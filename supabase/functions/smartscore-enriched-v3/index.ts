// supabase/functions/smartscore-enriched-v3/index.ts
// ✅ VERSION v3.11 - ANALYSE PROFESSIONNELLE ENRICHIE + ZONES RURALES
// ✅ CHANGELOG v3.11:
//    - Zones rurales: Recherche élargie jusqu'à 20km pour équipements essentiels
//    - Commerces essentiels: Pharmacies, Hyper/Supermarchés, Supérettes, Stations-service
//    - Services essentiels: La Poste, Banques/DAB
//    - Résidences seniors: Ajout recherche FINESS (résidences autonomie, services seniors)
//    - Rayon adaptatif: 500m en ville, 3-20km en zone rurale
//    - Nouveau champ zone_type: "rural" | "urbain" dans la réponse
//
// ✅ CHANGELOG v3.10:
//    - Commerces: Détail des commerces proches avec nom, type et distance
//    - Médecins: Liste des médecins proches avec nom, spécialité et distance
//    - BPE: Enrichissement avec détails nominatifs des équipements
//    - Nouveaux KPIs: commerces_proches, medecins_proches
//
// ✅ CHANGELOG v3.9:
//    - Transport: Uniquement évalué pour les grandes agglomérations avec réseau TC
//    - Santé: Détail des professionnels + hôpital le plus proche avec distance
//    - DVF Comps: Ajout du nom de commune pour chaque transaction
//    - Score global: Poids adaptatifs selon les données disponibles
//    - Prix index: Gestion des targets aberrants
//    - BPE: Fallback amélioré avec recherche élargie
//
// ✅ CHANGELOG v3.8:
//    - DVF: Fichiers CSV officiels data.gouv.fr (remplace API cquest.org down)
//    - Parseur CSV intégré
//    - Fallback RPC conservé si CSV échoue

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as turf from "https://esm.sh/@turf/turf@6.5.0";

// ✅ Providers existants (FINESS + scoring)
import { finessEhpadNearby } from "../_shared/providers/finess.ts";
import { weightedAverage } from "../_shared/providers/scoring.ts";
import type { Coverage } from "../_shared/providers/types.ts";

console.log("🚀 smartscore-enriched-v3 – orchestrator loaded (v3.11 Zones Rurales)");

// ----------------------------------------------------
// SUPABASE CLIENT
// ----------------------------------------------------
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("REST_URL") ?? "";
const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  : null;

// ----------------------------------------------------
// CONSTANTS - APIs EXTERNES
// ----------------------------------------------------
const DVF_CSV_BASE = "https://files.data.gouv.fr/geo-dvf/latest/csv";
const GEO_API_BASE = "https://geo.api.gouv.fr";
const DATA_GOUV_BPE_API = "https://tabular-api.data.gouv.fr/api/resources";
const BPE_RESOURCE_ID = "7257eb8b-f2eb-48f5-9c06-172675496269"; // BPE 2023 ensemble

// ✅ v3.11: Constantes pour les rayons de recherche
const RAYON_URBAIN_M = 500;
const RAYON_RURAL_MIN_M = 3000;
const RAYON_RURAL_MAX_M = 20000;

// ✅ v3.11: Codes BPE pour services essentiels ruraux
const CODES_COMMERCES_ESSENTIELS = new Set(["B101", "B102", "B201", "B313", "D301"]); // Hyper, Super, Supérette, Station, Pharmacie
const CODES_SERVICES_ESSENTIELS = new Set(["A203", "A204", "A206", "A207", "A208"]); // Banque, DAB, Poste
const CODES_SANTE_ESSENTIELS = new Set(["D201", "D202", "D203", "D204", "D205", "D206", "D207", "D208", "D221", "D232", "D233"]); // Médecins, dentistes, infirmiers, kinés

// ----------------------------------------------------
// GRANDES AGGLOMÉRATIONS AVEC RÉSEAU TC SIGNIFICATIF
// Liste des codes INSEE des communes principales de chaque métropole
// ----------------------------------------------------
const COMMUNES_GRANDES_AGGLOS = new Set<string>([
  // Île-de-France (Paris et petite couronne)
  "75056", // Paris
  "92012", "92014", "92019", "92020", "92022", "92023", "92024", "92025", "92026", // Hauts-de-Seine
  "92032", "92033", "92035", "92036", "92040", "92044", "92046", "92047", "92048",
  "92049", "92050", "92051", "92060", "92062", "92063", "92064", "92071", "92072",
  "92073", "92075", "92076", "92077", "92078",
  "93001", "93005", "93006", "93007", "93008", "93010", "93013", "93014", "93015", // Seine-Saint-Denis
  "93027", "93029", "93030", "93031", "93032", "93033", "93039", "93045", "93046",
  "93047", "93048", "93049", "93050", "93051", "93053", "93055", "93057", "93059",
  "93061", "93062", "93063", "93064", "93066", "93070", "93071", "93072", "93073",
  "93074", "93077", "93078", "93079",
  "94001", "94002", "94003", "94004", "94011", "94015", "94016", "94017", "94018", // Val-de-Marne
  "94019", "94021", "94022", "94028", "94033", "94034", "94037", "94038", "94041",
  "94042", "94043", "94044", "94046", "94047", "94048", "94052", "94053", "94054",
  "94055", "94056", "94058", "94059", "94060", "94065", "94067", "94068", "94069",
  "94070", "94071", "94073", "94074", "94075", "94076", "94077", "94078", "94079",
  "94080", "94081",
]);

// Départements des grandes métropoles avec réseau TC dense
const DEPARTEMENTS_GRANDES_AGGLOS = new Set<string>([
  "75", // Paris
  "92", // Hauts-de-Seine
  "93", // Seine-Saint-Denis
  "94", // Val-de-Marne
  "69", // Lyon Métropole
  "13", // Marseille Métropole (Bouches-du-Rhône)
  "33", // Bordeaux Métropole (Gironde)
  "31", // Toulouse Métropole (Haute-Garonne)
  "44", // Nantes Métropole (Loire-Atlantique)
  "59", // Lille Métropole (Nord)
  "67", // Strasbourg Eurométropole (Bas-Rhin)
  "06", // Nice Côte d'Azur (Alpes-Maritimes)
  "34", // Montpellier Méditerranée (Hérault)
  "35", // Rennes Métropole (Ille-et-Vilaine)
]);

// Communes principales des autres métropoles (hors IDF)
const COMMUNES_METROPOLES = new Set<string>([
  // Lyon
  "69123", "69381", "69382", "69383", "69384", "69385", "69386", "69387", "69388", "69389",
  "69003", "69029", "69033", "69034", "69040", "69044", "69046", "69063", "69068", "69069",
  "69071", "69072", "69081", "69085", "69087", "69088", "69089", "69091", "69096", "69100",
  "69116", "69117", "69127", "69142", "69143", "69149", "69152", "69153", "69163", "69168",
  "69191", "69194", "69199", "69202", "69204", "69205", "69207", "69233", "69244", "69250",
  "69256", "69259", "69260", "69266", "69271", "69273", "69275", "69276", "69277", "69278",
  "69279", "69281", "69282", "69283", "69284", "69286", "69290", "69291", "69292", "69293",
  "69296",
  // Marseille
  "13055", "13001", "13002", "13003", "13004", "13005", "13006", "13007", "13008", "13009",
  "13010", "13011", "13012", "13013", "13014", "13015", "13016", "13201", "13202", "13203",
  "13204", "13205", "13206", "13207", "13208", "13209", "13210", "13211", "13212", "13213",
  "13214", "13215", "13216",
  // Bordeaux
  "33063", "33003", "33013", "33039", "33056", "33065", "33069", "33075", "33096", "33119",
  "33162", "33167", "33192", "33200", "33238", "33249", "33273", "33281", "33312", "33318",
  "33376", "33434", "33449", "33487", "33519", "33522", "33550",
  // Toulouse
  "31555", "31003", "31022", "31044", "31056", "31069", "31088", "31091", "31116", "31149",
  "31150", "31157", "31163", "31165", "31182", "31184", "31186", "31205", "31230", "31282",
  "31389", "31395", "31417", "31418", "31424", "31445", "31446", "31467", "31488", "31490",
  "31506", "31541", "31557", "31561", "31575",
  // Nantes
  "44109", "44020", "44026", "44035", "44047", "44071", "44074", "44114", "44143", "44162",
  "44172", "44190", "44194", "44198", "44204", "44215",
  // Lille
  "59350", "59009", "59011", "59017", "59044", "59051", "59056", "59106", "59128", "59146",
  "59152", "59163", "59195", "59196", "59201", "59208", "59220", "59247", "59250", "59256",
  "59275", "59278", "59279", "59281", "59286", "59299", "59303", "59316", "59317", "59320",
  "59328", "59332", "59339", "59343", "59346", "59352", "59356", "59360", "59367", "59368",
  "59378", "59380", "59381", "59382", "59386", "59388", "59410", "59421", "59426", "59437",
  "59457", "59470", "59482", "59507", "59508", "59512", "59522", "59524", "59527", "59550",
  "59553", "59560", "59566", "59585", "59598", "59599", "59602", "59609", "59611", "59636",
  "59643", "59646", "59648", "59650", "59653", "59656", "59658", "59660",
  // Strasbourg
  "67482", "67043", "67118", "67137", "67180", "67204", "67218", "67227", "67252", "67267",
  "67268", "67302", "67309", "67318", "67365", "67411", "67447", "67462", "67463", "67471",
  "67506", "67519",
  // Nice
  "06088", "06004", "06011", "06027", "06029", "06030", "06031", "06032", "06033", "06057",
  "06069", "06079", "06083", "06084", "06085", "06092", "06095", "06101", "06104", "06106",
  "06112", "06123", "06127", "06128", "06136", "06138", "06149", "06151", "06152", "06155",
  "06157", "06159", "06161",
  // Montpellier
  "34172", "34022", "34057", "34058", "34077", "34087", "34090", "34095", "34116", "34120",
  "34123", "34129", "34134", "34145", "34154", "34164", "34169", "34179", "34198", "34217",
  "34227", "34249", "34256", "34259", "34270", "34295", "34307", "34327", "34337",
  // Rennes
  "35238", "35001", "35022", "35024", "35047", "35051", "35055", "35066", "35068", "35080",
  "35115", "35139", "35196", "35206", "35210", "35218", "35240", "35245", "35266", "35275",
  "35278", "35281", "35300", "35315", "35334", "35352", "35353",
  // Grenoble
  "38185", "38057", "38059", "38071", "38111", "38126", "38150", "38151", "38158", "38169",
  "38170", "38187", "38188", "38200", "38229", "38235", "38252", "38258", "38271", "38277",
  "38279", "38281", "38309", "38317", "38325", "38328", "38364", "38382", "38421", "38423",
  "38436", "38445", "38471", "38472", "38474", "38485", "38486", "38516", "38524", "38528",
  "38529", "38533", "38540", "38545", "38547", "38553", "38554", "38562",
  // Rouen
  "76540", "76005", "76020", "76039", "76056", "76069", "76095", "76108", "76116", "76157",
  "76165", "76178", "76212", "76216", "76222", "76231", "76237", "76269", "76273", "76281",
  "76282", "76285", "76319", "76322", "76350", "76354", "76366", "76367", "76377", "76378",
  "76391", "76402", "76410", "76429", "76436", "76448", "76451", "76457", "76474", "76475",
  "76484", "76486", "76497", "76498", "76499", "76514", "76536", "76550", "76558", "76560",
  "76575", "76591", "76599", "76608", "76614", "76617", "76636", "76640", "76659", "76681",
  "76682", "76684", "76691", "76709", "76717", "76750", "76753",
  // Toulon
  "83137", "83034", "83047", "83062", "83069", "83090", "83098", "83103", "83107", "83118",
  "83126", "83129", "83144",
]);

function isInGrandeAgglomeration(communeInsee: string | null): boolean {
  if (!communeInsee || communeInsee.length < 2) return false;
  
  // Vérifier si c'est une commune connue des grandes agglos
  if (COMMUNES_GRANDES_AGGLOS.has(communeInsee)) return true;
  if (COMMUNES_METROPOLES.has(communeInsee)) return true;
  
  // Vérifier le département
  const dep = communeInsee.slice(0, 2);
  return DEPARTEMENTS_GRANDES_AGGLOS.has(dep);
}

// ----------------------------------------------------
// TYPES (MARKET STUDY)
// ----------------------------------------------------
type MarketStudyPayload = {
  mode: "market_study";
  parcel_id?: string;
  commune_insee?: string | number;
  project_nature: string;
  radius_km?: number;
  horizon_months?: number;
  lat?: number;
  lon?: number;
  targets?: {
    unit_price_m2?: number;
    nightly_rate?: number;
    monthly_rent?: number;
  };
  debug?: boolean;
};

type ResolvedPoint = {
  lat: number;
  lon: number;
  source: "payload" | "parcel" | "commune";
  parcel_id?: string;
  commune_insee?: string;
  surface_m2?: number;
};

type DvfMarketStats = {
  transactions_count: number;
  transactions_count_previous: number;
  price_median_eur_m2: number | null;
  price_mean_eur_m2: number | null;
  price_q1_eur_m2: number | null;
  price_q3_eur_m2: number | null;
  evolution_pct: number | null;
  volume_total_eur: number | null;
  surface_mean_m2: number | null;
};

type MarketKpi = {
  label: string;
  value: string | number | null;
  unit?: string;
  trend?: "up" | "down" | "stable" | null;
  description?: string;
};

type MarketInsight = {
  type: "positive" | "negative" | "neutral" | "warning";
  title: string;
  description: string;
  source?: string;
};

type MarketComp = {
  id: string;
  address?: string;
  price_m2?: number;
  surface_m2?: number;
  date?: string;
  type_local?: string;
  distance_m?: number;
  commune?: string;
};

// ----------------------------------------------------
// TYPES (STANDARD MODE)
// ----------------------------------------------------
type StandardPayload = {
  mode?: "standard" | undefined;
  address?: string;
  cp?: string;
  ville?: string;
  surface?: number;
  prix?: number;
  travaux?: number;
  userCriteria?: Record<string, unknown>;
  meloId?: string;
  type_local?: string;
  dep_code?: string;
  commune_code?: string;
  lat?: number;
  lon?: number;
  parcel_id?: string;
  commune_insee?: string | number;
  transports?: unknown;
  radius_km?: number;
  horizon_months?: number;
  debug?: boolean;
};

