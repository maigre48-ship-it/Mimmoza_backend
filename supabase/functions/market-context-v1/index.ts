// supabase/functions/market-context-v1/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

/**
 * market-context-v1
 * - Entrée: zipCode + city (et optionnel surfaceHabitable/priceAsked/lat/lon/propertyType)
 * - Sortie: marketContext (DVF stats + scores) + insee (enrichi via sources open)
 *
 * DVF (public.opendatasoft.com, BuildingRef/Etalab):
 * - Le dataset renvoie souvent des lignes sans surface (ex: Dépendance)
 * - Par défaut, si propertyType est absent/ "autre", on filtre côté code sur Appartement+Maison
 * - On calcule price/m² uniquement si on trouve une surface (surface_reelle_bati ou somme carrez lot*)
 *
 * FiLoSoFi (data.gouv.fr):
 * - Les URLs /download/ et /api/resources/.../data/csv/ peuvent 404 selon la ressource.
 * - On utilise `resource.latest` (URL permanente vers la dernière version) quand disponible.
 * - On supporte les CSV gzip (.gz) via DecompressionStream("gzip").
 * - Colonnes standard FiLoSoFi: MEDxx (médiane niveau de vie), TXPAUxx (taux pauvreté),
 *   PARTIMPxx (part ménages imposés) où xx = année à 2 chiffres (ex: 21 = 2021).
 */

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

type MarketContextInput = {
  address?: string;
  zipCode: string;
  city: string;
  propertyType?: "appartement" | "maison" | "immeuble" | "terrain" | "autre";
  surfaceHabitable?: number;
  priceAsked?: number;
  lat?: number;
  lon?: number;
  debug?: boolean;
};

type MarketContext = {
  location: {
    city: string;
    zipCode: string;
    inseeCode?: string | null;
  };
  dvfWindow: {
    periodMonths: number;
    radiusMeters: number;
  };
  stats: {
    transactionsCount: number;
    priceM2Median: number | null;
    priceM2P25: number | null;
    priceM2P75: number | null;
    priceTrend12m: number | null;
  };
  scores: {
    dynamismScore: number;
    liquidityScore: number;
    demandDepthScore: number;
  };
};

type InseeEnriched = {
  code_commune: string | null;
  commune: string | null;
  departement: string | null;
  code_commune_arr?: string | null;

  population?: number | null;
  surface_km2?: number | null;
  densite?: number | null;

  revenu_median?: number | null;
  taux_pauvrete?: number | null;
  part_menages_imposes?: number | null;

  // Valeur canonique (même valeur que revenu_median, mais champ explicite)
  incomeMedianUcEur?: number | null;
  incomeMedianUcYear?: number | null;

  source: {
    provider: string;
    dataset: string;
    note?: string;
    last_updated?: string | null;
  };
};

// -------------------- helpers --------------------

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function monthsDiff(d1: Date, d2: Date): number {
  const years = d1.getFullYear() - d2.getFullYear();
  const months = d1.getMonth() - d2.getMonth();
  const total = years * 12 + months;
  const dayDiff = d1.getDate() - d2.getDate();
  return total + dayDiff / 30;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(",", ".").trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toIntOrNull(v: unknown): number | null {
  const n = toNumberOrNull(v);
  if (n === null) return null;
  const i = Math.trunc(n);
  return Number.isFinite(i) ? i : null;
}

function pickFirstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length) return v.trim();
  }
  return null;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; status: number; data: any | null; text?: string | null; contentType?: string | null }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    const contentType = r.headers.get("content-type");
    let data: any | null = null;
    let text: string | null = null;

    if ((contentType ?? "").includes("application/json")) {
      data = await r.json().catch(() => null);
    } else {
      text = await r.text().catch(() => null);
      if (text && text.trim().startsWith("{")) {
        try {
          data = JSON.parse(text);
        } catch {
          // ignore
        }
      }
    }

    return { ok: r.ok, status: r.status, data, text, contentType: contentType ?? null };
  } catch {
    return { ok: false, status: 0, data: null, text: null, contentType: null };
  } finally {
    clearTimeout(t);
  }
}

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * geo.api.gouv.fr renvoie souvent `surface` en hectares (ex: Paris 10536,03).
 * Normalisation:
 * - si surface > 5,000,000 => m² => km² = surface / 1e6
 * - sinon => hectares => km² = surface / 100
 */
