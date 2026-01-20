/// <reference lib="deno.ns" />
/// <reference lib="dom" />

// supabase/functions/synthese-generate-v1/index.ts
// ============================================================================
// SYNTHÈSE PROMOTEUR — Edge Function (v1.4) : Anthropic + Logging robuste + Anti-blocage
//
// - Reçoit: { prompt_version, system, user, payload, options, ping? }
// - Ping: répond immédiatement pour test runtime
// - Appelle Anthropic (Claude) en utilisant system + user
// - Timeout réseau (AbortController) pour éviter tout blocage
// - Extrait décision (+ listes) depuis le markdown
// - Log best-effort dans public.promoteur_synthese_logs: meta + decision (+ payload + markdown)
//   => IMPORTANT: l'insert est "await" avec timeout court (ne doit pas bloquer la réponse)
// - Répond toujours (même si logging échoue)
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

type SyntheseDecision = "GO" | "GO_SOUS_CONDITIONS" | "NO_GO";

type SynthesePayload = {
  meta?: {
    version?: string;
    generated_at?: string;
    parcel_id?: string;
    commune?: { insee?: string; nom?: string };
  };
  [k: string]: any;
};

type ReqBody = {
  ping?: boolean;
  prompt_version?: string;
  system?: string;
  user?: string;
  payload?: SynthesePayload;
  options?: { language?: string; concise?: boolean };
};

