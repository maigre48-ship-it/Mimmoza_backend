// ===== PART 1/5 =====
// supabase/functions/smartscore-enriched-v3/index.ts
// VERSION v3.22 - INSEE Comparateur API tabulaire (sans ZIP)
// CHANGELOG v3.22:
//    - REMOVE: fetchInseeComparateur() via ZIP/unzip (lourd, non fiable)
//    - NEW: fetchInseeComparateurApi() via API tabulaire data.gouv.fr avec filtre CODGEO
//    - NEW: Cache leger 30j pour INSEE Comparateur
//    - NEW: Debug insee_comparateur_debug (ok, source, cache_hit, fetch_ms, error, fields_present)
//    - FIX: market.insee enrichi avec revenu_median, taux_chomage, pct_proprietaires, taux_pauvrete

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as turf from "https://esm.sh/@turf/turf@6.5.0";

// Providers existants (FINESS + scoring)
import { finessEhpadNearby } from "../_shared/providers/finess.ts";
import { servicesProximiteV1 } from "../_shared/providers/services_proximite.ts";
import { weightedAverage } from "../_shared/providers/scoring.ts";
import type { Coverage } from "../_shared/providers/types.ts";

console.log("smartscore-enriched-v3 orchestrator loaded (v3.22 INSEE Comparateur API tabulaire)");

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

// v3.22: INSEE Comparateur via API tabulaire data.gouv.fr
// Resource ID du fichier "Base CC Comparateur" sur data.gouv.fr
const INSEE_COMPARATEUR_RESOURCE_ID = "a1f09595-0e79-4300-be1d-c05efde75c4c";
const INSEE_COMPARATEUR_API_BASE = "https://tabular-api.data.gouv.fr/api/resources";
const INSEE_COMPARATEUR_CACHE_TTL = 30 * 24 * 3600; // 30 jours

// v3.21: Overpass API pour OSM
const OVERPASS_API_URL = "https://overpass-api.de/api/interpreter";

// v3.11: Constantes pour les rayons de recherche
const RAYON_URBAIN_M = 500;
const RAYON_RURAL_MIN_M = 3000;
const RAYON_RURAL_MAX_M = 20000;

// v3.19: Codes BPE CORRIGES - Station-service = G101 (pas B313/B316)
const CODES_COMMERCES_ESSENTIELS = new Set([
  // Hyper/super (compat anciens + BPE 2023)
  "B101", "B102", "B104", "B105",
  // Superette / epicerie
  "B201", "B202", "B207", "B208", "B210",
  // v3.19: Station-service = G101 (domaine G = Services)
  "G101",
  // Pharmacie
  "D301",
  // v3.15: Commerces du quotidien
  "B203", // boulangerie
  "B204", // boucherie
  "B205", // surgeles
  "B206", // poissonnerie
]);

const CODES_SERVICES_ESSENTIELS = new Set([
  // Banque / DAB
  "A203", "A204",
  // Poste
  "A206", "A207", "A208",
  // Securite
  "A101", // police
  "A104", // gendarmerie
]);

// v3.15: Sante MAX COVERAGE
const CODES_SANTE_ESSENTIELS = new Set([
  // Generaliste
  "D201",
  // Specialistes (MAX)
  "D202", "D203", "D204", "D205", "D206", "D207", "D208", "D209", "D210", "D211",
  // Dentiste
  "D221",
  // Paramedical (MAX)
  "D231", // sage-femme
  "D232", // infirmier
  "D233", // kine
  "D235", // orthophoniste
  "D236", // orthoptiste
  "D237", // pedicure-podologue
  "D238", // audio prothesiste
  "D239", // ergotherapeute
  "D240", // psychomotricien
  "D241", // dieteticien
  // v3.19: Pharmacie explicite
  "D301",
]);

// ----------------------------------------------------
// GRANDES AGGLOMERATIONS AVEC RESEAU TC SIGNIFICATIF
// ----------------------------------------------------
const COMMUNES_GRANDES_AGGLOS = new Set<string>([
  // Ile-de-France (Paris et petite couronne)
  "75056", // Paris
  "92012", "92014", "92019", "92020", "92022", "92023", "92024", "92025", "92026",
  "92032", "92033", "92035", "92036", "92040", "92044", "92046", "92047", "92048",
  "92049", "92050", "92051", "92060", "92062", "92063", "92064", "92071", "92072",
  "92073", "92075", "92076", "92077", "92078",
  "93001", "93005", "93006", "93007", "93008", "93010", "93013", "93014", "93015",
  "93027", "93029", "93030", "93031", "93032", "93033", "93039", "93045", "93046",
  "93047", "93048", "93049", "93050", "93051", "93053", "93055", "93057", "93059",
  "93061", "93062", "93063", "93064", "93066", "93070", "93071", "93072", "93073",
  "93074", "93077", "93078", "93079",
  "94001", "94002", "94003", "94004", "94011", "94015", "94016", "94017", "94018",
  "94019", "94021", "94022", "94028", "94033", "94034", "94037", "94038", "94041",
  "94042", "94043", "94044", "94046", "94047", "94048", "94052", "94053", "94054",
  "94055", "94056", "94058", "94059", "94060", "94065", "94067", "94068", "94069",
  "94070", "94071", "94073", "94074", "94075", "94076", "94077", "94078", "94079",
  "94080", "94081",
]);

// Departements des grandes metropoles avec reseau TC dense
const DEPARTEMENTS_GRANDES_AGGLOS = new Set<string>([
  "75", "92", "93", "94", "69", "13", "33", "31", "44", "59", "67", "06", "34", "35",
]);

// Communes principales des autres metropoles (hors IDF)
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
  if (COMMUNES_GRANDES_AGGLOS.has(communeInsee)) return true;
  if (COMMUNES_METROPOLES.has(communeInsee)) return true;
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

// Types enrichis pour la sante
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

// Types pour les commerces et medecins proches
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

// Types pour les services essentiels ruraux
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
  commissariat_proche: ServiceEssentiel | null;
  gendarmerie_proche: ServiceEssentiel | null;
  medecin_proche: MedecinProche | null;
  rayon_recherche_m: number;
};

// Types canoniques pour EssentialServicesBlock
type EssentialServiceBucket =
  | "pharmacie"
  | "banque_dab"
  | "poste"
  | "station_service"
  | "commerce_alimentaire"
  | "medecin_generaliste"
  | "medecin_specialiste"
  | "dentiste"
  | "infirmier"
  | "kinesitherapeute"
  | "gendarmerie"
  | "commissariat";

type EssentialServiceItem = {
  name: string;
  type_label: string;
  type_code: string;
  distance_m: number;
  distance_km: number;
  commune?: string;
  adresse?: string;
};

type EssentialServiceSummary = {
  radius_km: number;
  count: number;
  nearest: EssentialServiceItem | null;
  top?: EssentialServiceItem[];
};

type EssentialServicesBlock = {
  zone_type: "rural" | "urbain";
  radius_km: number;

  pharmacie: EssentialServiceSummary;
  banque_dab: EssentialServiceSummary;
  poste: EssentialServiceSummary;
  station_service: EssentialServiceSummary;
  commerce_alimentaire: EssentialServiceSummary;

  medecin_generaliste: EssentialServiceSummary;
  medecin_specialiste: EssentialServiceSummary;
  dentiste: EssentialServiceSummary;
  infirmier: EssentialServiceSummary;
  kinesitherapeute: EssentialServiceSummary;

  gendarmerie: EssentialServiceSummary;
  commissariat: EssentialServiceSummary;
};

// v3.22: Type pour donnees INSEE Comparateur enrichies (API tabulaire)
type InseeComparateurData = {
  code_commune: string;
  commune: string | null;
  revenu_median: number | null;
  taux_pauvrete: number | null;
  pct_proprietaires: number | null;
  taux_chomage: number | null;
  nb_menages: number | null;
  nb_logements: number | null;
};

// v3.22: Type pour debug INSEE Comparateur
type InseeComparateurDebug = {
  ok: boolean;
  source: string;
  cache_hit: boolean;
  fetch_ms: number | null;
  error: string | null;
  fields_present: string[];
  api_url?: string;
  http_status?: number;
};

// v3.22: Type pour donnees INSEE hybrides (Supabase + Comparateur)
type InseeHybridData = {
  // Champs Supabase existants
  code_commune: string;
  commune?: string | null;
  population?: number | null;
  pct_moins_25?: number | null;
  pct_plus_65?: number | null;
  densite_pop?: number | null;
  // v3.22: Champs Comparateur
  revenu_median?: number | null;
  taux_pauvrete?: number | null;
  pct_proprietaires?: number | null;
  pension_retraite_moyenne?: number | null;
  taux_chomage?: number | null;
  nb_menages?: number | null;
  nb_logements?: number | null;
  // Source
  source_comparateur?: boolean;
  [key: string]: unknown;
};

// v3.19: Mapping type_code -> bucket CORRIGE (G101 pour station-service)
const ESSENTIAL_BUCKET_BY_TYPE_CODE: Record<string, EssentialServiceBucket> = {
  // SANTE
  D301: "pharmacie",
  D201: "medecin_generaliste",
  D202: "medecin_specialiste",
  D203: "medecin_specialiste",
  D204: "medecin_specialiste",
  D205: "medecin_specialiste",
  D206: "medecin_specialiste",
  D207: "medecin_specialiste",
  D208: "medecin_specialiste",
  D209: "medecin_specialiste",
  D210: "medecin_specialiste",
  D211: "medecin_specialiste",
  D221: "dentiste",
  D231: "infirmier",
  D232: "infirmier",
  D233: "kinesitherapeute",
  D235: "kinesitherapeute",
  D236: "kinesitherapeute",
  D237: "kinesitherapeute",
  D238: "kinesitherapeute",
  D239: "kinesitherapeute",
  D240: "kinesitherapeute",
  D241: "kinesitherapeute",
  // SERVICES
  A203: "banque_dab",
  A204: "banque_dab",
  A206: "poste",
  A207: "poste",
  A208: "poste",
  A101: "commissariat",
  A104: "gendarmerie",
  // v3.19: STATION SERVICE - Code correct = G101
  G101: "station_service",
  // COMMERCE ALIMENTAIRE
  B101: "commerce_alimentaire",
  B104: "commerce_alimentaire",
  B102: "commerce_alimentaire",
  B105: "commerce_alimentaire",
  B201: "commerce_alimentaire",
  B208: "commerce_alimentaire",
  B202: "commerce_alimentaire",
  B207: "commerce_alimentaire",
  B210: "commerce_alimentaire",
  B203: "commerce_alimentaire",
  B204: "commerce_alimentaire",
  B205: "commerce_alimentaire",
  B206: "commerce_alimentaire",
};

// Liste des buckets pour iteration
const ALL_ESSENTIAL_BUCKETS: EssentialServiceBucket[] = [
  "pharmacie",
  "banque_dab",
  "poste",
  "station_service",
  "commerce_alimentaire",
  "medecin_generaliste",
  "medecin_specialiste",
  "dentiste",
  "infirmier",
  "kinesitherapeute",
  "gendarmerie",
  "commissariat",
];

// ----------------------------------------------------
// HELPERS GENERAUX
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
  if (c === "no_data") return "Pas de donnees";
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

function metersToKm(m: number): number {
  return Math.round(m / 100) / 10;
}

// v3.20: Helper pour normaliser texte (minuscules, sans accents)
function normalizeTextForSearch(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
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
    console.warn("Cache read error:", e);
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
    console.warn("Cache write error:", e);
  }
}// ===== PART 2/5 =====
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
    "https://apicarto.ign.fr/api/cadastre/parcelle" +
    "?code_insee=" + encodeURIComponent(code_insee) +
    "&section=" + encodeURIComponent(section) +
    "&numero=" + encodeURIComponent(numero) +
    "&com_abs=" + encodeURIComponent(com_abs) +
    "&_limit=1";

  dbg.url = url;
  if (debug) console.log("api-carto cadastre url:", url);

  try {
    const resp = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
    dbg.status = resp.status;
    dbg.ok = resp.ok;

    const json = await resp.json().catch(() => null);
    if (!json || !resp.ok) {
      dbg.error = "api-carto error status=" + String(resp.status);
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
    dbg.error = "fetch exception: " + String(e);
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
    console.error("RPC get_parcelle_centroid error:", error);
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
// RESOLUTION POINT - Market Study
// v3.20: SELECT * pour INSEE au lieu de champs restrictifs
// ----------------------------------------------------
async function resolveAnalysisPoint(
  payload: MarketStudyPayload,
): Promise<{ point: ResolvedPoint | null; error: string | null; inseeMeta?: any; debugResolve?: any }> {
  const { parcel_id, commune_insee, lat, lon, debug } = payload;

  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    console.log("Point resolu depuis payload lat/lon");
    return {
      point: { lat, lon, source: "payload", parcel_id: parcel_id ?? undefined, commune_insee: commune_insee?.toString() },
      error: null,
    };
  }

  if (parcel_id) {
    console.log("Resolution point via parcel_id:", parcel_id);
    const res = await resolvePointFromParcelId(parcel_id, commune_insee ?? null, !!debug);
    if (res.point) {
      console.log("Point resolu depuis parcelle:", res.point.lat, res.point.lon);
      return { point: res.point, error: null };
    }
    if (debug) {
      return {
        point: null,
        error: "Parcelle non resolue",
        debugResolve: { parcel_id, commune_insee: commune_insee?.toString() ?? null, cadastre: res.cadastreDebug, rpc: res.rpcDebug },
      };
    }
  }

  if (supabase && commune_insee) {
    // v3.20: SELECT * au lieu de champs restrictifs
    const { data: inseeData } = await supabase
      .from("insee_communes_stats")
      .select("*")
      .eq("code_commune", commune_insee.toString())
      .limit(1)
      .maybeSingle();

    if (inseeData) {
      return { point: null, error: "Coordonnees absentes pour cette commune.", inseeMeta: inseeData };
    }
  }

  return { point: null, error: "Impossible de resoudre le point d'analyse. Fournir lat/lon, parcel_id ou commune_insee valide." };
}

// ----------------------------------------------------
// RESOLUTION POINT - Standard
// ----------------------------------------------------
async function resolveStandardPoint(
  payload: StandardPayload,
): Promise<{ point: ResolvedPoint | null; error: string | null; debugResolve?: any }> {
  const { parcel_id, commune_insee, commune_code, lat, lon, debug } = payload;

  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    console.log("[Standard] Point resolu depuis payload lat/lon");
    return {
      point: { lat, lon, source: "payload", parcel_id: parcel_id ?? undefined, commune_insee: commune_insee?.toString() ?? commune_code ?? undefined },
      error: null,
    };
  }

  const effectiveCommune = commune_insee?.toString() ?? commune_code ?? null;
  if (parcel_id) {
    console.log("[Standard] Resolution point via parcel_id:", parcel_id);
    const res = await resolvePointFromParcelId(parcel_id, effectiveCommune, !!debug);
    if (res.point) {
      console.log("[Standard] Point resolu depuis parcelle:", res.point.lat, res.point.lon);
      return { point: res.point, error: null };
    }
    if (debug) {
      return { point: null, error: "Parcelle non resolue", debugResolve: { parcel_id, commune_insee: effectiveCommune, cadastre: res.cadastreDebug, rpc: res.rpcDebug } };
    }
    return { point: null, error: "Impossible de resoudre le point d'analyse via parcel_id." };
  }

  return { point: null, error: "Impossible de resoudre le point d'analyse. Fournir lat/lon ou parcel_id valide." };
}

