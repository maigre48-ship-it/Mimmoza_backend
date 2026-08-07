// FILE: supabase/functions/banque-operation-enrich-v1/index.ts
// ============================================================================
// banque-operation-enrich-v1/index.ts
// Orchestrateur BEST-EFFORT pour l'espace Banque.
// ✅ Toujours renvoie `operation_enriched` + `operation` (alias) pour compat front.
// ✅ Forward Authorization entrant si présent, sinon Service Role.
// ✅ result.operation_enriched mirrored for extra safety.
// ✅ FIX: lecture rétro-compatible des options (top-level fallback)
// ✅ FIX: userId extraction from JWT + ownership on upsert + forwarded to committee
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ── ENV ──
const SUPABASE_URL =
  Deno.env.get("MIMMOZA_SUPABASE_PUBLIC_URL") ??
  Deno.env.get("MIMMOZA_SUPABASE_URL") ??
  Deno.env.get("SUPABASE_URL") ??
  "";

const EDGE_INTERNAL_URL = Deno.env.get("MIMMOZA_EDGE_INTERNAL_URL") ?? "";

const SERVICE_ROLE_JWT =
  Deno.env.get("MIMMOZA_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

// ── POINT 1: ANON KEY for auth.getUser only – NEVER service role ──
const ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("MIMMOZA_SUPABASE_ANON_KEY") ??
  "";

// ── CORS ──
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Types ──
interface EnrichInput {
  dossierId: string;
  profile: "particulier" | "marchand" | "promoteur" | "entreprise";
  operation?: Record<string, any>;
  options?: {
    refresh?: boolean;
    withRiskStudy?: boolean;
    withMarketStudy?: boolean;
    projectType?:
      | "logement"
      | "commerce"
      | "bureaux"
      | "hotel"
      | "residence_etudiante"
      | "ehpad";
    radiusKm?: number;
    debug?: boolean;
  };
}

interface StepResult {
  ok: boolean;
  data?: any;
  error?: string;
  durationMs?: number;
}

// ── helpers ──
function jsonResp(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function log(msg: string, enabled: boolean): void {
  if (enabled) console.log(`[ENRICH-ORCH] ${msg}`);
}

function pickAuth(req: Request): { authorization: string; apikey: string } {
  const incoming =
    req.headers.get("authorization") || req.headers.get("Authorization") || "";

  if (incoming.toLowerCase().startsWith("bearer ")) {
    const apiKey =
      req.headers.get("apikey") ||
      req.headers.get("Apikey") ||
      req.headers.get("x-apikey") ||
      SERVICE_ROLE_JWT;

    return { authorization: incoming, apikey: apiKey || SERVICE_ROLE_JWT };
  }

  return {
    authorization: `Bearer ${SERVICE_ROLE_JWT}`,
    apikey: SERVICE_ROLE_JWT,
  };
}

// ── POINT 1: Extract userId from incoming JWT (best-effort, never crashes) ──
async function extractUserId(req: Request, debug: boolean): Promise<string | null> {
  const authHeader =
    req.headers.get("authorization") || req.headers.get("Authorization") || "";

  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    log("userId extraction: no Bearer token → userId=null", debug);
    return null;
  }

  if (!SUPABASE_URL) {
    log("userId extraction: SUPABASE_URL missing → userId=null", debug);
    return null;
  }

  if (!ANON_KEY) {
    log("userId extraction: ANON_KEY missing → userId=null (non-blocking)", debug);
    return null;
  }

  try {
    const supabaseAnon = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data, error } = await supabaseAnon.auth.getUser();
    if (error || !data?.user?.id) {
      log(`userId extraction: auth.getUser → null (${error?.message ?? "no user"})`, debug);
      return null;
    }

    log(`userId extraction: OK → userId=${data.user.id}`, debug);
    return data.user.id;
  } catch (e) {
    log(`userId extraction: exception → userId=null (${e instanceof Error ? e.message : String(e)})`, debug);
    return null;
  }
}

async function callFn(
  req: Request,
  slug: string,
  body: Record<string, any>,
  timeoutMs = 60_000
): Promise<StepResult> {
  const baseUrl = EDGE_INTERNAL_URL || SUPABASE_URL;
  const url = `${baseUrl}/functions/v1/${slug}`;
  const { authorization, apikey } = pickAuth(req);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();

  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: authorization,
        apikey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });

    clearTimeout(timer);
    const durationMs = Date.now() - t0;

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `${slug} HTTP ${resp.status}: ${text.slice(0, 600)}`,
        durationMs,
      };
    }

    const text = await resp.text().catch(() => "");
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }

    return { ok: true, data, durationMs };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `${slug}: ${msg.toLowerCase().includes("abort") ? "Timeout" : msg}`,
      durationMs: Date.now() - t0,
    };
  }
}

