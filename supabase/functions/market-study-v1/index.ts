/// <reference lib="deno.unstable" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

import type {
  MarketStudyRequest,
  MarketStudyResponse,
  ZoneType,
} from "./types/market.types.ts";

import {
  corsHeaders,
  json,
  methodNotAllowed,
  badRequest,
  serverError,
} from "./utils/http.ts";

import { validateRequest, applyDefaults } from "./utils/validate.ts";

import { SCORING_VERSION, SCORING_PROFILES } from "./scoring/scoringConfig.ts";
import { computeSubscores } from "./scoring/computeSubscores.ts";
import { computeCompleteness } from "./scoring/computeCompleteness.ts";
import { computeGlobalScore } from "./scoring/computeGlobalScore.ts";
import { buildInsights } from "./insights/buildInsights.ts";

import { fetchInsee } from "./data/fetchInsee.ts";
import { fetchBpe } from "./data/fetchBpe.ts";
import { fetchTransport } from "./data/fetchTransport.ts";
import { fetchPrices } from "./data/fetchPrices.ts";
import { fetchCompetitionSenior } from "./data/fetchCompetitionSenior.ts";

// ✅ BUILD TAG (force redeploy bundling — change this string when needed)
const BUILD_TAG = "MARKET_STUDY_V1_BUILD_2026-01-27_03";

/**
 * Compatibilité front + robustesse:
 * - accepte { lng } comme alias de { lon }
 * - cast string -> number pour lat/lon si besoin
 * - défaut project_type si absent (évite l'erreur "Invalid project_type")
 */
function normalizeIncomingBody(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;

  const out: any = { ...(raw as any) };

  // Alias lng -> lon
  if (out.lon == null && out.lng != null) out.lon = out.lng;

  // Cast lat/lon si string
  if (typeof out.lat === "string") out.lat = Number(out.lat);
  if (typeof out.lon === "string") out.lon = Number(out.lon);

  // Défaut project_type si absent
  if (!out.project_type) out.project_type = "LOGEMENT";

  return out as Record<string, unknown>;
}

/**
 * Lecture optionnelle d'un flag debug côté request
 */
function isDebug(raw: Record<string, unknown>): boolean {
  return raw["debug"] === true;
}

/**
 * Détermine si le module transport est "couvert" (règle temporaire IDF).
 * Objectif : éviter que transport=null ressemble à un bug.
 */
function isTransportCovered(input: MarketStudyRequest): boolean {
  const insee = String(input.commune_insee ?? "").trim();

  if (/^\d{5}$/.test(insee)) {
    const dep = insee.slice(0, 2);
    if (["75", "77", "78", "91", "92", "93", "94", "95"].includes(dep)) return true;
    return false;
  }

  return true;
}

/**
 * Sécurise forwardAuth:
 * - évite d’envoyer { apikey: undefined } dans certains fetch wrappers
 * - normalise les noms
 */
function buildForwardAuth(req: Request): { apikey?: string; Authorization?: string } {
  const apikey = req.headers.get("apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const Authorization = req.headers.get("Authorization") ?? undefined;
  const out: any = {};
  if (apikey) out.apikey = apikey;
  if (Authorization) out.Authorization = Authorization;
  return out;
}

/**
 * Extrait une clé "brute" (sans "Bearer ") depuis les headers.
 * Sert à forward une clé valide à fetchInsee pour qu'il puisse appeler market-context-v1.
 */
function extractIncomingKey(req: Request): string | null {
  const apikey = req.headers.get("apikey") ?? req.headers.get("x-api-key");
  if (apikey && apikey.trim()) return apikey.trim();

  const auth = req.headers.get("Authorization");
  if (auth && auth.trim()) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }

  return null;
}

/**
 * Helper: récupère provider avec fallback explicite
 */
function providerOf(obj: any, fallback = "stub"): string {
  return (obj && obj.source && typeof obj.source.provider === "string" && obj.source.provider)
    ? obj.source.provider
    : fallback;
}

