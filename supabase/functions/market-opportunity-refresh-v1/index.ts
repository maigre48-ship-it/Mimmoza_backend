import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type RequestBody = {
  zip_code?: string;
  city?: string;
  transaction_mode?: "all" | "sale" | "rent";
  dry_run?: boolean;
  include_samples?: boolean;
  sample_limit?: number;
  min_score?: number;
};

type CanonicalRow = {
  canonical_key: string;
  city: string | null;
  zip_code: string | null;
  price: number | null;
  surface: number | null;
  price_m2: number | null;
  listing_count: number | null;
  portal_count: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  updated_at: string | null;
  dedupe_confidence: number | null;
  representative_url: string | null;
};

type ZoneMetricsRow = {
  zone_key: string;
  median_price_m2: number | null;
  median_days_on_market: number | null;
  liquidity_signal: string | null;
  tension_signal: string | null;
  active_listings: number | null;
  new_listings_7d: number | null;
};

type OpportunityRow = {
  canonical_key: string;
  zone_key: string;
  city: string | null;
  zip_code: string | null;
  price: number | null;
  surface: number | null;
  price_m2: number | null;
  portal_count: number | null;
  listing_count: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  representative_url: string | null;
  opportunity_score: number;
  opportunity_bucket: "faible" | "moyenne" | "forte";
  score_freshness: number;
  score_price_position: number;
  score_diffusion: number;
  score_multi_portal: number;
  score_zone_liquidity: number;
  price_position_pct: number | null;
  days_on_market: number | null;
  updated_at: string;
  payload: Record<string, unknown>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeForCompare(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function roundSafe(value: number | null | undefined, digits = 2): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function daysBetween(startIso: string | null, endIso: string): number | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const diff = (end - start) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(diff)) return null;
  return roundSafe(Math.max(0, diff), 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildZoneKey(params: Required<RequestBody>): string {
  const zip = normalizeText(params.zip_code);
  const city = normalizeText(params.city);

  if (zip) return `${zip}|${params.transaction_mode}`;
  if (city) return `${normalizeForCompare(city)}|${params.transaction_mode}`;
  return `all|${params.transaction_mode}`;
}

function parseBody(raw: unknown): Required<RequestBody> {
  const body = (raw ?? {}) as RequestBody;

  const transactionMode =
    body.transaction_mode === "sale" ||
    body.transaction_mode === "rent" ||
    body.transaction_mode === "all"
      ? body.transaction_mode
      : "all";

  const sampleLimit =
    typeof body.sample_limit === "number" && Number.isFinite(body.sample_limit)
      ? Math.max(1, Math.min(50, Math.round(body.sample_limit)))
      : 10;

  const minScore =
    typeof body.min_score === "number" && Number.isFinite(body.min_score)
      ? Math.max(0, Math.min(100, Math.round(body.min_score)))
      : 0;

  return {
    zip_code: normalizeText(body.zip_code) ?? "",
    city: normalizeText(body.city) ?? "",
    transaction_mode: transactionMode,
    dry_run: Boolean(body.dry_run),
    include_samples: Boolean(body.include_samples),
    sample_limit: sampleLimit,
    min_score: minScore,
  };
}

function filterRowsByZone(
  rows: CanonicalRow[],
  params: Required<RequestBody>
): CanonicalRow[] {
  const zip = normalizeText(params.zip_code);
  const cityNorm = normalizeForCompare(params.city);

  return rows.filter((row) => {
    if (zip && row.zip_code === zip) return true;
    if (!zip && cityNorm && normalizeForCompare(row.city) === cityNorm) return true;
    if (zip && cityNorm && row.zip_code === zip) return true;
    if (!zip && !cityNorm) return true;
    return false;
  });
}

function computePricePositionPct(
  rowPriceM2: number | null,
  zoneMedianPriceM2: number | null
): number | null {
  if (
    rowPriceM2 === null ||
    zoneMedianPriceM2 === null ||
    zoneMedianPriceM2 <= 0
  ) {
    return null;
  }

  return roundSafe(((rowPriceM2 - zoneMedianPriceM2) / zoneMedianPriceM2) * 100, 2);
}

function computeFreshnessScore(daysOnMarket: number | null): number {
  if (daysOnMarket === null) return 8;
  if (daysOnMarket <= 3) return 15;
  if (daysOnMarket <= 7) return 13;
  if (daysOnMarket <= 14) return 10;
  if (daysOnMarket <= 30) return 7;
  if (daysOnMarket <= 60) return 4;
  return 2;
}

function computePricePositionScore(pricePositionPct: number | null): number {
  if (pricePositionPct === null) return 10;

  if (pricePositionPct <= -15) return 30;
  if (pricePositionPct <= -10) return 26;
  if (pricePositionPct <= -7) return 22;
  if (pricePositionPct <= -5) return 18;
  if (pricePositionPct <= -2) return 14;
  if (pricePositionPct <= 2) return 10;
  if (pricePositionPct <= 5) return 6;
  return 2;
}

function computeDiffusionScore(daysOnMarket: number | null): number {
  if (daysOnMarket === null) return 6;

  if (daysOnMarket >= 90) return 15;
  if (daysOnMarket >= 60) return 13;
  if (daysOnMarket >= 45) return 11;
  if (daysOnMarket >= 30) return 9;
  if (daysOnMarket >= 14) return 6;
  if (daysOnMarket >= 7) return 4;
  return 2;
}

function computeMultiPortalScore(portalCount: number | null): number {
  const n = portalCount ?? 0;
  if (n >= 4) return 10;
  if (n === 3) return 8;
  if (n === 2) return 6;
  if (n === 1) return 2;
  return 1;
}

function computeZoneLiquidityScore(liquiditySignal: string | null): number {
  switch (liquiditySignal) {
    case "tres_fluide":
      return 10;
    case "fluide":
      return 8;
    case "intermediaire":
      return 6;
    case "lente":
      return 4;
    case "tres_lente":
      return 3;
    default:
      return 5;
  }
}

function computeBucket(score: number): "faible" | "moyenne" | "forte" {
  if (score >= 70) return "forte";
  if (score >= 50) return "moyenne";
  return "faible";
}

function buildOpportunityRow(
  row: CanonicalRow,
  metrics: ZoneMetricsRow,
  zoneKey: string
): OpportunityRow {
  const nowIso = new Date().toISOString();

  const daysOnMarket = daysBetween(row.first_seen_at, nowIso);
  const pricePositionPct = computePricePositionPct(
    row.price_m2,
    metrics.median_price_m2
  );

  const scoreFreshness = computeFreshnessScore(daysOnMarket);
  const scorePricePosition = computePricePositionScore(pricePositionPct);
  const scoreDiffusion = computeDiffusionScore(daysOnMarket);
  const scoreMultiPortal = computeMultiPortalScore(row.portal_count);
  const scoreZoneLiquidity = computeZoneLiquidityScore(metrics.liquidity_signal);

  const totalScore = clamp(
    roundSafe(
      scoreFreshness +
        scorePricePosition +
        scoreDiffusion +
        scoreMultiPortal +
        scoreZoneLiquidity,
      0
    ),
    0,
    100
  );

  return {
    canonical_key: row.canonical_key,
    zone_key: zoneKey,
    city: row.city,
    zip_code: row.zip_code,
    price: row.price,
    surface: row.surface,
    price_m2: row.price_m2,
    portal_count: row.portal_count,
    listing_count: row.listing_count,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    representative_url: row.representative_url,
    opportunity_score: totalScore,
    opportunity_bucket: computeBucket(totalScore),
    score_freshness: scoreFreshness,
    score_price_position: scorePricePosition,
    score_diffusion: scoreDiffusion,
    score_multi_portal: scoreMultiPortal,
    score_zone_liquidity: scoreZoneLiquidity,
    price_position_pct: pricePositionPct,
    days_on_market: daysOnMarket,
    updated_at: nowIso,
    payload: {
      zone_metrics_snapshot: {
        median_price_m2: metrics.median_price_m2,
        median_days_on_market: metrics.median_days_on_market,
        liquidity_signal: metrics.liquidity_signal,
        tension_signal: metrics.tension_signal,
        active_listings: metrics.active_listings,
        new_listings_7d: metrics.new_listings_7d,
      },
      dedupe_confidence: row.dedupe_confidence,
    },
  };
}

async function fetchCanonicalRows(
  params: Required<RequestBody>
): Promise<{
  supabase: ReturnType<typeof createClient>;
  rows: CanonicalRow[];
}> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const pageSize = 1000;
  const rows: CanonicalRow[] = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;

    let query = supabase
      .from("listings_canonical")
      .select(
        "canonical_key, city, zip_code, price, surface, price_m2, listing_count, portal_count, first_seen_at, last_seen_at, updated_at, dedupe_confidence, representative_url"
      )
      .order("last_seen_at", { ascending: false })
      .range(from, to);

    if (params.zip_code) {
      query = query.eq("zip_code", params.zip_code);
    }

    if (params.city && !params.zip_code) {
      query = query.ilike("city", `%${params.city}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const batch = (data ?? []) as CanonicalRow[];
    rows.push(...batch);

    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return { supabase, rows };
}

async function fetchZoneMetrics(
  supabase: ReturnType<typeof createClient>,
  zoneKey: string
): Promise<ZoneMetricsRow> {
  const { data, error } = await supabase
    .from("market_zone_metrics")
    .select(
      "zone_key, median_price_m2, median_days_on_market, liquidity_signal, tension_signal, active_listings, new_listings_7d"
    )
    .eq("zone_key", zoneKey)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    throw new Error(
      `market_zone_metrics introuvable pour zone_key=${zoneKey}. Lance d'abord market-metrics-zone-v1 en écriture réelle.`
    );
  }

  return data as ZoneMetricsRow;
}

async function upsertOpportunitiesInChunks(
  supabase: ReturnType<typeof createClient>,
  rows: OpportunityRow[]
): Promise<number> {
  const chunkSize = 500;
  let upserted = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);

    const { error } = await supabase
      .from("market_opportunities")
      .upsert(chunk, { onConflict: "canonical_key" });

    if (error) throw error;
    upserted += chunk.length;
  }

  return upserted;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Method not allowed",
      }),
      {
        status: 405,
        headers: corsHeaders,
      }
    );
  }

  try {
    let rawBody: unknown = {};
    try {
      rawBody = await req.json();
    } catch {
      rawBody = {};
    }

    const params = parseBody(rawBody);
    const zoneKey = buildZoneKey(params);

    const { supabase, rows: fetchedRows } = await fetchCanonicalRows(params);
    const rows = filterRowsByZone(fetchedRows, params);
    const zoneMetrics = await fetchZoneMetrics(supabase, zoneKey);

    const opportunityRows = rows
      .map((row) => buildOpportunityRow(row, zoneMetrics, zoneKey))
      .filter((row) => row.opportunity_score >= params.min_score)
      .sort((a, b) => b.opportunity_score - a.opportunity_score);

    let upserted = 0;

    if (!params.dry_run && opportunityRows.length) {
      upserted = await upsertOpportunitiesInChunks(supabase, opportunityRows);
    }

    const samples = params.include_samples
      ? opportunityRows.slice(0, params.sample_limit).map((row) => ({
          canonical_key: row.canonical_key,
          city: row.city,
          zip_code: row.zip_code,
          price: row.price,
          surface: row.surface,
          price_m2: row.price_m2,
          portal_count: row.portal_count,
          listing_count: row.listing_count,
          representative_url: row.representative_url,
          opportunity_score: row.opportunity_score,
          opportunity_bucket: row.opportunity_bucket,
          score_freshness: row.score_freshness,
          score_price_position: row.score_price_position,
          score_diffusion: row.score_diffusion,
          score_multi_portal: row.score_multi_portal,
          score_zone_liquidity: row.score_zone_liquidity,
          price_position_pct: row.price_position_pct,
          days_on_market: row.days_on_market,
        }))
      : undefined;

    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: params.dry_run,
        zone_key: zoneKey,
        filters: {
          zip_code: params.zip_code || null,
          city: params.city || null,
          transaction_mode: params.transaction_mode,
          min_score: params.min_score,
        },
        rows_fetched: fetchedRows.length,
        rows_retained: rows.length,
        opportunities_computed: opportunityRows.length,
        opportunities_upserted: params.dry_run ? 0 : upserted,
        zone_metrics_snapshot: {
          median_price_m2: zoneMetrics.median_price_m2,
          median_days_on_market: zoneMetrics.median_days_on_market,
          liquidity_signal: zoneMetrics.liquidity_signal,
          tension_signal: zoneMetrics.tension_signal,
          active_listings: zoneMetrics.active_listings,
          new_listings_7d: zoneMetrics.new_listings_7d,
        },
        samples,
      }),
      {
        status: 200,
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error("market-opportunity-refresh-v1 error:", error);

    return new Response(
      JSON.stringify({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : typeof error === "object"
              ? JSON.stringify(error)
              : String(error),
      }),
      {
        status: 400,
        headers: corsHeaders,
      }
    );
  }
});