function normalizeSurfaceKm2(
  surfaceRaw: number | null,
): { km2: number | null; unitGuess: "m2" | "ha" | "unknown" } {
  if (surfaceRaw === null || !Number.isFinite(surfaceRaw) || surfaceRaw <= 0) {
    return { km2: null, unitGuess: "unknown" };
  }
  if (surfaceRaw > 5_000_000) return { km2: surfaceRaw / 1_000_000, unitGuess: "m2" };
  return { km2: surfaceRaw / 100, unitGuess: "ha" };
}

function normalizeKey(k: string) {
  return k
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9_]/g, "_");
}

// -------------------- FiLoSoFi helpers (MEDxx / TXPAUxx / PARTIMPxx) --------------------

/**
 * Scans all keys in `row` whose normalized form starts with `prefix` followed by 2 digits (year).
 * Returns the key with the highest year (most recent data).
 * Example: prefix="med" → matches "med21", "med20", "med19" → picks "med21" → year=2021
 *
 * Note: headers are already normalized by normalizeHeader() (lowercase, no diacritics, underscores).
 * So original CSV "MED21" becomes "med21", "TXPAU21" becomes "txpau21", etc.
 */
function pickLatestYearKey(
  row: Record<string, string>,
  prefix: string,
): { key: string; year: number } | null {
  const pfx = prefix.toLowerCase();
  let best: { key: string; year: number } | null = null;

  for (const k of Object.keys(row)) {
    const kk = k.toLowerCase();
    if (!kk.startsWith(pfx)) continue;
    const suffix = kk.slice(pfx.length);
    // Accept exactly 2-digit year
    const m = suffix.match(/^(\d{2})$/);
    if (!m) continue;
    const yy = Number(m[1]);
    // Convert 2-digit to 4-digit: 00-49 → 2000-2049, 50-99 → 1950-1999
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    if (!best || year > best.year) {
      best = { key: k, year };
    }
  }

  return best;
}

/**
 * Reads a non-empty string value from a row by key.
 */