// ----------------------------------------------------------------------------
// CORS + helpers
// ----------------------------------------------------------------------------

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(body: any, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

function asString(v: any, fallback = ""): string {
  return typeof v === "string" ? v : v == null ? fallback : String(v);
}

function normalizeDecision(raw: any): SyntheseDecision {
  const s = asString(raw, "").trim().toUpperCase();
  if (s === "GO") return "GO";
  if (s === "NO_GO" || s === "NOGO" || s === "NO GO") return "NO_GO";
  if (
    s === "GO_SOUS_CONDITIONS" ||
    s === "GO_CONDITIONNEL" ||
    s === "GO_CONDITIONS" ||
    s.includes("GO SOUS CONDITIONS")
  ) {
    return "GO_SOUS_CONDITIONS";
  }
  return "GO_SOUS_CONDITIONS";
}

function extractDecisionFromMarkdown(md: string): SyntheseDecision {
  const txt = md ?? "";

  // FR
  const m1 = txt.match(
    /\bDécision\s*[:：]\s*(GO_SOUS_CONDITIONS|GO|NO_GO|NO GO)\b/i
  );
  if (m1?.[1]) return normalizeDecision(m1[1]);

  // EN
  const m2 = txt.match(
    /\bDecision\s*[:：]\s*(GO_SOUS_CONDITIONS|GO|NO_GO|NO GO)\b/i
  );
  if (m2?.[1]) return normalizeDecision(m2[1]);

  // fallback: lignes isolées
  for (const l of txt.split("\n").map((x) => x.trim().toUpperCase())) {
    if (l === "GO") return "GO";
    if (l === "NO_GO" || l === "NO GO" || l === "NOGO") return "NO_GO";
    if (l.includes("GO_SOUS_CONDITIONS") || l.includes("GO SOUS CONDITIONS")) {
      return "GO_SOUS_CONDITIONS";
    }
  }

  return "GO_SOUS_CONDITIONS";
}

function extractBulletsUnderHeading(md: string, heading: RegExp): string[] {
  const lines = (md ?? "").split("\n");
  let active = false;
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();

    if (heading.test(l)) {
      active = true;
      continue;
    }
    if (active && /^#{1,3}\s+/.test(l)) break;
    if (!active) continue;

    const b = l.match(/^[-*]\s+(.*)$/);
    if (b?.[1]) {
      const t = b[1].trim();
      if (t) out.push(t);
    }
  }

  return Array.from(
    new Set(
      out
        .map((x) => x.replace(/\s+/g, " ").trim())
        .filter(Boolean)
    )
  ).slice(0, 12);
}

// ----------------------------------------------------------------------------
// Promesse avec timeout (utile pour logging "await" sans bloquer)
// ----------------------------------------------------------------------------

async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  timeoutMessage = "Timeout"
): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return (await Promise.race([p, timeout])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// Anthropic call (timeout obligatoire)
// ----------------------------------------------------------------------------

async function callClaude(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": params.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
        system: params.system,
        messages: [{ role: "user", content: params.user }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Anthropic API error (${res.status}): ${errText || res.statusText}`
      );
    }

    const data = await res.json();

    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
      .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    return { raw: data, text };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error("Anthropic API timeout (fetch aborted).");
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { success: false, error: "Method not allowed" },
      405,
      origin
    );
  }

  const startedAt = Date.now();

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return jsonResponse(
      { success: false, error: "Body JSON invalide." },
      400,
      origin
    );
  }

  // Ping (diagnostic)
  if (body?.ping === true) {
    return jsonResponse(
      {
        success: true,
        pong: true,
        received: {
          prompt_version: body?.prompt_version ?? null,
          hasSystem: typeof body?.system === "string" && body.system.length > 0,
          hasUser: typeof body?.user === "string" && body.user.length > 0,
          hasPayloadMeta: !!body?.payload?.meta,
        },
      },
      200,
      origin
    );
  }

  const prompt_version = asString(body.prompt_version, "unknown");
  const system = asString(body.system, "").trim();
  const user = asString(body.user, "").trim();
  const payload = (body.payload ?? {}) as SynthesePayload;

  if (!system || !user) {
    return jsonResponse(
      { success: false, error: "Champs requis manquants: 'system' et/ou 'user'." },
      400,
      origin
    );
  }

  // Env (IMPORTANT: Edge runtime ignore les variables qui commencent par SUPABASE_)
  // => utilisez SB_URL + SB_SERVICE_ROLE_KEY dans .env.local
  const SB_URL = Deno.env.get("SB_URL") ?? "";
  const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  const ANTHROPIC_MODEL =
    Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-5-sonnet-20240620";

  if (!ANTHROPIC_API_KEY) {
    return jsonResponse(
      { success: false, error: "ANTHROPIC_API_KEY manquante (env)." },
      500,
      origin
    );
  }

  // Supabase client (logging) — best effort
  const canLog = !!(SB_URL && SB_SERVICE_ROLE_KEY);
  const supabase = canLog
    ? createClient(SB_URL, SB_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

  // Helper logging "await" + timeout court + swallow errors
  async function logRow(row: Record<string, any>) {
    if (!supabase) return;

    try {
      const p = supabase.from("promoteur_synthese_logs").insert(row);
      // Timeout court: on veut "être sûr que l'insert est déclenché",
      // mais on ne veut pas risquer de bloquer la réponse si DB lente.
      const res: any = await withTimeout(p, 2500, "Logging insert timeout");
      if (res?.error) {
        // On n'échoue jamais la requête user pour un problème de log
        // (table manquante, RLS, type mismatch, etc.)
      }
    } catch {
      // swallow
    }
  }

  try {
    // Call Claude with timeout
    const claude = await callClaude({
      apiKey: ANTHROPIC_API_KEY,
      model: ANTHROPIC_MODEL,
      system,
      user,
      maxTokens: 2400,
      temperature: 0.2,
      timeoutMs: 45000,
    });

    const markdown = claude.text || "";
    const decision = extractDecisionFromMarkdown(markdown);

    const points_forts =
      extractBulletsUnderHeading(markdown, /^##\s*Points forts\b/i) ||
      extractBulletsUnderHeading(markdown, /^##\s*Strengths\b/i);

    const risques_cles =
      extractBulletsUnderHeading(markdown, /^##\s*Risques clés\b/i) ||
      extractBulletsUnderHeading(markdown, /^##\s*Key risks\b/i);

    const elapsed_ms = Date.now() - startedAt;

    // Logging: "await" + timeout court (robuste)
    await logRow({
      prompt_version,
      model: ANTHROPIC_MODEL,
      meta: payload?.meta ?? null,
      decision,
      payload,
      markdown,
      elapsed_ms,
      success: true,
      error: null,
    });

    return jsonResponse(
      {
        success: true,
        data: { markdown, decision, points_forts, risques_cles },
        meta: {
          prompt_version,
          model: ANTHROPIC_MODEL,
          elapsed_ms,
          payload_meta: payload?.meta ?? null,
          usage: claude.raw?.usage ?? null,
          id: claude.raw?.id ?? null,
          stop_reason: claude.raw?.stop_reason ?? null,
          logging_enabled: !!supabase,
        },
      },
      200,
      origin
    );
  } catch (e: any) {
    const errMsg = asString(e?.message, "Erreur inconnue.");
    const elapsed_ms = Date.now() - startedAt;

    // Logging erreur: "await" + timeout court (robuste)
    await logRow({
      prompt_version,
      model: ANTHROPIC_MODEL,
      meta: payload?.meta ?? null,
      decision: null,
      payload,
      markdown: null,
      elapsed_ms,
      success: false,
      error: errMsg,
    });

    return jsonResponse(
      {
        success: false,
        error: errMsg,
        meta: {
          prompt_version,
          model: ANTHROPIC_MODEL,
          elapsed_ms,
          payload_meta: payload?.meta ?? null,
          logging_enabled: !!supabase,
        },
      },
      500,
      origin
    );
  }
});