// ── POINT 2: ensureDossierRow now accepts optional userId for ownership ──
async function ensureDossierRow(
  dossierId: string,
  operation?: Record<string, any>,
  userId?: string | null
): Promise<{ ok: boolean; error?: string }> {
  const project = operation?.project ?? {};
  const now = new Date().toISOString();

  const row: Record<string, any> = { id: dossierId, updated_at: now };

  // Claim ownership if userId is known
  if (userId) row.user_id = userId;

  if (project.address) row.adresse = project.address;
  if (project.zipCode) row.code_postal = project.zipCode;
  if (project.city) row.ville = project.city;
  if (project.lat) row.lat = project.lat;
  if (project.lng) row.lng = project.lng;
  if (project.communeInsee) row.commune_insee = project.communeInsee;

  try {
    const url = `${SUPABASE_URL}/rest/v1/banque_dossiers`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_JWT}`,
        apikey: SERVICE_ROLE_JWT,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `Upsert dossier HTTP ${resp.status}: ${text.slice(0, 600)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Upsert dossier: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function patchDossierColumn(
  dossierId: string,
  column: string,
  value: any
): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/banque_dossiers?id=eq.${dossierId}`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_JWT}`,
        apikey: SERVICE_ROLE_JWT,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ [column]: value, updated_at: new Date().toISOString() }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `Patch ${column} HTTP ${resp.status}: ${text.slice(0, 600)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Patch ${column}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function readDossierGeo(
  dossierId: string
): Promise<{ lat?: number; lng?: number; commune_insee?: string }> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/banque_dossiers?id=eq.${dossierId}&select=lat,lng,commune_insee`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_JWT}`,
        apikey: SERVICE_ROLE_JWT,
        Accept: "application/json",
      },
    });
    if (!resp.ok) return {};
    const rows = await resp.json();
    return rows?.[0] ?? {};
  } catch {
    return {};
  }
}

/** Build enriched operation — ALWAYS produces a valid object */
function buildOperationEnriched(params: {
  operation?: any;
  dossierId: string;
  profile: string;
  geo?: { lat?: number; lng?: number; communeInsee?: string };
  risksRefresh?: any;
  riskStudy?: any;
  marketStudy?: any;
  committee?: any;
}): any {
  const op = params.operation ?? {};
  const project = op.project ?? {};

  const enriched = {
    ...op,
    dossierId: params.dossierId,
    profile: params.profile,

    project: {
      ...project,
      lat: project.lat ?? params.geo?.lat,
      lng: project.lng ?? params.geo?.lng,
      communeInsee: project.communeInsee ?? params.geo?.communeInsee,
    },

    risks: op.risks ?? params.risksRefresh ?? null,
    riskStudy: op.riskStudy ?? params.riskStudy ?? null,
    market: op.market ?? params.marketStudy ?? null,
    dvf: op.dvf ?? null,

    committee: params.committee ?? null,
  };

  return enriched;
}

// ════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (!SUPABASE_URL) return jsonResp({ ok: false, error: "Missing SUPABASE_URL" }, 500);
  if (!SERVICE_ROLE_JWT) return jsonResp({ ok: false, error: "Missing SERVICE_ROLE_JWT" }, 500);

  const t0Global = Date.now();

  try {
    const body: EnrichInput = await req.json();
    const { dossierId, profile, operation, options } = body;

    // ✅ FIX: Lecture rétro-compatible — options.X ?? body.X ?? default
    const refresh =
      options?.refresh ??
      (body as any).refresh ??
      false;

    const withRiskStudy =
      options?.withRiskStudy ??
      (body as any).withRiskStudy ??
      false;

    const withMarketStudy =
      options?.withMarketStudy ??
      (body as any).withMarketStudy ??
      false;

    const projectType =
      options?.projectType ??
      (body as any).projectType ??
      "logement";

    const radiusKm =
      options?.radiusKm ??
      (body as any).radiusKm ??
      5;

    const debug =
      options?.debug ??
      (body as any).debug ??
      false;

    if (!dossierId) return jsonResp({ ok: false, error: "Missing dossierId" }, 400);
    if (!profile) return jsonResp({ ok: false, error: "Missing profile" }, 400);

    const warnings: string[] = [];
    const sources: string[] = [];
    const timings: Record<string, number> = {};
    const result: Record<string, any> = {};

    // ── POINT 1: Extract userId from JWT (best-effort, never blocks) ──
    const userId = await extractUserId(req, debug);
    // POINT 6: safe log – presence only, never the token
    log(`userId=${userId ? "present" : "absent"}`, debug);

    log(`▶ START dossier=${dossierId} profile=${profile} refresh=${refresh} withMarketStudy=${withMarketStudy} withRiskStudy=${withRiskStudy}`, debug);

    // STEP 0 — POINT 2: pass userId for ownership claim on upsert
    const upsertRes = await ensureDossierRow(dossierId, operation, userId);
    if (!upsertRes.ok) warnings.push(`Upsert dossier: ${upsertRes.error}`);

    // STEP 1 risks-refresh
    let risksRefresh: any = null;
    try {
      const project = operation?.project ?? {};
      const risksBody: Record<string, any> = { dossierId, debug, refresh, rayon_m: radiusKm * 1000 };

      if (project.address || project.city || project.zipCode) {
        risksBody.adresse = [project.address, project.zipCode, project.city].filter(Boolean).join(" ");
      }
      if (project.lat) risksBody.lat = project.lat;
      if (project.lng) risksBody.lng = project.lng;

      const step1 = await callFn(req, "risks-refresh-v1", risksBody, 30_000);
      timings["risks-refresh"] = step1.durationMs ?? 0;

      if (step1.ok) {
        risksRefresh = step1.data;
        result.risksRefresh = step1.data;
        sources.push("risks-refresh-v1");
      } else {
        warnings.push(`risks-refresh-v1: ${step1.error}`);
      }
    } catch (err) {
      warnings.push(`risks-refresh-v1 exception: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Geo
    const geoRow = await readDossierGeo(dossierId);
    const lat = geoRow.lat ?? operation?.project?.lat;
    const lng = geoRow.lng ?? operation?.project?.lng;
    const communeInsee = geoRow.commune_insee ?? operation?.project?.communeInsee;

    const geo = { lat, lng, communeInsee };

    // STEP 2 risk-study (optional)
    let riskStudy: any = null;
    if (withRiskStudy && lat && lng) {
      try {
        const step2 = await callFn(
          req,
          "risk-study-v1",
          { lat, lon: lng, commune_insee: communeInsee, radius_km: radiusKm, debug },
          45_000
        );
        timings["risk-study"] = step2.durationMs ?? 0;

        if (step2.ok) {
          riskStudy = step2.data;
          result.riskStudy = step2.data;
          sources.push("risk-study-v1");
          const p = await patchDossierColumn(dossierId, "risk_study_data", step2.data);
          if (!p.ok) warnings.push(`Persist risk_study_data: ${p.error}`);
        } else {
          warnings.push(`risk-study-v1: ${step2.error}`);
        }
      } catch (err) {
        warnings.push(`risk-study-v1 exception: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // STEP 3 market-study (optional)
    let marketStudy: any = null;
    if (withMarketStudy && lat && lng) {
      try {
        const step3 = await callFn(
          req,
          "market-study-promoteur-v1",
          { lat, lon: lng, project_type: projectType, radius_km: radiusKm, debug },
          60_000
        );
        timings["market-study"] = step3.durationMs ?? 0;

        if (step3.ok) {
          marketStudy = step3.data;
          result.marketStudy = step3.data;
          sources.push("market-study-promoteur-v1");
          const p = await patchDossierColumn(dossierId, "market_data", step3.data);
          if (!p.ok) warnings.push(`Persist market_data: ${p.error}`);
        } else {
          warnings.push(`market-study-promoteur-v1: ${step3.error}`);
        }
      } catch (err) {
        warnings.push(`market-study-promoteur-v1 exception: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log(`Market study executed: ${withMarketStudy} (lat=${lat}, lng=${lng})`, debug);

    // STEP 4 committee report (always)
    // ── POINT 3: forward userId in body payload ──
    let committee: any = null;
    try {
      const step4 = await callFn(
        req,
        "banque-committee-report-v1",
        { dossierId, userId, persist: true, debug },
        90_000
      );
      timings["committee-report"] = step4.durationMs ?? 0;

      if (step4.ok) {
        committee = step4.data;
        result.committee = step4.data;
        sources.push("banque-committee-report-v1");
      } else {
        warnings.push(`banque-committee-report-v1: ${step4.error}`);
      }
    } catch (err) {
      warnings.push(`banque-committee-report-v1 exception: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ✅ ALWAYS build an operation_enriched
    const operation_enriched = buildOperationEnriched({
      operation,
      dossierId,
      profile,
      geo,
      risksRefresh,
      riskStudy,
      marketStudy,
      committee,
    });

    // Mirror into result for convenience
    result.operation_enriched = operation_enriched;

    const totalMs = Date.now() - t0Global;

    log(`Final sources: ${sources.join(", ")}`, debug);
    log(`✓ DONE in ${totalMs}ms — warnings: ${warnings.length}`, debug);

    const payload: Record<string, any> = {
      ok: true,
      dossierId,
      sources,
      warnings,
      result,

      // ✅ Top-level: what the front expects (both keys for maximum compat)
      operation_enriched,
      operation: operation_enriched,
      operationEnriched: operation_enriched,
    };

    if (debug) {
      payload.timings = timings;
      payload.totalMs = totalMs;
      payload.geo = geo;
      // POINT 6: expose userId presence in debug (never the token)
      payload.userIdPresent = !!userId;
    }

    return jsonResp(payload, 200);
  } catch (err) {
    console.error("[ENRICH-ORCH] Fatal:", err);
    return jsonResp(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error",
        stack: err instanceof Error ? err.stack : undefined,
      },
      500
    );
  }
});