// ============================================================================
// CSV PARSER (pour DVF)
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
// DVF PROVIDER - CSV data.gouv.fr + fallback RPC
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
  const key = communeInsee ?? (String(Math.round(lat * 100)) + "_" + String(Math.round(lon * 100)));
  return "dvf:" + key + ":" + String(months) + ":" + (typeLocal || "all");
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

  const cached = await getFromCache(cacheKey);
  if (cached) {
    if (debug) console.log("DVF from cache");
    return { ...cached, source: "cache" };
  }

  let codeCommune = commune_insee;
  let nomCommune: string | null = null;
  
  if (!codeCommune) {
    try {
      const geoResp = await fetch(GEO_API_BASE + "/communes?lat=" + String(lat) + "&lon=" + String(lon) + "&fields=code,nom&limit=1");
      if (geoResp.ok) {
        const communes = await geoResp.json();
        if (communes.length > 0) {
          codeCommune = communes[0].code;
          nomCommune = communes[0].nom;
          if (debug) console.log("DVF: commune detectee:", codeCommune, nomCommune);
        }
      }
    } catch (e) {
      if (debug) console.warn("DVF: erreur detection commune:", e);
    }
  } else {
    try {
      const geoResp = await fetch(GEO_API_BASE + "/communes/" + codeCommune + "?fields=nom");
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
      reason: "Impossible de determiner le code commune",
      kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null },
      comps: [],
    };
  }

  const dep = codeCommune.slice(0, 2);
  
  const dateLimit = new Date();
  dateLimit.setMonth(dateLimit.getMonth() - horizon_months);
  const dateLimitStr = dateLimit.toISOString().split("T")[0];

  const currentYear = new Date().getFullYear();
  const yearsToFetch: number[] = [];
  for (let y = currentYear; y >= currentYear - 3 && y >= 2019; y--) {
    yearsToFetch.push(y);
  }

  let allRows: Array<Record<string, string>> = [];
  const csvSources: string[] = [];

  for (const year of yearsToFetch) {
    const csvUrl = DVF_CSV_BASE + "/" + String(year) + "/communes/" + dep + "/" + codeCommune + ".csv";
    if (debug) console.log("DVF CSV:", csvUrl);

    try {
      const resp = await fetch(csvUrl);
      if (resp.ok) {
        const csvText = await resp.text();
        const rows = parseCSV(csvText);
        allRows = allRows.concat(rows);
        csvSources.push(String(year));
        if (debug) console.log("DVF " + String(year) + ": " + String(rows.length) + " lignes");
      } else {
        if (debug) console.log("DVF " + String(year) + ": HTTP " + String(resp.status));
      }
    } catch (e) {
      if (debug) console.warn("DVF " + String(year) + " error:", e);
    }
  }

  if (allRows.length === 0) {
    if (debug) console.log("DVF CSV: aucune donnee");
    return {
      provider: "dvf",
      source: "csv",
      coverage: "no_data",
      reason: "Aucune donnee DVF trouvee pour " + codeCommune,
      kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null },
      comps: [],
    };
  }

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

  const comps: MarketComp[] = transactions.slice(0, 20).map((t, idx) => ({
    id: t.record.id || String(idx),
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
    source: "csv:" + csvSources.join(","),
    coverage: n > 0 ? "ok" : "no_data",
    kpis: { n, median_price_m2, avg_price_m2, q1_price_m2, q3_price_m2 },
    comps,
  };

  await saveToCache(cacheKey, "dvf", result, ttl_seconds);

  if (debug) console.log("DVF result:", result.kpis);

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
    return { stats: null, comps: [], error: "Supabase non initialise" };
  }

  const radiusM = Math.round(radiusKm * 1000);

  console.log("Fallback -> RPC get_dvf_market_stats_radius");

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
        id: safeToString(c.id) ?? String(idx),
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
    console.error("fetchDvfMarketStatsRpc error:", e);
    return { stats: null, comps: [], error: String(e) };
  }
}// ===== PART 3/5 =====
// ============================================================================
// BPE PROVIDER - API data.gouv.fr + fallback RPC
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
  rayon_m: number;
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
  D204: "medecin_specialiste",
  D205: "medecin_specialiste",
  D206: "medecin_specialiste",
  D207: "medecin_specialiste",
  D208: "medecin_specialiste",
  D209: "medecin_specialiste",
  D210: "medecin_specialiste",
  D211: "medecin_specialiste",
  D221: "dentiste",
  D231: "infirmier",
  D232: "infirmier",
  D233: "kinesitherapeute",
  D235: "kinesitherapeute",
  D236: "kinesitherapeute",
  D237: "kinesitherapeute",
  D238: "kinesitherapeute",
  D239: "kinesitherapeute",
  D240: "kinesitherapeute",
  D241: "kinesitherapeute",
  D301: "pharmacie",
};

const SANTE_LABELS: Record<string, string> = {
  medecin_generaliste: "Medecins generalistes",
  medecin_specialiste: "Medecins specialistes",
  dentiste: "Chirurgiens-dentistes",
  pharmacie: "Pharmacies",
  infirmier: "Infirmiers / Sages-femmes",
  kinesitherapeute: "Kinesitherapeutes / Paramedicaux",
  autre_sante: "Autres professionnels de sante",
};

// v3.19: Labels commerces avec G101 pour station-service
const COMMERCE_TYPE_LABELS: Record<string, string> = {
  B101: "Hypermarche",
  B102: "Supermarche",
  B103: "Grande surface de bricolage",
  B104: "Hypermarche",
  B105: "Supermarche",
  B201: "Superette",
  B202: "Epicerie",
  B203: "Boulangerie",
  B204: "Boucherie charcuterie",
  B205: "Produits surgeles",
  B206: "Poissonnerie",
  B207: "Epicerie",
  B208: "Superette",
  B210: "Commerce alimentaire",
  B301: "Librairie papeterie journaux",
  B302: "Magasin de vetements",
  B303: "Magasin d'equipements du foyer",
  B304: "Magasin de chaussures",
  B305: "Magasin d'electromenager et de materiel audio-video",
  B306: "Magasin de meubles",
  B307: "Magasin d'articles de sports et de loisirs",
  B308: "Droguerie quincaillerie bricolage",
  B309: "Parfumerie",
  B310: "Horlogerie Bijouterie",
  B311: "Fleuriste",
  B312: "Magasin d'optique",
  // v3.19: Station-service = G101 (domaine G)
  G101: "Station service",
};

const MEDECIN_SPECIALITE_LABELS: Record<string, string> = {
  D201: "Medecin generaliste",
  D202: "Specialiste en cardiologie",
  D203: "Specialiste en dermatologie",
  D204: "Specialiste en gastro-enterologie",
  D205: "Specialiste en psychiatrie",
  D206: "Specialiste en ophtalmologie",
  D207: "Specialiste en ORL",
  D208: "Specialiste en pediatrie",
  D209: "Specialiste en radiodiagnostic et imagerie medicale",
  D210: "Specialiste en gynecologie",
  D211: "Specialiste en gynecologie obstetrique",
  D221: "Chirurgien-dentiste",
  D231: "Sage-femme",
  D232: "Infirmier",
  D233: "Masseur kinesitherapeute",
  D235: "Orthophoniste",
  D236: "Orthoptiste",
  D237: "Pedicure-podologue",
  D238: "Audio prothesiste",
  D239: "Ergotherapeute",
  D240: "Psychomotricien",
  D241: "Dieteticien",
  D301: "Pharmacie",
  D302: "Laboratoire d'analyses medicales",
  D303: "Ambulance",
  D307: "Transfusion sanguine",
  D310: "Maison de sante pluridisciplinaire",
};

const SERVICE_TYPE_LABELS: Record<string, string> = {
  A101: "Commissariat de police",
  A104: "Gendarmerie",
  A203: "Banque",
  A204: "DAB (distributeur automatique)",
  A206: "Bureau de poste",
  A207: "Relais poste",
  A208: "Agence postale communale",
  // v3.19: Ajout G101 dans les services aussi
  G101: "Station service",
};

// v3.19: Types pour forcer le label officiel (evite "Magasin d'optique" pour station-service)
const FORCE_TYPE_LABEL_CODES = new Set(["G101"]);

function getBpeCacheKey(lat: number, lon: number, radiusM: number): string {
  const latRounded = Math.round(lat * 100) / 100;
  const lonRounded = Math.round(lon * 100) / 100;
  return "bpe:" + String(latRounded) + ":" + String(lonRounded) + ":" + String(radiusM);
}

async function getCommuneCenter(communeCode: string): Promise<{ lat: number; lon: number; nom: string } | null> {
  try {
    const resp = await fetch(GEO_API_BASE + "/communes/" + communeCode + "?fields=centre,nom");
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.centre?.coordinates) {
      return {
        lon: data.centre.coordinates[0],
        lat: data.centre.coordinates[1],
        nom: data.nom || communeCode,
      };
    }
  } catch (e) {
    // Ignorer
  }
  return null;
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
    if (debug) console.log("BPE from cache");
    return cached;
  }

  let effectiveCommune = communeInsee;
  let communeCenter: { lat: number; lon: number; nom: string } | null = null;
  
  if (!effectiveCommune) {
    try {
      const geoResp = await fetch(GEO_API_BASE + "/communes?lat=" + String(lat) + "&lon=" + String(lon) + "&fields=code,nom,centre&limit=1");
      if (geoResp.ok) {
        const communes = await geoResp.json();
        if (communes.length > 0) {
          effectiveCommune = communes[0].code;
          if (communes[0].centre?.coordinates) {
            communeCenter = {
              lon: communes[0].centre.coordinates[0],
              lat: communes[0].centre.coordinates[1],
              nom: communes[0].nom,
            };
          }
          if (debug) console.log("BPE: commune detectee:", effectiveCommune, communes[0].nom);
        }
      }
    } catch (e) {
      console.warn("BPE: erreur detection commune:", e);
    }
  } else {
    communeCenter = await getCommuneCenter(effectiveCommune);
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
    const apiUrl = DATA_GOUV_BPE_API + "/" + BPE_RESOURCE_ID + "/data/?DEPCOM__exact=" + effectiveCommune + "&page_size=2000";

    if (debug) console.log("BPE API URL:", apiUrl);

    const resp = await fetch(apiUrl, { headers: { Accept: "application/json" } });

    if (!resp.ok) {
      console.warn("BPE API error:", resp.status);
      if (supabase) {
        console.log("BPE: Fallback vers RPC get_bpe_proximite");
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

    if (debug) console.log("BPE: " + String(records.length) + " equipements trouves pour commune " + effectiveCommune);

    if (records.length === 0) {
      if (supabase) {
        console.log("BPE: Aucune donnee API, fallback vers RPC");
        return await fetchBpeStatsRpc(lat, lon, radiusM);
      }
    }

    const byDomaine: Record<string, number> = {};
    const santeByType: Record<string, { count: number; minDist: number | null }> = {};
    let totalInRadius = 0;

    const commercesProches: CommerceProche[] = [];
    const medecinsProches: MedecinProche[] = [];

    for (const r of records) {
      let eqLat = parseFloat(r.LATITUDE || r.latitude || "");
      let eqLon = parseFloat(r.LONGITUDE || r.longitude || "");

      if (isNaN(eqLat) || isNaN(eqLon)) {
        if (communeCenter) {
          eqLat = communeCenter.lat;
          eqLon = communeCenter.lon;
        } else {
          continue;
        }
      }

      const distance = haversineDistance(lat, lon, eqLat, eqLon);

      if (distance <= radiusM) {
        totalInRadius++;
        const typeCode = r.TYPEQU || r.typequ || "";
        const domaine = typeCode.charAt(0);
        const domaineLabel = DOMAINE_MAP[domaine] || "autre";

        byDomaine[domaineLabel] = (byDomaine[domaineLabel] || 0) + 1;

        if (debug && totalInRadius <= 3) {
          console.log("BPE sample TYPEQU:", typeCode, "NOM:", r.NOM || r.nom || "", "COMMUNE:", r.LIBCOM || r.libcom || "");
        }

        // v3.19: Inclure G101 (station-service) dans les commerces proches
        if ((domaine === "B" || typeCode === "G101") && commercesProches.length < 15) {
          const nomCommerce = r.NOM || r.nom || COMMERCE_TYPE_LABELS[typeCode] || "Commerce";
          commercesProches.push({
            nom: nomCommerce,
            type: COMMERCE_TYPE_LABELS[typeCode] || typeCode,
            type_code: typeCode,
            distance_m: Math.round(distance),
            distance_km: metersToKm(distance),
            adresse: r.ADRESSE || r.adresse || undefined,
            commune: r.LIBCOM || r.libcom || communeCenter?.nom || undefined,
          });
        }

        if (domaine === "D") {
          const santeType = SANTE_TYPE_MAP[typeCode] || "autre_sante";
          if (!santeByType[santeType]) {
            santeByType[santeType] = { count: 0, minDist: null };
          }
          santeByType[santeType].count++;
          if (santeByType[santeType].minDist === null || distance < santeByType[santeType].minDist!) {
            santeByType[santeType].minDist = Math.round(distance);
          }

          if ((typeCode.startsWith("D2") || typeCode.startsWith("D3")) && medecinsProches.length < 15) {
            const nomMedecin = r.NOM || r.nom || MEDECIN_SPECIALITE_LABELS[typeCode] || "Professionnel de sante";
            medecinsProches.push({
              nom: nomMedecin,
              specialite: MEDECIN_SPECIALITE_LABELS[typeCode] || typeCode,
              type_code: typeCode,
              distance_m: Math.round(distance),
              distance_km: metersToKm(distance),
              adresse: r.ADRESSE || r.adresse || undefined,
              commune: r.LIBCOM || r.libcom || communeCenter?.nom || undefined,
            });
          }
        }
      }
    }

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
      rayon_m: radiusM,
      sante_details,
      commerces_proches: commercesProches.slice(0, 10),
      medecins_proches: medecinsProches.slice(0, 10),
    };

    const result = {
      scoreCommodites: coverage === "ok" ? scoreCommodites : null,
      details,
      coverage,
      totalEquipements: totalInRadius,
    };

    await saveToCache(cacheKey, "bpe", result, 86400);

    if (debug) console.log("BPE result:", { totalInRadius, nb_commerces, nb_sante, nb_services, medecinsProches: medecinsProches.length });

    return result;
  } catch (e) {
    console.error("BPE API error:", e);
    if (supabase) {
      console.log("BPE: Fallback vers RPC apres exception");
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
      console.error("RPC get_bpe_proximite error:", error);
      return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 };
    }

    const score = numOrNull((data as any)?.scoreCommodites);
    const totalEquipements = numOrNull((data as any)?.total_equipements_proximite) ?? 0;

    if (totalEquipements === 0 && (score === 0 || score == null)) {
      return { scoreCommodites: null, details: data as BpeKpis, coverage: "no_data", totalEquipements: 0 };
    }

    return { scoreCommodites: score, details: data as BpeKpis, coverage: score != null ? "ok" : "no_data", totalEquipements };
  } catch (e) {
    console.error("fetchBpeStatsRpc error:", e);
    return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 };
  }
}

