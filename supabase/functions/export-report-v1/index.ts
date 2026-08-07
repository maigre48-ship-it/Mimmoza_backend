// supabase/functions/export-report-v1/index.ts
// Genere une ANALYSE INVESTISSEUR pour un dossier export Mimmoza
// via Anthropic Claude, basee uniquement sur un objet JSON "context".

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// --- Constants ---------------------------------------------------------------

const PROMPT_VERSION = "investor-report-v2.10-narrative-guaranteed";

const ANALYSIS_REQUIRED_KEYS = [
  "verdict",
  "confidence",
  "executiveSummary",
  "narrativeMarkdown",
  "strengths",
  "vigilances",
  "sensitivities",
  "actionPlan",
  "missingData",
] as const;

const VALID_VERDICTS = ["GO", "GO_AVEC_RESERVES", "NO_GO"] as const;

// --- Wikimedia constants -----------------------------------------------------

const WIKI_UA =
  "Mimmoza/1.0 (contact: support@mimmoza.local; purpose: local-context-enrichment)";
const WIKI_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WIKI_TIMEOUT_MS = 6_000;
const WIKI_MIN_EXTRACT_LENGTH = 60;

// Defaults (petite commune)
const NARRATIVE_MAX_CHARS_DEFAULT  = 600;
const NARRATIVE_MAX_SENTENCES_DEFAULT = 3;
const NARRATIVE_MIN_CHARS_DEFAULT  = 0;

// Grande commune (>= 50 000 habitants)
const NARRATIVE_MAX_CHARS_LARGE    = 600;
const NARRATIVE_MAX_SENTENCES_LARGE = 5;
const NARRATIVE_MIN_CHARS_LARGE    = 220;

const POPULATION_LARGE_THRESHOLD   = 50_000;

const WIKIDATA_QID_COMMUNE_FALLBACK: readonly string[] = [
  "Q484170",
  "Q21869758",
  "Q208511",
  "Q205663",
];

// --- Arrondissements municipaux (Paris, Lyon, Marseille) --------------------

const WIKIDATA_QID_ARRONDISSEMENT: readonly string[] = [
  "Q702842",
  "Q2076984",
  "Q2086742",
  "Q2510537",
];

// Union des QIDs acceptés comme localité française valide
const WIKIDATA_QID_VALID_FR_LOCALITY: readonly string[] = [
  ...WIKIDATA_QID_COMMUNE_FALLBACK,
  ...WIKIDATA_QID_ARRONDISSEMENT,
];

const COMMUNE_TEXT_SIGNALS: readonly string[] = [
  "commune", "municipality", "ville", "habitants",
  "département", "departement", "région", "region",
  "arrondissement", "code insee", "code postal", "chef-lieu",
];

const NOISE_PATTERNS: readonly RegExp[] = [
  /\([^)]{0,120}\)/g,
  /\[[^\]]{0,60}\]/g,
  /={2,}.+?={2,}/g,
  /\b(voir aussi|notes|références|annexes|liens externes)\b.*/gi,
];

const TRANSPORT_KEYWORDS: readonly string[] = [
  "rer", "métro", "metro", "gare", "sncf", "tramway", "tram",
  "autoroute", "a86", "a13", "a14", "a15", "rocade", "transports",
  "bus", "périphérique", "peripherique", "ligne de bus",
];

const ECONOMY_KEYWORDS: readonly string[] = [
  "entreprise", "emploi", "zone d'activit", "zone industrielle",
  "pôle", "pole d'emploi", "économie", "economie",
  "activit", "commerce", "industrie",
];

const AMENITIES_KEYWORDS: readonly string[] = [
  "école", "ecole", "collège", "college", "lycée", "lycee", "crèche", "creche",
  "hôpital", "hopital", "clinique", "médecin", "medecin", "pharmacie",
  "marché", "marche", "supermarché", "supermarche", "commerces", "boulangerie",
  "parc", "jardin", "square", "équipement", "equipement", "bibliothèque", "bibliotheque",
];

const RESIDENTIAL_KEYWORDS: readonly string[] = [
  "résidentiel", "residentiel", "habitat", "logement",
  "immeuble", "appartement", "maison", "quartier",
  "urbain", "dense", "densité", "densite", "lotissement", "copropriété",
];

const STREET_KEYWORDS: readonly string[] = [
  "rue", "avenue", "boulevard", "voie", "axe",
  "artère", "artere", "passage", "allée", "allee", "impasse",
  "commerçante", "commercante", "piétonne", "pietonne",
  "circulation", "trafic", "longe", "relie", "traverse",
];

// --- Nouveaux groupes de mots-clés thématiques --------------------------------

const UNIVERSITY_KEYWORDS: readonly string[] = [
  "université", "universite", "campus", "grande école", "grande ecole",
  "fac ", "faculté", "faculte", "école supérieure", "ecole superieure",
  "iut", "bts", "classe préparatoire", "classe preparatoire",
  "école d'ingénieurs", "ecole ingenieurs", "école de commerce",
  "enseignement supérieur", "enseignement superieur",
];

const HOSPITAL_KEYWORDS: readonly string[] = [
  "hôpital", "hopital", "chu", "chru", "clinique",
  "urgences", "maternité", "maternite", "établissement de santé",
  "etablissement de sante", "centre hospitalier", "médical", "medical",
  "polyclinique", "ehpad", "maison de retraite", "soins",
];

const PARK_KEYWORDS: readonly string[] = [
  "parc", "jardin", "bois", "forêt", "foret",
  "espace vert", "promenade", "coulée verte", "coulee verte",
  "allée arborée", "allee arboree", "aire de jeux",
  "base de loisirs", "plan d'eau",
];

const CULTURE_KEYWORDS: readonly string[] = [
  "musée", "musee", "théâtre", "theatre", "cinéma", "cinema",
  "bibliothèque", "bibliotheque", "médiathèque", "mediatheque",
  "centre culturel", "salle de spectacle", "opéra", "opera",
  "galerie", "exposition", "conservatoire", "maison des arts",
];

const KNOWN_COUNTRY_QIDS: Record<string, string> = {
  "Q142": "France", "Q31": "Belgique", "Q39": "Suisse",
  "Q32": "Luxembourg", "Q183": "Allemagne", "Q29": "Espagne",
};

const DEPT_TYPE_QIDS = new Set([
  "Q6465", "Q202216", "Q22704", "Q833061", "Q164595", "Q868711",
]);

const REGION_TYPE_QIDS = new Set([
  "Q36784", "Q3455524", "Q22890", "Q208511", "Q1907114", "Q22670030",
]);

// Phrases de renommage / historique : filtrées AVANT scoring, sans exception.
const RENAME_HISTORY_SENTENCE_REGEX =
  /jusqu[''`]en\s+\d{3,4}|s[''`]appelait|anciennement\s+(?:appel|nomm)|^[\s\u00a0]*en\s+\d{3,4}[,\s]|^[\s\u00a0]*(?:au|vers|dès)\s+(?:le\s+)?\d{3,4}[,\s]/i;

// --- CORS --------------------------------------------------------------------

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// --- Utility: JSON response --------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function canonicalize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stripCodeFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "");
}

function safeUtf8Fix(text: string): string {
  if (!/[\xC0-\xC3\xC5-\xC8\xCA-\xCF\xD0-\xD7]/.test(text)) return text;
  try {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      if (cp > 0xFF) return text;
      bytes[i] = cp;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return text; }
}

// --- extractFirstJsonObject --------------------------------------------------

function extractFirstJsonObject(raw: string): string | null {
  const stripped = stripCodeFences(raw).trim();
  let depth = 0, start = -1;
  let inString = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (ch === "\\" && i + 1 < stripped.length) { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) return stripped.slice(start, i + 1);
    }
  }
  return null;
}

// --- Wikidata snak/statement helpers -----------------------------------------

interface WbSnakValue {
  amount?: string; time?: string; id?: string;
  latitude?: number; longitude?: number;
  altitude?: number | null; precision?: number; globe?: string;
  text?: string; language?: string;
}
interface WbSnak {
  snaktype?: string; property?: string;
  datavalue?: { value?: WbSnakValue | string | number; type?: string };
}
interface WbStatement {
  mainsnak?: WbSnak;
  qualifiers?: Record<string, WbSnak[]>;
  rank?: string;
}
interface WbEntityDetailed {
  labels?: Record<string, { value?: string }>;
  descriptions?: Record<string, { value?: string }>;
  claims?: Record<string, WbStatement[]>;
}
interface WbGetEntitiesDetailed {
  entities?: Record<string, WbEntityDetailed>;
}

function getStatementQid(stmt: WbStatement | undefined): string | null {
  if (!stmt?.mainsnak || stmt.mainsnak.snaktype !== "value") return null;
  const val = stmt.mainsnak.datavalue?.value;
  if (typeof val === "object" && val !== null && "id" in (val as WbSnakValue)) {
    return (val as WbSnakValue).id ?? null;
  }
  return null;
}

function getStatementAmount(stmt: WbStatement | undefined): number | null {
  if (!stmt?.mainsnak || stmt.mainsnak.snaktype !== "value") return null;
  const val = stmt.mainsnak.datavalue?.value;
  if (typeof val === "object" && val !== null && "amount" in (val as WbSnakValue)) {
    const amt = (val as WbSnakValue).amount;
    if (typeof amt === "string") {
      const n = parseInt(amt.replace(/^\+/, ""), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return null;
}

function getQualifierTime(stmt: WbStatement, propId: string): number | null {
  const qualSnaks = stmt.qualifiers?.[propId] ?? [];
  if (qualSnaks.length === 0) return null;
  const val = qualSnaks[0]?.datavalue?.value;
  if (typeof val === "object" && val !== null && "time" in (val as WbSnakValue)) {
    const t = (val as WbSnakValue).time;
    if (typeof t === "string") {
      const m = t.match(/\+(\d{4})/);
      return m ? parseInt(m[1], 10) : null;
    }
  }
  return null;
}

function extractBestPopulation(
  statements: WbStatement[],
): { amount: number; year: number | null } | null {
  const active = statements.filter((s) => s.rank !== "deprecated");
  const preferred = active.filter((s) => s.rank === "preferred");
  const pool = preferred.length > 0 ? preferred : active;
  let best: { amount: number; year: number | null } | null = null;
  let bestYear = -Infinity;
  for (const stmt of pool) {
    const amount = getStatementAmount(stmt);
    if (amount === null) continue;
    const year = getQualifierTime(stmt, "P585");
    const effectiveYear = year ?? 0;
    if (!best || effectiveYear > bestYear) { best = { amount, year }; bestYear = effectiveYear; }
  }
  return best;
}

function extractCoordinatesFromClaims(
  claims: Record<string, WbStatement[]>,
): { lat: number; lng: number } | null {
  const p625 = claims["P625"] ?? [];
  if (p625.length === 0) return null;
  const snak = p625[0]?.mainsnak;
  if (!snak || snak.snaktype !== "value") return null;
  const val = snak.datavalue?.value;
  if (typeof val !== "object" || val === null) return null;
  const v = val as WbSnakValue;
  if (typeof v.latitude !== "number" || typeof v.longitude !== "number") return null;
  if (!Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) return null;
  return { lat: v.latitude, lng: v.longitude };
}

// --- extractThematicSentence (single) ----------------------------------------

function extractThematicSentence(text: string, keywords: readonly string[]): string | null {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [];
  const normKw = keywords.map((kw) =>
    kw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  );
  for (const s of sentences) {
    if (RENAME_HISTORY_SENTENCE_REGEX.test(s)) continue;
    const lower = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (normKw.some((kw) => lower.includes(kw))) return s.trim();
  }
  return null;
}

// --- extractThematicSentences (plural) ----------------------------------------

function extractThematicSentences(
  text: string,
  keywords: readonly string[],
  maxCount = 2,
): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [];
  const normKw = keywords.map((kw) =>
    kw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  );
  const result: string[] = [];
  for (const s of sentences) {
    if (result.length >= maxCount) break;
    if (RENAME_HISTORY_SENTENCE_REGEX.test(s)) continue;
    const lower = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (normKw.some((kw) => lower.includes(kw))) result.push(s.trim());
  }
  return result;
}

// --- Wikimedia types ---------------------------------------------------------

export interface WikimediaProfile {
  population: number | null;
  populationYear: number | null;
  country: string | null;
  department: string | null;
  region: string | null;
  adminSummary: string | null;
  transportSummary: string | null;
  economySummary: string | null;
  amenitiesSummary: string | null;
  residentialSummary: string | null;
  streetSummary: string | null;
  universitySummary: string | null;
  hospitalSummary: string | null;
  parkSummary: string | null;
  cultureSummary: string | null;
  transportSentences: string[];
  economySentences: string[];
  amenitiesSentences: string[];
  parkSentences: string[];
  cultureSentences: string[];
  coordinates: { lat: number; lng: number } | null;
  sources: { wikidata: string; wikipedia?: string };
}

export interface WikimediaBlock {
  place: {
    query: { city: string; zipCode: string | null };
    narrative: string | null;
    context: { short: string | null; long: string | null };
    profile: WikimediaProfile | null;
    source: "wikipedia" | "wikidata" | null;
    title: string | null;
    qid: string | null;
  };
  sources: { wikipediaUrl?: string; wikidataUrl?: string };
  quality: { ok: boolean; reason?: string };
}

// --- Cache infrastructure ----------------------------------------------------

interface WikiCacheEntry<T> { value: T; expiresAt: number }
function makeCache<T>(): Map<string, WikiCacheEntry<T>> { return new Map(); }
function cacheGet<T>(cache: Map<string, WikiCacheEntry<T>>, key: string): { hit: true; value: T } | { hit: false } {
  const entry = cache.get(key);
  if (!entry) return { hit: false };
  if (Date.now() > entry.expiresAt) { cache.delete(key); return { hit: false }; }
  return { hit: true, value: entry.value };
}
function cacheSet<T>(cache: Map<string, WikiCacheEntry<T>>, key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + WIKI_CACHE_TTL_MS });
}

const wpExtractCache        = makeCache<{ extract: string; title: string; qid: string | null; url: string } | null>();
const wpStreetExtractCache  = makeCache<{ extract: string; title: string; url: string } | null>();
const wpQuartierExtractCache = makeCache<{ extract: string; title: string; url: string } | null>();
const wdP31Cache            = makeCache<boolean>();
const wdFallbackCache       = makeCache<{ narrative: string; qid: string; deptLabel: string | null; regionLabel: string | null } | null>();
const wdProfileCache        = makeCache<WikimediaProfile | null>();

// --- wikiFetch ---------------------------------------------------------------

async function wikiFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WIKI_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": WIKI_UA, "Accept": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return resp;
  } catch (err) { clearTimeout(timer); throw err; }
}

// --- Text utilities ----------------------------------------------------------

function normalizeStr(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function hasTextSignalCommune(text: string): boolean {
  const n = normalizeStr(text);
  return COMMUNE_TEXT_SIGNALS.some((sig) => n.includes(normalizeStr(sig)));
}
function cleanWikipediaExtract(raw: string): string {
  let text = raw;
  for (const pattern of NOISE_PATTERNS) text = text.replace(pattern, "");
  return text.replace(/\s{2,}/g, " ").trim();
}

// --- scoreSentence -----------------------------------------------------------

const GEO_SIGNALS: readonly string[] = [
  "commune", "ville", "municipality", "arrondissement", "departement", "department",
  "region", "chef-lieu", "sous-prefecture", "prefecture",
  "ile-de-france", "hauts-de-seine", "seine", "val-de-marne",
  "nord", "sud", "est", "ouest", "centre",
  "habitants", "population", "insee", "postal",
  "metro", "rer", "tramway", "transports", "gare", "sncf",
  "autoroute", "rocade", "peripherique",
  "kilometre", "km", "situe", "localise", "borde", "limitrophe",
];
const HIST_SIGNALS: readonly string[] = [
  "siecle", "moyen", "medieval", "romain", "gaulois",
  "fonde", "cree", "etabli",
  "chevalier", "seigneur", "chatelain", "abbaye", "prieure",
  "revolution", "guerre", "bataille", "invasion",
  "antiquite", "prehistoire", "neolithique",
  "etymolog", "toponyme", "nom vient",
  "jusqu'en", "jusqu'au", "autrefois", "jadis", "anciennement",
];
function scoreSentence(s: string): number {
  const lower = s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  let score = 0;
  for (const sig of GEO_SIGNALS) if (lower.includes(sig)) score += 2;
  for (const sig of HIST_SIGNALS) if (lower.includes(sig)) score -= 3;
  if (/^(jusqu|en \d{3,4}|au [ivxlc]+e|des le|depuis le \d|au moyen)/i.test(s.trim())) score -= 5;
  return score;
}

// suppress unused warning
const _scoreSentenceRef = scoreSentence;
void _scoreSentenceRef;

// --- NarrativeOptions --------------------------------------------------------

interface NarrativeOptions {
  maxSentences: number;
  minChars: number;
  maxChars: number;
}

function narrativeOptionsForPopulation(population: number | null): NarrativeOptions {
  if (population !== null && population >= POPULATION_LARGE_THRESHOLD) {
    return {
      maxSentences: NARRATIVE_MAX_SENTENCES_LARGE,
      minChars: NARRATIVE_MIN_CHARS_LARGE,
      maxChars: NARRATIVE_MAX_CHARS_LARGE,
    };
  }
  return {
    maxSentences: NARRATIVE_MAX_SENTENCES_DEFAULT,
    minChars: NARRATIVE_MIN_CHARS_DEFAULT,
    maxChars: NARRATIVE_MAX_CHARS_DEFAULT,
  };
}

// --- formatCommuneNarrative --------------------------------------------------

function formatCommuneNarrative(
  text: string,
  options: NarrativeOptions = {
    maxSentences: NARRATIVE_MAX_SENTENCES_DEFAULT,
    minChars: NARRATIVE_MIN_CHARS_DEFAULT,
    maxChars: NARRATIVE_MAX_CHARS_DEFAULT,
  },
): string {
  const { maxSentences, maxChars } = options;
  const cleaned = cleanWikipediaExtract(text);
  const rawSentences = cleaned.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [cleaned];

  const sentences = rawSentences.filter((s) => !RENAME_HISTORY_SENTENCE_REGEX.test(s));

  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const goodSignals = [
    "commune", "departement", "département", "region", "région",
    "ile-de-france", "île-de-france", "hauts-de-seine",
    "situ", "proxim", "paris", "ouest", "est", "nord", "sud",
    "seine", "transports", "gare", "rer", "metro", "métro",
    "habitants", "population", "prefecture", "préfecture",
    "sous-prefecture", "chef-lieu", "limitrophe",
    "arrondissement",
  ];
  const badSignals = [
    "jusqu'en", "jusqu'au", "anciennement", "s'appelait",
    "au moyen age", "au moyen âge",
    "xixe", "xviiie", "xviie", "xvie", "xve", "xive",
    "fondée", "fondee", "fondation",
    "étymolog", "etymolog",
    "siecle", "siècle", "révolution", "revolution", "guerre", "bataille",
  ];

  type Scored = { s: string; score: number; idx: number };
  const scored: Scored[] = sentences
    .map((raw, idx) => ({ s: raw.trim(), idx }))
    .filter((x) => x.s.length > 0)
    .map(({ s, idx }) => {
      const n = norm(s);
      let score = 0;
      for (const g of goodSignals) if (n.includes(g)) score += 3;
      for (const b of badSignals) if (n.includes(b)) score -= 6;
      if (n.includes("commune")) score += 3;
      if (/^(jusqu|en \d{3,4}|au [ivxlc]+e|des le|depuis le \d|au moyen|il y a|autrefois|jadis)/i.test(s.trim())) {
        score -= 8;
      }
      return { s, score, idx };
    });

  const positiveCount = scored.filter((x) => x.score >= 0).length;
  const filtered = positiveCount >= 2 ? scored.filter((x) => x.score >= 0) : scored;

  const picked = filtered
    .slice()
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .slice(0, maxSentences)
    .sort((a, b) => a.idx - b.idx);

  let result = "";
  let count = 0;
  for (const p of picked) {
    if (count >= maxSentences) break;
    const candidate = result ? `${result} ${p.s}` : p.s;
    if (candidate.length > maxChars) break;
    result = candidate;
    count++;
    if (maxSentences <= 3 && count >= 2 && result.length >= 220) break;
  }

  if (!result.trim()) {
    let fallback = "";
    let c = 0;
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s || RENAME_HISTORY_SENTENCE_REGEX.test(s)) continue;
      const candidate = fallback ? `${fallback} ${s}` : s;
      if (candidate.length > maxChars) break;
      fallback = candidate;
      c++;
      if (c >= maxSentences) break;
    }
    return fallback.trim();
  }
  return result.trim();
}