type CoverageMap = {
  dvf: Coverage;
  transport: Coverage;
  ecoles: Coverage;
  bpe: Coverage;
  sante: Coverage;
  insee: Coverage;
  ehpad: Coverage;
};

type SmartScoreComponents = {
  transport_score: number | null;
  ecoles_score: number | null;
  commodites_score: number | null;
  marche_score: number | null;
  sante_score: number | null;
};

// ✅ Types enrichis pour la santé v3.9
type ProfessionnelsSanteDetails = {
  medecins_generalistes: number;
  medecins_specialistes: number;
  dentistes: number;
  infirmiers: number;
  kinesitherapeutes: number;
  pharmacies: number;
  autres: number;
};

type HopitalProche = {
  nom: string;
  commune: string;
  distance_km: number;
  type: string;
} | null;

type HealthFicheEnriched = {
  code_commune: string;
  commune: string;
  population: number | null;
  densite_medecins_10000: number | null;
  densite_label: string;
  desert_medical_score: number | null;
  resume: string;
  kpi: {
    medecins_total: number | null;
    generalistes_total: number | null;
    generalistes_densite_10000: number | null;
    infirmiers_total: number | null;
    pharmacies_total: number | null;
    dentistes_total: number | null;
    autres_professionnels: number | null;
    etablissements_sante: number | null;
  };
  professionnels_details?: ProfessionnelsSanteDetails;
  hopital_proche?: HopitalProche;
  medecins_proches?: MedecinProche[];
};

// ✅ v3.10: Types pour les commerces et médecins proches
type CommerceProche = {
  nom: string;
  type: string;
  type_code: string;
  distance_m: number;
  distance_km?: number;
  adresse?: string;
  commune?: string;
};

type MedecinProche = {
  nom: string;
  specialite: string;
  type_code: string;
  distance_m: number;
  distance_km?: number;
  adresse?: string;
  commune?: string;
};

// ✅ v3.11: Types pour les services essentiels ruraux
type ServiceEssentiel = {
  nom: string;
  type: string;
  type_code: string;
  distance_m: number;
  distance_km: number;
  adresse?: string;
  commune?: string;
};

type ResidenceSenior = {
  nom: string;
  type: string;
  commune: string;
  distance_km: number;
  finess?: string;
};

type ServicesRuraux = {
  pharmacie_proche: ServiceEssentiel | null;
  supermarche_proche: ServiceEssentiel | null;
  hypermarche_proche: ServiceEssentiel | null;
  superette_proche: ServiceEssentiel | null;
  station_service_proche: ServiceEssentiel | null;
  poste_proche: ServiceEssentiel | null;
  banque_proche: ServiceEssentiel | null;
  medecin_proche: MedecinProche | null;
  rayon_recherche_m: number;
};

// ----------------------------------------------------
// HELPERS GÉNÉRAUX
// ----------------------------------------------------
function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeToString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function coverageLabel(c: Coverage): string {
  if (c === "ok") return "OK";
  if (c === "no_data") return "Pas de données";
  if (c === "not_covered") return "Non couvert";
  return "Erreur";
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ✅ v3.11: Helper pour convertir mètres en km
function metersToKm(m: number): number {
  return Math.round(m / 100) / 10;
}

// ----------------------------------------------------
// CACHE UNIVERSEL (table api_cache)
// ----------------------------------------------------
async function getFromCache(cacheKey: string): Promise<any | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("api_cache")
      .select("data")
      .eq("cache_key", cacheKey)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (!error && data?.data) {
      supabase
        .from("api_cache")
        .update({ hit_count: (data as any).hit_count ? (data as any).hit_count + 1 : 1 })
        .eq("cache_key", cacheKey)
        .then(() => {});
      return data.data;
    }
  } catch (e) {
    console.warn("⚠️ Cache read error:", e);
  }
  return null;
}

async function saveToCache(cacheKey: string, provider: string, data: any, ttlSeconds: number): Promise<void> {
  if (!supabase) return;
  try {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await supabase
      .from("api_cache")
      .upsert({
        cache_key: cacheKey,
        provider,
        data,
        expires_at: expiresAt,
        hit_count: 0,
      }, { onConflict: "cache_key" });
  } catch (e) {
    console.warn("⚠️ Cache write error:", e);
  }
}

// ----------------------------------------------------
// DVF MAPPING HELPERS
// ----------------------------------------------------
function mapProjectNatureToDvfType(nature: string): string | null {
  const n = (nature ?? "").toString().toLowerCase();
  if (n === "logement") return null;
  if (n === "residence_senior") return "Appartement";
  if (n === "residence_etudiante") return "Appartement";
  if (n === "ehpad") return "Local";
  if (n === "hotel") return "Local";
  if (n === "bureaux") return "Local";
  if (n === "commerce") return "Local";
  if (n.includes("logement")) return null;
  if (n.includes("bureau")) return "Local";
  if (n.includes("commerce")) return "Local";
  if (n.includes("hotel")) return "Local";
  return null;
}

function normalizeStandardTypeLocal(input: unknown): string | null {
  const s = safeToString(input);
  if (!s) return null;
  const raw = s.toLowerCase();
  if (raw === "appartement") return "Appartement";
  if (raw === "maison") return "Maison";
  if (raw === "local") return "Local";
  if (raw === "apt" || raw === "appts" || raw.includes("appart")) return "Appartement";
  if (raw.includes("maison")) return "Maison";
  if (raw.includes("bureau") || raw.includes("commerce") || raw.includes("hotel") || raw.includes("local")) return "Local";
  return mapProjectNatureToDvfType(raw);
}

function computeIndex(value: number | null, min: number, max: number, invert = false): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (max === min) return 50;
  const clamped = Math.max(min, Math.min(max, value));
  const normalized = (clamped - min) / (max - min);
  const score = Math.round((invert ? 1 - normalized : normalized) * 100);
  return Math.max(0, Math.min(100, score));
}

// ----------------------------------------------------
// CADASTRE NATIONAL (hors IDF) via API Carto
// ----------------------------------------------------
function isIdfDepFromInsee(communeInsee: string | null): boolean {
  if (!communeInsee || communeInsee.length < 2) return false;
  const dep = communeInsee.slice(0, 2);
  return ["75", "77", "78", "91", "92", "93", "94", "95"].includes(dep);
}

function parseParcelIdu(idu: string): {
  code_insee: string | null;
  com_abs: string | null;
  section: string | null;
  numero: string | null;
} {
  const s = (idu ?? "").trim();
  if (!s) return { code_insee: null, com_abs: null, section: null, numero: null };
  if (s.length >= 14) {
    return {
      code_insee: s.slice(0, 5),
      com_abs: s.slice(5, 8),
      section: s.slice(8, 10),
      numero: s.slice(10, 14),
    };
  }
  return {
    code_insee: s.length >= 5 ? s.slice(0, 5) : null,
    com_abs: s.length >= 8 ? s.slice(5, 8) : null,
    section: s.length >= 10 ? s.slice(8, 10) : null,
    numero: s.length >= 14 ? s.slice(10, 14) : null,
  };
}

type CadastreFetchDebug = {
  url?: string;
  status?: number;
  ok?: boolean;
  numberReturned?: number | null;
  error?: string | null;
};

async function fetchParcelFromApiCarto(
  idu: string,
  communeInseeHint?: string | null,
  debug = false,
): Promise<{ point: ResolvedPoint | null; dbg: CadastreFetchDebug }> {
  const dbg: CadastreFetchDebug = {};
  const parsed = parseParcelIdu(idu);
  const code_insee = communeInseeHint?.toString() ?? parsed.code_insee;
  const section = parsed.section;
  const numero = parsed.numero;
  const com_abs = parsed.com_abs ?? "000";

  if (!code_insee || !section || !numero) {
    dbg.error = "Missing code_insee/section/numero";
    return { point: null, dbg };
  }

  const url =
    `https://apicarto.ign.fr/api/cadastre/parcelle` +
    `?code_insee=${encodeURIComponent(code_insee)}` +
    `&section=${encodeURIComponent(section)}` +
    `&numero=${encodeURIComponent(numero)}` +
    `&com_abs=${encodeURIComponent(com_abs)}` +
    `&_limit=1`;

  dbg.url = url;
  if (debug) console.log("🧭 api-carto cadastre url:", url);

  try {
    const resp = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
    dbg.status = resp.status;
    dbg.ok = resp.ok;

    const json = await resp.json().catch(() => null);
    if (!json || !resp.ok) {
      dbg.error = `api-carto error status=${resp.status}`;
      return { point: null, dbg };
    }

    dbg.numberReturned = numOrNull((json as any).numberReturned) ?? null;

    const feature = Array.isArray((json as any).features) && (json as any).features.length > 0
      ? (json as any).features[0]
      : null;

    if (!feature?.geometry) {
      dbg.error = "no feature.geometry";
      return { point: null, dbg };
    }

    const centroid = turf.centroid(feature);
    const coords = centroid?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      dbg.error = "centroid coords invalid";
      return { point: null, dbg };
    }

    const lon = numOrNull(coords[0]);
    const lat = numOrNull(coords[1]);
    if (lat == null || lon == null) {
      dbg.error = "lat/lon null";
      return { point: null, dbg };
    }

    let surface_m2: number | null = null;
    try { surface_m2 = turf.area(feature); } catch { surface_m2 = null; }

    return {
      point: {
        lat,
        lon,
        source: "parcel",
        parcel_id: idu,
        commune_insee: code_insee,
        surface_m2: surface_m2 ?? undefined,
      },
      dbg,
    };
  } catch (e) {
    dbg.error = `fetch exception: ${String(e)}`;
    return { point: null, dbg };
  }
}

async function resolvePointFromParcelId(
  parcelId: string,
  communeInsee?: string | number | null,
  debug = false,
): Promise<{ point: ResolvedPoint | null; cadastreDebug?: CadastreFetchDebug; rpcDebug?: any }> {
  if (!parcelId) return { point: null };

  const parsed = parseParcelIdu(parcelId);
  const inseeStr = communeInsee?.toString() ?? parsed.code_insee ?? null;

  if (inseeStr && !isIdfDepFromInsee(inseeStr)) {
    const { point, dbg } = await fetchParcelFromApiCarto(parcelId, inseeStr, debug);
    if (point) return { point, cadastreDebug: dbg };
    return { point: null, cadastreDebug: dbg };
  }

  if (!supabase) return { point: null };

  const tryRpc = async (comm: string | null) => {
    return await supabase.rpc("get_parcelle_centroid", {
      p_parcel_id: parcelId,
      p_commune_insee: comm,
    });
  };

  let { data, error } = await tryRpc(communeInsee?.toString() ?? null);
  if (!error && (!Array.isArray(data) || data.length === 0)) {
    ({ data, error } = await tryRpc(null));
  }

  if (error) {
    console.error("❌ RPC get_parcelle_centroid error:", error);
    return { point: null, rpcDebug: { error } };
  }

  if (Array.isArray(data) && data.length > 0) {
    const row: any = data[0];
    const rLat = numOrNull(row.lat);
    const rLon = numOrNull(row.lon);
    if (rLat != null && rLon != null) {
      return {
        point: {
          lat: rLat,
          lon: rLon,
          source: "parcel",
          parcel_id: parcelId,
          commune_insee: safeToString(row.commune_insee) ?? communeInsee?.toString() ?? undefined,
          surface_m2: numOrNull(row.surface_m2) ?? undefined,
        },
        rpcDebug: { row },
      };
    }
  }

  return { point: null, rpcDebug: { data_len: Array.isArray(data) ? data.length : null } };
}

// ----------------------------------------------------
// RÉSOLUTION POINT - Market Study
// ----------------------------------------------------
async function resolveAnalysisPoint(
  payload: MarketStudyPayload,
): Promise<{ point: ResolvedPoint | null; error: string | null; inseeMeta?: any; debugResolve?: any }> {
  const { parcel_id, commune_insee, lat, lon, debug } = payload;

  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    console.log("📍 Point résolu depuis payload lat/lon");
    return {
      point: { lat, lon, source: "payload", parcel_id: parcel_id ?? undefined, commune_insee: commune_insee?.toString() },
      error: null,
    };
  }

  if (parcel_id) {
    console.log("📍 Résolution point via parcel_id:", parcel_id);
    const res = await resolvePointFromParcelId(parcel_id, commune_insee ?? null, !!debug);
    if (res.point) {
      console.log("✅ Point résolu depuis parcelle:", res.point.lat, res.point.lon);
      return { point: res.point, error: null };
    }
    if (debug) {
      return {
        point: null,
        error: "Parcelle non résolue",
        debugResolve: { parcel_id, commune_insee: commune_insee?.toString() ?? null, cadastre: res.cadastreDebug, rpc: res.rpcDebug },
      };
    }
  }

  if (supabase && commune_insee) {
    const { data: inseeData } = await supabase
      .from("insee_communes_stats")
      .select("code_commune,commune,population,pct_moins_25,pct_plus_65")
      .eq("code_commune", commune_insee.toString())
      .limit(1)
      .maybeSingle();

    if (inseeData) {
      return { point: null, error: "Coordonnées absentes pour cette commune.", inseeMeta: inseeData };
    }
  }

  return { point: null, error: "Impossible de résoudre le point d'analyse. Fournir lat/lon, parcel_id ou commune_insee valide." };
}

// ----------------------------------------------------
// RÉSOLUTION POINT - Standard
// ----------------------------------------------------
async function resolveStandardPoint(
  payload: StandardPayload,
): Promise<{ point: ResolvedPoint | null; error: string | null; debugResolve?: any }> {
  const { parcel_id, commune_insee, commune_code, lat, lon, debug } = payload;

  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    console.log("📍 [Standard] Point résolu depuis payload lat/lon");
    return {
      point: { lat, lon, source: "payload", parcel_id: parcel_id ?? undefined, commune_insee: commune_insee?.toString() ?? commune_code ?? undefined },
      error: null,
    };
  }

  const effectiveCommune = commune_insee?.toString() ?? commune_code ?? null;
  if (parcel_id) {
    console.log("📍 [Standard] Résolution point via parcel_id:", parcel_id);
    const res = await resolvePointFromParcelId(parcel_id, effectiveCommune, !!debug);
    if (res.point) {
      console.log("✅ [Standard] Point résolu depuis parcelle:", res.point.lat, res.point.lon);
      return { point: res.point, error: null };
    }
    if (debug) {
      return { point: null, error: "Parcelle non résolue", debugResolve: { parcel_id, commune_insee: effectiveCommune, cadastre: res.cadastreDebug, rpc: res.rpcDebug } };
    }
    return { point: null, error: "Impossible de résoudre le point d'analyse via parcel_id." };
  }

  return { point: null, error: "Impossible de résoudre le point d'analyse. Fournir lat/lon ou parcel_id valide." };
}

