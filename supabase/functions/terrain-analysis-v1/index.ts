/// <reference lib="deno.ns" />
/// <reference lib="dom" />

// supabase/functions/terrain-analysis-v1/index.ts
//
// ✅ terrain-analysis-v1 (v1.5) — REAL PARCEL POINTS (masked) + TRUE SLOPE (plane-fit) + ROBUSTNESS
// - Input: parcel_id + commune_insee (+ optional parcel_geojson) + grid_size + padding_meters
// - Resolves parcel GeoJSON (preferred: payload.parcel_geojson; fallback: cadastre-from-commune + find parcel)
// - Computes:
//     - baseBbox: bbox stricte de la parcelle (sans padding) -> utilisée pour les STATS fiables
//     - renderBbox: bbox paddée -> utilisée pour l'AFFICHAGE (grid rendu)
// - Builds grids:
//     - gridRender over renderBbox (pour le rendu 3D)
//     - gridStats over baseBbox, BUT KPIs are computed ONLY on points INSIDE parcel
// - IMPORTANT CHANGE v1.5:
//     - We do NOT compute slope on full bbox matrix anymore.
//     - We compute slope from INSIDE-PARCEL sample points using a plane-fit in meters.
//     - We ensure we have enough inside-parcel sample points by adaptively increasing stats grid density.
// - Fetches elevations (IGN ALTI if key present, else OpenTopoData SRTM90m with retry/throttle)
// - Returns terrainData with:
//     - parcelBounds = baseBbox (référence parcelle)
//     - renderBounds = renderBbox (référence rendu)
//     - grid.z = gridRender (rendu)
//     - altitudeMin/Max/penteMoyenne computed ONLY from inside-parcel stats points
//     - parcelGeojson = resolved parcel Feature for front masking + earthworks
//
// Notes:
// - Uses Supabase Edge Function `cadastre-from-commune` to retrieve parcel geometry consistently.
// - Requires env:
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY (recommended) OR SUPABASE_ANON_KEY (fallback)
//   - Optional: IGN_ALTI_KEY or VITE_IGN_ALTI_KEY
//   - INTERNAL_ANON_JWT (JWT anon "eyJ...", used ONLY as fallback for internal calls)

import { corsHeaders } from "../_shared/cors.ts";

// -----------------------------
// Versioning (single source of truth)
// -----------------------------
const VERSION = "v1.5" as const;

// Build stamp: helps you verify that the deployed code is the one you expect.
// Each deploy/load gets a new stamp.
const BUILD_STAMP = new Date().toISOString();

type BBox = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]

type TerrainInput = {
  parcel_id?: string | null;
  commune_insee?: string | null;
  parcel_geojson?: any | null;
  grid_size?: number | null;
  padding_meters?: number | null;

  // Optional robustness knobs (safe defaults if omitted)
  request_timeout_ms?: number | null; // default 12_000
  opentopo_chunk_delay_ms?: number | null; // default 450
  opentopo_max_retries?: number | null; // default 4
  ign_max_retries?: number | null; // default 2
  cache_ttl_ms?: number | null; // default 60_000

  // Optional: if you want denser stats sampling for very thin parcels
  stats_grid_max_n?: number | null; // default 120
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Terrain-Version": VERSION,
      "X-Terrain-Build": BUILD_STAMP,
    },
  });
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------
// Network helpers: timeout + retry
// -----------------------------
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(
    () => controller.abort(),
    Math.max(1, timeoutMs || 12_000),
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function isRetryableStatus(status: number) {
  return status === 429 || (status >= 500 && status <= 599);
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: {
    timeoutMs: number;
    maxRetries: number;
    baseBackoffMs: number;
    jitterMs: number;
    retryOnStatuses: (s: number) => boolean;
    tag: string;
  },
): Promise<Response> {
  const maxRetries = Math.max(0, Math.min(10, Math.floor(opts.maxRetries ?? 0)));
  const timeoutMs = Math.max(
    1000,
    Math.min(60_000, Math.floor(opts.timeoutMs ?? 12_000)),
  );
  const baseBackoffMs = Math.max(
    50,
    Math.min(5_000, Math.floor(opts.baseBackoffMs ?? 250)),
  );
  const jitterMs = Math.max(0, Math.min(2_000, Math.floor(opts.jitterMs ?? 150)));

  let lastErr: any = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);
      if (!opts.retryOnStatuses(res.status) || attempt === maxRetries) return res;

      const wait = Math.floor(baseBackoffMs * Math.pow(2, attempt) + Math.random() * jitterMs);
      console.warn(
        `[${opts.tag}] retryable status=${res.status}, attempt=${attempt + 1}/${maxRetries}, wait=${wait}ms`,
      );
      try {
        await res.text().catch(() => "");
      } catch {
        // ignore
      }
      await delay(wait);
      continue;
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries) break;
      const wait = Math.floor(baseBackoffMs * Math.pow(2, attempt) + Math.random() * jitterMs);
      console.warn(`[${opts.tag}] fetch error (attempt=${attempt + 1}/${maxRetries}):`, e);
      await delay(wait);
    }
  }

  throw lastErr ?? new Error(`[${opts.tag}] fetch failed`);
}