// --- buildNarrativeFromParts -------------------------------------------------

function buildNarrativeFromParts(
  parts: string[],
  maxSentences: number,
  maxChars: number,
): string {
  const allSentences: string[] = [];
  for (const part of parts) {
    const sentences = part.match(/[^.!?]+[.!?]+(?:\s|$)/g) ??
      (part.trim() ? [part.trim()] : []);
    for (const s of sentences) {
      const t = s.trim();
      if (t.length > 10 && !RENAME_HISTORY_SENTENCE_REGEX.test(t)) allSentences.push(t);
    }
  }
  const seenKeys = new Set<string>();
  const deduped: string[] = [];
  for (const s of allSentences) {
    const key = s.toLowerCase().replace(/\s+/g, " ").slice(0, 45);
    if (!seenKeys.has(key)) { seenKeys.add(key); deduped.push(s); }
  }
  let result = "";
  let count = 0;
  for (const s of deduped) {
    if (count >= maxSentences) break;
    const candidate = result ? `${result} ${s}` : s;
    if (candidate.length > maxChars) break;
    result = candidate;
    count++;
  }
  return result.trim();
}

// --- Real-estate narrative helpers -------------------------------------------

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [text])
    .map((s) => s.trim())
    .filter(Boolean);
}

function dedupeSentences(sentences: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sentences) {
    const key = normalizeStr(s).replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function isLowValueGeoSentence(sentence: string): boolean {
  const s = normalizeStr(sentence).replace(/\s+/g, " ").replace(/[.!?,;:]/g, "");

  if (s.includes("touche au nord")) return true;
  if (s.includes("touche au sud")) return true;
  if (s.includes("touche a l est")) return true;
  if (s.includes("touche a l ouest")) return true;
  if (s.includes("limitrophe")) return true;
  if (s.includes("est l un des vingt arrondissements")) return true;
  if (s.includes("rive gauche de la seine")) return true;
  if (s.includes("rive droite de la seine")) return true;

  if (s.includes("est une rue du sud de paris")) return true;
  if (s.includes("est une rue du nord de paris")) return true;
  if (s.includes("est une rue de paris")) return true;
  if (s.includes("parcourt le") && s.includes("arrondissement")) return true;
  if (s.includes("sur toute sa longueur")) return true;
  if (/\d[\s\u00a0]?\d{3}\s*m[eè]tres?/.test(s)) return true;
  if (/\d+[,.]?\d*\s*km\b/.test(s)) return true;
  if (s.includes("quartier administratif")) return true;
  if (
    s.includes("est situe dans le") &&
    s.includes("arrondissement") &&
    !s.includes("departement") &&
    !s.includes("region") &&
    !s.includes("population") &&
    !s.includes("habitants") &&
    s.length < 100
  ) return true;

  if (s.includes("evolution recente du marche")) return true;
  if (s.includes("a confirmer via les donnees dvf")) return true;
  if (s.includes("confirmer via dvf")) return true;
  if (s.includes("donnees dvf")) return true;
  if (s.includes("marche local est a confirmer")) return true;

  // ── Phrases encyclopédiques de tracé de rue ──────────────────────────────
  if (s.includes("son trace est parallele")) return true;
  if (/parallele.{0,30}(boulevard|avenue|rue)/.test(s)) return true;
  if (/prolongee.{0,30}(est|ouest|nord|sud)/.test(s)) return true;
  if (s.includes("a hauteur de")) return true;
  if (s.includes("franchit la rue")) return true;
  if (s.includes("sous un pont")) return true;
  if (s.includes("sous une passerelle")) return true;
  if (s.includes("pont ferroviaire")) return true;
  if (s.includes("pont de la ligne")) return true;
  if (s.includes("coulee verte") && s.includes("entre le")) return true;
  if (/coupe l.{0,5}avenue|coupe l.{0,5}rue/.test(s)) return true;
  if (s.includes("bordee d arbres") && s.includes("prolongee")) return true;

  return false;
}

function dedupeStrong(sentences: string[]): string[] {
  const seen = new Set<string>();
  const out:  string[] = [];
  for (const s of sentences) {
    const key = normalizeStr(s)
      .replace(/\s+/g, " ")
      .replace(/[.!?,;:\s]+$/, "")
      .trim();
    if (!key || seen.has(key)) continue;
    const prefix = key.slice(0, 55);
    const isDuplPrefix = [...seen].some((k) => k.slice(0, 55) === prefix);
    if (isDuplPrefix) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function isUsefulRealEstateSentence(sentence: string): boolean {
  const s = normalizeStr(sentence);
  const usefulSignals = [
    "commune", "arrondissement", "population", "habitants",
    "transports", "metro", "rer", "gare", "tram",
    "commerce", "commerces", "ecole", "ecoles",
    "sante", "hopital", "quartier", "residentiel",
    "urbain", "dens", "dense", "activite", "emploi",
    "centre", "paris",
  ];
  return usefulSignals.some((sig) => s.includes(sig));
}

function buildRealEstateNarrative(
  rawNarrative: string | null,
  profile: WikimediaProfile | null,
  cityLabel: string,
): string | null {
  const base = safeUtf8Fix((rawNarrative ?? "").trim());
  const sentences = dedupeSentences(splitSentences(base));

  const kept = sentences.filter((s) => {
    if (RENAME_HISTORY_SENTENCE_REGEX.test(s)) return false;
    if (isLowValueGeoSentence(s)) return false;
    if (!isUsefulRealEstateSentence(s) && s.length < 70) return false;
    return true;
  });

  const parts: string[] = [];
  const city = cityLabel.trim();

  if (profile?.department && profile?.region) {
    if (/arrondissement/i.test(city)) {
      parts.push(
        `${city} est situé dans la ville de Paris, au sein du département de Paris et de la région Île-de-France.`,
      );
    } else {
      parts.push(
        `${city} se situe dans le département ${profile.department}, en région ${profile.region}.`,
      );
    }
  } else if (profile?.department) {
    parts.push(`${city} se situe dans le département ${profile.department}.`);
  }

  if (profile?.population != null) {
    const pop  = profile.population.toLocaleString("fr-FR");
    const year = profile.populationYear ? ` (recensement ${profile.populationYear})` : "";
    parts.push(`${city} compte environ ${pop} habitants${year}.`);
  }

  for (const s of kept.slice(0, 2)) {
    parts.push(s);
  }

  if (profile?.transportSummary) {
    parts.push(profile.transportSummary);
  }

  const normalizedCityKey = normalizeStr(city);
  const densitySignal =
    (profile?.population ?? 0) >= 50_000 ||
    normalizedCityKey.includes("paris") ||
    normalizedCityKey.includes("lyon") ||
    normalizedCityKey.includes("marseille");

  if (densitySignal) {
    parts.push(
      "Dans une logique immobilière, ce type de secteur dense et bien desservi soutient généralement la demande locative et contribue à la liquidité à la revente.",
    );
  } else {
    parts.push(
      "Dans une logique immobilière, l'attractivité locale, les services de proximité et l'accessibilité constituent des facteurs importants de demande et de liquidité.",
    );
  }

  const cleaned = dedupeSentences(parts)
    .filter((s) => !isLowValueGeoSentence(s))
    .join(" ")
    .trim();

  return cleaned.length >= 80 ? cleaned : null;
}

// --- RichLocalContext --------------------------------------------------------

interface RichLocalContext {
  short: string | null;
  long: string | null;
}

function buildRichLocalContext(
  profile: WikimediaProfile | null,
  cityLabel: string,
  streetExtract: string | null,
  wpExtractRaw: string | null,
): RichLocalContext {
  const city     = cityLabel.trim();
  const normCity = normalizeStr(city);
  const isDense  =
    (profile?.population ?? 0) >= POPULATION_LARGE_THRESHOLD ||
    normCity.includes("paris") ||
    normCity.includes("lyon") ||
    normCity.includes("marseille");
  const isParis  = normCity.includes("paris");

  const globalUsed = new Set<string>();

  function globalKey(s: string): string {
    return normalizeStr(s)
      .replace(/\s+/g, " ")
      .replace(/[.!?,;:\s]+$/, "")
      .trim()
      .slice(0, 60);
  }
  function globalAdd(s: string): void { globalUsed.add(globalKey(s)); }
  function globalHas(s: string): boolean {
    const k = globalKey(s);
    if (globalUsed.has(k)) return true;
    for (const u of globalUsed) { if (u.slice(0, 50) === k.slice(0, 50)) return true; }
    return false;
  }

  const getThematicSentences = (
    profileField:     string | null,
    profileSentences: string[],
    keywords:         readonly string[],
    maxCount = 1,
    sourceText: string | null = wpExtractRaw,
  ): string[] => {
    const candidates: string[] = [];
    if (profileField) candidates.push(profileField);
    for (const s of profileSentences) {
      if (!candidates.some((x) => normalizeStr(x).slice(0, 40) === normalizeStr(s).slice(0, 40))) {
        candidates.push(s);
      }
    }
    if (candidates.length < maxCount && sourceText) {
      const live = extractThematicSentences(sourceText, keywords, maxCount);
      for (const s of live) {
        if (candidates.length >= maxCount) break;
        if (!candidates.some((x) => normalizeStr(x).slice(0, 40) === normalizeStr(s).slice(0, 40))) {
          candidates.push(safeUtf8Fix(s));
        }
      }
    }
    const out: string[] = [];
    for (const s of candidates) {
      if (out.length >= maxCount) break;
      if (isLowValueGeoSentence(s)) continue;
      if (globalHas(s)) continue;
      out.push(s);
    }
    return out;
  };

  // P1 — Portrait urbain
  const p1Raw: string[] = [];

  const pop     = profile?.population != null
    ? profile.population.toLocaleString("fr-FR") : null;
  const popYear = profile?.populationYear
    ? ` (${profile.populationYear})` : "";

  if (/arrondissement/i.test(city)) {
    if (pop) {
      p1Raw.push(
        `${city} est un arrondissement parisien d'environ ${pop} habitants${popYear}, situé en Île-de-France.`,
      );
    } else {
      p1Raw.push(`${city} est un arrondissement de Paris, en Île-de-France.`);
    }
  } else if (profile?.department && profile?.region) {
    if (pop) {
      p1Raw.push(
        `${city} est une commune de ${pop} habitants${popYear}, dans le département ${profile.department} en région ${profile.region}.`,
      );
    } else {
      p1Raw.push(
        `${city} est une commune du département ${profile.department}, en région ${profile.region}.`,
      );
    }
  } else if (profile?.department) {
    p1Raw.push(
      pop
        ? `${city} compte environ ${pop} habitants${popYear}, dans le département ${profile.department}.`
        : `${city} est une commune du département ${profile.department}.`,
    );
  } else {
    p1Raw.push(
      pop ? `${city} est une commune française d'environ ${pop} habitants${popYear}.`
          : `${city} est une commune française.`,
    );
  }

  const residentialSentences = getThematicSentences(
    profile?.residentialSummary ?? null, [], RESIDENTIAL_KEYWORDS, 1,
  );
  p1Raw.push(...residentialSentences);

  const amenitiesSentences = getThematicSentences(
    profile?.amenitiesSummary ?? null,
    profile?.amenitiesSentences ?? [],
    AMENITIES_KEYWORDS,
    1,
  );
  p1Raw.push(...amenitiesSentences);

  if (amenitiesSentences.length === 0) {
    const hospitalSentences = getThematicSentences(
      profile?.hospitalSummary ?? null, [], HOSPITAL_KEYWORDS, 1,
    );
    p1Raw.push(...hospitalSentences);
  }

  const p1Sentences = dedupeStrong(
    p1Raw.filter((s) => !isLowValueGeoSentence(s)),
  ).slice(0, 3);
  for (const s of p1Sentences) globalAdd(s);

  const p1 = p1Sentences.join(" ").trim();

  // P2 — Micro-localisation
  // NOTE: ce paragraphe sera remplacé par la synthèse IA dans resolveWikimedia
  // si buildAILocalContext retourne un résultat. On le construit quand même
  // comme fallback.
  const p2Raw: string[] = [];

  // Intro quartier : 1-2 premières phrases non-filtrées de l'article quartier
  // injectées en tête de P2 avant les signaux thématiques
  if (streetExtract) {
    const quartierIntroSentences = dedupeStrong(
      splitSentences(cleanWikipediaExtract(streetExtract))
        .filter((s) => !RENAME_HISTORY_SENTENCE_REGEX.test(s))
        .filter((s) => !isLowValueGeoSentence(s))
        .filter((s) => !globalHas(s))
        .filter((s) => s.length > 40),
    ).slice(0, 2);
    p2Raw.push(...quartierIntroSentences);
  }

  const transportSentences = getThematicSentences(
    profile?.transportSummary ?? null,
    profile?.transportSentences ?? [],
    TRANSPORT_KEYWORDS,
    2,
  );
  p2Raw.push(...transportSentences);

  const economySentences = getThematicSentences(
    profile?.economySummary ?? null,
    profile?.economySentences ?? [],
    ECONOMY_KEYWORDS,
    1,
  );
  p2Raw.push(...economySentences);

  // STREET_USEFUL_SIGNALS étendu (v2)
  const STREET_USEFUL_SIGNALS = [
    "commerc", "animee", "anime", "pietonne", "marche",
    "artere", "dessert", "relie", "centre", "quartier",
    "arboree", "arbres", "calme", "residentiel", "residentielle",
    "coulee verte", "square", "jardin", "animation",
    "bordee", "borde",
  ];
  const streetUseful = (s: string): boolean => {
    const ns = normalizeStr(s);
    return STREET_USEFUL_SIGNALS.some((sig) => ns.includes(sig));
  };

  if (profile?.streetSummary) {
    const ss = profile.streetSummary;
    if (!isLowValueGeoSentence(ss) && streetUseful(ss) && !globalHas(ss)) {
      p2Raw.push(ss);
    }
  } else if (streetExtract) {
    const streetFromExtract = dedupeStrong(
      splitSentences(cleanWikipediaExtract(streetExtract))
        .filter((s) => !RENAME_HISTORY_SENTENCE_REGEX.test(s))
        .filter((s) => !isLowValueGeoSentence(s))
        .filter((s) => !globalHas(s))
        .filter((s) => streetUseful(s) || s.length > 120),
    ).slice(0, 1);
    p2Raw.push(...streetFromExtract);
  }

  const universitySentences = getThematicSentences(
    profile?.universitySummary ?? null, [], UNIVERSITY_KEYWORDS, 1,
  );
  p2Raw.push(...universitySentences);

  const parkSentences = getThematicSentences(
    profile?.parkSummary ?? null,
    profile?.parkSentences ?? [],
    PARK_KEYWORDS,
    1,
  );
  p2Raw.push(...parkSentences);

  const cultureSentences = getThematicSentences(
    profile?.cultureSummary ?? null,
    profile?.cultureSentences ?? [],
    CULTURE_KEYWORDS,
    1,
  );
  p2Raw.push(...cultureSentences);

  const p2Sentences = dedupeStrong(
    p2Raw.filter((s) => !isLowValueGeoSentence(s) && !globalHas(s)),
  ).slice(0, 4);
  for (const s of p2Sentences) globalAdd(s);

  const p2 = p2Sentences.join(" ").trim();

  // P3 — Lecture immobilière
  const hasTransport   = transportSentences.length > 0;
  const hasEconomy     = economySentences.length > 0;
  const hasUniversity  = universitySentences.length > 0;
  const hasPark        = parkSentences.length > 0;
  const hasCulture     = cultureSentences.length > 0;
  const hasAmenities   = amenitiesSentences.length > 0;
  const hasResidential = residentialSentences.length > 0;

  const p3Parts: string[] = [];

  if (isDense && hasTransport) {
    p3Parts.push(
      isParis
        ? "Sur le plan immobilier, ce secteur parisien bien desservi affiche une demande locative structurellement soutenue et une liquidité à la revente supérieure à la moyenne."
        : "Sur le plan immobilier, la densité et la desserte en transports de ce secteur soutiennent la demande locative et la liquidité à la revente.",
    );
  } else if (isDense) {
    p3Parts.push(
      "Sur le plan immobilier, la densité urbaine de ce secteur contribue à maintenir une demande locative élevée et une bonne liquidité.",
    );
  } else if (hasTransport) {
    p3Parts.push(
      "Sur le plan immobilier, la desserte en transports constitue un facteur favorable à la demande locative et à l'attractivité du secteur.",
    );
  } else {
    p3Parts.push(
      "Sur le plan immobilier, l'attractivité résidentielle de ce secteur repose sur la qualité du cadre de vie et la proximité des équipements.",
    );
  }

  if (hasUniversity) {
    p3Parts.push(
      "La présence d'établissements d'enseignement supérieur génère une demande locative étudiante régulière, favorable au rendement locatif.",
    );
  } else if (hasEconomy && isDense) {
    p3Parts.push(
      "La présence de commerces et d'activités économiques de proximité renforce l'attractivité résidentielle et la valeur patrimoniale.",
    );
  } else if (hasPark || hasCulture) {
    p3Parts.push(
      "Les espaces verts et équipements culturels à proximité sont des facteurs de valorisation résidentielle à moyen et long terme.",
    );
  } else if (hasAmenities || hasResidential) {
    p3Parts.push(
      "La diversité des équipements de proximité constitue un atout pour la stabilité de la demande locative et la valeur à la revente.",
    );
  }

  const p3 = p3Parts.join(" ").trim();

  const paragraphs = [p1, p2, p3].filter((p) => p.length >= 30);

  const long  = paragraphs.length >= 2 ? paragraphs.join("\n\n") : (paragraphs[0] ?? null);
  const short = p1.length >= 60 ? p1 : (long ? long.slice(0, 400).trim() : null);

  return {
    short: short && short.length >= 60 ? short : null,
    long:  long  && long.length  >= 80 ? long  : null,
  };
}// --- ensureMinCharsFromWikipedia ---------------------------------------------

function ensureMinCharsFromWikipedia(
  base: string,
  wikipediaExtractRaw: string | null,
  opts: NarrativeOptions,
): string {
  let result = (base ?? "").trim();
  if (result.length >= opts.minChars) return result;
  if (!wikipediaExtractRaw) return result;

  const cleaned = cleanWikipediaExtract(wikipediaExtractRaw);
  const rawSentences =
    cleaned.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? (cleaned.trim() ? [cleaned.trim()] : []);

  const candidates = rawSentences
    .map((s) => s.trim())
    .filter((s) => s.length > 10 && !RENAME_HISTORY_SENTENCE_REGEX.test(s));

  const have = normalizeStr(result).replace(/\s+/g, " ");
  for (const s of candidates) {
    if (result.length >= opts.minChars) break;
    const ns = normalizeStr(s).replace(/\s+/g, " ");
    if (have.includes(ns.slice(0, 40))) continue;
    const next = result ? `${result} ${s}` : s;
    if (next.length > opts.maxChars) break;
    result = next;
  }

  return result.trim();
}

// --- Types -------------------------------------------------------------------

export interface MarketStatus {
  label: "TRES_LIQUIDE" | "LIQUIDE" | "NEUTRE" | "TENDU" | "PEU_LIQUIDE" | "INCONNU";
  plainFrench: string;
  dvfSummary?: {
    nbTransactions?: number | null;
    medianPriceM2?: number | null;
    acquisitionPriceM2?: number | null;
    premiumVsDvfPct?: number | null;
  };
}

export interface Conclusion {
  decisionToday: string;
  decisionAdvised: "ACHETER" | "NEGOCIER" | "ATTENDRE" | "RENOCER" | "INCONNU";
  whyInPlainFrench: string[];
  whatToDoNow: string[];
  conditionsToBuy: string[];
  maxEngagementPriceEur: number | null;
  neverExceedPriceEur: number | null;
  afterVerificationDecision: string;
}

export interface FinalSummary {
  decisionToday: string;
  decisionAfterDueDiligence: string;
  maxEngagementPriceEur: number | null;
  neverExceedPriceEur: number | null;
  top3ActionsNow: string[];
  dataToGetBeforeSigning: string[];
  killSwitches: string[];
  plan60Days: { week1: string[]; weeks2to4: string[]; month2: string[] };
  investorChecklist: string[];
  messageToAgent: string;
}

export interface Scenario {
  id: "A" | "B" | "C" | "D";
  title: string;
  forWho: string;
  entryConditions: string[];
  targetPriceEur: number | null;
  maxPriceEur: number | null;
  cushionRules: string[];
  suspensiveClauses: string[];
  executionPlan: { day7: string[]; day30: string[]; day60: string[] };
  goCriteria: string[];
  noGoCriteria: string[];
  mainRisks: string[];
  mitigations: string[];
  mimmozaNextSteps: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getNumFromContext(
  context: Record<string, unknown>,
  keys: string[],
  sections = ["financials", "pricing", "financial", "bien", "property", "simulation"],
): number | null {
  for (const k of keys) {
    if (context[k] !== undefined && context[k] !== null) {
      const n = Number(context[k]);
      if (Number.isFinite(n)) return n;
    }
    for (const section of sections) {
      const sub = context[section];
      if (sub && typeof sub === "object" && !Array.isArray(sub)) {
        const val = (sub as Record<string, unknown>)[k];
        if (val !== undefined && val !== null) {
          const n = Number(val);
          if (Number.isFinite(n)) return n;
        }
      }
    }
  }
  return null;
}

const ALL_SEARCH_SECTIONS = [
  "financials", "pricing", "financial", "bien", "property", "simulation",
  "scores", "smartscore", "computed", "analysis", "marketStudy", "riskStudy",
  "result", "metrics", "kpis", "copropriete", "copro", "diagnostics", "diag",
  "dossier", "strategie", "strategy", "location", "rental",
] as const;

function hasKeyInContext(
  context: Record<string, unknown>,
  keys: string[],
  sections: readonly string[] = ALL_SEARCH_SECTIONS,
): boolean {
  for (const k of keys) {
    const topVal = context[k];
    if (topVal !== undefined && topVal !== null && topVal !== "" && topVal !== 0) return true;
    for (const section of sections) {
      const sub = context[section];
      if (sub && typeof sub === "object" && !Array.isArray(sub)) {
        const val = (sub as Record<string, unknown>)[k];
        if (val !== undefined && val !== null && val !== "" && val !== 0) return true;
      }
    }
  }
  return false;
}

const SCORE_SECTIONS = [
  "scores", "smartscore", "computed", "analysis", "marketStudy",
  "riskStudy", "result", "metrics", "kpis",
] as const;

function getScoreFromContext(context: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    if (context[k] !== undefined && context[k] !== null) {
      const n = Number(context[k]);
      if (Number.isFinite(n)) return Math.round(clamp(n, 0, 100));
    }
    for (const section of SCORE_SECTIONS) {
      const sub = context[section];
      if (sub && typeof sub === "object" && !Array.isArray(sub)) {
        const val = (sub as Record<string, unknown>)[k];
        if (val !== undefined && val !== null) {
          const n = Number(val);
          if (Number.isFinite(n)) return Math.round(clamp(n, 0, 100));
        }
      }
    }
  }
  return null;
}

interface SmartScoreInput {
  liquidite: number | null; opportunite: number | null; rentabilite: number | null;
  robustesse: number | null; pressionRisque: number | null;
}
interface SmartScoreResult {
  smartScore: number | null; weightsUsed: Record<string, number> | null;
  nbScoresDisponibles: number; renormalized: boolean;
}

function computeSmartScore(scores: SmartScoreInput): SmartScoreResult {
  const weightDefs: { key: keyof SmartScoreInput; weight: number }[] = [
    { key: "robustesse", weight: 0.20 }, { key: "pressionRisque", weight: 0.15 },
    { key: "liquidite", weight: 0.25 }, { key: "opportunite", weight: 0.15 },
    { key: "rentabilite", weight: 0.25 },
  ];
  let somme = 0, poidsTotal = 0, nbDisponibles = 0;
  const weightsUsed: Record<string, number> = {};
  for (const { key, weight } of weightDefs) {
    const val = scores[key];
    if (val !== null) {
      nbDisponibles++;
      somme += val * weight;
      poidsTotal += weight;
      weightsUsed[key] = weight;
    }
  }
  if (nbDisponibles < 2 || poidsTotal === 0) {
    return { smartScore: null, weightsUsed: null, nbScoresDisponibles: nbDisponibles, renormalized: false };
  }
  const renormalized = poidsTotal < 0.999;
  const smartScore = Math.round(clamp(somme / poidsTotal, 0, 100));
  if (renormalized) {
    for (const k of Object.keys(weightsUsed)) {
      weightsUsed[k] = Math.round((weightsUsed[k] / poidsTotal) * 1000) / 1000;
    }
  }
  return { smartScore, weightsUsed, nbScoresDisponibles: nbDisponibles, renormalized };
}

export interface FiscaliteLMNP {
  regime: "LMNP_REEL"; horizonAnnees: number;
  hypothese: { loyerAnnuel: number; charges: number; tmi: number; amortissementAnnuel: number };
  resultats: { resultatFiscal: number; impotAnnuel: number; cashflowNetAnnuel: number };
  plusValue: { brute: number; impotPlusValue: number; nette: number };
  indicateurs: { triBrut: number; triNetFiscal: number };
}

function computeFiscaliteLMNP(context: Record<string, unknown>): FiscaliteLMNP | null {
  const getNum = (keys: string[]): number | null => getNumFromContext(context, keys);
  const acquisitionPrice = getNum(["acquisitionPrice", "prixAcquisition", "prix", "price"]);
  if (!acquisitionPrice || acquisitionPrice <= 0) return null;
  const resaleTargetPrice = getNum(["resaleTargetPrice", "prixRevente", "resalePrice", "targetPrice"]);
  const estimatedAnnualRent = getNum(["estimatedAnnualRent", "loyerAnnuel", "annualRent", "loyer"]);
  if (estimatedAnnualRent === null) return null;
  const loyerAnnuel = estimatedAnnualRent;
  const travaux = getNum(["travaux", "renovationCost", "works", "coutTravaux"]) ?? 0;
  const notaire = getNum(["notaire", "fraisNotaire", "notaryFees"]) ?? Math.round(acquisitionPrice * 0.08);
  const holdingYears = getNum(["holdingYears", "dureeDetention", "horizonAnnees"]) ?? 5;
  const tmi = getNum(["tmi", "tauxMarginal"]) ?? 0.30;
  const tauxCredit = getNum(["tauxCredit", "interestRate", "tauxInteret"]) ?? 0;
  const apport = getNum(["apport", "downPayment", "apportPersonnel"]) ?? acquisitionPrice + travaux + notaire;
  const coutTotal = acquisitionPrice + travaux + notaire;
  const montantCredit = Math.max(coutTotal - apport, 0);
  const amortissementAnnuel = (acquisitionPrice * 0.80) / 30 + (acquisitionPrice * 0.05) / 5;
  const charges = montantCredit * tauxCredit + acquisitionPrice * 0.015;
  const resultatFiscal = Math.round((loyerAnnuel - charges - amortissementAnnuel) * 100) / 100;
  const tauxImposition = tmi + 0.172;
  const impotAnnuel = Math.round(Math.max(resultatFiscal, 0) * tauxImposition * 100) / 100;
  const cashflowNetAnnuel = Math.round((loyerAnnuel - charges - impotAnnuel) * 100) / 100;
  const pvBrute = (resaleTargetPrice ?? acquisitionPrice) - acquisitionPrice;
  const impotPlusValue = pvBrute > 0 ? Math.round(pvBrute * (0.19 + 0.172) * 100) / 100 : 0;
  const pvNette = Math.round((pvBrute - impotPlusValue) * 100) / 100;
  const horizonAnnees = Math.max(holdingYears, 1);
  const fluxExploitationTotal = cashflowNetAnnuel * horizonAnnees;
  const ratioFluxBrut = ((loyerAnnuel * horizonAnnees) + (resaleTargetPrice ?? acquisitionPrice)) / coutTotal;
  const triBrut = ratioFluxBrut > 0 ? Math.round((Math.pow(ratioFluxBrut, 1 / horizonAnnees) - 1) * 10000) / 10000 : 0;
  const ratioFluxNet = (fluxExploitationTotal + pvNette + apport) / coutTotal;
  const triNetFiscal = ratioFluxNet > 0 ? Math.round((Math.pow(ratioFluxNet, 1 / horizonAnnees) - 1) * 10000) / 10000 : 0;
  return {
    regime: "LMNP_REEL", horizonAnnees,
    hypothese: { loyerAnnuel: Math.round(loyerAnnuel), charges: Math.round(charges), tmi, amortissementAnnuel: Math.round(amortissementAnnuel) },
    resultats: { resultatFiscal, impotAnnuel, cashflowNetAnnuel },
    plusValue: { brute: Math.round(pvBrute), impotPlusValue, nette: pvNette },
    indicateurs: { triBrut, triNetFiscal },
  };
}

function computeFiscalScore(_context: Record<string, unknown>, fiscalite?: FiscaliteLMNP | null): number | null {
  if (!fiscalite) return 35;
  const cf = fiscalite.resultats?.cashflowNetAnnuel;
  if (cf === null || cf === undefined) return 35;
  if (cf <= 0) return 25;
  const loyer = fiscalite.hypothese?.loyerAnnuel;
  let score = (!loyer || loyer <= 0) ? 45 : clamp(40 + (cf / loyer) * 200, 40, 100);
  if (fiscalite.regime === "LMNP_REEL") score = Math.min(score + 10, 100);
  return Math.round(clamp(score, 0, 100));
}

export interface ScoreRentabiliteV2 {
  score: number | null;
  piliers: {
    margeBrute:    { score: number | null; poids: number };
    cushion:       { score: number | null; poids: number };
    stressRevente: { score: number | null; poids: number };
    fiscal:        { score: number | null; poids: number; isPenalite: boolean };
  };
  nbPiliersCalculables: number;
  version: "v2";
}

function computeScoreRentabiliteV2(
  context: Record<string, unknown>,
  fiscalite: FiscaliteLMNP | null,
  fiscalScore: number | null,
): ScoreRentabiliteV2 {
  const getNum = (keys: string[]): number | null => getNumFromContext(context, keys);
  const acq = getNum(["acquisitionPrice", "prixAcquisition", "prix", "price"]);
  const rev = getNum(["resaleTargetPrice", "prixRevente", "resalePrice", "targetPrice"]);
  const trv = getNum(["travaux", "renovationCost", "works", "coutTravaux"]);
  const not = getNum(["notaire", "fraisNotaire", "notaryFees"]);

  const calcCout = () => (acq ?? 0) + (trv ?? 0) + (not ?? Math.round((acq ?? 0) * 0.08));

  let scoreMargeBrute: number | null = null;
  if (acq && acq > 0 && rev && rev > 0) {
    const ct = calcCout();
    const pct = ((rev - ct) / ct) * 100;
    if (pct <= 0) scoreMargeBrute = Math.max(0, 20 + pct * 2);
    else if (pct <= 12) scoreMargeBrute = 20 + (pct / 12) * 50;
    else scoreMargeBrute = Math.min(70 + ((pct - 12) / 8) * 30, 100);
    scoreMargeBrute = Math.round(clamp(scoreMargeBrute, 0, 100));
  }

  let scoreCushion: number | null = null;
  if (acq && acq > 0 && rev && rev > 0) {
    const ct = calcCout();
    const ca = ((rev - ct) / ct) * 100 - ((trv ?? 0) * 0.10 / ct) * 100;
    if (ca <= 0) scoreCushion = Math.max(0, 10 + ca * 2);
    else if (ca <= 5) scoreCushion = 10 + (ca / 5) * 30;
    else if (ca <= 10) scoreCushion = 40 + ((ca - 5) / 5) * 30;
    else scoreCushion = Math.min(70 + ((ca - 10) / 10) * 30, 100);
    scoreCushion = Math.round(clamp(scoreCushion, 0, 100));
  }

  let scoreStress: number | null = null;
  if (acq && acq > 0 && rev && rev > 0) {
    const ct = calcCout();
    const ms = ((rev * 0.95 - ct) / ct) * 100;
    if (ms <= -5) scoreStress = 0;
    else if (ms <= 0) scoreStress = Math.max(0, 30 + ms * 6);
    else if (ms <= 5) scoreStress = 30 + (ms / 5) * 30;
    else scoreStress = Math.min(60 + ((ms - 5) / 10) * 40, 100);
    scoreStress = Math.round(clamp(scoreStress, 0, 100));
  }

  const fiscalIsPenalite = !fiscalite ||
    fiscalite.resultats?.cashflowNetAnnuel === null ||
    fiscalite.resultats?.cashflowNetAnnuel === undefined;

  let nbPiliersCalculables = 0;
  if (scoreMargeBrute !== null) nbPiliersCalculables++;
  if (scoreCushion !== null) nbPiliersCalculables++;
  if (scoreStress !== null) nbPiliersCalculables++;
  if (!fiscalIsPenalite && fiscalScore !== null) nbPiliersCalculables++;

  let scoreTotal: number | null = null;
  if (nbPiliersCalculables >= 2) {
    let somme = 0, poidsTotal = 0;
    if (scoreMargeBrute !== null) { somme += scoreMargeBrute * 0.40; poidsTotal += 0.40; }
    if (scoreCushion !== null)    { somme += scoreCushion    * 0.20; poidsTotal += 0.20; }
    if (scoreStress !== null)     { somme += scoreStress     * 0.20; poidsTotal += 0.20; }
    somme += (fiscalScore ?? 35) * 0.20; poidsTotal += 0.20;
    scoreTotal = poidsTotal > 0 ? Math.round(clamp(somme / poidsTotal, 0, 100)) : null;
  }

  return {
    score: scoreTotal,
    piliers: {
      margeBrute:    { score: scoreMargeBrute, poids: 0.40 },
      cushion:       { score: scoreCushion,    poids: 0.20 },
      stressRevente: { score: scoreStress,     poids: 0.20 },
      fiscal:        { score: fiscalScore,     poids: 0.20, isPenalite: fiscalIsPenalite },
    },
    nbPiliersCalculables,
    version: "v2",
  };
}

export interface MissingDataServer { critical: string[]; important: string[]; optional: string[] }

function computeMissingDataServer(context: Record<string, unknown>): MissingDataServer {
  const critical: string[] = [], important: string[] = [], optional: string[] = [];
  const isLoc = hasKeyInContext(context, ["loyerAnnuel", "annualRent", "estimatedAnnualRent", "loyer", "strategyLocation", "strategieLocation", "lmnp", "locatif"]);
  if (!hasKeyInContext(context, ["typeBien", "type_de_bien", "type", "propertyType"])) critical.push("typeBien");
  if (!hasKeyInContext(context, ["etat", "etatBien", "propertyCondition", "condition"])) critical.push("etatBien");
  if (getNumFromContext(context, ["travaux", "works", "renovationCost", "coutTravaux"]) === null) critical.push("travauxMontant");
  if (!hasKeyInContext(context, ["holdingYears", "dureeDetention", "horizonAnnees", "dureeDetentionMois", "holdingMonths"])) critical.push("dureeDetentionMois");
  if (isLoc && !hasKeyInContext(context, ["loyerAnnuel", "annualRent", "estimatedAnnualRent", "loyer"])) critical.push("loyerAnnuel");
  if (!hasKeyInContext(context, ["chargesAnnuelles", "annualCharges", "charges", "taxeFonciere", "chargesCopro", "assurancePNO", "fraisGestion"])) critical.push("chargesAnnuelles");
  if (!hasKeyInContext(context, ["notaire", "fraisNotaire", "notaryFees"])) important.push("fraisNotaire");
  if (hasKeyInContext(context, ["copropriete", "copro", "nbLots", "syndic"]) && !hasKeyInContext(context, ["auditCopro", "auditCopropriete", "pvAG", "carnetEntretien"])) important.push("auditCopropriete");
  if (!hasKeyInContext(context, ["diagnostics", "dpe", "amiante", "plomb", "termites", "diagnosticElec", "diagnosticGaz"])) important.push("diagnostics");
  if (!hasKeyInContext(context, ["surfaceHabitable", "surface", "surfaceM2", "livingArea", "area"])) important.push("surfaceHabitable");
  if (!hasKeyInContext(context, ["tmi", "tauxMarginal"])) optional.push("tmi");
  if (!hasKeyInContext(context, ["tauxCredit", "interestRate", "tauxInteret"])) optional.push("tauxCredit");
  if (!hasKeyInContext(context, ["apport", "downPayment", "apportPersonnel"])) optional.push("apport");
  return { critical, important, optional };
}

function enrichMissingDataFromServer(existing: string[], mds: MissingDataServer): string[] {
  const enriched = [...existing];
  const set = new Set(existing.map((s) => s.toLowerCase()));
  const add = (level: string, items: string[]) => {
    for (const item of items) {
      const tagged = `${level}: ${item}`;
      if (!set.has(tagged.toLowerCase())) { enriched.push(tagged); set.add(tagged.toLowerCase()); }
    }
  };
  add("CRITICAL", mds.critical);
  add("IMPORTANT", mds.important);
  add("OPTIONAL", mds.optional);
  return enriched;
}

export interface OperationSheet {
  reference: string | null; title: string | null; address: string | null;
  zipCode: string | null; city: string | null;
  acquisitionPriceEur: number | null; resaleTargetPriceEur: number | null;
  surfaceM2: number | null; typeBien: string | null; etatBien: string | null;
  travauxEur: number | null; notaireEur: number | null; coutTotalEur: number | null;
  margeBruteEur: number | null; margeBrutePct: number | null;
  margeNetteEur: null; margeNettePct: null; rentabilitePct: null;
}

function getStringFromContext(
  context: Record<string, unknown>,
  keys: string[],
  sections: readonly string[] = ALL_SEARCH_SECTIONS,
): string | null {
  for (const k of keys) {
    const topVal = context[k];
    if (typeof topVal === "string" && topVal.trim()) return topVal.trim();
    for (const section of sections) {
      const sub = context[section];
      if (sub && typeof sub === "object" && !Array.isArray(sub)) {
        const val = (sub as Record<string, unknown>)[k];
        if (typeof val === "string" && val.trim()) return val.trim();
      }
    }
  }
  return null;
}

function computeOperationSheet(context: Record<string, unknown>): OperationSheet {
  const getNum = (keys: string[]): number | null => getNumFromContext(context, keys);
  const getStr = (keys: string[]): string | null => getStringFromContext(context, keys);
  const acquisitionPrice = getNum(["acquisitionPrice", "prixAcquisition", "prix", "price"]);
  const resaleTargetPrice = getNum(["resaleTargetPrice", "prixRevente", "resalePrice", "targetPrice"]);
  const surfaceM2 = getNum(["surfaceHabitable", "surface", "surfaceM2", "livingArea", "area"]);
  const travaux = getNum(["travaux", "renovationCost", "works", "coutTravaux"]);
  const notaireExplicit = getNum(["notaire", "fraisNotaire", "notaryFees"]);
  const notaire = notaireExplicit ?? (acquisitionPrice ? Math.round(acquisitionPrice * 0.08) : null);
  const typeBien  = getStr(["typeBien", "type_de_bien", "type", "propertyType"]);
  const reference = getStr(["reference", "ref"]);
  const zipCode   = getStr(["zipCode", "cp", "codePostal"]);
  const city      = getStr(["city", "ville"]);
  const etatBien  = (() => { const v = getStr(["etat", "etatBien", "propertyCondition", "condition"]); return v ? safeUtf8Fix(v) : v; })();
  const title     = (() => { const v = getStr(["title", "operationTitle", "titre"]); return v ? safeUtf8Fix(v) : v; })();
  const address   = (() => { const v = getStr(["address", "adresse"]); return v ? safeUtf8Fix(v) : v; })();
  let coutTotalEur: number | null = null, margeBruteEur: number | null = null, margeBrutePct: number | null = null;
  if (acquisitionPrice && notaire !== null) {
    coutTotalEur = acquisitionPrice + (travaux ?? 0) + notaire;
    if (resaleTargetPrice) {
      margeBruteEur = Math.round(resaleTargetPrice - coutTotalEur);
      margeBrutePct = Math.round(((resaleTargetPrice - coutTotalEur) / coutTotalEur) * 10000) / 100;
    }
  }
  return {
    reference, title, address, zipCode, city,
    acquisitionPriceEur: acquisitionPrice, resaleTargetPriceEur: resaleTargetPrice,
    surfaceM2, typeBien, etatBien, travauxEur: travaux, notaireEur: notaire, coutTotalEur,
    margeBruteEur, margeBrutePct, margeNetteEur: null, margeNettePct: null, rentabilitePct: null,
  };
}

// --- AnalysisResultLegacy avec narrativeMarkdown ----------------------------

interface AnalysisResultLegacy {
  verdict: "GO" | "GO_AVEC_RESERVES" | "NO_GO";
  confidence: number;
  executiveSummary: string;
  narrativeMarkdown: string;
  strengths: string[];
  vigilances: string[];
  sensitivities: string[];
  actionPlan: string[];
  missingData: string[];
}

export interface AnalysisResult extends AnalysisResultLegacy {
  marketStatus?: MarketStatus;
  conclusion?: Conclusion;
  finalSummary?: FinalSummary | null;
  scenarios?: Scenario[] | null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).map((s) => s.trim()).filter(Boolean);
}
function safeNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeParseClaudeJson(raw: string): { parsed: AnalysisResult | null; errors: string[] } {
  const errors: string[] = [];
  let jsonStr = extractFirstJsonObject(raw);
  if (!jsonStr) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try { JSON.parse(trimmed); jsonStr = trimmed; } catch { /* ignore */ }
    }
    if (!jsonStr) return { parsed: null, errors: ["Impossible d'extraire un objet JSON de la reponse Claude."] };
  }
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(jsonStr); }
  catch (e) { return { parsed: null, errors: ["JSON.parse a echoue: " + (e instanceof Error ? e.message : String(e))] }; }

  for (const key of ANALYSIS_REQUIRED_KEYS) {
    if (!(key in obj)) errors.push(`Cle manquante dans la reponse: "${key}"`);
  }
  if (typeof obj.verdict !== "string" || !(VALID_VERDICTS as readonly string[]).includes(obj.verdict)) {
    errors.push(`verdict invalide: "${obj.verdict}"`); obj.verdict = "GO_AVEC_RESERVES";
  }
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
    errors.push(`confidence invalide: ${obj.confidence}`); obj.confidence = 0.3;
  }
  if (typeof obj.executiveSummary !== "string") {
    errors.push('"executiveSummary" devrait etre une string');
    obj.executiveSummary = "Information non fournie dans les donnees analysees.";
  }
  if (typeof obj.narrativeMarkdown !== "string") {
    errors.push('"narrativeMarkdown" devrait etre une string');
    obj.narrativeMarkdown = "";
  }
  for (const key of ["strengths", "vigilances", "sensitivities", "actionPlan", "missingData"] as const) {
    if (!Array.isArray(obj[key])) { errors.push(`"${key}" devrait etre un tableau`); obj[key] = []; }
    else obj[key] = (obj[key] as unknown[]).map((v) => String(v));
  }
  if (obj.marketStatus && typeof obj.marketStatus === "object") {
    const ms = obj.marketStatus as Record<string, unknown>;
    const label = String(ms.label ?? "INCONNU").toUpperCase();
    const allowed = ["TRES_LIQUIDE", "LIQUIDE", "NEUTRE", "TENDU", "PEU_LIQUIDE", "INCONNU"];
    const dvs = ms.dvfSummary as Record<string, unknown> | undefined;
    obj.marketStatus = {
      label: (allowed.includes(label) ? label : "INCONNU") as MarketStatus["label"],
      plainFrench: typeof ms.plainFrench === "string" && ms.plainFrench.trim() ? ms.plainFrench : "Information non fournie dans les donnees analysees.",
      dvfSummary: dvs && typeof dvs === "object" ? {
        nbTransactions: safeNumberOrNull(dvs.nbTransactions),
        medianPriceM2: safeNumberOrNull(dvs.medianPriceM2),
        acquisitionPriceM2: safeNumberOrNull(dvs.acquisitionPriceM2),
        premiumVsDvfPct: safeNumberOrNull(dvs.premiumVsDvfPct),
      } : undefined,
    } satisfies MarketStatus;
  } else if ("marketStatus" in obj && obj.marketStatus !== null) {
    errors.push('"marketStatus" present mais invalide'); delete obj.marketStatus;
  }
  if (obj.conclusion && typeof obj.conclusion === "object") {
    const c = obj.conclusion as Record<string, unknown>;
    const dRaw = String(c.decisionAdvised ?? "INCONNU").toUpperCase();
    const allowedD = ["ACHETER", "NEGOCIER", "ATTENDRE", "RENOCER", "INCONNU"];
    obj.conclusion = {
      decisionToday: typeof c.decisionToday === "string" && c.decisionToday.trim() ? c.decisionToday : "Information non fournie dans les donnees analysees.",
      decisionAdvised: (allowedD.includes(dRaw) ? dRaw : "INCONNU") as Conclusion["decisionAdvised"],
      whyInPlainFrench: asStringArray(c.whyInPlainFrench).slice(0, 5),
      whatToDoNow: asStringArray(c.whatToDoNow).slice(0, 8),
      conditionsToBuy: asStringArray(c.conditionsToBuy).slice(0, 8),
      maxEngagementPriceEur: safeNumberOrNull(c.maxEngagementPriceEur),
      neverExceedPriceEur: safeNumberOrNull(c.neverExceedPriceEur),
      afterVerificationDecision: typeof c.afterVerificationDecision === "string" ? c.afterVerificationDecision : "",
    } satisfies Conclusion;
  } else if ("conclusion" in obj && obj.conclusion !== null) {
    errors.push('"conclusion" present mais invalide'); delete obj.conclusion;
  }
  if (obj.finalSummary === null) { /* ok */ }
  else if (obj.finalSummary && typeof obj.finalSummary === "object") {
    const fs = obj.finalSummary as Record<string, unknown>;
    const p60 = fs.plan60Days as Record<string, unknown> | undefined;
    obj.finalSummary = {
      decisionToday: typeof fs.decisionToday === "string" && fs.decisionToday.trim() ? fs.decisionToday : "Information non fournie dans les donnees analysees.",
      decisionAfterDueDiligence: typeof fs.decisionAfterDueDiligence === "string" && fs.decisionAfterDueDiligence.trim() ? fs.decisionAfterDueDiligence : "Information non fournie dans les donnees analysees.",
      maxEngagementPriceEur: safeNumberOrNull(fs.maxEngagementPriceEur),
      neverExceedPriceEur: safeNumberOrNull(fs.neverExceedPriceEur),
      top3ActionsNow: asStringArray(fs.top3ActionsNow).slice(0, 3),
      dataToGetBeforeSigning: asStringArray(fs.dataToGetBeforeSigning),
      killSwitches: asStringArray(fs.killSwitches).slice(0, 8),
      plan60Days: p60 && typeof p60 === "object"
        ? { week1: asStringArray(p60.week1), weeks2to4: asStringArray(p60.weeks2to4), month2: asStringArray(p60.month2) }
        : { week1: [], weeks2to4: [], month2: [] },
      investorChecklist: asStringArray(fs.investorChecklist),
      messageToAgent: typeof fs.messageToAgent === "string" ? fs.messageToAgent : "",
    } satisfies FinalSummary;
  } else if ("finalSummary" in obj) {
    errors.push('"finalSummary" present mais invalide'); delete obj.finalSummary;
  }
  if (obj.scenarios === null) { /* ok */ }
  else if (Array.isArray(obj.scenarios)) {
    const normalized: Scenario[] = [];
    for (const s of obj.scenarios as unknown[]) {
      if (!s || typeof s !== "object") continue;
      const sc = s as Record<string, unknown>;
      const idRaw = String(sc.id ?? "").toUpperCase();
      const validIds: readonly string[] = ["A", "B", "C", "D"];
      const id = (validIds.includes(idRaw) ? idRaw : "A") as Scenario["id"];
      const exec = sc.executionPlan as Record<string, unknown> | undefined;
      normalized.push({
        id,
        title: typeof sc.title === "string" ? sc.title : "",
        forWho: typeof sc.forWho === "string" ? sc.forWho : "",
        entryConditions: asStringArray(sc.entryConditions),
        targetPriceEur: safeNumberOrNull(sc.targetPriceEur),
        maxPriceEur: safeNumberOrNull(sc.maxPriceEur),
        cushionRules: asStringArray(sc.cushionRules),
        suspensiveClauses: asStringArray(sc.suspensiveClauses),
        executionPlan: {
          day7: exec ? asStringArray(exec.day7) : [],
          day30: exec ? asStringArray(exec.day30) : [],
          day60: exec ? asStringArray(exec.day60) : [],
        },
        goCriteria: asStringArray(sc.goCriteria),
        noGoCriteria: asStringArray(sc.noGoCriteria),
        mainRisks: asStringArray(sc.mainRisks),
        mitigations: asStringArray(sc.mitigations),
        mimmozaNextSteps: asStringArray(sc.mimmozaNextSteps),
      });
    }
    obj.scenarios = normalized;
  } else if ("scenarios" in obj) {
    errors.push('"scenarios" present mais invalide'); delete obj.scenarios;
  }
  return { parsed: obj as unknown as AnalysisResult, errors };
}

