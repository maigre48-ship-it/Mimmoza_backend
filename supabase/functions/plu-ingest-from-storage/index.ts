// supabase/functions/plu-ingest-from-storage/index.ts
// Version : plu-ingest-from-storage-v1 (corrected)

// Objectif :
// - Prend commune_insee (+ commune_nom optionnel)
// - Trouve le dernier PDF dans Storage (bucket "plu_raw")
// - Crée une URL signée
// - Appelle le moteur Node (PLU_PARSER_API_URL) pour extraire les rulesets
// - Appelle plu-ingest-rulesets (Edge Function) pour enregistrer dans plu_rulesets_universal
// - Retourne un récapitulatif

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PLU_PARSER_API_URL = Deno.env.get("PLU_PARSER_API_URL")!;
const PLU_PARSER_API_KEY = Deno.env.get("PLU_PARSER_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const FUNCTIONS_BASE_URL = SUPABASE_URL.replace(
  ".supabase.co",
  ".functions.supabase.co",
);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const commune_insee = (body.commune_insee ?? "").toString().trim();
    const commune_nom =
      (body.commune_nom ?? body.commune_name ?? "").toString().trim() || null;

    if (!commune_insee) {
      return jsonResponse(
        { success: false, error: "MISSING_COMMUNE_INSEE" },
        400,
      );
    }

    // 1️⃣ Liste des fichiers PLU dans Storage
    const { data: files, error: listError } = await supabase.storage
      .from("plu_raw")
      .list(commune_insee, {
        limit: 100,
        sortBy: { column: "name", order: "desc" },
      });

    if (listError) {
      console.error("STORAGE_LIST_ERROR:", listError);
      return jsonResponse(
        { success: false, error: "STORAGE_LIST_ERROR" },
        500,
      );
    }

    if (!files || files.length === 0) {
      return jsonResponse(
        { success: false, error: "NO_PLU_PDF_FOUND_FOR_COMMUNE" },
        404,
      );
    }

    const latestFile = files[0];
    const storagePath = `${commune_insee}/${latestFile.name}`;

    // 2️⃣ URL signée
    const { data: signed, error: signedError } = await supabase.storage
      .from("plu_raw")
      .createSignedUrl(storagePath, 60 * 60);

    if (signedError || !signed?.signedUrl) {
      console.error("SIGNED_URL_ERROR:", signedError);
      return jsonResponse(
        { success: false, error: "SIGNED_URL_ERROR" },
        500,
      );
    }

    const source_pdf_url = signed.signedUrl;

    // 3️⃣ Appel moteur PLU (Render → Node)
    const parserRes = await fetch(PLU_PARSER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PLU_PARSER_API_KEY}`,
      },
      body: JSON.stringify({
        commune_insee,
        commune_nom,
        source_pdf_url,
      }),
    });

    const parserJson = await parserRes.json().catch(() => null);

    if (!parserRes.ok || !parserJson?.success) {
      console.error("PLU_PARSER_ERROR:", parserRes.status, parserJson);
      return jsonResponse(
        {
          success: false,
          error: "PLU_PARSER_FAILED",
          status: parserRes.status,
          parser_response: parserJson,
          storage_path: storagePath,
        },
        200,
      );
    }

    // 4️⃣ Envoi à plu-ingest-rulesets
    const ingestRes = await fetch(
      `${FUNCTIONS_BASE_URL}/plu-ingest-rulesets`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify(parserJson),
      },
    );

    const ingestJson = await ingestRes.json().catch(() => null);

    if (!ingestJson?.success) {
      console.error("PLU_INGEST_RULESETS_ERROR:", ingestJson);
      return jsonResponse(
        {
          success: false,
          error: "PLU_INGEST_RULESETS_FAILED",
          parser: parserJson,
          ingest: ingestJson,
          storage_path: storagePath,
        },
        200,
      );
    }

    // 5️⃣ Réponse finale OK
    return jsonResponse(
      {
        success: true,
        version: "plu-ingest-from-storage-v1",
        commune_insee,
        commune_nom,
        storage_path: storagePath,
        parser: {
          success: parserJson.success,
          plu_version_label: parserJson.plu_version_label ?? null,
          zones_count: parserJson.zones_rulesets?.length ?? 0,
        },
        ingest: ingestJson,
      },
      200,
    );
  } catch (err) {
    console.error("PLU_INGEST_FROM_STORAGE_ERROR:", err);
    return jsonResponse(
      {
        success: false,
        error: "PLU_INGEST_FROM_STORAGE_INTERNAL_ERROR",
        details: err instanceof Error ? err.message : String(err),
        storage_path: null,
      },
      200,
    );
  }
});