// -----------------------------
// GeoJSON helpers (bbox + find parcel)
// -----------------------------
function collectCoordsFromGeometry(geom: any, out: number[][]) {
  if (!geom || typeof geom !== "object") return;
  const t = geom.type;
  const c = geom.coordinates;
  if (!t || !c) return;

  if (t === "Polygon" && Array.isArray(c)) {
    for (const ring of c) {
      if (!Array.isArray(ring)) continue;
      for (const p of ring) {
        if (Array.isArray(p) && p.length >= 2) out.push([Number(p[0]), Number(p[1])]);
      }
    }
    return;
  }

  if (t === "MultiPolygon" && Array.isArray(c)) {
    for (const poly of c) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) {
        if (!Array.isArray(ring)) continue;
        for (const p of ring) {
          if (Array.isArray(p) && p.length >= 2) out.push([Number(p[0]), Number(p[1])]);
        }
      }
    }
    return;
  }

  if (t === "Point" && Array.isArray(c) && c.length >= 2) {
    out.push([Number(c[0]), Number(c[1])]);
    return;
  }

  if (t === "LineString" && Array.isArray(c)) {
    for (const p of c) {
      if (Array.isArray(p) && p.length >= 2) out.push([Number(p[0]), Number(p[1])]);
    }
    return;
  }

  if (t === "MultiLineString" && Array.isArray(c)) {
    for (const line of c) {
      if (!Array.isArray(line)) continue;
      for (const p of line) {
        if (Array.isArray(p) && p.length >= 2) out.push([Number(p[0]), Number(p[1])]);
      }
    }
    return;
  }
}

function bboxFromFeature(feature: any): BBox {
  const geom = feature?.type === "Feature" ? feature.geometry : feature?.geometry ?? feature;
  const coords: number[][] = [];
  collectCoordsFromGeometry(geom, coords);
  if (!coords.length) throw new Error("bboxFromFeature: geometry has no coordinates");

  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;

  for (const [lng, lat] of coords) {
    if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) continue;
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }

  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) {
    throw new Error("bboxFromFeature: bbox not computable (non-finite)");
  }
  return [minLng, minLat, maxLng, maxLat];
}

function normalizeToFeature(raw: any): any | null {
  if (!raw) return null;

  if (raw.type === "Feature" && raw.geometry) return raw;

  if (raw.type === "FeatureCollection" && Array.isArray(raw.features)) {
    const f = raw.features.find(
      (x: any) =>
        x?.type === "Feature" &&
        (x?.geometry?.type === "Polygon" || x?.geometry?.type === "MultiPolygon"),
    );
    return f ?? null;
  }

  if (raw.geometry && (raw.geometry.type === "Polygon" || raw.geometry.type === "MultiPolygon")) {
    return { type: "Feature", geometry: raw.geometry, properties: raw.properties ?? {} };
  }

  if (raw.type === "Polygon" || raw.type === "MultiPolygon") {
    return { type: "Feature", geometry: raw, properties: {} };
  }

  return null;
}

