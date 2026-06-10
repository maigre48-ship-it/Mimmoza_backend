// supabase/functions/plu-upload/index.ts
// Version : plu-upload-v1.1
// Objectif :
// - Recevoir un PDF de PLU (multipart/form-data)
// - Le stocker dans le bucket Storage "plu_raw"
// - Retourner { success, path }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function isValidCommuneInsee(value: string): boolean {
  return /^\d{5}$/.test(value);
}

function isPdfFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();

  return type === "application/pdf" || name.endsWith(".pdf");
}

function sanitizeFileName(name: string): string {
  const clean = name
    .replace(/[^a-zA-Z0-9.\-_]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);

  return clean || "plu.pdf";
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[plu-upload] missing environment configuration");
    return jsonResponse({ success: false, error: "MISSING_ENV" }, 500);
  }

  try {
    const contentType = req.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return jsonResponse(
        { success: false, error: "CONTENT_TYPE_MUST_BE_MULTIPART" },
        400,
      );
    }

    const formData = await req.formData();

    const file = formData.get("file");
    const communeInsee = (formData.get("commune_insee") ?? "")
      .toString()
      .trim();

    if (!(file instanceof File)) {
      return jsonResponse({ success: false, error: "NO_FILE_PROVIDED" }, 400);
    }

    if (!isValidCommuneInsee(communeInsee)) {
      return jsonResponse({ success: false, error: "INVALID_COMMUNE_INSEE" }, 400);
    }

    if (!isPdfFile(file)) {
      return jsonResponse({ success: false, error: "INVALID_FILE_TYPE" }, 400);
    }

    if (file.size <= 0) {
      return jsonResponse({ success: false, error: "EMPTY_FILE" }, 400);
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      return jsonResponse({ success: false, error: "FILE_TOO_LARGE" }, 413);
    }

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const now = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = sanitizeFileName(file.name);
    const path = `${communeInsee}/${now}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from("plu_raw")
      .upload(path, bytes, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      console.error("[plu-upload] upload failed");
      return jsonResponse({ success: false, error: "UPLOAD_FAILED" }, 500);
    }

    return jsonResponse(
      {
        success: true,
        version: "plu-upload-v1.1",
        path,
        commune_insee: communeInsee,
      },
      200,
    );
  } catch (_e) {
    console.error("[plu-upload] internal error");

    return jsonResponse(
      {
        success: false,
        error: "PLU_UPLOAD_FAILED",
      },
      500,
    );
  }
});