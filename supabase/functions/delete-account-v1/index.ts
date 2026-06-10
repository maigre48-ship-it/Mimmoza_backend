/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";

    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse({ success: false, error: "UNAUTHORIZED" }, 401);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const token = authHeader.replace("Bearer ", "").trim();

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return jsonResponse({ success: false, error: "UNAUTHORIZED" }, 401);
    }

    const userId = user.id;

    /*
      RGPD — suppression de compte.

      Important :
      - Ne pas exposer de détail SQL côté client.
      - Supprimer progressivement les tables métier ici.
      - Les suppressions doivent être idempotentes.
      - Si une table n'existe pas encore, ignorer l'erreur côté code ou ajouter plus tard.

      À compléter après audit des tables user_id / owner_id.
    */

    await Promise.allSettled([
      supabaseAdmin.from("api_keys").delete().eq("user_id", userId),
      supabaseAdmin.from("api_usage_logs").delete().eq("user_id", userId),
      supabaseAdmin.from("promoteur_profiles").delete().eq("owner_id", userId),
      supabaseAdmin.from("promoteur_synthese_logs").delete().eq("user_id", userId),
      supabaseAdmin.from("promoteur_terrain3d_runs").delete().eq("user_id", userId),
      supabaseAdmin.from("quotes").delete().eq("user_id", userId),
    ]);

    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (deleteError) {
      return jsonResponse({ success: false, error: "DELETE_FAILED" }, 500);
    }

    return jsonResponse({ success: true });
  } catch {
    return jsonResponse({ success: false, error: "INTERNAL_ERROR" }, 500);
  }
});