function getRowValue(row: Record<string, string>, key: string): string | null {
  const v = row[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

// -------------------- DVF (Opendatasoft public) --------------------

const DVF_OSD_DATASET_ID =
  "buildingref-france-demande-de-valeurs-foncieres-geolocalisee-millesime";

const DVF_OSD_V1_BASE =
  `https://public.opendatasoft.com/api/records/1.0/search/?dataset=${DVF_OSD_DATASET_ID}`;

type DvfRecord = { fields?: Record<string, unknown> };

async function fetchDvfRecords(input: MarketContextInput): Promise<DvfRecord[]> {
  const params = new URLSearchParams({
    rows: "200",
    sort: "-date_mutation",
  });

  if (input.zipCode) params.append("refine.code_postal", input.zipCode);

  if (input.propertyType === "appartement") params.append("refine.type_local", "Appartement");
  if (input.propertyType === "maison") params.append("refine.type_local", "Maison");

  const url = `${DVF_OSD_V1_BASE}&${params.toString()}`;
  const res = await fetchJson(url, { method: "GET", headers: { accept: "application/json" } }, 18_000);

  const records = (res.data?.records ?? []) as any[];
  const out = Array.isArray(records)
    ? (records.map((r) => ({ fields: (r as any)?.fields ?? (r as any) })) as DvfRecord[])
    : [];

  return out;
}

function pickFirstExistingKey(fields: Record<string, unknown>, candidates: string[]): string | null {
  const keys = Object.keys(fields);
  const normToActual = new Map<string, string>();
  for (const k of keys) normToActual.set(normalizeKey(k), k);

  for (const cand of candidates) {
    const actual = normToActual.get(normalizeKey(cand));
    if (actual) return actual;
  }
  return null;
}

function findKeyByContainsAll(
  fields: Record<string, unknown>,
  containsAll: string[],
  excludes: string[] = [],
): string | null {
  for (const k of Object.keys(fields)) {
    const kk = normalizeKey(k);
    if (excludes.some((e) => kk.includes(e))) continue;
    if (containsAll.every((c) => kk.includes(c))) return k;
  }
  return null;
}

function detectDvfKeys(fields: Record<string, unknown>) {
  const dateKey =
    pickFirstExistingKey(fields, ["date_mutation", "datemutation", "date", "date_de_mutation", "date_mut"]) ??
    findKeyByContainsAll(fields, ["date", "mut"]) ??
    findKeyByContainsAll(fields, ["date"]);

  const valeurKey =
    pickFirstExistingKey(fields, ["valeur_fonciere", "valeurfonciere", "valeur_fonciere_eur", "valeur", "prix", "montant"]) ??
    findKeyByContainsAll(fields, ["valeur", "fonc"]) ??
    findKeyByContainsAll(fields, ["prix"]);

  const surfaceBatiKey =
    pickFirstExistingKey(fields, ["surface_reelle_bati", "surfacereellebati", "surface_bati"]) ??
    findKeyByContainsAll(fields, ["surface", "reelle", "bati"]) ??
    findKeyByContainsAll(fields, ["surface", "bati"]);

  const surfaceTerrainKey =
    pickFirstExistingKey(fields, ["surface_terrain"]) ??
    findKeyByContainsAll(fields, ["surface", "terrain"]);

  return { dateKey, valeurKey, surfaceBatiKey, surfaceTerrainKey };
}

function sumCarrezSurfaces(fields: Record<string, unknown>): number | null {
  let sum = 0;
  let found = 0;
  for (const k of Object.keys(fields)) {
    const nk = normalizeKey(k);
    if (nk.includes("surface") && nk.includes("carrez")) {
      const v = toNumberOrNull(fields[k]);
      if (v !== null && v > 0) {
        sum += v;
        found++;
      }
    }
  }
  return found ? sum : null;
}

function defaultAllowedTypes(input: MarketContextInput): Set<string> | null {
  if (input.propertyType && input.propertyType !== "autre") return null;
  return new Set(["Appartement", "Maison"]);
}

// -------------------- INSEE mini (api-adresse) --------------------

async function resolveInseeMini(input: MarketContextInput): Promise<InseeEnriched | null> {
  const q = encodeURIComponent(`${input.city}`);
  const pc = encodeURIComponent(`${input.zipCode}`);
  const searchUrl = `https://api-adresse.data.gouv.fr/search/?q=${q}&postcode=${pc}&limit=1`;

  const s = await fetchJson(searchUrl, { method: "GET", headers: { accept: "application/json" } }, 10_000);

  const feat = s.data?.features?.[0];
  const props = feat?.properties ?? {};
  const code_search = pickFirstString(props.citycode);
  const city_search = pickFirstString(props.city, input.city);

  const lat = toNumberOrNull((input as any).lat);
  const lon = toNumberOrNull((input as any).lon);
  let code_reverse: string | null = null;

  if (lat !== null && lon !== null) {
    const revUrl =
      `https://api-adresse.data.gouv.fr/reverse/?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lon))}&limit=1`;
    const r = await fetchJson(revUrl, { method: "GET", headers: { accept: "application/json" } }, 10_000);
    const f2 = r.data?.features?.[0];
    const p2 = f2?.properties ?? {};
    code_reverse = pickFirstString(p2.citycode);
  }

  const primary = code_search ?? code_reverse ?? null;
  if (!primary) return null;

  const departement = primary.length >= 2 ? primary.slice(0, 2) : null;

  return {
    code_commune: primary,
    commune: city_search ?? input.city,
    departement,
    code_commune_arr: (code_reverse && code_reverse !== primary) ? code_reverse : null,
    source: {
      provider: "api-adresse",
      dataset: code_search ? "search" : "reverse",
      note: code_search
        ? "city+postcode -> citycode (commune)"
        : "lat/lon -> citycode (may be arrondissement for Paris)",
      last_updated: null,
    },
  };
}

// -------------------- Enrich: geo.api.gouv.fr --------------------

type GeoApiCommune = {
  code?: string;
  nom?: string;
  population?: number;
  surface?: number;
};

const geoApiCache = new Map<string, { ts: number; data: GeoApiCommune | null }>();
const GEO_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchGeoApiCommune(code: string): Promise<GeoApiCommune | null> {
  const now = Date.now();
  const hit = geoApiCache.get(code);
  if (hit && now - hit.ts < GEO_TTL_MS) return hit.data;

  const url = `https://geo.api.gouv.fr/communes/${encodeURIComponent(code)}?fields=code,nom,population,surface`;
  const res = await fetchJson(url, { method: "GET", headers: { accept: "application/json" } }, 10_000);

  const data = (res.ok && res.data) ? (res.data as GeoApiCommune) : null;
  geoApiCache.set(code, { ts: now, data });
  return data;
}

// -------------------- FiLoSoFi (data.gouv) --------------------

const FILOSOFI_DATASET_SLUG =
  "revenus-et-pauvrete-des-menages-aux-niveaux-national-et-local-revenus-localises-sociaux-et-fiscaux";

let filosofiCache:
  | {
    ts: number;
    map: Map<string, Record<string, string>>;
    last_updated: string | null;
    csv_url: string | null;
    headers: string[];
    resource_id: string | null;
  }
  | null = null;

const FILO_TTL_MS = 24 * 60 * 60 * 1000;

function detectDelimiter(line: string): string {
  const semi = (line.match(/;/g) ?? []).length;
  const comma = (line.match(/,/g) ?? []).length;
  return semi >= comma ? ";" : ",";
}

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQ && next === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (!inQ && ch === delim) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function pickRowValue(row: Record<string, string>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim().length) return v.trim();
  }
  return null;
}

