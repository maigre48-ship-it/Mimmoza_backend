// supabase/functions/plu-ingest-from-storage/index.ts
// Version : plu-ingest-from-storage-v10.1
// SECURITY HARDENING: no sensitive leaks in logs/responses

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v || !v.toString().trim()) {
    throw new Error(`MISSING_ENV:${name}`);
  }
  return v.toString().trim();
}

function getEnv(name: string): string | null {
  const v = Deno.env.get(name);
  const s = (v ?? "").toString().trim();
  return s ? s : null;
}

function assertValidUrl(_name: string, value: string): string | null {
  try {
    new URL(value);
    return null;
  } catch {
    return "INVALID_URL";
  }
}

const SUPABASE_URL = getEnv("SUPABASE_URL") ?? getEnv("MIMMOZA_SUPABASE_URL") ?? "";

const SUPABASE_SERVICE_ROLE_KEY =
  getEnv("SUPABASE_SERVICE_ROLE_KEY") ??
  getEnv("MIMMOZA_SERVICE_ROLE_KEY") ??
  "";

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("MISSING_ENV:SUPABASE_SERVICE_ROLE_KEY");
}

const MIMMOZA_ANON_KEY = requireEnv("MIMMOZA_ANON_KEY");

const DEFAULT_PLU_PARSER_URL = "https://mimmoza-plu-parser.onrender.com";

const PLU_PARSER_BASE = (
  getEnv("PLU_PARSER_API_URL") ??
  getEnv("PLU_PARSER_URL") ??
  DEFAULT_PLU_PARSER_URL
)
  .trim()
  .replace(/\/+$/, "");

