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

/**
 * FIX D: Vérifie si un content-type est de type JSON
 */
function isJsonContentType(ct: string | null): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return (
    lower.includes("application/json") ||
    lower.includes("application/geo+json") ||
    lower.includes("application/vnd.geo+json")
  );
}

/**
 * FIX D: Vérifie si le contenu ressemble à du HTML
 */
function looksLikeHtml(text: string | null): boolean {
  if (!text) return false;
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<?xml")
  );
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

    // Lire le body comme texte d'abord
    text = await r.text().catch(() => null);

    // FIX D: Détecter si c'est du HTML (même si ok=true) => ne pas parser
    if (looksLikeHtml(text)) {
      return { ok: false, status: r.status, data: null, text, contentType: contentType ?? null };
    }

    // FIX D: Si content-type indique JSON (incluant geo+json, charset variants), parser
    if (isJsonContentType(contentType)) {
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // ignore parse error
      }
    } else if (text) {
      // Sinon, tenter de parser si ça ressemble à JSON
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
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

// -------------------- DVF (Opendatasoft public) --------------------

const DVF_OSD_DATASET_ID =
  "buildingref-france-demande-de-valeurs-foncieres-geolocalisee-millesime";

const DVF_OSD_V1_BASE =
  `https://public.opendatasoft.com/api/records/1.0/search/?dataset=${DVF_OSD_DATASET_ID}`;

type DvfRecord = { fields?: Record<string, unknown> };

let _dvfLastDebug: any = null;

async function fetchDvfRecords(input: MarketContextInput): Promise<DvfRecord[]> {
  const params = new URLSearchParams({
    rows: "200",
    sort: "-date_mutation",
  });

  if (input.zipCode) params.append("refine.code_postal", input.zipCode);

  // ⚠️ On ne refine pas par type_local si propertyType n'est pas explicitement fourni.
  // Sinon, tu risques de te retrouver avec des dépendances uniquement (comme ton sample).
  if (input.propertyType === "appartement") params.append("refine.type_local", "Appartement");
  if (input.propertyType === "maison") params.append("refine.type_local", "Maison");

  const url = `${DVF_OSD_V1_BASE}&${params.toString()}`;
  const res = await fetchJson(url, { method: "GET", headers: { Accept: "application/json" } }, 18_000);

  const records = (res.data?.records ?? []) as any[];
  const out = Array.isArray(records)
    ? (records.map((r) => ({ fields: (r as any)?.fields ?? (r as any) })) as DvfRecord[])
    : [];

  _dvfLastDebug = {
    provider: "opendatasoft_v1",
    url,
    ok: res.ok,
    status: res.status,
    contentType: res.contentType ?? null,
    records_len: out.length,
  };

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
  // Si propertyType explicitement défini => pas de filtre "par défaut"
  if (input.propertyType && input.propertyType !== "autre") return null;
  // Par défaut: on vise logement => Appartement + Maison
  return new Set(["Appartement", "Maison"]);
}

function computeTopTypeLocal(records: DvfRecord[]): Array<{ type: string; n: number }> {
  const m = new Map<string, number>();
  for (const rec of records) {
    const f = (rec.fields ?? {}) as Record<string, unknown>;
    const tl = pickFirstString(f["type_local"]) ?? "";
    if (!tl) continue;
    m.set(tl, (m.get(tl) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, n]) => ({ type, n }));
}

// -------------------- INSEE mini (api-adresse) --------------------

async function resolveInseeMini(input: MarketContextInput): Promise<InseeEnriched | null> {
  const q = encodeURIComponent(`${input.city}`);
  const pc = encodeURIComponent(`${input.zipCode}`);
  const searchUrl = `https://api-adresse.data.gouv.fr/search/?q=${q}&postcode=${pc}&limit=1`;

  const s = await fetchJson(searchUrl, { method: "GET", headers: { Accept: "application/json" } }, 10_000);

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
    const r = await fetchJson(revUrl, { method: "GET", headers: { Accept: "application/json" } }, 10_000);
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
let _geoLastDebug: any = null;

/**
 * FIX A: Utiliser l'endpoint /decoupage-administratif/communes avec:
 * - Query param ?code=<INSEE>&fields=...&format=json
 * - Header Accept: application/json
 * - Détecter et refuser le HTML
 * - Gérer le retour en array
 */
async function fetchGeoApiCommune(code: string): Promise<GeoApiCommune | null> {
  const now = Date.now();
  const hit = geoApiCache.get(code);
  if (hit && now - hit.ts < GEO_TTL_MS) return hit.data;

  // ✅ FIX A: Endpoint corrigé avec /decoupage-administratif/communes, query params et format=json
  const url = `https://geo.api.gouv.fr/decoupage-administratif/communes?code=${encodeURIComponent(code)}&fields=code,nom,population,surface&format=json`;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);

  let data: GeoApiCommune | null = null;

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ac.signal,
    });

    const contentType = r.headers.get("content-type");
    const text = await r.text().catch(() => null);

    // FIX A: Détecter HTML même si status=200
    if (looksLikeHtml(text)) {
      _geoLastDebug = {
        ok: false,
        status: r.status,
        contentType: contentType ?? null,
        url,
        error: "geo_api_returned_html",
        dataIsArray: false,
        dataLength: null,
        sample: text?.slice(0, 100) ?? null,
      };
      geoApiCache.set(code, { ts: now, data: null });
      return null;
    }

    // FIX A: Détecter content-type HTML
    if (contentType && contentType.toLowerCase().includes("text/html")) {
      _geoLastDebug = {
        ok: false,
        status: r.status,
        contentType: contentType ?? null,
        url,
        error: "geo_api_content_type_html",
        dataIsArray: false,
        dataLength: null,
      };
      geoApiCache.set(code, { ts: now, data: null });
      return null;
    }

    // Parser JSON
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        _geoLastDebug = {
          ok: false,
          status: r.status,
          contentType: contentType ?? null,
          url,
          error: "geo_api_json_parse_error",
          dataIsArray: false,
          dataLength: null,
          sample: text?.slice(0, 100) ?? null,
        };
        geoApiCache.set(code, { ts: now, data: null });
        return null;
      }
    }

    // FIX A: L'API retourne un tableau, on prend le premier élément
    const isArray = Array.isArray(parsed);
    const arrLen = isArray ? parsed.length : null;

    if (r.ok && parsed) {
      if (isArray && parsed.length > 0) {
        data = parsed[0] as GeoApiCommune;
      } else if (typeof parsed === "object" && !isArray) {
        // Au cas où l'API retourne un objet unique
        data = parsed as GeoApiCommune;
      }
    }

    _geoLastDebug = {
      ok: r.ok && data !== null,
      status: r.status,
      contentType: contentType ?? null,
      url,
      dataIsArray: isArray,
      dataLength: arrLen,
      error: (!r.ok || data === null) ? "no_data_found" : undefined,
    };

  } catch (err) {
    _geoLastDebug = {
      ok: false,
      status: 0,
      contentType: null,
      url,
      error: `fetch_error: ${err instanceof Error ? err.message : String(err)}`,
      dataIsArray: false,
      dataLength: null,
    };
  } finally {
    clearTimeout(t);
  }

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