async function resolveFilosofiCsvUrl(): Promise<{
  csvUrl: string | null;
  lastModified: string | null;
  resourceId: string | null;
  isGz: boolean;
}> {
  const apiUrl = `https://www.data.gouv.fr/api/1/datasets/${encodeURIComponent(FILOSOFI_DATASET_SLUG)}/`;
  const res = await fetchJson(apiUrl, { method: "GET", headers: { accept: "application/json" } }, 12_000);
  if (!res.ok || !res.data) return { csvUrl: null, lastModified: null, resourceId: null, isGz: false };

  const resources = (res.data?.resources ?? []) as any[];
  if (!Array.isArray(resources) || resources.length === 0) return { csvUrl: null, lastModified: null, resourceId: null, isGz: false };

  const csv = resources.find((r) => {
    const fmt = String(r?.format ?? "").toLowerCase();
    const mime = String(r?.mime ?? "").toLowerCase();
    const url = String(r?.url ?? "");
    const latest = String(r?.latest ?? "");
    return (
      fmt.includes("csv") ||
      mime.includes("csv") ||
      url.toLowerCase().includes(".csv") ||
      url.toLowerCase().includes(".csv.gz") ||
      latest.toLowerCase().includes(".csv") ||
      latest.toLowerCase().includes(".csv.gz")
    );
  });

  const rid = csv?.id ? String(csv.id) : null;

  const latestUrl = csv?.latest ? String(csv.latest) : null;
  const url = csv?.url ? String(csv.url) : null;

  const chosen = latestUrl || url || null;
  const isGz = Boolean(chosen && chosen.toLowerCase().includes(".gz"));

  const lastModified = csv?.last_modified
    ? String(csv.last_modified)
    : (res.data?.last_modified ? String(res.data.last_modified) : null);

  return { csvUrl: chosen, lastModified, resourceId: rid, isGz };
}

async function readTextPossiblyGz(resp: Response, isGz: boolean): Promise<string> {
  if (!isGz) return await resp.text();

  const ds = new DecompressionStream("gzip");
  const decompressed = resp.body?.pipeThrough(ds);
  if (!decompressed) return await resp.text();

  const ab = await new Response(decompressed).arrayBuffer();
  return new TextDecoder("utf-8").decode(ab);
}

