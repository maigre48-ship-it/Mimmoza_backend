// supabase/functions/plu-from-parcelle/index.ts
// Version : plu-from-parcelle-v1 (robuste, surface optionnelle – source finale côté front)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get(
  "SUPABASE_SERVICE_ROLE_KEY",
)!;

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

// 🔍 Vérifie la cohérence entre parcel_id et code INSEE
function isParcelConsistentWithCommune(
  parcelId: string | null,
  communeInsee: string | null,
): boolean {
  if (!parcelId || !communeInsee) return true;

  // Pour les parcelles PCI : les 5 premiers caractères = code INSEE
  if (communeInsee.length === 5) {
    const parcelCommune = parcelId.slice(0, 5);
    if (parcelCommune !== communeInsee) return false;
  }

  // Vérification minimale sur le département (2 premiers caractères)
  const expectedDept = communeInsee.slice(0, 2);
  const parcelDept = parcelId.slice(0, 2);

  return expectedDept === parcelDept;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ success: false, error: "Method not allowed" }, 405);
    }

    const body = await req.json().catch(() => null);

    if (!body) {
      return jsonResponse(
        { success: false, error: "Invalid JSON body" },
        400,
      );
    }

    const commune_insee: string | undefined = body.commune_insee;
    const commune_nom: string | undefined = body.commune_nom;
    const parcel_id: string | undefined = body.parcel_id;

    if (!commune_insee || !parcel_id) {
      return jsonResponse(
        {
          success: false,
          error: "Missing fields: commune_insee, parcel_id",
        },
        400,
      );
    }

    // 1️⃣ Vérification basique de cohérence commune / parcelle
    if (!isParcelConsistentWithCommune(parcel_id, commune_insee)) {
      return jsonResponse(
        {
          success: false,
          error: "Parcel/commune inconsistent",
          details:
            "Le numéro de parcelle ne correspond pas au code INSEE indiqué.",
        },
        400,
      );
    }

    // 2️⃣ Parcelle – tentative via Supabase (cache IDF) pour centroid + surface indicative éventuelle
    let parcelRow: any = null;

    try {
      const { data: parcelles, error: parcelleError } = await supabase.rpc(
        "get_parcelle_by_id",
        { parcel_id },
      );

      if (parcelleError) {
        console.error("get_parcelle_by_id error:", parcelleError);
      } else if (parcelles && parcelles.length > 0) {
        parcelRow = Array.isArray(parcelles) ? parcelles[0] : parcelles;
      }
    } catch (e) {
      console.error("Unexpected error while calling get_parcelle_by_id:", e);
    }

    const parcel = {
      parcel_id,
      surface_terrain_m2: parcelRow?.surface_terrain_m2 ?? null,
      centroid: {
        lat: parcelRow?.centroid_lat ?? null,
        lon: parcelRow?.centroid_lon ?? null,
      },
    };

    // 3️⃣ PLU – robuste (comme avant)
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
        console.error("plu_get_for_parcelle_any error:", pluError);
        pluReason = "Error while fetching PLU rules";
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
          pluReason = "PLU ruleset not found for this commune/zone";
        }
      } else {
        pluReason = "PLU ruleset not found for this commune/zone";
      }
    } catch (e) {
      console.error(
        "Unexpected error while calling plu_get_for_parcelle_any:",
        e,
      );
      pluReason = "Error while fetching PLU rules";
    }

    const responseBody: any = {
      success: true,
      version: "plu-from-parcelle-v1",
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
        reason:
          pluReason ?? "PLU ruleset not found for this commune/zone",
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
  } catch (err) {
    console.error("Unexpected error in plu-from-parcelle:", err);
    return jsonResponse(
      {
        success: false,
        error: "Unexpected error",
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
