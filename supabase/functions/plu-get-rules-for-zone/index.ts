// supabase/functions/plu-get-rules-for-zone/index.ts
// Version : v1.1
//
// Objectif :
//  - Entrée : { commune_insee, zone_code }
//  - Sortie : extrait les règles principales depuis plu_rulesets.rules (PLURulesetV2)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PLU_RULESETS_TABLE = "plu_rulesets";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type GetRulesInput = {
  commune_insee: string;
  zone_code: string;
};

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type GetRulesResponse = {
  success: boolean;
  version: string;
  inputs?: GetRulesInput;
  rules?: {
    densite_emprise?: JsonValue;
    hauteurs?: JsonValue;
    pleine_terre?: JsonValue;
    stationnement?: JsonValue;
    autres?: JsonValue;
  };
  error?: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return jsonResponse({ ok: true }, 200);
  }

  if (req.method !== "POST") {
    return jsonResponse(
      {
        success: false,
        version: "plu-get-rules-for-zone-v1",
        error: "METHOD_NOT_ALLOWED",
      },
      405,
    );
  }

  try {
    const body = (await req.json().catch(() => null)) as Partial<GetRulesInput> | null;

    if (!body) {
      return jsonResponse(
        {
          success: false,
          version: "plu-get-rules-for-zone-v1",
          error: "INVALID_JSON",
        },
        400,
      );
    }

    const commune_insee = typeof body.commune_insee === "string"
      ? body.commune_insee.trim()
      : "";

    const zone_code = typeof body.zone_code === "string"
      ? body.zone_code.trim()
      : "";

    if (!commune_insee || !zone_code) {
      return jsonResponse(
        {
          success: false,
          version: "plu-get-rules-for-zone-v1",
          error: "MISSING_REQUIRED_FIELDS",
        },
        400,
      );
    }

    const { data, error } = await supabase
      .from(PLU_RULESETS_TABLE)
      .select("id, rules")
      .eq("commune_insee", commune_insee)
      .eq("zone_code", zone_code)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[plu-get-rules-for-zone] Database error");

      return jsonResponse(
        {
          success: false,
          version: "plu-get-rules-for-zone-v1",
          error: "DB_ERROR",
        },
        500,
      );
    }

    if (!data || !data.rules) {
      return jsonResponse(
        {
          success: false,
          version: "plu-get-rules-for-zone-v1",
          error: "RULESET_NOT_FOUND",
        },
        404,
      );
    }

    const ruleset = data.rules as any;

    const resp: GetRulesResponse = {
      success: true,
      version: "plu-get-rules-for-zone-v1",
      inputs: {
        commune_insee,
        zone_code,
      },
      rules: {
        densite_emprise: ruleset.densite_emprise ?? null,
        hauteurs: ruleset.hauteurs ?? null,
        pleine_terre: ruleset.pleine_terre ?? null,
        stationnement: ruleset.stationnement ?? null,
        autres: {
          usages: ruleset.usages ?? null,
          voirie_acces: ruleset.voirie_acces ?? null,
          divers: ruleset.divers ?? null,
        },
      },
    };

    return jsonResponse(resp, 200);
  } catch {
    console.error("[plu-get-rules-for-zone] Internal error");

    return jsonResponse(
      {
        success: false,
        version: "plu-get-rules-for-zone-v1",
        error: "INTERNAL_ERROR",
      },
      500,
    );
  }
});