// ============================================================================
// v3.21: PHARMACIE FALLBACK OSM OVERPASS
// ============================================================================
async function fetchNearestPharmacyOverpass(
  lat: number,
  lon: number,
  maxRadiusM: number = 20000,
  debug = false,
): Promise<ServiceEssentiel | null> {
  // Rayons progressifs: 2km, 5km, 10km, 20km
  const radii = [2000, 5000, 10000, maxRadiusM].filter(r => r <= maxRadiusM);
  
  for (const radiusM of radii) {
    if (debug) console.log("OSM Overpass: recherche pharmacie rayon " + String(radiusM) + "m");
    
    const query = 
      "[out:json][timeout:10];\n" +
      "(\n" +
      "  node[\"amenity\"=\"pharmacy\"](around:" + String(radiusM) + "," + String(lat) + "," + String(lon) + ");\n" +
      "  way[\"amenity\"=\"pharmacy\"](around:" + String(radiusM) + "," + String(lat) + "," + String(lon) + ");\n" +
      ");\n" +
      "out center;";
    
    try {
      const resp = await fetch(OVERPASS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      });
      
      if (!resp.ok) {
        if (debug) console.warn("OSM Overpass HTTP " + String(resp.status));
        continue;
      }
      
      const json = await resp.json();
      const elements = json.elements || [];
      
      if (elements.length === 0) {
        if (debug) console.log("OSM Overpass: aucune pharmacie dans " + String(radiusM) + "m");
        continue;
      }
      
      // Calculer distances et trouver la plus proche
      let nearest: ServiceEssentiel | null = null;
      let minDistance = Infinity;
      
      for (const el of elements) {
        // Pour les "way", utiliser le centre
        const elLat = el.lat ?? el.center?.lat;
        const elLon = el.lon ?? el.center?.lon;
        
        if (elLat == null || elLon == null) continue;
        
        const distance = haversineDistance(lat, lon, elLat, elLon);
        
        if (distance < minDistance) {
          minDistance = distance;
          
          const tags = el.tags || {};
          const nom = tags.name || tags["name:fr"] || "Pharmacie";
          const adresse = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ") || undefined;
          const commune = tags["addr:city"] || tags["addr:municipality"] || undefined;
          
          nearest = {
            nom,
            type: "Pharmacie",
            type_code: "OSM_PHARMACY",
            distance_m: Math.round(distance),
            distance_km: metersToKm(distance),
            adresse,
            commune,
          };
        }
      }
      
      if (nearest) {
        if (debug) console.log("OSM Overpass: pharmacie trouvee \"" + nearest.nom + "\" a " + String(nearest.distance_km) + "km (rayon " + String(radiusM) + "m)");
        return nearest;
      }
    } catch (e) {
      if (debug) console.warn("OSM Overpass error (rayon " + String(radiusM) + "m):", e);
      // Continuer avec le rayon suivant
    }
  }
  
  if (debug) console.log("OSM Overpass: aucune pharmacie trouvee jusqu'a " + String(maxRadiusM) + "m");
  return null;
}

// ============================================================================
// v3.20: ESSENTIAL SERVICES BLOCK BUILDER - AVEC FIX distance=0 + pharmacie fallback + station strict
// ============================================================================

function normalizeEquipmentName(eq: any, typeCode: string): string {
  // v3.19: Pour station-service (G101), TOUJOURS utiliser le label officiel
  // Evite les erreurs de donnees comme "Magasin d'optique" pour une station
  if (FORCE_TYPE_LABEL_CODES.has(typeCode)) {
    if (COMMERCE_TYPE_LABELS[typeCode]) return COMMERCE_TYPE_LABELS[typeCode];
    if (SERVICE_TYPE_LABELS[typeCode]) return SERVICE_TYPE_LABELS[typeCode];
  }
  
  const nom = eq.nom || eq.NOM || eq.name || null;
  if (nom && nom.trim()) return nom.trim();
  
  const typeLibelle = eq.type_libelle || eq.TYPE_LIBELLE || null;
  if (typeLibelle && typeLibelle.trim()) return typeLibelle.trim();
  
  if (COMMERCE_TYPE_LABELS[typeCode]) return COMMERCE_TYPE_LABELS[typeCode];
  if (SERVICE_TYPE_LABELS[typeCode]) return SERVICE_TYPE_LABELS[typeCode];
  if (MEDECIN_SPECIALITE_LABELS[typeCode]) return MEDECIN_SPECIALITE_LABELS[typeCode];
  
  return typeCode;
}

function getTypeLabel(typeCode: string): string {
  if (COMMERCE_TYPE_LABELS[typeCode]) return COMMERCE_TYPE_LABELS[typeCode];
  if (SERVICE_TYPE_LABELS[typeCode]) return SERVICE_TYPE_LABELS[typeCode];
  if (MEDECIN_SPECIALITE_LABELS[typeCode]) return MEDECIN_SPECIALITE_LABELS[typeCode];
  return typeCode;
}

function createEmptySummary(radiusKm: number): EssentialServiceSummary {
  return {
    radius_km: radiusKm,
    count: 0,
    nearest: null,
    top: [],
  };
}

// v3.20: Helper pour extraire le texte descriptif d'un equipement
function getEquipmentTextForFallback(eq: any): string {
  const parts: string[] = [];
  if (eq.nom) parts.push(eq.nom);
  if (eq.NOM) parts.push(eq.NOM);
  if (eq.name) parts.push(eq.name);
  if (eq.type_libelle) parts.push(eq.type_libelle);
  if (eq.TYPE_LIBELLE) parts.push(eq.TYPE_LIBELLE);
  return normalizeTextForSearch(parts.join(" "));
}

// v3.20: Helper pour verifier si un texte contient des mots d'optique
function containsOptiqueKeywords(text: string): boolean {
  const normalized = normalizeTextForSearch(text);
  return normalized.includes("optique") || 
         normalized.includes("opticien") || 
         normalized.includes("lunette");
}

function buildEssentialServicesBlock(
  rawItems: Array<{
    type_code: string;
    distance_m: number;
    nom?: string;
    name?: string;
    NOM?: string;
    type_libelle?: string;
    TYPE_LIBELLE?: string;
    commune?: string;
    LIBCOM?: string;
    libcom?: string;
    adresse?: string;
    ADRESSE?: string;
  }>,
  radiusM: number,
  isRural: boolean,
  debug = false,
): EssentialServicesBlock {
  const radiusKm = metersToKm(radiusM);
  
  const buckets: Record<EssentialServiceBucket, EssentialServiceItem[]> = {
    pharmacie: [],
    banque_dab: [],
    poste: [],
    station_service: [],
    commerce_alimentaire: [],
    medecin_generaliste: [],
    medecin_specialiste: [],
    dentiste: [],
    infirmier: [],
    kinesitherapeute: [],
    gendarmerie: [],
    commissariat: [],
  };

  // v3.20: Debug - collecter items pour analyse si pharmacie vide
  const debugPharmacieItems: Array<{ type_code: string; text: string; distance_m: number }> = [];
  const typeCodeHistogram: Record<string, number> = {};

  for (const eq of rawItems) {
    const typeCode = String(eq.type_code ?? "").trim();
    if (!typeCode) continue;
    
    // v3.20: FIX - Accepter distance_m = 0, rejeter seulement < 0 ou NaN
    const distM = Number(eq.distance_m ?? 0);
    if (!Number.isFinite(distM) || distM < 0) continue;
    
    // v3.20: Debug histogram
    if (debug) {
      typeCodeHistogram[typeCode] = (typeCodeHistogram[typeCode] || 0) + 1;
    }
    
    // v3.20: Determiner le bucket - avec fallback texte pour pharmacie
    let bucket = ESSENTIAL_BUCKET_BY_TYPE_CODE[typeCode];
    
    // v3.20: FALLBACK PHARMACIE - Si type_code non reconnu, chercher "pharmacie" dans le texte
    if (!bucket) {
      const textContent = getEquipmentTextForFallback(eq);
      if (textContent.includes("pharmacie") || textContent.includes("pharma")) {
        bucket = "pharmacie";
        if (debug) {
          console.log("Pharmacie fallback texte: type_code=" + typeCode + ", text=\"" + textContent.slice(0, 50) + "\"");
        }
      }
      
      // v3.20: Debug - collecter pour analyse
      if (debug && (typeCode.startsWith("D3") || textContent.includes("pharm"))) {
        debugPharmacieItems.push({ type_code: typeCode, text: textContent.slice(0, 80), distance_m: distM });
      }
    }
    
    if (!bucket) continue;
    
    // v3.20: FILTRAGE STRICT STATION-SERVICE
    if (bucket === "station_service") {
      // Regle 1: Uniquement type_code G101
      if (typeCode !== "G101") {
        if (debug) {
          console.log("Station-service rejetee: type_code=" + typeCode + " (attendu G101)");
        }
        continue;
      }
      
      // Regle 2: Rejeter si nom/type_libelle contient optique/opticien/lunette
      const textContent = getEquipmentTextForFallback(eq);
      if (containsOptiqueKeywords(textContent)) {
        if (debug) {
          console.log("Station-service rejetee (optique): type_code=" + typeCode + ", text=\"" + textContent.slice(0, 50) + "\"");
        }
        continue;
      }
    }
    
    // v3.20: Determiner le type_label (forcer pour pharmacie fallback si generique)
    let typeLabel = getTypeLabel(typeCode);
    if (bucket === "pharmacie" && !ESSENTIAL_BUCKET_BY_TYPE_CODE[typeCode]) {
      // Fallback texte - forcer label "Pharmacie"
      typeLabel = "Pharmacie";
    }
    
    const item: EssentialServiceItem = {
      name: normalizeEquipmentName(eq, typeCode),
      type_label: typeLabel,
      type_code: typeCode,
      distance_m: Math.round(distM),
      distance_km: metersToKm(distM),
      commune: eq.commune || eq.LIBCOM || eq.libcom || undefined,
      adresse: eq.adresse || eq.ADRESSE || undefined,
    };
    
    buckets[bucket].push(item);
  }

  const buildSummary = (bucket: EssentialServiceBucket): EssentialServiceSummary => {
    const items = buckets[bucket];
    if (items.length === 0) {
      return createEmptySummary(radiusKm);
    }
    
    items.sort((a, b) => a.distance_m - b.distance_m);
    
    return {
      radius_km: radiusKm,
      count: items.length,
      nearest: items[0],
      top: items.slice(0, 5),
    };
  };

  const result: EssentialServicesBlock = {
    zone_type: isRural ? "rural" : "urbain",
    radius_km: radiusKm,
    
    pharmacie: buildSummary("pharmacie"),
    banque_dab: buildSummary("banque_dab"),
    poste: buildSummary("poste"),
    station_service: buildSummary("station_service"),
    commerce_alimentaire: buildSummary("commerce_alimentaire"),
    
    medecin_generaliste: buildSummary("medecin_generaliste"),
    medecin_specialiste: buildSummary("medecin_specialiste"),
    dentiste: buildSummary("dentiste"),
    infirmier: buildSummary("infirmier"),
    kinesitherapeute: buildSummary("kinesitherapeute"),
    
    gendarmerie: buildSummary("gendarmerie"),
    commissariat: buildSummary("commissariat"),
  };

  // v3.20: Debug conditionnel si pharmacie.count === 0
  if (debug && result.pharmacie.count === 0) {
    console.log("DEBUG PHARMACIE: count=0, analyse des rawItems:");
    console.log("  - Echantillon items D3* ou contenant 'pharm' (max 30):", debugPharmacieItems.slice(0, 30));
    
    // Histogramme top 20 type_codes
    const sortedCodes = Object.entries(typeCodeHistogram)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    console.log("  - Histogramme type_code (top 20):", sortedCodes);
  }

  return result;
}