// ✅ Deep extractor for FeatureCollection (robust to nested responses)
function extractFeatureCollectionFromAnyResponse(data: any, depth = 0): any | null {
  if (!data || typeof data !== "object") return null;

  if (data.type === "FeatureCollection" && Array.isArray(data.features)) return data;

  if (depth > 5) return null;

  const preferredKeys = ["geojson", "data", "cadastre", "parcelles", "features"];
  for (const key of preferredKeys) {
    const v = (data as any)[key];
    if (v && typeof v === "object") {
      const fc = extractFeatureCollectionFromAnyResponse(v, depth + 1);
      if (fc) return fc;
    }
  }

  for (const v of Object.values(data)) {
    if (v && typeof v === "object") {
      const fc = extractFeatureCollectionFromAnyResponse(v, depth + 1);
      if (fc) return fc;
    }
  }

  return null;
}

// ✅ Robust parcel feature matcher (covers more property keys)
function findFeatureForParcelRobust(fc: any, parcelId: string): any | null {
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return null;

  const target = String(parcelId ?? "").trim();
  if (!target) return null;

  for (const f of fc.features) {
    const p = (f?.properties || {}) as any;

    const candidates = [
      f?.id,
      p?.id,
      p?.ID,
      p?.idu,
      p?.IDU,
      p?.parcel_id,
      p?.parcelle_id,
      p?.id_parcelle,
      p?.parcelle,
      p?.cleabs,
      p?.cleabs_id,
    ]
      .filter((v) => v !== undefined && v !== null)
      .map((v) => String(v).trim());

    if (candidates.includes(target)) return f;
  }

  return null;
}

// -----------------------------
// Point-in-polygon (parcel mask for stats)
// -----------------------------
type LonLat = [number, number];

function pointInRing(pt: LonLat, ring: LonLat[]): boolean {
  const x = pt[0];
  const y = pt[1];
  let inside = false;

  const n = ring.length;
  if (n < 3) return false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect =
      (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

function pointInPolygonCoords(pt: LonLat, poly: LonLat[][]): boolean {
  if (!Array.isArray(poly) || poly.length === 0) return false;

  const outer = poly[0];
  if (!pointInRing(pt, outer)) return false;

  for (let k = 1; k < poly.length; k++) {
    const hole = poly[k];
    if (pointInRing(pt, hole)) return false;
  }

  return true;
}

function pointInGeometry(pt: LonLat, geom: any): boolean {
  if (!geom || typeof geom !== "object") return false;

  if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
    const poly = geom.coordinates as LonLat[][];
    return pointInPolygonCoords(pt, poly);
  }

  if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
    const mp = geom.coordinates as LonLat[][][];
    for (const poly of mp) {
      if (pointInPolygonCoords(pt, poly)) return true;
    }
    return false;
  }

  return false;
}

function pointInFeature(pt: LonLat, feature: any): boolean {
  const geom = feature?.type === "Feature" ? feature.geometry : feature?.geometry ?? feature;
  return pointInGeometry(pt, geom);
}

// -----------------------------
// bbox padding meters -> degrees (approx)
// -----------------------------
function metersToDegreesLat(m: number): number {
  return m / 111_320;
}

function metersToDegreesLng(m: number, atLatDeg: number): number {
  const cos = Math.cos((atLatDeg * Math.PI) / 180);
  const denom = 111_320 * (cos || 1e-6);
  return m / denom;
}

function padBbox(b: BBox, paddingMeters: number): BBox {
  if (!paddingMeters || paddingMeters <= 0) return b;
  const [minLng, minLat, maxLng, maxLat] = b;
  const midLat = (minLat + maxLat) / 2;
  const dLat = metersToDegreesLat(paddingMeters);
  const dLng = metersToDegreesLng(paddingMeters, midLat);
  return [minLng - dLng, minLat - dLat, maxLng + dLng, maxLat + dLat];
}

// -----------------------------
// Grid
// -----------------------------
function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function buildGrid(bbox: BBox, gridSize: number) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const n = clampInt(gridSize || 17, 10, 200); // allow higher internally if needed

  const lonList: number[] = new Array(n);
  const latList: number[] = new Array(n);

  for (let ix = 0; ix < n; ix++) {
    const tx = n === 1 ? 0.5 : ix / (n - 1);
    lonList[ix] = minLng + tx * (maxLng - minLng);
  }
  for (let iy = 0; iy < n; iy++) {
    const ty = n === 1 ? 0.5 : iy / (n - 1);
    latList[iy] = minLat + ty * (maxLat - minLat);
  }

  const points: Array<{ lon: number; lat: number }> = [];
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      points.push({ lon: lonList[ix], lat: latList[iy] });
    }
  }

  return { n, lonList, latList, points };
}

