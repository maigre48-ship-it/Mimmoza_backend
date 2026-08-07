// supabase/functions/_shared/apiKeyAuth.ts
// ─────────────────────────────────────────────────────────────────────────────
// Validation des API keys Mimmoza (x-api-key ou Authorization Bearer)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractApiKey(
  authHeader: string | null,
  xApiKey: string | null,
): string | null {
  if (xApiKey) return xApiKey.trim();

  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  return null;
}

export async function validateApiKey(
  authHeader: string | null,
  xApiKey?: string | null,
): Promise<AuthResult> {
  const token = extractApiKey(authHeader, xApiKey);

  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Missing API key",
    };
  }

  if (!token.startsWith("mk_live_") && !token.startsWith("mk_test_")) {
    return {
      ok: false,
      status: 401,
      error: "Invalid API key format",
    };
  }

  const hash = await sha256(token);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    {
      auth: {
        persistSession: false,
      },
    },
  );

  const { data, error } = await supabase
    .from("api_keys")
    .select(
      "id, user_id, env, plan, requests_count, requests_limit, revoked_at",
    )
    .eq("secret_hash", hash)
    .single();

  if (error || !data) {
    return {
      ok: false,
      status: 401,
      error: "Invalid API key",
    };
  }

  if (data.revoked_at) {
    return {
      ok: false,
      status: 401,
      error: "API key revoked",
    };
  }

  if (data.requests_count >= data.requests_limit) {
    return {
      ok: false,
      status: 429,
      error: "Quota exceeded",
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

export async function incrementUsage(
  keyId: string,
  endpoint: string,
  isError: boolean,
  latencyMs: number,
  cost = 1,
): Promise<void> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    {
      auth: {
        persistSession: false,
      },
    },
  );

  await supabase.rpc("increment_api_usage", {
    p_key_id: keyId,
    p_endpoint: endpoint,
    p_is_error: isError,
    p_latency: latencyMs,
    p_cost: cost,
  });
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-api-key, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};