/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

const DELETE_TARGETS: Array<{ table: string; column: string }> = [
  { table: "access_audit_log", column: "user_id" },
  { table: "admin_subscriptions", column: "user_id" },
  { table: "admin_token_ledger", column: "user_id" },
  { table: "admin_usage_log", column: "user_id" },
  { table: "admin_users", column: "user_id" },

  { table: "analyses", column: "user_id" },
  { table: "api_keys", column: "user_id" },
  { table: "banque_dossiers", column: "user_id" },
  { table: "billing_invoices", column: "user_id" },
  { table: "billing_profiles", column: "user_id" },

  { table: "comparison_sessions", column: "user_id" },
  { table: "copilot_analyses", column: "user_id" },
  { table: "copilot_conversations", column: "user_id" },
  { table: "copilot_credit_ledger", column: "user_id" },
  { table: "copilot_credits_balance", column: "user_id" },
  { table: "copilot_messages", column: "user_id" },
  { table: "copilot_tool_calls", column: "user_id" },
  { table: "copilot_usage_daily", column: "user_id" },

  { table: "credit_accounts", column: "user_id" },
  { table: "credit_transactions", column: "user_id" },
  { table: "implantation_sessions", column: "user_id" },
  { table: "listings", column: "user_id" },

  { table: "market_refresh_usage", column: "user_id" },
  { table: "market_watch_zones", column: "user_id" },
  { table: "market_zone_refresh_log", column: "user_id" },
  { table: "my_account_context", column: "user_id" },

  { table: "opportunities", column: "user_id" },
  { table: "organisation_members", column: "user_id" },
  { table: "pipeline_alerts", column: "user_id" },
  { table: "plu_user_overrides_v1", column: "user_id" },

  { table: "projects", column: "created_by" },
  { table: "promoteur_profiles", column: "owner_id" },
  { table: "promoteur_studies", column: "user_id" },

  { table: "searches", column: "user_id" },
  { table: "smartscore_history", column: "user_id" },
  { table: "smartscore_user_weights", column: "user_id" },
  { table: "sourcing_items", column: "user_id" },
  { table: "token_ledger", column: "user_id" },

  { table: "user_opportunity_views", column: "user_id" },
  { table: "user_watchlists", column: "user_id" },
  { table: "user_zone_notifications", column: "user_id" },
  { table: "veille_user_summary", column: "user_id" },
  { table: "watch_zones", column: "user_id" },
];

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "server_configuration_error" }, 500);
  }

  const authHeader = req.headers.get("Authorization");

  if (!authHeader) {
    return jsonResponse({ error: "missing_authorization_header" }, 401);
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const userId = user.id;

  const deletedFrom: string[] = [];

  for (const target of DELETE_TARGETS) {
    const { error } = await adminClient
      .from(target.table)
      .delete()
      .eq(target.column, userId);

    if (error) {
      return jsonResponse(
        {
          error: "delete_user_data_failed",
          table: target.table,
        },
        500,
      );
    }

    deletedFrom.push(`${target.table}.${target.column}`);
  }

  const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(
    userId,
  );

  if (deleteAuthError) {
    return jsonResponse({ error: "delete_auth_user_failed" }, 500);
  }

  return jsonResponse({
    success: true,
    deletedFrom,
  });
});