function filterInsidePoints(
  feature: any,
  points: Array<{ lon: number; lat: number }>,
): { inside: Array<{ lon: number; lat: number }>; mask: boolean[]; count: number } {
  const mask: boolean[] = new Array(points.length);
  let count = 0;
  const inside: Array<{ lon: number; lat: number }> = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const ok = pointInFeature([p.lon, p.lat], feature);
    mask[i] = ok;
    if (ok) {
      count++;
      inside.push(p);
    }
  }
  return { inside, mask, count };
}

// -----------------------------
// Elevation providers
// -----------------------------
const IGN_ALTI_KEY = Deno.env.get("IGN_ALTI_KEY") ?? Deno.env.get("VITE_IGN_ALTI_KEY") ?? "";

async function fetchIgnAlti(
  points: Array<{ lon: number; lat: number }>,
  opts: { timeoutMs: number; maxRetries: number },
): Promise<number[]> {
  if (!IGN_ALTI_KEY) throw new Error("IGN_ALTI_KEY missing");
  const chunkSize = 100;
  const out: number[] = [];

  for (let i = 0; i < points.length; i += chunkSize) {
    const chunk = points.slice(i, i + chunkSize);
    const lons = chunk.map((p) => p.lon.toFixed(7)).join(",");
    const lats = chunk.map((p) => p.lat.toFixed(7)).join(",");
    const url = `https://wxs.ign.fr/${encodeURIComponent(
      IGN_ALTI_KEY,
    )}/alti/rest/elevation.json?lon=${lons}&lat=${lats}`;

    const res = await fetchWithRetry(
      url,
      { method: "GET" },
      {
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        baseBackoffMs: 250,
        jitterMs: 200,
        retryOnStatuses: isRetryableStatus,
        tag: "IGN_ALTI",
      },
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`IGN_ALTI_HTTP_${res.status}: ${txt}`);
    }

    const json = await res.json();
    const elevations = (json?.elevations ?? json?.elevation ?? json?.results) as any;

    if (!Array.isArray(elevations) || elevations.length === 0) {
      throw new Error("IGN_ALTI: invalid response (no elevations array)");
    }

    for (const e of elevations) {
      const z = e?.z ?? e?.altitude ?? e?.elevation ?? e?.h ?? null;
      out.push(typeof z === "number" && Number.isFinite(z) ? z : NaN);
    }
  }

  return out;
}

async function fetchOpenTopoSrtm(
  points: Array<{ lon: number; lat: number }>,
  opts: { timeoutMs: number; maxRetries: number; chunkDelayMs: number },
): Promise<number[]> {
  const chunkSize = 80;
  const out: number[] = [];

  for (let i = 0; i < points.length; i += chunkSize) {
    const chunk = points.slice(i, i + chunkSize);
    const locations = chunk.map((p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`).join("|");
    const url = `https://api.opentopodata.org/v1/srtm90m?locations=${encodeURIComponent(locations)}`;

    if (i > 0) await delay(Math.max(0, Math.floor(opts.chunkDelayMs ?? 450)));

    const res = await fetchWithRetry(
      url,
      { method: "GET" },
      {
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        baseBackoffMs: 400,
        jitterMs: 250,
        retryOnStatuses: isRetryableStatus,
        tag: "OPENTOPODATA",
      },
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`OPENTOPODATA_HTTP_${res.status}: ${txt}`);
    }

    const json = await res.json();
    const results = json?.results;
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error("OPENTOPODATA: invalid response (no results array)");
    }

    for (const r of results) {
      const z = r?.elevation;
      out.push(typeof z === "number" && Number.isFinite(z) ? z : NaN);
    }
  }

  return out;
}