function buildSourcesUsed(context: Record<string, unknown>, prefix = "context"): string[] {
  const sources: string[] = [];
  for (const key of Object.keys(context)) {
    const val = context[key];
    if (val !== null && val !== undefined) {
      if (typeof val === "object" && !Array.isArray(val)) {
        for (const subKey of Object.keys(val as Record<string, unknown>)) {
          sources.push(`${prefix}.${key}.${subKey}`);
        }
      } else { sources.push(`${prefix}.${key}`); }
    }
  }
  return sources;
}

// =============================================================================
// --- Wikimedia Client v4.5 ---------------------------------------------------
// =============================================================================

interface WikipediaPage {
  pageid?: number; ns?: number; title?: string; missing?: string;
  extract?: string; pageprops?: { wikibase_item?: string };
}
interface WikipediaQueryResponse {
  query?: { pages?: WikipediaPage[] | Record<string, WikipediaPage> };
}
interface WbSearchEntity { id?: string; label?: string; description?: string; }
interface WbSearchResponse { search?: WbSearchEntity[]; }

interface WikipediaSearchHit { ns?: number; title?: string; pageid?: number; snippet?: string; }
interface WikipediaSearchResponse {
  query?: { search?: WikipediaSearchHit[] };
}

// --- normalizeCityName -------------------------------------------------------

