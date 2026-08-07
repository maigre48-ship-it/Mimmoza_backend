/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Body = {
  storage_path?: string;
  document_id?: string;
  commune_insee?: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[plu-faisabilite-summary-v1] Missing environment configuration");

    return jsonResponse(
      {
        success: false,
        error: "MISSING_ENV",
      },
      500,
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Body;

    const storage_path = typeof body.storage_path === "string"
      ? body.storage_path.trim() || null
      : null;

    const document_id = typeof body.document_id === "string"
      ? body.document_id.trim() || null
      : null;

    const commune_insee = typeof body.commune_insee === "string"
      ? body.commune_insee.trim() || null
      : null;

    if (!storage_path && !document_id && !commune_insee) {
      return jsonResponse(
        {
          success: false,
          error: "MISSING_INPUT",
        },
        400,
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
      },
    });

    let docQuery = supabase
      .from("plu_documents")
      .select("id, commune_insee, commune_nom, storage_path, created_at")
      .order("created_at", { ascending: false })
      .limit(1);

    if (document_id) {
      docQuery = docQuery.eq("id", document_id);
    } else if (storage_path) {
      docQuery = docQuery.eq("storage_path", storage_path);
    } else if (commune_insee) {
      docQuery = docQuery.eq("commune_insee", commune_insee);
    }

    const { data: docs, error: docErr } = await docQuery;

    if (docErr) {
      console.error("[plu-faisabilite-summary-v1] Document query error");

      return jsonResponse(
        {
          success: false,
          error: "DB_ERROR",
        },
        500,
      );
    }

    const doc = docs?.[0] ?? null;

    if (!doc) {
      return jsonResponse(
        {
          success: false,
          error: "DOCUMENT_NOT_FOUND",
        },
        404,
      );
    }

    const { data: zones, error: zonesErr } = await supabase
      .from("plu_zone_rules_normalized")
      .select("document_id, commune_insee, zone_code, zone_libelle, confidence_score, source, rules, created_at")
      .eq("document_id", doc.id)
      .order("zone_code", { ascending: true });

    if (zonesErr) {
      console.error("[plu-faisabilite-summary-v1] Zones query error");

      return jsonResponse(
        {
          success: false,
          error: "DB_ERROR",
        },
        500,
      );
    }

    return jsonResponse(
      {
        success: true,
        document: doc,
        zones: zones ?? [],
      },
      200,
    );
  } catch {
    console.error("[plu-faisabilite-summary-v1] Internal error");

    return jsonResponse(
      {
        success: false,
        error: "INTERNAL_ERROR",
      },
      500,
    );
  }
});