// -----------------------------
// Missing value handling
// -----------------------------
function medianFinite(values: number[]): number | null {
  const arr = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function fillMissingValues(values: number[]): { filled: number[]; fillValue: number } {
  const med = medianFinite(values);
  const fillValue = Number.isFinite(med) ? (med as number) : 0;
  const filled = values.map((v) => (Number.isFinite(v) ? v : fillValue));
  return { filled, fillValue };
}

// -----------------------------
// Plane-fit slope on inside-parcel points (TRUE slope)
// -----------------------------
// We fit z = a*x + b*y + c (x,y in meters) with least squares.
// slope% = sqrt(a^2 + b^2) * 100
function estimateSlopePlaneFitPercent(
  ptsLonLat: Array<{ lon: number; lat: number }>,
  zVals: number[],
): number {
  const n = Math.min(ptsLonLat.length, zVals.length);
  if (n < 6) return 0;

  // Use centroid as origin to keep numbers stable
  let lon0 = 0;
  let lat0 = 0;
  for (let i = 0; i < n; i++) {
    lon0 += ptsLonLat[i].lon;
    lat0 += ptsLonLat[i].lat;
  }
  lon0 /= n;
  lat0 /= n;

  const cosLat = Math.cos((lat0 * Math.PI) / 180) || 1e-6;
  const mxPerDegLon = 111_320 * cosLat;
  const mxPerDegLat = 111_320;

  // Build normal equations for [a,b,c]
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0;
  let Sxz = 0, Syz = 0, Sz = 0;

  let used = 0;
  for (let i = 0; i < n; i++) {
    const z = zVals[i];
    if (!Number.isFinite(z)) continue;

    const dx = (ptsLonLat[i].lon - lon0) * mxPerDegLon;
    const dy = (ptsLonLat[i].lat - lat0) * mxPerDegLat;

    Sxx += dx * dx;
    Sxy += dx * dy;
    Syy += dy * dy;
    Sx += dx;
    Sy += dy;

    Sxz += dx * z;
    Syz += dy * z;
    Sz += z;

    used++;
  }

  if (used < 6) return 0;

  // Solve 3x3 linear system with Cramer's rule
  const A11 = Sxx, A12 = Sxy, A13 = Sx;
  const A21 = Sxy, A22 = Syy, A23 = Sy;
  const A31 = Sx, A32 = Sy, A33 = used;

  const det =
    A11 * (A22 * A33 - A23 * A32) -
    A12 * (A21 * A33 - A23 * A31) +
    A13 * (A21 * A32 - A22 * A31);

  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return 0;

  const B1 = Sxz, B2 = Syz, B3 = Sz;

  const detA =
    B1 * (A22 * A33 - A23 * A32) -
    A12 * (B2 * A33 - A23 * B3) +
    A13 * (B2 * A32 - A22 * B3);

  const detB =
    A11 * (B2 * A33 - A23 * B3) -
    B1 * (A21 * A33 - A23 * A31) +
    A13 * (A21 * B3 - B2 * A31);

  const a = detA / det;
  const b = detB / det;

  const slopeRatio = Math.sqrt(a * a + b * b);
  const slopePercent = slopeRatio * 100;

  if (!Number.isFinite(slopePercent)) return 0;
  return Math.max(0, Math.min(100, slopePercent));
}

// -----------------------------
// Parcel resolver (cadastre-from-commune)
// -----------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const INTERNAL_ANON_JWT = Deno.env.get("INTERNAL_ANON_JWT") ?? "";

function getApiKeyOrThrow(): string {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY (recommended) or SUPABASE_ANON_KEY");
  return key;
}

function getForwardedOrFallbackAuthorization(req: Request): string {
  const incoming = (req.headers.get("Authorization") || "").trim();

  if (incoming.startsWith("Bearer ")) {
    const token = incoming.slice("Bearer ".length).trim();
    if (token.length > 50 && token !== "null" && token !== "undefined") {
      return `Bearer ${token}`;
    }
  }

  if (!INTERNAL_ANON_JWT) {
    throw new Error("Missing INTERNAL_ANON_JWT secret (required for internal calls)");
  }

  return `Bearer ${INTERNAL_ANON_JWT.trim()}`;
}

async function resolveParcelGeojson(req: Request, communeInsee: string, parcelId: string): Promise<any> {
  if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");

  const baseUrl = SUPABASE_URL.replace(/\/$/, "");
  const url = `${baseUrl}/functions/v1/cadastre-from-commune`;

  const apiKey = getApiKeyOrThrow();
  const auth = getForwardedOrFallbackAuthorization(req);

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
        Authorization: auth,
      },
      body: JSON.stringify({ commune_insee: communeInsee }),
    },
    {
      timeoutMs: 15_000,
      maxRetries: 2,
      baseBackoffMs: 250,
      jitterMs: 200,
      retryOnStatuses: isRetryableStatus,
      tag: "CADASTRE_FROM_COMMUNE",
    },
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`cadastre-from-commune HTTP ${res.status}: ${txt}`);
  }

  const json = await res.json();

  const fc = extractFeatureCollectionFromAnyResponse(json);
  if (!fc) {
    throw new Error("cadastre-from-commune: FeatureCollection introuvable dans la réponse");
  }

  const feature = findFeatureForParcelRobust(fc, parcelId);
  if (!feature) {
    throw new Error(`Parcel not found in cadastre-from-commune response (parcelId=${parcelId}).`);
  }

  const norm = normalizeToFeature(feature);
  if (!norm) throw new Error("Invalid parcel feature geometry");
  return norm;
}