function normalizeCityName(raw: string): string {
  const m = raw.match(
    /^(.+?)\s+(\d+(?:er|ère|e|ème|eme)?)\s+[Aa]rrondissement$/i,
  );
  if (m) {
    const cityPart    = m[1].trim();
    const ordinalPart = m[2].toLowerCase();
    return `${ordinalPart} arrondissement de ${cityPart}`;
  }
  return raw;
}

// --- extractStreetNameFromAddress -------------------------------------------

function extractStreetNameFromAddress(address: string | null): string | null {
  if (!address) return null;
  const m = address.match(
    /^\d+[\w\-]*\s+((?:rue|avenue|boulevard|allée|allee|impasse|passage|voie|chemin|place|cours|quai|esplanade|villa|cité|cite|square|sente)\b.+)$/i,
  );
  if (!m) return null;
  const street = m[1].trim();
  return street.charAt(0).toUpperCase() + street.slice(1);
}

// --- fetchWikipediaStreetExtract ---------------------------------------------

async function fetchWikipediaStreetExtract(
  streetName: string,
  warnings: string[],
): Promise<{ extract: string; title: string; url: string } | null> {
  const cacheKey = `wpstreet:${streetName.toLowerCase()}`;
  const cached = cacheGet(wpStreetExtractCache, cacheKey);
  if (cached.hit) return cached.value;
  const params = new URLSearchParams({
    action: "query", prop: "extracts", exsentences: "10", explaintext: "1",
    titles: streetName, format: "json", redirects: "1", formatversion: "2",
  });
  try {
    const resp = await wikiFetch(`https://fr.wikipedia.org/w/api.php?${params.toString()}`);
    if (!resp.ok) { cacheSet(wpStreetExtractCache, cacheKey, null); return null; }
    const data = await resp.json() as WikipediaQueryResponse;
    const pages = data?.query?.pages;
    if (!pages) { cacheSet(wpStreetExtractCache, cacheKey, null); return null; }
    const pageList: WikipediaPage[] = Array.isArray(pages)
      ? pages : Object.values(pages as Record<string, WikipediaPage>);
    for (const page of pageList) {
      if (page.missing !== undefined) continue;
      if (page.pageid !== undefined && page.pageid < 0) continue;
      if (page.ns !== undefined && page.ns !== 0) continue;
      const extract = (page.extract ?? "").trim();
      if (!extract || extract.length < 40) continue;
      const title = page.title ?? streetName;
      const result = {
        extract, title,
        url: `https://fr.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      };
      cacheSet(wpStreetExtractCache, cacheKey, result); return result;
    }
    cacheSet(wpStreetExtractCache, cacheKey, null); return null;
  } catch (err) {
    warnings.push(`[wikimedia] fetchWikipediaStreetExtract("${streetName}"): ${(err as Error).message}`);
    cacheSet(wpStreetExtractCache, cacheKey, null); return null;
  }
}

// --- buildQuartierSearchQueries ----------------------------------------------

const PARIS_QUARTIER_STREET_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["14:alesia", "Quartier du Petit-Montrouge"],
]);

function buildQuartierSearchQueries(
  rawCity: string,
  zipCode: string | null,
  streetName: string | null,
): string[] {
  const queries: string[] = [];

  const parisNumMatch =
    rawCity.match(/^Paris\s+(\d{1,2})(?:er|e|ème|eme)?$/i) ??
    rawCity.match(/(\d{1,2})(?:er|e|ème|eme)?\s+arrondissement\s+de\s+Paris/i);

  const parisArrNum = parisNumMatch
    ? parseInt(parisNumMatch[1], 10)
    : zipCode?.match(/^750\d{2}$/) ? parseInt(zipCode.slice(3), 10) : null;

  if (parisArrNum !== null && parisArrNum > 0 && parisArrNum <= 20 && streetName) {
    const streetCoreNorm = normalizeStr(
      streetName
        .replace(/^(?:rue|avenue|boulevard|allée|allee|impasse|passage|voie|chemin|place|cours|quai|esplanade|villa|cité|cite|square|sente)\s+/i, "")
        .trim(),
    );
    const overrideKey   = `${parisArrNum}:${streetCoreNorm}`;
    const overrideTitle = PARIS_QUARTIER_STREET_OVERRIDES.get(overrideKey);
    if (overrideTitle) {
      queries.push(overrideTitle);
      console.log(
        "[WIKIMEDIA][2/QUARTIER_OVERRIDE]",
        `paris${parisArrNum}+"${streetCoreNorm}"→"${overrideTitle}"`,
      );
    }
  }

  if (parisNumMatch) {
    const num = parseInt(parisNumMatch[1], 10);
    if (num > 0 && num <= 20) {
      queries.push(`quartier Paris ${num}e arrondissement`);
      queries.push(`quartier administratif Paris ${num}`);
    }
  }

  if (!parisNumMatch && zipCode?.match(/^750\d{2}$/)) {
    const num = parseInt(zipCode.slice(3), 10);
    if (num > 0 && num <= 20) {
      queries.push(`quartier Paris ${num}e arrondissement`);
    }
  }

  const lyonMatch =
    rawCity.match(/^Lyon\s+(\d{1,2})(?:er|e|ème|eme)?$/i) ??
    rawCity.match(/(\d{1,2})(?:er|e|ème|eme)?\s+arrondissement\s+de\s+Lyon/i);
  if (lyonMatch) {
    const num = parseInt(lyonMatch[1], 10);
    if (num > 0 && num <= 9) {
      queries.push(`quartier Lyon ${num}e arrondissement`);
    }
  }

  const marseilleMatch =
    rawCity.match(/^Marseille\s+(\d{1,2})(?:er|e|ème|eme)?$/i) ??
    rawCity.match(/(\d{1,2})(?:er|e|ème|eme)?\s+arrondissement\s+de\s+Marseille/i);
  if (marseilleMatch) {
    const num = parseInt(marseilleMatch[1], 10);
    if (num > 0 && num <= 16) {
      queries.push(`quartier Marseille ${num}e arrondissement`);
    }
  }

  if (streetName) {
    const streetCore = streetName
      .replace(/^(?:rue|avenue|boulevard|allée|allee|impasse|passage|voie|chemin|place|cours|quai|esplanade|villa|cité|cite|square|sente)\s+/i, "")
      .trim();
    if (streetCore.length > 3) {
      const cityBase = rawCity.replace(/\s+\d+.*$/, "").trim();
      queries.push(`quartier ${cityBase} ${streetCore}`);
    }
  }

  const normRaw = normalizeStr(rawCity);
  const isBigCity =
    normRaw.includes("paris") ||
    normRaw.includes("lyon") ||
    normRaw.includes("marseille");
  if (!isBigCity) {
    const cityBase = rawCity.replace(/\s+\d+.*$/, "").trim();
    if (cityBase.length > 2) queries.push(`quartier ${cityBase}`);
  }

  return [...new Set(queries)].slice(0, 4);
}

// --- fetchWikipediaQuartierExtract -------------------------------------------

async function fetchWikipediaQuartierExtract(
  rawCity: string,
  zipCode: string | null,
  streetName: string | null,
  warnings: string[],
): Promise<{ extract: string; title: string; url: string } | null> {
  const cacheKey = `wpquartier:${normalizeStr(rawCity)}:${zipCode ?? ""}:${normalizeStr(streetName ?? "")}`;
  const cached = cacheGet(wpQuartierExtractCache, cacheKey);
  if (cached.hit) return cached.value;

  const queries = buildQuartierSearchQueries(rawCity, zipCode, streetName);
  if (queries.length === 0) {
    cacheSet(wpQuartierExtractCache, cacheKey, null);
    return null;
  }

  for (const q of queries) {
    try {
      const searchParams = new URLSearchParams({
        action: "query", list: "search",
        srsearch: q, srnamespace: "0", srlimit: "5",
        format: "json", formatversion: "2",
      });
      const searchResp = await wikiFetch(
        `https://fr.wikipedia.org/w/api.php?${searchParams.toString()}`,
      );
      if (!searchResp.ok) continue;
      const searchData = await searchResp.json() as WikipediaSearchResponse;
      const hits = searchData?.query?.search ?? [];

      const quartierHits = hits.filter(
        (h) => h.title && /quartier/i.test(h.title),
      );
      if (quartierHits.length === 0) continue;

      for (const hit of quartierHits.slice(0, 2)) {
        const hitTitle = hit.title ?? "";
        try {
          const extractParams = new URLSearchParams({
            action: "query", prop: "extracts",
            exsentences: "10", explaintext: "1",
            titles: hitTitle, format: "json",
            redirects: "1", formatversion: "2",
          });
          const extractResp = await wikiFetch(
            `https://fr.wikipedia.org/w/api.php?${extractParams.toString()}`,
          );
          if (!extractResp.ok) continue;
          const extractData = await extractResp.json() as WikipediaQueryResponse;
          const pages = extractData?.query?.pages;
          if (!pages) continue;
          const pageList: WikipediaPage[] = Array.isArray(pages)
            ? pages : Object.values(pages as Record<string, WikipediaPage>);
          for (const page of pageList) {
            if (page.missing !== undefined) continue;
            if (page.pageid !== undefined && page.pageid < 0) continue;
            const extract = (page.extract ?? "").trim();
            if (extract.length < 40) continue;
            const pageTitle = page.title ?? hitTitle;
            const url = `https://fr.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`;
            const result = { extract, title: pageTitle, url };
            console.log(
              "[WIKIMEDIA][quartierExtract]",
              `title="${pageTitle}" len=${extract.length} query="${q}"`,
            );
            cacheSet(wpQuartierExtractCache, cacheKey, result);
            return result;
          }
        } catch { /* non bloquant, essai suivant */ }
      }
    } catch { /* non bloquant, requête suivante */ }
  }

  cacheSet(wpQuartierExtractCache, cacheKey, null);
  return null;
}