serve(async (req: Request) => {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders, status: 200 });
    }

    if (req.method !== "POST") return methodNotAllowed();

    // Parse body
    const raw0 = await req.json().catch(() => null);
    const raw = normalizeIncomingBody(raw0);
    if (!raw) return badRequest("Invalid JSON body");

    const debug = isDebug(raw);

    // Validate
    const v = validateRequest(raw);
    if (!v.ok) return badRequest(v.error);

    // Apply defaults (radius_km, zone_type, etc.)
    const input: MarketStudyRequest = applyDefaults(v.value);

    // Hard-guard lat/lon
    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon)) {
      return badRequest("lat/lon invalid");
    }

    const profile = SCORING_PROFILES[input.project_type];
    if (!profile) {
      const allowed = Object.keys(SCORING_PROFILES).join(", ");
      return badRequest(`Invalid project_type. Allowed: ${allowed}`);
    }

    // Forward auth entrante (utile pour certaines fonctions qui appellent d'autres endpoints)
    const forwardAuth = buildForwardAuth(req);

    // ✅ Clé entrante (ANON la plupart du temps) qu'on forward à fetchInsee
    const incomingKey = extractIncomingKey(req);

    // Transport coverage (temp: IDF only)
    const transportCovered = isTransportCovered(input);

    // Data collection (safe wrappers)
    const safeFetchInsee = async () => {
      try {
        // ✅ on forward une clé utilisable pour appeler market-context-v1
        const patchedInput: any = { ...(input as any), _supabase_key: incomingKey };
        return await fetchInsee(patchedInput as MarketStudyRequest);
      } catch (e) {
        console.warn("[market-study-v1] fetchInsee failed:", e);
        return null;
      }
    };

    const safeFetchTransport = async () => {
      try {
        return transportCovered ? await fetchTransport(input) : null;
      } catch (e) {
        console.warn("[market-study-v1] fetchTransport failed:", e);
        return null;
      }
    };

    const safeFetchPrices = async () => {
      try {
        return await fetchPrices(input);
      } catch (e) {
        console.warn("[market-study-v1] fetchPrices failed:", e);
        return null;
      }
    };

    const safeFetchCompetition = async () => {
      try {
        return await fetchCompetitionSenior(input);
      } catch (e) {
        console.warn("[market-study-v1] fetchCompetitionSenior failed:", e);
        return null;
      }
    };

    const safeFetchBpe = async () => {
      try {
        return await (fetchBpe as any)(input, { debug, forwardAuth });
      } catch (e) {
        console.warn("[market-study-v1] fetchBpe failed:", e);
        return null;
      }
    };

    const [insee, bpe, transport, prices, seniorCompetition] =
      await Promise.all([
        safeFetchInsee(),
        safeFetchBpe(),
        safeFetchTransport(),
        safeFetchPrices(),
        safeFetchCompetition(),
      ]);

    const zone_type: ZoneType = input.zone_type ?? "commune";

    // Compute subscores from collected data
    const subscores = computeSubscores({
      project_type: input.project_type,
      insee,
      bpe,
      transport,
      prices,
      seniorCompetition,
    });

    // Completeness (expected fields based on project)
    const completeness = computeCompleteness({
      project_type: input.project_type,
      subscores,
      insee,
      bpe,
      transport,
      prices,
      seniorCompetition,
      blocking_missing: profile.blocking_missing,
    });

    // Global score (null if blocking missing)
    const score = computeGlobalScore({
      subscores,
      weights: profile.weights,
      blocking: completeness.blocking,
    });

    // Verdict
    const verdict =
      score === null
        ? (completeness.blocking.length > 0
          ? `Score non calculé — données manquantes bloquantes (${completeness.blocking.join(", ")})`
          : "Score non calculé — données insuffisantes pour calculer un score")
        : (profile.verdict.find((r) => score >= r.min)?.label ??
          "Verdict indisponible");

    // Insights
    const insights = buildInsights({
      project_type: input.project_type,
      score,
      subscores,
      completeness,
      insee,
      transport,
      prices,
      seniorCompetition,
    });

    // Transport status explicite
    const transport_status =
      transportCovered
        ? (transport ? "ok" : "missing")
        : "not_covered_outside_idf";

    // Warnings (non bloquants)
    const warnings: string[] = [];
    if (completeness.missing.length > 0) warnings.push("Certaines données sont manquantes.");
    if (transport_status === "missing") warnings.push("Module transport : données indisponibles (IDF).");
    if (transport_status === "not_covered_outside_idf") warnings.push("Module transport : non couvert hors Île-de-France.");

    // Sources providers cohérents
    const sources = [
      { key: "insee", provider: providerOf(insee, "stub") },
      { key: "bpe", provider: providerOf(bpe, "stub") },
      { key: "transport", provider: providerOf(transport, transport_status) },
      { key: "prices", provider: providerOf(prices, "stub") },
      { key: "senior_competition", provider: providerOf(seniorCompetition, "stub") },
    ];

    const response: MarketStudyResponse & {
      debug?: Record<string, unknown>;
      transport_status?: string;
    } = {
      success: true,
      scoring_version: SCORING_VERSION,
      input: {
        resolved_point: { lat: Number(input.lat), lon: Number(input.lon) },
        radius_km: input.radius_km,
        commune_insee: input.commune_insee ?? undefined,
        project_type: input.project_type,
      },
      zone_type,
      market: {
        verdict,
        score,
        subscores,

        completeness,
        insights,

        insee: insee ?? null,

        prices: prices ?? null,
        transactions: prices?.transactions ?? null,

        bpe: bpe ?? null,
        transport: transport ?? null,

        poi_nearby: null,

        modules:
          input.project_type === "EHPAD" || input.project_type === "RSS"
            ? { senior_competition: seniorCompetition }
            : undefined,

        sources,
        warnings,
      },
      error: null,
      message: null,
      transport_status,
    };

    // Debug minimal (non sensible)
    if (debug) {
      response.debug = {
        build_tag: BUILD_TAG,
        bpe_is_null: bpe === null,
        insee_is_null: insee === null,
        transport_is_null: transport === null,
        prices_is_null: prices === null,
        transport_covered: transportCovered,
        transport_status,
        env_supabase_url_set: Boolean(Deno.env.get("SUPABASE_URL")),
        env_service_role_set: Boolean(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
        insee_provider: providerOf(insee, null as any) ?? null,
        bpe_provider: providerOf(bpe, null as any) ?? null,
        prices_provider: providerOf(prices, null as any) ?? null,
        transport_provider: providerOf(transport, null as any) ?? null,
        forward_auth_present: {
          apikey: Boolean((forwardAuth as any)?.apikey),
          Authorization: Boolean((forwardAuth as any)?.Authorization),
        },
        incoming_key_present: Boolean(incomingKey),
      };
    }

    return json(response);
  } catch (e) {
    console.error("[market-study-v1] error:", e);
    return serverError("Internal error");
  }
});