// -----------------------------
// Best-effort in-memory cache (within same isolate)
// -----------------------------
type CacheValue = { at: number; value: any };
const __CACHE: Map<string, CacheValue> = new Map();

function cacheGet<T>(key: string, ttlMs: number): T | null {
  if (!ttlMs || ttlMs <= 0) return null;
  const v = __CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.at > ttlMs) {
    __CACHE.delete(key);
    return null;
  }
  return v.value as T;
}

function cacheSet(key: string, value: any) {
  __CACHE.set(key, { at: Date.now(), value });
}

// -----------------------------
// Stats sampling: adaptive density until we have enough inside-parcel points
// -----------------------------
function buildStatsSamplePointsAdaptive(
  parcelFeature: any,
  baseBbox: BBox,
  requestedN: number,
  maxN: number,
): {
  nUsed: number;
  gridAll: ReturnType<typeof buildGrid>;
  inside: Array<{ lon: number; lat: number }>;
  inCount: number;
  minNeeded: number;
} {
  // We require a meaningful inside sample count to avoid "flat"/artifact KPIs.
  // 15% of grid points, with a hard floor.
  const baseRequested = clampInt(requestedN || 17, 10, 80);
  const maxAllowed = clampInt(maxN || 120, 20, 200);

  let n = baseRequested;

  // minNeeded depends on n (n*n points)
  const computeMinNeeded = (nn: number) => Math.max(20, Math.floor(nn * nn * 0.15));

  let grid = buildGrid(baseBbox, n);
  let insidePack = filterInsidePoints(parcelFeature, grid.points);
  let minNeeded = computeMinNeeded(n);

  // Increase density until enough inside points or we hit max
  while (insidePack.count < minNeeded && n < maxAllowed) {
    n = Math.min(maxAllowed, n + 10);
    grid = buildGrid(baseBbox, n);
    insidePack = filterInsidePoints(parcelFeature, grid.points);
    minNeeded = computeMinNeeded(n);
  }

  return {
    nUsed: n,
    gridAll: grid,
    inside: insidePack.inside,
    inCount: insidePack.count,
    minNeeded,
  };
}