// --- isWikidataCommuneFR -----------------------------------------------------

async function isWikidataCommuneFR(qid: string): Promise<boolean> {
  const cacheKey = `p31:${qid}`;
  const cached = cacheGet(wdP31Cache, cacheKey);
  if (cached.hit) return cached.value;
  try {
    const resp = await wikiFetch(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=claims&format=json`,
    );
    if (!resp.ok) { cacheSet(wdP31Cache, cacheKey, false); return false; }
    const data = await resp.json() as WbGetEntitiesDetailed;
    for (const stmt of data?.entities?.[qid]?.claims?.["P31"] ?? []) {
      if (WIKIDATA_QID_VALID_FR_LOCALITY.includes(getStatementQid(stmt) ?? "")) {
        cacheSet(wdP31Cache, cacheKey, true); return true;
      }
    }
    cacheSet(wdP31Cache, cacheKey, false); return false;
  } catch (err) {
    console.warn(`[wikimedia] isWikidataCommuneFR(${qid}): ${(err as Error).message}`);
    cacheSet(wdP31Cache, cacheKey, false); return false;
  }
}

// --- fetchWikipediaExtract ---------------------------------------------------

async function fetchWikipediaExtract(
  city: string,
  warnings: string[],
): Promise<{ extract: string; title: string; qid: string | null; url: string } | null> {
  const cacheKey = `wpq:${city.toLowerCase()}`;
  const cached = cacheGet(wpExtractCache, cacheKey);
  if (cached.hit) return cached.value;
  const params = new URLSearchParams({
    action: "query", prop: "extracts|pageprops", ppprop: "wikibase_item",
    exintro: "1", explaintext: "1", titles: city, format: "json",
    redirects: "1", formatversion: "2",
  });
  try {
    const resp = await wikiFetch(`https://fr.wikipedia.org/w/api.php?${params.toString()}`);
    if (!resp.ok) { cacheSet(wpExtractCache, cacheKey, null); return null; }
    const data = await resp.json() as WikipediaQueryResponse;
    const pages = data?.query?.pages;
    if (!pages) { cacheSet(wpExtractCache, cacheKey, null); return null; }
    const pageList: WikipediaPage[] = Array.isArray(pages)
      ? pages : Object.values(pages as Record<string, WikipediaPage>);
    for (const page of pageList) {
      if (page.missing !== undefined) continue;
      if (page.pageid !== undefined && page.pageid < 0) continue;
      if (page.ns !== undefined && page.ns !== 0) continue;
      const extract = (page.extract ?? "").trim();
      const title = page.title ?? city;
      const qid = page.pageprops?.wikibase_item ?? null;
      if (!extract) continue;
      if (!qid) {
        warnings.push(`[wikimedia] Wikipedia "${title}": wikibase_item absent — rejeté.`);
        cacheSet(wpExtractCache, cacheKey, null); return null;
      }
      if (!(await isWikidataCommuneFR(qid))) {
        warnings.push(`[wikimedia] Wikipedia "${title}" (${qid}): P31 ≠ commune/arrondissement FR — rejeté.`);
        cacheSet(wpExtractCache, cacheKey, null); return null;
      }
      const result = {
        extract, title, qid,
        url: `https://fr.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      };
      cacheSet(wpExtractCache, cacheKey, result); return result;
    }
    cacheSet(wpExtractCache, cacheKey, null); return null;
  } catch (err) {
    console.warn(`[wikimedia] fetchWikipediaExtract("${city}"): ${(err as Error).message}`);
    cacheSet(wpExtractCache, cacheKey, null); return null;
  }
}

// --- fetchWikidataFallback ---------------------------------------------------

async function fetchWikidataFallback(
  city: string,
  warnings: string[],
): Promise<{ narrative: string; qid: string; deptLabel: string | null; regionLabel: string | null } | null> {
  const cacheKey = `wdf:${city.toLowerCase()}`;
  const cached = cacheGet(wdFallbackCache, cacheKey);
  if (cached.hit) return cached.value;
  try {
    const searchResp = await wikiFetch(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(city)}&language=fr&type=item&limit=5&format=json`,
    );
    if (!searchResp.ok) { cacheSet(wdFallbackCache, cacheKey, null); return null; }
    const candidates = ((await searchResp.json() as WbSearchResponse).search ?? []);

    for (const entity of candidates) {
      const qid = entity.id ?? "";
      if (!qid || !(await isWikidataCommuneFR(qid))) continue;

      let deptLabel: string | null = null, regionLabel: string | null = null;
      let communeLabel = entity.label ?? city, communeDescription = entity.description ?? "";

      try {
        const detailResp = await wikiFetch(
          `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=labels|descriptions|claims&languages=fr&format=json`,
        );
        if (detailResp.ok) {
          const ent = (await detailResp.json() as WbGetEntitiesDetailed)?.entities?.[qid];
          if (ent) {
            communeLabel = ent.labels?.fr?.value ?? communeLabel;
            communeDescription = ent.descriptions?.fr?.value ?? communeDescription;
            const parentIds = (ent.claims?.["P131"] ?? [])
              .map((s) => getStatementQid(s)).filter((id): id is string => id !== null).slice(0, 12);
            if (parentIds.length > 0) {
              try {
                const pResp = await wikiFetch(
                  `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(parentIds.join("|"))}&props=labels|claims&languages=fr&format=json`,
                );
                if (pResp.ok) {
                  const pData = await pResp.json() as WbGetEntitiesDetailed;
                  const deptQidsFound: string[] = [];
                  for (const pid of parentIds) {
                    const pe = pData.entities?.[pid];
                    const pLabel = pe?.labels?.fr?.value ?? null;
                    if (!pLabel) continue;
                    const typeQids = (pe?.claims?.["P31"] ?? [])
                      .map((s) => getStatementQid(s)).filter((id): id is string => id !== null);
                    const isDept   = typeQids.some((id) => DEPT_TYPE_QIDS.has(id));
                    const isRegion = typeQids.some((id) => REGION_TYPE_QIDS.has(id));
                    if (isDept && !deptLabel) { deptLabel = pLabel; deptQidsFound.push(pid); }
                    else if (isRegion && !regionLabel) { regionLabel = pLabel; }
                    else if (!deptLabel && !deptQidsFound.length) { deptLabel = pLabel; deptQidsFound.push(pid); }
                  }
                  if (!regionLabel && deptQidsFound.length > 0) {
                    const gpSet = new Set<string>();
                    for (const dqid of deptQidsFound.slice(0, 3)) {
                      for (const s of pData.entities?.[dqid]?.claims?.["P131"] ?? []) {
                        const gid = getStatementQid(s); if (gid) gpSet.add(gid);
                      }
                    }
                    const gpQids = [...gpSet].slice(0, 6);
                    if (gpQids.length > 0) {
                      try {
                        const gpResp = await wikiFetch(
                          `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(gpQids.join("|"))}&props=labels|claims&languages=fr&format=json`,
                        );
                        if (gpResp.ok) {
                          const gpData = await gpResp.json() as WbGetEntitiesDetailed;
                          for (const gpid of gpQids) {
                            const gpe = gpData.entities?.[gpid];
                            const gpLabel = gpe?.labels?.fr?.value ?? null;
                            if (!gpLabel) continue;
                            const gpTypeQids = (gpe?.claims?.["P31"] ?? [])
                              .map((s) => getStatementQid(s)).filter((id): id is string => id !== null);
                            if (gpTypeQids.some((id) => REGION_TYPE_QIDS.has(id))) {
                              regionLabel = gpLabel; break;
                            }
                          }
                        }
                      } catch { /* non bloquant */ }
                    }
                  }
                }
              } catch { /* non bloquant */ }
            }
          }
        }
      } catch { /* non bloquant */ }

      const parts: string[] = [];
      if (deptLabel && regionLabel) {
        parts.push(`${communeLabel} est une commune française située dans le département ${deptLabel}, en région ${regionLabel}.`);
      } else if (deptLabel) {
        parts.push(`${communeLabel} est une commune française du département ${deptLabel}.`);
      } else if (communeDescription) {
        const cap = communeDescription.charAt(0).toUpperCase() + communeDescription.slice(1);
        parts.push(`${communeLabel} est ${cap}.`);
      } else {
        parts.push(`${communeLabel} est une commune française.`);
      }
      if (communeDescription && hasTextSignalCommune(communeDescription)) {
        const descCap = communeDescription.charAt(0).toUpperCase() + communeDescription.slice(1);
        if (!parts[0].toLowerCase().includes(descCap.slice(0, 20).toLowerCase())) {
          parts.push(`${descCap}.`);
        }
      }
      const narrative = formatCommuneNarrative(parts.join(" "));
      if (narrative.length < 20) continue;
      const result = { narrative, qid, deptLabel, regionLabel };
      cacheSet(wdFallbackCache, cacheKey, result); return result;
    }

    warnings.push(`[wikimedia] Wikidata: aucune entité commune FR trouvée pour "${city}".`);
    cacheSet(wdFallbackCache, cacheKey, null); return null;
  } catch (err) {
    console.warn(`[wikimedia] fetchWikidataFallback("${city}"): ${(err as Error).message}`);
    cacheSet(wdFallbackCache, cacheKey, null); return null;
  }
}// --- fetchWikidataProfile ----------------------------------------------------

async function fetchWikidataProfile(qid: string, warnings: string[]): Promise<WikimediaProfile | null> {
  const cacheKey = `wdprofile:${qid}`;
  const cached = cacheGet(wdProfileCache, cacheKey);
  if (cached.hit) return cached.value;
  try {
    const resp = await wikiFetch(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=claims&languages=fr&format=json`,
    );
    if (!resp.ok) { cacheSet(wdProfileCache, cacheKey, null); return null; }
    const entity = (await resp.json() as WbGetEntitiesDetailed)?.entities?.[qid];
    if (!entity) { cacheSet(wdProfileCache, cacheKey, null); return null; }
    const claims = entity.claims ?? {};

    const popData    = extractBestPopulation(claims["P1082"] ?? []);
    const coordinates = extractCoordinatesFromClaims(claims);

    let country: string | null = null;
    const countryQid = getStatementQid(claims["P17"]?.[0]);
    if (countryQid) {
      country = KNOWN_COUNTRY_QIDS[countryQid] ?? null;
      if (!country) {
        try {
          const cResp = await wikiFetch(
            `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(countryQid)}&props=labels&languages=fr&format=json`,
          );
          if (cResp.ok) {
            country = (await cResp.json() as WbGetEntitiesDetailed)?.entities?.[countryQid]?.labels?.fr?.value ?? null;
          }
        } catch { /* non bloquant */ }
      }
    }

    let department: string | null = null, region: string | null = null;
    const parentQids = (claims["P131"] ?? [])
      .map((s) => getStatementQid(s)).filter((id): id is string => id !== null).slice(0, 12);

    if (parentQids.length > 0) {
      let pData: WbGetEntitiesDetailed | null = null;
      try {
        const pResp = await wikiFetch(
          `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(parentQids.join("|"))}&props=labels|claims&languages=fr&format=json`,
        );
        if (pResp.ok) pData = await pResp.json() as WbGetEntitiesDetailed;
      } catch (e) {
        warnings.push(`[wikimedia] fetchWikidataProfile P131 L1 (${qid}): ${(e as Error).message}`);
      }

      if (pData) {
        const deptQidsFound: string[] = [];
        for (const pid of parentQids) {
          const pe = pData.entities?.[pid];
          const pLabel = pe?.labels?.fr?.value ?? null;
          if (!pLabel) continue;
          const typeQids = (pe?.claims?.["P31"] ?? [])
            .map((s) => getStatementQid(s)).filter((id): id is string => id !== null);
          const isDept   = typeQids.some((id) => DEPT_TYPE_QIDS.has(id));
          const isRegion = typeQids.some((id) => REGION_TYPE_QIDS.has(id));
          if (isDept && !department) { department = pLabel; deptQidsFound.push(pid); }
          else if (isRegion && !region) { region = pLabel; }
        }
        if (!department && parentQids.length > 0) {
          const firstLabel = pData.entities?.[parentQids[0]]?.labels?.fr?.value ?? null;
          if (firstLabel) { department = firstLabel; deptQidsFound.push(parentQids[0]); }
        }
        if (!region && deptQidsFound.length > 0) {
          const gpSet = new Set<string>();
          for (const dqid of deptQidsFound.slice(0, 3)) {
            for (const s of pData.entities?.[dqid]?.claims?.["P131"] ?? []) {
              const gid = getStatementQid(s); if (gid) gpSet.add(gid);
            }
          }
          const gpQids = [...gpSet].slice(0, 8);
          if (gpQids.length > 0) {
            try {
              const gpResp = await wikiFetch(
                `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(gpQids.join("|"))}&props=labels|claims&languages=fr&format=json`,
              );
              if (gpResp.ok) {
                const gpData = await gpResp.json() as WbGetEntitiesDetailed;
                for (const gpid of gpQids) {
                  const gpe = gpData.entities?.[gpid];
                  const gpLabel = gpe?.labels?.fr?.value ?? null;
                  if (!gpLabel) continue;
                  const gpTypeQids = (gpe?.claims?.["P31"] ?? [])
                    .map((s) => getStatementQid(s)).filter((id): id is string => id !== null);
                  if (gpTypeQids.some((id) => REGION_TYPE_QIDS.has(id))) { region = gpLabel; break; }
                }
              }
            } catch (e) {
              warnings.push(`[wikimedia] fetchWikidataProfile P131 L2 (${qid}): ${(e as Error).message}`);
            }
          }
        }
      }
    }

    const normalizedRegion =
      region && normalizeStr(region) === "paris" ? "Île-de-France" : region;

    const profile: WikimediaProfile = {
      population: popData?.amount ?? null,
      populationYear: popData?.year ?? null,
      country,
      department,
      region: normalizedRegion,
      adminSummary: null,
      transportSummary: null,
      economySummary: null,
      amenitiesSummary: null,
      residentialSummary: null,
      streetSummary: null,
      universitySummary: null,
      hospitalSummary: null,
      parkSummary: null,
      cultureSummary: null,
      transportSentences: [],
      economySentences: [],
      amenitiesSentences: [],
      parkSentences: [],
      cultureSentences: [],
      coordinates,
      sources: { wikidata: `https://www.wikidata.org/wiki/${qid}` },
    };
    cacheSet(wdProfileCache, cacheKey, profile); return profile;
  } catch (err) {
    warnings.push(`[wikimedia] fetchWikidataProfile(${qid}): ${(err as Error).message}`);
    cacheSet(wdProfileCache, cacheKey, null); return null;
  }
}

