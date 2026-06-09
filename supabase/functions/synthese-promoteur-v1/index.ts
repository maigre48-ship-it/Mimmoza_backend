// supabase/functions/synthese-promoteur-v1/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { buildInvestmentMemoPrompt } from "./prompt.ts";
import type { AiSyntheseRequest, AiSyntheseResponse } from "./types.ts";

/* ============================================================
   Helpers
   ============================================================ */
function corsHeaders(extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    ...extra,
  };
}

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(extraHeaders),
  });
}

function badRequest(msg: string) {
  const out: AiSyntheseResponse = { ok: false, error: msg };
  return jsonResponse(out, 400);
}

function getTextFromAnthropicContent(content: any): string {
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text" && typeof c?.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  if (typeof content === "string") return content;
  return "";
}

/* ============================================================
   Anthropic call
   ============================================================ */
async function callClaude(
  prompt: string,
): Promise<{ markdown: string; model: string }> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY manquante (env).");

  const model =
    Deno.env.get("ANTHROPIC_MODEL") || "claude-3-5-haiku-latest";
  const maxTokens = Number(Deno.env.get("ANTHROPIC_MAX_TOKENS") || "3200");

  const controller = new AbortController();
  const timeoutMs = Number(Deno.env.get("ANTHROPIC_TIMEOUT_MS") || "90000");
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const system =
    Deno.env.get("ANTHROPIC_SYSTEM") ||
    "Tu es un analyste crédit senior (banque) spécialisé immobilier. " +
      "Rédaction dense, structurée, factuelle, orientée décision. " +
      "Aucun marketing. Ne jamais inventer de données. " +
      "Si une donnée manque : écrire 'Donnée non disponible' + action concrète pour l’obtenir.";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.1,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      const msg =
        data?.error?.message ||
        data?.message ||
        `Anthropic HTTP ${r.status}`;
      throw new Error(msg);
    }

    const markdown = getTextFromAnthropicContent(data?.content);
    if (!markdown) throw new Error("Réponse Claude vide ou illisible.");

    return { markdown, model: data?.model || model };
  } finally {
    clearTimeout(t);
  }
}

/* ============================================================
   Handler
   ============================================================ */
serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResponse({ ok: true }, 200);
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  let body: AiSyntheseRequest | null = null;
  try {
    body = (await req.json()) as AiSyntheseRequest;
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (!body?.snapshot) return badRequest("Missing snapshot");

  // ✅ Date serveur (ISO + lisible FR)
  const now = new Date();
  const dateISO = now.toISOString();
  const dateFR = now.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  // On injecte la date dans la requête passée au prompt
  const prompt = buildInvestmentMemoPrompt({
    ...body,
    snapshot: {
      ...body.snapshot,
      // métadonnées sûres côté serveur
      _meta: {
        generatedAtISO: dateISO,
        generatedAtFR: dateFR,
      } as any,
    },
  } as any);

  try {
    const { markdown, model } = await callClaude(prompt);

    const out: AiSyntheseResponse = {
      ok: true,
      markdown,
      updatedAt: dateISO,
      model,
      warnings: [],
    };

    return jsonResponse(out, 200);
  } catch (e: any) {
    const out: AiSyntheseResponse = {
      ok: false,
      error: e?.message || "Erreur Claude",
    };
    return jsonResponse(out, 500);
  }
});
