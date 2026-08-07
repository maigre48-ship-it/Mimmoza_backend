import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type RequestBody = {
  zip_code?: string;
  city?: string;
  transaction_mode?: "all" | "sale" | "rent";
  dry_run?: boolean;
  include_samples?: boolean;
  sample_limit?: number;
};

type CanonicalRow = {
  canonical_key: string;
  city: string | null;
  zip_code: string | null;
  price_m2: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  representative_url: string | null;
};

type MarketMetricsPayload = {
  zone_key: string;
  city: string | null;
  zip_code: string | null;
  transaction_mode: "all" | "sale" | "rent";
  active_listings: number;
  new_listings_7d: number;
  median_price_m2: number | null;
  median_days_on_market: number | null;
  liquidity_signal: string;
  tension_signal: string;
  computed_at: string;
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

function roundSafe(value: number | null | undefined, digits = 2): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return roundSafe((sorted[mid - 1] + sorted[mid]) / 2, 2);
  }

  return roundSafe(sorted[mid], 2);
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

  return {
    zip_code: normalizeText(body.zip_code) ?? "",
    city: normalizeText(body.city) ?? "",
    transaction_mode: transactionMode,
    dry_run: Boolean(body.dry_run),
    include_samples: Boolean(body.include_samples),
    sample_limit: sampleLimit,
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

function computeLiquiditySignal(medianDaysOnMarket: number | null): string {
  if (medianDaysOnMarket === null) return "indeterminee";
  if (medianDaysOnMarket <= 15) return "tres_fluide";
  if (medianDaysOnMarket <= 30) return "fluide";
  if (medianDaysOnMarket <= 60) return "intermediaire";
  if (medianDaysOnMarket <= 90) return "lente";
  return "tres_lente";
}

function computeTensionSignal(
  newListings7d: number,
  activeListings: number,
  medianDaysOnMarket: number | null
): string {
  const freshnessRate =
    activeListings > 0 ? (newListings7d / activeListings) * 100 : 0;

  if (medianDaysOnMarket !== null && medianDaysOnMarket <= 20 && freshnessRate >= 12) {
    return "forte";
  }
  if (medianDaysOnMarket !== null && medianDaysOnMarket <= 35 && freshnessRate >= 8) {
    return "soutenue";
  }
  if (medianDaysOnMarket !== null && medianDaysOnMarket <= 60) {
    return "equilibree";
  }
  if (medianDaysOnMarket !== null && medianDaysOnMarket <= 90) {
    return "detendue";
  }
  return "faible";
}

function computeMetrics(
  rows: CanonicalRow[],
  params: Required<RequestBody>
): MarketMetricsPayload {
  const nowIso = new Date().toISOString();
  const nowTs = new Date(nowIso).getTime();
  const cutoff7d = nowTs - 7 * 24 * 60 * 60 * 1000;
  const zoneKey = buildZoneKey(params);

  const priceM2s = rows
    .map((x) => x.price_m2)
    .filter((x): x is number => typeof x === "number" && x > 0);

  const dayOnMarketValues = rows
    .map((x) => daysBetween(x.first_seen_at, nowIso))
    .filter((x): x is number => typeof x === "number");

  const activeListings = rows.length;

  const newListings7d = rows.filter((row) => {
    if (!row.first_seen_at) return false;
    const ts = new Date(row.first_seen_at).getTime();
    return Number.isFinite(ts) && ts >= cutoff7d;
  }).length;

  const medianDaysOnMarket = median(dayOnMarketValues);
  const liquiditySignal = computeLiquiditySignal(medianDaysOnMarket);
  const tensionSignal = computeTensionSignal(
    newListings7d,
    activeListings,
    medianDaysOnMarket
  );

  return {
    zone_key: zoneKey,
    city: normalizeText(params.city) ?? rows.find((x) => x.city)?.city ?? null,
    zip_code:
      normalizeText(params.zip_code) ?? rows.find((x) => x.zip_code)?.zip_code ?? null,
    transaction_mode: params.transaction_mode,
    active_listings: activeListings,
    new_listings_7d: newListings7d,
    median_price_m2: median(priceM2s),
    median_days_on_market: medianDaysOnMarket,
    liquidity_signal: liquiditySignal,
    tension_signal: tensionSignal,
    computed_at: nowIso,
    payload: {
      filters: {
        zip_code: normalizeText(params.zip_code),
        city: normalizeText(params.city),
        transaction_mode: params.transaction_mode,
      },
      distributions: {
        price_m2_count: priceM2s.length,
      },
    },
  };
}

async function fetchCanonicalRows(params: Required<RequestBody>): Promise<{
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
        "canonical_key, city, zip_code, price_m2, first_seen_at, last_seen_at, representative_url"
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

async function upsertZoneMetrics(
  supabase: ReturnType<typeof createClient>,
  metrics: MarketMetricsPayload
) {
  const { error } = await supabase
    .from("market_zone_metrics")
    .upsert(metrics, { onConflict: "zone_key" });

  if (error) throw error;
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

    const { supabase, rows: fetchedRows } = await fetchCanonicalRows(params);
    const rows = filterRowsByZone(fetchedRows, params);
    const metrics = computeMetrics(rows, params);

    if (!params.dry_run) {
      await upsertZoneMetrics(supabase, metrics);
    }

    const samples = params.include_samples
      ? rows.slice(0, params.sample_limit).map((row) => ({
          canonical_key: row.canonical_key,
          city: row.city,
          zip_code: row.zip_code,
          price_m2: row.price_m2,
          first_seen_at: row.first_seen_at,
          last_seen_at: row.last_seen_at,
          representative_url: row.representative_url,
        }))
      : undefined;

    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: params.dry_run,
        zone_key: metrics.zone_key,
        filters: {
          zip_code: params.zip_code || null,
          city: params.city || null,
          transaction_mode: params.transaction_mode,
        },
        rows_fetched: fetchedRows.length,
        rows_retained: rows.length,
        metrics,
        samples,
      }),
      {
        status: 200,
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error("market-metrics-zone-v1 error:", error);

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