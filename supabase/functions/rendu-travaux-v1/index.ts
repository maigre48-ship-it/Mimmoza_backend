// supabase/functions/rendu-travaux-v1/index.ts
//
// V4 — IMAGE EDIT + MASK (gpt-image-1)
//
// DALL-E 2 était trop limité pour les intérieurs (modifications quasi invisibles).
// gpt-image-1 comprend le contexte et applique vraiment les changements.
//
// Différences gpt-image-1 vs dall-e-2 :
//   ✅ Prompt long (32k tokens) → pas de troncature
//   ✅ Bien meilleure compréhension renovation intérieure
//   ✅ Retourne b64_json (on reconstruit data URL côté hook)
//   ✅ Mask PNG blanc/noir supporté
//   ⚠️  Pas de response_format param (toujours b64_json)
//   ⚠️  Pas de size param fixe

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// ── CORS ──────────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Helpers base64 ────────────────────────────────────────────────

function base64ToUint8Array(base64OrDataUrl: string): Uint8Array {
  const base64 = base64OrDataUrl.includes(",")
    ? base64OrDataUrl.split(",")[1]
    : base64OrDataUrl;

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64ToBlob(base64OrDataUrl: string, mimeType = "image/png"): Blob {
  const bytes = base64ToUint8Array(base64OrDataUrl);
  return new Blob([bytes], { type: mimeType });
}

// ── Validation ────────────────────────────────────────────────────

interface ParsedInputs {
  imageBlob: Blob;
  maskBlob: Blob;
  prompt: string;
}

function validateAndParse(body: Record<string, unknown>): ParsedInputs {
  const { image_base64, mask_base64, prompt } = body;

  if (!image_base64 || typeof image_base64 !== "string") {
    throw new Error("Champ manquant : image_base64");
  }
  if (!mask_base64 || typeof mask_base64 !== "string") {
    throw new Error("Champ manquant : mask_base64");
  }
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("Champ manquant : prompt");
  }

  // gpt-image-1 supporte les prompts longs — pas de troncature
  const imageBlob = base64ToBlob(image_base64, "image/png");
  const maskBlob  = base64ToBlob(mask_base64,  "image/png");

  return { imageBlob, maskBlob, prompt };
}

// ── Appel gpt-image-1 /images/edits ──────────────────────────────

interface EditResult {
  imageBase64: string;
  durationMs: number;
}

async function callGptImageEdit(params: {
  imageBlob: Blob;
  maskBlob:  Blob;
  prompt:    string;
  apiKey:    string;
}): Promise<EditResult> {
  const { imageBlob, maskBlob, prompt, apiKey } = params;
  const t0 = Date.now();

  const form = new FormData();
  form.append("model",   "gpt-image-1");
  form.append("image",   imageBlob, "image.png");
  form.append("mask",    maskBlob,  "mask.png");
  form.append("prompt",  prompt);
  form.append("n",       "1");
  form.append("quality", "medium"); // "low" | "medium" | "high"

  console.log("[RenduTravaux] → POST /v1/images/edits (gpt-image-1)", {
    promptLength:   prompt.length,
    imageSizeBytes: imageBlob.size,
    maskSizeBytes:  maskBlob.size,
  });

  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method:  "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    // ⚠️ NE PAS forcer Content-Type — boundary multipart auto
    body: form,
  });

  const rawText = await resp.text();

  if (!resp.ok) {
    let detail = rawText;
    try {
      const err = JSON.parse(rawText);
      detail = err?.error?.message ?? err?.error ?? rawText;
    } catch { /* garder texte brut */ }
    console.error("[RenduTravaux] OpenAI error", {
      status: resp.status,
      detail: detail.slice(0, 400),
    });
    throw new Error(`OpenAI API error (${resp.status}): ${detail}`);
  }

  let data: { data?: Array<{ b64_json?: string; url?: string }> };
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error("Réponse OpenAI non parseable");
  }

  // gpt-image-1 retourne toujours b64_json
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    console.error("[RenduTravaux] Réponse inattendue :", JSON.stringify(data).slice(0, 300));
    throw new Error("Aucune image retournée par OpenAI (b64_json absent)");
  }

  return { imageBase64: b64, durationMs: Date.now() - t0 };
}

// ── Serve ─────────────────────────────────────────────────────────

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  const t0 = Date.now();

  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return json({ success: false, error: "OPENAI_API_KEY manquante" }, 500);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ success: false, error: "JSON invalide" }, 400);
    }

    console.log("[RenduTravaux] START", {
      hasImage:     Boolean(body.image_base64),
      hasMask:      Boolean(body.mask_base64),
      hasPrompt:    Boolean(body.prompt),
      imageSizeKb:  typeof body.image_base64 === "string" ? Math.round((body.image_base64 as string).length / 1024) : 0,
      maskSizeKb:   typeof body.mask_base64  === "string" ? Math.round((body.mask_base64  as string).length / 1024) : 0,
      promptLength: typeof body.prompt       === "string" ? (body.prompt as string).length : 0,
    });

    let inputs: ParsedInputs;
    try {
      inputs = validateAndParse(body);
    } catch (e) {
      return json({ success: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }

    const { imageBase64, durationMs } = await callGptImageEdit({
      imageBlob: inputs.imageBlob,
      maskBlob:  inputs.maskBlob,
      prompt:    inputs.prompt,
      apiKey,
    });

    console.log("[RenduTravaux] SUCCESS", {
      editDurationMs: durationMs,
      totalMs:        Date.now() - t0,
      b64Kb:          Math.round(imageBase64.length / 1024),
    });

    return json({
      success:      true,
      image_base64: imageBase64, // PNG base64 pur — le hook reconstruit la data URL
      duration_ms:  Date.now() - t0,
    });

  } catch (e) {
    console.error("[RenduTravaux] FATAL:", e);
    return json({
      success:    false,
      error:      e instanceof Error ? e.message : String(e),
      duration_ms: Date.now() - t0,
    }, 500);
  }
});