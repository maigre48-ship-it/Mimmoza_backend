import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface RequestBody {
  document_id: string;
  zone_code: string;
}

interface SuccessResponse {
  success: true;
  version: string;
  document_id: string;
  zone_code: string;
  zone_libelle: string | null;
  confidence_score: number | null;
  rules: Record<string, unknown>;
}

interface ErrorResponse {
  success: false;
  error: string;
}

function jsonResponse(body: SuccessResponse | ErrorResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const supabaseUrl =
    Deno.env.get("SUPABASE_URL") ??
    Deno.env.get("MIMMOZA_SUPABASE_URL");

  const supabaseServiceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("MIMMOZA_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.error("[plu-rules-by-zone-v1] missing environment configuration");
    return jsonResponse({ success: false, error: "MISSING_ENV" }, 500);
  }

  try {
    let body: RequestBody;

    try {
      body = await req.json();
    } catch (_e) {
      return jsonResponse({ success: false, error: "INVALID_JSON_BODY" }, 400);
    }

    const document_id = String(body.document_id ?? "").trim();
    const zone_code = String(body.zone_code ?? "").trim().toUpperCase();

    if (!document_id || !zone_code) {
      return jsonResponse({ success: false, error: "INVALID_INPUT" }, 400);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data, error } = await supabase
      .from("plu_zone_rules_normalized")
      .select("zone_libelle, rules, confidence_score")
      .eq("document_id", document_id)
      .eq("zone_code", zone_code)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return jsonResponse({ success: false, error: "NOT_FOUND" }, 404);
      }

      console.error("[plu-rules-by-zone-v1] database error");
      return jsonResponse({ success: false, error: "INTERNAL_ERROR" }, 500);
    }

    if (data === null || data === undefined) {
      return jsonResponse({ success: false, error: "NOT_FOUND" }, 404);
    }

    return jsonResponse(
      {
        success: true,
        version: "plu-rules-by-zone-v1.1",
        document_id,
        zone_code,
        zone_libelle: data.zone_libelle,
        confidence_score: data.confidence_score,
        rules: data.rules || {},
      },
      200,
    );
  } catch (_e) {
    console.error("[plu-rules-by-zone-v1] internal error");
    return jsonResponse({ success: false, error: "INTERNAL_ERROR" }, 500);
  }
});