// ============================================================================
// FETCH ESSENTIAL SERVICES VIA BPE-PROXY
// ============================================================================
type EssentialServicesRawItem = {
  type_code: string;
  distance_m: number;
  nom?: string;
  name?: string;
  type_libelle?: string;
  commune?: string;
  code_commune?: string;
  adresse?: string;
};

type EssentialServicesRawResult = {
  items: EssentialServicesRawItem[];
  type_codes_sent: string[];
};

async function fetchEssentialServicesRaw(
  lat: number,
  lon: number,
  radiusM: number,
  debug = false,
): Promise<EssentialServicesRawResult> {
  const functionsUrl = Deno.env.get("FUNCTIONS_URL") ?? (supabaseUrl ? (supabaseUrl + "/functions/v1") : "");
  if (!functionsUrl) {
    if (debug) console.warn("fetchEssentialServicesRaw: no FUNCTIONS_URL");
    return { items: [], type_codes_sent: [] };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceKey) {
    headers["Authorization"] = "Bearer " + serviceKey;
    headers["apikey"] = serviceKey;
  }

  const type_codes = Object.keys(ESSENTIAL_BUCKET_BY_TYPE_CODE);

  if (debug) console.log("Essential services: sending " + String(type_codes.length) + " type_codes to bpe-proxy, including G101 for station-service");

  try {
    const resp = await fetch(functionsUrl + "/bpe-proxy", {
      method: "POST",
      headers,
      body: JSON.stringify({
        lat,
        lon,
        radius_m: radiusM,
        type_codes,
        limit: 500,
      }),
    });

    const json = await resp.json().catch(() => null);
    if (!resp.ok || !json?.success) {
      if (debug) console.warn("bpe-proxy non-OK:", resp.status, json);
      return { items: [], type_codes_sent: type_codes };
    }

    const items: EssentialServicesRawItem[] = [];
    const rows = Array.isArray(json.items) ? json.items : [];

    if (debug) console.log("Essential services raw: " + String(rows.length) + " items from bpe-proxy");

    for (const eq of rows) {
      const typeCode = String(eq.type_code ?? "").trim();
      const distM = Number(eq.distance_m ?? 0);
      
      // v3.20: Accepter distance_m = 0
      if (!typeCode || !Number.isFinite(distM) || distM < 0) continue;
      
      items.push({
        type_code: typeCode,
        distance_m: distM,
        nom: eq.nom || eq.name || undefined,
        type_libelle: eq.type_libelle || undefined,
        commune: eq.commune || eq.code_commune || undefined,
        adresse: eq.adresse || undefined,
      });
    }

    return { items, type_codes_sent: type_codes };
  } catch (e) {
    if (debug) console.error("fetchEssentialServicesRaw error:", e);
    return { items: [], type_codes_sent: type_codes };
  }
}

// ============================================================================
// v3.19: FALLBACK DIRECT RPC pour services essentiels (pharmacie, etc.)
// ============================================================================
async function fetchEssentialServicesViaRpc(
  lat: number,
  lon: number,
  radiusM: number,
  debug = false,
): Promise<EssentialServicesRawItem[]> {
  if (!supabase) return [];

  try {
    // Appeler RPC get_bpe_essentiels_radius si disponible
    const { data, error } = await supabase.rpc("get_bpe_essentiels_radius", {
      p_lat: lat,
      p_lon: lon,
      p_radius_m: radiusM,
    });

    if (error) {
      if (debug) console.warn("RPC get_bpe_essentiels_radius error:", error);
      return [];
    }

    if (!Array.isArray(data)) return [];

    if (debug) console.log("RPC get_bpe_essentiels_radius: " + String(data.length) + " items");

    return data.map((item: any) => ({
      type_code: item.type_code || item.typequ || "",
      distance_m: item.distance_m || 0,
      nom: item.nom || item.name || undefined,
      type_libelle: item.type_libelle || undefined,
      commune: item.commune || item.libcom || undefined,
      adresse: item.adresse || undefined,
    }));
  } catch (e) {
    if (debug) console.error("fetchEssentialServicesViaRpc error:", e);
    return [];
  }
}

// ============================================================================
// RESIDENCES SENIORS (FINESS - hors EHPAD) - CORRECTED VERSION
// ============================================================================
async function fetchResidencesSeniors(
  lat: number,
  lon: number,
  radiusKm: number = 20,
  debug = false,
): Promise<ResidenceSenior[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from("finess_etablissements")
      .select("finess, raison_sociale, commune, categorie, latitude, longitude")
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .or("categorie.ilike.%Residence autonomie%,categorie.ilike.%Residence services%,categorie.ilike.%Logement foyer%,categorie.ilike.%Foyer logement%,categorie.ilike.%MARPA%")
      .limit(200);

    if (error || !data) {
      if (debug) console.warn("fetchResidencesSeniors error:", error);
      return [];
    }

    const residences: ResidenceSenior[] = [];

    for (const r of data) {
      const rLat = parseFloat((r as any).latitude);
      const rLon = parseFloat((r as any).longitude);
      if (Number.isNaN(rLat) || Number.isNaN(rLon)) continue;

      const dist = haversineDistance(lat, lon, rLat, rLon);
      if (dist <= radiusKm * 1000) {
        residences.push({
          nom: (r as any).raison_sociale || "Residence seniors",
          type: (r as any).categorie || "Residence seniors",
          commune: (r as any).commune || "",
          distance_km: metersToKm(dist),
          finess: (r as any).finess,
        });
      }
    }

    residences.sort((a, b) => a.distance_km - b.distance_km);

    if (debug) console.log("fetchResidencesSeniors found:", residences.length);

    return residences.slice(0, 10);
  } catch (e) {
    if (debug) console.warn("fetchResidencesSeniors exception:", e);
    return [];
  }
}// ===== PART 4/5 =====
// ============================================================================
// TRANSPORT PROVIDER - Conditionnel selon agglomeration
// ============================================================================
async function fetchTransportScore(
  lat: number,
  lon: number,
  communeInsee: string | null,
): Promise<{ score: number | null; label: string | null; summary: string | null; coverage: Coverage; applicable: boolean }> {
  
  const isInMetro = isInGrandeAgglomeration(communeInsee);
  
  if (!isInMetro) {
    console.log("[Transport] zone hors grande agglomeration, critere non applicable");
    return {
      score: null,
      label: "Non applicable",
      summary: "Hors grande agglomeration - critere non evalue",
      coverage: "ok",
      applicable: false,
    };
  }

  const functionsUrl = Deno.env.get("FUNCTIONS_URL") ?? (supabaseUrl ? supabaseUrl + "/functions/v1" : "");
  if (!functionsUrl) {
    console.warn("[fetchTransportScore] no FUNCTIONS_URL available");
    return { score: null, label: null, summary: null, coverage: "not_covered", applicable: true };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceKey) {
    headers["Authorization"] = "Bearer " + serviceKey;
    headers["apikey"] = serviceKey;
  }

  try {
    console.log("[fetchTransportScore] calling:", functionsUrl + "/transport-score");

    const resp = await fetch(functionsUrl + "/transport-score", {
      method: "POST",
      headers,
      body: JSON.stringify({ lat, lng: lon, radius_m: 800 }),
    });

    const json = await resp.json().catch(() => null);

    if (!resp.ok) {
      console.warn("[fetchTransportScore] non-OK response:", resp.status, json);
      return { score: null, label: null, summary: null, coverage: "error", applicable: true };
    }

    if (json?.success) {
      const scoring = json.scoring ?? {};
      const score = numOrNull(scoring.scoreTransport);
      console.log("[fetchTransportScore] success, score:", score);
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
    console.error("[fetchTransportScore] error:", e);
    return { score: null, label: null, summary: null, coverage: "error", applicable: true };
  }
}

// ============================================================================
// SANTE ENRICHIE - Professionnels + Hopital proche + Medecins proches
// ============================================================================
async function fetchHealthFicheForCommune(codeCommune: string): Promise<{ data: HealthFicheEnriched | null; coverage: Coverage }> {
  if (!supabase || !codeCommune) return { data: null, coverage: "not_covered" };
  try {
    const { data, error } = await supabase.rpc("get_fiche_sante_commune", { p_code_commune: codeCommune });
    if (error) {
      console.error("[RPC get_fiche_sante_commune] error:", error);
      return { data: null, coverage: "error" };
    }
    return { data: data as HealthFicheEnriched | null, coverage: data ? "ok" : "no_data" };
  } catch (e) {
    console.error("[fetchHealthFicheForCommune] error:", e);
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
    const { data, error } = await supabase.rpc("get_hopital_proche", {
      p_lat: lat,
      p_lon: lon,
      p_radius_km: maxRadiusKm,
    });

    if (!error && data && Array.isArray(data) && data.length > 0) {
      const h = data[0];
      return {
        nom: h.raison_sociale || h.nom || "Hopital",
        commune: h.commune || "",
        distance_km: Math.round((h.distance_m || 0) / 100) / 10,
        type: h.categorie || "Etablissement de sante",
      };
    }

    const { data: finessData, error: finessError } = await supabase
      .from("finess_etablissements")
      .select("finess, raison_sociale, commune, categorie, latitude, longitude")
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .in("categorie", [
        "Centre Hospitalier Regional",
        "Centre Hospitalier",
        "Centre Hospitalier Specialise",
        "Hopital local",
        "Clinique MCO",
        "Hopital des armees",
      ])
      .limit(100);

    if (finessError || !finessData) return null;

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
          nom: h.raison_sociale || "Hopital",
          commune: h.commune || "",
          distance_km: Math.round(dist / 100) / 10,
          type: h.categorie || "Etablissement de sante",
        };
      }
    }

    return closest;
  } catch (e) {
    console.warn("[fetchHopitalProche] error:", e);
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
  const baseData: HealthFicheEnriched = healthData || {
    code_commune: "",
    commune: "",
    population: null,
    densite_medecins_10000: null,
    densite_label: "Donnees insuffisantes",
    desert_medical_score: null,
    resume: "",
    kpi: {
      medecins_total: null,
      generalistes_total: null,
      generalistes_densite_10000: null,
      infirmiers_total: null,
      pharmacies_total: null,
      dentistes_total: null,
      autres_professionnels: null,
      etablissements_sante: null,
    },
  };

  const hopital = await fetchHopitalProche(lat, lon, 50);

  let professionnels_details: ProfessionnelsSanteDetails = {
    medecins_generalistes: baseData.kpi.generalistes_total ?? 0,
    medecins_specialistes: Math.max(0, (baseData.kpi.medecins_total ?? 0) - (baseData.kpi.generalistes_total ?? 0)),
    dentistes: baseData.kpi.dentistes_total ?? 0,
    infirmiers: baseData.kpi.infirmiers_total ?? 0,
    kinesitherapeutes: 0,
    pharmacies: baseData.kpi.pharmacies_total ?? 0,
    autres: baseData.kpi.autres_professionnels ?? 0,
  };

  if (bpeSanteDetails && bpeSanteDetails.length > 0) {
    for (const detail of bpeSanteDetails) {
      switch (detail.type) {
        case "medecin_generaliste":
          professionnels_details.medecins_generalistes = Math.max(professionnels_details.medecins_generalistes, detail.count);
          break;
        case "medecin_specialiste":
          professionnels_details.medecins_specialistes = Math.max(professionnels_details.medecins_specialistes, detail.count);
          break;
        case "dentiste":
          professionnels_details.dentistes = Math.max(professionnels_details.dentistes, detail.count);
          break;
        case "infirmier":
          professionnels_details.infirmiers = Math.max(professionnels_details.infirmiers, detail.count);
          break;
        case "kinesitherapeute":
          professionnels_details.kinesitherapeutes = Math.max(professionnels_details.kinesitherapeutes, detail.count);
          break;
        case "pharmacie":
          professionnels_details.pharmacies = Math.max(professionnels_details.pharmacies, detail.count);
          break;
        case "autre_sante":
          professionnels_details.autres = Math.max(professionnels_details.autres, detail.count);
          break;
      }
    }
  }

  if (medecinsProches && medecinsProches.length > 0) {
    const countByType: Record<string, number> = {};
    for (const m of medecinsProches) {
      const type = SANTE_TYPE_MAP[m.type_code] || "autre_sante";
      countByType[type] = (countByType[type] || 0) + 1;
    }
    
    if (countByType["medecin_generaliste"]) {
      professionnels_details.medecins_generalistes = Math.max(
        professionnels_details.medecins_generalistes,
        countByType["medecin_generaliste"]
      );
    }
    if (countByType["medecin_specialiste"]) {
      professionnels_details.medecins_specialistes = Math.max(
        professionnels_details.medecins_specialistes,
        countByType["medecin_specialiste"]
      );
    }
    if (countByType["dentiste"]) {
      professionnels_details.dentistes = Math.max(professionnels_details.dentistes, countByType["dentiste"]);
    }
    if (countByType["infirmier"]) {
      professionnels_details.infirmiers = Math.max(professionnels_details.infirmiers, countByType["infirmier"]);
    }
    if (countByType["pharmacie"]) {
      professionnels_details.pharmacies = Math.max(professionnels_details.pharmacies, countByType["pharmacie"]);
    }
    if (countByType["kinesitherapeute"]) {
      professionnels_details.kinesitherapeutes = Math.max(professionnels_details.kinesitherapeutes, countByType["kinesitherapeute"]);
    }
  }

  const resumeParts: string[] = [];
  const communeName = baseData.commune || "la commune";
  const pop = baseData.population;
  
  if (pop) {
    resumeParts.push("La commune de " + communeName + " compte " + pop.toLocaleString("fr-FR") + " habitants.");
  } else {
    resumeParts.push("La commune de " + communeName + ".");
  }

  const profList: string[] = [];
  if (professionnels_details.medecins_generalistes > 0) {
    profList.push(String(professionnels_details.medecins_generalistes) + " medecin" + (professionnels_details.medecins_generalistes > 1 ? "s" : "") + " generaliste" + (professionnels_details.medecins_generalistes > 1 ? "s" : ""));
  }
  if (professionnels_details.medecins_specialistes > 0) {
    profList.push(String(professionnels_details.medecins_specialistes) + " specialiste" + (professionnels_details.medecins_specialistes > 1 ? "s" : ""));
  }
  if (professionnels_details.dentistes > 0) {
    profList.push(String(professionnels_details.dentistes) + " dentiste" + (professionnels_details.dentistes > 1 ? "s" : ""));
  }
  if (professionnels_details.infirmiers > 0) {
    profList.push(String(professionnels_details.infirmiers) + " infirmier" + (professionnels_details.infirmiers > 1 ? "s" : ""));
  }
  if (professionnels_details.kinesitherapeutes > 0) {
    profList.push(String(professionnels_details.kinesitherapeutes) + " kinesitherapeute" + (professionnels_details.kinesitherapeutes > 1 ? "s" : ""));
  }
  if (professionnels_details.pharmacies > 0) {
    profList.push(String(professionnels_details.pharmacies) + " pharmacie" + (professionnels_details.pharmacies > 1 ? "s" : ""));
  }

  if (profList.length > 0) {
    resumeParts.push("Professionnels de sante : " + profList.join(", ") + ".");
  } else {
    resumeParts.push("Aucun professionnel de sante recense sur la commune.");
  }

  if (hopital) {
    resumeParts.push("Hopital le plus proche : " + hopital.nom + " a " + hopital.commune + " (" + String(hopital.distance_km) + " km).");
  }

  return {
    ...baseData,
    resume: resumeParts.join(" "),
    professionnels_details,
    hopital_proche: hopital,
    medecins_proches: medecinsProches,
  };
}

