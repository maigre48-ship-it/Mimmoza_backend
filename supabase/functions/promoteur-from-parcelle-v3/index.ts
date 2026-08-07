// supabase/functions/promoteur-from-parcelle-v3/index.ts
// Version : promoteur-from-parcelle-v3
//
// Objectif :
//  - Entrée : parcel_id (+ commune_insee et surface_terrain_m2 optionnels)
//  - Étapes :
//      1) Récupérer la parcelle IGN + PLU via la fonction Edge plu-from-parcelle-v2
//      2) Appeler la fonction SQL promoteur_v1(input jsonb)
//      3) Calculer un massing 3D v0 (emprise + hauteur)
//  - Sortie : { version, success, parcel, plu, promoteur, massing, error? }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type MassingBlock = {
  id: string;
  label: string;
  height_m: number;
  floors: number;
  footprint_m2: number;
};

type MassingSpec = {
  enabled: boolean;
  reason?: string;
  ground_footprint_m2: number | null;
  max_emprise_m2: number | null;
  max_height_m: number | null;
  blocks: MassingBlock[];
};

type PromoteurFromParcelleInputs = {
  parcel_id: string;
  commune_insee?: string | null;
  surface_terrain_m2?: number | null;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function buildMassingV0(
  pluRules: any | null,
  surfaceTerrainM2: number | null,
): MassingSpec {
  if (!surfaceTerrainM2 || surfaceTerrainM2 <= 0) {
    return {
      enabled: false,
      reason: "SURFACE_TERRAIN_INVALIDE",
      ground_footprint_m2: null,
      max_emprise_m2: null,
      max_height_m: null,
      blocks: [],
    };
  }

  if (!pluRules) {
    return {
      enabled: false,
      reason: "PLU_RULES_ABSENTS",
      ground_footprint_m2: null,
      max_emprise_m2: null,
      max_height_m: null,
      blocks: [],
    };
  }

  let empriseRatio: number | null = null;
  const rawEmprise = pluRules?.emprise_sol?.emprise_sol_max;

  if (typeof rawEmprise === "number") {
    empriseRatio = rawEmprise > 1 ? rawEmprise / 100 : rawEmprise;
  }

  if (!empriseRatio || empriseRatio <= 0 || empriseRatio > 1) {
    empriseRatio = 0.35;
  }

  const footprint = surfaceTerrainM2 * empriseRatio;

  let hauteurMaxM: number | null = null;
  const rawHauteur = pluRules?.hauteur?.hauteur_max_m;

  if (typeof rawHauteur === "number" && rawHauteur > 0) {
    hauteurMaxM = rawHauteur;
  } else {
    hauteurMaxM = 9;
  }

  const floors = Math.max(1, Math.round((hauteurMaxM ?? 9) / 3));

  const block: MassingBlock = {
    id: "B1",
    label: "Volume principal",
    height_m: hauteurMaxM ?? 9,
    floors,
    footprint_m2: footprint,
  };

  return {
    enabled: true,
    ground_footprint_m2: footprint,
    max_emprise_m2: footprint,
    max_height_m: hauteurMaxM,
    blocks: [block],
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      {
        version: "promoteur-from-parcelle-v3",
        success: false,
        error: "METHOD_NOT_ALLOWED",
      },
      405,
    );
  }

  try {
    const body = (await req.json().catch(() => null)) as PromoteurFromParcelleInputs | null;

    if (!body) {
      return jsonResponse(
        {
          version: "promoteur-from-parcelle-v3",
          success: false,
          error: "INVALID_JSON",
        },
        400,
      );
    }

    const parcelId = body.parcel_id?.trim();
    const inputCommuneInsee = body.commune_insee?.trim() || null;
    let inputSurfaceTerrain = body.surface_terrain_m2 ?? null;

    if (!parcelId) {
      return jsonResponse(
        {
          version: "promoteur-from-parcelle-v3",
          success: false,
          error: "MISSING_PARCEL_ID",
        },
        400,
      );
    }

    const pluFunctionUrl = `${SUPABASE_URL}/functions/v1/plu-from-parcelle-v2`;

    const pluResponse = await fetch(pluFunctionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        parcel_id: parcelId,
        commune_insee: inputCommuneInsee,
      }),
    });

    if (!pluResponse.ok) {
      console.error("[promoteur-from-parcelle-v3] PLU Edge error");

      return jsonResponse(
        {
          version: "promoteur-from-parcelle-v3",
          success: false,
          error: "PLU_EDGE_ERROR",
        },
        500,
      );
    }

    const pluJson: any = await pluResponse.json().catch(() => null);

    const parcelFromPlu = pluJson?.parcel ?? null;
    const pluPart = pluJson?.plu ?? null;

    if (!parcelFromPlu || !pluPart) {
      console.error("[promoteur-from-parcelle-v3] PLU Edge payload invalid");

      return jsonResponse(
        {
          version: "promoteur-from-parcelle-v3",
          success: false,
          error: "PLU_EDGE_PAYLOAD_INVALID",
        },
        500,
      );
    }

    const communeInsee =
      inputCommuneInsee ??
      pluPart?.commune_insee ??
      parcelFromPlu?.commune_insee ??
      null;

    if (!inputSurfaceTerrain) {
      const contenance = parcelFromPlu?.props?.contenance;
      if (typeof contenance === "number" && contenance > 0) {
        inputSurfaceTerrain = contenance;
      }
    }

    const parcelForOutput = {
      parcel_id: parcelId,
      commune_insee: communeInsee,
      commune:
        parcelFromPlu?.props?.nom_com ??
        parcelFromPlu?.commune ??
        null,
      section:
        parcelFromPlu?.props?.section ??
        parcelFromPlu?.section ??
        null,
      numero:
        parcelFromPlu?.props?.numero ??
        parcelFromPlu?.numero ??
        null,
      surface_terrain_m2: inputSurfaceTerrain,
    };

    const parcelForRpc = {
      ...parcelForOutput,
      props: parcelFromPlu?.props ?? null,
    };

    const pluForOutput = {
      found: pluPart?.found ?? true,
      reason: pluPart?.reason ?? null,
      zone: pluPart?.zone ?? null,
      rules: pluPart?.rules ?? null,
    };

    const promoteurInput = {
      parcel: parcelForRpc,
      plu: {
        zone: pluForOutput.zone,
        rules: pluForOutput.rules,
      },
    };

    const { data: promoteurData, error: promoteurError } = await supabase.rpc(
      "promoteur_v1",
      { input: promoteurInput },
    );

    if (promoteurError) {
      console.error("[promoteur-from-parcelle-v3] Promoteur RPC error");

      return jsonResponse(
        {
          version: "promoteur-from-parcelle-v3",
          success: false,
          error: "PROMOTEUR_RPC_ERROR",
        },
        500,
      );
    }

    const promoteurForOutput = promoteurData ?? null;

    const massing = buildMassingV0(
      pluForOutput.rules,
      inputSurfaceTerrain ?? null,
    );

    return jsonResponse(
      {
        version: "promoteur-from-parcelle-v3",
        success: true,
        parcel: parcelForOutput,
        plu: pluForOutput,
        promoteur: promoteurForOutput,
        massing,
      },
      200,
    );
  } catch {
    console.error("[promoteur-from-parcelle-v3] Unexpected error");

    return jsonResponse(
      {
        version: "promoteur-from-parcelle-v3",
        success: false,
        error: "UNEXPECTED_ERROR",
      },
      500,
    );
  }
});