// -----------------------------
// Main handler
// -----------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const started = Date.now();

  try {
    const payload = (await req.json().catch(() => ({}))) as TerrainInput;

    const parcel_id = String(payload?.parcel_id ?? "").trim() || null;
    const commune_insee = String(payload?.commune_insee ?? "").trim() || null;

    const grid_size = Number(payload?.grid_size ?? 17);
    const padding_meters = Number(payload?.padding_meters ?? 80);

    const request_timeout_ms = Number(payload?.request_timeout_ms ?? 12_000);
    const opentopo_chunk_delay_ms = Number(payload?.opentopo_chunk_delay_ms ?? 450);
    const opentopo_max_retries = clampInt(Number(payload?.opentopo_max_retries ?? 4), 0, 10);
    const ign_max_retries = clampInt(Number(payload?.ign_max_retries ?? 2), 0, 10);
    const cache_ttl_ms = Number(payload?.cache_ttl_ms ?? 60_000);
    const stats_grid_max_n = Number(payload?.stats_grid_max_n ?? 120);

    // 1) Resolve parcel geojson
    let parcelFeature: any | null = null;
    if (payload?.parcel_geojson) {
      parcelFeature = normalizeToFeature(payload.parcel_geojson);
    }
    if (!parcelFeature) {
      if (!parcel_id || !commune_insee) {
        throw new Error("Missing parcel_geojson and (parcel_id + commune_insee)");
      }
      parcelFeature = await resolveParcelGeojson(req, commune_insee, parcel_id);
    }

    // 2) bboxes
    const baseBbox = bboxFromFeature(parcelFeature);
    const renderBbox = padBbox(baseBbox, Number.isFinite(padding_meters) ? padding_meters : 80);

    // 3) render grid (kept for 3D mesh)
    const gridRender = buildGrid(
      renderBbox,
      clampInt(Number.isFinite(grid_size) ? grid_size : 17, 10, 80),
    );
    const renderMaskPack = filterInsidePoints(parcelFeature, gridRender.points);
    const inParcelCountRender = renderMaskPack.count;

    // 4) stats sample points: adaptive density until we truly sample inside the parcel
    const statsPack = buildStatsSamplePointsAdaptive(
      parcelFeature,
      baseBbox,
      clampInt(Number.isFinite(grid_size) ? grid_size : 17, 10, 80),
      clampInt(Number.isFinite(stats_grid_max_n) ? stats_grid_max_n : 120, 20, 200),
    );

    const statsPointsInside = statsPack.inside; // ONLY inside-parcel points, exact lon/lat
    const inParcelCountStats = statsPack.inCount;

    if (statsPointsInside.length < 6) {
      // This should be extremely rare; it would mean the polygon test or geometry is invalid.
      throw new Error(
        `Stats sampling too sparse: inside=${statsPointsInside.length}. Check parcel geometry / coordinates.`,
      );
    }

    // Cache key: include version + bboxes + render n + stats nUsed + provider presence
    const cacheKey =
      `${VERSION}|${parcel_id ?? "nogid"}|${commune_insee ?? "noci"}|base=${baseBbox.map((x) => x.toFixed(7)).join(",")}` +
      `|render=${renderBbox.map((x) => x.toFixed(7)).join(",")}|nR=${gridRender.n}|nS=${statsPack.nUsed}|ign=${IGN_ALTI_KEY ? "1" : "0"}`;

    const cached = cacheGet<any>(cacheKey, Number.isFinite(cache_ttl_ms) ? cache_ttl_ms : 0);
    if (cached) {
      const ms = Date.now() - started;
      return jsonResponse({
        success: true,
        version: VERSION,
        buildStamp: BUILD_STAMP,
        terrainData: cached.terrainData,
        debug: {
          ...cached.debug,
          ms,
          cache: "HIT",
          receivedKeys: Object.keys(payload ?? {}),
        },
      });
    }

    // 5) elevations fetch (render grid + stats INSIDE points only)
    let provider = "OPENTOPODATA_SRTM90";
    let elevationsRender: number[] = [];
    let elevationsStatsInside: number[] = [];

    const fetchAll = async () => {
      if (IGN_ALTI_KEY) {
        try {
          elevationsRender = await fetchIgnAlti(gridRender.points, {
            timeoutMs: request_timeout_ms,
            maxRetries: ign_max_retries,
          });
          elevationsStatsInside = await fetchIgnAlti(statsPointsInside, {
            timeoutMs: request_timeout_ms,
            maxRetries: ign_max_retries,
          });
          provider = "IGN_ALTI";
          return;
        } catch (e) {
          console.warn("[terrain-analysis-v1] IGN_ALTI failed, fallback OpenTopo:", e);
        }
      }

      elevationsRender = await fetchOpenTopoSrtm(gridRender.points, {
        timeoutMs: request_timeout_ms,
        maxRetries: opentopo_max_retries,
        chunkDelayMs: opentopo_chunk_delay_ms,
      });
      elevationsStatsInside = await fetchOpenTopoSrtm(statsPointsInside, {
        timeoutMs: request_timeout_ms,
        maxRetries: opentopo_max_retries,
        chunkDelayMs: opentopo_chunk_delay_ms,
      });
      provider = "OPENTOPODATA_SRTM90";
    };

    await fetchAll();

    if (!Array.isArray(elevationsRender) || elevationsRender.length !== gridRender.points.length) {
      throw new Error(
        `Elevation(render) invalid: len=${(elevationsRender as any)?.length ?? "?"}, expected=${gridRender.points.length}`,
      );
    }
    if (
      !Array.isArray(elevationsStatsInside) ||
      elevationsStatsInside.length !== statsPointsInside.length
    ) {
      throw new Error(
        `Elevation(statsInside) invalid: len=${(elevationsStatsInside as any)?.length ?? "?"}, expected=${statsPointsInside.length}`,
      );
    }

    // 5b) Fill NaN/missing
    const filledRender = fillMissingValues(elevationsRender);
    const filledStatsInside = fillMissingValues(elevationsStatsInside);

    // 6) build gridRender.z for rendering (nR x nR)
    const nR = gridRender.n;
    const gridZRender: number[][] = new Array(nR);

    let idxR = 0;
    for (let y = 0; y < nR; y++) {
      const row: number[] = new Array(nR);
      for (let x = 0; x < nR; x++) {
        const z = filledRender.filled[idxR++];
        row[x] = Number.isFinite(z) ? z : filledRender.fillValue;
      }
      gridZRender[y] = row;
    }

    // 7) altitude min/max ONLY on inside-parcel stats points
    let altitudeMinParcel = Infinity;
    let altitudeMaxParcel = -Infinity;

    for (let i = 0; i < filledStatsInside.filled.length; i++) {
      const z = filledStatsInside.filled[i];
      const zz = Number.isFinite(z) ? z : filledStatsInside.fillValue;
      if (zz < altitudeMinParcel) altitudeMinParcel = zz;
      if (zz > altitudeMaxParcel) altitudeMaxParcel = zz;
    }

    if (!Number.isFinite(altitudeMinParcel) || !Number.isFinite(altitudeMaxParcel)) {
      const med = medianFinite(filledStatsInside.filled);
      if (!Number.isFinite(med)) throw new Error("altitudeMin/altitudeMax not computable");
      altitudeMinParcel = med as number;
      altitudeMaxParcel = med as number;
    }

    // 8) pente réelle: plane-fit on INSIDE points (meters), not bbox matrix
    const penteMoyenne = estimateSlopePlaneFitPercent(statsPointsInside, filledStatsInside.filled);

    const terrainData = {
      altitudeMin: altitudeMinParcel,
      altitudeMax: altitudeMaxParcel,
      penteMoyenne,
      provider,
      parcelBounds: baseBbox, // bbox stricte parcelle (référence)
      renderBounds: renderBbox, // bbox rendu (paddée) pour aligner le mesh si besoin côté front
      grid: { z: gridZRender, n: nR }, // grille rendu
      parcel_id,
      commune_insee,

      // ✅ ADDED: parcelGeojson for front masking + earthworks
      parcelGeojson: parcelFeature,
    };

    const ms = Date.now() - started;

    const responseBody = {
      success: true,
      version: VERSION,
      buildStamp: BUILD_STAMP,
      terrainData,
      debug: {
        ms,
        cache: "MISS",
        receivedKeys: Object.keys(payload ?? {}),
        provider,
        baseBbox,
        renderBbox,

        nRender: nR,
        pointsCountRender: gridRender.points.length,
        inParcelCountRender,

        nStatsUsed: statsPack.nUsed,
        pointsCountStatsGridAll: statsPack.gridAll.points.length,
        inParcelCountStats,
        statsMinNeeded: statsPack.minNeeded,

        filledNaNWithRender: filledRender.fillValue,
        filledNaNWithStatsInside: filledStatsInside.fillValue,

        timeouts: { request_timeout_ms },
        throttling: { opentopo_chunk_delay_ms, opentopo_max_retries, ign_max_retries },

        // Optional small proof for you (first 5 inside-parcel points)
        sampleInsidePoints: statsPointsInside.slice(0, 5).map((p, i) => ({
          lon: p.lon,
          lat: p.lat,
          z: Number.isFinite(filledStatsInside.filled[i])
            ? filledStatsInside.filled[i]
            : filledStatsInside.fillValue,
        })),
      },
    };

    cacheSet(cacheKey, { terrainData, debug: responseBody.debug });

    return jsonResponse(responseBody);
  } catch (e: any) {
    return jsonResponse(
      {
        success: false,
        version: VERSION,
        buildStamp: BUILD_STAMP,
        error: String(e?.message ?? e),
      },
      500,
    );
  }
});