// ============================================================================
// v3.23: INSEE SOCIO-ECO - Lecture directe table Supabase insee_socioeco_communes
// ============================================================================
type InseeSocioEcoData = {
  code_commune: string;
  commune: string | null;
  revenu_median: number | null;
  taux_chomage: number | null;
  pension_retraite_moyenne: number | null;
  taux_pauvrete: number | null;
  pct_proprietaires: number | null;
  annee: number | null;
  source: string | null;
};

type InseeSocioEcoDebug = {
  ok: boolean;
  source: string;
  commune_insee: string;
  found: boolean;
  fields_present: string[];
  error: string | null;
};

async function fetchInseeSocioEco(
  communeCode: string,
  debug = false,
): Promise<{ data: InseeSocioEcoData | null; debugInfo: InseeSocioEcoDebug }> {
  const debugInfo: InseeSocioEcoDebug = {
    ok: false,
    source: "supabase",
    commune_insee: communeCode,
    found: false,
    fields_present: [],
    error: null,
  };

  if (!communeCode) {
    debugInfo.error = "code_commune vide";
    return { data: null, debugInfo };
  }

  if (!supabase) {
    debugInfo.error = "supabase non initialise";
    return { data: null, debugInfo };
  }

  try {
    if (debug) console.log("[INSEE SocioEco] fetching from Supabase for commune", communeCode);

    const { data, error } = await supabase
      .from("insee_socioeco_communes")
      .select("*")
      .eq("code_commune", communeCode)
      .limit(1)
      .maybeSingle();

    if (error) {
      debugInfo.error = "Supabase error: " + (error.message || String(error));
      if (debug) console.warn("[INSEE SocioEco] Supabase error:", error);
      return { data: null, debugInfo };
    }

    if (!data) {
      debugInfo.error = "commune non trouvee dans insee_socioeco_communes";
      if (debug) console.log("[INSEE SocioEco] commune not found:", communeCode);
      return { data: null, debugInfo };
    }

    debugInfo.found = true;

    const result: InseeSocioEcoData = {
      code_commune: communeCode,
      commune: data.commune || null,
      revenu_median: data.revenu_median_eur != null ? Number(data.revenu_median_eur) : null,
      taux_chomage: data.taux_chomage_pct != null ? parseFloat(String(data.taux_chomage_pct)) : null,
      taux_pauvrete: data.taux_pauvrete_pct != null ? parseFloat(String(data.taux_pauvrete_pct)) : null,
      pct_proprietaires: data.pct_proprietaires != null ? parseFloat(String(data.pct_proprietaires)) : null,
      pension_retraite_moyenne:
      data.pension_retraite_moyenne_eur_mois != null
    ? Number(data.pension_retraite_moyenne_eur_mois)
    : null,

      annee: data.annee != null ? Number(data.annee) : null,
      source: data.source || null,
    };

    // Construire la liste des champs presents
    const fieldsPresent: string[] = [];
    if (result.revenu_median != null) fieldsPresent.push("revenu_median");
    if (result.taux_chomage != null) fieldsPresent.push("taux_chomage");
    if (result.taux_pauvrete != null) fieldsPresent.push("taux_pauvrete");
    if (result.pct_proprietaires != null) fieldsPresent.push("pct_proprietaires");
    if (result.pension_retraite_moyenne != null) fieldsPresent.push("pension_retraite_moyenne");

    debugInfo.ok = true;
    debugInfo.fields_present = fieldsPresent;

    if (debug) {
      console.log("[INSEE SocioEco] result:", {
        revenu_median: result.revenu_median,
        taux_chomage: result.taux_chomage,
        taux_pauvrete: result.taux_pauvrete,
        pct_proprietaires: result.pct_proprietaires,
        pension_retraite_moyenne: result.pension_retraite_moyenne,
        fields: fieldsPresent,
      });
    }

    return { data: result, debugInfo };
  } catch (e) {
    debugInfo.error = "Exception: " + String(e);
    console.error("[fetchInseeSocioEco] error:", e);
    return { data: null, debugInfo };
  }
}

// ============================================================================
// v3.23: INSEE HYBRIDE - Fusionne Supabase demo + socio-eco
// ============================================================================
async function fetchInseeStatsHybrid(
  communeInsee: string | null,
  debug = false,
): Promise<{ data: InseeHybridData | null; coverage: Coverage; socioEcoDebug?: InseeSocioEcoDebug }> {
  if (!communeInsee) return { data: null, coverage: "not_covered" };

  let baseData: any = null;

  // 1. Recuperer les donnees demographiques Supabase existantes (insee_communes_stats)
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("insee_communes_stats")
        .select("*")
        .eq("code_commune", communeInsee)
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        baseData = data;
        if (debug) console.log("[INSEE Supabase] found demographic fields for", communeInsee);
      }
    } catch (e) {
      if (debug) console.warn("[INSEE Supabase] error:", e);
    }
  }

  // 2. Recuperer les donnees socio-eco depuis insee_socioeco_communes
  const socioEcoResult = await fetchInseeSocioEco(communeInsee, debug);
  const socioEcoData = socioEcoResult.data;

  // 3. Fusionner les sources
  if (!baseData && !socioEcoData) {
    return { data: null, coverage: "no_data", socioEcoDebug: socioEcoResult.debugInfo };
  }

  const hasSocioEcoData = socioEcoData != null && socioEcoResult.debugInfo.ok && socioEcoResult.debugInfo.fields_present.length > 0;

  const result: InseeHybridData = {
    code_commune: communeInsee,
    // Donnees demographiques Supabase
    commune: baseData?.commune ?? baseData?.nom_commune ?? socioEcoData?.commune ?? null,
    population: numOrNull(baseData?.population),
    pct_moins_25: numOrNull(baseData?.pct_moins_25),
    pct_plus_65: numOrNull(baseData?.pct_plus_65),
    densite_pop: numOrNull(baseData?.densite_pop),
    // Donnees socio-eco depuis insee_socioeco_communes
    revenu_median: socioEcoData?.revenu_median ?? null,
    taux_pauvrete: socioEcoData?.taux_pauvrete ?? null,
    pct_proprietaires: socioEcoData?.pct_proprietaires ?? null,
    taux_chomage: socioEcoData?.taux_chomage ?? null,
    pension_retraite_moyenne: socioEcoData?.pension_retraite_moyenne ?? null,
    // Champs legacy (nb_menages, nb_logements) - pas disponibles dans la nouvelle table
    nb_menages: null,
    nb_logements: null,
    // Indiquer la source socio-eco
    source_comparateur: hasSocioEcoData,
  };

  // Copier les autres champs de baseData
  if (baseData) {
    for (const [key, value] of Object.entries(baseData)) {
      if (!(key in result)) {
        result[key] = value;
      }
    }
  }

  if (debug) {
    console.log("[INSEE Hybrid] result:", {
      population: result.population,
      pct_plus_65: result.pct_plus_65,
      revenu_median: result.revenu_median,
      taux_chomage: result.taux_chomage,
      pct_proprietaires: result.pct_proprietaires,
      taux_pauvrete: result.taux_pauvrete,
      source_comparateur: result.source_comparateur,
    });
  }

  return { data: result, coverage: "ok", socioEcoDebug: socioEcoResult.debugInfo };
}

// ============================================================================
// ECOLES
// ============================================================================
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
      console.error("[RPC get_ecoles_proximite] error:", error);
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
    console.error("[fetchEcolesStats] error:", e);
    return { data: null, coverage: "error" };
  }
}

// ============================================================================
// CALCUL INDICES & VERDICT
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
  const accessibility_index = transportApplicable ? transportScore : null;

  let supply_index: number | null = null;
  if (dvfStats?.transactions_count != null) {
    supply_index = computeIndex(dvfStats.transactions_count, 0, 100, false);
  }

  let demand_index: number | null = null;
  if (dvfStats?.evolution_pct != null) {
    demand_index = computeIndex(dvfStats.evolution_pct, -10, 10, false);
  }

  let price_index: number | null = null;
  if (dvfStats?.price_median_eur_m2 && targets?.unit_price_m2) {
    const ratio = dvfStats.price_median_eur_m2 / targets.unit_price_m2;
    if (ratio >= 0.1 && ratio <= 10) {
      price_index = computeIndex(ratio, 0.5, 1.5, true);
    } else {
      price_index = 50;
    }
  } else if (dvfStats?.price_median_eur_m2) {
    price_index = 50;
  }

  let risk_index: number | null = null;
  if (bpeCoverage === "ok" && commoditesScore != null) {
    risk_index = Math.round(100 - commoditesScore);
  }

  const items: Array<{ w: number; v: number | null }> = [];

  if (dvfStats && dvfStats.transactions_count > 0) {
    items.push({ w: 0.35, v: supply_index });
    items.push({ w: 0.25, v: price_index });
  }

  if (transportApplicable && transportScore != null) {
    items.push({ w: 0.20, v: accessibility_index });
  }

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
    p === "hotel" ? "hotel" :
    p === "ehpad" ? "EHPAD" :
    p === "residence_senior" ? "residence senior" :
    p === "residence_etudiante" ? "residence etudiante" :
    projectNature;

  const transportNote = !transportApplicable ? " (zone hors metropole, transport non evalue)" : "";

  if (dvfCoverage === "not_covered") return "Prix/transactions indisponibles (DVF: " + coverageLabel(dvfCoverage) + ").";
  if (dvfCoverage === "error") return "Erreur lors de la recuperation DVF.";
  if (dvfStats == null || dvfStats.transactions_count === 0) {
    return "Donnees de marche insuffisantes pour evaluer ce projet de " + projectLabel + ". Elargir le perimetre recommande.";
  }
  if (score >= 70) return "Marche tres favorable pour un projet de " + projectLabel + transportNote + ". Demande soutenue et bonne liquidite.";
  if (score >= 55) return "Marche favorable pour un projet de " + projectLabel + transportNote + ". Conditions de marche correctes.";
  if (score >= 40) return "Marche modere pour un projet de " + projectLabel + transportNote + ". Analyse approfondie recommandee.";
  return "Marche tendu pour un projet de " + projectLabel + transportNote + ". Vigilance requise sur le positionnement prix.";
}

