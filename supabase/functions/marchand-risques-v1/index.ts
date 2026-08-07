// =============================================================================
// marchand-risques-v1/index.ts
// Edge Function — Analyse risques GeoRisques pour l'espace Marchand
//
// ✅ Standalone : aucune dépendance locale, aucune table DB
// ✅ Cache optionnel via RPC api_cache_get / api_cache_put
// ✅ Scoring inline (copié de banque-risques-v1 scoreRisksV1)
// ✅ Input flexible : lat/lng | adresse | parcel_id
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function errJson(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const LOG = "[marchand-risques-v1]";
function log(msg: string, data?: unknown) {
  console.log(`${LOG} ${msg}`, data ?? "");
}
function logErr(msg: string, err?: unknown) {
  console.error(`${LOG} ❌ ${msg}`, err ?? "");
}

// ---------------------------------------------------------------------------
// INPUT TYPES
// ---------------------------------------------------------------------------
interface Input {
  lat?: number;
  lng?: number;
  adresse?: string;
  parcel_id?: string;
  rayon_m?: number;
  ttl_seconds?: number;
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// GEORISQUES TYPES
// ---------------------------------------------------------------------------
type RiskLevel = "fort" | "moyen" | "faible" | "inconnu" | "non_concerne";

interface RiskItem {
  key: string;
  label: string;
  level: RiskLevel;
  scoreImpact?: number;
  source?: string;
  detail?: string;
  raw?: unknown;
}

interface RiskScoring {
  score: number;
  grade: "A" | "B" | "C" | "D" | "E";
  level_label: string;
  confidence: number;
  rationale: string[];
  items: Array<{
    key: string;
    label: string;
    severity: "low" | "moderate" | "high" | "critical" | "unknown";
    score_impact: number;
    confidence: number;
  }>;
}

interface RisksWithScore {
  risks: RiskItem[];
  scoring: RiskScoring;
  raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------
const GEORISQUES_BASE = "https://georisques.gouv.fr/api/v1";

const RISK_CATALOG: Record<
  string,
  { label: string; weight: number; category: string }
> = {
  flood: { label: "Inondation", weight: 3, category: "naturel" },
  clay_shrink_swell: {
    label: "Retrait-gonflement argiles",
    weight: 2,
    category: "geotechnique",
  },
  landslide: { label: "Mouvement de terrain", weight: 2, category: "naturel" },
  seismic: { label: "Séisme", weight: 2, category: "naturel" },
  radon: { label: "Radon", weight: 1, category: "pollution" },
  avalanche: { label: "Avalanche", weight: 2, category: "naturel" },
  wildfire: { label: "Feux de forêt", weight: 2, category: "naturel" },
  storm_wind: { label: "Tempête / Vent", weight: 1, category: "naturel" },
  snow_ice: { label: "Neige / Verglas", weight: 1, category: "naturel" },
  cyclone: { label: "Cyclone", weight: 1, category: "naturel" },
  industrial_tech: {
    label: "Risque industriel (ICPE/SEVESO)",
    weight: 2,
    category: "technologique",
  },
  dangerous_goods_transport: {
    label: "Transport matières dangereuses",
    weight: 1,
    category: "technologique",
  },
  polluted_soil: {
    label: "Sites pollués (SIS)",
    weight: 3,
    category: "pollution",
  },
  coastal_erosion: {
    label: "Érosion littorale",
    weight: 3,
    category: "naturel",
  },
  mining: { label: "Risque minier / Cavités", weight: 3, category: "geotechnique" },
  volcanic: { label: "Volcanisme", weight: 1, category: "naturel" },
};

const ALL_RISK_KEYS = Object.keys(RISK_CATALOG);

// ---------------------------------------------------------------------------
// HELPER: safe fetch with timeout
// ---------------------------------------------------------------------------
async function safeFetch(
  url: string,
  timeoutMs = 12000
): Promise<{ ok: boolean; data: unknown; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      return { ok: false, data: null, status: resp.status };
    }
    const d = await resp.json();
    return { ok: true, data: d, status: resp.status };
  } catch (e) {
    clearTimeout(timer);
    logErr(`fetch failed: ${url}`, e);
    return { ok: false, data: null, status: 0 };
  }
}

// ---------------------------------------------------------------------------
// STEP 1: Resolve lat/lng + code_insee
// ---------------------------------------------------------------------------

/** Geocode via data.geopf.fr */
async function geocodeAddress(
  adresse: string
): Promise<{ lat: number; lng: number; code_insee: string } | null> {
  const url = `https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(
    adresse
  )}&limit=1`;
  const r = await safeFetch(url);
  if (!r.ok) return null;
  const d = r.data as any;
  const feat = d?.features?.[0];
  if (!feat) return null;
  const [lon, lat] = feat.geometry?.coordinates ?? [];
  const code_insee =
    feat.properties?.citycode ?? feat.properties?.municipality ?? "";
  if (!lat || !lon) return null;
  return { lat, lng: lon, code_insee };
}

/** Resolve parcel_id via cadastre Etalab */
async function resolveParcel(
  parcel_id: string
): Promise<{ lat: number; lng: number; code_insee: string } | null> {
  // parcel_id format: "DDDCCC000SSNNNN" or various formats
  // Try etalab cadastre GeoJSON feature endpoint
  const cleanId = parcel_id.replace(/[\s-]/g, "").toUpperCase();

  // Extract commune code (5 first chars) to build URL
  const deptCode = cleanId.substring(0, 2);
  const communeCode = cleanId.substring(0, 5);
  const section = cleanId.substring(5, 10).replace(/^0+/, "");
  const numero = cleanId.substring(10);

  // Try the Etalab cadastre API
  const url = `https://cadastre.data.gouv.fr/bundler/cadastre-etalab/communes/${communeCode}/geojson/parcelles`;
  const r = await safeFetch(url, 20000);

  if (r.ok) {
    const geo = r.data as any;
    const features = geo?.features ?? [];

    // Try to find the exact parcel
    const match = features.find((f: any) => {
      const fId = (f.properties?.id ?? "").replace(/[\s-]/g, "").toUpperCase();
      return fId === cleanId || fId.endsWith(cleanId.substring(5));
    });

    const target = match ?? features[0];
    if (target?.geometry?.coordinates) {
      const coords = flattenCoords(target.geometry.coordinates);
      if (coords.length > 0) {
        const centroid = computeCentroid(coords);
        return {
          lat: centroid[1],
          lng: centroid[0],
          code_insee: communeCode,
        };
      }
    }
  }

  // Fallback: use geo API for commune centroid
  const communeUrl = `https://geo.api.gouv.fr/communes/${communeCode}?fields=centre&format=json`;
  const cr = await safeFetch(communeUrl);
  if (cr.ok) {
    const c = cr.data as any;
    const [lon, lat] = c?.centre?.coordinates ?? [];
    if (lat && lon) {
      return { lat, lng: lon, code_insee: communeCode };
    }
  }

  return null;
}

function flattenCoords(coords: any[]): number[][] {
  const out: number[][] = [];
  function walk(c: any) {
    if (
      Array.isArray(c) &&
      c.length >= 2 &&
      typeof c[0] === "number" &&
      typeof c[1] === "number"
    ) {
      out.push(c as number[]);
    } else if (Array.isArray(c)) {
      for (const sub of c) walk(sub);
    }
  }
  walk(coords);
  return out;
}

function computeCentroid(coords: number[][]): [number, number] {
  let sumX = 0,
    sumY = 0;
  for (const [x, y] of coords) {
    sumX += x;
    sumY += y;
  }
  const n = coords.length;
  return [sumX / n, sumY / n];
}

/** Reverse geocode to get code_insee */
async function reverseGeocode(
  lat: number,
  lng: number
): Promise<string | null> {
  const url = `https://data.geopf.fr/geocodage/reverse?lon=${lng}&lat=${lat}&limit=1`;
  const r = await safeFetch(url);
  if (!r.ok) return null;
  const d = r.data as any;
  const feat = d?.features?.[0];
  return feat?.properties?.citycode ?? feat?.properties?.municipality ?? null;
}

// ---------------------------------------------------------------------------
// STEP 2 + 3: GeoRisques fetches
// ---------------------------------------------------------------------------

async function fetchGasparCatnat(
  codeInsee: string
): Promise<{ events: any[]; count: number }> {
  const url = `${GEORISQUES_BASE}/gaspar/catnat?rayon=1000&code_insee=${codeInsee}&page=1&page_size=50`;
  const r = await safeFetch(url);
  if (!r.ok) return { events: [], count: 0 };
  const d = r.data as any;
  const items = d?.data ?? d?.results ?? [];
  return { events: items, count: items.length };
}

async function fetchGasparRisques(
  codeInsee: string
): Promise<{ risques: any[] }> {
  const url = `${GEORISQUES_BASE}/gaspar/risques?code_insee=${codeInsee}&page=1&page_size=50`;
  const r = await safeFetch(url);
  if (!r.ok) return { risques: [] };
  const d = r.data as any;
  return { risques: d?.data ?? d?.results ?? [] };
}

async function fetchGasparPpr(
  codeInsee: string
): Promise<{ pprs: any[]; count: number }> {
  const url = `${GEORISQUES_BASE}/gaspar/ppr?code_insee=${codeInsee}&page=1&page_size=50`;
  const r = await safeFetch(url);
  if (!r.ok) return { pprs: [], count: 0 };
  const d = r.data as any;
  const items = d?.data ?? d?.results ?? [];
  return { pprs: items, count: items.length };
}

async function fetchRadon(
  codeInsee: string
): Promise<{ classe: number | null; libelle: string }> {
  const url = `${GEORISQUES_BASE}/radon?code_insee=${codeInsee}&page=1&page_size=10`;
  const r = await safeFetch(url);
  if (!r.ok) return { classe: null, libelle: "Indisponible" };
  const d = r.data as any;
  const items = d?.data ?? d?.results ?? [];
  const first = items[0];
  if (!first) return { classe: null, libelle: "Non renseigné" };
  const classe = first.classe_potentiel ?? first.classe ?? null;
  const libelle =
    classe === 1
      ? "Faible"
      : classe === 2
      ? "Moyen"
      : classe === 3
      ? "Élevé"
      : "Non renseigné";
  return { classe, libelle };
}

async function fetchArgiles(
  lat: number,
  lng: number
): Promise<{ niveau: string | null; level: RiskLevel }> {
  const url = `${GEORISQUES_BASE}/argiles?lon=${lng}&lat=${lat}`;
  const r = await safeFetch(url);
  if (!r.ok) return { niveau: null, level: "inconnu" };
  const d = r.data as any;
  const items = Array.isArray(d) ? d : d?.data ?? [];
  const first = items[0];
  if (!first) return { niveau: null, level: "non_concerne" };
  const niveau =
    first.niveau_alea ?? first.exposition ?? first.niveau ?? null;
  let level: RiskLevel = "inconnu";
  if (typeof niveau === "string") {
    const n = niveau.toLowerCase();
    if (n.includes("fort")) level = "fort";
    else if (n.includes("moyen")) level = "moyen";
    else if (n.includes("faible") || n.includes("a priori")) level = "faible";
    else level = "moyen";
  }
  return { niveau, level };
}

async function fetchIcpe(
  lat: number,
  lng: number,
  rayon: number
): Promise<{
  count: number;
  seveso_haut: number;
  seveso_bas: number;
  installations: any[];
}> {
  const url = `${GEORISQUES_BASE}/installations_classees?lon=${lng}&lat=${lat}&rayon=${rayon}&page=1&page_size=50`;
  const r = await safeFetch(url);
  if (!r.ok) return { count: 0, seveso_haut: 0, seveso_bas: 0, installations: [] };
  const d = r.data as any;
  const items = d?.data ?? d?.results ?? [];
  let seveso_haut = 0;
  let seveso_bas = 0;
  for (const inst of items) {
    const s = (inst.seveso ?? inst.statut_seveso ?? "").toLowerCase();
    if (s.includes("haut")) seveso_haut++;
    else if (s.includes("bas") || s.includes("seuil")) seveso_bas++;
  }
  return { count: items.length, seveso_haut, seveso_bas, installations: items };
}

async function fetchSis(
  lat: number,
  lng: number,
  rayon: number
): Promise<{ count: number; sites: any[] }> {
  const url = `${GEORISQUES_BASE}/sis?lon=${lng}&lat=${lat}&rayon=${rayon}&page=1&page_size=50`;
  const r = await safeFetch(url);
  if (!r.ok) return { count: 0, sites: [] };
  const d = r.data as any;
  const items = d?.data ?? d?.results ?? [];
  return { count: items.length, sites: items };
}

async function fetchCavites(
  lat: number,
  lng: number,
  rayon: number
): Promise<{ count: number; cavites: any[] }> {
  const url = `${GEORISQUES_BASE}/cavites?lon=${lng}&lat=${lat}&rayon=${rayon}&page=1&page_size=50`;
  const r = await safeFetch(url);
  if (!r.ok) return { count: 0, cavites: [] };
  const d = r.data as any;
  const items = d?.data ?? d?.results ?? [];
  return { count: items.length, cavites: items };
}

async function fetchMvt(
  lat: number,
  lng: number,
  rayon: number
): Promise<{ count: number; mouvements: any[] }> {
  const url = `${GEORISQUES_BASE}/mvt?lon=${lng}&lat=${lat}&rayon=${rayon}&page=1&page_size=50`;
  const r = await safeFetch(url);
  if (!r.ok) return { count: 0, mouvements: [] };
  const d = r.data as any;
  const items = d?.data ?? d?.results ?? [];
  return { count: items.length, mouvements: items };
}

async function fetchZonageSismique(
  codeInsee: string
): Promise<{ zone: number | null; libelle: string }> {
  const url = `${GEORISQUES_BASE}/zonage_sismique?code_insee=${codeInsee}`;
  const r = await safeFetch(url);
  if (!r.ok) return { zone: null, libelle: "Indisponible" };
  const d = r.data as any;
  const items = Array.isArray(d) ? d : d?.data ?? [];
  const first = items[0];
  if (!first) return { zone: null, libelle: "Non renseigné" };
  return {
    zone: first.code_zone ?? first.zone ?? null,
    libelle: first.libelle ?? `Zone ${first.code_zone ?? "?"}`,
  };
}

// ---------------------------------------------------------------------------
// STEP 4: SCORING (inline — copied from banque-risques-v1 scoreRisksV1)
// ---------------------------------------------------------------------------

const LEVEL_PENALTY: Record<RiskLevel, number> = {
  fort: -20,
  moyen: -10,
  faible: -3,
  inconnu: -2,
  non_concerne: 0,
};

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

function levelToSeverity(
  level: RiskLevel
): "low" | "moderate" | "high" | "critical" | "unknown" {
  switch (level) {
    case "fort":
      return "critical";
    case "moyen":
      return "high";
    case "faible":
      return "low";
    case "non_concerne":
      return "low";
    case "inconnu":
    default:
      return "unknown";
  }
}

function scoreGrade(score: number): "A" | "B" | "C" | "D" | "E" {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "E";
}

function scoreLevelLabel(grade: string): string {
  switch (grade) {
    case "A":
      return "Risque très faible";
    case "B":
      return "Risque faible";
    case "C":
      return "Risque modéré";
    case "D":
      return "Risque élevé";
    case "E":
      return "Risque très élevé";
    default:
      return "Inconnu";
  }
}

function scoreRisksV1(risks: RiskItem[]): RiskScoring {
  let totalImpact = 0;
  let totalWeight = 0;
  let knownCount = 0;

  const scoredItems: RiskScoring["items"] = [];
  const rationale: string[] = [];

  for (const risk of risks) {
    const catalog = RISK_CATALOG[risk.key];
    const weight = catalog?.weight ?? 1;
    const penalty = LEVEL_PENALTY[risk.level] ?? -2;
    const impact = penalty * weight;

    totalImpact += impact;
    totalWeight += weight;

    if (risk.level !== "inconnu") {
      knownCount++;
    }

    scoredItems.push({
      key: risk.key,
      label: risk.label,
      severity: levelToSeverity(risk.level),
      score_impact: Math.round(impact),
      confidence: risk.level === "inconnu" ? 0.3 : 0.9,
    });

    // Build rationale for significant risks
    if (risk.level === "fort") {
      rationale.push(
        `${risk.label} : niveau FORT${
          risk.detail ? ` (${risk.detail})` : ""
        }`
      );
    } else if (risk.level === "moyen") {
      rationale.push(
        `${risk.label} : niveau moyen${
          risk.detail ? ` (${risk.detail})` : ""
        }`
      );
    }
  }

  // Normalize: base = 100, add all weighted impacts
  // Max possible penalty = sum of (weight * -20) for all fort
  const maxPenalty = totalWeight * 20;
  const normalized =
    maxPenalty > 0
      ? clamp(Math.round(100 + (totalImpact / maxPenalty) * 100))
      : 100;

  const score = clamp(normalized);
  const grade = scoreGrade(score);
  const confidence =
    risks.length > 0 ? clamp(knownCount / risks.length, 0, 1) : 0;

  // Add summary rationale
  if (rationale.length === 0) {
    rationale.push("Aucun risque significatif détecté");
  }

  return {
    score,
    grade,
    level_label: scoreLevelLabel(grade),
    confidence: Math.round(confidence * 100) / 100,
    rationale: rationale.slice(0, 5),
    items: scoredItems,
  };
}

// ---------------------------------------------------------------------------
// BUILD RISKS from raw API data
// ---------------------------------------------------------------------------

function buildRisks(data: {
  catnat: { events: any[]; count: number };
  risques: { risques: any[] };
  ppr: { pprs: any[]; count: number };
  radon: { classe: number | null; libelle: string };
  argiles: { niveau: string | null; level: RiskLevel };
  icpe: {
    count: number;
    seveso_haut: number;
    seveso_bas: number;
    installations: any[];
  };
  sis: { count: number; sites: any[] };
  cavites: { count: number; cavites: any[] };
  mvt: { count: number; mouvements: any[] };
  seisme: { zone: number | null; libelle: string };
}): RiskItem[] {
  const risks: RiskItem[] = [];

  // --- Helper: detect GASPAR risque by keyword ---
  const gasparRisques = data.risques.risques;
  const gasparLabels = gasparRisques
    .map((r: any) => (r.libelle_risque_jo ?? r.libelle ?? "").toLowerCase())
    .join("|");

  function gasparHas(...keywords: string[]): boolean {
    return keywords.some((kw) => gasparLabels.includes(kw.toLowerCase()));
  }

  // Count catnat events by type
  const catnatByType = (keyword: string): number =>
    data.catnat.events.filter((e: any) =>
      (e.libelle_risque ?? "").toLowerCase().includes(keyword.toLowerCase())
    ).length;

  // PPR presence
  const hasPprn = data.ppr.pprs.some(
    (p: any) =>
      (p.code_type_ppr ?? p.type ?? "").toLowerCase().includes("n")
  );
  const hasPprt = data.ppr.pprs.some(
    (p: any) =>
      (p.code_type_ppr ?? p.type ?? "").toLowerCase().includes("t")
  );

  // --- FLOOD ---
  {
    const catnatFlood = catnatByType("inondation");
    const gasparFlood = gasparHas("inondation", "submersion", "crue");
    let level: RiskLevel = "non_concerne";
    if (catnatFlood >= 5 || (gasparFlood && hasPprn)) level = "fort";
    else if (catnatFlood >= 2 || gasparFlood) level = "moyen";
    else if (catnatFlood >= 1) level = "faible";
    risks.push({
      key: "flood",
      label: RISK_CATALOG.flood.label,
      level,
      source: "GASPAR/CATNAT",
      detail: `${catnatFlood} arrêtés CATNAT inondation${hasPprn ? ", PPRN actif" : ""}`,
    });
  }

  // --- CLAY SHRINK-SWELL (RGA) ---
  risks.push({
    key: "clay_shrink_swell",
    label: RISK_CATALOG.clay_shrink_swell.label,
    level: data.argiles.level,
    source: "Géorisques Argiles",
    detail: data.argiles.niveau ?? "Non évalué",
  });

  // --- LANDSLIDE ---
  {
    const count = data.mvt.count;
    let level: RiskLevel =
      count >= 5 ? "fort" : count >= 2 ? "moyen" : count >= 1 ? "faible" : "non_concerne";
    risks.push({
      key: "landslide",
      label: RISK_CATALOG.landslide.label,
      level,
      source: "Géorisques MVT",
      detail: `${count} mouvements de terrain recensés`,
    });
  }

  // --- SEISMIC ---
  {
    const zone = data.seisme.zone;
    let level: RiskLevel = "non_concerne";
    if (zone !== null) {
      if (zone >= 4) level = "fort";
      else if (zone === 3) level = "moyen";
      else if (zone === 2) level = "faible";
      else level = "non_concerne";
    }
    risks.push({
      key: "seismic",
      label: RISK_CATALOG.seismic.label,
      level,
      source: "Géorisques Sismique",
      detail: `${data.seisme.libelle} (zone ${zone ?? "?"})`,
    });
  }

  // --- RADON ---
  {
    const classe = data.radon.classe;
    let level: RiskLevel = "inconnu";
    if (classe === 3) level = "fort";
    else if (classe === 2) level = "moyen";
    else if (classe === 1) level = "faible";
    risks.push({
      key: "radon",
      label: RISK_CATALOG.radon.label,
      level,
      source: "Géorisques Radon",
      detail: `Classe ${classe ?? "?"} — ${data.radon.libelle}`,
    });
  }

  // --- AVALANCHE ---
  {
    const hasAva = gasparHas("avalanche");
    const catnatAva = catnatByType("avalanche");
    let level: RiskLevel = "non_concerne";
    if (catnatAva >= 2 || hasAva) level = "moyen";
    else if (catnatAva >= 1) level = "faible";
    risks.push({
      key: "avalanche",
      label: RISK_CATALOG.avalanche.label,
      level,
      source: "GASPAR",
      detail: hasAva ? "Commune exposée" : "Non concerné",
    });
  }

  // --- WILDFIRE ---
  {
    const hasFire = gasparHas("feu", "incendie", "forêt", "foret");
    const catnatFire = catnatByType("feu") + catnatByType("incendie");
    let level: RiskLevel = "non_concerne";
    if (catnatFire >= 2 || hasFire) level = "moyen";
    else if (catnatFire >= 1) level = "faible";
    risks.push({
      key: "wildfire",
      label: RISK_CATALOG.wildfire.label,
      level,
      source: "GASPAR",
      detail: hasFire ? "Commune exposée" : "Non concerné",
    });
  }

  // --- STORM / WIND ---
  {
    const catnatStorm = catnatByType("tempête") + catnatByType("vent");
    let level: RiskLevel = "non_concerne";
    if (catnatStorm >= 5) level = "moyen";
    else if (catnatStorm >= 2) level = "faible";
    risks.push({
      key: "storm_wind",
      label: RISK_CATALOG.storm_wind.label,
      level,
      source: "CATNAT",
      detail: `${catnatStorm} arrêtés tempête/vent`,
    });
  }

  // --- SNOW / ICE ---
  {
    const catnatSnow = catnatByType("neige") + catnatByType("verglas");
    let level: RiskLevel = "non_concerne";
    if (catnatSnow >= 3) level = "moyen";
    else if (catnatSnow >= 1) level = "faible";
    risks.push({
      key: "snow_ice",
      label: RISK_CATALOG.snow_ice.label,
      level,
      source: "CATNAT",
      detail: `${catnatSnow} arrêtés neige/verglas`,
    });
  }

  // --- CYCLONE ---
  {
    const catnatCyc = catnatByType("cyclone") + catnatByType("ouragan");
    let level: RiskLevel = "non_concerne";
    if (catnatCyc >= 2) level = "fort";
    else if (catnatCyc >= 1) level = "moyen";
    risks.push({
      key: "cyclone",
      label: RISK_CATALOG.cyclone.label,
      level,
      source: "CATNAT",
      detail: `${catnatCyc} arrêtés cyclone`,
    });
  }

  // --- INDUSTRIAL / ICPE / SEVESO ---
  {
    let level: RiskLevel = "non_concerne";
    if (data.icpe.seveso_haut > 0) level = "fort";
    else if (data.icpe.seveso_bas > 0) level = "moyen";
    else if (data.icpe.count > 0) level = "faible";
    risks.push({
      key: "industrial_tech",
      label: RISK_CATALOG.industrial_tech.label,
      level,
      source: "Géorisques ICPE",
      detail: `${data.icpe.count} ICPE (${data.icpe.seveso_haut} SEVESO haut, ${data.icpe.seveso_bas} SEVESO bas)`,
    });
  }

  // --- DANGEROUS GOODS TRANSPORT ---
  {
    const hasTmd = gasparHas(
      "transport",
      "matières dangereuses",
      "matieres dangereuses",
      "TMD"
    );
    risks.push({
      key: "dangerous_goods_transport",
      label: RISK_CATALOG.dangerous_goods_transport.label,
      level: hasTmd ? "moyen" : "non_concerne",
      source: "GASPAR",
      detail: hasTmd ? "Commune exposée TMD" : "Non concerné",
    });
  }

  // --- POLLUTED SOIL (SIS) ---
  {
    let level: RiskLevel = "non_concerne";
    if (data.sis.count >= 3) level = "fort";
    else if (data.sis.count >= 1) level = "moyen";
    risks.push({
      key: "polluted_soil",
      label: RISK_CATALOG.polluted_soil.label,
      level,
      source: "Géorisques SIS",
      detail: `${data.sis.count} sites pollués identifiés`,
    });
  }

  // --- COASTAL EROSION ---
  {
    const hasCoast = gasparHas("littoral", "érosion", "erosion", "submersion marine");
    const catnatCoast = catnatByType("submersion") + catnatByType("littoral");
    let level: RiskLevel = "non_concerne";
    if (catnatCoast >= 2 || hasCoast) level = "moyen";
    else if (catnatCoast >= 1) level = "faible";
    risks.push({
      key: "coastal_erosion",
      label: RISK_CATALOG.coastal_erosion.label,
      level,
      source: "GASPAR/CATNAT",
      detail: hasCoast ? "Commune littorale exposée" : "Non concerné",
    });
  }

  // --- MINING / CAVITIES ---
  {
    let level: RiskLevel = "non_concerne";
    const hasMining = gasparHas("minier", "mine", "carrière", "carriere");
    if (data.cavites.count >= 5 || hasMining) level = "fort";
    else if (data.cavites.count >= 2) level = "moyen";
    else if (data.cavites.count >= 1) level = "faible";
    risks.push({
      key: "mining",
      label: RISK_CATALOG.mining.label,
      level,
      source: "Géorisques Cavités + GASPAR",
      detail: `${data.cavites.count} cavités${hasMining ? " + risque minier GASPAR" : ""}`,
    });
  }

  // --- VOLCANIC ---
  {
    const hasVolc = gasparHas("volcan", "éruption", "eruption");
    risks.push({
      key: "volcanic",
      label: RISK_CATALOG.volcanic.label,
      level: hasVolc ? "moyen" : "non_concerne",
      source: "GASPAR",
      detail: hasVolc ? "Commune exposée" : "Non concerné",
    });
  }

  return risks;
}

// ---------------------------------------------------------------------------
// STEP 5: CACHE (optional Supabase RPC)
// ---------------------------------------------------------------------------

interface SupabaseClient {
  url: string;
  key: string;
}

function getSupabaseClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return { url, key };
}

