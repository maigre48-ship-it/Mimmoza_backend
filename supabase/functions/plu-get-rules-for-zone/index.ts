// supabase/functions/plu-get-rules-for-zone/index.ts
// Version : v1.1
//
// Objectif :
//  - Entrée : { commune_insee, zone_code }
//  - Sortie : extrait les règles principales depuis plu_rulesets.rules (PLURulesetV2)
//
// Dépendances :
//  - @supabase/supabase-js v2
//  - ../_shared/cors.ts

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
  ruleset_raw?: JsonValue;
  error?: string;
  details?: unknown;
};

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  if (req.method !== "POST") {
    const resp: GetRulesResponse = {
      success: false,
      version: "plu-get-rules-for-zone-v1",
      error: "Méthode non supportée. Utilise POST.",
    };
    return new Response(JSON.stringify(resp), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  try {
    const body = (await req.json()) as Partial<GetRulesInput>;
    const { commune_insee, zone_code } = body;

    if (!commune_insee || !zone_code) {
      const resp: GetRulesResponse = {
        success: false,
        version: "plu-get-rules-for-zone-v1",
        error: "Champs requis manquants : commune_insee, zone_code.",
      };
      return new Response(JSON.stringify(resp), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }

    // Lecture du ruleset le plus récent pour cette commune / zone
    const { data, error } = await supabase
      .from(PLU_RULESETS_TABLE)
      .select("id, rules")
      .eq("commune_insee", commune_insee)
      .eq("zone_code", zone_code)
      .order("id", { ascending: false }) // on prend le plus récent selon l'id
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Erreur select plu_rulesets:", error);
      const resp: GetRulesResponse = {
        success: false,
        version: "plu-get-rules-for-zone-v1",
        error: "Erreur lors de la lecture de plu_rulesets.",
        details: error.message,
      };
      return new Response(JSON.stringify(resp), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }

    if (!data || !data.rules) {
      const resp: GetRulesResponse = {
        success: false,
        version: "plu-get-rules-for-zone-v1",
        error:
          "Aucun ruleset trouvé pour cette commune / zone. As-tu bien lancé plu-extract-ruleset avec save_to_db = true ?",
      };
      return new Response(JSON.stringify(resp), {
        status: 404,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
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
      ruleset_raw: ruleset,
    };

    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error("Erreur plu-get-rules-for-zone:", err);
    const resp: GetRulesResponse = {
      success: false,
      version: "plu-get-rules-for-zone-v1",
      error: "Erreur interne plu-get-rules-for-zone",
      details: String(err),
    };
    return new Response(JSON.stringify(resp), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
});
