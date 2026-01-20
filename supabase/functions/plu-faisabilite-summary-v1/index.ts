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

serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Method
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Guard env
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "MISSING_ENV",
        message: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY non configuré",
      }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Body;

    const storage_path = typeof body.storage_path === "string" ? body.storage_path.trim() : null;
    const document_id = typeof body.document_id === "string" ? body.document_id.trim() : null;
    const commune_insee = typeof body.commune_insee === "string" ? body.commune_insee.trim() : null;

    if (!storage_path && !document_id && !commune_insee) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "MISSING_INPUT",
          message: "Fournir storage_path ou document_id ou commune_insee",
        }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1) Charger le document PLU (sans colonnes optionnelles non garanties)
    let docQuery = supabase
      .from("plu_documents")
      .select("id, commune_insee, commune_nom, storage_path, created_at")
      .order("created_at", { ascending: false })
      .limit(1);

    if (document_id) docQuery = docQuery.eq("id", document_id);
    else if (storage_path) docQuery = docQuery.eq("storage_path", storage_path);
    else if (commune_insee) docQuery = docQuery.eq("commune_insee", commune_insee);

    const { data: docs, error: docErr } = await docQuery;

    if (docErr) {
      return new Response(JSON.stringify({ success: false, error: "DB_ERROR", details: docErr.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const doc = docs?.[0] ?? null;
    if (!doc) {
      return new Response(JSON.stringify({ success: false, error: "DOCUMENT_NOT_FOUND" }), {
        status: 404,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 2) Charger les zones normalisées pour ce document
    const { data: zones, error: zonesErr } = await supabase
      .from("plu_zone_rules_normalized")
      .select("document_id, commune_insee, zone_code, zone_libelle, confidence_score, source, rules, created_at")
      .eq("document_id", doc.id)
      .order("zone_code", { ascending: true });

    if (zonesErr) {
      return new Response(JSON.stringify({ success: false, error: "DB_ERROR", details: zonesErr.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        document: doc,
        zones: zones ?? [],
      }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ success: false, error: "INTERNAL_ERROR", message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
