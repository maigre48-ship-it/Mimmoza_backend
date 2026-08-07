// supabase/functions/macro-rates-refresh-v1/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type SeriesSpec = {
  seriesKey: "ESTR" | "YC_10Y_AAA_EA";
  flowRef: "EST" | "YC";
  sdmxSeries: string; // full series key for ECB
  source: "ECB Data Portal";
};

const SERIES: SeriesSpec[] = [
  {
    seriesKey: "ESTR",
    flowRef: "EST",
    sdmxSeries: "EST.B.EU000A2X2A25.WT",
    source: "ECB Data Portal",
  },
  {
    seriesKey: "YC_10Y_AAA_EA",
    flowRef: "YC",
    sdmxSeries: "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y",
    source: "ECB Data Portal",
  },
];

function json(res: unknown, status = 200) {
  return new Response(JSON.stringify(res, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function fetchSdmxLastN(
  flowRef: string,
  series: string,
  lastN: number
): Promise<any> {
  const url =
    `https://data-api.ecb.europa.eu/service/data/${encodeURIComponent(flowRef)}/${encodeURIComponent(series)}` +
    `?lastNObservations=${lastN}&format=sdmx-json`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // ECB SDMX service works without auth; set UA for polite usage.
        "User-Agent": "mimmoza/1.0 (macro-rates-refresh)",
        "Accept": "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ECB fetch failed ${res.status}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Parse SDMX-JSON (ECB) into [{date, value}]
 * Works for single-series responses (which we request).
 */
function parseSdmxJson(data: any): Array<{ date: string; value: number }> {
  const structure = data?.structure;
  const dataset = data?.dataSets?.[0];

  const obsDim = structure?.dimensions?.observation?.[0];
  const timeValues: Array<{ id: string }> = obsDim?.values ?? [];
  if (!dataset?.series) return [];

  // Take first (and only) series
  const seriesKeys = Object.keys(dataset.series);
  if (seriesKeys.length === 0) return [];
  const firstSeries = dataset.series[seriesKeys[0]];

  const observations = firstSeries?.observations ?? {};
  const out: Array<{ date: string; value: number }> = [];

  for (const [obsIndexStr, obsArr] of Object.entries(observations)) {
    const obsIndex = Number(obsIndexStr);
    const date = timeValues?.[obsIndex]?.id;
    const value = Array.isArray(obsArr) ? Number(obsArr[0]) : NaN;
    if (date && Number.isFinite(value)) out.push({ date, value });
  }

  // Ensure chronological ascending
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ ok: false, error: "Missing Supabase env vars" }, 500);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const lastN = 15;

    const results: any[] = [];

    for (const spec of SERIES) {
      // Basic retry (2 tries)
      let payload: any;
      let lastErr: any = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          payload = await fetchSdmxLastN(spec.flowRef, spec.sdmxSeries, lastN);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!payload) throw lastErr ?? new Error("Unknown fetch error");

      const obs = parseSdmxJson(payload);
      if (obs.length === 0) {
        results.push({
          seriesKey: spec.seriesKey,
          inserted: 0,
          warning: "No observations parsed",
        });
        continue;
      }

      const rows = obs.map((o) => ({
        rate_date: o.date, // YYYY-MM-DD
        series_key: spec.seriesKey,
        value_pct: o.value,
        source: spec.source,
        raw: null, // keep null (or store small metadata if you want)
      }));

      const { error } = await supabase
        .from("macro_rates")
        .upsert(rows, { onConflict: "rate_date,series_key" });

      if (error) throw error;

      results.push({
        seriesKey: spec.seriesKey,
        observations: obs.length,
        from: obs[0]?.date,
        to: obs[obs.length - 1]?.date,
        last: obs[obs.length - 1],
      });
    }

    return json({
      ok: true,
      mode: "lastNObservations",
      lastN: 15,
      updatedAt: new Date().toISOString(),
      results,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        error: String(e?.message ?? e),
      },
      500
    );
  }
});