async function cacheGet(
  sb: SupabaseClient,
  provider: string,
  cacheKey: string
): Promise<unknown | null> {
  try {
    const resp = await fetch(`${sb.url}/rest/v1/rpc/api_cache_get`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sb.key}`,
        apikey: sb.key,
      },
      body: JSON.stringify({ p_provider: provider, p_key: cacheKey }),
    });
    if (!resp.ok) return null;
    const d = await resp.json();
    // RPC returns the cached value or null
    if (d && typeof d === "object" && d !== null) {
      // May return { data: ... } or directly the cached JSON
      return (d as any).data ?? d;
    }
    return d ?? null;
  } catch {
    return null;
  }
}

async function cachePut(
  sb: SupabaseClient,
  provider: string,
  cacheKey: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  try {
    await fetch(`${sb.url}/rest/v1/rpc/api_cache_put`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sb.key}`,
        apikey: sb.key,
      },
      body: JSON.stringify({
        p_provider: provider,
        p_key: cacheKey,
        p_value: value,
        p_ttl_seconds: ttlSeconds,
      }),
    });
  } catch (e) {
    logErr("cache_put failed (non-blocking)", e);
  }
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------

serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== "POST") {
    return errJson("Method not allowed. Use POST.", 405);
  }

  const startMs = Date.now();

  try {
    // Parse input
    let body: Input;
    try {
      body = await req.json();
    } catch {
      return errJson("Invalid JSON body", 400);
    }

    const debug = body.debug === true;
    const rayon_m = body.rayon_m ?? 1000;
    const ttl_seconds = body.ttl_seconds ?? 86400;

    if (debug) log("Input", body);

    // -----------------------------------------------------------------------
    // STEP 1: Resolve lat/lng + code_insee
    // -----------------------------------------------------------------------
    let lat: number | undefined = body.lat;
    let lng: number | undefined = body.lng;
    let code_insee: string | undefined;
    let resolved_adresse: string | undefined = body.adresse;
    let resolved_parcel: string | undefined = body.parcel_id;

    if (body.adresse && (!lat || !lng)) {
      // Geocode from address
      if (debug) log("Geocoding address", body.adresse);
      const geo = await geocodeAddress(body.adresse);
      if (!geo) {
        return errJson(
          `Impossible de géocoder l'adresse : "${body.adresse}"`,
          422
        );
      }
      lat = geo.lat;
      lng = geo.lng;
      code_insee = geo.code_insee;
      if (debug) log("Geocoded", { lat, lng, code_insee });
    } else if (body.parcel_id && (!lat || !lng)) {
      // Resolve from parcel
      if (debug) log("Resolving parcel", body.parcel_id);
      const parcel = await resolveParcel(body.parcel_id);
      if (!parcel) {
        return errJson(
          `Impossible de résoudre la parcelle : "${body.parcel_id}"`,
          422
        );
      }
      lat = parcel.lat;
      lng = parcel.lng;
      code_insee = parcel.code_insee;
      if (debug) log("Parcel resolved", { lat, lng, code_insee });
    }

    if (!lat || !lng) {
      return errJson(
        "Coordonnées manquantes. Fournir lat/lng, adresse, ou parcel_id.",
        400
      );
    }

    // Reverse geocode for code_insee if missing
    if (!code_insee) {
      if (debug) log("Reverse geocoding for code_insee", { lat, lng });
      code_insee = (await reverseGeocode(lat, lng)) ?? undefined;
      if (!code_insee) {
        return errJson(
          "Impossible de déterminer le code INSEE pour ces coordonnées.",
          422
        );
      }
      if (debug) log("Reverse geocoded", { code_insee });
    }

    // -----------------------------------------------------------------------
    // STEP 5a: Check cache
    // -----------------------------------------------------------------------
    const sb = getSupabaseClient();
    const cacheKey = JSON.stringify({
      v: 1,
      lat: Math.round(lat * 100000) / 100000,
      lng: Math.round(lng * 100000) / 100000,
      rayon_m,
      code_insee,
    });
    const CACHE_PROVIDER = "georisques";

    if (sb) {
      if (debug) log("Checking cache", { cacheKey });
      const cached = await cacheGet(sb, CACHE_PROVIDER, cacheKey);
      if (cached && typeof cached === "object") {
        if (debug) log("Cache HIT");
        return json({
          ok: true,
          risks: cached,
          cached: true,
          computed_at: (cached as any)._computed_at ?? new Date().toISOString(),
          input: {
            lat,
            lng,
            rayon_m,
            code_insee,
            adresse: resolved_adresse,
            parcel_id: resolved_parcel,
          },
          duration_ms: Date.now() - startMs,
        });
      }
      if (debug) log("Cache MISS");
    } else {
      if (debug)
        log("Supabase not configured — running without cache");
    }

    // -----------------------------------------------------------------------
    // STEP 2 + 3: Fetch all GeoRisques endpoints in parallel
    // -----------------------------------------------------------------------
    if (debug) log("Fetching GeoRisques APIs", { code_insee, lat, lng, rayon_m });

    const [
      catnat,
      risques,
      ppr,
      radon,
      argiles,
      icpe,
      sis,
      cavites,
      mvt,
      seisme,
    ] = await Promise.all([
      fetchGasparCatnat(code_insee),
      fetchGasparRisques(code_insee),
      fetchGasparPpr(code_insee),
      fetchRadon(code_insee),
      fetchArgiles(lat, lng),
      fetchIcpe(lat, lng, rayon_m),
      fetchSis(lat, lng, rayon_m),
      fetchCavites(lat, lng, rayon_m),
      fetchMvt(lat, lng, rayon_m),
      fetchZonageSismique(code_insee),
    ]);

    if (debug) {
      log("Raw results summary", {
        catnat_count: catnat.count,
        risques_count: risques.risques.length,
        ppr_count: ppr.count,
        radon_classe: radon.classe,
        argiles_level: argiles.level,
        icpe_count: icpe.count,
        sis_count: sis.count,
        cavites_count: cavites.count,
        mvt_count: mvt.count,
        seisme_zone: seisme.zone,
      });
    }

    // -----------------------------------------------------------------------
    // STEP 4: Build risks + scoring
    // -----------------------------------------------------------------------
    const risks = buildRisks({
      catnat,
      risques,
      ppr,
      radon,
      argiles,
      icpe,
      sis,
      cavites,
      mvt,
      seisme,
    });

    const scoring = scoreRisksV1(risks);

    const risksWithScore: RisksWithScore = {
      risks,
      scoring,
      ...(debug
        ? {
            raw: {
              catnat_count: catnat.count,
              risques_gaspar: risques.risques.length,
              ppr_count: ppr.count,
              radon_classe: radon.classe,
              argiles_niveau: argiles.niveau,
              icpe_count: icpe.count,
              icpe_seveso_haut: icpe.seveso_haut,
              icpe_seveso_bas: icpe.seveso_bas,
              sis_count: sis.count,
              cavites_count: cavites.count,
              mvt_count: mvt.count,
              seisme_zone: seisme.zone,
            },
          }
        : {}),
    };

    const computed_at = new Date().toISOString();

    // -----------------------------------------------------------------------
    // STEP 5b: Store in cache
    // -----------------------------------------------------------------------
    if (sb) {
      const toCache = { ...risksWithScore, _computed_at: computed_at };
      // Fire-and-forget — don't block response
      cachePut(sb, CACHE_PROVIDER, cacheKey, toCache, ttl_seconds).catch(
        () => {}
      );
      if (debug) log("Cache PUT dispatched");
    }

    // -----------------------------------------------------------------------
    // STEP 6: Output
    // -----------------------------------------------------------------------
    const result = {
      ok: true,
      risks: risksWithScore,
      cached: false,
      computed_at,
      input: {
        lat,
        lng,
        rayon_m,
        code_insee,
        adresse: resolved_adresse,
        parcel_id: resolved_parcel,
      },
      duration_ms: Date.now() - startMs,
    };

    if (debug) log("Response", { score: scoring.score, grade: scoring.grade });
    return json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    logErr("Unhandled", err);
    return errJson(msg, 500);
  }
});