// --- buildAILocalContext -----------------------------------------------------
// Synthèse IA orientée immobilier à partir des extraits Wikipedia bruts.
// Remplace le P2 mécanique de buildRichLocalContext quand les données sont
// disponibles. Non bloquant : retourne null en cas d'échec ou résultat trop court.

async function buildAILocalContext(
  apiKey: string,
  model: string,
  cityLabel: string,
  streetExtract: string | null,
  quartierExtract: string | null,
  wpExtractRaw: string | null,
  profile: WikimediaProfile | null,
): Promise<string | null> {
  // APRÈS
  // Filtre les phrases encyclopédiques inutiles avant d'envoyer au modèle
  const STREET_NOISE_REGEX =
    /pont|passerelle|franchit|parallèle|parallele|prolongée|prolongee|tracé|trace\b|coupe l'|à hauteur de|à l'est|à l'ouest|rue de [A-Z]|rue [A-Z][a-z]+\s*,|boulevard des|avenue du|place [A-Z]/i;

  function filterExtractForAI(raw: string, maxChars: number): string {
    const sentences = splitSentences(cleanWikipediaExtract(raw));
    const kept = sentences.filter((s) => {
      if (RENAME_HISTORY_SENTENCE_REGEX.test(s)) return false;
      if (isLowValueGeoSentence(s)) return false;
      if (STREET_NOISE_REGEX.test(s)) return false;
      return true;
    });
    return kept.join(" ").slice(0, maxChars).trim();
  }

  const parts: string[] = [];
  if (streetExtract) {
    const filtered = filterExtractForAI(streetExtract, 1200);
    if (filtered.length > 40) parts.push(`=== Contexte RUE ===\n${filtered}`);
  }
  if (quartierExtract) {
    const filtered = filterExtractForAI(quartierExtract, 1200);
    if (filtered.length > 40) parts.push(`=== Contexte QUARTIER ===\n${filtered}`);
  }
  if (wpExtractRaw) {
    const filtered = filterExtractForAI(wpExtractRaw, 800);
    if (filtered.length > 40) parts.push(`=== Contexte COMMUNE ===\n${filtered}`);
  }
  if (parts.length === 0) return null;

  const popInfo = profile?.population
    ? `, ${profile.population.toLocaleString("fr-FR")} habitants (${profile.populationYear ?? "?"})`
    : "";

  const prompt =
    `Tu es un expert immobilier français. À partir des extraits Wikipedia ci-dessous sur "${cityLabel}"${popInfo}, rédige 3 à 5 phrases de contexte local pour un investisseur immobilier.\n\n` +
    `INCLURE : ambiance et tissu du quartier, commerces et vie de rue, transports en commun (métro, RER, tram), équipements (écoles, parcs, marchés), caractère résidentiel.\n` +
    `EXCLURE ABSOLUMENT : dimensions métriques, numéros de rues adjacentes, détails de ponts/passerelles/franchissements, historique de renommage, renvois vers d'autres arrondissements ou communes.\n` +
    `Style : factuel, neutre, professionnel. Phrases complètes. Pas de superlatifs. Pas de markdown. Pas d'introduction.\n` +
    `Réponds uniquement avec le texte.\n\n` +
    parts.join("\n\n");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      console.warn("[WIKIMEDIA][5/AI_CONTEXT] appel échoué:", response.status);
      return null;
    }
    const data = await response.json() as AnthropicMessagesResponse;
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    if (!text || text.length < 60) return null;
    return safeUtf8Fix(text);
  } catch (err) {
    console.warn("[WIKIMEDIA][5/AI_CONTEXT] exception:", (err as Error).message);
    return null;
  }
}

// --- resolveWikimedia --------------------------------------------------------

