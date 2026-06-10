/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[plu-documents-list-v1] missing environment configuration");
    return jsonResponse({ success: false, error: "MISSING_ENV" }, 500);
  }

  try {
    let commune_insee: string | null = null;
    let limit = 50;

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));

      commune_insee = typeof body?.commune_insee === "string"
        ? body.commune_insee.trim() || null
        : null;

      limit = typeof body?.limit === "number"
        ? Math.max(1, Math.min(200, body.limit))
        : 50;
    } else {
      const url = new URL(req.url);

      commune_insee = url.searchParams.get("commune_insee");
      commune_insee = commune_insee?.trim() || null;

      const l = url.searchParams.get("limit");

      if (l) {
        const n = Number(l);
        if (!Number.isNaN(n)) limit = Math.max(1, Math.min(200, n));
      }
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    let q = supabase
      .from("plu_documents")
      .select("id, commune_insee, commune_nom, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (commune_insee) {
      q = q.eq("commune_insee", commune_insee);
    }

    const { data, error } = await q;

    if (error) {
      console.error("[plu-documents-list-v1] database error");
      return jsonResponse({ success: false, error: "DB_ERROR" }, 500);
    }

    return jsonResponse(
      {
        success: true,
        version: "plu-documents-list-v1.1",
        count: data?.length ?? 0,
        documents: data ?? [],
      },
      200,
    );
  } catch (_e) {
    console.error("[plu-documents-list-v1] internal error");
    return jsonResponse({ success: false, error: "INTERNAL_ERROR" }, 500);
  }
});