async function loadFilosofiCache(): Promise<void> {
  const now = Date.now();
  if (filosofiCache && now - filosofiCache.ts < FILO_TTL_MS) return;

  const { csvUrl, lastModified, resourceId, isGz } = await resolveFilosofiCsvUrl();
  if (!csvUrl) {
    filosofiCache = { ts: now, map: new Map(), last_updated: lastModified ?? null, csv_url: null, headers: [], resource_id: resourceId ?? null };
    return;
  }

  const resp = await fetch(csvUrl, { method: "GET", headers: { accept: "text/csv,*/*" } }).catch(() => null);
  if (!resp) {
    filosofiCache = { ts: now, map: new Map(), last_updated: lastModified ?? null, csv_url: csvUrl, headers: [], resource_id: resourceId ?? null };
    return;
  }

  const ok = resp.ok;

  let text = "";
  try {
    text = await readTextPossiblyGz(resp, isGz);
  } catch {
    text = "";
  }

  if (text && text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  if (!ok) {
    filosofiCache = { ts: now, map: new Map(), last_updated: lastModified ?? null, csv_url: csvUrl, headers: [], resource_id: resourceId ?? null };
    return;
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);

  if (lines.length < 2) {
    filosofiCache = { ts: now, map: new Map(), last_updated: lastModified ?? null, csv_url: csvUrl, headers: [], resource_id: resourceId ?? null };
    return;
  }

  const delim = detectDelimiter(lines[0]);
  const rawHeaders = splitCsvLine(lines[0], delim);
  const headers = rawHeaders.map(normalizeHeader);

  const map = new Map<string, Record<string, string>>();

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delim);
    if (cols.length === 0) continue;

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j] ?? `col_${j}`;
      row[key] = (cols[j] ?? "").trim();
    }

    const code = pickRowValue(row, "codgeo", "code_geographique", "codegeo", "code", "code_commune") ?? null;
    if (code && /^\d{5}$/.test(code)) map.set(code, row);
  }

  filosofiCache = { ts: now, map, last_updated: lastModified ?? null, csv_url: csvUrl, headers, resource_id: resourceId ?? null };
}