// ============================================================================
// ✅ CSV PARSER (pour DVF)
// ============================================================================
function parseCSV(csvText: string): Array<Record<string, string>> {
  const lines = csvText.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(",").map(h => h.trim());
  const rows: Array<Record<string, string>> = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",");
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] ?? "").trim();
    }
    rows.push(row);
  }
  
  return rows;
}

// ============================================================================
// ✅ DVF PROVIDER - CSV data.gouv.fr (FIABLE) + fallback RPC
// ============================================================================
type DvfApiResult = {
  provider: "dvf";
  source: string;
  coverage: Coverage;
  reason?: string;
  kpis: {
    n: number;
    median_price_m2: number | null;
    avg_price_m2: number | null;
    q1_price_m2: number | null;
    q3_price_m2: number | null;
  };
  comps: MarketComp[];
};

function getDvfCacheKey(communeInsee: string | null, lat: number, lon: number, months: number, typeLocal: string | null): string {
  const key = communeInsee ?? `${Math.round(lat * 100)}_${Math.round(lon * 100)}`;
  return `dvf:${key}:${months}:${typeLocal || "all"}`;
}

async function dvfMarketKpis(
  params: {
    lat: number;
    lon: number;
    radius_m?: number;
    horizon_months?: number;
    type_local?: string | null;
    commune_insee?: string | null;
    ttl_seconds?: number;
    debug?: boolean;
  }
): Promise<DvfApiResult> {
  const {
    lat,
    lon,
    radius_m = 2000,
    horizon_months = 24,
    type_local = null,
    commune_insee = null,
    ttl_seconds = 86400,
    debug = false,
  } = params;

  const cacheKey = getDvfCacheKey(commune_insee, lat, lon, horizon_months, type_local);

  // 1. Check cache
  const cached = await getFromCache(cacheKey);
  if (cached) {
    if (debug) console.log("✅ DVF from cache");
    return { ...cached, source: "cache" };
  }

  // 2. Déterminer le code commune et nom
  let codeCommune = commune_insee;
  let nomCommune: string | null = null;
  
  if (!codeCommune) {
    try {
      const geoResp = await fetch(`${GEO_API_BASE}/communes?lat=${lat}&lon=${lon}&fields=code,nom&limit=1`);
      if (geoResp.ok) {
        const communes = await geoResp.json();
        if (communes.length > 0) {
          codeCommune = communes[0].code;
          nomCommune = communes[0].nom;
          if (debug) console.log("📍 DVF: commune détectée:", codeCommune, nomCommune);
        }
      }
    } catch (e) {
      if (debug) console.warn("⚠️ DVF: erreur détection commune:", e);
    }
  } else {
    // Récupérer le nom de la commune
    try {
      const geoResp = await fetch(`${GEO_API_BASE}/communes/${codeCommune}?fields=nom`);
      if (geoResp.ok) {
        const communeData = await geoResp.json();
        nomCommune = communeData.nom;
      }
    } catch (e) {
      // Ignorer
    }
  }

  if (!codeCommune) {
    return {
      provider: "dvf",
      source: "csv",
      coverage: "not_covered",
      reason: "Impossible de déterminer le code commune",
      kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null },
      comps: [],
    };
  }

  const dep = codeCommune.slice(0, 2);
  
  // 3. Date limite
  const dateLimit = new Date();
  dateLimit.setMonth(dateLimit.getMonth() - horizon_months);
  const dateLimitStr = dateLimit.toISOString().split("T")[0];

  // 4. Télécharger les CSV DVF pour les années concernées
  const currentYear = new Date().getFullYear();
  const yearsToFetch: number[] = [];
  for (let y = currentYear; y >= currentYear - 3 && y >= 2019; y--) {
    yearsToFetch.push(y);
  }

  let allRows: Array<Record<string, string>> = [];
  const csvSources: string[] = [];

  for (const year of yearsToFetch) {
    const csvUrl = `${DVF_CSV_BASE}/${year}/communes/${dep}/${codeCommune}.csv`;
    if (debug) console.log(`📥 DVF CSV: ${csvUrl}`);

    try {
      const resp = await fetch(csvUrl);
      if (resp.ok) {
        const csvText = await resp.text();
        const rows = parseCSV(csvText);
        allRows = allRows.concat(rows);
        csvSources.push(String(year));
        if (debug) console.log(`✅ DVF ${year}: ${rows.length} lignes`);
      } else {
        if (debug) console.log(`⚠️ DVF ${year}: HTTP ${resp.status}`);
      }
    } catch (e) {
      if (debug) console.warn(`⚠️ DVF ${year} error:`, e);
    }
  }

  if (allRows.length === 0) {
    if (debug) console.log("📦 DVF CSV: aucune donnée");
    return {
      provider: "dvf",
      source: "csv",
      coverage: "no_data",
      reason: `Aucune donnée DVF trouvée pour ${codeCommune}`,
      kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null },
      comps: [],
    };
  }

  // 5. Filtrer et transformer
  const transactions: Array<{ price_m2: number; valeur: number; surface: number; record: any }> = [];
  const seenMutations = new Set<string>();

  for (const row of allRows) {
    const dateMutation = row.date_mutation || "";
    if (dateMutation < dateLimitStr) continue;

    const idMutation = row.id_mutation || "";
    if (seenMutations.has(idMutation)) continue;
    
    const valeur = parseFloat(row.valeur_fonciere || "0");
    const surface = parseFloat(row.surface_reelle_bati || "0");
    
    if (valeur <= 0 || surface <= 0) continue;

    const rowTypeLocal = row.type_local || "";
    if (type_local) {
      if (type_local === "Appartement" && rowTypeLocal !== "Appartement") continue;
      if (type_local === "Maison" && rowTypeLocal !== "Maison") continue;
      if (type_local === "Local" && !rowTypeLocal.toLowerCase().includes("local")) continue;
    }

    const tLat = parseFloat(row.latitude || "0");
    const tLon = parseFloat(row.longitude || "0");
    let distance_m: number | undefined;
    
    if (tLat && tLon && lat && lon) {
      distance_m = Math.round(haversineDistance(lat, lon, tLat, tLon));
      if (distance_m > radius_m) continue;
    }

    seenMutations.add(idMutation);

    transactions.push({
      price_m2: Math.round(valeur / surface),
      valeur,
      surface,
      record: {
        id: idMutation,
        date_mutation: dateMutation,
        adresse: [row.adresse_numero, row.adresse_suffixe, row.adresse_nom_voie].filter(Boolean).join(" ") || null,
        type_local: rowTypeLocal,
        latitude: tLat || null,
        longitude: tLon || null,
        distance_m,
        nom_commune: row.nom_commune || nomCommune || null,
      },
    });
  }

  transactions.sort((a, b) => (b.record.date_mutation || "").localeCompare(a.record.date_mutation || ""));

  // 6. Calculer les KPIs
  const prices = transactions.map(t => t.price_m2).sort((a, b) => a - b);
  const n = prices.length;

  let median_price_m2: number | null = null;
  let avg_price_m2: number | null = null;
  let q1_price_m2: number | null = null;
  let q3_price_m2: number | null = null;

  if (n > 0) {
    median_price_m2 = prices[Math.floor(n / 2)];
    avg_price_m2 = Math.round(prices.reduce((a, b) => a + b, 0) / n);
    q1_price_m2 = prices[Math.floor(n * 0.25)];
    q3_price_m2 = prices[Math.floor(n * 0.75)];
  }

  // Comps (top 20) - avec nom_commune
  const comps: MarketComp[] = transactions.slice(0, 20).map((t, idx) => ({
    id: t.record.id || `${idx}`,
    address: t.record.adresse ?? undefined,
    price_m2: t.price_m2,
    surface_m2: t.surface,
    date: t.record.date_mutation ?? undefined,
    type_local: t.record.type_local ?? undefined,
    distance_m: t.record.distance_m,
    commune: t.record.nom_commune ?? nomCommune ?? undefined,
  }));

  const result: DvfApiResult = {
    provider: "dvf",
    source: `csv:${csvSources.join(",")}`,
    coverage: n > 0 ? "ok" : "no_data",
    kpis: { n, median_price_m2, avg_price_m2, q1_price_m2, q3_price_m2 },
    comps,
  };

  await saveToCache(cacheKey, "dvf", result, ttl_seconds);

  if (debug) console.log("✅ DVF result:", result.kpis);

  return result;
}

// Fallback RPC pour DVF
function unwrapRpcSingleRow(data: any): any | null {
  if (!data) return null;
  if (Array.isArray(data)) return data.length > 0 ? data[0] : null;
  return data;
}

async function fetchDvfMarketStatsRpc(
  point: ResolvedPoint,
  radiusKm: number,
  months: number,
  typeLocal: string | null,
): Promise<{ stats: DvfMarketStats | null; comps: MarketComp[]; error: string | null }> {
  if (!supabase) {
    return { stats: null, comps: [], error: "Supabase non initialisé" };
  }

  const radiusM = Math.round(radiusKm * 1000);

  console.log("📊 Fallback → RPC get_dvf_market_stats_radius");

  try {
    let statsData: any = null;
    let statsError: any = null;

    const attempt1 = await supabase.rpc("get_dvf_market_stats_radius", {
      p_lat: point.lat,
      p_lon: point.lon,
      p_months: months,
      p_radius_m: radiusM,
      p_type_local: typeLocal,
    });

    if (attempt1.error) {
      const attempt2 = await supabase.rpc("get_dvf_market_stats_radius", {
        p_lat: point.lat,
        p_lon: point.lon,
        p_radius_m: radiusM,
        p_months: months,
        p_type_local: typeLocal,
      });

      if (attempt2.error) {
        statsError = attempt2.error;
      } else {
        statsData = attempt2.data;
      }
    } else {
      statsData = attempt1.data;
    }

    if (statsError) {
      return { stats: null, comps: [], error: statsError.message ?? String(statsError) };
    }

    const row = unwrapRpcSingleRow(statsData);
    const rawStats = row?.stats ? row.stats : row;

    const stats: DvfMarketStats = {
      transactions_count: Number(rawStats?.transactions_count ?? 0) || 0,
      transactions_count_previous: Number(rawStats?.transactions_count_previous ?? 0) || 0,
      price_median_eur_m2: numOrNull(rawStats?.price_median_eur_m2),
      price_mean_eur_m2: numOrNull(rawStats?.price_mean_eur_m2),
      price_q1_eur_m2: numOrNull(rawStats?.price_q1_eur_m2),
      price_q3_eur_m2: numOrNull(rawStats?.price_q3_eur_m2),
      evolution_pct: numOrNull(rawStats?.evolution_pct),
      volume_total_eur: numOrNull(rawStats?.volume_total_eur),
      surface_mean_m2: numOrNull(rawStats?.surface_mean_m2),
    };

    const { data: compsData } = await supabase.rpc("get_dvf_comps_radius", {
      p_lat: point.lat,
      p_lon: point.lon,
      p_radius_m: Math.min(radiusM, 1500),
      p_months: Math.min(months, 12),
      p_type_local: typeLocal,
      p_limit: 15,
    });

    let comps: MarketComp[] = [];
    if (Array.isArray(compsData)) {
      comps = compsData.map((c: any, idx: number) => ({
        id: safeToString(c.id) ?? `${idx}`,
        address: safeToString(c.adresse) ?? undefined,
        price_m2: numOrNull(c.price_m2) ?? undefined,
        surface_m2: numOrNull(c.surface_m2) ?? undefined,
        date: safeToString(c.date_mutation) ?? undefined,
        type_local: safeToString(c.type_local) ?? undefined,
        distance_m: numOrNull(c.distance_m) ?? undefined,
        commune: safeToString(c.commune) ?? undefined,
      }));
    }

    return { stats, comps, error: null };
  } catch (e) {
    console.error("❌ fetchDvfMarketStatsRpc error:", e);
    return { stats: null, comps: [], error: String(e) };
  }
}

// ============================================================================
// ✅ BPE PROVIDER - API data.gouv.fr + fallback RPC
// ============================================================================
type BpeKpis = {
  total_equipements: number;
  nb_commerces: number;
  nb_sante: number;
  nb_services: number;
  nb_enseignement: number;
  nb_sport_culture: number;
  score_commerces: number;
  score_sante: number;
  score_services: number;
  scoreCommodites: number;
  sante_details: Array<{ type: string; label: string; count: number; min_distance_m: number | null }>;
  commerces_proches?: CommerceProche[];
  medecins_proches?: MedecinProche[];
};

const DOMAINE_MAP: Record<string, string> = {
  A: "services",
  B: "commerces",
  C: "enseignement",
  D: "sante",
  E: "transport",
  F: "sport_culture",
  G: "tourisme",
};

const SANTE_TYPE_MAP: Record<string, string> = {
  D201: "medecin_generaliste",
  D202: "medecin_specialiste",
  D203: "medecin_specialiste",
  D206: "medecin_specialiste",
  D221: "dentiste",
  D301: "pharmacie",
  D232: "infirmier",
  D233: "kinesitherapeute",
};

const SANTE_LABELS: Record<string, string> = {
  medecin_generaliste: "Médecins généralistes",
  medecin_specialiste: "Médecins spécialistes",
  dentiste: "Chirurgiens-dentistes",
  pharmacie: "Pharmacies",
  infirmier: "Infirmiers",
  kinesitherapeute: "Kinésithérapeutes",
  autre_sante: "Autres professionnels de santé",
};

// ✅ v3.10: Labels pour les types de commerces BPE
const COMMERCE_TYPE_LABELS: Record<string, string> = {
  B101: "Hypermarché",
  B102: "Supermarché",
  B103: "Grande surface de bricolage",
  B201: "Supérette",
  B202: "Épicerie",
  B203: "Boulangerie",
  B204: "Boucherie charcuterie",
  B205: "Produits surgelés",
  B206: "Poissonnerie",
  B301: "Librairie papeterie journaux",
  B302: "Magasin de vêtements",
  B303: "Magasin d'équipements du foyer",
  B304: "Magasin de chaussures",
  B305: "Magasin d'électroménager et de matériel audio-vidéo",
  B306: "Magasin de meubles",
  B307: "Magasin d'articles de sports et de loisirs",
  B308: "Droguerie quincaillerie bricolage",
  B309: "Parfumerie",
  B310: "Horlogerie Bijouterie",
  B311: "Fleuriste",
  B312: "Magasin d'optique",
  B313: "Station service",
};