let _filoLastDebug: any = null;

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
  const res = await fetchJson(apiUrl, { method: "GET", headers: { Accept: "application/json" } }, 12_000);
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

  // ✅ préférer "latest" (URL permanente vers la dernière version) quand disponible
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

  // gzip -> DecompressionStream
  const ds = new DecompressionStream("gzip");
  const decompressed = resp.body?.pipeThrough(ds);
  if (!decompressed) return await resp.text();

  const ab = await new Response(decompressed).arrayBuffer();
  return new TextDecoder("utf-8").decode(ab);
}

/**
 * FIX B: Suivre les redirections et détecter le HTML
 */
async function fetchWithRedirectFollow(
  url: string,
  maxRedirects = 5,
): Promise<{ resp: Response | null; finalUrl: string; error?: string }> {
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount < maxRedirects) {
    try {
      const resp = await fetch(currentUrl, {
        method: "GET",
        headers: { Accept: "text/csv,*/*" },
        redirect: "manual", // Gérer manuellement les redirections
      });

      // Si c'est une redirection (301, 302, 303, 307, 308)
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        if (!location) {
          return { resp: null, finalUrl: currentUrl, error: "redirect_no_location" };
        }
        // Construire l'URL absolue si relative
        currentUrl = new URL(location, currentUrl).toString();
        redirectCount++;
        continue;
      }

      return { resp, finalUrl: currentUrl };
    } catch (err) {
      return { resp: null, finalUrl: currentUrl, error: `fetch_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { resp: null, finalUrl: currentUrl, error: "too_many_redirects" };
}

async function loadFilosofiCache(): Promise<void> {
  const now = Date.now();
  if (filosofiCache && now - filosofiCache.ts < FILO_TTL_MS) return;

  const { csvUrl, lastModified, resourceId, isGz } = await resolveFilosofiCsvUrl();
  if (!csvUrl) {
    _filoLastDebug = { ok: false, status: 0, error: "no_csv_url", resourceId };
    filosofiCache = { ts: now, map: new Map(), last_updated: lastModified ?? null, csv_url: null, headers: [], resource_id: resourceId ?? null };
    return;
  }

  // FIX B: Utiliser fetchWithRedirectFollow pour gérer les redirections data.gouv
  const { resp, finalUrl, error: redirectError } = await fetchWithRedirectFollow(csvUrl);

  if (!resp) {
    _filoLastDebug = { ok: false, status: 0, error: redirectError ?? "fetch_failed", csvUrl, finalUrl, resourceId };
    filosofiCache = { ts: now, map: new Map(), last_updated: lastModified ?? null, csv_url: csvUrl, headers: [], resource_id: resourceId ?? null };
    return;
  }

  const ct = resp.headers.get("content-type");
  const ok = resp.ok;
  const status = resp.status;

  let text = "";
  try {
    text = await readTextPossiblyGz(resp, isGz);
  } catch {
    text = "";
  }

  if (text && text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const sample = text ? text.slice(0, 300) : "";

  // FIX B: Détecter le HTML et refuser de parser
  if (looksLikeHtml(text)) {
    _filoLastDebug = {
      ok: false,
      status,
      content_type: ct,
      is_gz: isGz,
      error: "filosofi_returned_html",
      sample_starts_with: sample.slice(0, 40),
      csvUrl,
      finalUrl,
      resourceId,
    };
    filosofiCache = { ts: now, map: new Map(), last_updated: lastModified ?? null, csv_url: csvUrl, headers: [], resource_id: resourceId ?? null };
    return;
  }

  // FIX B: Vérifier aussi le content-type
  if (ct && ct.toLowerCase().includes("text/html")) {
    _filoLastDebug = {
      ok: false,
      status,
      content_type: ct,
      is_gz: isGz,
      error: "filosofi_content_type_html",
      sample_starts_with: sample.slice(0, 40),
      csvUrl,
      finalUrl,
      resourceId,
    };
    filosofiCache = { ts: now, map: new Map(), last_updated: lastModified ?? null, csv_url: csvUrl, headers: [], resource_id: resourceId ?? null };
    return;
  }

  _filoLastDebug = {
    ok,
    status,
    content_type: ct,
    is_gz: isGz,
    sample_starts_with: sample.slice(0, 40),
    csvUrl,
    finalUrl,
    resourceId,
  };

  if (!ok) {
    _filoLastDebug.error = `http_status_${status}`;
    filosofiCache = { ts: now, map: new Map(), last_updated: lastModified ?? null, csv_url: csvUrl, headers: [], resource_id: resourceId ?? null };
    return;
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  _filoLastDebug.lines_count = lines.length;

  if (lines.length < 2) {
    _filoLastDebug.error = "not_enough_lines";
    filosofiCache = { ts: now, map: new Map(), last_updated: lastModified ?? null, csv_url: csvUrl, headers: [], resource_id: resourceId ?? null };
    return;
  }

  const delim = detectDelimiter(lines[0]);
  const rawHeaders = splitCsvLine(lines[0], delim);
  const headers = rawHeaders.map(normalizeHeader);

  _filoLastDebug.delim = delim;
  _filoLastDebug.headers_len = headers.length;
  _filoLastDebug.headers_sample = headers.slice(0, 30);

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

  _filoLastDebug.rows_parsed = map.size;
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

async function fetchFilosofiForCode(code: string): Promise<{
  found: boolean;
  revenu_median: number | null;
  taux_pauvrete: number | null;
  part_imposes: number | null;
  last_updated: string | null;
  csv_url: string | null;
  detected_keys?: { medianKey?: string | null; pauvKey?: string | null; imposKey?: string | null };
}> {
  await loadFilosofiCache();
  const row = filosofiCache?.map.get(code) ?? null;
  const found = Boolean(row);

  const revenuRaw = pickRowValue(
    row ?? {},
    "mediane_du_niveau_de_vie",
    "mediane_niveau_de_vie",
    "niveau_de_vie_median",
    "nivvie_med",
    "med",
    "mediane",
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

  if (row && (revenu === null && pauv === null && impos === null)) {
    medianKey = findKeyByHints(row, ["med"], []);
    if (medianKey && !(medianKey.includes("vie") || medianKey.includes("niv") || medianKey.includes("niveau"))) {
      const refined =
        findKeyByHints(row, ["med", "vie"], ["q1", "q3", "p25", "p75"]) ??
        findKeyByHints(row, ["med", "niv"], ["q1", "q3", "p25", "p75"]) ??
        findKeyByHints(row, ["med", "niveau"], ["q1", "q3", "p25", "p75"]);
      if (refined) medianKey = refined;
    }

    pauvKey =
      findKeyByHints(row, ["pauv", "taux"], []) ??
      findKeyByHints(row, ["pauv", "tx"], []) ??
      findKeyByHints(row, ["pauvrete"], []);

    imposKey =
      findKeyByHints(row, ["impos", "part"], []) ??
      findKeyByHints(row, ["impos"], []);

    if (medianKey) revenu = parseEuroOrNull(pickRowValue(row, medianKey));
    if (pauvKey) pauv = parsePercentOrNull(pickRowValue(row, pauvKey));
    if (imposKey) impos = parsePercentOrNull(pickRowValue(row, imposKey));
  }

  return {
    found,
    revenu_median: revenu,
    taux_pauvrete: pauv,
    part_imposes: impos,
    last_updated: filosofiCache?.last_updated ?? null,
    csv_url: filosofiCache?.csv_url ?? null,
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

// -------------------- DVF Reject Counters (FIX C) --------------------

type DvfRejectCounters = {
  type_excluded: number;
  type_excluded_samples: string[];
  missing_type_local: number;
  missing_date_key: number;
  missing_date_value: number;
  bad_date_parse: number;
  missing_price_key: number;
  missing_price_value: number;
  price_le0: number;
  out_window_future: number;
  out_window_past: number;
  used: number;
  used_with_surface: number;
  used_without_surface: number;
  surface_source: {
    surface_reelle_bati: number;
    carrez_sum: number;
    surface_terrain: number;
    none: number;
  };
};

function createDvfRejectCounters(): DvfRejectCounters {
  return {
    type_excluded: 0,
    type_excluded_samples: [],
    missing_type_local: 0,
    missing_date_key: 0,
    missing_date_value: 0,
    bad_date_parse: 0,
    missing_price_key: 0,
    missing_price_value: 0,
    price_le0: 0,
    out_window_future: 0,
    out_window_past: 0,
    used: 0,
    used_with_surface: 0,
    used_without_surface: 0,
    surface_source: {
      surface_reelle_bati: 0,
      carrez_sum: 0,
      surface_terrain: 0,
      none: 0,
    },
  };
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
    const topTypes = input.debug ? computeTopTypeLocal(records) : null;

    // FIX C: Compteurs de rejet DVF
    const rejectCounters = input.debug ? createDvfRejectCounters() : null;

    type DvfEntry = { date: Date; price: number; surface: number | null; priceM2: number | null; typeLocal?: string | null };
    const entries: DvfEntry[] = [];

    let dvfSample: any = null;
    if (input.debug && records.length) {
      const f0 = (records[0].fields ?? {}) as Record<string, unknown>;
      const detected0 = detectDvfKeys(f0);
      dvfSample = {
        first_record_keys: Object.keys(f0),
        detected_keys: detected0,
        first_record_preview: {
          date: detected0.dateKey ? f0[detected0.dateKey] : null,
          valeur: detected0.valeurKey ? f0[detected0.valeurKey] : null,
          surface_bati: detected0.surfaceBatiKey ? f0[detected0.surfaceBatiKey] : null,
          carrez_sum: sumCarrezSurfaces(f0),
          type_local: f0["type_local"] ?? null,
        },
      };
    }

    for (const rec of records) {
      const fields = (rec.fields ?? {}) as Record<string, unknown>;
      const { dateKey, valeurKey, surfaceBatiKey, surfaceTerrainKey } = detectDvfKeys(fields);

      const typeLocal = pickFirstString(fields["type_local"]);

      // FIX C: Filtre type_local avec compteurs
      if (allowed) {
        if (!typeLocal) {
          if (rejectCounters) rejectCounters.missing_type_local++;
          continue;
        }
        if (!allowed.has(typeLocal)) {
          if (rejectCounters) {
            rejectCounters.type_excluded++;
            if (rejectCounters.type_excluded_samples.length < 5 && !rejectCounters.type_excluded_samples.includes(typeLocal)) {
              rejectCounters.type_excluded_samples.push(typeLocal);
            }
          }
          continue;
        }
      }

      // FIX C: Date avec compteurs
      if (!dateKey) {
        if (rejectCounters) rejectCounters.missing_date_key++;
        continue;
      }
      const dateStr = pickFirstString(fields[dateKey]);
      if (!dateStr) {
        if (rejectCounters) rejectCounters.missing_date_value++;
        continue;
      }

      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) {
        if (rejectCounters) rejectCounters.bad_date_parse++;
        continue;
      }

      // FIX C: Prix avec compteurs
      if (!valeurKey) {
        if (rejectCounters) rejectCounters.missing_price_key++;
        continue;
      }
      const valeurFonciere = toNumberOrNull(fields[valeurKey]);
      if (valeurFonciere === null) {
        if (rejectCounters) rejectCounters.missing_price_value++;
        continue;
      }
      if (valeurFonciere <= 0) {
        if (rejectCounters) rejectCounters.price_le0++;
        continue;
      }

      // FIX C: Fenêtre temporelle avec compteurs
      const diffMonths = monthsDiff(now, date);
      if (diffMonths < 0) {
        if (rejectCounters) rejectCounters.out_window_future++;
        continue;
      }
      if (diffMonths > 24) {
        if (rejectCounters) rejectCounters.out_window_past++;
        continue;
      }

      // FIX C: Surface avec compteurs de source
      const sBati = surfaceBatiKey ? toNumberOrNull(fields[surfaceBatiKey]) : null;
      const sCarrez = sumCarrezSurfaces(fields);
      const sTerrain = surfaceTerrainKey ? toNumberOrNull(fields[surfaceTerrainKey]) : null;

      let surface: number | null = null;
      let surfaceSource: "surface_reelle_bati" | "carrez_sum" | "surface_terrain" | "none" = "none";

      if (sBati !== null && sBati > 0) {
        surface = sBati;
        surfaceSource = "surface_reelle_bati";
      } else if (sCarrez !== null && sCarrez > 0) {
        surface = sCarrez;
        surfaceSource = "carrez_sum";
      } else if (sTerrain !== null && sTerrain > 0) {
        surface = sTerrain;
        surfaceSource = "surface_terrain";
      }

      if (rejectCounters) {
        rejectCounters.surface_source[surfaceSource]++;
      }

      const priceM2 = (surface !== null && surface > 0) ? (valeurFonciere / surface) : null;

      if (rejectCounters) {
        rejectCounters.used++;
        if (surface !== null && surface > 0) {
          rejectCounters.used_with_surface++;
        } else {
          rejectCounters.used_without_surface++;
        }
      }

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

    let geo_surface_raw: number | null = null;
    let geo_surface_unit_guess: "m2" | "ha" | "unknown" = "unknown";

    let filosofi_used_code: string | null = null;
    let filosofi_fallback_used: boolean | null = null;
    let filosofi_detected_keys: any = null;

    if (inseeBase?.code_commune) {
      const g = await fetchGeoApiCommune(inseeBase.code_commune);
      const pop = toIntOrNull(g?.population ?? null);

      geo_surface_raw = toNumberOrNull(g?.surface ?? null);
      const surfaceNorm = normalizeSurfaceKm2(geo_surface_raw);
      const surface_km2 = surfaceNorm.km2;
      geo_surface_unit_guess = surfaceNorm.unitGuess;

      const densite = (pop !== null && surface_km2 !== null && surface_km2 > 0) ? (pop / surface_km2) : null;

      const filo = await fetchFilosofiForCommuneWithFallback(
        inseeBase.code_commune,
        inseeBase.code_commune_arr ?? null,
      );

      filosofi_used_code = (filo as any).used_code ?? inseeBase.code_commune;
      filosofi_fallback_used = (filo as any).fallback_used ?? false;
      filosofi_detected_keys = (filo as any).detected_keys ?? null;

      insee = {
        ...inseeBase,
        population: pop,
        surface_km2,
        densite: densite !== null ? Math.round(densite) : null,

        revenu_median: (filo as any).revenu_median ?? null,
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

    if (input.debug === true) {
      resp.debug = {
        zipCode,
        city,
        lat: input.lat ?? null,
        lon: input.lon ?? null,
        insee_code_commune: insee?.code_commune ?? null,
        insee_code_commune_arr: insee?.code_commune_arr ?? null,

        dvf_http: _dvfLastDebug ?? null,
        dvf_records_fetched: records.length,
        dvf_entries_used: transactionsCount,
        dvf_m2_entries_used: m2List.length,
        dvf_top_type_local: topTypes,
        dvf_sample: dvfSample,
        dvf_reject_reasons: rejectCounters, // FIX C: Compteurs de rejet

        geo_api_debug: _geoLastDebug ?? null,
        geo_surface_raw,
        geo_surface_unit_guess,

        filosofi_used_code,
        filosofi_fallback_used,
        filosofi_detected_keys,
        filosofi_last_updated: filosofiCache?.last_updated ?? null,
        filosofi_csv_url_present: Boolean(filosofiCache?.csv_url),
        filosofi_resource_id_present: Boolean(filosofiCache?.resource_id),
        filosofi_headers_sample: (filosofiCache?.headers ?? []).slice(0, 30),
        filosofi_rows_parsed: filosofiCache?.map.size ?? 0,
        filosofi_download_debug: _filoLastDebug ?? null,
      };
    }

    return jsonResponse(200, resp);
  } catch (err) {
    console.error("Erreur market-context-v1:", err);
    return jsonResponse(500, { success: false, error: "Erreur interne dans market-context-v1" });
  }
});