function parsePercentOrNull(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v.replace(",", ".").replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

function parseEuroOrNull(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v.replace(/\s/g, "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
}

function findKeyByHints(row: Record<string, string>, includesAll: string[], excludes: string[] = []): string | null {
  for (const k of Object.keys(row)) {
    const kk = k.toLowerCase();
    if (excludes.some((e) => kk.includes(e))) continue;
    if (includesAll.every((h) => kk.includes(h))) return k;
  }
  return null;
}

// -------------------- fetchFilosofiForCode --------------------

async function fetchFilosofiForCode(code: string): Promise<{
  found: boolean;
  revenu_median: number | null;
  taux_pauvrete: number | null;
  part_imposes: number | null;
  last_updated: string | null;
  csv_url: string | null;
  incomeMedianUcYear?: number | null;
  detected_keys?: { medianKey?: string | null; pauvKey?: string | null; imposKey?: string | null };
}> {
  await loadFilosofiCache();
  const row = filosofiCache?.map.get(code) ?? null;
  const found = Boolean(row);

  // ──────────────────────────────────────────────────────────────
  // ÉTAPE 1 : Colonnes "longues" explicites (priorité haute)
  // ──────────────────────────────────────────────────────────────
  const revenuRaw = pickRowValue(
    row ?? {},
    "mediane_du_niveau_de_vie",
    "mediane_niveau_de_vie",
    "niveau_de_vie_median",
    "niveau_vie_median",
    "nivvie_med",
    "mediane_revenu_disponible",
    "revenu_disponible_median",
    "revenu_disponible_median_uc",
  );

  const pauvRaw = pickRowValue(
    row ?? {},
    "taux_de_pauvrete_ensemble",
    "taux_pauvrete_ensemble",
    "taux_de_pauvrete",
    "taux_pauvrete",
    "txpau",
  );

  const imposRaw = pickRowValue(
    row ?? {},
    "part_des_menages_imposes",
    "part_menages_imposes",
    "part_des_menages_fiscaux_imposes",
    "part_imposes",
  );

  let revenu = parseEuroOrNull(revenuRaw);
  let pauv = parsePercentOrNull(pauvRaw);
  let impos = parsePercentOrNull(imposRaw);

  let medianKey: string | null = null;
  let pauvKey: string | null = null;
  let imposKey: string | null = null;
  let incomeYear: number | null = null;

  // ──────────────────────────────────────────────────────────────
  // ÉTAPE 2 : Fallback colonnes FiLoSoFi courtes MEDxx / TXPAUxx / PARTIMPxx
  // ──────────────────────────────────────────────────────────────
  if (row && revenu === null) {
    const medResult = pickLatestYearKey(row, "med");
    if (medResult) {
      const raw = getRowValue(row, medResult.key);
      const parsed = parseEuroOrNull(raw);
      if (parsed !== null) {
        revenu = parsed;
        medianKey = medResult.key;
        incomeYear = medResult.year;
      }
    }
  }

  if (row && pauv === null) {
    const txpauResult = pickLatestYearKey(row, "txpau");
    if (txpauResult) {
      const raw = getRowValue(row, txpauResult.key);
      const parsed = parsePercentOrNull(raw);
      if (parsed !== null) {
        pauv = parsed;
        pauvKey = txpauResult.key;
      }
    }
  }

  if (row && impos === null) {
    const partimpResult = pickLatestYearKey(row, "partimp");
    if (partimpResult) {
      const raw = getRowValue(row, partimpResult.key);
      const parsed = parsePercentOrNull(raw);
      if (parsed !== null) {
        impos = parsed;
        imposKey = partimpResult.key;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // ÉTAPE 3 : Dernier recours — findKeyByHints (recherche floue)
  // ──────────────────────────────────────────────────────────────
  if (row && revenu === null && pauv === null && impos === null) {
    if (!medianKey) {
      medianKey =
        findKeyByHints(row, ["med", "vie"], ["q1", "q3", "p25", "p75"]) ??
        findKeyByHints(row, ["med", "niv"], ["q1", "q3", "p25", "p75"]) ??
        findKeyByHints(row, ["med", "niveau"], ["q1", "q3", "p25", "p75"]) ??
        findKeyByHints(row, ["med", "disponible"], ["q1", "q3", "p25", "p75"]) ??
        null;
    }

    if (!pauvKey) {
      pauvKey =
        findKeyByHints(row, ["pauv", "taux"], []) ??
        findKeyByHints(row, ["pauv", "tx"], []) ??
        findKeyByHints(row, ["pauvrete"], []);
    }

    if (!imposKey) {
      imposKey =
        findKeyByHints(row, ["impos", "part"], []) ??
        findKeyByHints(row, ["impos"], []);
    }

    if (medianKey && revenu === null) revenu = parseEuroOrNull(pickRowValue(row, medianKey));
    if (pauvKey && pauv === null) pauv = parsePercentOrNull(pickRowValue(row, pauvKey));
    if (imposKey && impos === null) impos = parsePercentOrNull(pickRowValue(row, imposKey));
  }

  // Try to infer year from key name if not already set
  if (incomeYear === null && medianKey) {
    const m = medianKey.match(/(19|20)\d{2}/);
    if (m) incomeYear = Number(m[0]);
  }

  return {
    found,
    revenu_median: revenu,
    taux_pauvrete: pauv,
    part_imposes: impos,
    last_updated: filosofiCache?.last_updated ?? null,
    csv_url: null,
    incomeMedianUcYear: incomeYear,
    detected_keys: { medianKey, pauvKey, imposKey },
  };
}

async function fetchFilosofiForCommuneWithFallback(codeCommune: string, codeArr?: string | null) {
  const primary = await fetchFilosofiForCode(codeCommune);
  const allNullPrimary = (primary.revenu_median === null && primary.taux_pauvrete === null && primary.part_imposes === null);

  if (codeArr && /^\d{5}$/.test(codeArr) && (!primary.found || allNullPrimary)) {
    const arr = await fetchFilosofiForCode(codeArr);
    const allNullArr = (arr.revenu_median === null && arr.taux_pauvrete === null && arr.part_imposes === null);
    if (arr.found && !allNullArr) return { ...arr, used_code: codeArr, fallback_used: true };
  }

  return { ...primary, used_code: codeCommune, fallback_used: false };
}

// -------------------- main --------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const body = (await req.json().catch(() => null)) as MarketContextInput | null;
    if (!body) return jsonResponse(400, { success: false, error: "Body JSON invalide" });

    const zipCode = pickFirstString(body.zipCode);
    const city = pickFirstString(body.city);
    if (!zipCode || !city) {
      return jsonResponse(400, { success: false, error: "Requête incomplète : zipCode et city sont obligatoires." });
    }

    const input: MarketContextInput = {
      address: body.address,
      zipCode,
      city,
      propertyType: body.propertyType ?? "autre",
      surfaceHabitable: toNumberOrNull(body.surfaceHabitable ?? undefined) ?? undefined,
      priceAsked: toNumberOrNull(body.priceAsked ?? undefined) ?? undefined,
      lat: toNumberOrNull((body as any).lat) ?? undefined,
      lon: toNumberOrNull((body as any).lon) ?? undefined,
      debug: body.debug === true,
    };

    // 1) DVF
    const records = await fetchDvfRecords(input);
    const now = new Date();

    const allowed = defaultAllowedTypes(input);

    type DvfEntry = { date: Date; price: number; surface: number | null; priceM2: number | null; typeLocal?: string | null };
    const entries: DvfEntry[] = [];

    for (const rec of records) {
      const fields = (rec.fields ?? {}) as Record<string, unknown>;
      const { dateKey, valeurKey, surfaceBatiKey, surfaceTerrainKey } = detectDvfKeys(fields);

      const typeLocal = pickFirstString(fields["type_local"]);
      if (allowed && typeLocal && !allowed.has(typeLocal)) continue;

      const dateStr = dateKey ? pickFirstString(fields[dateKey]) : null;
      const valeurFonciere = valeurKey ? toNumberOrNull(fields[valeurKey]) : null;
      if (!dateStr || valeurFonciere === null || valeurFonciere <= 0) continue;

      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) continue;

      const diffMonths = monthsDiff(now, date);
      if (diffMonths < 0 || diffMonths > 24) continue;

      const sBati = surfaceBatiKey ? toNumberOrNull(fields[surfaceBatiKey]) : null;
      const sCarrez = sumCarrezSurfaces(fields);
      const sTerrain = surfaceTerrainKey ? toNumberOrNull(fields[surfaceTerrainKey]) : null;

      const surface =
        (sBati !== null && sBati > 0) ? sBati :
        (sCarrez !== null && sCarrez > 0) ? sCarrez :
        (sTerrain !== null && sTerrain > 0) ? sTerrain :
        null;

      const priceM2 = (surface !== null && surface > 0) ? (valeurFonciere / surface) : null;
      entries.push({ date, price: valeurFonciere, surface, priceM2, typeLocal: typeLocal ?? null });
    }

    const transactionsCount = entries.length;

    const m2List = entries
      .map((e) => e.priceM2)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);

    const priceM2Median = median(m2List);
    const priceM2P25 = percentile(m2List, 25);
    const priceM2P75 = percentile(m2List, 75);

    const last12m: number[] = [];
    const prev12m: number[] = [];
    for (const e of entries) {
      if (e.priceM2 === null) continue;
      const diff = monthsDiff(now, e.date);
      if (diff <= 12) last12m.push(e.priceM2);
      else prev12m.push(e.priceM2);
    }

    const medianLast12m = median(last12m);
    const medianPrev12m = median(prev12m);

    let priceTrend12m: number | null = null;
    if (medianLast12m !== null && medianPrev12m !== null && medianPrev12m > 0) {
      priceTrend12m = ((medianLast12m - medianPrev12m) / medianPrev12m) * 100;
    }

    let dynamismScore = 50;
    if (transactionsCount === 0) dynamismScore = 30;
    else if (transactionsCount < 10) dynamismScore = 45;
    else if (transactionsCount < 30) dynamismScore = 60;
    else if (transactionsCount < 80) dynamismScore = 75;
    else dynamismScore = 85;

    let liquidityScore = dynamismScore;
    if (priceTrend12m !== null) {
      if (priceTrend12m > 8) liquidityScore += 10;
      else if (priceTrend12m > 3) liquidityScore += 5;
      else if (priceTrend12m < -5) liquidityScore -= 10;
      else if (priceTrend12m < -2) liquidityScore -= 5;
    }
    liquidityScore = clamp(liquidityScore);

    let demandDepthScore = 70;
    if (input.priceAsked && input.surfaceHabitable && input.surfaceHabitable > 0 && priceM2Median && priceM2Median > 0) {
      const priceM2Bien = input.priceAsked / input.surfaceHabitable;
      const ratio = priceM2Bien / priceM2Median;

      if (ratio > 1.25) demandDepthScore -= 15;
      else if (ratio > 1.1) demandDepthScore -= 5;
      else if (ratio < 0.8) demandDepthScore += 10;
      else if (ratio < 0.95) demandDepthScore += 5;
    }
    demandDepthScore = clamp(demandDepthScore);

    // 2) INSEE (mini + enrich)
    const inseeBase = await resolveInseeMini(input);
    let insee: InseeEnriched | null = inseeBase;

    if (inseeBase?.code_commune) {
      const g = await fetchGeoApiCommune(inseeBase.code_commune);
      const pop = toIntOrNull(g?.population ?? null);

      const geo_surface_raw = toNumberOrNull(g?.surface ?? null);
      const surfaceNorm = normalizeSurfaceKm2(geo_surface_raw);
      const surface_km2 = surfaceNorm.km2;
      const geo_surface_unit_guess = surfaceNorm.unitGuess;

      const densite = (pop !== null && surface_km2 !== null && surface_km2 > 0) ? (pop / surface_km2) : null;

      const filo = await fetchFilosofiForCommuneWithFallback(
        inseeBase.code_commune,
        inseeBase.code_commune_arr ?? null,
      );

      const filosofi_used_code = (filo as any).used_code ?? inseeBase.code_commune;
      const filosofi_fallback_used = (filo as any).fallback_used ?? false;

      insee = {
        ...inseeBase,
        population: pop,
        surface_km2,
        densite: densite !== null ? Math.round(densite) : null,

        revenu_median: (filo as any).revenu_median ?? null,
        incomeMedianUcEur: (filo as any).revenu_median ?? null,
        incomeMedianUcYear: (filo as any).incomeMedianUcYear ?? null,
        taux_pauvrete: (filo as any).taux_pauvrete ?? null,
        part_menages_imposes: (filo as any).part_imposes ?? null,

        source: {
          provider: "market-context-v1",
          dataset: "insee+geoapi+filosofi",
          note:
            `geo.api.gouv.fr (surface_unit_guess=${geo_surface_unit_guess}) + data.gouv FiLoSoFi (used_code=${filosofi_used_code}${filosofi_fallback_used ? ", fallback=arr" : ""})`,
          last_updated: (filo as any).last_updated ?? null,
        },
      };
    }

    const dvfRadiusMeters = (() => {
      const env = Deno.env.get("MARKET_DVF_RADIUS_M");
      const n = env ? Number(env) : NaN;
      if (Number.isFinite(n) && n > 0) return Math.round(n);
      return 1200;
    })();

    const marketContext: MarketContext = {
      location: { city: input.city, zipCode: input.zipCode, inseeCode: insee?.code_commune ?? null },
      dvfWindow: { periodMonths: 24, radiusMeters: dvfRadiusMeters },
      stats: { transactionsCount, priceM2Median, priceM2P25, priceM2P75, priceTrend12m },
      scores: {
        dynamismScore: Math.round(dynamismScore),
        liquidityScore: Math.round(liquidityScore),
        demandDepthScore: Math.round(demandDepthScore),
      },
    };

    const resp: any = {
      success: true,
      marketContext,
      insee: insee ?? null,
      source: {
        provider: "market-context-v1",
        dvf: "public.opendatasoft.com (BuildingRef/Etalab)",
        geo: "api-adresse.data.gouv.fr + geo.api.gouv.fr",
        insee: "data.gouv.fr (FiLoSoFi via resource.latest/url)",
      },
    };

    console.info("[market-context-v1] completed");

    return jsonResponse(200, resp);
  } catch (_err) {
    console.error("[market-context-v1] Internal error");
    return jsonResponse(500, { success: false, error: "Erreur interne dans market-context-v1" });
  }
});