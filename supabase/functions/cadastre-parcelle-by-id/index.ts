/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

/**
 * Edge Function: cadastre-parcelle-by-id
 * Récupère la géométrie d'une parcelle cadastrale par son ID
 */

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "Access-Control-Max-Age": "86400",
};

type Input = { 
  parcel_id: string; 
  commune_insee?: string;
};

const IGN_FETCH_TIMEOUT_MS = 8000;

/**
 * Parse parcel ID to extract components
 * Format: 64065000AI0002 -> commune=64065, section=AI, numero=0002
 */
function parseParcelId(parcelId: string): { commune: string; section: string; numero: string } | null {
  // Format standard: CCCCC000SSNNNN (5 digits commune + 000 + 2 chars section + 4 digits numero)
  const match = parcelId.match(/^(\d{5})000([A-Z]{1,2})(\d{4})$/);
  if (match) {
    return {
      commune: match[1],
      section: match[2],
      numero: match[3],
    };
  }
  
  // Format alternatif: CCCCCSSNNNN
  const match2 = parcelId.match(/^(\d{5})([A-Z]{1,2})(\d{4})$/);
  if (match2) {
    return {
      commune: match2[1],
      section: match2[2],
      numero: match2[3],
    };
  }
  
  return null;
}

/**
 * Fetch parcelle from IGN Apicarto API by ID
 */
async function fetchParcelleById(
  communeInsee: string,
  section: string,
  numero: string
): Promise<{ feature: any; error?: string }> {
  const params = new URLSearchParams({
    code_insee: communeInsee,
    section: section,
    numero: numero,
    source_ign: "PCI",
    _limit: "1",
  });

  const ignUrl = `https://apicarto.ign.fr/api/cadastre/parcelle?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IGN_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(ignUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        feature: null,
        error: `IGN_HTTP_${response.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = await response.json();

    // Validate response structure
    if (data?.type === "FeatureCollection" && Array.isArray(data?.features) && data.features.length > 0) {
      return {
        feature: data.features[0],
      };
    }

    return {
      feature: null,
      error: "PARCEL_NOT_FOUND",
    };
  } catch (e: any) {
    clearTimeout(timeoutId);

    if (e.name === "AbortError") {
      return {
        feature: null,
        error: `IGN_TIMEOUT: Request exceeded ${IGN_FETCH_TIMEOUT_MS}ms`,
      };
    }

    return {
      feature: null,
      error: `IGN_FETCH_ERROR: ${e.message ?? String(e)}`,
    };
  }
}

serve(async (req) => {
  // Preflight CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let parcel_id: string | undefined;
    let commune_insee: string | undefined;

    if (req.method === "GET") {
      const url = new URL(req.url);
      parcel_id = url.searchParams.get("parcel_id") ?? undefined;
      commune_insee = url.searchParams.get("commune_insee") ?? undefined;
    } else {
      const body = (await req.json().catch(() => null)) as Input | null;
      parcel_id = body?.parcel_id;
      commune_insee = body?.commune_insee;
    }

    if (!parcel_id || typeof parcel_id !== "string") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "MISSING_PARAMS",
          message: "parcel_id est obligatoire",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse parcel ID
    const parsed = parseParcelId(parcel_id);
    if (!parsed) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "INVALID_PARCEL_ID",
          message: `Format de parcel_id invalide: ${parcel_id}`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use commune from parcel_id if not provided
    const finalCommune = commune_insee || parsed.commune;

    // Fetch from IGN
    const result = await fetchParcelleById(finalCommune, parsed.section, parsed.numero);

    if (!result.feature) {
      return new Response(
        JSON.stringify({
          success: false,
          error: result.error || "PARCEL_NOT_FOUND",
          message: `Parcelle non trouvée: ${parcel_id}`,
          parsed,
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        parcel_id,
        commune_insee: finalCommune,
        section: parsed.section,
        numero: parsed.numero,
        feature: result.feature,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ success: false, error: "UNHANDLED", message: msg.slice(0, 800) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});