// ✅ v3.10: Labels pour les spécialités médicales
const MEDECIN_SPECIALITE_LABELS: Record<string, string> = {
  D201: "Médecin généraliste",
  D202: "Spécialiste en cardiologie",
  D203: "Spécialiste en dermatologie",
  D204: "Spécialiste en gastro-entérologie",
  D205: "Spécialiste en psychiatrie",
  D206: "Spécialiste en ophtalmologie",
  D207: "Spécialiste en ORL",
  D208: "Spécialiste en pédiatrie",
  D209: "Spécialiste en radiodiagnostic et imagerie médicale",
  D210: "Spécialiste en gynécologie",
  D211: "Spécialiste en gynécologie obstétrique",
  D221: "Chirurgien-dentiste",
  D231: "Sage-femme",
  D232: "Infirmier",
  D233: "Masseur kinésithérapeute",
  D235: "Orthophoniste",
  D236: "Orthoptiste",
  D237: "Pédicure-podologue",
  D238: "Audio prothésiste",
  D239: "Ergothérapeute",
  D240: "Psychomotricien",
  D241: "Diététicien",
  D301: "Pharmacie",
  D302: "Laboratoire d'analyses médicales",
  D303: "Ambulance",
  D307: "Transfusion sanguine",
  D310: "Maison de santé pluridisciplinaire",
};

// ✅ v3.11: Labels pour les services essentiels
const SERVICE_TYPE_LABELS: Record<string, string> = {
  A203: "Banque",
  A204: "DAB (distributeur automatique)",
  A206: "Bureau de poste",
  A207: "Relais poste",
  A208: "Agence postale communale",
};

function getBpeCacheKey(lat: number, lon: number, radiusM: number): string {
  const latRounded = Math.round(lat * 100) / 100;
  const lonRounded = Math.round(lon * 100) / 100;
  return `bpe:${latRounded}:${lonRounded}:${radiusM}`;
}

async function fetchBpeStats(
  lat: number,
  lon: number,
  radiusM = 500,
  communeInsee?: string | null,
  debug = false,
): Promise<{ scoreCommodites: number | null; details: BpeKpis | null; coverage: Coverage; totalEquipements: number }> {
  const cacheKey = getBpeCacheKey(lat, lon, radiusM);

  const cached = await getFromCache(cacheKey);
  if (cached) {
    if (debug) console.log("✅ BPE from cache");
    return cached;
  }

  let effectiveCommune = communeInsee;
  if (!effectiveCommune) {
    try {
      const geoResp = await fetch(`${GEO_API_BASE}/communes?lat=${lat}&lon=${lon}&fields=code,nom&limit=1`);
      if (geoResp.ok) {
        const communes = await geoResp.json();
        if (communes.length > 0) {
          effectiveCommune = communes[0].code;
          if (debug) console.log("📍 BPE: commune détectée:", effectiveCommune, communes[0].nom);
        }
      }
    } catch (e) {
      console.warn("⚠️ BPE: erreur détection commune:", e);
    }
  }

  if (!effectiveCommune) {
    return {
      scoreCommodites: null,
      details: null,
      coverage: "not_covered" as Coverage,
      totalEquipements: 0,
    };
  }

  try {
    const apiUrl = `${DATA_GOUV_BPE_API}/${BPE_RESOURCE_ID}/data/?DEPCOM__exact=${effectiveCommune}&page_size=2000`;

    if (debug) console.log("🔍 BPE API URL:", apiUrl);

    const resp = await fetch(apiUrl, { headers: { Accept: "application/json" } });

    if (!resp.ok) {
      console.warn("⚠️ BPE API error:", resp.status);
      if (supabase) {
        console.log("📦 BPE: Fallback vers RPC get_bpe_proximite");
        return await fetchBpeStatsRpc(lat, lon, radiusM);
      }
      return {
        scoreCommodites: null,
        details: null,
        coverage: "error" as Coverage,
        totalEquipements: 0,
      };
    }

    const json = await resp.json();
    const records = json.data || [];

    if (debug) console.log(`📦 BPE: ${records.length} équipements trouvés pour commune ${effectiveCommune}`);

    if (records.length === 0) {
      if (supabase) {
        console.log("📦 BPE: Aucune donnée API, fallback vers RPC");
        return await fetchBpeStatsRpc(lat, lon, radiusM);
      }
    }

    const byDomaine: Record<string, number> = {};
    const santeByType: Record<string, { count: number; minDist: number | null }> = {};
    let totalInRadius = 0;

    // ✅ v3.10: Collecter les commerces et médecins proches
    const commercesProches: CommerceProche[] = [];
    const medecinsProches: MedecinProche[] = [];

    for (const r of records) {
      const eqLat = parseFloat(r.LATITUDE || r.latitude || "");
      const eqLon = parseFloat(r.LONGITUDE || r.longitude || "");

      if (isNaN(eqLat) || isNaN(eqLon)) continue;

      const distance = haversineDistance(lat, lon, eqLat, eqLon);

      if (distance <= radiusM) {
        totalInRadius++;
        const typeCode = r.TYPEQU || r.typequ || "";
        const domaine = typeCode.charAt(0);
        const domaineLabel = DOMAINE_MAP[domaine] || "autre";

        byDomaine[domaineLabel] = (byDomaine[domaineLabel] || 0) + 1;

        // ✅ v3.10: Collecter les commerces proches (domaine B)
        if (domaine === "B" && commercesProches.length < 15) {
          const nomCommerce = r.NOM || r.nom || COMMERCE_TYPE_LABELS[typeCode] || "Commerce";
          commercesProches.push({
            nom: nomCommerce,
            type: COMMERCE_TYPE_LABELS[typeCode] || typeCode,
            type_code: typeCode,
            distance_m: Math.round(distance),
            distance_km: metersToKm(distance),
            adresse: r.ADRESSE || r.adresse || undefined,
            commune: r.LIBCOM || r.libcom || undefined,
          });
        }

        // ✅ v3.10: Collecter les professionnels de santé proches (domaine D)
        if (domaine === "D") {
          const santeType = SANTE_TYPE_MAP[typeCode] || "autre_sante";
          if (!santeByType[santeType]) {
            santeByType[santeType] = { count: 0, minDist: null };
          }
          santeByType[santeType].count++;
          if (santeByType[santeType].minDist === null || distance < santeByType[santeType].minDist!) {
            santeByType[santeType].minDist = Math.round(distance);
          }

          // ✅ v3.10: Collecter les médecins proches (types D201-D211)
          if (typeCode.startsWith("D2") && medecinsProches.length < 15) {
            const nomMedecin = r.NOM || r.nom || MEDECIN_SPECIALITE_LABELS[typeCode] || "Professionnel de santé";
            medecinsProches.push({
              nom: nomMedecin,
              specialite: MEDECIN_SPECIALITE_LABELS[typeCode] || typeCode,
              type_code: typeCode,
              distance_m: Math.round(distance),
              distance_km: metersToKm(distance),
              adresse: r.ADRESSE || r.adresse || undefined,
              commune: r.LIBCOM || r.libcom || undefined,
            });
          }
        }
      }
    }

    // Trier par distance
    commercesProches.sort((a, b) => a.distance_m - b.distance_m);
    medecinsProches.sort((a, b) => a.distance_m - b.distance_m);

    const nb_commerces = byDomaine.commerces || 0;
    const nb_sante = byDomaine.sante || 0;
    const nb_services = byDomaine.services || 0;
    const nb_enseignement = byDomaine.enseignement || 0;
    const nb_sport_culture = byDomaine.sport_culture || 0;

    const score_commerces = Math.min(100, nb_commerces * 2.5);
    const score_sante = Math.min(100, nb_sante * 3.0);
    const score_services = Math.min(100, nb_services * 1.5);

    const scoreCommodites = totalInRadius > 0
      ? Math.round((score_commerces + score_sante + score_services) / 3)
      : 0;

    const sante_details = Object.entries(santeByType).map(([type, data]) => ({
      type,
      label: SANTE_LABELS[type] || type,
      count: data.count,
      min_distance_m: data.minDist,
    }));

    const coverage: Coverage = totalInRadius > 0 ? "ok" : "no_data";

    const details: BpeKpis = {
      total_equipements: totalInRadius,
      nb_commerces,
      nb_sante,
      nb_services,
      nb_enseignement,
      nb_sport_culture,
      score_commerces,
      score_sante,
      score_services,
      scoreCommodites,
      sante_details,
      commerces_proches: commercesProches.slice(0, 10), // ✅ v3.10: Top 10 commerces
      medecins_proches: medecinsProches.slice(0, 10),   // ✅ v3.10: Top 10 médecins
    };

    const result = {
      scoreCommodites: coverage === "ok" ? scoreCommodites : null,
      details,
      coverage,
      totalEquipements: totalInRadius,
    };

    await saveToCache(cacheKey, "bpe", result, 86400);

    if (debug) console.log("✅ BPE result:", details);

    return result;
  } catch (e) {
    console.error("❌ BPE API error:", e);
    if (supabase) {
      console.log("📦 BPE: Fallback vers RPC après exception");
      return await fetchBpeStatsRpc(lat, lon, radiusM);
    }
    return {
      scoreCommodites: null,
      details: null,
      coverage: "error" as Coverage,
      totalEquipements: 0,
    };
  }
}

async function fetchBpeStatsRpc(
  lat: number,
  lon: number,
  radiusM = 500,
): Promise<{ scoreCommodites: number | null; details: BpeKpis | null; coverage: Coverage; totalEquipements: number }> {
  if (!supabase) return { scoreCommodites: null, details: null, coverage: "not_covered", totalEquipements: 0 };

  try {
    const { data, error } = await supabase.rpc("get_bpe_proximite", {
      p_lat: lat,
      p_lon: lon,
      p_rayon_m: radiusM,
      p_types: null,
    });

    if (error) {
      console.error("❌ RPC get_bpe_proximite error:", error);
      return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 };
    }

    const score = numOrNull((data as any)?.scoreCommodites);
    const totalEquipements = numOrNull((data as any)?.total_equipements_proximite) ?? 0;

    if (totalEquipements === 0 && (score === 0 || score == null)) {
      return { scoreCommodites: null, details: data as BpeKpis, coverage: "no_data", totalEquipements: 0 };
    }

    return { scoreCommodites: score, details: data as BpeKpis, coverage: score != null ? "ok" : "no_data", totalEquipements };
  } catch (e) {
    console.error("⚠️ fetchBpeStatsRpc error:", e);
    return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 };
  }
}

// ============================================================================
// ✅ v3.11: SERVICES ESSENTIELS ZONE RURALE (jusqu'à 20km)
// ============================================================================

// Récupérer les communes voisines dans un rayon donné
async function getCommunesVoisines(lat: number, lon: number, radiusKm: number): Promise<string[]> {
  try {
    // D'abord, trouver la commune principale
    const resp = await fetch(`${GEO_API_BASE}/communes?lat=${lat}&lon=${lon}&fields=code,nom,centre&format=json`);
    if (!resp.ok) return [];
    
    const mainCommune = await resp.json();
    const communes: string[] = [];
    
    if (Array.isArray(mainCommune) && mainCommune.length > 0) {
      communes.push(mainCommune[0].code);
    }
    
    // Récupérer le département
    const dep = communes[0]?.slice(0, 2);
    if (!dep) return communes;
    
    // Récupérer toutes les communes du département et filtrer par distance
    const depResp = await fetch(`${GEO_API_BASE}/departements/${dep}/communes?fields=code,nom,centre`);
    if (!depResp.ok) return communes;
    
    const allCommunes = await depResp.json();
    
    for (const c of allCommunes) {
      if (!c.centre?.coordinates) continue;
      const [cLon, cLat] = c.centre.coordinates;
      const dist = haversineDistance(lat, lon, cLat, cLon);
      if (dist <= radiusKm * 1000 && !communes.includes(c.code)) {
        communes.push(c.code);
      }
    }
    
    return communes.slice(0, 50); // Limiter à 50 communes max
  } catch (e) {
    console.warn("⚠️ getCommunesVoisines error:", e);
    return [];
  }
}

