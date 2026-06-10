// supabase/functions/plu-from-parcelle/index.ts
// Version : plu-from-parcelle-v1.1 — security hardening, no detailed logs/responses

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function isParcelConsistentWithCommune(
  parcelId: string | null,
  communeInsee: string | null,
): boolean {
  if (!parcelId || !communeInsee) return true;

  if (communeInsee.length === 5) {
    const parcelCommune = parcelId.slice(0, 5);
    if (parcelCommune !== communeInsee) return false;
  }

  const expectedDept = communeInsee.slice(0, 2);
  const parcelDept = parcelId.slice(0, 2);

  return expectedDept === parcelDept;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[plu-from-parcelle] missing environment configuration");
    return jsonResponse({ success: false, error: "MISSING_ENV" }, 500);
  }

  try {
    const body = await req.json().catch(() => null);

    if (!body) {
      return jsonResponse({ success: false, error: "INVALID_JSON_BODY" }, 400);
    }

    const commune_insee =
      typeof body.commune_insee === "string" ? body.commune_insee.trim() : "";

    const commune_nom =
      typeof body.commune_nom === "string" ? body.commune_nom.trim() : null;

    const parcel_id =
      typeof body.parcel_id === "string" ? body.parcel_id.trim() : "";

    if (!commune_insee || !parcel_id) {
      return jsonResponse({ success: false, error: "INVALID_INPUT" }, 400);
    }

    if (!isParcelConsistentWithCommune(parcel_id, commune_insee)) {
      return jsonResponse(
        {
          success: false,
          error: "PARCEL_COMMUNE_INCONSISTENT",
        },
        400,
      );
    }

    let parcelRow: any = null;

    try {
      const { data: parcelles, error: parcelleError } = await supabase.rpc(
        "get_parcelle_by_id",
        { parcel_id },
      );

      if (parcelleError) {
        console.error("[plu-from-parcelle] parcel rpc error");
      } else if (parcelles && parcelles.length > 0) {
        parcelRow = Array.isArray(parcelles) ? parcelles[0] : parcelles;
      }
    } catch (_e) {
      console.error("[plu-from-parcelle] parcel rpc exception");
    }

    const parcel = {
      parcel_id,
      surface_terrain_m2: parcelRow?.surface_terrain_m2 ?? null,
      centroid: {
        lat: parcelRow?.centroid_lat ?? null,
        lon: parcelRow?.centroid_lon ?? null,
      },
    };

    let pluFound = false;
    let zone: any = null;
    let ruleset: any = null;
    let source: any = null;
    let pluReason: string | null = null;

    try {
      const { data: pluData, error: pluError } = await supabase.rpc(
        "plu_get_for_parcelle_any",
        {
          parcel_id: parcel.parcel_id,
          commune_insee,
        },
      );

      if (pluError) {
        console.error("[plu-from-parcelle] plu rpc error");
        pluReason = "PLU_FETCH_ERROR";
      } else if (pluData) {
        let pluResult: any = null;

        if (Array.isArray(pluData) && pluData.length > 0) {
          const first = pluData[0];
          pluResult =
            first.plu_get_for_parcelle_any ??
            first.plu_get_for_parcelle_manual ??
            first;
        } else {
          pluResult = pluData;
        }

        if (pluResult && pluResult.found !== false) {
          pluFound = true;
          zone = pluResult.zone ?? null;
          ruleset = pluResult.rules ?? pluResult.ruleset ?? null;
          source = pluResult.source ?? null;
        } else {
          pluReason = "PLU_NOT_FOUND";
        }
      } else {
        pluReason = "PLU_NOT_FOUND";
      }
    } catch (_e) {
      console.error("[plu-from-parcelle] plu rpc exception");
      pluReason = "PLU_FETCH_ERROR";
    }

    const responseBody: any = {
      success: true,
      version: "plu-from-parcelle-v1.1",
      mode: "parcel",
      inputs: { commune_insee, commune_nom, parcel_id },
      parcel,
      plu: {
        found: pluFound,
        zone,
        ruleset,
        source,
      },
      next_actions: {
        can_run_etude_marche: true,
        can_run_bilan_promoteur: pluFound,
        can_run_etude_archi: pluFound,
      },
      plu_upload_required: !pluFound,
    };

    if (!pluFound) {
      const zoneCode =
        (zone as any)?.zone_code ??
        (zone as any)?.zone ??
        null;

      responseBody.plu = {
        ...responseBody.plu,
        reason: pluReason ?? "PLU_NOT_FOUND",
      };

      responseBody.plu_upload_hint = {
        message:
          "PLU non structuré ou non disponible pour cette commune/zone. Merci d'uploader le règlement PLU (PDF).",
        expected_format: "PDF règlement PLU complet ou par zone",
        base44_source_id_suggestion:
          zoneCode
            ? `plu-${commune_insee}-${zoneCode}-v1`
            : `plu-${commune_insee}-zone-INC-v1`,
      };
    }

    return jsonResponse(responseBody, 200);
  } catch (_e) {
    console.error("[plu-from-parcelle] internal error");

    return jsonResponse(
      {
        success: false,
        error: "INTERNAL_ERROR",
      },
      500,
    );
  }
});