// v3.17: generateInsights utilise UNIQUEMENT services_ruraux pour les services de proximite
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
  _essentialServices: EssentialServicesBlock | null = null,
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
      title: String(dvfStats.transactions_count) + " transactions analysees",
      description: "Marche actif avec " + String(dvfStats.transactions_count) + " ventes dans un rayon de " + String(radiusKm) + " km.",
      source: "DVF",
    });
    if (dvfStats.price_median_eur_m2) {
      insights.push({
        type: "neutral",
        title: "Prix median : " + dvfStats.price_median_eur_m2.toLocaleString("fr-FR") + " EUR/m2",
        description: "Intervalle (Q1-Q3) : " + (dvfStats.price_q1_eur_m2?.toLocaleString("fr-FR") ?? "?") + " a " + (dvfStats.price_q3_eur_m2?.toLocaleString("fr-FR") ?? "?") + " EUR/m2.",
        source: "DVF",
      });
    }
  } else {
    insights.push({ type: "warning", title: "Donnees DVF insuffisantes", description: "Peu ou pas de transactions. Elargir le rayon.", source: "DVF" });
  }

  // Transport (conditionnel)
  if (transportApplicable) {
    if (transportScore != null) {
      const level = transportScore >= 70 ? "Excellente" : transportScore >= 50 ? "Bonne" : transportScore >= 30 ? "Moyenne" : "Faible";
      insights.push({
        type: transportScore >= 50 ? "positive" : transportScore >= 30 ? "neutral" : "negative",
        title: level + " desserte transports (" + String(transportScore) + "/100)",
        description: "Accessibilite transports en commun.",
        source: "Transport",
      });
    }
  } else {
    insights.push({
      type: "neutral",
      title: "Transports en commun",
      description: "Zone hors grande agglomeration - critere non evalue.",
      source: "Transport",
    });
  }

  // v3.17: Insights bases UNIQUEMENT sur services_ruraux (source de verite)
  if (servicesRuraux) {
    const radiusLabel = String(metersToKm(servicesRuraux.rayon_recherche_m)) + " km";

    // Pharmacie
    if (servicesRuraux.pharmacie_proche) {
      const ph = servicesRuraux.pharmacie_proche;
      insights.push({
        type: ph.distance_km <= 5 ? "positive" : ph.distance_km <= 10 ? "neutral" : "negative",
        title: "Pharmacie a " + String(ph.distance_km) + " km",
        description: ph.nom + (ph.commune ? " (" + ph.commune + ")" : "") + ".",
        source: "Services ruraux",
      });
    } else if (isRural) {
      insights.push({
        type: "warning",
        title: "Aucune pharmacie trouvee",
        description: "Pas de pharmacie dans un rayon de " + radiusLabel + ".",
        source: "Services ruraux",
      });
    }

    // Commerce alimentaire
    const commerce = servicesRuraux.supermarche_proche || servicesRuraux.hypermarche_proche || servicesRuraux.superette_proche;
    if (commerce) {
      insights.push({
        type: commerce.distance_km <= 10 ? "positive" : commerce.distance_km <= 15 ? "neutral" : "negative",
        title: commerce.type + " a " + String(commerce.distance_km) + " km",
        description: commerce.nom + (commerce.commune ? " (" + commerce.commune + ")" : "") + ".",
        source: "Services ruraux",
      });
    } else if (isRural) {
      insights.push({
        type: "warning",
        title: "Aucun commerce alimentaire trouve",
        description: "Pas de commerce alimentaire dans un rayon de " + radiusLabel + ".",
        source: "Services ruraux",
      });
    }

    // Medecin generaliste
    if (servicesRuraux.medecin_proche) {
      const m = servicesRuraux.medecin_proche;
      const distKm = m.distance_km ?? metersToKm(m.distance_m);
      insights.push({
        type: distKm <= 10 ? "positive" : distKm <= 15 ? "neutral" : "negative",
        title: "Medecin generaliste a " + String(distKm) + " km",
        description: m.nom + (m.commune ? " (" + m.commune + ")" : "") + ".",
        source: "Services ruraux",
      });
    } else if (isRural) {
      insights.push({
        type: "warning",
        title: "Aucun medecin generaliste trouve",
        description: "Pas de medecin generaliste dans un rayon de " + radiusLabel + ".",
        source: "Services ruraux",
      });
    }

    // Poste
    if (servicesRuraux.poste_proche) {
      const s = servicesRuraux.poste_proche;
      insights.push({
        type: s.distance_km <= 5 ? "positive" : "neutral",
        title: s.type + " a " + String(s.distance_km) + " km",
        description: s.nom + (s.commune ? " (" + s.commune + ")" : "") + ".",
        source: "Services ruraux",
      });
    }

    // Banque/DAB
    if (servicesRuraux.banque_proche) {
      const b = servicesRuraux.banque_proche;
      insights.push({
        type: b.distance_km <= 5 ? "positive" : "neutral",
        title: "Banque/DAB a " + String(b.distance_km) + " km",
        description: b.nom + (b.commune ? " (" + b.commune + ")" : "") + ".",
        source: "Services ruraux",
      });
    }

    // Station service (surtout pertinent en rural)
    if (isRural && servicesRuraux.station_service_proche) {
      const s = servicesRuraux.station_service_proche;
      insights.push({
        type: s.distance_km <= 10 ? "positive" : "neutral",
        title: "Station service a " + String(s.distance_km) + " km",
        description: s.nom + (s.commune ? " (" + s.commune + ")" : "") + ".",
        source: "Services ruraux",
      });
    }
  } else if (!isRural) {
    // Mode urbain sans services_ruraux - fallback sur BPE
    if (bpeDetails?.commerces_proches && bpeDetails.commerces_proches.length > 0) {
      const commercesTop3 = bpeDetails.commerces_proches.slice(0, 3);
      const commercesDesc = commercesTop3.map(c => c.type + " a " + String(c.distance_m) + "m").join(", ");
      insights.push({
        type: bpeDetails.nb_commerces >= 5 ? "positive" : bpeDetails.nb_commerces >= 2 ? "neutral" : "negative",
        title: String(bpeDetails.nb_commerces) + " commerces a proximite",
        description: "Les plus proches : " + commercesDesc + ".",
        source: "BPE",
      });
    } else if (bpeCoverage === "no_data") {
      insights.push({ type: "warning", title: "Donnees BPE indisponibles", description: "Aucun equipement trouve dans le perimetre.", source: "BPE" });
    } else if (commoditesScore != null) {
      const level = commoditesScore >= 70 ? "Excellente" : commoditesScore >= 50 ? "Bonne" : commoditesScore >= 30 ? "Moyenne" : "Faible";
      insights.push({
        type: commoditesScore >= 50 ? "positive" : commoditesScore >= 30 ? "neutral" : "negative",
        title: level + " proximite commerces/services",
        description: "Densite d'equipements a proximite (BPE).",
        source: "BPE",
      });
    }
  }

  // Ecoles
  if (ecolesScore != null) {
    const level = ecolesScore >= 70 ? "Tres bonne" : ecolesScore >= 50 ? "Bonne" : ecolesScore >= 30 ? "Moyenne" : "Faible";
    insights.push({
      type: ecolesScore >= 50 ? "positive" : ecolesScore >= 30 ? "neutral" : "negative",
      title: level + " accessibilite scolaire (" + String(ecolesScore) + "/100)",
      description: "Base sur la proximite et la densite d'etablissements a 1 km.",
      source: "Ecoles",
    });
  }

  // Medecins proches (mode urbain, depuis BPE)
  if (!isRural) {
    const medecinsProches = bpeDetails?.medecins_proches || healthSummary?.medecins_proches;
    if (medecinsProches && medecinsProches.length > 0) {
      const medecinsTop3 = medecinsProches.slice(0, 3);
      const medecinsDesc = medecinsTop3.map(m => m.specialite + " a " + String(m.distance_m) + "m").join(", ");
      insights.push({
        type: medecinsProches.length >= 5 ? "positive" : medecinsProches.length >= 2 ? "neutral" : "negative",
        title: String(medecinsProches.length) + " professionnels de sante a proximite",
        description: "Les plus proches : " + medecinsDesc + ".",
        source: "Sante",
      });
    }
  }

  return insights;
}

// ===== PART 5/5 =====
// ============================================================================
// v3.19: HELPER - Construire services_ruraux depuis EssentialServicesBlock
// (SOURCE FIABLE via bpe-proxy)
// ============================================================================
function buildServicesRurauxFromEssentialServices(es: EssentialServicesBlock): ServicesRuraux {
  const toServiceEssentiel = (item: EssentialServiceItem | null): ServiceEssentiel | null => {
    if (!item) return null;
    return {
      nom: item.name,
      type: item.type_label,
      type_code: item.type_code,
      distance_m: item.distance_m,
      distance_km: item.distance_km,
      adresse: item.adresse,
      commune: item.commune,
    };
  };

  const toMedecinProche = (item: EssentialServiceItem | null): MedecinProche | null => {
    if (!item) return null;
    return {
      nom: item.name,
      specialite: item.type_label,
      type_code: item.type_code,
      distance_m: item.distance_m,
      distance_km: item.distance_km,
      adresse: item.adresse,
      commune: item.commune,
    };
  };

  return {
    pharmacie_proche: toServiceEssentiel(es.pharmacie.nearest),
    supermarche_proche: toServiceEssentiel(es.commerce_alimentaire.nearest),
    hypermarche_proche: null,
    superette_proche: null,
    station_service_proche: toServiceEssentiel(es.station_service.nearest),
    poste_proche: toServiceEssentiel(es.poste.nearest),
    banque_proche: toServiceEssentiel(es.banque_dab.nearest),
    commissariat_proche: toServiceEssentiel(es.commissariat.nearest),
    gendarmerie_proche: toServiceEssentiel(es.gendarmerie.nearest),
    medecin_proche: toMedecinProche(es.medecin_generaliste.nearest),
    rayon_recherche_m: es.radius_km * 1000,
  };
}

// ============================================================================
// v3.16 COMPAT: HELPER - Construire services_ruraux depuis servicesProximiteV1
// ============================================================================
function buildServicesRurauxFromProvider(sp: any): ServicesRuraux {
  const nearest = sp.nearest_by_category || {};

  return {
    pharmacie_proche: nearest.pharmacie
      ? {
          nom: nearest.pharmacie.name ?? "Pharmacie",
          type: nearest.pharmacie.label ?? "Pharmacie",
          type_code: nearest.pharmacie.raw_type_code ?? "D301",
          distance_m: nearest.pharmacie.distance_m,
          distance_km: Math.round((nearest.pharmacie.distance_m / 1000) * 10) / 10,
          commune: nearest.pharmacie.commune ?? undefined,
        }
      : null,
    supermarche_proche: nearest.alimentation
      ? {
          nom: nearest.alimentation.name ?? "Commerce alimentaire",
          type: nearest.alimentation.label ?? "Commerce alimentaire",
          type_code: nearest.alimentation.raw_type_code ?? "",
          distance_m: nearest.alimentation.distance_m,
          distance_km: Math.round((nearest.alimentation.distance_m / 1000) * 10) / 10,
          commune: nearest.alimentation.commune ?? undefined,
        }
      : null,
    hypermarche_proche: nearest.hypermarche
      ? {
          nom: nearest.hypermarche.name ?? "Hypermarche",
          type: nearest.hypermarche.label ?? "Hypermarche",
          type_code: nearest.hypermarche.raw_type_code ?? "",
          distance_m: nearest.hypermarche.distance_m,
          distance_km: Math.round((nearest.hypermarche.distance_m / 1000) * 10) / 10,
          commune: nearest.hypermarche.commune ?? undefined,
        }
      : null,
    superette_proche: nearest.superette
      ? {
          nom: nearest.superette.name ?? "Superette",
          type: nearest.superette.label ?? "Superette",
          type_code: nearest.superette.raw_type_code ?? "",
          distance_m: nearest.superette.distance_m,
          distance_km: Math.round((nearest.superette.distance_m / 1000) * 10) / 10,
          commune: nearest.superette.commune ?? undefined,
        }
      : null,
    station_service_proche: nearest.station_service
      ? {
          nom: "Station service",
          type: "Station service",
          type_code: nearest.station_service.raw_type_code ?? "G101",
          distance_m: nearest.station_service.distance_m,
          distance_km: Math.round((nearest.station_service.distance_m / 1000) * 10) / 10,
          commune: nearest.station_service.commune ?? undefined,
        }
      : null,
    poste_proche: nearest.poste
      ? {
          nom: nearest.poste.name ?? "Bureau de poste",
          type: nearest.poste.label ?? "Bureau de poste",
          type_code: nearest.poste.raw_type_code ?? "",
          distance_m: nearest.poste.distance_m,
          distance_km: Math.round((nearest.poste.distance_m / 1000) * 10) / 10,
          commune: nearest.poste.commune ?? undefined,
        }
      : null,
    banque_proche: nearest.banque_dab
      ? {
          nom: nearest.banque_dab.name ?? "Banque/DAB",
          type: nearest.banque_dab.label ?? "Banque/DAB",
          type_code: nearest.banque_dab.raw_type_code ?? "",
          distance_m: nearest.banque_dab.distance_m,
          distance_km: Math.round((nearest.banque_dab.distance_m / 1000) * 10) / 10,
          commune: nearest.banque_dab.commune ?? undefined,
        }
      : null,
    commissariat_proche: nearest.commissariat
      ? {
          nom: nearest.commissariat.name ?? "Commissariat",
          type: nearest.commissariat.label ?? "Commissariat",
          type_code: nearest.commissariat.raw_type_code ?? "",
          distance_m: nearest.commissariat.distance_m,
          distance_km: Math.round((nearest.commissariat.distance_m / 1000) * 10) / 10,
          commune: nearest.commissariat.commune ?? undefined,
        }
      : null,
    gendarmerie_proche: nearest.gendarmerie
      ? {
          nom: nearest.gendarmerie.name ?? "Gendarmerie",
          type: nearest.gendarmerie.label ?? "Gendarmerie",
          type_code: nearest.gendarmerie.raw_type_code ?? "",
          distance_m: nearest.gendarmerie.distance_m,
          distance_km: Math.round((nearest.gendarmerie.distance_m / 1000) * 10) / 10,
          commune: nearest.gendarmerie.commune ?? undefined,
        }
      : null,
    medecin_proche: nearest.medecin_generaliste
      ? {
          nom: nearest.medecin_generaliste.name ?? "Medecin generaliste",
          specialite: "Medecin generaliste",
          type_code: nearest.medecin_generaliste.raw_type_code ?? "D201",
          distance_m: nearest.medecin_generaliste.distance_m,
          distance_km: Math.round((nearest.medecin_generaliste.distance_m / 1000) * 10) / 10,
          commune: nearest.medecin_generaliste.commune ?? undefined,
        }
      : null,
    rayon_recherche_m: sp.rayon_recherche_m ?? RAYON_RURAL_MAX_M,
  };
}

