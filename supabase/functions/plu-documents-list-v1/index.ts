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

serve(async (req: Request): Promise<Response> => {
  // 1) CORS preflight (CRITIQUE)
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 2) Autoriser GET/POST (selon comment ton front appelle)
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // 3) Guard env
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
    // Optionnel: permettre des filtres (commune_insee, limit)
    let commune_insee: string | null = null;
    let limit = 50;

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      commune_insee = typeof body?.commune_insee === "string" ? body.commune_insee : null;
      limit = typeof body?.limit === "number" ? Math.max(1, Math.min(200, body.limit)) : 50;
    } else {
      const url = new URL(req.url);
      commune_insee = url.searchParams.get("commune_insee");
      const l = url.searchParams.get("limit");
      if (l) {
        const n = Number(l);
        if (!Number.isNaN(n)) limit = Math.max(1, Math.min(200, n));
      }
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let q = supabase
      .from("plu_documents")
      .select("id, commune_insee, commune_nom, storage_path, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (commune_insee) q = q.eq("commune_insee", commune_insee);

    const { data, error } = await q;

    if (error) {
      return new Response(JSON.stringify({ success: false, error: "DB_ERROR", details: error.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, count: data?.length ?? 0, documents: data ?? [] }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ success: false, error: "INTERNAL_ERROR", message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
