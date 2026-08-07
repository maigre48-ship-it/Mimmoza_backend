// supabase/functions/bpe-proxy/index.ts
// ✅ VERSION v4.5 — Early-stop + category + refine seulement si type_codes fourni (évite 0 résultats)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";

const ODS_API_URL = "https://public.opendatasoft.com/api/records/1.0/search/";
const ODS_DATASET = "buildingref-france-bpe-all-geolocated";
const ODS_API_KEY = Deno.env.get("ODS_API_KEY") ?? "";

// ⚠️ Liste conservée (utile si dataset compatible / ou si caller force type_codes)
const TYPES_ESSENTIELS = new Set<string>([
  "D301", "D201", "D202", "D203", "D204", "D205", "D206", "D207", "D208", "D209", "D210", "D211",
  "D221", "D232", "D233",
  "A203", "A206", "A207", "A208", "A101", "A104",
  "B101", "B102", "B103", "B201", "B202", "B203", "B204",
  "B306",
]);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function toNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function ensureArray<T = unknown>(x: unknown): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? (x as T[]) : ([x] as T[]);
}

function normalizeTypeCode(x: unknown): string | null {
  if (x == null) return null;
  const s = String(x).trim().toUpperCase();
  return s.length ? s : null;
}

function pickFirstString(x: unknown): string | null {
  const arr = ensureArray(x);
  const v = arr.length ? arr[0] : null;
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseGeoPoint2d(geo: unknown): { lat: number; lon: number } | null {
  if (!geo) return null;

  if (Array.isArray(geo) && geo.length >= 2) {
    const a = toNum(geo[0]);
    const b = toNum(geo[1]);
    if (a == null || b == null) return null;
    if (Math.abs(a) > 90 && Math.abs(b) <= 90) return { lat: b, lon: a };
    return { lat: a, lon: b };
  }

  if (typeof geo === "object") {
    const o = geo as any;
    const lat = toNum(o.lat ?? o.latitude);
    const lon = toNum(o.lon ?? o.lng ?? o.longitude);
    if (lat == null || lon == null) return null;
    return { lat, lon };
  }

  if (typeof geo === "string" && geo.includes(",")) {
    const [p1, p2] = geo.split(",").map((s) => s.trim());
    const a = toNum(p1);
    const b = toNum(p2);
    if (a == null || b == null) return null;
    if (Math.abs(a) > 90 && Math.abs(b) <= 90) return { lat: b, lon: a };
    return { lat: a, lon: b };
  }

  return null;
}

function buildRefineQuery(field: string, values: string[], maxValues = 30): string {
  const uniq = Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
  const clipped = uniq.slice(0, Math.max(0, maxValues));
  return clipped.map((v) => `&refine.${encodeURIComponent(field)}=${encodeURIComponent(v)}`).join("");
}

async function fetchBpeFromODS(
  lat: number,
  lon: number,
  radiusM: number,
  typeCodes: string[] | null,
  limit: number,
  debug: boolean,
): Promise<{ items: any[]; error: string | null; debug: any }> {
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const targetItems = Math.max(50, Math.min(3000, safeLimit * 3));

  const filterCodes = (typeCodes ?? []).map(normalizeTypeCode).filter(Boolean) as string[];

  // ✅ refine SEULEMENT si caller fournit explicitement type_codes
  const refineEnabled = filterCodes.length > 0;
  const refineQS = refineEnabled ? buildRefineQuery("equipment_code", filterCodes, 40) : "";

  const debugInfo: any = {
    requests: [],
    totalRecords: 0,
    totalAvailable: 0,
    essentialItemsCount: 0,
    pagesFetched: 0,
    earlyStop: false,
    targetItems,
    ods_api_key_set: Boolean(ODS_API_KEY),
    refine: {
      enabled: refineEnabled,
      field: "equipment_code",
      codesCount: filterCodes.length,
      codesUsed: filterCodes.slice(0, 40),
    },
  };

  const allItems: any[] = [];
  let start = 0;

  const pageSize = 100;
  const maxPages = 30;

  for (let page = 0; page < maxPages; page++) {
    const apiKeyQS = ODS_API_KEY ? `&api_key=${encodeURIComponent(ODS_API_KEY)}` : "";
    const url =
      `${ODS_API_URL}?dataset=${ODS_DATASET}` +
      `&rows=${pageSize}&start=${start}` +
      `&geofilter.distance=${lat},${lon},${radiusM}` +
      refineQS +
      apiKeyQS;

    const entry: any = { url, status: null, recordCount: 0 };
    debugInfo.requests.push(entry);

    const resp = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });

    entry.status = resp.status;
    debugInfo.pagesFetched = page + 1;

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      entry.error = txt.slice(0, 300);
      return { items: [], error: `ODS HTTP ${resp.status}`, debug: debugInfo };
    }

    const data = await resp.json();
    const records = ensureArray<any>(data.records);
    const total = toNum(data.nhits) ?? 0;

    entry.recordCount = records.length;
    debugInfo.totalAvailable = total;
    debugInfo.totalRecords += records.length;

    for (const rec of records) {
      const f = rec.fields ?? {};

      const codes = ensureArray(f.equipment_code).map(normalizeTypeCode).filter(Boolean) as string[];
      if (!codes.length) continue;

      // ✅ Filtrage :
      // - si type_codes fourni => filtre strict
      // - sinon => pas de filtre "TYPES_ESSENTIELS" (dataset pas compatible), on prend tout
      const matched =
        filterCodes.length > 0
          ? codes.find((c) => filterCodes.includes(c))
          : (codes[0] ?? null);

      if (!matched) continue;

      const geo = parseGeoPoint2d(f.geo_point_2d);
      if (!geo) continue;

      const d = haversineDistance(lat, lon, geo.lat, geo.lon);

      allItems.push({
        type_code: matched,
        nom: pickFirstString(f.equipment_name),
        commune: pickFirstString(f.com_arm_name),
        code_commune: pickFirstString(f.com_arm_code),
        category: pickFirstString((f as any).category),
        latitude: geo.lat,
        longitude: geo.lon,
        distance_m: Math.round(d),
      });

      if (allItems.length >= targetItems) {
        debugInfo.earlyStop = true;
        break;
      }
    }

    if (debugInfo.earlyStop) break;

    if (records.length < pageSize || start + pageSize >= total) break;
    start += pageSize;
  }

  allItems.sort((a, b) => a.distance_m - b.distance_m);
  debugInfo.essentialItemsCount = allItems.length;

  if (!debug) {
    debugInfo.requests = debugInfo.requests.map((r: any) => ({
      status: r.status,
      recordCount: r.recordCount,
      error: r.error,
    }));
  }

  return { items: allItems.slice(0, safeLimit), error: null, debug: debugInfo };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { success: false, error: "Method not allowed" });

  const payload = await req.json().catch(() => null);
  if (!payload) return json(400, { success: false, error: "Invalid JSON" });

  const lat = toNum(payload.lat);
  const lon = toNum(payload.lon);
  const radius_m = toNum(payload.radius_m ?? 20000) ?? 20000;
  const limit = toNum(payload.limit ?? 500) ?? 500;
  const debug = Boolean(payload.debug);

  const type_codes = Array.isArray(payload.type_codes)
    ? payload.type_codes.map(normalizeTypeCode).filter(Boolean)
    : null;

  if (lat == null || lon == null) {
    return json(400, { success: false, error: "lat/lon required" });
  }

  console.log(`📦 bpe-proxy v4.5 lat=${lat} lon=${lon} radius=${radius_m} limit=${limit}`);

  try {
    const { items, error, debug: dbg } = await fetchBpeFromODS(
      lat,
      lon,
      radius_m,
      type_codes,
      limit,
      debug,
    );

    if (error) {
      return json(200, { success: false, items: [], count: 0, error, debug: dbg });
    }

    return json(200, {
      success: true,
      items,
      count: items.length,
      source: {
        provider: "opendatasoft-v1.0-geofilter",
        dataset: "bpe",
        ods_api_key_set: Boolean(ODS_API_KEY),
      },
      params: { lat, lon, radius_m, limit },
      ...(debug ? { debug: dbg } : {}),
    });
  } catch (e) {
    console.error("bpe-proxy error:", e);
    return json(500, { success: false, error: "Internal error", details: String(e) });
  }
});