const PLU_PARSER_TOKEN = (
  getEnv("PLU_PARSER_BEARER_TOKEN") ??
  getEnv("PLU_PARSER_KEY") ??
  getEnv("PLU_PARSER_API_KEY") ??
  ""
).trim();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const FUNCTIONS_BASE_URL = SUPABASE_URL.includes("supabase.co")
  ? SUPABASE_URL.replace(".supabase.co", ".functions.supabase.co")
  : `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function safeStr(v: unknown): string {
  return (v ?? "").toString();
}

function isInternalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "kong" ||
    lower.startsWith("192.168.") ||
    lower.startsWith("10.") ||
    lower === "host.docker.internal"
  );
}

function makePublicSignedUrl(signedUrlRaw: string, supabaseUrl: string): string {
  if (!signedUrlRaw) return signedUrlRaw;

  const trimmed = signedUrlRaw.trim();
  const baseUrl = supabaseUrl.replace(/\/+$/, "");

  if (trimmed.startsWith("/")) {
    return `${baseUrl}${trimmed}`;
  }

  try {
    const u = new URL(trimmed);

    if (isInternalHost(u.hostname)) {
      const base = new URL(baseUrl);
      return `${base.origin}${u.pathname}${u.search}`;
    }

    return trimmed;
  } catch {
    return `${baseUrl}/${trimmed}`;
  }
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    if (!SUPABASE_URL) {
      return jsonResponse({ success: false, error: "MISSING_ENV_SUPABASE_URL" }, 500);
    }

    let supabaseHost = "";
    try {
      supabaseHost = new URL(SUPABASE_URL).hostname;
    } catch {
      return jsonResponse({ success: false, error: "INVALID_ENV_SUPABASE_URL" }, 500);
    }

    if (isInternalHost(supabaseHost)) {
      return jsonResponse({ success: false, error: "SUPABASE_URL_MUST_BE_CLOUD_IN_PROD" }, 500);
    }

    const parserFullUrl = `${PLU_PARSER_BASE}/api/plu-parse`;
    const parserUrlErr = assertValidUrl("PLU_PARSER_URL", parserFullUrl);

    if (parserUrlErr) {
      return jsonResponse({ success: false, error: "INVALID_ENV_PLU_PARSER_URL" }, 500);
    }

    if (!PLU_PARSER_TOKEN) {
      return jsonResponse({ success: false, error: "MISSING_ENV_PLU_PARSER_TOKEN" }, 500);
    }

    const body = await req.json().catch(() => ({}));

    const commune_insee = safeStr(body.commune_insee).trim();
    const commune_nom = safeStr(body.commune_nom ?? body.commune_name).trim() || null;
    const requested_storage_path = safeStr(body.storage_path).trim() || null;

    if (!commune_insee) {
      return jsonResponse({ success: false, error: "MISSING_COMMUNE_INSEE" }, 400);
    }

    const BUCKET_NAME = "plu_raw";

    const { data: files, error: listError } = await supabase.storage
      .from(BUCKET_NAME)
      .list(commune_insee, {
        limit: 100,
        sortBy: { column: "name", order: "desc" },
      });

    if (listError) {
      return jsonResponse({ success: false, error: "STORAGE_LIST_ERROR" }, 500);
    }

    if (!files || files.length === 0) {
      return jsonResponse({ success: false, error: "NO_PLU_PDF_FOUND_FOR_COMMUNE" }, 404);
    }

    let storagePath: string;

    if (requested_storage_path) {
      if (!requested_storage_path.startsWith(`${commune_insee}/`)) {
        return jsonResponse({ success: false, error: "INVALID_STORAGE_PATH" }, 400);
      }

      storagePath = requested_storage_path;
    } else {
      const latestFile = files[0];
      storagePath = `${commune_insee}/${latestFile.name}`;
    }

    const { data: signed, error: signedError } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(storagePath, 10 * 60);

    if (signedError || !signed?.signedUrl) {
      return jsonResponse({ success: false, error: "SIGNED_URL_ERROR" }, 500);
    }

    const signedUrlRaw = signed.signedUrl;
    const finalSignedUrl = makePublicSignedUrl(signedUrlRaw, SUPABASE_URL);

    console.log("[PLU_INGEST] signed url generated");

    const parserPayload = {
      commune_insee,
      commune_nom,
      source_pdf_url: finalSignedUrl,
    };

    console.log("[PLU_INGEST] parser call");

    let parserRes: Response;
    let parserJson: any = null;

    try {
      parserRes = await fetch(parserFullUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PLU_PARSER_TOKEN}`,
        },
        body: JSON.stringify(parserPayload),
      });

      const parserRawText = await parserRes.text();

      try {
        parserJson = JSON.parse(parserRawText);
      } catch {
        parserJson = null;
      }
    } catch (_e) {
      console.log("[PLU_INGEST] parser call failed");
      return jsonResponse({ success: false, error: "PLU_PARSER_FETCH_ERROR" }, 200);
    }

    if (!parserRes.ok) {
      console.log("[PLU_INGEST] parser call failed");

      return jsonResponse(
        {
          success: false,
          error: "PLU_PARSER_FAILED",
          status: parserRes.status,
        },
        200,
      );
    }

    if (!parserJson?.success) {
      console.log("[PLU_INGEST] parser call failed");

      return jsonResponse(
        {
          success: false,
          error: "PLU_PARSER_RESPONSE_NOT_SUCCESS",
          status: parserRes.status,
        },
        200,
      );
    }

    console.log("[PLU_INGEST] parser call succeeded");

    const zones_rulesets = parserJson?.zones_rulesets;

    if (!Array.isArray(zones_rulesets) || zones_rulesets.length === 0) {
      return jsonResponse({ success: false, error: "PARSER_INVALID_OUTPUT" }, 200);
    }

    const ingestBody = {
      commune_insee,
      commune_nom,
      plu_version_label: parserJson.plu_version_label ?? null,
      storage_path: storagePath,
      source_document: storagePath,
      zones_rulesets,
    };

    const ingestRes = await fetch(`${FUNCTIONS_BASE_URL}/plu-ingest-rulesets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: MIMMOZA_ANON_KEY,
        Authorization: `Bearer ${MIMMOZA_ANON_KEY}`,
      },
      body: JSON.stringify(ingestBody),
    });

    const ingestJson = await ingestRes.json().catch(() => null);

    if (!ingestJson?.success) {
      return jsonResponse(
        {
          success: false,
          error: "PLU_INGEST_RULESETS_FAILED",
        },
        200,
      );
    }

    return jsonResponse(
      {
        success: true,
        version: "plu-ingest-from-storage-v10.1",
        commune_insee,
        commune_nom,
        ingest: {
          success: true,
        },
      },
      200,
    );
  } catch (_e) {
    console.log("[PLU_INGEST] internal error");

    return jsonResponse(
      {
        success: false,
        error: "PLU_INGEST_FROM_STORAGE_INTERNAL_ERROR",
      },
      200,
    );
  }
});