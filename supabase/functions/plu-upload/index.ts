// supabase/functions/plu-upload/index.ts
// Version : plu-upload-v1.2
// Objectif :
// - Recevoir un PDF de PLU (multipart/form-data)
// - Le stocker dans le bucket Storage "plu_raw"
// - Retourner { success, path }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// -----------------------------------------------------------------------------
// Env helpers
// -----------------------------------------------------------------------------
function getEnvVar(primary: string, fallback: string): string {
  return (Deno.env.get(primary) ?? Deno.env.get(fallback) ?? "").trim();
}

// ⚠️ IMPORTANT:
// - En local, `supabase functions serve --env-file` ignore souvent SUPABASE_*
// - Donc on lit SB_* en priorité.
const SUPABASE_URL = getEnvVar("SB_URL", "SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = getEnvVar("SB_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY");

const BUCKET = "plu_raw";

// -----------------------------------------------------------------------------
// Supabase client (lazy)
// -----------------------------------------------------------------------------
let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient | null {
  if (supabase) return supabase;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[plu-upload] ENV missing", {
      SB_URL: !!Deno.env.get("SB_URL"),
      SB_SERVICE_ROLE_KEY: !!Deno.env.get("SB_SERVICE_ROLE_KEY"),
      SUPABASE_URL: !!Deno.env.get("SUPABASE_URL"),
      SUPABASE_SERVICE_ROLE_KEY: !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    });
    return null;
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: {
      headers: {
        "X-Client-Info": "mimmoza-plu-upload-v1.2",
      },
    },
  });

  return supabase;
}

// -----------------------------------------------------------------------------
// Response helpers
// -----------------------------------------------------------------------------
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sanitizeFilename(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "plu.pdf";
  const safe = trimmed.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return safe.length > 180 ? safe.slice(0, 180) : safe;
}

function isLikelyPdf(file: File): boolean {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (type === "application/pdf") return true;
  if (name.endsWith(".pdf")) return true;
  return false;
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------
serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  // Log minimal à chaque POST pour confirmer que la fonction voit les env
  console.log("[plu-upload] POST received", {
    hasUrl: !!SUPABASE_URL,
    serviceKeyPrefix: SUPABASE_SERVICE_ROLE_KEY ? SUPABASE_SERVICE_ROLE_KEY.slice(0, 10) : null,
    bucket: BUCKET,
  });

  const sb = getSupabase();
  if (!sb) {
    return json(
      {
        success: false,
        error: "ENV_MISSING",
        message:
          "Missing env SB_URL / SB_SERVICE_ROLE_KEY (or SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).",
        debug: {
          SB_URL: !!Deno.env.get("SB_URL"),
          SB_SERVICE_ROLE_KEY: !!Deno.env.get("SB_SERVICE_ROLE_KEY"),
          SUPABASE_URL: !!Deno.env.get("SUPABASE_URL"),
          SUPABASE_SERVICE_ROLE_KEY: !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
        },
      },
      500,
    );
  }

  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return json(
        {
          success: false,
          error: "CONTENT_TYPE_MUST_BE_MULTIPART",
          received: contentType,
        },
        400,
      );
    }

    const formData = await req.formData();

    // Supporte plusieurs champs possibles pour éviter un mismatch front
    const fileCandidate =
      formData.get("file") ?? formData.get("pdf") ?? formData.get("plu");

    const communeInsee = (formData.get("commune_insee") ?? "").toString().trim();

    if (!(fileCandidate instanceof File)) {
      return json(
        {
          success: false,
          error: "NO_FILE_PROVIDED",
          message: "Expected multipart field 'file' (or 'pdf'/'plu') as a File.",
          debug: {
            keys: Array.from(formData.keys()),
          },
        },
        400,
      );
    }

    if (!communeInsee) {
      return json({ success: false, error: "MISSING_COMMUNE_INSEE" }, 400);
    }

    if (fileCandidate.size <= 0) {
      return json({ success: false, error: "EMPTY_FILE" }, 400);
    }

    if (!isLikelyPdf(fileCandidate)) {
      return json(
        {
          success: false,
          error: "NOT_A_PDF",
          message: "Only PDF files are accepted.",
          file: { name: fileCandidate.name, type: fileCandidate.type, size: fileCandidate.size },
        },
        400,
      );
    }

    const now = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = sanitizeFilename(fileCandidate.name);
    const path = `${communeInsee}/${now}-${safeName}`;

    const { data, error: uploadError } = await sb.storage
      .from(BUCKET)
      .upload(path, fileCandidate, {
        contentType: fileCandidate.type || "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      const anyErr = uploadError as any;

      console.error("[plu-upload] Upload error:", uploadError);

      // On renvoie un payload ACTIONNABLE côté front
      return json(
        {
          success: false,
          error: "UPLOAD_FAILED",
          message: uploadError.message,
          status: anyErr?.statusCode ?? anyErr?.status ?? null,
          name: anyErr?.name ?? null,
          cause: anyErr?.cause ?? null,
          hint:
            "Verify: (1) bucket 'plu_raw' exists in LOCAL Studio, (2) local SB_SERVICE_ROLE_KEY is correct (sb_secret_...), (3) storage is running.",
        },
        500,
      );
    }

    return json(
      {
        success: true,
        version: "plu-upload-v1.2",
        path: data?.path ?? path,
        commune_insee: communeInsee,
        bucket: BUCKET,
        file: {
          name: fileCandidate.name,
          type: fileCandidate.type,
          size: fileCandidate.size,
        },
      },
      200,
    );
  } catch (err) {
    console.error("[plu-upload] Unhandled error:", err);
    return json(
      {
        success: false,
        error: "PLU_UPLOAD_FAILED",
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