// ============================================================================
// MARKET STUDY - HANDLER
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

  console.log("[Market Study v3.23] payload:", { parcel_id, commune_insee, project_nature, radius_km, horizon_months, debug });

  const { point, error, inseeMeta, debugResolve } = await resolveAnalysisPoint(payload);

  if (!point) {
    return json({
      success: false,
      error: error ?? "Impossible de resoudre le point d'analyse.",
      mode: "market_study",
      version: "v3.23",
      inseeMeta: inseeMeta ?? null,
      debugResolve: debug ? debugResolve : undefined,
    }, 400);
  }

  console.log("[Market Study] Point resolu:", point);

  const communeInseeFinal = point.commune_insee ?? commune_insee?.toString() ?? null;
  const isRural = !isInGrandeAgglomeration(communeInseeFinal);
  const zoneType: "rural" | "urbain" = isRural ? "rural" : "urbain";

  console.log("[Market Study] Zone: " + zoneType.toUpperCase());

  // Appels paralleles
  const transportResult = await fetchTransportScore(point.lat, point.lon, communeInseeFinal);
  const bpeRadius = isRural ? RAYON_RURAL_MIN_M : RAYON_URBAIN_M;
  const bpeResult = await fetchBpeStats(point.lat, point.lon, bpeRadius, communeInseeFinal, debug);
  const ecolesResult = await fetchEcolesStats(point.lat, point.lon);

  // v3.23: Utiliser fetchInseeStatsHybrid avec lecture directe Supabase
  const inseeResult = await fetchInseeStatsHybrid(communeInseeFinal, debug);

  // Essential Services Block (via bpe-proxy - SOURCE FIABLE)
  const essentialServicesRadius = isRural ? RAYON_RURAL_MAX_M : RAYON_URBAIN_M;
  let essentialServicesRawResult = await fetchEssentialServicesRaw(point.lat, point.lon, essentialServicesRadius, debug);

  // v3.19: Fallback RPC si bpe-proxy ne retourne rien
  if (essentialServicesRawResult.items.length === 0 && supabase) {
    console.log("[Essential services] fallback vers RPC get_bpe_essentiels_radius");
    const rpcItems = await fetchEssentialServicesViaRpc(point.lat, point.lon, essentialServicesRadius, debug);
    if (rpcItems.length > 0) {
      essentialServicesRawResult = { items: rpcItems, type_codes_sent: essentialServicesRawResult.type_codes_sent };
    }
  }

  // v3.20: Passer debug pour logs conditionnels
  const essentialServices = buildEssentialServicesBlock(essentialServicesRawResult.items, essentialServicesRadius, isRural, debug);

  // v3.19: Services essentiels - PRIORITE a essential_services (bpe-proxy)
  let servicesRuraux: ServicesRuraux | null = null;
  let servicesProximiteDebug: any = null;
  let residencesSeniors: ResidenceSenior[] = [];

  // v3.19: D'abord construire depuis essential_services (source fiable via bpe-proxy)
  servicesRuraux = buildServicesRurauxFromEssentialServices(essentialServices);

  console.log("[services_ruraux] construit depuis essential_services:", {
    pharmacie: servicesRuraux.pharmacie_proche?.distance_km ?? null,
    commerce: servicesRuraux.supermarche_proche?.distance_km ?? null,
    medecin: servicesRuraux.medecin_proche?.distance_km ?? null,
    poste: servicesRuraux.poste_proche?.distance_km ?? null,
    banque: servicesRuraux.banque_proche?.distance_km ?? null,
    station: servicesRuraux.station_service_proche?.distance_km ?? null,
  });

  // v3.19: Enrichir avec servicesProximiteV1 si disponible (pour donnees complementaires)
  if (supabase) {
    try {
      console.log("[servicesProximiteV1] Appel (zone: " + zoneType + ") pour enrichissement");
      const sp = await (servicesProximiteV1 as any)({
        supabase,
        lat: point.lat,
        lon: point.lon,
        zone_type: zoneType,
      });

      if (debug) {
        servicesProximiteDebug = (sp as any)?.debug;
      }

      // v3.19: Enrichir services_ruraux avec les donnees de servicesProximiteV1
      const spServices = buildServicesRurauxFromProvider(sp);

      // Fusionner: prendre les donnees de servicesProximiteV1 si essential_services n'a pas trouve
      if (!servicesRuraux.pharmacie_proche && spServices.pharmacie_proche) {
        servicesRuraux.pharmacie_proche = spServices.pharmacie_proche;
      }
      if (!servicesRuraux.supermarche_proche && spServices.supermarche_proche) {
        servicesRuraux.supermarche_proche = spServices.supermarche_proche;
      }
      if (!servicesRuraux.hypermarche_proche && spServices.hypermarche_proche) {
        servicesRuraux.hypermarche_proche = spServices.hypermarche_proche;
      }
      if (!servicesRuraux.superette_proche && spServices.superette_proche) {
        servicesRuraux.superette_proche = spServices.superette_proche;
      }
      if (!servicesRuraux.station_service_proche && spServices.station_service_proche) {
        servicesRuraux.station_service_proche = spServices.station_service_proche;
      }
      if (!servicesRuraux.poste_proche && spServices.poste_proche) {
        servicesRuraux.poste_proche = spServices.poste_proche;
      }
      if (!servicesRuraux.banque_proche && spServices.banque_proche) {
        servicesRuraux.banque_proche = spServices.banque_proche;
      }
      if (!servicesRuraux.commissariat_proche && spServices.commissariat_proche) {
        servicesRuraux.commissariat_proche = spServices.commissariat_proche;
      }
      if (!servicesRuraux.gendarmerie_proche && spServices.gendarmerie_proche) {
        servicesRuraux.gendarmerie_proche = spServices.gendarmerie_proche;
      }
      if (!servicesRuraux.medecin_proche && spServices.medecin_proche) {
        servicesRuraux.medecin_proche = spServices.medecin_proche;
      }
    } catch (e) {
      console.warn("[servicesProximiteV1] error (non-blocking):", e);
    }
  }

  // v3.21: FALLBACK OSM OVERPASS pour pharmacie si toujours null
  if (!servicesRuraux.pharmacie_proche) {
    console.log("[Pharmacie] non trouvee via BPE/RPC, fallback OSM Overpass...");
    const osmPharmacy = await fetchNearestPharmacyOverpass(point.lat, point.lon, RAYON_RURAL_MAX_M, debug);
    if (osmPharmacy) {
      servicesRuraux.pharmacie_proche = osmPharmacy;
      if (debug) {
        console.log("[Pharmacie OSM] trouvee:", osmPharmacy.nom, "a", osmPharmacy.distance_km, "km");
      }
    } else {
      console.log("[Pharmacie] Aucune trouvee via OSM Overpass");
    }
  }

  if (isRural) {
    residencesSeniors = await fetchResidencesSeniors(point.lat, point.lon, 20, debug);
  }

  // Sante enrichie
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

  const healthSummary = healthResult.data;

  const ehpadRadius = isRural ? RAYON_RURAL_MAX_M : 5000;
  const ehpad = await finessEhpadNearby(supabase!, {
    lat: point.lat,
    lon: point.lon,
    radius_m: ehpadRadius,
    ttl_seconds: 86400,
    debug,
  });

  // DVF
  const dvfTypeLocal = mapProjectNatureToDvfType(project_nature);
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

  // Fallback RPC DVF
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

  // Indices
  const indices = computeMarketIndices(
    dvfStats,
    transportResult.score,
    transportResult.applicable,
    bpeResult.scoreCommodites,
    targets,
    bpeResult.coverage,
  );

  const verdict = generateVerdict(indices.global_score, dvfStats, dvfCoverage, project_nature, transportResult.applicable);

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
    isRural,
    essentialServices,
  );

  // v3.19: KPIs bases sur services_ruraux (SOURCE DE VERITE)
  const kpis: MarketKpi[] = [];

  kpis.push({ label: "Score global", value: indices.global_score, unit: "/100", description: verdict });

  if (dvfStats?.transactions_count != null && dvfStats.transactions_count > 0) {
    kpis.push({ label: "Transactions (DVF)", value: dvfStats.transactions_count, description: "Dans un rayon de " + String(radius_km) + " km" });
  }
  if (dvfStats?.price_median_eur_m2 != null) {
    kpis.push({ label: "Prix median", value: dvfStats.price_median_eur_m2, unit: "EUR/m2" });
  }
  if (transportResult.applicable && transportResult.score != null) {
    kpis.push({ label: "Transport", value: transportResult.score, unit: "/100", description: transportResult.label ?? undefined });
  }

  const ecolesDesc = ecolesResult.coverage === "ok"
    ? String(ecolesResult.data?.count1000m ?? 0) + " etablissements a 1km"
    : "Ecoles: " + coverageLabel(ecolesResult.coverage);
  kpis.push({ label: "Ecoles", value: ecolesResult.data?.scoreEcoles ?? null, unit: "/100", description: ecolesDesc });

  // KPIs services depuis services_ruraux
  const rayonKm = servicesRuraux ? metersToKm(servicesRuraux.rayon_recherche_m) : (isRural ? metersToKm(RAYON_RURAL_MAX_M) : metersToKm(RAYON_URBAIN_M));

  if (servicesRuraux?.pharmacie_proche) {
    kpis.push({
      label: "Pharmacie",
      value: servicesRuraux.pharmacie_proche.distance_km,
      unit: "km",
      description: servicesRuraux.pharmacie_proche.nom + (servicesRuraux.pharmacie_proche.commune ? " (" + servicesRuraux.pharmacie_proche.commune + ")" : "")
    });
  } else {
    kpis.push({
      label: "Pharmacie",
      value: null,
      unit: "km",
      description: "Aucune dans " + String(rayonKm) + " km"
    });
  }

  const commerceAlimentaire = servicesRuraux?.supermarche_proche || servicesRuraux?.hypermarche_proche || servicesRuraux?.superette_proche;
  if (commerceAlimentaire) {
    kpis.push({
      label: "Commerce alimentaire",
      value: commerceAlimentaire.distance_km,
      unit: "km",
      description: commerceAlimentaire.type + ": " + commerceAlimentaire.nom + (commerceAlimentaire.commune ? " (" + commerceAlimentaire.commune + ")" : "")
    });
  } else {
    kpis.push({
      label: "Commerce alimentaire",
      value: null,
      unit: "km",
      description: "Aucun dans " + String(rayonKm) + " km"
    });
  }

  if (servicesRuraux?.medecin_proche) {
    const m = servicesRuraux.medecin_proche;
    const distKm = m.distance_km ?? metersToKm(m.distance_m);
    kpis.push({
      label: "Medecin generaliste",
      value: distKm,
      unit: "km",
      description: m.nom + (m.commune ? " (" + m.commune + ")" : "")
    });
  } else {
    kpis.push({
      label: "Medecin generaliste",
      value: null,
      unit: "km",
      description: "Aucun dans " + String(rayonKm) + " km"
    });
  }

  if (servicesRuraux?.poste_proche) {
    kpis.push({
      label: "Poste",
      value: servicesRuraux.poste_proche.distance_km,
      unit: "km",
      description: servicesRuraux.poste_proche.type + ": " + servicesRuraux.poste_proche.nom + (servicesRuraux.poste_proche.commune ? " (" + servicesRuraux.poste_proche.commune + ")" : "")
    });
  } else {
    kpis.push({
      label: "Poste",
      value: null,
      unit: "km",
      description: "Aucun dans " + String(rayonKm) + " km"
    });
  }

  if (servicesRuraux?.banque_proche) {
    kpis.push({
      label: "Banque/DAB",
      value: servicesRuraux.banque_proche.distance_km,
      unit: "km",
      description: servicesRuraux.banque_proche.type + ": " + servicesRuraux.banque_proche.nom + (servicesRuraux.banque_proche.commune ? " (" + servicesRuraux.banque_proche.commune + ")" : "")
    });
  } else {
    kpis.push({
      label: "Banque/DAB",
      value: null,
      unit: "km",
      description: "Aucun dans " + String(rayonKm) + " km"
    });
  }

  if (servicesRuraux?.station_service_proche) {
    kpis.push({
      label: "Station service",
      value: servicesRuraux.station_service_proche.distance_km,
      unit: "km",
      description: servicesRuraux.station_service_proche.nom + (servicesRuraux.station_service_proche.commune ? " (" + servicesRuraux.station_service_proche.commune + ")" : "")
    });
  } else if (isRural) {
    kpis.push({
      label: "Station service",
      value: null,
      unit: "km",
      description: "Aucune dans " + String(rayonKm) + " km"
    });
  }

  if (!isRural) {
    const bpeDesc = bpeResult.coverage === "ok" ? "Score commerces/services/sante" : "BPE: " + coverageLabel(bpeResult.coverage);
    kpis.push({ label: "Commodites (BPE)", value: bpeResult.coverage === "ok" ? bpeResult.scoreCommodites : null, unit: "/100", description: bpeDesc });
  }

  kpis.push({ label: "Population", value: inseeResult.data?.population ?? null, description: "Population communale (INSEE)" });

  // v3.23: Nouveaux KPIs INSEE socio-eco depuis Supabase
  if (inseeResult.data?.revenu_median) {
    kpis.push({
      label: "Revenu median",
      value: inseeResult.data.revenu_median,
      unit: "EUR/an",
      description: "Revenu median des menages (INSEE)"
    });
  }
  if (inseeResult.data?.pct_plus_65 != null) {
  kpis.push({
    label: "65 ans et plus",
    value: Math.round(inseeResult.data.pct_plus_65 * 10) / 10,
    unit: "%",
    description: "Part de la population âgée de 65 ans et plus (INSEE)",
    });
  }
  if (inseeResult.data?.taux_chomage != null) {
    kpis.push({
      label: "Taux de chomage",
      value: inseeResult.data.taux_chomage,
      unit: "%",
      description: "Part des actifs au chomage (INSEE)"
    });
  }
  if (inseeResult.data?.pct_proprietaires != null) {
    kpis.push({
      label: "Proprietaires",
      value: inseeResult.data.pct_proprietaires,
      unit: "%",
      description: "Part des residences principales en propriete"
    });
  }
  if (inseeResult.data?.taux_pauvrete != null) {
    kpis.push({
      label: "Taux de pauvrete",
      value: inseeResult.data.taux_pauvrete,
      unit: "%",
      description: "Part de la population sous le seuil de pauvrete"
    });
  }
  if (inseeResult.data?.pension_retraite_moyenne != null) {
  kpis.push({
    label: "Retraite moyenne",
    value: inseeResult.data.pension_retraite_moyenne,
    unit: "EUR/mois",
    description: "Pension moyenne des retraités (INSEE)",
    });
  }

  if (healthSummary?.professionnels_details) {
    const prof = healthSummary.professionnels_details;
    const totalProf = prof.medecins_generalistes + prof.medecins_specialistes + prof.dentistes + prof.infirmiers + prof.pharmacies + prof.kinesitherapeutes;
    const profDescParts = [
      prof.medecins_generalistes > 0 ? String(prof.medecins_generalistes) + " generaliste(s)" : null,
      prof.medecins_specialistes > 0 ? String(prof.medecins_specialistes) + " specialiste(s)" : null,
      prof.infirmiers > 0 ? String(prof.infirmiers) + " infirmier(s)" : null,
      prof.dentistes > 0 ? String(prof.dentistes) + " dentiste(s)" : null,
      prof.pharmacies > 0 ? String(prof.pharmacies) + " pharmacie(s)" : null,
      prof.kinesitherapeutes > 0 ? String(prof.kinesitherapeutes) + " kine(s)" : null,
    ].filter(Boolean).join(", ");

    kpis.push({
      label: "Professionnels de sante (commune)",
      value: totalProf > 0 ? totalProf : 0,
      description: profDescParts || "Aucun sur la commune"
    });
  }

  if (healthSummary?.hopital_proche) {
    kpis.push({
      label: "Hopital le plus proche",
      value: healthSummary.hopital_proche.distance_km,
      unit: "km",
      description: healthSummary.hopital_proche.nom + " (" + healthSummary.hopital_proche.commune + ")"
    });
  }

  const totalEtablissementsSeniors = (ehpad.coverage === "ok" ? ehpad.count : 0) + residencesSeniors.length;
  const etablissementsSeniorsDesc = isRural
    ? String(ehpad.count || 0) + " EHPAD + " + String(residencesSeniors.length) + " residences (rayon " + String(ehpadRadius / 1000) + "km)"
    : "FINESS: " + coverageLabel(ehpad.coverage);

  kpis.push({
    label: "Etablissements seniors",
    value: totalEtablissementsSeniors > 0 ? totalEtablissementsSeniors : null,
    description: etablissementsSeniorsDesc
  });

  const output: any = {
    success: true,
    version: "v3.23",
    orchestrator: "smartscore-enriched-v3",
    mode: "market_study",
    zone_type: zoneType,
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
      transport: { ...transportResult, applicable: transportResult.applicable },
      ecoles: ecolesResult.data,
      bpe: bpeResult.details,
      bpeCoverage: bpeResult.coverage,
      commoditesScore: bpeResult.scoreCommodites,
      commerces_proches: bpeResult.details?.commerces_proches ?? [],
      medecins_proches: bpeResult.details?.medecins_proches ?? [],
      essential_services: essentialServices,
      services_ruraux: servicesRuraux,
      residences_seniors: residencesSeniors,
      healthSummary,
      insee: inseeResult.data,
      ehpad: { coverage: ehpad.coverage, source: ehpad.source, count: ehpad.count, radius_m: ehpad.radius_m, nearest: ehpad.nearest ?? null, reason: ehpad.reason ?? null },
      kpis,
      insights,
      comps,
    },
  };

  if (debug) {
    const essentialServicesCounts: Record<string, number> = {};
    for (const bucket of ALL_ESSENTIAL_BUCKETS) {
      essentialServicesCounts[bucket] = essentialServices[bucket].count;
    }

    const rawItemsSample = essentialServicesRawResult.items.slice(0, 10).map(item => ({
      type_code: item.type_code,
      distance_m: item.distance_m,
      commune: item.commune,
    }));

    output.debug = {
      timestamp: new Date().toISOString(),
      dvfApi,
      transportResult,
      bpeResult,
      ecolesResult,
      inseeResult: { coverage: inseeResult.coverage, data: inseeResult.data },
      insee_socioeco_debug: inseeResult.socioEcoDebug,
      ehpad,
      servicesRuraux,
      servicesProximite: servicesProximiteDebug,
      residencesSeniors,
      isInGrandeAgglomeration: !isRural,
      bpeRadius,
      ehpadRadius,
      essential_services_debug: {
        radius_m: essentialServicesRadius,
        radius_km: metersToKm(essentialServicesRadius),
        type_codes_sent_count: essentialServicesRawResult.type_codes_sent.length,
        type_codes_sent_sample: essentialServicesRawResult.type_codes_sent.slice(0, 25),
        raw_items_count: essentialServicesRawResult.items.length,
        raw_items_sample: rawItemsSample,
        counts_by_bucket: essentialServicesCounts,
      },
    };
  }

  console.log("[market_study] response ready, score:", indices.global_score, "DVF source:", dvfSource, "Zone:", zoneType);
  return json(output, 200);
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
  const coverageText = "(" + String(sourcesOk) + "/" + String(totalSources) + " sources)";
  const transportNote = !transportApplicable ? " - zone hors metropole" : "";

  if (sourcesOk === 0) return "Analyse impossible : aucune source disponible.";
  if (score >= 80) return "Excellent emplacement " + coverageText + transportNote + ". Tres bonne accessibilite.";
  if (score >= 65) return "Bon emplacement " + coverageText + transportNote + ". Cadre de vie agreable.";
  if (score >= 50) return "Emplacement correct " + coverageText + transportNote + ". Quelques points d'amelioration.";
  if (score >= 35) return "Emplacement moyen " + coverageText + transportNote + ". Analyse approfondie recommandee.";
  return "Emplacement a ameliorer " + coverageText + transportNote + ". Vigilance requise.";
}

