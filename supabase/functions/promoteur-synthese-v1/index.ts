// supabase/functions/promoteur-synthese-v1/index.ts
import { corsHeaders } from "../_shared/cors.ts";
import type { SyntheseGenerateRequest, SyntheseGenerateResponse } from "./types.ts";
import { buildClaudeUserPayload, buildTitle, buildWarnings } from "./composer.ts";
import { CLAUDE_SYSTEM_PROMPT, buildClaudeUserPrompt } from "./prompts.ts";

const VERSION = "v1.0";

function mustGetEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function callClaudeMarkdown(opts: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const apiKey = mustGetEnv("ANTHROPIC_API_KEY");
  const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-5-sonnet-20241022";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 1400,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });

  const json = await res.json();

  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `Claude API error (${res.status})`;
    throw new Error(msg);
  }

  const blocks = json?.content;
  if (Array.isArray(blocks)) {
    const text = blocks
      .map((b: any) => (b?.type === "text" ? b?.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }

  const fallback = json?.completion || json?.text;
  if (typeof fallback === "string" && fallback.trim()) return fallback;

  throw new Error("Réponse Claude vide ou non parsable.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    const payload = (await req.json()) as SyntheseGenerateRequest;

    if (!payload?.context) {
      return new Response(
        JSON.stringify({ success: false, version: VERSION, error: "Missing context" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    const userData = buildClaudeUserPayload(payload.context);
    const userPrompt = buildClaudeUserPrompt(JSON.stringify(userData, null, 2));

    const markdown = await callClaudeMarkdown({
      system: CLAUDE_SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: 1800,
    });

    const warnings = buildWarnings(payload.context);
    const title = buildTitle(payload.context);

    const out: SyntheseGenerateResponse = {
      success: true,
      version: VERSION,
      title,
      markdown,
      meta: {
        generated_at: new Date().toISOString(),
        warnings: warnings.length ? warnings : undefined,
      },
    };

    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ success: false, version: VERSION, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
    );
  }
});