async function resolveWikimedia(
  context: Record<string, unknown>,
  warnings: string[],
  apiKey?: string,
  model?: string,
): Promise<WikimediaBlock | null> {
  // ── 1️⃣  Entrée resolveWikimedia ─────────────────────────────────────────
  console.log(
    "[WIKIMEDIA][1/INPUT]",
    `adresse="${context["address"] ?? context["adresse"] ?? "(absent)"}"`,
    `| ville_brute="${context["city"] ?? context["ville"] ?? context["commune"] ?? "(absent)"}"`,
    `| cp="${context["zipCode"] ?? context["cp"] ?? "(absent)"}"`,
  );

  const rawCity = getStringFromContext(context, ["city", "ville", "commune"]);
  if (!rawCity) {
    console.warn("[WIKIMEDIA] city introuvable dans le context");
    return null;
  }

  const city    = normalizeCityName(rawCity);
  const zipCode = getStringFromContext(context, ["zipCode", "cp", "codePostal"]);

  console.log(
    "[WIKIMEDIA][1/PARSED]",
    `city="${city}"`,
    `| zip="${zipCode ?? "(absent)"}"`,
  );

  let narrative: string | null = null;
  let source: "wikipedia" | "wikidata" | null = null;
  let title: string | null = null;
  let qid: string | null = null;
  let profile: WikimediaProfile | null = null;
  let wpExtractRaw: string | null = null;
  let streetExtract: string | null = null;
  let quartierExtract: string | null = null;
  let mergedExtract: string | null = null;
  let wikipediaUrl: string | undefined, wikidataUrl: string | undefined;
  let qualityOk = false, qualityReason: string | undefined;

  const rawAddress = getStringFromContext(context, ["address", "adresse"]);
  const streetName = extractStreetNameFromAddress(rawAddress ?? null);
  console.log("[WIKIMEDIA][1/STREET_NAME]", streetName ?? "(non détectée)");

  try {
    // ── 2️⃣  Wikipedia ville ──────────────────────────────────────────────
    const wpResult = await fetchWikipediaExtract(city, warnings);
    console.log(
      "[WIKIMEDIA][2/CITY]",
      wpResult
        ? `ok=oui | title="${wpResult.title}" | qid=${wpResult.qid ?? "(absent)"} | len=${wpResult.extract.length}`
        : "ok=non",
    );

    if (wpResult) {
      wpExtractRaw = wpResult.extract;
      const formatted = formatCommuneNarrative(wpResult.extract);
      if (formatted.length >= WIKI_MIN_EXTRACT_LENGTH) {
        narrative = safeUtf8Fix(formatted);
        source = "wikipedia"; title = wpResult.title; qid = wpResult.qid;
        wikipediaUrl = wpResult.url;
        if (qid) wikidataUrl = `https://www.wikidata.org/wiki/${qid}`;
        qualityOk = true;
      } else {
        warnings.push(
          `[wikimedia] Wikipedia "${wpResult.title}": narratif trop court (${formatted.length} chars) — rejeté.`,
        );
        qualityReason = `narratif trop court (${formatted.length} chars < ${WIKI_MIN_EXTRACT_LENGTH})`;
      }
    }

    if (!qualityOk) {
      const wdResult = await fetchWikidataFallback(city, warnings);
      if (wdResult) {
        narrative = safeUtf8Fix(wdResult.narrative);
        source = "wikidata"; title = city; qid = wdResult.qid;
        wikidataUrl = `https://www.wikidata.org/wiki/${qid}`;
        qualityOk = true;
        warnings.push(
          `[wikimedia] Wikipedia indisponible pour "${city}" — narratif Wikidata (${qid}).`,
        );
      } else {
        qualityReason = qualityReason ?? `Aucune source fiable trouvée pour "${city}".`;
      }
    }

    // ── 2b Wikipedia rue (best-effort) ────────────────────────────────────
    if (streetName) {
      try {
        const streetResult = await fetchWikipediaStreetExtract(streetName, warnings);
        if (streetResult) {
          streetExtract = streetResult.extract;
          console.log(
            "[WIKIMEDIA][2/STREET]",
            `title="${streetResult.title}" | len=${streetResult.extract.length}`,
          );
        } else {
          console.log("[WIKIMEDIA][2/STREET]", "absent");
        }
      } catch { /* non bloquant */ }
    }

    // ── 2c Wikipedia quartier (best-effort) ───────────────────────────────
    try {
      const quartierResult = await fetchWikipediaQuartierExtract(
        rawCity, zipCode, streetName, warnings,
      );
      if (quartierResult) {
        quartierExtract = quartierResult.extract;
        console.log(
          "[WIKIMEDIA][2/QUARTIER]",
          `title="${quartierResult.title}" | len=${quartierResult.extract.length}`,
        );
        warnings.push(`[wikimedia] Quartier trouvé : "${quartierResult.title}" — ${quartierResult.url}`);
      } else {
        console.log("[WIKIMEDIA][2/QUARTIER]", "absent");
      }
    } catch { /* non bloquant */ }

    // ── 3️⃣  mergedExtract ────────────────────────────────────────────────
    const mergedExtractParts: string[] = [];
    if (streetExtract)   mergedExtractParts.push(cleanWikipediaExtract(streetExtract));
    if (quartierExtract) mergedExtractParts.push(cleanWikipediaExtract(quartierExtract));
    if (wpExtractRaw)    mergedExtractParts.push(cleanWikipediaExtract(wpExtractRaw));
    mergedExtract = mergedExtractParts.length > 0
      ? mergedExtractParts.join(" ")
      : null;

    console.log(
      "[WIKIMEDIA][3/MERGE]",
      `street=${streetExtract ? "oui" : "non"}`,
      `| quartier=${quartierExtract ? "oui" : "non"}`,
      `| ville=${wpExtractRaw ? "oui" : "non"}`,
      `| merged_len=${mergedExtract?.length ?? 0}`,
    );

    // ── 4️⃣  Profil Wikidata ──────────────────────────────────────────────
    if (qid) {
      profile = await fetchWikidataProfile(qid, warnings);

      if (profile) {
        if (wikipediaUrl) profile.sources.wikipedia = wikipediaUrl;

        if (profile.department && profile.region) {
          profile.adminSummary = `${city} se situe dans le département ${profile.department}, en région ${profile.region}.`;
        } else if (profile.department) {
          profile.adminSummary = `${city} se situe dans le département ${profile.department}.`;
        }

        if (mergedExtract) {
          const tSentences = extractThematicSentences(mergedExtract, TRANSPORT_KEYWORDS, 2);
          if (tSentences.length > 0) {
            profile.transportSummary = safeUtf8Fix(tSentences[0]);
            profile.transportSentences = tSentences.map(safeUtf8Fix);
          }

          const eSentences = extractThematicSentences(mergedExtract, ECONOMY_KEYWORDS, 2);
          if (eSentences.length > 0) {
            profile.economySummary = safeUtf8Fix(eSentences[0]);
            profile.economySentences = eSentences.map(safeUtf8Fix);
          }

          const aSentences = extractThematicSentences(mergedExtract, AMENITIES_KEYWORDS, 2);
          if (aSentences.length > 0) {
            profile.amenitiesSummary = safeUtf8Fix(aSentences[0]);
            profile.amenitiesSentences = aSentences.map(safeUtf8Fix);
          }

          const rs = extractThematicSentence(mergedExtract, RESIDENTIAL_KEYWORDS);
          if (rs) profile.residentialSummary = safeUtf8Fix(rs);

          const uSentences = extractThematicSentences(mergedExtract, UNIVERSITY_KEYWORDS, 1);
          if (uSentences.length > 0) profile.universitySummary = safeUtf8Fix(uSentences[0]);

          const hSentences = extractThematicSentences(mergedExtract, HOSPITAL_KEYWORDS, 1);
          if (hSentences.length > 0) profile.hospitalSummary = safeUtf8Fix(hSentences[0]);

          const pSentences = extractThematicSentences(mergedExtract, PARK_KEYWORDS, 2);
          if (pSentences.length > 0) {
            profile.parkSummary = safeUtf8Fix(pSentences[0]);
            profile.parkSentences = pSentences.map(safeUtf8Fix);
          }

          const cSentences = extractThematicSentences(mergedExtract, CULTURE_KEYWORDS, 2);
          if (cSentences.length > 0) {
            profile.cultureSummary = safeUtf8Fix(cSentences[0]);
            profile.cultureSentences = cSentences.map(safeUtf8Fix);
          }
        }

        if (streetExtract) {
          const ss = extractThematicSentence(streetExtract, STREET_KEYWORDS);
          if (ss) profile.streetSummary = safeUtf8Fix(ss);
        }

        console.log(
          "[WIKIMEDIA][4/PROFILE_GEO]",
          `pop=${profile.population ?? "(absent)"}(${profile.populationYear ?? "?"})`,
          `| dept="${profile.department ?? "(absent)"}"`,
          `| region="${profile.region ?? "(absent)"}"`,
        );
        const p4Summaries: [string, string | null][] = [
          ["transport",   profile.transportSummary],
          ["amenities",   profile.amenitiesSummary],
          ["residential", profile.residentialSummary],
          ["street",      profile.streetSummary],
          ["economy",     profile.economySummary],
          ["university",  profile.universitySummary],
          ["hospital",    profile.hospitalSummary],
          ["park",        profile.parkSummary],
          ["culture",     profile.cultureSummary],
        ];
        for (const [key, val] of p4Summaries) {
          if (val) console.log(`[WIKIMEDIA][4/SUMMARY_${key.toUpperCase()}]`, val.slice(0, 100));
        }

        if (qualityOk) {
          const opts    = narrativeOptionsForPopulation(profile.population);
          const isLarge = profile.population !== null &&
            profile.population >= POPULATION_LARGE_THRESHOLD;

          const guaranteedSentences: string[] = [];
          if (profile.adminSummary) guaranteedSentences.push(profile.adminSummary);
          if (profile.population !== null) {
            const popStr  = profile.population.toLocaleString("fr-FR");
            const yearStr = profile.populationYear
              ? ` (recensement ${profile.populationYear})`
              : "";
            guaranteedSentences.push(
              `La commune compte environ ${popStr} habitants${yearStr}.`,
            );
          }

          const geoSlots = Math.max(opts.maxSentences - guaranteedSentences.length, 1);

          const geoSentences: string[] = [];
          if (wpExtractRaw) {
            const geoNarrative = formatCommuneNarrative(wpExtractRaw, {
              ...opts,
              maxSentences: geoSlots,
            });
            if (geoNarrative.length >= WIKI_MIN_EXTRACT_LENGTH) {
              geoSentences.push(geoNarrative);
            }
          } else if (narrative) {
            geoSentences.push(narrative);
          }

          const transportSentences: string[] = [];
          if (isLarge && profile.transportSummary) {
            const usedSentences = geoSentences.length + guaranteedSentences.length;
            if (usedSentences < opts.maxSentences) {
              transportSentences.push(profile.transportSummary);
            }
          }

          const allParts = [
            ...guaranteedSentences,
            ...geoSentences,
            ...transportSentences,
          ];

          const richNarrative = buildNarrativeFromParts(
            allParts,
            opts.maxSentences,
            opts.maxChars,
          );

          let candidate: string | null = null;

          if (richNarrative.length >= WIKI_MIN_EXTRACT_LENGTH) {
            if (isLarge) {
              const prev = narrative ?? "";
              const best = richNarrative.length > prev.length ? richNarrative : prev;
              const completed = ensureMinCharsFromWikipedia(best, wpExtractRaw, opts);
              if (completed.length < opts.minChars) {
                warnings.push(
                  `[wikimedia] Narratif grande commune "${city}" : ${completed.length} chars < minChars (${opts.minChars}) — Wikipedia insuffisant après complétion.`,
                );
              }
              candidate = safeUtf8Fix(completed);
            } else {
              candidate = safeUtf8Fix(richNarrative);
            }
          } else {
            candidate = narrative ? safeUtf8Fix(narrative) : null;
          }

          const adapted = buildRealEstateNarrative(candidate, profile, title ?? city);
          if (adapted && adapted.length >= WIKI_MIN_EXTRACT_LENGTH) {
            narrative = adapted;
          } else if (candidate && candidate.length >= WIKI_MIN_EXTRACT_LENGTH) {
            narrative = candidate;
          }
        }

        if (!narrative || narrative.length < WIKI_MIN_EXTRACT_LENGTH) {
          const fallbackNarrative = buildRealEstateNarrative(
            profile.adminSummary ?? null,
            profile,
            title ?? city,
          );
          if (fallbackNarrative && fallbackNarrative.length >= WIKI_MIN_EXTRACT_LENGTH) {
            narrative = fallbackNarrative;
            qualityOk = true;
            warnings.push(
              `[wikimedia] Narratif construit depuis profil Wikidata (adminSummary/population) pour "${rawCity}".`,
            );
          }
        }
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`[wikimedia] resolveWikimedia("${city}"): ${msg}`);
    warnings.push(`[wikimedia] Enrichissement échoué pour "${city}" — ${msg}`);
    qualityReason = `Erreur: ${msg}`;
  }

  if ((!narrative || !narrative.trim()) && profile) {
    const fallbackNarrative = buildRealEstateNarrative(
      profile.adminSummary ?? null,
      profile,
      title ?? city,
    );
    if (fallbackNarrative) {
      narrative = fallbackNarrative;
      warnings.push(`[wikimedia] Fallback narratif immobilier appliqué pour "${city}".`);
    }
  }

  // ── 5️⃣  buildRichLocalContext + injection synthèse IA ───────────────────
  const richContext = buildRichLocalContext(
    profile,
    title ?? city,
    streetExtract,
    mergedExtract ?? wpExtractRaw,
  );

  // Synthèse IA : remplace P2 si disponible
  if (apiKey && model && (streetExtract || quartierExtract || wpExtractRaw)) {
    try {
      const aiLocalContext = await buildAILocalContext(
        apiKey, model,
        title ?? city,
        streetExtract,
        quartierExtract,
        wpExtractRaw,
        profile,
      );
      if (aiLocalContext) {
        console.log("[WIKIMEDIA][5/AI_CONTEXT]", aiLocalContext.slice(0, 150));
        // Reconstruire context.long : P1 + synthèse IA + P3
        const paragraphs = (richContext.long ?? "").split("\n\n");
        const p1 = paragraphs[0] ?? richContext.short ?? "";
        const p3 = paragraphs.length >= 3 ? paragraphs[paragraphs.length - 1] : (paragraphs[1] ?? "");
        // P3 = lecture immobilière — on la conserve même courte
        richContext.long = [p1, aiLocalContext, p3]
          .filter((p, i) => i === 2 ? p.trim().length > 0 : p.trim().length >= 20)
          .join("\n\n");
        // short reste inchangé (portrait géo P1)
      } else {
        console.log("[WIKIMEDIA][5/AI_CONTEXT]", "absent ou trop court — fallback mécanique conservé");
      }
    } catch { /* non bloquant */ }
  }

  const countSentences = (text: string | null): number =>
    text ? (text.match(/[^.!?]+[.!?]+/g) ?? []).length : 0;

  console.log(
    "[WIKIMEDIA][5/CONTEXT]",
    `short_len=${richContext.short?.length ?? 0}(${countSentences(richContext.short)}ph)`,
    `| long_len=${richContext.long?.length ?? 0}(${countSentences(richContext.long)}ph)`,
  );
  if (richContext.short) {
    console.log("[WIKIMEDIA][5/SHORT_PREVIEW]", richContext.short.slice(0, 150));
  }
  if (richContext.long && richContext.long !== richContext.short) {
    const longP2start = richContext.long.split("\n\n")[1]?.slice(0, 120);
    if (longP2start) console.log("[WIKIMEDIA][5/LONG_P2_PREVIEW]", longP2start);
  }

  const sources: WikimediaBlock["sources"] = {};
  if (wikipediaUrl) sources.wikipediaUrl = wikipediaUrl;
  if (wikidataUrl)  sources.wikidataUrl  = wikidataUrl;

  // ── 6️⃣  Résultat final resolveWikimedia ──────────────────────────────────
  console.log(
    "[WIKIMEDIA][6/FINAL]",
    `ok=${qualityOk}`,
    `| src=${source ?? "(aucune)"}`,
    `| qid=${qid ?? "(absent)"}`,
    `| narrative_len=${narrative?.length ?? 0}`,
    `| short_len=${richContext.short?.length ?? 0}`,
    `| long_len=${richContext.long?.length ?? 0}`,
  );
  if (narrative) console.log("[WIKIMEDIA][6/NARRATIVE_PREVIEW]", narrative.slice(0, 150));

  return {
    place: {
      query: { city: rawCity, zipCode },
      narrative,
      context: { short: richContext.short, long: richContext.long },
      profile: profile ?? null,
      source,
      title,
      qid,
    },
    sources,
    quality: qualityOk ? { ok: true } : { ok: false, reason: qualityReason },
  };
}// --- buildSystemPrompt -------------------------------------------------------

function buildSystemPrompt(): string {
  const SEP = "\u2500".repeat(32);
  return [
    "Tu es un DIRECTEUR D\u2019INVESTISSEMENT VIRTUEL (immobilier).",
    "",
    "Ton r\u00f4le n\u2019est PAS d\u2019analyser passivement : ton r\u00f4le est de DIRE QUOI FAIRE, de fa\u00e7on ex\u00e9cutable imm\u00e9diatement, m\u00eame pour un investisseur d\u00e9butant.",
    "",
    SEP, "OBJECTIF PRIORITAIRE", SEP,
    "",
    "Fournir une conclusion ultra lisible :",
    "* \u00e9tat du march\u00e9",
    "* d\u00e9cision conseill\u00e9e",
    "* quoi faire maintenant",
    "* conditions d\u2019achat",
    "* prix maximum si possible",
    "",
    "Chaque analyse doit permettre \u00e0 un investisseur de r\u00e9pondre imm\u00e9diatement \u00e0 la question :",
    "\"Est-ce que j\u2019ach\u00e8te ou pas, et \u00e0 quel prix ?\"",
    "",
    SEP, "R\u00c8GLES STRICTES", SEP,
    "",
    "1. Tu r\u00e9ponds UNIQUEMENT en JSON valide. Aucun texte avant ou apr\u00e8s. Aucun markdown. Aucun commentaire.",
    "",
    "2. Z\u00e9ro hallucination.",
    "   Si une donn\u00e9e n\u2019est pas pr\u00e9sente dans les informations fournies :",
    "   * \u00e9crire : \"Information non fournie dans les donn\u00e9es analys\u00e9es.\"",
    "   * ou mettre null pour une valeur num\u00e9rique",
    "   * ajouter l\u2019\u00e9l\u00e9ment dans missingData",
    "",
    "3. Tu dois \u00eatre DIRECT, p\u00e9dagogique, sans jargon inutile.",
    "4. Les phrases doivent \u00eatre courtes et compr\u00e9hensibles par un investisseur non expert.",
    "5. Anglicismes interdits : deal, upside, momentum, cushion, flip, etc.",
    "6. Si tu utilises un terme technique (marge, TRI, rendement), explique-le simplement.",
    "7. Si les donn\u00e9es sont insuffisantes : verdict = GO_AVEC_RESERVES, confidence faible, missingData d\u00e9taill\u00e9.",
    "",
    SEP, "R\u00c8GLE DE CALCUL DES CO\u00dbTS", SEP,
    "",
    "Pour toute analyse de marge, rentabilit\u00e9 ou s\u00e9curit\u00e9 financi\u00e8re :",
    "UTILISE TOUJOURS en priorit\u00e9 : computed.operationSheet.coutTotalEur",
    "Ce montant inclut : prix d\u2019acquisition + travaux + frais de notaire.",
    "Si absent, utilise : prixAcquisition + travaux + fraisNotaire.",
    "Interdiction d\u2019ignorer les frais de notaire si une estimation est disponible.",
    "",
    SEP, "CONTEXTE LOCAL (WIKIMEDIA)", SEP,
    "",
    "Les informations de contexte local peuvent provenir uniquement de :",
    "context.wikimedia.place.narrative",
    "context.wikimedia.place.context.long",
    "Si ces données sont disponibles, tu dois les intégrer dans narrativeMarkdown sous forme d'un court passage contextualisant la commune, le quartier et la rue, sans hallucination et sans dépasser 6 lignes de contenu local.",
    "Tu peux utiliser context.wikimedia.place.context.long pour enrichir la section contexte local du narrativeMarkdown.",
    "",
    SEP, "FORMULATIONS STRICTEMENT INTERDITES", SEP,
    "",
    "Tu n\u2019as PAS le droit d\u2019\u00e9crire ou de sugg\u00e9rer que la ville :",
    "* n\u2019existe pas / est inexistante / est introuvable",
    "* ne correspond \u00e0 aucune r\u00e9alit\u00e9 / donn\u00e9e connue / commune inexistante",
    "Toute formulation \u00e9quivalente est interdite.",
    "",
    SEP, "PHRASE DE REMPLACEMENT OBLIGATOIRE", SEP,
    "",
    "Si la localisation ne peut pas \u00eatre v\u00e9rifi\u00e9e avec les donn\u00e9es fournies, tu \u00e9cris STRICTEMENT :",
    "\"Localisation non v\u00e9rifiable avec les donn\u00e9es fournies. V\u00e9rifiez la commune et le code postal via une source officielle (INSEE / service-public).\"",
    "Dans ce cas : ajoute \"verificationCommuneCodePostal\" dans missingData.",
    "",
    SEP, "SEUILS MIMMOZA", SEP,
    "",
    "* marge brute cible \u2265 12 %",
    "* rendement brut minimal \u2265 5 %",
    "* dur\u00e9e cible de d\u00e9tention \u2264 18 mois",
    "Notion cl\u00e9 : marge de s\u00e9curit\u00e9 (couvre travaux + al\u00e9as de march\u00e9 + dur\u00e9e de d\u00e9tention).",
    "",
    SEP, "STRUCTURE JSON \u00c0 PRODUIRE", SEP,
    "",
    "{",
    "  \"verdict\": \"GO\" | \"GO_AVEC_RESERVES\" | \"NO_GO\",",
    "  \"confidence\": <nombre entre 0 et 1>,",
    "  \"marketStatus\": {",
    "    \"label\": \"TRES_LIQUIDE\" | \"LIQUIDE\" | \"NEUTRE\" | \"TENDU\" | \"PEU_LIQUIDE\" | \"INCONNU\",",
    "    \"plainFrench\": \"<2 ou 3 phrases simples>\",",
    "    \"dvfSummary\": { \"nbTransactions\": <n|null>, \"medianPriceM2\": <n|null>, \"acquisitionPriceM2\": <n|null>, \"premiumVsDvfPct\": <n|null> }",
    "  },",
    "  \"conclusion\": {",
    "    \"decisionToday\": \"<1 phrase claire>\",",
    "    \"decisionAdvised\": \"ACHETER\" | \"NEGOCIER\" | \"ATTENDRE\" | \"RENOCER\" | \"INCONNU\",",
    "    \"whyInPlainFrench\": [\"<max 3 raisons>\"],",
    "    \"whatToDoNow\": [\"<max 6 actions concrètes>\"],",
    "    \"conditionsToBuy\": [\"<max 6 conditions>\"],",
    "    \"maxEngagementPriceEur\": <n|null>,",
    "    \"neverExceedPriceEur\": <n|null>,",
    "    \"afterVerificationDecision\": \"<1 phrase>\"",
    "  },",
    "  \"executiveSummary\": \"<3 à 5 phrases simples>\",",
    "  \"narrativeMarkdown\": \"<markdown structuré, 6 à 12 paragraphes, lisible, orienté décision, intégrant le contexte local (commune, quartier, rue, équipements) si context.wikimedia.place.context.long est disponible>\",",
    "  \"strengths\": [\"<max 5>\"],",
    "  \"vigilances\": [\"<max 5>\"],",
    "  \"sensitivities\": [\"<max 5>\"],",
    "  \"actionPlan\": [\"<max 6>\"],",
    "  \"missingData\": [\"<liste>\"],",
    "  \"finalSummary\": { ... } | null,",
    "  \"scenarios\": [ ... ] | null",
    "}",
    "",
    SEP, "BLOCS OPTIONNELS", SEP,
    "",
    "Si les donn\u00e9es sont insuffisantes : \"finalSummary\": null, \"scenarios\": null.",
    "NE JAMAIS inventer des sc\u00e9narios vides, dupliquer, g\u00e9n\u00e9rer des objets incomplets.",
    "",
    SEP,
    "",
    "R\u00e9ponds avec un seul objet JSON valide. Aucun texte hors JSON.",
  ].join("\n");
}

// --- Anthropic model selection -----------------------------------------------

interface AnthropicModelEntry { id?: string }
interface AnthropicModelsResponse { data?: AnthropicModelEntry[] }

async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const resp = await fetch("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Anthropic Models API error ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data: AnthropicModelsResponse = await resp.json();
  return Array.isArray(data?.data)
    ? data.data.map((m) => String(m?.id ?? "")).filter((s) => s.length > 0)
    : [];
}

function pickBestModel(available: string[]): string {
  return (
    available.find((id) => /sonnet/i.test(id)) ??
    available.find((id) => /opus/i.test(id)) ??
    available.find((id) => /haiku/i.test(id)) ??
    available[0] ?? ""
  );
}

interface AnthropicContentBlock { type: string; text?: string }
interface AnthropicMessagesResponse { content?: AnthropicContentBlock[]; model?: string }

async function callAnthropic(
  apiKey: string,
  model: string,
  context: Record<string, unknown>,
): Promise<{ rawText: string; model: string }> {
  const userMessage =
    `Voici les donnees du dossier immobilier a analyser (source de verite). N'invente rien.\n\n${JSON.stringify(context, null, 2)}\n\nProduis ton analyse investisseur en JSON strict. La conclusion doit etre ultra lisible (etat du marche + quoi faire + decision conseillee).`;

  const doCall = async (m: string): Promise<Response> =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: m, max_tokens: 6000, temperature: 0,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: userMessage }],
      }),
    });

  let response = await doCall(model);
  if (response.status === 404) {
    console.warn(`[export-report-v1] Modele "${model}" introuvable. Fallback...`);
    const available = await listAnthropicModels(apiKey);
    const fallback = pickBestModel(available);
    if (!fallback) throw new Error(`Modele "${model}" introuvable et aucun fallback.`);
    console.log(`[export-report-v1] Fallback vers: "${fallback}"`);
    response = await doCall(fallback);
    model = fallback;
  }
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorBody.slice(0, 500)}`);
  }
  const data: AnthropicMessagesResponse = await response.json();
  const rawText = data.content?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") ?? "";
  return { rawText, model: data.model ?? model };
}

async function callAnthropicRepair(
  apiKey: string,
  model: string,
  brokenRawText: string,
): Promise<{ rawText: string; model: string }> {
  const truncated = brokenRawText.slice(0, 8000);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 2000, temperature: 0,
      system: "Tu es un outil de reparation JSON. Renvoie UNIQUEMENT un objet JSON valide. Aucun texte avant/apres. Aucun markdown.",
      messages: [{
        role: "user",
        content: "Le JSON ci-dessous est invalide ou tronque. Repare-le et renvoie UNIQUEMENT un objet JSON valide. Conserve toutes les donnees existantes. Si des sections sont manquantes, ferme proprement l'objet JSON avec des tableaux vides ou null.\n\nJSON a reparer :\n" + truncated,
      }],
    }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic repair API error ${response.status}: ${errorBody.slice(0, 300)}`);
  }
  const data: AnthropicMessagesResponse = await response.json();
  const rawText = data.content?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") ?? "";
  return { rawText, model: data.model ?? model };
}

// --- Helpers fallback narrativeMarkdown --------------------------------------