// Recherche des services essentiels dans un rayon élargi (zone rurale)
async function fetchServicesEssentielsRural(
  lat: number,
  lon: number,
  debug = false,
): Promise<ServicesRuraux> {
  console.log("🏘️ Recherche services essentiels zone rurale (rayon 20km)");
  
  const result: ServicesRuraux = {
    pharmacie_proche: null,
    supermarche_proche: null,
    hypermarche_proche: null,
    superette_proche: null,
    station_service_proche: null,
    poste_proche: null,
    banque_proche: null,
    medecin_proche: null,
    rayon_recherche_m: RAYON_RURAL_MAX_M,
  };

  // Récupérer les communes dans un rayon de 20km
  const communesVoisines = await getCommunesVoisines(lat, lon, 20);
  if (communesVoisines.length === 0) {
    console.log("⚠️ Aucune commune voisine trouvée");
    return result;
  }

  if (debug) console.log(`📍 ${communesVoisines.length} communes dans le rayon de 20km`);

  // Collecter tous les équipements essentiels
  const allEquipements: Array<{
    typeCode: string;
    nom: string;
    lat: number;
    lon: number;
    distance_m: number;
    commune: string;
    adresse?: string;
  }> = [];

  // Limiter à 20 communes pour la performance
  for (const communeCode of communesVoisines.slice(0, 20)) {
    try {
      const resp = await fetch(
        `${DATA_GOUV_BPE_API}/${BPE_RESOURCE_ID}/data/?DEPCOM__exact=${communeCode}&page_size=500`,
        { headers: { Accept: "application/json" } }
      );
      
      if (!resp.ok) continue;
      
      const json = await resp.json();
      const records = json.data || [];

      for (const r of records) {
        const eqLat = parseFloat(r.LATITUDE || r.latitude || "");
        const eqLon = parseFloat(r.LONGITUDE || r.longitude || "");
        if (isNaN(eqLat) || isNaN(eqLon)) continue;

        const typeCode = r.TYPEQU || r.typequ || "";
        const distance = haversineDistance(lat, lon, eqLat, eqLon);

        // Filtrer uniquement les services essentiels dans le rayon
        if (distance <= RAYON_RURAL_MAX_M && 
            (CODES_COMMERCES_ESSENTIELS.has(typeCode) || 
             CODES_SERVICES_ESSENTIELS.has(typeCode) || 
             CODES_SANTE_ESSENTIELS.has(typeCode))) {
          allEquipements.push({
            typeCode,
            nom: r.NOM || r.nom || "",
            lat: eqLat,
            lon: eqLon,
            distance_m: Math.round(distance),
            commune: r.LIBCOM || r.libcom || "",
            adresse: r.ADRESSE || r.adresse || undefined,
          });
        }
      }
    } catch (e) {
      // Continuer avec les autres communes
    }
  }

  // Trier par distance
  allEquipements.sort((a, b) => a.distance_m - b.distance_m);

  if (debug) console.log(`📦 ${allEquipements.length} équipements essentiels trouvés`);

  // Extraire le plus proche de chaque type
  for (const eq of allEquipements) {
    const distKm = metersToKm(eq.distance_m);
    
    const service: ServiceEssentiel = {
      nom: eq.nom || COMMERCE_TYPE_LABELS[eq.typeCode] || SERVICE_TYPE_LABELS[eq.typeCode] || MEDECIN_SPECIALITE_LABELS[eq.typeCode] || eq.typeCode,
      type: COMMERCE_TYPE_LABELS[eq.typeCode] || SERVICE_TYPE_LABELS[eq.typeCode] || MEDECIN_SPECIALITE_LABELS[eq.typeCode] || eq.typeCode,
      type_code: eq.typeCode,
      distance_m: eq.distance_m,
      distance_km: distKm,
      adresse: eq.adresse,
      commune: eq.commune,
    };

    // Pharmacie (D301)
    if (eq.typeCode === "D301" && !result.pharmacie_proche) {
      result.pharmacie_proche = service;
    }
    // Hypermarché (B101)
    if (eq.typeCode === "B101" && !result.hypermarche_proche) {
      result.hypermarche_proche = service;
    }
    // Supermarché (B102)
    if (eq.typeCode === "B102" && !result.supermarche_proche) {
      result.supermarche_proche = service;
    }
    // Supérette (B201)
    if (eq.typeCode === "B201" && !result.superette_proche) {
      result.superette_proche = service;
    }
    // Station service (B313)
    if (eq.typeCode === "B313" && !result.station_service_proche) {
      result.station_service_proche = service;
    }
    // Bureau de poste / Relais / Agence (A206, A207, A208)
    if ((eq.typeCode === "A206" || eq.typeCode === "A207" || eq.typeCode === "A208") && !result.poste_proche) {
      result.poste_proche = service;
    }
    // Banque / DAB (A203, A204)
    if ((eq.typeCode === "A203" || eq.typeCode === "A204") && !result.banque_proche) {
      result.banque_proche = service;
    }
    // Médecin généraliste (D201)
    if (eq.typeCode === "D201" && !result.medecin_proche) {
      result.medecin_proche = {
        nom: eq.nom || "Médecin généraliste",
        specialite: "Médecin généraliste",
        type_code: eq.typeCode,
        distance_m: eq.distance_m,
        distance_km: distKm,
        adresse: eq.adresse,
        commune: eq.commune,
      };
    }
  }

  return result;
}

// ============================================================================
// ✅ v3.11: RÉSIDENCES SENIORS (FINESS - hors EHPAD)
// ============================================================================
async function fetchResidencesSeniors(
  lat: number,
  lon: number,
  radiusKm: number = 20,
  debug = false,
): Promise<ResidenceSenior[]> {
  if (!supabase) return [];

  try {
    // Rechercher les résidences seniors dans FINESS
    // Catégories: Résidence autonomie, Résidence services seniors, Logement foyer, MARPA
    const { data, error } = await supabase
      .from("finess_etablissements")
      .select("finess, raison_sociale, commune, categorie, latitude, longitude")
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .or("categorie.ilike.%Résidence autonomie%,categorie.ilike.%Résidence services%,categorie.ilike.%Logement foyer%,categorie.ilike.%Foyer logement%,categorie.ilike.%MARPA%")
      .limit(200);

    if (error || !data) {
      if (debug) console.warn("⚠️ fetchResidencesSeniors error:", error);
      return [];
    }

    const residences: ResidenceSenior[] = [];

    for (const r of data) {
      const rLat = parseFloat(r.latitude);
      const rLon = parseFloat(r.longitude);
      if (isNaN(rLat) || isNaN(rLon)) continue;

      const dist = haversineDistance(lat, lon, rLat, rLon);
      if (dist <= radiusKm * 1000) {
        residences.push({
          nom: r.raison_sociale || "Résidence seniors",
          type: r.categorie || "Résidence seniors",
          commune: r.commune || "",
          distance_km: metersToKm(dist),
          finess: r.finess,
        });
      }
    }

    // Trier par distance
    residences.sort((a, b) => a.distance_km - b.distance_km);

    if (debug) console.log(`🏠 ${residences.length} résidences seniors trouvées dans ${radiusKm}km`);

    return residences.slice(0, 10); // Top 10
  } catch (e) {
    console.warn("⚠️ fetchResidencesSeniors error:", e);
    return [];
  }
}

// ============================================================================
// ✅ TRANSPORT PROVIDER - Conditionnel selon agglomération
// ============================================================================
async function fetchTransportScore(
  lat: number,
  lon: number,
  communeInsee: string | null,
): Promise<{ score: number | null; label: string | null; summary: string | null; coverage: Coverage; applicable: boolean }> {
  
  // ✅ v3.9 : Vérifier si on est dans une grande agglomération
  const isInMetro = isInGrandeAgglomeration(communeInsee);
  
  if (!isInMetro) {
    console.log("🚇 Transport: zone hors grande agglomération, critère non applicable");
    return {
      score: null,
      label: "Non applicable",
      summary: "Hors grande agglomération - critère non évalué",
      coverage: "ok",
      applicable: false,
    };
  }

  const functionsUrl = Deno.env.get("FUNCTIONS_URL") ?? (supabaseUrl ? `${supabaseUrl}/functions/v1` : "");
  if (!functionsUrl) {
    console.warn("⚠️ fetchTransportScore: no FUNCTIONS_URL available");
    return { score: null, label: null, summary: null, coverage: "not_covered", applicable: true };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceKey) {
    headers["Authorization"] = `Bearer ${serviceKey}`;
    headers["apikey"] = serviceKey;
  }

  try {
    console.log("🚇 fetchTransportScore calling:", `${functionsUrl}/transport-score`);

    const resp = await fetch(`${functionsUrl}/transport-score`, {
      method: "POST",
      headers,
      body: JSON.stringify({ lat, lng: lon, radius_m: 800 }),
    });

    const json = await resp.json().catch(() => null);

    if (!resp.ok) {
      console.warn("⚠️ fetchTransportScore non-OK response:", resp.status, json);
      return { score: null, label: null, summary: null, coverage: "error", applicable: true };
    }

    if (json?.success) {
      const scoring = json.scoring ?? {};
      const score = numOrNull(scoring.scoreTransport);
      console.log("✅ fetchTransportScore success, score:", score);
      return {
        score,
        label: safeToString(scoring.label),
        summary: safeToString(scoring.summary),
        coverage: score != null ? "ok" : "no_data",
        applicable: true,
      };
    }

    return { score: null, label: null, summary: null, coverage: "error", applicable: true };
  } catch (e) {
    console.error("⚠️ fetchTransportScore error:", e);
    return { score: null, label: null, summary: null, coverage: "error", applicable: true };
  }
}

// ============================================================================
// ✅ SANTÉ ENRICHIE v3.9 + v3.10 - Professionnels + Hôpital proche + Médecins proches
// ============================================================================
async function fetchHealthFicheForCommune(codeCommune: string): Promise<{ data: HealthFicheEnriched | null; coverage: Coverage }> {
  if (!supabase || !codeCommune) return { data: null, coverage: "not_covered" };
  try {
    const { data, error } = await supabase.rpc("get_fiche_sante_commune", { p_code_commune: codeCommune });
    if (error) {
      console.error("❌ RPC get_fiche_sante_commune error:", error);
      return { data: null, coverage: "error" };
    }
    return { data: data as HealthFicheEnriched | null, coverage: data ? "ok" : "no_data" };
  } catch (e) {
    console.error("❌ fetchHealthFicheForCommune error:", e);
    return { data: null, coverage: "error" };
  }
}

async function fetchHopitalProche(
  lat: number,
  lon: number,
  maxRadiusKm: number = 50,
): Promise<HopitalProche> {
  if (!supabase) return null;

  try {
    // Essayer la RPC si elle existe
    const { data, error } = await supabase.rpc("get_hopital_proche", {
      p_lat: lat,
      p_lon: lon,
      p_radius_km: maxRadiusKm,
    });

    if (!error && data && Array.isArray(data) && data.length > 0) {
      const h = data[0];
      return {
        nom: h.raison_sociale || h.nom || "Hôpital",
        commune: h.commune || "",
        distance_km: Math.round((h.distance_m || 0) / 100) / 10,
        type: h.categorie || "Établissement de santé",
      };
    }

    // Fallback: chercher dans finess_etablissements directement
    const { data: finessData, error: finessError } = await supabase
      .from("finess_etablissements")
      .select("finess, raison_sociale, commune, categorie, latitude, longitude")
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .in("categorie", [
        "Centre Hospitalier Régional",
        "Centre Hospitalier",
        "Centre Hospitalier Spécialisé",
        "Hôpital local",
        "Clinique MCO",
        "Hôpital des armées",
      ])
      .limit(100);

    if (finessError || !finessData) return null;

    // Calculer les distances et trouver le plus proche
    let closest: HopitalProche = null;
    let minDistance = Infinity;

    for (const h of finessData) {
      const hLat = parseFloat(h.latitude);
      const hLon = parseFloat(h.longitude);
      if (isNaN(hLat) || isNaN(hLon)) continue;

      const dist = haversineDistance(lat, lon, hLat, hLon);
      if (dist < minDistance && dist <= maxRadiusKm * 1000) {
        minDistance = dist;
        closest = {
          nom: h.raison_sociale || "Hôpital",
          commune: h.commune || "",
          distance_km: Math.round(dist / 100) / 10,
          type: h.categorie || "Établissement de santé",
        };
      }
    }

    return closest;
  } catch (e) {
    console.warn("⚠️ fetchHopitalProche error:", e);
    return null;
  }
}

async function enrichHealthData(
  lat: number,
  lon: number,
  healthData: HealthFicheEnriched | null,
  bpeSanteDetails: Array<{ type: string; label: string; count: number; min_distance_m: number | null }> | null,
  medecinsProches?: MedecinProche[],
): Promise<HealthFicheEnriched | null> {
  if (!healthData) return null;

  // Rechercher l'hôpital le plus proche
  const hopital = await fetchHopitalProche(lat, lon, 50);

  // Construire les détails des professionnels
  const professionnels_details: ProfessionnelsSanteDetails = {
    medecins_generalistes: healthData.kpi.generalistes_total ?? 0,
    medecins_specialistes: Math.max(0, (healthData.kpi.medecins_total ?? 0) - (healthData.kpi.generalistes_total ?? 0)),
    dentistes: healthData.kpi.dentistes_total ?? 0,
    infirmiers: healthData.kpi.infirmiers_total ?? 0,
    kinesitherapeutes: 0,
    pharmacies: healthData.kpi.pharmacies_total ?? 0,
    autres: healthData.kpi.autres_professionnels ?? 0,
  };

  // Enrichir avec BPE si disponible
  if (bpeSanteDetails && bpeSanteDetails.length > 0) {
    for (const detail of bpeSanteDetails) {
      if (detail.type === "kinesitherapeute") {
        professionnels_details.kinesitherapeutes = detail.count;
      }
    }
  }

  // Construire un résumé enrichi
  const resumeParts: string[] = [];
  resumeParts.push(`La commune de ${healthData.commune} compte ${healthData.population?.toLocaleString("fr-FR") ?? "?"} habitants.`);

  const profList: string[] = [];
  if (professionnels_details.medecins_generalistes > 0) {
    profList.push(`${professionnels_details.medecins_generalistes} médecin${professionnels_details.medecins_generalistes > 1 ? "s" : ""} généraliste${professionnels_details.medecins_generalistes > 1 ? "s" : ""}`);
  }
  if (professionnels_details.medecins_specialistes > 0) {
    profList.push(`${professionnels_details.medecins_specialistes} spécialiste${professionnels_details.medecins_specialistes > 1 ? "s" : ""}`);
  }
  if (professionnels_details.dentistes > 0) {
    profList.push(`${professionnels_details.dentistes} dentiste${professionnels_details.dentistes > 1 ? "s" : ""}`);
  }
  if (professionnels_details.infirmiers > 0) {
    profList.push(`${professionnels_details.infirmiers} infirmier${professionnels_details.infirmiers > 1 ? "s" : ""}`);
  }
  if (professionnels_details.kinesitherapeutes > 0) {
    profList.push(`${professionnels_details.kinesitherapeutes} kinésithérapeute${professionnels_details.kinesitherapeutes > 1 ? "s" : ""}`);
  }
  if (professionnels_details.pharmacies > 0) {
    profList.push(`${professionnels_details.pharmacies} pharmacie${professionnels_details.pharmacies > 1 ? "s" : ""}`);
  }

  if (profList.length > 0) {
    resumeParts.push(`Professionnels de santé : ${profList.join(", ")}.`);
  } else {
    resumeParts.push("Aucun professionnel de santé recensé sur la commune.");
  }

  if (hopital) {
    resumeParts.push(`Hôpital le plus proche : ${hopital.nom} à ${hopital.commune} (${hopital.distance_km} km).`);
  }

  return {
    ...healthData,
    resume: resumeParts.join(" "),
    professionnels_details,
    hopital_proche: hopital,
    medecins_proches: medecinsProches, // ✅ v3.10: Ajout des médecins proches
  };
}

// ============================================================================
// INSEE / ÉCOLES (RPC existants)
// ============================================================================
async function fetchInseeStats(communeInsee: string | null): Promise<{ data: any | null; coverage: Coverage }> {
  if (!supabase || !communeInsee) return { data: null, coverage: "not_covered" };
  try {
    const { data, error } = await supabase
      .from("insee_communes_stats")
      .select("code_commune,commune,population,pct_moins_25,pct_plus_65")
      .eq("code_commune", communeInsee)
      .limit(1)
      .maybeSingle();

    if (error) return { data: null, coverage: "error" };
    return { data: data ?? null, coverage: data ? "ok" : "no_data" };
  } catch (_e) {
    return { data: null, coverage: "error" };
  }
}

