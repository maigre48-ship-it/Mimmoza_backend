// supabase/functions/plu-ingest-rulesets/index.ts
// Version : plu-ingest-rulesets-v1-simplified (corrected)
//
// Reçoit un JSON contenant plusieurs zones_rulesets
// et fait un UPSERT propre dans plu_rulesets_universal.
// En cas d'erreur SQL, on NE renvoie PAS un 500 (pour inspection côté client).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    const plu_version_label: string | undefined = body.plu_version_label;
    const source_document: string | undefined = body.source_document;
    const zones_rulesets: any[] | undefined = body.zones_rulesets;

    if (!commune_insee || !zones_rulesets || !Array.isArray(zones_rulesets)) {
      return jsonResponse(
        {
          success: false,
          error:
            "Missing required fields: commune_insee and zones_rulesets (array) are required.",
        },
        400,
      );
    }

    // Transformation en lignes à upserter
    const rowsToUpsert = zones_rulesets
      .filter((z) => z && z.zone_code && z.ruleset)
      .map((z) => ({
        commune_insee,
        commune_nom: commune_nom ?? null,
        zone_code: z.zone_code,
        zone_libelle: z.zone_libelle ?? null,
        plu_version_label: plu_version_label ?? null,
        source_document: source_document ?? null,
        ruleset: z.ruleset,
      }));

    if (rowsToUpsert.length === 0) {
      return jsonResponse(
        {
          success: false,
          error:
            "No valid zones_rulesets entries found (each needs zone_code + ruleset).",
        },
        400,
      );
    }

    // 🔥 UPSERT correct avec gestion des doublons sur (commune_insee, zone_code)
    const { data, error } = await supabase
      .from("plu_rulesets_universal")
      .upsert(rowsToUpsert, {
        onConflict: "commune_insee,zone_code",   // 🔥 la clé unique de la table
        ignoreDuplicates: false,                 // met à jour en cas de conflit
      });

    if (error) {
      console.error("DB error in plu-ingest-rulesets:", error);
      return jsonResponse(
        {
          success: false,
          error: "DB error while upserting plu_rulesets_universal",
          details: error.message,
          rows_tried: rowsToUpsert,
        },
        200, // On garde 200 pour voir l'erreur côté client
      );
    }

    return jsonResponse(
      {
        success: true,
        version: "plu-ingest-rulesets-v1-simplified",
        input: {
          commune_insee,
          commune_nom: commune_nom ?? null,
          plu_version_label: plu_version_label ?? null,
          source_document: source_document ?? null,
        },
        upserted_count: data?.length ?? 0,
        upserted: data ?? [],
      },
      200,
    );
  } catch (err) {
    console.error("Unexpected error in plu-ingest-rulesets:", err);
    return jsonResponse(
      {
        success: false,
        error: "Unexpected error (function-level)",
        details: err instanceof Error ? err.message : String(err),
      },
      200,
    );
  }
});