async function handleStandard(payload: StandardPayload): Promise<Response> {
  const {
    address, cp, ville, surface, prix, travaux, userCriteria, meloId, type_local, dep_code, commune_code,
    parcel_id, commune_insee, transports, radius_km = 2, horizon_months = 24, debug = false,
  } = payload;

  console.log("[Standard v3.23] payload:", { address, cp, ville, surface, type_local, parcel_id, commune_insee: commune_insee ?? commune_code, debug });

  if (!supabase) {
    return json({ success: false, error: "Supabase non initialise", mode: "standard", version: "v3.23" }, 500);
  }

  const { point, error: pointError, debugResolve } = await resolveStandardPoint(payload);

  if (!point) {
    return json({
      success: false,
      error: pointError ?? "Impossible de resoudre le point d'analyse.",
      mode: "standard",
      version: "v3.23",
      debugResolve: debug ? debugResolve : undefined,
    }, 400);
  }

  console.log("[Standard] Point resolu:", point);

  const communeInseeFinal = point.commune_insee ?? commune_insee?.toString() ?? commune_code ?? null;
  const isRural = !isInGrandeAgglomeration(communeInseeFinal);
  const zoneType: "rural" | "urbain" = isRural ? "rural" : "urbain";

  console.log("[Standard] Zone: " + zoneType.toUpperCase());

  const transportResult = await fetchTransportScore(point.lat, point.lon, communeInseeFinal);
  const bpeRadius = isRural ? RAYON_RURAL_MIN_M : RAYON_URBAIN_M;
  const bpeResult = await fetchBpeStats(point.lat, point.lon, bpeRadius, communeInseeFinal, debug);
  const ecolesResult = await fetchEcolesStats(point.lat, point.lon);

  // v3.23: Utiliser fetchInseeStatsHybrid avec lecture directe Supabase
  const inseeResult = await fetchInseeStatsHybrid(communeInseeFinal, debug);

  // Essential Services Block (via bpe-proxy - SOURCE FIABLE)
  const essentialServicesRadius = isRural ? RAYON_RURAL_MAX_M : RAYON_URBAIN_M;
  let essentialServicesRawResult = await fetchEssentialServicesRaw(point.lat, point.lon, essentialServicesRadius, debug);

  // v3.19: Fallback RPC si bpe-proxy ne retourne rien
  if (essentialServicesRawResult.items.length === 0 && supabase) {
    console.log("[Standard] Essential services: fallback vers RPC");
    const rpcItems = await fetchEssentialServicesViaRpc(point.lat, point.lon, essentialServicesRadius, debug);
    if (rpcItems.length > 0) {
      essentialServicesRawResult = { items: rpcItems, type_codes_sent: essentialServicesRawResult.type_codes_sent };
    }
  }

  // v3.20: Passer debug pour logs conditionnels
  const essentialServices = buildEssentialServicesBlock(essentialServicesRawResult.items, essentialServicesRadius, isRural, debug);

  // v3.19: Services essentiels - PRIORITE a essential_services (bpe-proxy)
  let servicesRuraux: ServicesRuraux | null = null;
  let servicesProximiteDebug: any = null;
  let residencesSeniors: ResidenceSenior[] = [];

  // v3.19: D'abord construire depuis essential_services (source fiable via bpe-proxy)
  servicesRuraux = buildServicesRurauxFromEssentialServices(essentialServices);

  console.log("[Standard] services_ruraux construit depuis essential_services");

  // v3.19: Enrichir avec servicesProximiteV1 si disponible
  try {
    console.log("[Standard] Appel servicesProximiteV1 (zone: " + zoneType + ") pour enrichissement");
    const sp = await (servicesProximiteV1 as any)({
      supabase: supabase!,
      lat: point.lat,
      lon: point.lon,
      zone_type: zoneType,
    });

    if (debug) {
      servicesProximiteDebug = (sp as any)?.debug;
    }

    const spServices = buildServicesRurauxFromProvider(sp);

    // Fusionner
    if (!servicesRuraux.pharmacie_proche && spServices.pharmacie_proche) {
      servicesRuraux.pharmacie_proche = spServices.pharmacie_proche;
    }
    if (!servicesRuraux.supermarche_proche && spServices.supermarche_proche) {
      servicesRuraux.supermarche_proche = spServices.supermarche_proche;
    }
    if (!servicesRuraux.hypermarche_proche && spServices.hypermarche_proche) {
      servicesRuraux.hypermarche_proche = spServices.hypermarche_proche;
    }
    if (!servicesRuraux.superette_proche && spServices.superette_proche) {
      servicesRuraux.superette_proche = spServices.superette_proche;
    }
    if (!servicesRuraux.station_service_proche && spServices.station_service_proche) {
      servicesRuraux.station_service_proche = spServices.station_service_proche;
    }
    if (!servicesRuraux.poste_proche && spServices.poste_proche) {
      servicesRuraux.poste_proche = spServices.poste_proche;
    }
    if (!servicesRuraux.banque_proche && spServices.banque_proche) {
      servicesRuraux.banque_proche = spServices.banque_proche;
    }
    if (!servicesRuraux.commissariat_proche && spServices.commissariat_proche) {
      servicesRuraux.commissariat_proche = spServices.commissariat_proche;
    }
    if (!servicesRuraux.gendarmerie_proche && spServices.gendarmerie_proche) {
      servicesRuraux.gendarmerie_proche = spServices.gendarmerie_proche;
    }
    if (!servicesRuraux.medecin_proche && spServices.medecin_proche) {
      servicesRuraux.medecin_proche = spServices.medecin_proche;
    }
  } catch (e) {
    console.warn("[Standard] servicesProximiteV1 error (non-blocking):", e);
  }

  // v3.21: FALLBACK OSM OVERPASS pour pharmacie si toujours null
  if (!servicesRuraux.pharmacie_proche) {
    console.log("[Standard] Pharmacie non trouvee via BPE/RPC, fallback OSM Overpass...");
    const osmPharmacy = await fetchNearestPharmacyOverpass(point.lat, point.lon, RAYON_RURAL_MAX_M, debug);
    if (osmPharmacy) {
      servicesRuraux.pharmacie_proche = osmPharmacy;
      if (debug) {
        console.log("[Standard] Pharmacie OSM trouvee:", osmPharmacy.nom, "a", osmPharmacy.distance_km, "km");
      }
    } else {
      console.log("[Standard] Aucune pharmacie trouvee via OSM Overpass");
    }
  }

  if (isRural) {
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

  const ehpadRadius = isRural ? RAYON_RURAL_MAX_M : 5000;
  const ehpad = await finessEhpadNearby(supabase, {
    lat: point.lat,
    lon: point.lon,
    radius_m: ehpadRadius,
    ttl_seconds: 86400,
    debug,
  });

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
    version: "v3.23",
    orchestrator: "smartscore-enriched-v3",
    mode: "standard",
    zone_type: zoneType,
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
      essential_services: essentialServices,
      services_ruraux: servicesRuraux,
      residences_seniors: residencesSeniors,
      healthSummary: { coverage: healthResult.coverage, data: healthResult.data },
      insee: { coverage: inseeResult.coverage, data: inseeResult.data },
      ehpad: { coverage: ehpad.coverage, source: ehpad.source, count: ehpad.count, radius_m: ehpad.radius_m, nearest: ehpad.nearest ?? null, reason: ehpad.reason ?? null },
    },
  };

  if (debug) {
    const essentialServicesCounts: Record<string, number> = {};
    for (const bucket of ALL_ESSENTIAL_BUCKETS) {
      essentialServicesCounts[bucket] = essentialServices[bucket].count;
    }

    const rawItemsSample = essentialServicesRawResult.items.slice(0, 10).map(item => ({
      type_code: item.type_code,
      distance_m: item.distance_m,
      commune: item.commune,
    }));

    output.debug = {
      timestamp: new Date().toISOString(),
      components,
      coverage,
      dvfApi,
      transportResult,
      ecolesResult,
      bpeResult,
      healthResult,
      inseeResult: { coverage: inseeResult.coverage, data: inseeResult.data },
      insee_socioeco_debug: inseeResult.socioEcoDebug,
      ehpad,
      servicesRuraux,
      servicesProximite: servicesProximiteDebug,
      residencesSeniors,
      isInGrandeAgglomeration: !isRural,
      bpeRadius,
      ehpadRadius,
      essential_services_debug: {
        radius_m: essentialServicesRadius,
        radius_km: metersToKm(essentialServicesRadius),
        type_codes_sent_count: essentialServicesRawResult.type_codes_sent.length,
        type_codes_sent_sample: essentialServicesRawResult.type_codes_sent.slice(0, 25),
        raw_items_count: essentialServicesRawResult.items.length,
        raw_items_sample: rawItemsSample,
        counts_by_bucket: essentialServicesCounts,
      },
    };
  }

  console.log("[Standard] response ready, smartscore:", smartScore, "DVF source:", dvfSource, "Zone:", zoneType);
  return json(output, 200);
}

// ============================================================================
// HELPER JSON avec CORS
// ============================================================================
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ============================================================================
// MAIN HANDLER
// ============================================================================
serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const payload = await req.json().catch(() => null);

    console.log("[enriched-v3 v3.23] Received payload:", payload);

    if (!payload) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid JSON" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if ((payload as any).mode === "market_study") {
      console.log("[enriched-v3] Mode market_study detected -> routing enrichi v3.23");
      return await handleMarketStudy(payload as MarketStudyPayload);
    }

    console.log("[enriched-v3] Mode standard detected -> routing standard v3.23");
    return await handleStandard(payload as StandardPayload);
  } catch (err) {
    console.error("[enriched-v3 v3.23] Internal error:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Internal error",
        details: String(err),
        version: "v3.23",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});