type EcolesStats = {
  nearestDistanceM: number | null;
  nearestName: string | null;
  nearestType: string | null;
  count300m: number;
  count500m: number;
  count1000m: number;
  scoreEcoles: number | null;
};

async function fetchEcolesStats(lat: number, lng: number): Promise<{ data: EcolesStats | null; coverage: Coverage }> {
  if (!supabase) return { data: null, coverage: "not_covered" };
  try {
    const { data, error } = await supabase.rpc("get_ecoles_proximite", { lat, lng, rayon_m: 1000 });
    if (error) {
      console.error("❌ RPC get_ecoles_proximite error:", error);
      return { data: null, coverage: "error" };
    }
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      return {
        data: { nearestDistanceM: null, nearestName: null, nearestType: null, count300m: 0, count500m: 0, count1000m: 0, scoreEcoles: null },
        coverage: "no_data",
      };
    }
    const nearest = rows[0] as any;
    const count300m = rows.filter((r: any) => r.distance_m <= 300).length;
    const count500m = rows.filter((r: any) => r.distance_m <= 500).length;
    const count1000m = rows.length;

    const nearestDistance = numOrNull(nearest.distance_m);

    let baseScore = 50;
    if (nearestDistance != null) {
      if (nearestDistance <= 200) baseScore = 95;
      else if (nearestDistance <= 300) baseScore = 90;
      else if (nearestDistance <= 500) baseScore = 80;
      else if (nearestDistance <= 800) baseScore = 70;
      else if (nearestDistance <= 1200) baseScore = 60;
    }

    const densityBonus = (count300m >= 2 ? 5 : 0) + (count500m >= 4 ? 5 : 0) + (count1000m >= 8 ? 5 : 0);
    const scoreEcoles = Math.min(100, baseScore + densityBonus);

    return {
      data: {
        nearestDistanceM: nearestDistance,
        nearestName: safeToString(nearest.nom),
        nearestType: safeToString(nearest.type_etablissement),
        count300m,
        count500m,
        count1000m,
        scoreEcoles,
      },
      coverage: "ok",
    };
  } catch (e) {
    console.error("❌ fetchEcolesStats error:", e);
    return { data: null, coverage: "error" };
  }
}

// ============================================================================
// ✅ CALCUL INDICES & VERDICT v3.9 (avec poids adaptatifs)
// ============================================================================
function computeMarketIndices(
  dvfStats: DvfMarketStats | null,
  transportScore: number | null,
  transportApplicable: boolean,
  commoditesScore: number | null,
  targets: MarketStudyPayload["targets"],
  bpeCoverage: Coverage = "ok",
): {
  demand_index: number | null;
  supply_index: number | null;
  price_index: number | null;
  accessibility_index: number | null;
  risk_index: number | null;
  global_score: number;
} {
  // Transport uniquement si applicable (grande agglomération)
  const accessibility_index = transportApplicable ? transportScore : null;

  let supply_index: number | null = null;
  if (dvfStats?.transactions_count != null) {
    supply_index = computeIndex(dvfStats.transactions_count, 0, 100, false);
  }

  let demand_index: number | null = null;
  if (dvfStats?.evolution_pct != null) {
    demand_index = computeIndex(dvfStats.evolution_pct, -10, 10, false);
  }

  // ✅ v3.9: Price index avec gestion des targets aberrants
  let price_index: number | null = null;
  if (dvfStats?.price_median_eur_m2 && targets?.unit_price_m2) {
    const ratio = dvfStats.price_median_eur_m2 / targets.unit_price_m2;
    // Si ratio aberrant (< 0.1 ou > 10), ignorer le target
    if (ratio >= 0.1 && ratio <= 10) {
      price_index = computeIndex(ratio, 0.5, 1.5, true);
    } else {
      // Target aberrant, utiliser score neutre
      price_index = 50;
    }
  } else if (dvfStats?.price_median_eur_m2) {
    price_index = 50;
  }

  let risk_index: number | null = null;
  if (bpeCoverage === "ok" && commoditesScore != null) {
    risk_index = Math.round(100 - commoditesScore);
  }

  // ✅ v3.9: Calcul avec poids adaptatifs selon données disponibles
  const items: Array<{ w: number; v: number | null }> = [];

  // DVF: toujours inclus si données disponibles
  if (dvfStats && dvfStats.transactions_count > 0) {
    items.push({ w: 0.35, v: supply_index });
    items.push({ w: 0.25, v: price_index });
  }

  // Transport: uniquement si applicable ET données disponibles
  if (transportApplicable && transportScore != null) {
    items.push({ w: 0.20, v: accessibility_index });
  }

  // BPE: si données disponibles
  if (bpeCoverage === "ok" && commoditesScore != null) {
    items.push({ w: 0.20, v: commoditesScore });
  }

  const global = weightedAverage(items);

  return {
    demand_index,
    supply_index,
    price_index,
    accessibility_index,
    risk_index,
    global_score: global == null ? 50 : Math.round(global),
  };
}

function generateVerdict(
  score: number,
  dvfStats: DvfMarketStats | null,
  dvfCoverage: Coverage,
  projectNature: string,
  transportApplicable: boolean,
): string {
  const p = (projectNature ?? "").toString().toLowerCase();
  const projectLabel =
    p === "logement" ? "logement" :
    p === "bureaux" ? "bureaux" :
    p === "commerce" ? "commerce" :
    p === "hotel" ? "hôtel" :
    p === "ehpad" ? "EHPAD" :
    p === "residence_senior" ? "résidence senior" :
    p === "residence_etudiante" ? "résidence étudiante" :
    projectNature;

  const transportNote = !transportApplicable ? " (zone hors métropole, transport non évalué)" : "";

  if (dvfCoverage === "not_covered") return `Prix/transactions indisponibles (DVF: ${coverageLabel(dvfCoverage)}).`;
  if (dvfCoverage === "error") return `Erreur lors de la récupération DVF.`;
  if (dvfStats == null || dvfStats.transactions_count === 0) {
    return `Données de marché insuffisantes pour évaluer ce projet de ${projectLabel}. Élargir le périmètre recommandé.`;
  }
  if (score >= 70) return `Marché très favorable pour un projet de ${projectLabel}${transportNote}. Demande soutenue et bonne liquidité.`;
  if (score >= 55) return `Marché favorable pour un projet de ${projectLabel}${transportNote}. Conditions de marché correctes.`;
  if (score >= 40) return `Marché modéré pour un projet de ${projectLabel}${transportNote}. Analyse approfondie recommandée.`;
  return `Marché tendu pour un projet de ${projectLabel}${transportNote}. Vigilance requise sur le positionnement prix.`;
}

function generateInsights(
  dvfStats: DvfMarketStats | null,
  dvfCoverage: Coverage,
  transportScore: number | null,
  transportApplicable: boolean,
  commoditesScore: number | null,
  ecolesScore: number | null,
  radiusKm: number,
  bpeCoverage: Coverage = "ok",
  healthSummary: HealthFicheEnriched | null = null,
  bpeDetails: BpeKpis | null = null,
  servicesRuraux: ServicesRuraux | null = null,
  isRural: boolean = false,
): MarketInsight[] {
  const insights: MarketInsight[] = [];

  // DVF
  if (dvfCoverage === "not_covered") {
    insights.push({ type: "warning", title: "DVF non couvert", description: "La source DVF n'est pas disponible.", source: "DVF" });
  } else if (dvfCoverage === "error") {
    insights.push({ type: "warning", title: "Erreur DVF", description: "Erreur lors de l'appel DVF.", source: "DVF" });
  } else if (dvfStats && dvfStats.transactions_count > 0) {
    insights.push({
      type: dvfStats.transactions_count >= 30 ? "positive" : "neutral",
      title: `${dvfStats.transactions_count} transactions analysées`,
      description: `Marché actif avec ${dvfStats.transactions_count} ventes dans un rayon de ${radiusKm} km.`,
      source: "DVF",
    });
    if (dvfStats.price_median_eur_m2) {
      insights.push({
        type: "neutral",
        title: `Prix médian : ${dvfStats.price_median_eur_m2.toLocaleString("fr-FR")} €/m²`,
        description: `Intervalle (Q1–Q3) : ${dvfStats.price_q1_eur_m2?.toLocaleString("fr-FR") ?? "?"} à ${dvfStats.price_q3_eur_m2?.toLocaleString("fr-FR") ?? "?"} €/m².`,
        source: "DVF",
      });
    }
  } else {
    insights.push({ type: "warning", title: "Données DVF insuffisantes", description: "Peu ou pas de transactions. Élargir le rayon.", source: "DVF" });
  }

  // Transport (conditionnel)
  if (transportApplicable) {
    if (transportScore != null) {
      const level = transportScore >= 70 ? "Excellente" : transportScore >= 50 ? "Bonne" : transportScore >= 30 ? "Moyenne" : "Faible";
      insights.push({
        type: transportScore >= 50 ? "positive" : transportScore >= 30 ? "neutral" : "negative",
        title: `${level} desserte transports (${transportScore}/100)`,
        description: "Accessibilité transports en commun.",
        source: "Transport",
      });
    }
  } else {
    insights.push({
      type: "neutral",
      title: "Transports en commun",
      description: "Zone hors grande agglomération - critère non évalué.",
      source: "Transport",
    });
  }

  // ✅ v3.11: Insights spécifiques zone rurale
  if (isRural && servicesRuraux) {
    // Pharmacie
    if (servicesRuraux.pharmacie_proche) {
      const p = servicesRuraux.pharmacie_proche;
      insights.push({
        type: p.distance_km <= 5 ? "positive" : p.distance_km <= 10 ? "neutral" : "negative",
        title: `Pharmacie à ${p.distance_km} km`,
        description: `${p.nom} (${p.commune}).`,
        source: "Services ruraux",
      });
    } else {
      insights.push({
        type: "warning",
        title: "Aucune pharmacie trouvée",
        description: "Pas de pharmacie dans un rayon de 20 km.",
        source: "Services ruraux",
      });
    }

    // Commerce alimentaire
    const commerce = servicesRuraux.supermarche_proche || servicesRuraux.hypermarche_proche || servicesRuraux.superette_proche;
    if (commerce) {
      insights.push({
        type: commerce.distance_km <= 10 ? "positive" : commerce.distance_km <= 15 ? "neutral" : "negative",
        title: `${commerce.type} à ${commerce.distance_km} km`,
        description: `${commerce.nom} (${commerce.commune}).`,
        source: "Services ruraux",
      });
    }

    // Médecin
    if (servicesRuraux.medecin_proche) {
      const m = servicesRuraux.medecin_proche;
      insights.push({
        type: (m.distance_km ?? 0) <= 10 ? "positive" : (m.distance_km ?? 0) <= 15 ? "neutral" : "negative",
        title: `Médecin généraliste à ${m.distance_km} km`,
        description: `${m.commune}.`,
        source: "Services ruraux",
      });
    } else {
      insights.push({
        type: "warning",
        title: "Aucun médecin trouvé",
        description: "Pas de médecin généraliste dans un rayon de 20 km.",
        source: "Services ruraux",
      });
    }

    // Poste
    if (servicesRuraux.poste_proche) {
      const s = servicesRuraux.poste_proche;
      insights.push({
        type: s.distance_km <= 5 ? "positive" : "neutral",
        title: `${s.type} à ${s.distance_km} km`,
        description: `${s.commune}.`,
        source: "Services ruraux",
      });
    }

    // Station service
    if (servicesRuraux.station_service_proche) {
      const s = servicesRuraux.station_service_proche;
      insights.push({
        type: s.distance_km <= 10 ? "positive" : "neutral",
        title: `Station service à ${s.distance_km} km`,
        description: `${s.commune}.`,
        source: "Services ruraux",
      });
    }
  } else {
    // ✅ v3.10: Commerces proches (mode urbain)
    if (bpeDetails?.commerces_proches && bpeDetails.commerces_proches.length > 0) {
      const commercesTop3 = bpeDetails.commerces_proches.slice(0, 3);
      const commercesDesc = commercesTop3.map(c => `${c.type} à ${c.distance_m}m`).join(", ");
      insights.push({
        type: bpeDetails.nb_commerces >= 5 ? "positive" : bpeDetails.nb_commerces >= 2 ? "neutral" : "negative",
        title: `${bpeDetails.nb_commerces} commerces à proximité`,
        description: `Les plus proches : ${commercesDesc}.`,
        source: "BPE",
      });
    } else if (bpeCoverage === "no_data") {
      insights.push({ type: "warning", title: "Données BPE indisponibles", description: "Aucun équipement trouvé dans le périmètre.", source: "BPE" });
    } else if (commoditesScore != null) {
      const level = commoditesScore >= 70 ? "Excellente" : commoditesScore >= 50 ? "Bonne" : commoditesScore >= 30 ? "Moyenne" : "Faible";
      insights.push({
        type: commoditesScore >= 50 ? "positive" : commoditesScore >= 30 ? "neutral" : "negative",
        title: `${level} proximité commerces/services`,
        description: "Densité d'équipements à proximité (BPE).",
        source: "BPE",
      });
    }
  }

  // Écoles
  if (ecolesScore != null) {
    const level = ecolesScore >= 70 ? "Très bonne" : ecolesScore >= 50 ? "Bonne" : ecolesScore >= 30 ? "Moyenne" : "Faible";
    insights.push({
      type: ecolesScore >= 50 ? "positive" : ecolesScore >= 30 ? "neutral" : "negative",
      title: `${level} accessibilité scolaire (${ecolesScore}/100)`,
      description: "Basé sur la proximité et la densité d'établissements à 1 km.",
      source: "Écoles",
    });
  }

  // ✅ v3.10: Médecins proches (mode urbain uniquement)
  if (!isRural) {
    const medecinsProches = bpeDetails?.medecins_proches || healthSummary?.medecins_proches;
    if (medecinsProches && medecinsProches.length > 0) {
      const medecinsTop3 = medecinsProches.slice(0, 3);
      const medecinsDesc = medecinsTop3.map(m => `${m.specialite} à ${m.distance_m}m`).join(", ");
      insights.push({
        type: medecinsProches.length >= 5 ? "positive" : medecinsProches.length >= 2 ? "neutral" : "negative",
        title: `${medecinsProches.length} professionnels de santé à proximité`,
        description: `Les plus proches : ${medecinsDesc}.`,
        source: "Santé",
      });
    } else if (healthSummary) {
      // Fallback sur les données de commune
      const prof = healthSummary.professionnels_details;
      if (prof) {
        const totalProf = prof.medecins_generalistes + prof.dentistes + prof.infirmiers + prof.pharmacies;
        if (totalProf > 0) {
          const profParts: string[] = [];
          if (prof.medecins_generalistes > 0) profParts.push(`${prof.medecins_generalistes} médecin(s)`);
          if (prof.infirmiers > 0) profParts.push(`${prof.infirmiers} infirmier(s)`);
          if (prof.dentistes > 0) profParts.push(`${prof.dentistes} dentiste(s)`);
          if (prof.pharmacies > 0) profParts.push(`${prof.pharmacies} pharmacie(s)`);

          insights.push({
            type: totalProf >= 5 ? "positive" : totalProf >= 2 ? "neutral" : "negative",
            title: `${totalProf} professionnels de santé sur la commune`,
            description: profParts.join(", ") + ".",
            source: "Santé",
          });
        } else {
          insights.push({
            type: "warning",
            title: "Peu de professionnels de santé",
            description: "Aucun professionnel de santé recensé sur la commune.",
            source: "Santé",
          });
        }
      }
    }
  }

  // Hôpital proche
  if (healthSummary?.hopital_proche) {
    const h = healthSummary.hopital_proche;
    insights.push({
      type: h.distance_km <= 15 ? "positive" : h.distance_km <= 30 ? "neutral" : "negative",
      title: `Hôpital à ${h.distance_km} km`,
      description: `${h.nom} (${h.commune}).`,
      source: "Santé",
    });
  }

  return insights;
}

