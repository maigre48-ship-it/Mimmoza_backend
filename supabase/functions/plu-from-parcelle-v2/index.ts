// supabase/functions/plu-from-parcelle-v2/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type PluFromParcelleInput = {
  parcel_id: string;
  commune_insee: string;
  address?: string;
  lat?: number;
  lon?: number;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseParcelId(parcelId: string) {
  if (parcelId.length < 14) {
    throw new Error("BAD_PARCEL_ID_FORMAT");
  }

  const code_dep = parcelId.slice(0, 2);
  const code_com = parcelId.slice(2, 5);
  const prefixe = parcelId.slice(5, 8);
  const section = parcelId.slice(8, 10);
  const numero = parcelId.slice(10, 14);
  const code_insee = code_dep + code_com;

  return { code_dep, code_com, code_insee, prefixe, section, numero };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, {
      success: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const body = (await req.json().catch(() => null)) as PluFromParcelleInput | null;

    if (!body) {
      return json(400, {
        success: false,
        error: "INVALID_JSON",
      });
    }

    const { parcel_id, commune_insee } = body;

    if (!parcel_id || !commune_insee) {
      return json(400, {
        success: false,
        error: "MISSING_PARAMS",
        message: "parcel_id et commune_insee sont obligatoires",
      });
    }

    let parsed: ReturnType<typeof parseParcelId>;

    try {
      parsed = parseParcelId(parcel_id);
    } catch {
      return json(400, {
        success: false,
        error: "BAD_PARCEL_ID_FORMAT",
      });
    }

    const { code_insee, section, numero } = parsed;

    if (code_insee !== commune_insee) {
      console.warn("[plu-from-parcelle-v2] commune mismatch");
    }

    const ignBaseUrl = "https://apicarto.ign.fr/api/cadastre/parcelle";

    const params = new URLSearchParams({
      code_insee: commune_insee,
      section,
      numero,
      source_ign: "PCI",
      _limit: "5",
    });

    const ignUrl = `${ignBaseUrl}?${params.toString()}`;

    const ignResp = await fetch(ignUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });

    if (!ignResp.ok) {
      console.error("[plu-from-parcelle-v2] IGN cadastre API error");

      return json(502, {
        success: false,
        error: "IGN_CADASTRE_API_ERROR",
        status: ignResp.status,
      });
    }

    const ignJson = await ignResp.json().catch(() => null);

    if (
      !ignJson ||
      ignJson.type !== "FeatureCollection" ||
      !Array.isArray(ignJson.features) ||
      ignJson.features.length === 0
    ) {
      return json(404, {
        success: false,
        error: "IGN_NO_PARCEL_FOUND",
      });
    }

    const feature = ignJson.features[0];
    const geometry = feature?.geometry;

    if (!geometry) {
      return json(502, {
        success: false,
        error: "IGN_NO_GEOMETRY",
      });
    }

    const { data: pluData, error: pluError } = await supabase.rpc(
      "get_plu_rules_for_geom",
      {
        p_commune_insee: commune_insee,
        p_geojson: geometry,
      },
    );

    if (pluError) {
      console.error("[plu-from-parcelle-v2] PLU RPC error");

      return json(500, {
        success: false,
        error: "PLU_RPC_ERROR",
      });
    }

    const success = Boolean(pluData?.found);

    return json(200, {
      version: "plu-from-parcelle-v2",
      success,
      parcel: {
        parcel_id,
        commune_insee,
      },
      plu: pluData,
    });
  } catch {
    console.error("[plu-from-parcelle-v2] Unexpected error");

    return json(500, {
      success: false,
      error: "UNEXPECTED_ERROR",
    });
  }
});