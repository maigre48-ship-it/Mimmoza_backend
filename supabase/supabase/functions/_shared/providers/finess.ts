import { sha256Hex, stableStringify } from "./hash.ts";
import { cacheGet, cachePut } from "./cache.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { FinessResult, FinessEhpad } from "./types.ts";

function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function finessEhpadNearby(
  supabase: SupabaseClient,
  args: {
    lat: number;
    lon: number;
    radius_m: number;
    ttl_seconds?: number;
    debug?: boolean;
  },
): Promise<FinessResult> {
  const provider = "finess";
  const ttl = args.ttl_seconds ?? 86400;

  const req = {
    lat: +args.lat,
    lon: +args.lon,
    radius_m: Math.round(args.radius_m),
  };

  const cache_key = await sha256Hex(stableStringify(req));

  const cached = await cacheGet(supabase, provider, cache_key);
  if (cached?.response) {
    return {
      provider,
      source: "api",
      coverage: cached.status === 200 ? "ok" : "error",
      reason: cached.status === 200 ? undefined : `API FINESS status=${cached.status}`,
      cached: true,
      fetched_at: cached.fetched_at,
      radius_m: req.radius_m,
      count: cached.response.count ?? 0,
      nearest: cached.response.nearest ?? null,
      items: cached.response.items ?? [],
    };
  }

  const baseUrl = Deno.env.get("ANS_FHIR_BASE_URL") ?? "";
  const apiKey = Deno.env.get("ANS_FHIR_API_KEY") ?? "";

  if (!baseUrl || !apiKey) {
    return {
      provider,
      source: "api",
      coverage: "not_covered",
      reason: "ANS_FHIR_BASE_URL / ANS_FHIR_API_KEY non configurées",
      radius_m: req.radius_m,
      count: 0,
      nearest: null,
      items: [],
    };
  }

  // Requête FHIR large, filtrage distance côté Mimmoza.
  // On affinera le filtre "EHPAD" ensuite selon les codes exposés par l'ANS.
  const url = new URL(baseUrl.replace(/\/$/, "") + "/Organization");
  url.searchParams.set("_count", "200");

  const headers: Record<string, string> = {
    accept: "application/fhir+json",
    "x-api-key": apiKey,
  };

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
        reason: `API FINESS status=${status}`,
        radius_m: req.radius_m,
        count: 0,
        nearest: null,
        items: [],
      };
    }

    const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
    const items: FinessEhpad[] = [];

    for (const e of entries) {
      const res = e?.resource;
      if (!res) continue;

      const name = res.name ?? res?.identifier?.[0]?.value ?? "Organisation";
      const finess = (res.identifier || []).find((id: any) =>
        String(id.system || "").toLowerCase().includes("finess")
      )?.value;

      const addr = Array.isArray(res.address) ? res.address[0] : res.address;
      const line = Array.isArray(addr?.line) ? addr.line.join(" ") : addr?.line;
      const city = addr?.city;

      const pos =
        res.position ??
        res?.extension?.find((x: any) =>
          String(x.url || "").toLowerCase().includes("position")
        )?.valuePoint;

      const lat = Number(pos?.latitude ?? pos?.lat);
      const lon = Number(pos?.longitude ?? pos?.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const d = distM(req.lat, req.lon, lat, lon);
      if (d <= req.radius_m) {
        items.push({
          name,
          finess,
          lat,
          lon,
          address: [line, city].filter(Boolean).join(", "),
          city,
          distance_m: d,
        });
      }
    }

    items.sort((a, b) => (a.distance_m ?? 1e18) - (b.distance_m ?? 1e18));

    const out = {
      count: items.length,
      nearest: items[0] ?? null,
      items: items.slice(0, 25),
    };

    await cachePut(supabase, provider, cache_key, req, out, 200, ttl);

    return {
      provider,
      source: "api",
      coverage: items.length ? "ok" : "no_data",
      reason: items.length ? undefined : "Aucun établissement (filtre/distance) dans le rayon",
      radius_m: req.radius_m,
      count: out.count,
      nearest: out.nearest,
      items: out.items,
    };
  } catch (e) {
    await cachePut(supabase, provider, cache_key, req, { error: String(e) }, 0, 300);
    return {
      provider,
      source: "api",
      coverage: "error",
      reason: `Erreur FINESS fetch: ${String(e)}`,
      radius_m: req.radius_m,
      count: 0,
      nearest: null,
      items: [],
    };
  }
}