// ============================================================================
// HANDLER MARKET_STUDY
// ============================================================================
async function handleMarketStudy(payload: MarketStudyPayload): Promise<Response> {
  const {
    parcel_id,
    commune_insee,
    project_nature,
    radius_km = 2,
    horizon_months = 24,
    targets,
    debug = false,
  } = payload;

  console.log("📊 market_study payload:", { parcel_id, commune_insee, project_nature, radius_km, horizon_months, debug });

  if (!supabase) {
    return new Response(
      JSON.stringify({ success: false, error: "Supabase non initialisé", mode: "market_study", version: "v3.11" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!parcel_id && !commune_insee && payload.lat == null) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing parcel_id, commune_insee, or lat/lon", mode: "market_study", version: "v3.11" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { point, error: pointError, inseeMeta, debugResolve } = await resolveAnalysisPoint(payload);
  if (!point) {
    return new Response(
      JSON.stringify({
        success: false,
        error: pointError ?? "Impossible de résoudre le point d'analyse",
        mode: "market_study",
        version: "v3.11",
        debugResolve: debug ? debugResolve : undefined,
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  console.log("📍 Point d'analyse résolu:", point);

  const communeInseeFinal = point.commune_insee ?? commune_insee?.toString() ?? null;
  const dvfTypeLocal = mapProjectNatureToDvfType(project_nature);

  // ✅ v3.11: Détection zone rurale
  const isRural = !isInGrandeAgglomeration(communeInseeFinal);
  console.log(`🏘️ Zone: ${isRural ? "RURALE" : "URBAINE"}`);

  // ✅ DVF via CSV data.gouv.fr + fallback RPC
  let dvfCoverage: Coverage = "not_covered";
  let dvfReason: string | null = null;
  let dvfStats: DvfMarketStats | null = null;
  let comps: MarketComp[] = [];
  let dvfSource = "csv";

  const dvfApi = await dvfMarketKpis({
    lat: point.lat,
    lon: point.lon,
    radius_m: Math.round(radius_km * 1000),
    horizon_months,
    type_local: dvfTypeLocal,
    commune_insee: communeInseeFinal,
    ttl_seconds: 86400,
    debug,
  });

  dvfCoverage = dvfApi.coverage;
  dvfReason = dvfApi.reason ?? null;
  dvfSource = dvfApi.source;

  if (dvfApi.coverage === "ok" || dvfApi.coverage === "no_data") {
    dvfStats = {
      transactions_count: dvfApi.kpis.n,
      transactions_count_previous: 0,
      price_median_eur_m2: dvfApi.kpis.median_price_m2,
      price_mean_eur_m2: dvfApi.kpis.avg_price_m2,
      price_q1_eur_m2: dvfApi.kpis.q1_price_m2,
      price_q3_eur_m2: dvfApi.kpis.q3_price_m2,
      evolution_pct: null,
      volume_total_eur: null,
      surface_mean_m2: null,
    };
    comps = dvfApi.comps;
  }

  // Fallback RPC si CSV échoue ou no_data
  if ((dvfApi.coverage === "not_covered" || dvfApi.coverage === "error" || dvfApi.coverage === "no_data") && dvfApi.kpis.n === 0) {
    console.log("📊 DVF CSV failed or no_data, trying RPC fallback...");
    const r = await fetchDvfMarketStatsRpc(point, radius_km, horizon_months, dvfTypeLocal);
    if (r.stats && r.stats.transactions_count > 0) {
      dvfStats = r.stats;
      comps = r.comps;
      dvfCoverage = "ok";
      dvfReason = "RPC fallback OK";
      dvfSource = "rpc";
    } else if (r.error) {
      dvfCoverage = dvfApi.coverage === "no_data" ? "no_data" : "error";
      dvfReason = r.error;
    }
  }

  // ✅ Autres providers
  const transportResult = await fetchTransportScore(point.lat, point.lon, communeInseeFinal);
  
  // ✅ v3.11: Rayon adaptatif pour BPE
  const bpeRadius = isRural ? RAYON_RURAL_MIN_M : RAYON_URBAIN_M;
  const bpeResult = await fetchBpeStats(point.lat, point.lon, bpeRadius, communeInseeFinal, debug);
  
  const ecolesResult = await fetchEcolesStats(point.lat, point.lon);

  // ✅ v3.11: Services essentiels zone rurale
  let servicesRuraux: ServicesRuraux | null = null;
  let residencesSeniors: ResidenceSenior[] = [];
  
  if (isRural) {
    servicesRuraux = await fetchServicesEssentielsRural(point.lat, point.lon, debug);
    residencesSeniors = await fetchResidencesSeniors(point.lat, point.lon, 20, debug);
  }

  // ✅ Santé enrichie v3.9 + v3.10
  let healthSummary: HealthFicheEnriched | null = null;
  if (communeInseeFinal) {
    const healthResult = await fetchHealthFicheForCommune(communeInseeFinal);
    healthSummary = await enrichHealthData(
      point.lat,
      point.lon,
      healthResult.data,
      bpeResult.details?.sante_details ?? null,
      bpeResult.details?.medecins_proches ?? undefined
    );
  }

  const inseeResult = inseeMeta?.code_commune
    ? { data: inseeMeta, coverage: "ok" as Coverage }
    : await fetchInseeStats(communeInseeFinal);

  // ✅ v3.11: Rayon adaptatif pour EHPAD
  const ehpadRadius = isRural ? RAYON_RURAL_MAX_M : 5000;
  const ehpad = await finessEhpadNearby(supabase, {
    lat: point.lat,
    lon: point.lon,
    radius_m: ehpadRadius,
    ttl_seconds: 86400,
    debug,
  });

  // ✅ Indices & verdict v3.9
  const indices = computeMarketIndices(
    dvfStats,
    transportResult.score,
    transportResult.applicable,
    bpeResult.scoreCommodites,
    targets,
    bpeResult.coverage
  );

  const verdict = generateVerdict(
    indices.global_score,
    dvfStats,
    dvfCoverage,
    project_nature,
    transportResult.applicable
  );

  const insights = generateInsights(
    dvfStats,
    dvfCoverage,
    transportResult.score,
    transportResult.applicable,
    bpeResult.scoreCommodites,
    ecolesResult.data?.scoreEcoles ?? null,
    radius_km,
    bpeResult.coverage,
    healthSummary,
    bpeResult.details,
    servicesRuraux,
    isRural
  );

  // ✅ KPIs enrichis v3.9 + v3.10 + v3.11
  const kpis: MarketKpi[] = [
    { label: "Prix médian", value: dvfCoverage === "ok" ? dvfStats?.price_median_eur_m2 ?? null : null, unit: "€/m²", description: dvfCoverage === "ok" ? "Prix médian des transactions" : `DVF: ${coverageLabel(dvfCoverage)}` },
    { label: "Prix moyen", value: dvfCoverage === "ok" ? dvfStats?.price_mean_eur_m2 ?? null : null, unit: "€/m²" },
    { label: "Fourchette (Q1–Q3)", value: dvfCoverage === "ok" && dvfStats?.price_q1_eur_m2 && dvfStats?.price_q3_eur_m2 ? `${dvfStats.price_q1_eur_m2.toLocaleString("fr-FR")} - ${dvfStats.price_q3_eur_m2.toLocaleString("fr-FR")}` : null, unit: "€/m²" },
    { label: "Transactions", value: dvfCoverage === "ok" ? dvfStats?.transactions_count ?? null : null, description: `Rayon ${radius_km} km` },
  ];

  // Transport conditionnel
  if (transportResult.applicable) {
    kpis.push({ label: "Accessibilité transports", value: transportResult.score, unit: "/100", description: transportResult.summary ?? "Score transports" });
  } else {
    kpis.push({ label: "Accessibilité transports", value: null, description: "Hors grande agglomération - non évalué" });
  }

  kpis.push({ label: "Écoles", value: ecolesResult.data?.scoreEcoles ?? null, unit: "/100", description: ecolesResult.data ? `Plus proche à ${Math.round(ecolesResult.data.nearestDistanceM ?? 0)} m` : "Données indisponibles" });

  // ✅ v3.11: KPIs spécifiques zone rurale
  if (isRural && servicesRuraux) {
    if (servicesRuraux.pharmacie_proche) {
      kpis.push({
        label: "Pharmacie la plus proche",
        value: servicesRuraux.pharmacie_proche.distance_km,
        unit: "km",
        description: `${servicesRuraux.pharmacie_proche.nom} (${servicesRuraux.pharmacie_proche.commune})`
      });
    }

    const commerce = servicesRuraux.supermarche_proche || servicesRuraux.hypermarche_proche || servicesRuraux.superette_proche;
    if (commerce) {
      kpis.push({
        label: "Commerce alimentaire",
        value: commerce.distance_km,
        unit: "km",
        description: `${commerce.type} (${commerce.commune})`
      });
    }

    if (servicesRuraux.medecin_proche) {
      kpis.push({
        label: "Médecin généraliste",
        value: servicesRuraux.medecin_proche.distance_km,
        unit: "km",
        description: `${servicesRuraux.medecin_proche.commune}`
      });
    }

    if (servicesRuraux.poste_proche) {
      kpis.push({
        label: "Bureau de poste",
        value: servicesRuraux.poste_proche.distance_km,
        unit: "km",
        description: `${servicesRuraux.poste_proche.type} (${servicesRuraux.poste_proche.commune})`
      });
    }

    if (servicesRuraux.banque_proche) {
      kpis.push({
        label: "Banque/DAB",
        value: servicesRuraux.banque_proche.distance_km,
        unit: "km",
        description: `${servicesRuraux.banque_proche.type} (${servicesRuraux.banque_proche.commune})`
      });
    }
  } else {
    // Mode urbain
    kpis.push({ label: "Commodités (BPE)", value: bpeResult.coverage === "ok" ? bpeResult.scoreCommodites : null, unit: "/100", description: bpeResult.coverage === "ok" ? "Score commerces/services/santé" : `BPE: ${coverageLabel(bpeResult.coverage)}` });
  }

  kpis.push({ label: "Population", value: inseeResult.data?.population ?? null, description: "Population communale (INSEE)" });

  // ✅ v3.10: KPIs commerces proches (mode urbain)
  if (!isRural && bpeResult.details?.commerces_proches && bpeResult.details.commerces_proches.length > 0) {
    const commerceProche = bpeResult.details.commerces_proches[0];
    kpis.push({
      label: "Commerce le plus proche",
      value: commerceProche.distance_m,
      unit: "m",
      description: `${commerceProche.type}`
    });
  }

  // ✅ v3.10: KPIs médecins proches
  const medecinsProches = bpeResult.details?.medecins_proches || healthSummary?.medecins_proches;
  if (!isRural && medecinsProches && medecinsProches.length > 0) {
    const medecinProche = medecinsProches[0];
    kpis.push({
      label: "Professionnel santé le plus proche",
      value: medecinProche.distance_m,
      unit: "m",
      description: `${medecinProche.specialite}`
    });
  }

  // ✅ KPIs santé enrichis v3.9
  if (healthSummary?.professionnels_details) {
    const prof = healthSummary.professionnels_details;
    const profDesc = [
      prof.medecins_generalistes > 0 ? `${prof.medecins_generalistes} généraliste(s)` : null,
      prof.infirmiers > 0 ? `${prof.infirmiers} infirmier(s)` : null,
      prof.dentistes > 0 ? `${prof.dentistes} dentiste(s)` : null,
      prof.pharmacies > 0 ? `${prof.pharmacies} pharmacie(s)` : null,
    ].filter(Boolean).join(", ");

    kpis.push({
      label: "Professionnels de santé (commune)",
      value: prof.medecins_generalistes + prof.infirmiers + prof.dentistes + prof.pharmacies,
      description: profDesc || "Aucun sur la commune"
    });
  }

  if (healthSummary?.hopital_proche) {
    kpis.push({
      label: "Hôpital le plus proche",
      value: healthSummary.hopital_proche.distance_km,
      unit: "km",
      description: `${healthSummary.hopital_proche.nom} (${healthSummary.hopital_proche.commune})`
    });
  }

  // ✅ v3.11: KPI établissements seniors combinés
  const totalEtablissementsSeniors = (ehpad.coverage === "ok" ? ehpad.count : 0) + residencesSeniors.length;
  kpis.push({
    label: "Établissements seniors",
    value: totalEtablissementsSeniors > 0 ? totalEtablissementsSeniors : null,
    description: isRural
      ? `${ehpad.count || 0} EHPAD + ${residencesSeniors.length} résidences (rayon ${ehpadRadius / 1000}km)`
      : `FINESS: ${coverageLabel(ehpad.coverage)}`
  });

  const output: any = {
    success: true,
    version: "v3.11",
    orchestrator: "smartscore-enriched-v3",
    mode: "market_study",
    zone_type: isRural ? "rural" : "urbain", // ✅ v3.11
    input: {
      parcel_id: parcel_id ?? null,
      commune_insee: commune_insee?.toString() ?? null,
      project_nature,
      radius_km,
      horizon_months,
      targets: targets ?? null,
      resolved_point: point,
      dvf_type_local: dvfTypeLocal,
    },
    market: {
      verdict,
      score: indices.global_score,
      demand_index: indices.demand_index,
      supply_index: indices.supply_index,
      price_index: indices.price_index,
      accessibility_index: indices.accessibility_index,
      risk_index: indices.risk_index,
      dvf: { coverage: dvfCoverage, reason: dvfReason, source: dvfSource },
      prices: dvfStats ? {
        median_eur_m2: dvfStats.price_median_eur_m2,
        mean_eur_m2: dvfStats.price_mean_eur_m2,
        q1_eur_m2: dvfStats.price_q1_eur_m2,
        q3_eur_m2: dvfStats.price_q3_eur_m2,
      } : null,
      transactions: dvfStats ? { count: dvfStats.transactions_count, count_previous: dvfStats.transactions_count_previous } : null,
      transport: {
        ...transportResult,
        applicable: transportResult.applicable,
      },
      ecoles: ecolesResult.data,
      bpe: bpeResult.details,
      bpeCoverage: bpeResult.coverage,
      commoditesScore: bpeResult.scoreCommodites,
      commerces_proches: bpeResult.details?.commerces_proches ?? [],
      medecins_proches: bpeResult.details?.medecins_proches ?? [],
      services_ruraux: servicesRuraux, // ✅ v3.11
      residences_seniors: residencesSeniors, // ✅ v3.11
      healthSummary,
      insee: inseeResult.data,
      ehpad: { coverage: ehpad.coverage, source: ehpad.source, count: ehpad.count, radius_m: ehpad.radius_m, nearest: ehpad.nearest ?? null, reason: ehpad.reason ?? null },
      kpis,
      insights,
      comps,
    },
  };

  if (debug) {
    output.debug = {
      timestamp: new Date().toISOString(),
      dvfApi,
      transportResult,
      bpeResult,
      ecolesResult,
      inseeResult,
      ehpad,
      servicesRuraux,
      residencesSeniors,
      isInGrandeAgglomeration: !isRural,
      bpeRadius,
      ehpadRadius,
    };
  }

  console.log("✅ market_study response ready, score:", indices.global_score, "DVF source:", dvfSource, "Zone:", isRural ? "rurale" : "urbaine");

  return new Response(JSON.stringify(output), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ============================================================================
// MODE STANDARD - HANDLER
// ============================================================================
function computeStandardSmartScore(components: SmartScoreComponents, transportApplicable: boolean): number {
  const items: Array<{ w: number; v: number | null }> = [];

  if (transportApplicable && components.transport_score != null) {
    items.push({ w: 0.25, v: components.transport_score });
  }
  if (components.commodites_score != null) {
    items.push({ w: 0.25, v: components.commodites_score });
  }
  if (components.ecoles_score != null) {
    items.push({ w: 0.20, v: components.ecoles_score });
  }
  if (components.marche_score != null) {
    items.push({ w: 0.20, v: components.marche_score });
  }
  if (components.sante_score != null) {
    items.push({ w: 0.10, v: components.sante_score });
  }

  const result = weightedAverage(items);
  return result == null ? 50 : Math.round(result);
}

function generateStandardVerdict(score: number, coverage: CoverageMap, transportApplicable: boolean): string {
  const sourcesOk = Object.values(coverage).filter((c) => c === "ok").length;
  const totalSources = Object.keys(coverage).length;
  const coverageText = `(${sourcesOk}/${totalSources} sources)`;
  const transportNote = !transportApplicable ? " - zone hors métropole" : "";

  if (sourcesOk === 0) return "Analyse impossible : aucune source disponible.";
  if (score >= 80) return `Excellent emplacement ${coverageText}${transportNote}. Très bonne accessibilité.`;
  if (score >= 65) return `Bon emplacement ${coverageText}${transportNote}. Cadre de vie agréable.`;
  if (score >= 50) return `Emplacement correct ${coverageText}${transportNote}. Quelques points d'amélioration.`;
  if (score >= 35) return `Emplacement moyen ${coverageText}${transportNote}. Analyse approfondie recommandée.`;
  return `Emplacement à améliorer ${coverageText}${transportNote}. Vigilance requise.`;
}

async function handleStandard(payload: StandardPayload): Promise<Response> {
  const {
    address, cp, ville, surface, prix, travaux, userCriteria, meloId, type_local, dep_code, commune_code,
    parcel_id, commune_insee, transports, radius_km = 2, horizon_months = 24, debug = false,
  } = payload;

  console.log("📊 [Standard] payload:", { address, cp, ville, surface, type_local, parcel_id, commune_insee: commune_insee ?? commune_code, debug });

  if (!supabase) {
    return new Response(
      JSON.stringify({ success: false, error: "Supabase non initialisé", mode: "standard", version: "v3.11" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { point, error: pointError, debugResolve } = await resolveStandardPoint(payload);
  if (!point) {
    return new Response(
      JSON.stringify({
        success: false,
        error: pointError ?? "Impossible de résoudre le point d'analyse.",
        mode: "standard",
        version: "v3.11",
        debugResolve: debug ? debugResolve : undefined,
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  console.log("📍 [Standard] Point résolu:", point);

  const communeInseeFinal = point.commune_insee ?? commune_insee?.toString() ?? commune_code ?? null;

  // ✅ v3.11: Détection zone rurale
  const isRural = !isInGrandeAgglomeration(communeInseeFinal);
  console.log(`🏘️ [Standard] Zone: ${isRural ? "RURALE" : "URBAINE"}`);

  const transportResult = await fetchTransportScore(point.lat, point.lon, communeInseeFinal);
  
  // ✅ v3.11: Rayon adaptatif pour BPE
  const bpeRadius = isRural ? RAYON_RURAL_MIN_M : RAYON_URBAIN_M;
  const bpeResult = await fetchBpeStats(point.lat, point.lon, bpeRadius, communeInseeFinal, debug);
  
  const ecolesResult = await fetchEcolesStats(point.lat, point.lon);
  const inseeResult = await fetchInseeStats(communeInseeFinal);

  // ✅ v3.11: Services essentiels zone rurale
  let servicesRuraux: ServicesRuraux | null = null;
  let residencesSeniors: ResidenceSenior[] = [];
  
  if (isRural) {
    servicesRuraux = await fetchServicesEssentielsRural(point.lat, point.lon, debug);
    residencesSeniors = await fetchResidencesSeniors(point.lat, point.lon, 20, debug);
  }

  let healthResult: { data: HealthFicheEnriched | null; coverage: Coverage } = { data: null, coverage: "not_covered" };
  if (communeInseeFinal) {
    const rawHealth = await fetchHealthFicheForCommune(communeInseeFinal);
    const enrichedHealth = await enrichHealthData(
      point.lat,
      point.lon,
      rawHealth.data,
      bpeResult.details?.sante_details ?? null,
      bpeResult.details?.medecins_proches ?? undefined
    );
    healthResult = { data: enrichedHealth, coverage: rawHealth.coverage };
  }

  // DVF
  const dvfTypeLocal = normalizeStandardTypeLocal(type_local);
  let dvfCoverage: Coverage = "not_covered";
  let dvfReason: string | null = null;
  let dvfStats: DvfMarketStats | null = null;
  let comps: MarketComp[] = [];
  let dvfSource = "csv";

  const dvfApi = await dvfMarketKpis({
    lat: point.lat,
    lon: point.lon,
    radius_m: Math.round(radius_km * 1000),
    horizon_months,
    type_local: dvfTypeLocal,
    commune_insee: communeInseeFinal,
    ttl_seconds: 86400,
    debug,
  });

  dvfCoverage = dvfApi.coverage;
  dvfReason = dvfApi.reason ?? null;
  dvfSource = dvfApi.source;

  if (dvfApi.coverage === "ok" || dvfApi.coverage === "no_data") {
    dvfStats = {
      transactions_count: dvfApi.kpis.n,
      transactions_count_previous: 0,
      price_median_eur_m2: dvfApi.kpis.median_price_m2,
      price_mean_eur_m2: dvfApi.kpis.avg_price_m2,
      price_q1_eur_m2: dvfApi.kpis.q1_price_m2,
      price_q3_eur_m2: dvfApi.kpis.q3_price_m2,
      evolution_pct: null,
      volume_total_eur: null,
      surface_mean_m2: null,
    };
    comps = dvfApi.comps;
  }

  // Fallback RPC
  if ((dvfApi.coverage === "not_covered" || dvfApi.coverage === "error" || dvfApi.coverage === "no_data") && dvfApi.kpis.n === 0) {
    const r = await fetchDvfMarketStatsRpc(point, radius_km, horizon_months, dvfTypeLocal);
    if (r.stats && r.stats.transactions_count > 0) {
      dvfStats = r.stats;
      comps = r.comps;
      dvfCoverage = "ok";
      dvfReason = "RPC fallback OK";
      dvfSource = "rpc";
    } else if (r.error) {
      dvfCoverage = dvfApi.coverage === "no_data" ? "no_data" : "error";
      dvfReason = r.error;
    }
  }

  // ✅ v3.11: Rayon adaptatif pour EHPAD
  const ehpadRadius = isRural ? RAYON_RURAL_MAX_M : 5000;
  const ehpad = await finessEhpadNearby(supabase, {
    lat: point.lat,
    lon: point.lon,
    radius_m: ehpadRadius,
    ttl_seconds: 86400,
    debug,
  });

  // SmartScore
  let marcheScore: number | null = null;
  if (dvfCoverage === "ok" && dvfStats) {
    marcheScore = computeIndex(dvfStats.transactions_count, 0, 100, false);
  }

  let santeScore: number | null = null;
  if (healthResult.data?.desert_medical_score != null) {
    santeScore = Math.round(100 - (healthResult.data.desert_medical_score ?? 0));
  } else if (healthResult.data?.densite_medecins_10000 != null) {
    santeScore = computeIndex(healthResult.data.densite_medecins_10000, 0, 15, false);
  }

  const components: SmartScoreComponents = {
    transport_score: transportResult.applicable ? transportResult.score : null,
    ecoles_score: ecolesResult.data?.scoreEcoles ?? null,
    commodites_score: bpeResult.coverage === "ok" ? bpeResult.scoreCommodites : null,
    marche_score: marcheScore,
    sante_score: santeScore,
  };

  const smartScore = computeStandardSmartScore(components, transportResult.applicable);

  const coverage: CoverageMap = {
    dvf: dvfCoverage,
    transport: transportResult.coverage,
    ecoles: ecolesResult.coverage,
    bpe: bpeResult.coverage,
    sante: healthResult.coverage,
    insee: inseeResult.coverage,
    ehpad: ehpad.coverage,
  };

  const verdict = generateStandardVerdict(smartScore, coverage, transportResult.applicable);

  const output: any = {
    success: true,
    version: "v3.11",
    orchestrator: "smartscore-enriched-v3",
    mode: "standard",
    zone_type: isRural ? "rural" : "urbain", // ✅ v3.11
    input: {
      address: address ?? null,
      cp: cp ?? null,
      ville: ville ?? null,
      surface: surface ?? null,
      prix: prix ?? null,
      travaux: travaux ?? null,
      type_local: type_local ?? null,
      dep_code: dep_code ?? null,
      commune_code: commune_code ?? null,
      parcel_id: parcel_id ?? null,
      commune_insee: commune_insee?.toString() ?? commune_code ?? null,
      meloId: meloId ?? null,
      radius_km,
      horizon_months,
      transports_provided: transports != null,
      userCriteria: userCriteria ?? null,
    },
    resolved_point: point,
    smartscore: {
      score: smartScore,
      verdict,
      components: {
        transport: components.transport_score,
        ecoles: components.ecoles_score,
        commodites: components.commodites_score,
        marche: components.marche_score,
        sante: components.sante_score,
      },
      coverage,
      transport_applicable: transportResult.applicable,
    },
    market_like: {
      dvf: {
        coverage: dvfCoverage,
        reason: dvfReason,
        source: dvfSource,
        kpis: dvfStats ? {
          transactions_count: dvfStats.transactions_count,
          price_median_eur_m2: dvfStats.price_median_eur_m2,
          price_mean_eur_m2: dvfStats.price_mean_eur_m2,
          price_q1_eur_m2: dvfStats.price_q1_eur_m2,
          price_q3_eur_m2: dvfStats.price_q3_eur_m2,
        } : null,
        comps,
      },
      transport: {
        coverage: transportResult.coverage,
        score: transportResult.score,
        label: transportResult.label,
        summary: transportResult.summary,
        applicable: transportResult.applicable,
      },
      ecoles: { coverage: ecolesResult.coverage, data: ecolesResult.data },
      bpe: {
        coverage: bpeResult.coverage,
        scoreCommodites: bpeResult.scoreCommodites,
        totalEquipements: bpeResult.totalEquipements,
        details: bpeResult.details,
        commerces_proches: bpeResult.details?.commerces_proches ?? [],
        medecins_proches: bpeResult.details?.medecins_proches ?? [],
      },
      services_ruraux: servicesRuraux, // ✅ v3.11
      residences_seniors: residencesSeniors, // ✅ v3.11
      healthSummary: { coverage: healthResult.coverage, data: healthResult.data },
      insee: { coverage: inseeResult.coverage, data: inseeResult.data },
      ehpad: { coverage: ehpad.coverage, source: ehpad.source, count: ehpad.count, radius_m: ehpad.radius_m, nearest: ehpad.nearest ?? null, reason: ehpad.reason ?? null },
    },
  };

  if (debug) {
    output.debug = {
      timestamp: new Date().toISOString(),
      components,
      coverage,
      dvfApi,
      transportResult,
      ecolesResult,
      bpeResult,
      healthResult,
      inseeResult,
      ehpad,
      servicesRuraux,
      residencesSeniors,
      isInGrandeAgglomeration: !isRural,
      bpeRadius,
      ehpadRadius,
    };
  }

  console.log("✅ [Standard] response ready, smartscore:", smartScore, "DVF source:", dvfSource, "Zone:", isRural ? "rurale" : "urbaine");

  return new Response(JSON.stringify(output), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ============================================================================
// MAIN HANDLER
// ============================================================================
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const payload = await req.json().catch(() => null);
    console.log("📥 Reçu enriched-v3:", payload);

    if (!payload) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid JSON" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
    }

    if ((payload as any).mode === "market_study") {
      console.log("🏪 Mode market_study détecté → routage enrichi");
      return await handleMarketStudy(payload as MarketStudyPayload);
    }

    console.log("📦 Mode standard détecté → routage standard");
    return await handleStandard(payload as StandardPayload);
  } catch (err) {
    console.error("❌ Internal error enriched-v3:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});