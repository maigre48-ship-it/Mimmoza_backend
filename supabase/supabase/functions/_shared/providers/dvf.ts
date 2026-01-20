import { sha256Hex, stableStringify } from "./hash.ts";
import { cacheGet, cachePut } from "./cache.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { DvfResult } from "./types.ts";

export async function dvfMarketKpis(
  supabase: SupabaseClient,
  args: {
    lat: number;
    lon: number;
    radius_m: number;
    horizon_months: number;
    type_local?: string | null;
    ttl_seconds?: number;
    debug?: boolean;
  },
): Promise<DvfResult> {
  const provider = "dvf";
  const ttl = args.ttl_seconds ?? 86400; // 24h

  const req = {
    lat: +args.lat,
    lon: +args.lon,
    radius_m: Math.round(args.radius_m),
    horizon_months: Math.round(args.horizon_months),
    type_local: args.type_local ?? null,
  };

  const cache_key = await sha256Hex(stableStringify(req));

  const cached = await cacheGet(supabase, provider, cache_key);
  if (cached?.response) {
    const k = cached.response.kpis ?? {};
    return {
      provider,
      source: "api",
      coverage: cached.status === 200 ? "ok" : "error",
      reason: cached.status === 200 ? undefined : `API DVF status=${cached.status}`,
      cached: true,
      fetched_at: cached.fetched_at,
      kpis: {
        n: Number(k.n ?? 0),
        median_price_m2: (k.median_price_m2 ?? null),
        avg_price_m2: (k.avg_price_m2 ?? null),
        q1_price_m2: (k.q1_price_m2 ?? null),
        q3_price_m2: (k.q3_price_m2 ?? null),
      },
      comps: cached.response.comps ?? [],
    };
  }

  const baseUrl = Deno.env.get("DVF_API_BASE_URL") ?? "";
  if (!baseUrl) {
    return {
      provider,
      source: "api",
      coverage: "not_covered",
      reason: "DVF_API_BASE_URL non configurée",
      kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null },
      comps: [],
    };
  }

  // Convention: GET /mutations?lat=..&lon=..&radius=..&months=..&type_local=..
  const url = new URL(baseUrl.replace(/\/$/, "") + "/mutations");
  url.searchParams.set("lat", String(req.lat));
  url.searchParams.set("lon", String(req.lon));
  url.searchParams.set("radius", String(req.radius_m));
  url.searchParams.set("months", String(req.horizon_months));
  if (req.type_local) url.searchParams.set("type_local", req.type_local);

  const headers: Record<string, string> = { accept: "application/json" };
  const token = Deno.env.get("DVF_API_TOKEN");
  if (token) headers["authorization"] = `Bearer ${token}`;

  try {
    const r = await fetch(url.toString(), { headers });
    const status = r.status;
    const payload = await r.json().catch(() => null);

    if (!r.ok) {
      await cachePut(supabase, provider, cache_key, req, { error: payload }, status, 300);
      return {
        provider,
        source: "api",
        coverage: "error",
        reason: `API DVF status=${status}`,
        kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null },
        comps: [],
      };
    }

    const rows: any[] = Array.isArray(payload?.results)
      ? payload.results
      : (Array.isArray(payload) ? payload : []);

    const prices = rows
      .map((x) => {
        const vf = Number(x.valeur_fonciere ?? x.valeur ?? x.price);
        const s = Number(x.surface_reelle_bati ?? x.surface ?? x.area);
        const p = (vf && s) ? (vf / s) : Number(x.prix_m2 ?? x.price_m2);
        return Number.isFinite(p) && p > 0 ? p : null;
      })
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);

    prices.sort((a, b) => a - b);

    const n = prices.length;
    const quantile = (p: number) => {
      if (n === 0) return null;
      const idx = (n - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return prices[lo];
      const h = idx - lo;
      return prices[lo] * (1 - h) + prices[hi] * h;
    };

    const kpis = {
      n,
      median_price_m2: quantile(0.5),
      avg_price_m2: n ? prices.reduce((a, b) => a + b, 0) / n : null,
      q1_price_m2: quantile(0.25),
      q3_price_m2: quantile(0.75),
    };

    const out = { kpis, comps: rows.slice(0, 20) };
    await cachePut(supabase, provider, cache_key, req, out, 200, ttl);

    return {
      provider,
      source: "api",
      coverage: n > 0 ? "ok" : "no_data",
      reason: n > 0 ? undefined : "Aucune transaction retournée par l’API DVF",
      cached: false,
      kpis,
      comps: out.comps,
    };
  } catch (e) {
    await cachePut(supabase, provider, cache_key, req, { error: String(e) }, 0, 300);
    return {
      provider,
      source: "api",
      coverage: "error",
      reason: `Erreur DVF fetch: ${String(e)}`,
      kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null },
      comps: [],
    };
  }
}
