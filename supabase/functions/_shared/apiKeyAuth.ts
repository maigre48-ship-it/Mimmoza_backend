// supabase/functions/_shared/apiKeyAuth.ts
// ─────────────────────────────────────────────────────────────────────────────
// Validation des API keys Mimmoza (x-api-key ou Authorization Bearer)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Types ──────────────────────────────────────────────────────────────────

export type ValidatedApiKey = {
  id: string;
  user_id: string;
  env: "live" | "test";
  plan: "starter" | "pro" | "enterprise";
  requests_count: number;
  requests_limit: number;
};

export type AuthResult =
  | { ok: true; key: ValidatedApiKey }
  | { ok: false; status: number; error: string };

// ── Hash SHA-256 ───────────────────────────────────────────────────────────

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Extraction clé API ─────────────────────────────────────────────────────

function extractApiKey(
  authHeader: string | null,
  xApiKey: string | null
): string | null {
  // Priorité x-api-key (API publique)
  if (xApiKey) return xApiKey.trim();

  // Fallback Authorization Bearer
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  return null;
}

// ── validateApiKey ─────────────────────────────────────────────────────────

export async function validateApiKey(
  authHeader: string | null,
  xApiKey?: string | null
): Promise<AuthResult> {
  const token = extractApiKey(authHeader, xApiKey);

  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Missing API key",
    };
  }

  // Format attendu
  if (!token.startsWith("mk_live_") && !token.startsWith("mk_test_")) {
    return {
      ok: false,
      status: 401,
      error: "Invalid API key format",
    };
  }

  // Hash
  const hash = await sha256(token);

  // Logs explicites demandés
  console.log("[apiKeyAuth] token:", token);
  console.log("[apiKeyAuth] hash:", hash);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const { data, error } = await supabase
    .from("api_keys")
    .select(
      "id, user_id, env, plan, requests_count, requests_limit, revoked_at"
    )
    .eq("secret_hash", hash)
    .single();

  // Logs explicites demandés
  console.log("[apiKeyAuth] db data:", data);
  console.log("[apiKeyAuth] db error:", error);

  if (error || !data) {
    return {
      ok: false,
      status: 401,
      error: "Invalid API key",
    };
  }

  // Révocation
  if (data.revoked_at) {
    return {
      ok: false,
      status: 401,
      error: "API key revoked",
    };
  }

  // Quota
  if (data.requests_count >= data.requests_limit) {
    return {
      ok: false,
      status: 429,
      error: `Quota exceeded (${data.requests_limit})`,
    };
  }

  return {
    ok: true,
    key: {
      id: data.id,
      user_id: data.user_id,
      env: data.env,
      plan: data.plan,
      requests_count: data.requests_count,
      requests_limit: data.requests_limit,
    },
  };
}

// ── incrementUsage ─────────────────────────────────────────────────────────

export async function incrementUsage(
  keyId: string,
  endpoint: string,
  isError: boolean,
  latencyMs: number
): Promise<void> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  await supabase.rpc("increment_api_usage", {
    p_key_id: keyId,
    p_endpoint: endpoint,
    p_is_error: isError,
    p_latency: latencyMs,
  });
}

// ── CORS ───────────────────────────────────────────────────────────────────

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-api-key, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};