function toSentence(value: string | null | undefined): string {
  const s = safeUtf8Fix((value ?? "").trim());
  if (!s) return "";
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function uniqueNonEmpty(lines: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const v = safeUtf8Fix((raw ?? "").trim());
    if (!v) continue;
    const key = v.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function buildFallbackNarrativeMarkdown(
  analysis: AnalysisResult,
  wikimediaBlock: WikimediaBlock | null,
  operationSheet: OperationSheet,
  fiscalite: FiscaliteLMNP | null,
  scoreRentaV2: ScoreRentabiliteV2,
): string {
  const parts: string[] = [];

  const decisionToday =
    analysis.conclusion?.decisionToday?.trim() ||
    analysis.executiveSummary?.trim() ||
    "Analyse disponible, mais données partielles à confirmer avant engagement.";

  const executiveSummary = analysis.executiveSummary?.trim() || "";
  const marketPlainFrench = analysis.marketStatus?.plainFrench?.trim() || "";
  const why = uniqueNonEmpty(analysis.conclusion?.whyInPlainFrench ?? []);
  const actions = uniqueNonEmpty(analysis.conclusion?.whatToDoNow ?? analysis.actionPlan ?? []);
  const conditions = uniqueNonEmpty(analysis.conclusion?.conditionsToBuy ?? []);

  const wikiContextLong = wikimediaBlock?.place?.context?.long?.trim() || "";
  const wikiNarrative   = wikimediaBlock?.place?.narrative?.trim() || "";
  const wikiContextText = wikiContextLong || wikiNarrative;

  const prixAchat = operationSheet.acquisitionPriceEur;
  const prixRevente = operationSheet.resaleTargetPriceEur;
  const coutTotal = operationSheet.coutTotalEur;
  const margeBrute = operationSheet.margeBruteEur;
  const margeBrutePct = operationSheet.margeBrutePct;
  const travaux = operationSheet.travauxEur;
  const surface = operationSheet.surfaceM2;
  const notaire = operationSheet.notaireEur;

  const financeLines = uniqueNonEmpty([
    prixAchat != null ? `Prix d'acquisition : ${prixAchat.toLocaleString("fr-FR")} €` : null,
    surface != null ? `Surface : ${surface.toLocaleString("fr-FR")} m²` : null,
    travaux != null ? `Travaux estimés : ${travaux.toLocaleString("fr-FR")} €` : null,
    notaire != null ? `Frais de notaire estimés : ${notaire.toLocaleString("fr-FR")} €` : null,
    coutTotal != null ? `Coût total engagé : ${coutTotal.toLocaleString("fr-FR")} €` : null,
    prixRevente != null ? `Prix de revente cible : ${prixRevente.toLocaleString("fr-FR")} €` : null,
    margeBrute != null
      ? `Marge brute estimée : ${margeBrute.toLocaleString("fr-FR")} €${margeBrutePct != null ? ` (${margeBrutePct.toLocaleString("fr-FR")} %)` : ""}`
      : null,
  ]);

  const rentaLine =
    scoreRentaV2.score != null
      ? `Score de rentabilité : ${scoreRentaV2.score}/100.`
      : null;

  const fiscalLine =
    fiscalite
      ? `Fiscalité LMNP réel simulée sur ${fiscalite.horizonAnnees} ans : cashflow net annuel ${Math.round(fiscalite.resultats.cashflowNetAnnuel).toLocaleString("fr-FR")} €, impôt annuel estimé ${Math.round(fiscalite.resultats.impotAnnuel).toLocaleString("fr-FR")} €.`
      : null;

  parts.push("## Synthèse de l'opération");
  parts.push(toSentence(decisionToday));
  if (executiveSummary) parts.push(toSentence(executiveSummary));

  if (marketPlainFrench) {
    parts.push("## Lecture du marché");
    parts.push(toSentence(marketPlainFrench));
  }

  if (wikiContextText) {
    parts.push("## Contexte local");
    parts.push(toSentence(wikiContextText));
  }

  if (financeLines.length > 0) {
    parts.push("## Chiffres clés");
    for (const line of financeLines) {
      parts.push(`- ${line}`);
    }
  }

  if (rentaLine || fiscalLine) {
    parts.push("## Rentabilité et structure économique");
    if (rentaLine) parts.push(rentaLine);
    if (fiscalLine) parts.push(fiscalLine);
  }

  if (why.length > 0) {
    parts.push("## Points favorables et points d'attention");
    for (const line of why.slice(0, 4)) {
      parts.push(`- ${toSentence(line)}`);
    }
  }

  if (conditions.length > 0) {
    parts.push("## Conditions d'achat");
    for (const line of conditions.slice(0, 6)) {
      parts.push(`- ${toSentence(line)}`);
    }
  }

  if (actions.length > 0) {
    parts.push("## Actions immédiates");
    for (const line of actions.slice(0, 6)) {
      parts.push(`- ${toSentence(line)}`);
    }
  }

  return parts.join("\n\n").trim();
}

// --- Main handler ------------------------------------------------------------

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body || !body.context) return jsonResponse({ ok: false, error: "Missing required field: context" }, 400);

    const context = body.context as Record<string, unknown>;
    const skipClaude = Boolean(body?.skipClaude);
    const apiKey = skipClaude ? "" : requireEnv("ANTHROPIC_API_KEY");

    let model = "";
    if (!skipClaude) {
      const forced = Deno.env.get("ANTHROPIC_MODEL")?.trim() || "";
      model = forced;
      if (!model) {
        const available = await listAnthropicModels(apiKey);
        model = pickBestModel(available);
        if (!model) throw new Error("Aucun modele Anthropic disponible (liste vide).");
        console.log(`[export-report-v1] Modele auto-selectionne: "${model}"`);
      }
    }

    const wikimediaWarnings: string[] = [];
    // Passer apiKey + model pour activer la synthèse IA du contexte local
    const wikimediaBlock = await resolveWikimedia(
      context,
      wikimediaWarnings,
      skipClaude ? undefined : apiKey,
      skipClaude ? undefined : model,
    );

    const contextForClaude: Record<string, unknown> = { ...context, wikimedia: wikimediaBlock ?? null };
    const sourceHash = await sha256Hex(JSON.stringify(canonicalize(context)));

    let usedModel = model;
    let parsed: AnalysisResult | null = null;
    let errors: string[] = [];

    if (!skipClaude) {
      const resp = await callAnthropic(apiKey, model, contextForClaude);
      usedModel = resp.model;
      console.log("[export-report-v1] rawText len=", resp.rawText.length);
      console.log("[export-report-v1] rawText head=", resp.rawText.slice(0, 300));
      console.log("[export-report-v1] rawText tail=", resp.rawText.slice(-300));

      const out = safeParseClaudeJson(resp.rawText);
      parsed = out.parsed; errors = out.errors;

      if (!parsed) {
        console.warn(`[export-report-v1] Parsing echoue (${errors.length} erreur(s)). Repair...`);
        try {
          const repairResp = await callAnthropicRepair(apiKey, usedModel, resp.rawText);
          console.log("[export-report-v1] Repair len=", repairResp.rawText.length);
          const repairOut = safeParseClaudeJson(repairResp.rawText);
          if (repairOut.parsed) {
            parsed = repairOut.parsed;
            errors = [...errors, "REPAIR: parsing initial echoue, repare via 2e appel.", ...repairOut.errors];
            usedModel = repairResp.model;
          } else {
            errors = [...errors, "REPAIR: 2e appel aussi echoue.", ...repairOut.errors];
            return jsonResponse({ ok: false, error: "Echec parsing (y compris repair)", details: errors, rawText: repairResp.rawText.slice(0, 800), model: usedModel, promptVersion: PROMPT_VERSION, sourceHash, generatedAt: new Date().toISOString() }, 502);
          }
        } catch (repairErr) {
          const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
          errors.push(`REPAIR: appel echoue -- ${msg}`);
          return jsonResponse({ ok: false, error: "Echec parsing (repair impossible)", details: errors, model: usedModel, promptVersion: PROMPT_VERSION, sourceHash, generatedAt: new Date().toISOString() }, 502);
        }
      }
    } else {
      parsed = {
        verdict: "GO_AVEC_RESERVES",
        confidence: 0.2,
        executiveSummary: "Mode test (skipClaude).",
        narrativeMarkdown: "",
        strengths: [],
        vigilances: [],
        sensitivities: [],
        actionPlan: [],
        missingData: [],
      };
      usedModel = "none (skipClaude)";
      errors = ["skipClaude=true : appel Claude ignore."];
    }

    const analysis = parsed!;
    const missingDataServer = computeMissingDataServer(context);
    analysis.missingData = enrichMissingDataFromServer(analysis.missingData, missingDataServer);

    if (!wikimediaBlock || !wikimediaBlock.quality.ok) {
      if (!analysis.missingData.some((e) => e.toLowerCase().includes("contextelocal"))) {
        analysis.missingData.push("contexteLocal");
      }
    }

    {
      const seen = new Map<string, number>();
      const deduped: string[] = [];
      for (const entry of analysis.missingData) {
        const key = entry.toLowerCase().replace(/\s+/g, "");
        const nk = key.includes("contextelocal") ? "contextelocal" : key;
        const idx = seen.get(nk);
        if (idx === undefined) { seen.set(nk, deduped.length); deduped.push(entry); }
        else if (entry.length > deduped[idx].length) deduped[idx] = entry;
      }
      analysis.missingData = deduped;
    }

    const operationSheet  = computeOperationSheet(context);
    const fiscalite       = computeFiscaliteLMNP(context);
    const fiscalScore     = computeFiscalScore(context, fiscalite);
    const scoreRentaV2    = computeScoreRentabiliteV2(context, fiscalite, fiscalScore);

    const liquiditeScore      = getScoreFromContext(context, ["liquidite", "liquiditeScore", "scoreLiquidite", "liquidity", "liquidityScore"]);
    const opportuniteScore    = getScoreFromContext(context, ["opportunite", "opportunity", "opportunityScore", "scoreOpportunite"]);
    const robustesseScore     = getScoreFromContext(context, ["robustesse", "robustesseScore", "scoreRobustesse"]);
    const pressionRisqueScore = getScoreFromContext(context, ["pressionRisque", "riskPressure", "riskPressureIndex", "riskScore", "scoreRisque"]);
    const rentabiliteScore    = scoreRentaV2.score !== null
      ? scoreRentaV2.score
      : getScoreFromContext(context, ["rentabilite", "rentabiliteScore", "scoreRentabilite"]);

    const smartScoreResult = computeSmartScore({
      liquidite: liquiditeScore, opportunite: opportuniteScore, rentabilite: rentabiliteScore,
      robustesse: robustesseScore, pressionRisque: pressionRisqueScore,
    });

    const analysisRecord = analysis as Record<string, unknown>;
    analysisRecord.computed = analysisRecord.computed ?? {};
    const cr = analysisRecord.computed as Record<string, unknown>;
    cr.scores = { liquidite: liquiditeScore, opportunite: opportuniteScore, rentabilite: rentabiliteScore, robustesse: robustesseScore, pressionRisque: pressionRisqueScore };
    cr.smartScore = smartScoreResult.smartScore;
    cr.operationSheet = operationSheet;
    analysisRecord.smartScore    = smartScoreResult.smartScore;
    analysisRecord.liquidite     = liquiditeScore;
    analysisRecord.opportunity   = opportuniteScore;
    analysisRecord.rentabilite   = rentabiliteScore;
    analysisRecord.robustesse    = robustesseScore;
    analysisRecord.pressionRisque = pressionRisqueScore;
    analysisRecord.operationSheet = operationSheet;

    const warnings: string[] = [...errors, ...wikimediaWarnings];

    const currentNarrative =
      typeof analysisRecord.narrativeMarkdown === "string"
        ? (analysisRecord.narrativeMarkdown as string).trim()
        : "";

    if (!currentNarrative) {
      analysisRecord.narrativeMarkdown = buildFallbackNarrativeMarkdown(
        analysis,
        wikimediaBlock,
        operationSheet,
        fiscalite,
        scoreRentaV2,
      );
      warnings.push("narrativeMarkdown absent de la réponse Claude — fallback serveur appliqué.");
    } else {
      analysisRecord.narrativeMarkdown = safeUtf8Fix(currentNarrative);
    }

    const sourcesUsed = buildSourcesUsed(context);
    if (wikimediaBlock?.sources.wikipediaUrl) sourcesUsed.push(`wikimedia:wikipedia:${wikimediaBlock.sources.wikipediaUrl}`);
    if (wikimediaBlock?.sources.wikidataUrl)  sourcesUsed.push(`wikimedia:wikidata:${wikimediaBlock.sources.wikidataUrl}`);

    if (analysis.missingData.length > 3) warnings.push("Nombreuses donnees manquantes — analyse potentiellement incomplete.");
    if (analysis.confidence < 0.4)       warnings.push("Confidence faible — donnees insuffisantes pour une decision ferme.");
    if (!analysis.marketStatus)          warnings.push('Bloc "marketStatus" absent.');
    if (!analysis.conclusion)            warnings.push('Bloc "conclusion" absent.');
    if (analysis.finalSummary === undefined) warnings.push('Bloc "finalSummary" absent.');
    if (analysis.scenarios === undefined)    warnings.push('Bloc "scenarios" absent.');
    else if (analysis.scenarios !== null && analysis.scenarios.length < 3) warnings.push('Bloc "scenarios" incomplet (< 3 scenarios).');
    if (!fiscalite)              warnings.push('Bloc "fiscalite" non calcule — acquisitionPrice ou loyerAnnuel manquant.');
    if (scoreRentaV2.score === null) warnings.push("Score Rentabilite v2 = ND — moins de 2 piliers calculables.");
    if (scoreRentaV2.piliers.fiscal.isPenalite) warnings.push("FiscalScore en mode penalite (35) — loyer absent ou fiscalite non calculable.");
    if (smartScoreResult.smartScore === null) warnings.push("SmartScore ND : moins de 2 sous-scores disponibles.");
    if (smartScoreResult.renormalized) warnings.push("SmartScore renormalisé (score marché absent).");
    warnings.push("Compat legacy: scores copies dans analysis.* en plus de computed.*");

    const opSheetNulls: string[] = [];
    if (!operationSheet.typeBien)       opSheetNulls.push("typeBien");
    if (!operationSheet.etatBien)       opSheetNulls.push("etatBien");
    if (operationSheet.travauxEur === null) opSheetNulls.push("travaux");
    if (opSheetNulls.length > 0) warnings.push(`Fiche Operation: ${opSheetNulls.join("/")} non fournis (affiches ND).`);
    if (missingDataServer.critical.length > 0) {
      warnings.push(`Donnees CRITICAL manquantes (${missingDataServer.critical.join(", ")}) : resultats chiffres non fiables.`);
    }

    if (!wikimediaBlock) {
      const city = getStringFromContext(context, ["city", "ville", "commune"]);
      warnings.push(city
        ? `Wikimedia: ville "${city}" sans enrichissement disponible.`
        : "Wikimedia: champ city/ville/commune absent du context.");
    } else if (!wikimediaBlock.quality.ok) {
      warnings.push(`Wikimedia: qualite insuffisante — ${wikimediaBlock.quality.reason ?? "raison inconnue"}`);
    } else if (wikimediaBlock.place.profile === null) {
      warnings.push("Wikimedia: profil Wikidata non disponible (population/département/région absents).");
    } else if (wikimediaBlock.place.profile.region === null) {
      warnings.push("Wikimedia: région non détectée via Wikidata P131.");
    } else {
      const pop = wikimediaBlock.place.profile.population;
      const narLen = wikimediaBlock.place.narrative?.length ?? 0;
      if (pop !== null && pop >= POPULATION_LARGE_THRESHOLD && narLen < NARRATIVE_MIN_CHARS_LARGE) {
        warnings.push(`Wikimedia: narratif grande commune "${wikimediaBlock.place.query.city}" — ${narLen} chars (objectif >= ${NARRATIVE_MIN_CHARS_LARGE}).`);
      }
    }

    console.log("[EXPORT_REPORT][RETURN][wikimedia.place.narrative]", wikimediaBlock?.place?.narrative ?? null);
    console.log("[EXPORT_REPORT][RETURN][wikimedia.place.context.short]", wikimediaBlock?.place?.context?.short ?? null);
    console.log("[EXPORT_REPORT][RETURN][wikimedia.place.context.long]", wikimediaBlock?.place?.context?.long ?? null);
    console.log("[EXPORT_REPORT][RETURN][wikimedia.place.title]", wikimediaBlock?.place?.title ?? null);
    console.log("[EXPORT_REPORT][RETURN][wikimedia.place.qid]", wikimediaBlock?.place?.qid ?? null);
    console.log("[EXPORT_REPORT][RETURN][wikimedia.quality]", wikimediaBlock?.quality ?? null);
    console.log(
      "[EXPORT_REPORT][RETURN][SUMMARY]",
      `narrative_len=${wikimediaBlock?.place?.narrative?.length ?? 0}`,
      `short_len=${wikimediaBlock?.place?.context?.short?.length ?? 0}`,
      `long_len=${wikimediaBlock?.place?.context?.long?.length ?? 0}`,
    );

    return jsonResponse({
      ok: true,
      analysis,
      computed: {
        fiscalite: fiscalite ?? null,
        fiscalScore: fiscalScore ?? null,
        scoreRentabiliteV2: scoreRentaV2,
        scores: { liquidite: liquiditeScore, opportunite: opportuniteScore, rentabilite: rentabiliteScore, robustesse: robustesseScore, pressionRisque: pressionRisqueScore },
        smartScore: smartScoreResult.smartScore,
        smartScoreMeta: { weightsUsed: smartScoreResult.weightsUsed, nbScoresDisponibles: smartScoreResult.nbScoresDisponibles, renormalized: smartScoreResult.renormalized },
        operationSheet,
        wikimedia: wikimediaBlock ?? null,
      },
      missingDataServer,
      sourcesUsed,
      warnings,
      model: usedModel,
      promptVersion: PROMPT_VERSION,
      sourceHash,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur interne inconnue";
    console.error("[export-report-v1] Error:", message);
    return jsonResponse({ ok: false, error: message, promptVersion: PROMPT_VERSION, generatedAt: new Date().toISOString() }, 500);
  }
});