// ===== smartscore-enriched-v3/index.ts =====
// VERSION v3.27 - Fixed INSEE/Santé data fetching with correct table/RPC names
// CHANGELOG v3.27:
//    - FIX: fetchInseeSocioEco now uses correct tables: insee_socioeco_communes + insee_communes_stats
//    - FIX: fetchHealthFicheForCommune uses correct RPC: get_fiche_sante_commune (not get_health_fiche_commune)
//    - FIX: Proper coverage logic (not_covered vs error vs no_data vs ok)
//    - FIX: String-to-float conversion for percentage fields (replace "," with ".")
//    - NEW: setProviderErrorObj for structured error reporting
//    - NEW: Enhanced debug.errors with step/message/code/details/hint

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as turf from "https://esm.sh/@turf/turf@6.5.0";

// Providers existants (FINESS + scoring)
import { finessEhpadNearby } from "../_shared/providers/finess.ts";
import { servicesProximiteV1 } from "../_shared/providers/services_proximite.ts";
import { weightedAverage } from "../_shared/providers/scoring.ts";
import type { Coverage } from "../_shared/providers/types.ts";

// V4 imports
import {
  computeEssentialServicesScore,
  computeRuralAccessibilityScore,
  computeSmartScoreV4,
  type EssentialServicesScoreResult,
  type RuralAccessibilityResult,
} from "./smartscore_weights_v4.ts";

import {
  computePriceTrend,
  computeLiquidityScore,
  computeRentalTension,
  computeMarketComposite,
  type PriceTrendResult,
  type LiquidityScoreResult,
  type RentalTensionResult,
} from "./market_intelligence_v4.ts";

import {
  computeGeorisquesScore,
  fetchDpeQuartier,
  fetchAirQuality,
  estimateNoiseScore,
  computeEnvironmentScore,
} from "./environment_score_v4.ts";

import {
  computeDemographicScore,
  type PopulationTrendResult,
} from "./demographic_signal_v4.ts";

import {
  fetchPermisProches,
  computeCompetitionScore,
  type CompetitionScoreResult,
} from "./competition_sitadel_v4.ts";


console.log("smartscore-enriched-v3 orchestrator loaded (v3.27 Fixed INSEE/Santé + Correct Tables/RPC)");

// ----------------------------------------------------
// v3.27: CENTRALIZED ENV + SUPABASE CLIENT CREATION
// ----------------------------------------------------
type EnvDebugInfo = {
  supabaseUrlUsed: string;
  keyKindUsed: "sb_secret" | "sb_publishable" | "jwt" | "unknown";
  hasServiceKey: boolean;
  hasAnonKeyOrJwt: boolean;
  clientReady: boolean;
  functionsBaseUrl: string;
};

type ProviderErrorDetail = {
  step?: string;
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
  demoWarn?: ProviderErrorDetail;
};

type ProviderErrors = {
  insee?: ProviderErrorDetail | string | null;
  sante?: ProviderErrorDetail | string | null;
  transport?: string | null;
  bpe?: string | null;
  dvf?: string | null;
};

function getSupabaseUrl(): string {
  return (
    Deno.env.get("SUPABASE_URL") ??
    Deno.env.get("REST_URL") ??
    Deno.env.get("SB_URL") ??
    Deno.env.get("MIMMOZA_SUPABASE_URL") ??
    Deno.env.get("MIMMOZA_SUPABASE_PUBLIC_URL") ??
    "http://127.0.0.1:54321"
  );
}

function getServiceRoleKey(): string | null {
  const key = 
    Deno.env.get("SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SB_SERVICE_ROLE_KEY") ??
    Deno.env.get("MIMMOZA_SERVICE_ROLE_KEY") ??
    Deno.env.get("MIMMOZA_EDGE_SERVICE_ROLE_JWT") ??
    null;
  return key && key.trim() ? key.trim() : null;
}

function getAnonKey(): string | null {
  const key =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SB_ANON_KEY") ??
    Deno.env.get("MIMMOZA_ANON_KEY") ??
    Deno.env.get("MIMMOZA_EDGE_ANON_JWT") ??
    null;
  return key && key.trim() ? key.trim() : null;
}

function determineKeyKind(key: string | null): EnvDebugInfo["keyKindUsed"] {
  if (!key) return "unknown";
  if (key.startsWith("sb_secret_")) return "sb_secret";
  if (key.startsWith("sb_publishable_")) return "sb_publishable";
  if (key.startsWith("eyJ")) return "jwt";
  return "unknown";
}

function getFunctionsBaseUrl(supabaseUrl: string): string {
  const functionsUrl = Deno.env.get("FUNCTIONS_URL");
  if (functionsUrl && functionsUrl.trim()) {
    return functionsUrl.trim();
  }
  const internalUrl = Deno.env.get("MIMMOZA_EDGE_INTERNAL_URL");
  if (internalUrl && internalUrl.trim()) {
    const base = internalUrl.trim().replace(/\/+$/, "");
    return base + "/functions/v1";
  }
  const base = supabaseUrl.replace(/\/+$/, "");
  return base + "/functions/v1";
}

// Initialize Supabase client
const supabaseUrl = getSupabaseUrl();
const serviceKey = getServiceRoleKey();
const anonKey = getAnonKey();
const supabaseKeyToUse = serviceKey || anonKey || "";
const keyKindUsed = determineKeyKind(supabaseKeyToUse);
const functionsBaseUrl = getFunctionsBaseUrl(supabaseUrl);

const supabase: SupabaseClient | null = supabaseUrl && supabaseKeyToUse
  ? createClient(supabaseUrl, supabaseKeyToUse, { auth: { persistSession: false } })
  : null;

const envDebugInfo: EnvDebugInfo = {
  supabaseUrlUsed: supabaseUrl,
  keyKindUsed,
  hasServiceKey: !!serviceKey,
  hasAnonKeyOrJwt: !!anonKey,
  clientReady: !!supabase,
  functionsBaseUrl,
};

console.log("[smartscore-enriched-v3 env]", envDebugInfo);

// Global error collector for debug
let providerErrors: ProviderErrors = {};

function resetProviderErrors(): void {
  providerErrors = {};
}

function setProviderError(provider: keyof ProviderErrors, error: string | null): void {
  if (error) {
    providerErrors[provider] = error;
  }
}

// v3.27: New function for structured error objects
function setProviderErrorObj(provider: keyof ProviderErrors, obj: ProviderErrorDetail | null): void {
  if (obj) {
    const existing = providerErrors[provider];
    if (existing && typeof existing === "object") {
      providerErrors[provider] = { ...existing, ...obj };
    } else {
      providerErrors[provider] = obj;
    }
  }
}

// ----------------------------------------------------
// CONSTANTS - APIs EXTERNES
// ----------------------------------------------------
const DVF_CSV_BASE = "https://files.data.gouv.fr/geo-dvf/latest/csv";
const GEO_API_BASE = "https://geo.api.gouv.fr";
const DATA_GOUV_BPE_API = "https://tabular-api.data.gouv.fr/api/resources";
const BPE_RESOURCE_ID = "7257eb8b-f2eb-48f5-9c06-172675496269";
const OVERPASS_API_URL = "https://overpass-api.de/api/interpreter";
const RAYON_URBAIN_M = 500;
const RAYON_RURAL_MIN_M = 3000;
const RAYON_RURAL_MAX_M = 20000;

const CODES_COMMERCES_ESSENTIELS = new Set([
  "B101", "B102", "B104", "B105", "B201", "B202", "B207", "B208", "B210",
  "G101", "D301", "B203", "B204", "B205", "B206",
]);

const CODES_SERVICES_ESSENTIELS = new Set([
  "A203", "A204", "A206", "A207", "A208", "A101", "A104",
]);

const CODES_SANTE_ESSENTIELS = new Set([
  "D201", "D202", "D203", "D204", "D205", "D206", "D207", "D208", "D209", "D210", "D211",
  "D221", "D231", "D232", "D233", "D235", "D236", "D237", "D238", "D239", "D240", "D241", "D301",
]);

// ----------------------------------------------------
// GRANDES AGGLOMERATIONS
// ----------------------------------------------------
const COMMUNES_GRANDES_AGGLOS = new Set<string>([
  "75056",
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

const DEPARTEMENTS_GRANDES_AGGLOS = new Set<string>([
  "75", "92", "93", "94", "69", "13", "33", "31", "44", "59", "67", "06", "34", "35",
]);

const COMMUNES_METROPOLES = new Set<string>([
  "69123", "69381", "69382", "69383", "69384", "69385", "69386", "69387", "69388", "69389",
  "69003", "69029", "69033", "69034", "69040", "69044", "69046", "69063", "69068", "69069",
  "69071", "69072", "69081", "69085", "69087", "69088", "69089", "69091", "69096", "69100",
  "69116", "69117", "69127", "69142", "69143", "69149", "69152", "69153", "69163", "69168",
  "69191", "69194", "69199", "69202", "69204", "69205", "69207", "69233", "69244", "69250",
  "69256", "69259", "69260", "69266", "69271", "69273", "69275", "69276", "69277", "69278",
  "69279", "69281", "69282", "69283", "69284", "69286", "69290", "69291", "69292", "69293", "69296",
  "13055", "13001", "13002", "13003", "13004", "13005", "13006", "13007", "13008", "13009",
  "13010", "13011", "13012", "13013", "13014", "13015", "13016", "13201", "13202", "13203",
  "13204", "13205", "13206", "13207", "13208", "13209", "13210", "13211", "13212", "13213",
  "13214", "13215", "13216",
  "33063", "33003", "33013", "33039", "33056", "33065", "33069", "33075", "33096", "33119",
  "33162", "33167", "33192", "33200", "33238", "33249", "33273", "33281", "33312", "33318",
  "33376", "33434", "33449", "33487", "33519", "33522", "33550",
  "31555", "31003", "31022", "31044", "31056", "31069", "31088", "31091", "31116", "31149",
  "31150", "31157", "31163", "31165", "31182", "31184", "31186", "31205", "31230", "31282",
  "31389", "31395", "31417", "31418", "31424", "31445", "31446", "31467", "31488", "31490",
  "31506", "31541", "31557", "31561", "31575",
  "44109", "44020", "44026", "44035", "44047", "44071", "44074", "44114", "44143", "44162",
  "44172", "44190", "44194", "44198", "44204", "44215",
  "59350", "59009", "59011", "59017", "59044", "59051", "59056", "59106", "59128", "59146",
  "59152", "59163", "59195", "59196", "59201", "59208", "59220", "59247", "59250", "59256",
  "59275", "59278", "59279", "59281", "59286", "59299", "59303", "59316", "59317", "59320",
  "59328", "59332", "59339", "59343", "59346", "59352", "59356", "59360", "59367", "59368",
  "59378", "59380", "59381", "59382", "59386", "59388", "59410", "59421", "59426", "59437",
  "59457", "59470", "59482", "59507", "59508", "59512", "59522", "59524", "59527", "59550",
  "59553", "59560", "59566", "59585", "59598", "59599", "59602", "59609", "59611", "59636",
  "59643", "59646", "59648", "59650", "59653", "59656", "59658", "59660",
  "67482", "67043", "67118", "67137", "67180", "67204", "67218", "67227", "67252", "67267",
  "67268", "67302", "67309", "67318", "67365", "67411", "67447", "67462", "67463", "67471",
  "67506", "67519",
  "06088", "06004", "06011", "06027", "06029", "06030", "06031", "06032", "06033", "06057",
  "06069", "06079", "06083", "06084", "06085", "06092", "06095", "06101", "06104", "06106",
  "06112", "06123", "06127", "06128", "06136", "06138", "06149", "06151", "06152", "06155",
  "06157", "06159", "06161",
  "34172", "34022", "34057", "34058", "34077", "34087", "34090", "34095", "34116", "34120",
  "34123", "34129", "34134", "34145", "34154", "34164", "34169", "34179", "34198", "34217",
  "34227", "34249", "34256", "34259", "34270", "34295", "34307", "34327", "34337",
  "35238", "35001", "35022", "35024", "35047", "35051", "35055", "35066", "35068", "35080",
  "35115", "35139", "35196", "35206", "35210", "35218", "35240", "35245", "35266", "35275",
  "35278", "35281", "35300", "35315", "35334", "35352", "35353",
  "38185", "38057", "38059", "38071", "38111", "38126", "38150", "38151", "38158", "38169",
  "38170", "38187", "38188", "38200", "38229", "38235", "38252", "38258", "38271", "38277",
  "38279", "38281", "38309", "38317", "38325", "38328", "38364", "38382", "38421", "38423",
  "38436", "38445", "38471", "38472", "38474", "38485", "38486", "38516", "38524", "38528",
  "38529", "38533", "38540", "38545", "38547", "38553", "38554", "38562",
  "76540", "76005", "76020", "76039", "76056", "76069", "76095", "76108", "76116", "76157",
  "76165", "76178", "76212", "76216", "76222", "76231", "76237", "76269", "76273", "76281",
  "76282", "76285", "76319", "76322", "76350", "76354", "76366", "76367", "76377", "76378",
  "76391", "76402", "76410", "76429", "76436", "76448", "76451", "76457", "76474", "76475",
  "76484", "76486", "76497", "76498", "76499", "76514", "76536", "76550", "76558", "76560",
  "76575", "76591", "76599", "76608", "76614", "76617", "76636", "76640", "76659", "76681",
  "76682", "76684", "76691", "76709", "76717", "76750", "76753",
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
// CANONICAL PROJECT TYPE + CONFIG
// ----------------------------------------------------
type CanonicalProjectType = "LOGEMENT" | "COMMERCE" | "BUREAUX" | "HOTEL" | "ETUDIANT" | "RSS" | "EHPAD";

function normalizeProjectType(projectNature: string | null | undefined): CanonicalProjectType {
  if (!projectNature) return "LOGEMENT";
  const normalized = projectNature.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (normalized === "logement" || normalized === "habitation" || normalized === "residential") return "LOGEMENT";
  if (normalized === "commerce" || normalized === "retail" || normalized === "boutique") return "COMMERCE";
  if (normalized === "bureaux" || normalized === "bureau" || normalized === "office" || normalized === "offices") return "BUREAUX";
  if (normalized === "hotel" || normalized === "hotellerie" || normalized === "hospitality") return "HOTEL";
  if (normalized === "residence_etudiante" || normalized === "etudiant" || normalized === "residence etudiante" || normalized === "student" || normalized === "etudiants") return "ETUDIANT";
  if (normalized === "residence_senior" || normalized === "senior" || normalized === "rss" || normalized === "residence senior" || normalized === "residence seniors" || normalized === "residence autonomie") return "RSS";
  if (normalized === "ehpad" || normalized === "maison de retraite" || normalized === "nursing home") return "EHPAD";
  if (normalized.includes("etudiant") || normalized.includes("student")) return "ETUDIANT";
  if (normalized.includes("senior") || normalized.includes("rss")) return "RSS";
  if (normalized.includes("ehpad") || normalized.includes("retraite")) return "EHPAD";
  if (normalized.includes("hotel")) return "HOTEL";
  if (normalized.includes("bureau") || normalized.includes("office")) return "BUREAUX";
  if (normalized.includes("commerce") || normalized.includes("boutique") || normalized.includes("magasin")) return "COMMERCE";
  if (normalized.includes("logement") || normalized.includes("appartement") || normalized.includes("maison")) return "LOGEMENT";
  return "LOGEMENT";
}

type ProjectWeights = { dvf: number; transport: number; bpe: number; ecoles: number; sante: number; insee: number };

type ProjectConfig = {
  projectType: CanonicalProjectType;
  dvf: { radius_km: number; horizon_months: number; type_local: string | null };
  bpe: { radius_m: number; essential_radius_m: number };
  weights: ProjectWeights;
  weightsNoTransport: ProjectWeights;
  modules: { enableSenior: boolean; enableStudent: boolean; enableCommerce: boolean; enableHotel: boolean };
  notes: string[];
};

function getProjectConfig(projectType: CanonicalProjectType, isRural: boolean, payloadRadiusKm: number, payloadHorizonMonths: number): ProjectConfig {
  const clampRadius = (min: number, max: number, val: number) => Math.max(min, Math.min(max, val));
  const clampMonths = (min: number, max: number, val: number) => Math.max(min, Math.min(max, val));
  const baseBpeRadius = isRural ? RAYON_RURAL_MIN_M : RAYON_URBAIN_M;
  const baseEssentialRadius = isRural ? RAYON_RURAL_MAX_M : RAYON_URBAIN_M;

  switch (projectType) {
    case "LOGEMENT":
      return { projectType, dvf: { radius_km: clampRadius(1, isRural ? 20 : 5, payloadRadiusKm), horizon_months: clampMonths(12, 36, payloadHorizonMonths), type_local: null }, bpe: { radius_m: baseBpeRadius, essential_radius_m: baseEssentialRadius }, weights: { dvf: 0.35, transport: 0.20, bpe: 0.20, ecoles: 0.15, sante: 0.10, insee: 0 }, weightsNoTransport: { dvf: 0.40, transport: 0, bpe: 0.25, ecoles: 0.20, sante: 0.15, insee: 0 }, modules: { enableSenior: false, enableStudent: false, enableCommerce: false, enableHotel: false }, notes: ["Projet logement standard"] };
    case "COMMERCE":
      return { projectType, dvf: { radius_km: clampRadius(1, isRural ? 15 : 3, payloadRadiusKm), horizon_months: clampMonths(12, 24, payloadHorizonMonths), type_local: "Local" }, bpe: { radius_m: isRural ? baseBpeRadius : 800, essential_radius_m: baseEssentialRadius }, weights: { dvf: 0.20, transport: 0.30, bpe: 0.35, ecoles: 0, sante: 0, insee: 0.15 }, weightsNoTransport: { dvf: 0.25, transport: 0, bpe: 0.45, ecoles: 0, sante: 0, insee: 0.30 }, modules: { enableSenior: false, enableStudent: false, enableCommerce: true, enableHotel: false }, notes: ["Projet commerce - focus flux et accessibilite"] };
    case "BUREAUX":
      return { projectType, dvf: { radius_km: clampRadius(1, isRural ? 10 : 3, payloadRadiusKm), horizon_months: clampMonths(12, 36, payloadHorizonMonths), type_local: "Local" }, bpe: { radius_m: baseBpeRadius, essential_radius_m: baseEssentialRadius }, weights: { dvf: 0.25, transport: 0.35, bpe: 0.20, ecoles: 0, sante: 0, insee: 0.20 }, weightsNoTransport: { dvf: 0.35, transport: 0, bpe: 0.35, ecoles: 0, sante: 0, insee: 0.30 }, modules: { enableSenior: false, enableStudent: false, enableCommerce: false, enableHotel: false }, notes: ["Projet bureaux - transport critique"] };
    case "HOTEL":
      return { projectType, dvf: { radius_km: clampRadius(1, isRural ? 10 : 3, payloadRadiusKm), horizon_months: clampMonths(12, 24, payloadHorizonMonths), type_local: "Local" }, bpe: { radius_m: isRural ? baseBpeRadius : 1000, essential_radius_m: baseEssentialRadius }, weights: { dvf: 0.20, transport: 0.25, bpe: 0.25, ecoles: 0, sante: 0.10, insee: 0.20 }, weightsNoTransport: { dvf: 0.30, transport: 0, bpe: 0.35, ecoles: 0, sante: 0.15, insee: 0.20 }, modules: { enableSenior: false, enableStudent: false, enableCommerce: false, enableHotel: true }, notes: ["Projet hotel - accessibilite et services"] };
    case "ETUDIANT":
      return { projectType, dvf: { radius_km: clampRadius(1, isRural ? 10 : 3, payloadRadiusKm), horizon_months: clampMonths(12, 24, payloadHorizonMonths), type_local: "Appartement" }, bpe: { radius_m: baseBpeRadius, essential_radius_m: baseEssentialRadius }, weights: { dvf: 0.20, transport: 0.30, bpe: 0.25, ecoles: 0.25, sante: 0, insee: 0 }, weightsNoTransport: { dvf: 0.25, transport: 0, bpe: 0.35, ecoles: 0.40, sante: 0, insee: 0 }, modules: { enableSenior: false, enableStudent: true, enableCommerce: false, enableHotel: false }, notes: ["Projet etudiant - ecoles et transport critiques"] };
    case "RSS":
    case "EHPAD":
      return { projectType, dvf: { radius_km: clampRadius(3, isRural ? 20 : 10, Math.max(payloadRadiusKm, 3)), horizon_months: clampMonths(24, 36, Math.max(payloadHorizonMonths, 24)), type_local: projectType === "EHPAD" ? "Local" : "Appartement" }, bpe: { radius_m: isRural ? RAYON_RURAL_MIN_M : 1000, essential_radius_m: baseEssentialRadius }, weights: { dvf: 0.10, transport: 0.10, bpe: 0.20, ecoles: 0, sante: 0.30, insee: 0.30 }, weightsNoTransport: { dvf: 0.15, transport: 0, bpe: 0.25, ecoles: 0, sante: 0.30, insee: 0.30 }, modules: { enableSenior: true, enableStudent: false, enableCommerce: false, enableHotel: false }, notes: ["Projet " + projectType + " - focus seniors"] };
    default:
      return getProjectConfig("LOGEMENT", isRural, payloadRadiusKm, payloadHorizonMonths);
  }
}

// ----------------------------------------------------
// TYPES PRINCIPAUX
// ----------------------------------------------------
type DvfStats = {
  nb_transactions: number;
  prix_m2_median: number | null;
  prix_m2_moyen: number | null;
  evolution_prix_pct: number | null;
  transactions: Array<{
    date_mutation: string;
    valeur_fonciere: number;
    surface_reelle_bati: number | null;
    type_local: string;
    code_postal: string;
    commune: string;
  }>;
};

type TransportScore = {
  score: number;
  stops: Array<{ name: string; type: string; distance_m: number; lat?: number; lon?: number }>;
  nearest_stop_m: number | null;
  coverage: Coverage;
};

type BpeEquipment = {
  code: string;
  label: string;
  count: number;
  nearest_distance_m: number | null;
  category?: string;
};

type BpeStats = {
  total_equipements: number;
  equipements: BpeEquipment[];
  score: number;
  coverage: Coverage;
  commerces?: { count: number; essentiels_count: number; score: number; details: BpeEquipment[] };
  services?: { count: number; essentiels_count: number; score: number; details: BpeEquipment[] };
  sante?: { count: number; essentiels_count: number; score: number; details: BpeEquipment[] };
};

type EcoleInfo = {
  nom: string;
  type: string;
  distance_m: number;
  effectif?: number | null;
  lat?: number;
  lon?: number;
};

type EcolesStats = {
  total_ecoles: number;
  ecoles: EcoleInfo[];
  score: number;
  coverage: Coverage;
};

type UniversityInfo = {
  nom: string;
  type: string;
  distance_m: number;
  effectif?: number | null;
};

type EtudiantStats = {
  universities_nearby: UniversityInfo[];
  total_students_nearby: number;
  score: number;
  coverage: Coverage;
};

type SanteEquipment = {
  code: string;
  label: string;
  count: number;
  nearest_distance_m: number | null;
};

type SanteStats = {
  total_etablissements: number;
  etablissements: SanteEquipment[];
  score: number;
  coverage: Coverage;
  apl?: number | null;
  medecins_generalistes?: number | null;
  dentistes?: number | null;
  pharmacies?: number | null;
  urgences_km?: number | null;
  hopital_km?: number | null;
  // v3.27: Additional fields from RPC
  desert_medical_score?: number | null;
  densite_medecins_10000?: number | null;
};

type InseeData = {
  population?: number | null;
  densite?: number | null;
  revenu_median?: number | null;
  taux_pauvrete?: number | null;
  part_retraites?: number | null;
  part_cadres?: number | null;
  taux_chomage?: number | null;
  score: number;
  coverage: Coverage;
};

type SeniorStats = {
  population_75_plus?: number | null;
  part_75_plus?: number | null;
  ehpad_nearby?: Array<{ nom: string; distance_m: number; capacite?: number | null }>;
  score: number;
  coverage: Coverage;
};

type CommerceStats = {
  zone_chalandise_pop?: number | null;
  revenus_zone?: number | null;
  concurrence_directe?: number | null;
  flux_pietons_score?: number | null;
  score: number;
  coverage: Coverage;
};

type HotelStats = {
  touristes_annuels?: number | null;
  hotels_concurrents?: number | null;
  taux_occupation_zone?: number | null;
  score: number;
  coverage: Coverage;
};

type EnrichedResult = {
  lat: number;
  lon: number;
  commune_insee: string | null;
  commune_nom: string | null;
  departement: string | null;
  region: string | null;
  code_postal: string | null;
  is_rural: boolean;
  project_type: CanonicalProjectType;
  project_config: ProjectConfig;
  dvf: DvfStats | null;
  transport: TransportScore | null;
  bpe: BpeStats | null;
  ecoles: EcolesStats | null;
  sante: SanteStats | null;
  insee: InseeData | null;
  etudiant?: EtudiantStats | null;
  senior?: SeniorStats | null;
  commerce?: CommerceStats | null;
  hotel?: HotelStats | null;
  global_score: number | null;
  score_details: Record<string, number | null>;
  coverage_summary: Record<string, Coverage>;
  debug?: {
    dvf_params?: { radius_km: number; horizon_months: number; type_local: string | null; dept: string | null };
    bpe_params?: { radius_m: number };
    weights_used?: ProjectWeights;
    envDebug?: EnvDebugInfo;
    errors?: ProviderErrors;
  };
};

// Market study types
type MarketStudyDemand = {
  population_zone: number | null;
  evolution_pop_5ans_pct: number | null;
  revenu_median: number | null;
  taux_proprietaires_pct: number | null;
  part_menages_1_2_pers_pct: number | null;
  score_demande: number;
};

type MarketStudyOffer = {
  nb_transactions_12m: number;
  prix_m2_median: number | null;
  evolution_prix_12m_pct: number | null;
  stock_actif_estimation: number | null;
  delai_vente_moyen_jours: number | null;
  score_offre: number;
};

type MarketStudyContext = {
  accessibilite_score: number;
  services_score: number;
  qualite_vie_score: number;
  dynamisme_eco_score: number;
  score_contexte: number;
};

type MarketStudyResult = {
  lat: number;
  lon: number;
  commune_insee: string | null;
  commune_nom: string | null;
  departement: string | null;
  code_postal: string | null;
  is_rural: boolean;
  project_type: CanonicalProjectType;
  demande: MarketStudyDemand;
  offre: MarketStudyOffer;
  contexte: MarketStudyContext;
  score_global: number;
  recommandation: "tres_favorable" | "favorable" | "neutre" | "defavorable" | "tres_defavorable";
  points_forts: string[];
  points_vigilance: string[];
  debug?: {
    envDebug?: EnvDebugInfo;
    errors?: ProviderErrors;
  };
};

// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------
function safeParseFloat(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return isNaN(val) ? null : val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed === "" || trimmed === "NA" || trimmed === "N/A" || trimmed === "-") return null;
    // v3.27: Handle French decimal separator
    const parsed = parseFloat(trimmed.replace(",", "."));
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

// v3.27: Helper to parse percentage strings like "12,5" or "12.5"
function safeParsePercentage(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return isNaN(val) ? null : val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed === "" || trimmed === "NA" || trimmed === "N/A" || trimmed === "-") return null;
    // Remove % if present and handle French decimal separator
    const cleaned = trimmed.replace("%", "").replace(",", ".").trim();
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

function resolvePoint(payload: Record<string, unknown>): { lat: number; lon: number } | null {
  if (typeof payload.lat === "number" && typeof payload.lon === "number") {
    return { lat: payload.lat, lon: payload.lon };
  }
  if (typeof payload.latitude === "number" && typeof payload.longitude === "number") {
    return { lat: payload.latitude, lon: payload.longitude };
  }
  if (typeof payload.address === "string" && payload.address.trim()) {
    return null;
  }
  return null;
}

async function geocodeAddress(address: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const url = `${GEO_API_BASE}/search/?q=${encodeURIComponent(address)}&limit=1`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0 && data[0].geometry?.coordinates) {
      const [lon, lat] = data[0].geometry.coordinates;
      return { lat, lon };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchCommuneInfo(lat: number, lon: number): Promise<{
  code_insee: string | null;
  nom: string | null;
  departement: string | null;
  region: string | null;
  code_postal: string | null;
  population: number | null;
  is_rural: boolean;
}> {
  try {
    const url = `${GEO_API_BASE}/communes?lat=${lat}&lon=${lon}&fields=code,nom,departement,region,codesPostaux,population&limit=1`;
    const resp = await fetch(url);
    if (!resp.ok) return { code_insee: null, nom: null, departement: null, region: null, code_postal: null, population: null, is_rural: true };
    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0) {
      const commune = data[0];
      const pop = commune.population ?? null;
      return {
        code_insee: commune.code ?? null,
        nom: commune.nom ?? null,
        departement: commune.departement?.code ?? null,
        region: commune.region?.nom ?? null,
        code_postal: commune.codesPostaux?.[0] ?? null,
        population: pop,
        is_rural: pop !== null && pop < 10000,
      };
    }
    return { code_insee: null, nom: null, departement: null, region: null, code_postal: null, population: null, is_rural: true };
  } catch {
    return { code_insee: null, nom: null, departement: null, region: null, code_postal: null, population: null, is_rural: true };
  }
}

function getDepartementFromInsee(code_insee: string | null): string | null {
  if (!code_insee || code_insee.length < 2) return null;
  if (code_insee.startsWith("97") && code_insee.length >= 3) {
    return code_insee.slice(0, 3);
  }
  return code_insee.slice(0, 2);
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreDvf(dvf: DvfStats | null): number {
  if (!dvf || dvf.nb_transactions === 0) return 0;
  let score = 50;
  if (dvf.nb_transactions >= 10) score += 15;
  else if (dvf.nb_transactions >= 5) score += 10;
  else if (dvf.nb_transactions >= 2) score += 5;
  if (dvf.evolution_prix_pct !== null) {
    if (dvf.evolution_prix_pct > 5) score += 20;
    else if (dvf.evolution_prix_pct > 0) score += 10;
    else if (dvf.evolution_prix_pct > -5) score += 5;
    else score -= 10;
  }
  return Math.max(0, Math.min(100, score));
}

function scoreTransport(transport: TransportScore | null): number {
  if (!transport || transport.coverage === "not_covered") return 0;
  return transport.score;
}

function scoreBpe(bpe: BpeStats | null): number {
  if (!bpe || bpe.coverage === "not_covered") return 0;
  return bpe.score;
}

function scoreEcoles(ecoles: EcolesStats | null): number {
  if (!ecoles || ecoles.coverage === "not_covered") return 0;
  return ecoles.score;
}

function scoreSante(sante: SanteStats | null): number {
  if (!sante || sante.coverage === "not_covered") return 0;
  return sante.score;
}

function scoreInsee(insee: InseeData | null): number {
  if (!insee || insee.coverage === "not_covered") return 0;
  return insee.score;
}

function computeGlobalScore(
  dvf: DvfStats | null,
  transport: TransportScore | null,
  bpe: BpeStats | null,
  ecoles: EcolesStats | null,
  sante: SanteStats | null,
  insee: InseeData | null,
  weights: ProjectWeights
): { global: number; details: Record<string, number | null> } {
  const scores: Array<{ key: string; score: number; weight: number }> = [];
  const details: Record<string, number | null> = {};
  const dvfScore = scoreDvf(dvf);
  details.dvf = dvfScore;
  if (weights.dvf > 0) scores.push({ key: "dvf", score: dvfScore, weight: weights.dvf });
  const transportScore = scoreTransport(transport);
  details.transport = transportScore;
  if (weights.transport > 0) scores.push({ key: "transport", score: transportScore, weight: weights.transport });
  const bpeScore = scoreBpe(bpe);
  details.bpe = bpeScore;
  if (weights.bpe > 0) scores.push({ key: "bpe", score: bpeScore, weight: weights.bpe });
  const ecolesScore = scoreEcoles(ecoles);
  details.ecoles = ecolesScore;
  if (weights.ecoles > 0) scores.push({ key: "ecoles", score: ecolesScore, weight: weights.ecoles });
  const santeScore = scoreSante(sante);
  details.sante = santeScore;
  if (weights.sante > 0) scores.push({ key: "sante", score: santeScore, weight: weights.sante });
  const inseeScore = scoreInsee(insee);
  details.insee = inseeScore;
  if (weights.insee > 0) scores.push({ key: "insee", score: inseeScore, weight: weights.insee });
  if (scores.length === 0) return { global: 0, details };
  const totalWeight = scores.reduce((acc, s) => acc + s.weight, 0);
  const weightedSum = scores.reduce((acc, s) => acc + s.score * s.weight, 0);
  const global = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  return { global, details };
}

// ----------------------------------------------------
// DVF FETCH
// ----------------------------------------------------
async function fetchDvfStats(
  lat: number,
  lon: number,
  dept: string,
  radiusKm: number,
  horizonMonths: number,
  typeLocal: string | null
): Promise<DvfStats> {
  const empty: DvfStats = { nb_transactions: 0, prix_m2_median: null, prix_m2_moyen: null, evolution_prix_pct: null, transactions: [] };
  try {
    const yearNow = new Date().getFullYear();
    const targetYears = [yearNow - 1, yearNow - 2];
    const transactions: DvfStats["transactions"] = [];
    for (const year of targetYears) {
      const csvUrl = `${DVF_CSV_BASE}/${year}/departements/${dept}.csv.gz`;
      const resp = await fetch(csvUrl);
      if (!resp.ok) continue;
      const text = await resp.text();
      const lines = text.split("\n");
      if (lines.length < 2) continue;
      const header = lines[0].split(",");
      const idxLat = header.indexOf("latitude");
      const idxLon = header.indexOf("longitude");
      const idxValeur = header.indexOf("valeur_fonciere");
      const idxSurface = header.indexOf("surface_reelle_bati");
      const idxType = header.indexOf("type_local");
      const idxDate = header.indexOf("date_mutation");
      const idxCP = header.indexOf("code_postal");
      const idxCommune = header.indexOf("nom_commune");
      if (idxLat < 0 || idxLon < 0 || idxValeur < 0) continue;
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        if (cols.length < header.length) continue;
        const tLat = parseFloat(cols[idxLat]);
        const tLon = parseFloat(cols[idxLon]);
        if (isNaN(tLat) || isNaN(tLon)) continue;
        const dist = haversineDistance(lat, lon, tLat, tLon) / 1000;
        if (dist > radiusKm) continue;
        if (typeLocal && idxType >= 0 && cols[idxType] && !cols[idxType].toLowerCase().includes(typeLocal.toLowerCase())) continue;
        const valeur = parseFloat(cols[idxValeur]);
        const surface = idxSurface >= 0 ? parseFloat(cols[idxSurface]) : NaN;
        if (isNaN(valeur) || valeur <= 0) continue;
        transactions.push({
          date_mutation: idxDate >= 0 ? cols[idxDate] : "",
          valeur_fonciere: valeur,
          surface_reelle_bati: isNaN(surface) ? null : surface,
          type_local: idxType >= 0 ? cols[idxType] : "",
          code_postal: idxCP >= 0 ? cols[idxCP] : "",
          commune: idxCommune >= 0 ? cols[idxCommune] : "",
        });
      }
    }
    if (transactions.length === 0) return empty;
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - horizonMonths);
    const filtered = transactions.filter((t) => {
      if (!t.date_mutation) return true;
      const d = new Date(t.date_mutation);
      return d >= cutoffDate;
    });
    if (filtered.length === 0) return { ...empty, transactions };
    const prixM2List = filtered.filter((t) => t.surface_reelle_bati && t.surface_reelle_bati > 0).map((t) => t.valeur_fonciere / t.surface_reelle_bati!);
    prixM2List.sort((a, b) => a - b);
    const median = prixM2List.length > 0 ? prixM2List[Math.floor(prixM2List.length / 2)] : null;
    const mean = prixM2List.length > 0 ? prixM2List.reduce((a, b) => a + b, 0) / prixM2List.length : null;
    let evolution: number | null = null;
    const halfHorizon = Math.floor(horizonMonths / 2);
    const midDate = new Date();
    midDate.setMonth(midDate.getMonth() - halfHorizon);
    const older = filtered.filter((t) => t.date_mutation && new Date(t.date_mutation) < midDate);
    const newer = filtered.filter((t) => t.date_mutation && new Date(t.date_mutation) >= midDate);
    if (older.length > 0 && newer.length > 0) {
      const olderPrix = older.filter((t) => t.surface_reelle_bati && t.surface_reelle_bati > 0).map((t) => t.valeur_fonciere / t.surface_reelle_bati!);
      const newerPrix = newer.filter((t) => t.surface_reelle_bati && t.surface_reelle_bati > 0).map((t) => t.valeur_fonciere / t.surface_reelle_bati!);
      if (olderPrix.length > 0 && newerPrix.length > 0) {
        const avgOld = olderPrix.reduce((a, b) => a + b, 0) / olderPrix.length;
        const avgNew = newerPrix.reduce((a, b) => a + b, 0) / newerPrix.length;
        if (avgOld > 0) evolution = ((avgNew - avgOld) / avgOld) * 100;
      }
    }
    return { nb_transactions: filtered.length, prix_m2_median: median, prix_m2_moyen: mean, evolution_prix_pct: evolution, transactions: filtered.slice(0, 50) };
  } catch (err) {
    console.error("[fetchDvfStats] Error:", err);
    setProviderError("dvf", String(err));
    return empty;
  }
}

// ----------------------------------------------------
// v3.27: INSEE SOCIO-ECO (FIXED - Correct tables)
// Tables used:
//   - insee_socioeco_communes (socio-economic data)
//   - insee_communes_stats (demographic data)
// ----------------------------------------------------
async function fetchInseeSocioEco(communeInsee: string): Promise<InseeData> {
  const empty: InseeData = { score: 0, coverage: "no_data" as Coverage };
  
  // v3.27: If no Supabase client, return not_covered (not error)
  if (!supabase) {
    console.warn("[fetchInseeSocioEco] not_covered (no Supabase client)");
    return { ...empty, coverage: "not_covered" as Coverage };
  }
  
  try {
    // ✅ Source 1: Socio-economic data from insee_socioeco_communes
    const { data: socio, error: socioErr } = await supabase
      .from("insee_socioeco_communes")
      .select("code_commune, commune, revenu_median_eur, taux_chomage_pct, taux_pauvrete_pct, pct_proprietaires, pension_retraite_moyenne_eur_mois, annee, source")
      .eq("code_commune", communeInsee)
      .maybeSingle();

    if (socioErr) {
      console.error("[fetchInseeSocioEco] socio query error:", socioErr);
      setProviderErrorObj("insee", {
        step: "select insee_socioeco_communes",
        message: socioErr.message,
        code: (socioErr as any).code,
        details: (socioErr as any).details,
        hint: (socioErr as any).hint,
      });
      return { ...empty, coverage: "error" as Coverage };
    }

    // ✅ Source 2: Demographic data from insee_communes_stats
    const { data: demo, error: demoErr } = await supabase
      .from("insee_communes_stats")
      .select("code_commune, population, densite, densite_pop, pct_plus_65, pct_moins_25, commune, nom_commune")
      .eq("code_commune", communeInsee)
      .maybeSingle();

    if (demoErr) {
      // Log warning but don't fail if socio is OK
      console.warn("[fetchInseeSocioEco] demo query warn:", demoErr);
      setProviderErrorObj("insee", {
        demoWarn: {
          step: "select insee_communes_stats",
          message: demoErr.message,
          code: (demoErr as any).code,
          details: (demoErr as any).details,
          hint: (demoErr as any).hint,
        },
      });
    }

    // If neither socio nor demo has data, return no_data
    if (!socio && !demo) {
      console.log("[fetchInseeSocioEco] no_data (no socio & no demo) for", communeInsee);
      return { ...empty, coverage: "no_data" as Coverage };
    }

    // Merge data from both sources with proper type handling
    const population = safeParseFloat((demo as any)?.population);
    const densite = safeParseFloat((demo as any)?.densite ?? (demo as any)?.densite_pop);
    const revenu_median = safeParseFloat((socio as any)?.revenu_median_eur);
    // v3.27: Parse percentage strings properly (handle "12,5" format)
    const taux_chomage = safeParsePercentage((socio as any)?.taux_chomage_pct);
    const taux_pauvrete = safeParsePercentage((socio as any)?.taux_pauvrete_pct);
    const part_retraites = safeParseFloat((socio as any)?.pension_retraite_moyenne_eur_mois);
    const part_cadres: number | null = null; // Not available in seed

    // Calculate score based on available data
    let score = 50;
    if (revenu_median !== null) {
      if (revenu_median > 25000) score += 15;
      else if (revenu_median > 20000) score += 10;
      else if (revenu_median < 15000) score -= 10;
    }
    if (taux_chomage !== null) {
      if (taux_chomage < 7) score += 10;
      else if (taux_chomage < 10) score += 5;
      else if (taux_chomage > 15) score -= 10;
    }
    if (taux_pauvrete !== null) {
      if (taux_pauvrete < 10) score += 10;
      else if (taux_pauvrete > 20) score -= 10;
    }
    score = Math.max(0, Math.min(100, score));

    return {
      population,
      densite,
      revenu_median,
      taux_pauvrete,
      part_retraites,
      part_cadres,
      taux_chomage,
      score,
      coverage: "ok" as Coverage,
    };
  } catch (err) {
    console.error("[fetchInseeSocioEco] Exception:", err);
    setProviderErrorObj("insee", { step: "exception", message: String(err) });
    return { ...empty, coverage: "error" as Coverage };
  }
}

// ----------------------------------------------------
// v3.27: HEALTH DATA VIA RPC (FIXED - Correct RPC name)
// RPC: get_fiche_sante_commune(p_code_commune text)
// Returns: { code_commune, commune, population, densite_medecins_10000, 
//            desert_medical_score, densite_label, kpi: {...}, resume }
// ----------------------------------------------------
async function fetchHealthFicheForCommune(communeInsee: string): Promise<SanteStats> {
  const empty: SanteStats = { total_etablissements: 0, etablissements: [], score: 0, coverage: "no_data" as Coverage };
  
  // v3.27: If no Supabase client, return not_covered (not error)
  if (!supabase) {
    console.warn("[fetchHealthFicheForCommune] not_covered (no Supabase client)");
    return { ...empty, coverage: "not_covered" as Coverage };
  }
  
  try {
    // ✅ v3.27: Call the CORRECT RPC name: get_fiche_sante_commune
    const { data, error } = await supabase.rpc("get_fiche_sante_commune", { p_code_commune: communeInsee });
    
    if (error) {
      console.error("[fetchHealthFicheForCommune] RPC error:", error);
      setProviderErrorObj("sante", {
        step: "rpc get_fiche_sante_commune",
        message: error.message,
        code: (error as any).code,
        details: (error as any).details,
        hint: (error as any).hint,
      });
      return { ...empty, coverage: "error" as Coverage };
    }
    
    if (!data || (Array.isArray(data) && data.length === 0)) {
      console.log("[fetchHealthFicheForCommune] No data for commune:", communeInsee);
      return { ...empty, coverage: "no_data" as Coverage };
    }
    
    // Handle both array and object responses
    const fiche: any = Array.isArray(data) ? data[0] : data;

    // v3.27: Extract fields from RPC response structure
    const desert = safeParseFloat(fiche?.desert_medical_score);
    const densiteMed = safeParseFloat(fiche?.densite_medecins_10000);

    // KPI object contains detailed counts
    const kpi = fiche?.kpi ?? {};
    const medecins = safeParseFloat(kpi?.generalistes_total ?? kpi?.medecins_generalistes ?? fiche?.medecins_generalistes);
    const dentistes = safeParseFloat(kpi?.dentistes_total ?? fiche?.dentistes_total ?? fiche?.dentistes);
    const pharmacies = safeParseFloat(kpi?.pharmacies_total ?? fiche?.pharmacies_total ?? fiche?.pharmacies);

    // Legacy fields (may or may not exist)
    const apl = safeParseFloat(fiche?.apl ?? null);
    const urgences = safeParseFloat(fiche?.urgences_km ?? null);
    const hopital = safeParseFloat(fiche?.hopital_km ?? null);

    // v3.27: Calculate score based on available data
    let score = 50;
    
    // Priority 1: Use desert_medical_score if available (0=perfect, 100=catastrophic)
    if (desert !== null) {
      score = Math.max(0, Math.min(100, Math.round(100 - desert)));
    }
    // Priority 2: Use densite_medecins_10000 as fallback
    else if (densiteMed !== null) {
      score = Math.max(0, Math.min(100, 30 + Math.round(densiteMed)));
    }
    // Priority 3: Use APL as legacy fallback
    else {
      if (apl !== null) {
        if (apl > 4) score += 20;
        else if (apl > 2.5) score += 10;
        else if (apl < 1) score -= 15;
      }
    }
    
    // Additional adjustments
    if (urgences !== null) {
      if (urgences < 10) score += 10;
      else if (urgences < 20) score += 5;
      else if (urgences > 30) score -= 10;
    }
    if (pharmacies !== null && pharmacies > 0) score += 5;
    
    score = Math.max(0, Math.min(100, score));

    return {
      total_etablissements: (medecins ?? 0) + (dentistes ?? 0) + (pharmacies ?? 0),
      etablissements: [],
      score,
      coverage: "ok" as Coverage,
      apl,
      medecins_generalistes: medecins,
      dentistes,
      pharmacies,
      urgences_km: urgences,
      hopital_km: hopital,
      // v3.27: Include new fields
      desert_medical_score: desert,
      densite_medecins_10000: densiteMed,
    };
  } catch (err) {
    console.error("[fetchHealthFicheForCommune] Exception:", err);
    setProviderErrorObj("sante", { step: "exception", message: String(err) });
    return { ...empty, coverage: "error" as Coverage };
  }
}

// ----------------------------------------------------
// v3.27: INSEE HYBRID STATS (Fallback to GeoAPI)
// ----------------------------------------------------
async function fetchInseeStatsHybrid(communeInsee: string, lat: number, lon: number): Promise<InseeData> {
  const fromDb = await fetchInseeSocioEco(communeInsee);
  
  // If we got data or not_covered, return as-is
  if (fromDb.coverage === "ok") return fromDb;
  if (fromDb.coverage === "not_covered") return fromDb;
  
  // Try GeoAPI fallback for basic population data
  try {
    const url = `${GEO_API_BASE}/communes/${communeInsee}?fields=population`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.population) {
        return {
          population: data.population,
          densite: null,
          revenu_median: null,
          taux_pauvrete: null,
          part_retraites: null,
          part_cadres: null,
          taux_chomage: null,
          score: 50,
          coverage: "ok" as Coverage,
        };
      }
    }
  } catch (err) {
    console.warn("[fetchInseeStatsHybrid] GeoAPI fallback failed:", err);
  }
  
  return fromDb;
}

// ----------------------------------------------------
// TRANSPORT (Overpass API)
// ----------------------------------------------------
async function fetchTransportScore(lat: number, lon: number, radiusM: number, isGrandeAgglo: boolean): Promise<TransportScore> {
  const empty: TransportScore = { score: 0, stops: [], nearest_stop_m: null, coverage: "no_data" as Coverage };
  try {
    const query = `
      [out:json][timeout:15];
      (
        node["railway"="station"](around:${radiusM},${lat},${lon});
        node["railway"="halt"](around:${radiusM},${lat},${lon});
        node["public_transport"="stop_position"]["subway"="yes"](around:${radiusM},${lat},${lon});
        node["station"="subway"](around:${radiusM},${lat},${lon});
        node["railway"="tram_stop"](around:${radiusM},${lat},${lon});
        node["highway"="bus_stop"](around:${radiusM},${lat},${lon});
        node["public_transport"="platform"](around:${radiusM},${lat},${lon});
      );
      out body;
    `;
    const resp = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!resp.ok) {
      console.warn("[fetchTransportScore] Overpass API error:", resp.status);
      setProviderError("transport", `Overpass API returned ${resp.status}`);
      return { ...empty, coverage: "error" as Coverage };
    }
    const data = await resp.json();
    const elements = data.elements || [];
    if (elements.length === 0) {
      return { ...empty, coverage: "ok" as Coverage, score: isGrandeAgglo ? 20 : 40 };
    }
    const stops: TransportScore["stops"] = [];
    for (const el of elements) {
      if (el.lat && el.lon) {
        const dist = haversineDistance(lat, lon, el.lat, el.lon);
        let type = "bus";
        if (el.tags?.railway === "station") type = "train";
        else if (el.tags?.railway === "halt") type = "train";
        else if (el.tags?.subway === "yes" || el.tags?.station === "subway") type = "metro";
        else if (el.tags?.railway === "tram_stop") type = "tram";
        stops.push({
          name: el.tags?.name || "Stop",
          type,
          distance_m: Math.round(dist),
          lat: el.lat,
          lon: el.lon,
        });
      }
    }
    stops.sort((a, b) => a.distance_m - b.distance_m);
    const topStops = stops.slice(0, 10);
    const nearest = topStops.length > 0 ? topStops[0].distance_m : null;
    let score = 50;
    const hasMetroOrTrain = topStops.some((s) => s.type === "metro" || s.type === "train");
    const hasTram = topStops.some((s) => s.type === "tram");
    if (hasMetroOrTrain) score += 30;
    else if (hasTram) score += 20;
    else if (topStops.length > 0) score += 10;
    if (nearest !== null) {
      if (nearest < 200) score += 15;
      else if (nearest < 500) score += 10;
      else if (nearest < 1000) score += 5;
    }
    if (topStops.length >= 5) score += 5;
    score = Math.max(0, Math.min(100, score));
    return { score, stops: topStops, nearest_stop_m: nearest, coverage: "ok" as Coverage };
  } catch (err) {
    console.error("[fetchTransportScore] Error:", err);
    setProviderError("transport", String(err));
    return { ...empty, coverage: "error" as Coverage };
  }
}

// ----------------------------------------------------
// BPE EQUIPMENT LABELS
// ----------------------------------------------------
const BPE_LABELS: Record<string, string> = {
  A101: "Police", A104: "Gendarmerie", A203: "Banque", A204: "Banque-Crédit",
  A206: "Poste", A207: "Relais Poste", A208: "Agence Postale",
  B101: "Hypermarché", B102: "Supermarché", B104: "Supérette", B105: "Épicerie",
  B201: "Boulangerie", B202: "Boucherie", B203: "Produits surgelés", B204: "Poissonnerie",
  B205: "Librairie", B206: "Magasin de vêtements", B207: "Magasin chaussures",
  B208: "Magasin électro", B210: "Magasin meubles",
  C101: "École maternelle", C102: "École maternelle de regr.",
  C104: "École élémentaire", C105: "École élémentaire de regr.",
  C201: "Collège", C301: "Lycée général", C302: "Lycée technologique", C303: "Lycée professionnel",
  C304: "SGT", C305: "SEP", C401: "STS-CPGE", C402: "Formation santé", C403: "Formation commerce",
  C409: "Autre formation sup", C501: "Résidence universitaire", C502: "Restaurant universitaire",
  C503: "Centre doc universitaire", C504: "Formation continue", C505: "Form. ingénieurs",
  C506: "Université", C509: "Autre enseignement sup",
  D201: "Médecin généraliste", D202: "Spécialiste chirurgie", D203: "Spécialiste gynéco",
  D204: "Spécialiste pédiatrie", D205: "Spécialiste psychiatrie", D206: "Spécialiste ophtalmo",
  D207: "Spécialiste ORL", D208: "Spécialiste cardio", D209: "Spécialiste radio",
  D210: "Spécialiste gastro", D211: "Spécialiste dermato",
  D221: "Chirurgien-dentiste", D231: "Sage-femme", D232: "Infirmier", D233: "Masseur-kiné",
  D235: "Orthophoniste", D236: "Orthoptiste", D237: "Audio-prothésiste",
  D238: "Pédicure-podologue", D239: "Ergothérapeute", D240: "Psychomotricien",
  D241: "Diététicien", D301: "Pharmacie",
  D302: "Laboratoire d'analyses", D303: "Ambulance", D304: "Transfusion sanguine",
  D305: "Établissement thermal", D307: "Établ hémodialyse",
  D401: "Hôpital court séjour", D402: "Hôpital moyen séjour", D403: "Hôpital long séjour",
  D404: "Hôpital psychiatrique", D405: "Centre de lutte cancer", D406: "Urgences",
  D407: "Maternité", D408: "Centre de santé", D409: "Struct psychiatrique ambulatoire",
  D410: "Centre médecine préventive", D411: "Dialyse", D412: "Hospitalisation à domicile",
  D501: "Personnes âgées: hébergement", D502: "Personnes âgées: soins domicile",
  D503: "Personnes âgées: services", D504: "Personnes âgées: foyer",
  D505: "Personnes âgées: soins infirmiers",
  D601: "Enfance: garde", D602: "Enfance: crèche", D603: "Enfance: halte-garderie",
  D604: "Enfance: assistance maternelle",
  E101: "Coiffure", E102: "Vétérinaire", E103: "Agence de voyages",
  E104: "Restaurant", E105: "Hôtel", E106: "Camping", E107: "Info touristique",
  F101: "Bassin de natation", F102: "Boulodrome", F103: "Tennis", F104: "Équipement athlétisme",
  F105: "Terrain de grands jeux", F106: "Salle de combat", F107: "Salle non spécialisée",
  F108: "Roller Skate Vélo", F109: "Sports nautiques", F110: "Centre équestre", F111: "Salle fitness",
  F112: "Terrain de golf", F113: "Parcours sportif", F114: "Sports de glace",
  F116: "Plateau ext. multisports", F117: "Salle multisports", F118: "Terrain de petits jeux",
  F119: "Salle de musculation", F120: "Skatepark", F121: "Sports aériens",
  F201: "Cinéma", F303: "Théâtre", F304: "Conservatoire", F305: "École de musique", F306: "École d'art",
  F307: "Bibliothèque", F308: "Musée", F309: "Exposition temporaire",
  G101: "Taxi", G102: "Gare de voyageurs", G103: "Gare sous convention",
  G104: "Aéroport", G105: "Port de commerce",
};

function getBpeLabel(code: string): string {
  return BPE_LABELS[code] || code;
}

// ----------------------------------------------------
// BPE FETCH
// ----------------------------------------------------
async function fetchBpeEquipments(lat: number, lon: number, radiusM: number): Promise<BpeStats> {
  const empty: BpeStats = { total_equipements: 0, equipements: [], score: 0, coverage: "no_data" as Coverage };
  try {
    const bbox = {
      minLat: lat - (radiusM / 111000),
      maxLat: lat + (radiusM / 111000),
      minLon: lon - (radiusM / (111000 * Math.cos(lat * Math.PI / 180))),
      maxLon: lon + (radiusM / (111000 * Math.cos(lat * Math.PI / 180))),
    };
    const url = `${DATA_GOUV_BPE_API}/${BPE_RESOURCE_ID}/data/?LAMBERT_Y__greater=${bbox.minLat * 1e6}&LAMBERT_Y__less=${bbox.maxLat * 1e6}&LAMBERT_X__greater=${bbox.minLon * 1e6}&LAMBERT_X__less=${bbox.maxLon * 1e6}&page_size=100`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn("[fetchBpeEquipments] BPE API error:", resp.status);
      setProviderError("bpe", `BPE API returned ${resp.status}`);
      return { ...empty, coverage: "error" as Coverage };
    }
    const data = await resp.json();
    const records = data.data || [];
    if (records.length === 0) {
      return { ...empty, coverage: "ok" as Coverage };
    }
    const equipmentMap = new Map<string, { count: number; minDist: number }>();
    for (const rec of records) {
      const code = rec.TYPEQU || rec.typequ || "";
      if (!code) continue;
      const eqLat = parseFloat(rec.LATITUDE || rec.latitude || "0");
      const eqLon = parseFloat(rec.LONGITUDE || rec.longitude || "0");
      let dist = radiusM;
      if (eqLat && eqLon) {
        dist = haversineDistance(lat, lon, eqLat, eqLon);
      }
      if (dist > radiusM) continue;
      const existing = equipmentMap.get(code);
      if (existing) {
        existing.count++;
        existing.minDist = Math.min(existing.minDist, dist);
      } else {
        equipmentMap.set(code, { count: 1, minDist: dist });
      }
    }
    const equipements: BpeEquipment[] = [];
    for (const [code, info] of equipmentMap) {
      equipements.push({
        code,
        label: getBpeLabel(code),
        count: info.count,
        nearest_distance_m: Math.round(info.minDist),
      });
    }
    equipements.sort((a, b) => (a.nearest_distance_m ?? Infinity) - (b.nearest_distance_m ?? Infinity));
    const totalEquipements = equipements.reduce((sum, e) => sum + e.count, 0);
    const commerces = equipements.filter((e) => e.code.startsWith("B"));
    const services = equipements.filter((e) => e.code.startsWith("A"));
    const sante = equipements.filter((e) => e.code.startsWith("D"));
    let score = 40;
    if (totalEquipements >= 50) score += 30;
    else if (totalEquipements >= 20) score += 20;
    else if (totalEquipements >= 10) score += 10;
    const hasEssentialCommerce = commerces.some((e) => CODES_COMMERCES_ESSENTIELS.has(e.code));
    if (hasEssentialCommerce) score += 15;
    const hasEssentialService = services.some((e) => CODES_SERVICES_ESSENTIELS.has(e.code));
    if (hasEssentialService) score += 10;
    const hasEssentialSante = sante.some((e) => CODES_SANTE_ESSENTIELS.has(e.code));
    if (hasEssentialSante) score += 5;
    score = Math.max(0, Math.min(100, score));
    return {
      total_equipements: totalEquipements,
      equipements: equipements.slice(0, 30),
      score,
      coverage: "ok" as Coverage,
      commerces: {
        count: commerces.reduce((s, e) => s + e.count, 0),
        essentiels_count: commerces.filter((e) => CODES_COMMERCES_ESSENTIELS.has(e.code)).reduce((s, e) => s + e.count, 0),
        score: hasEssentialCommerce ? 80 : 50,
        details: commerces.slice(0, 10),
      },
      services: {
        count: services.reduce((s, e) => s + e.count, 0),
        essentiels_count: services.filter((e) => CODES_SERVICES_ESSENTIELS.has(e.code)).reduce((s, e) => s + e.count, 0),
        score: hasEssentialService ? 80 : 50,
        details: services.slice(0, 10),
      },
      sante: {
        count: sante.reduce((s, e) => s + e.count, 0),
        essentiels_count: sante.filter((e) => CODES_SANTE_ESSENTIELS.has(e.code)).reduce((s, e) => s + e.count, 0),
        score: hasEssentialSante ? 80 : 50,
        details: sante.slice(0, 10),
      },
    };
  } catch (err) {
    console.error("[fetchBpeEquipments] Error:", err);
    setProviderError("bpe", String(err));
    return { ...empty, coverage: "error" as Coverage };
  }
}

// ----------------------------------------------------
// ECOLES FETCH
// ----------------------------------------------------
async function fetchEcoles(lat: number, lon: number, radiusM: number): Promise<EcolesStats> {
  const empty: EcolesStats = { total_ecoles: 0, ecoles: [], score: 0, coverage: "no_data" as Coverage };
  try {
    const query = `
      [out:json][timeout:15];
      (
        node["amenity"="school"](around:${radiusM},${lat},${lon});
        way["amenity"="school"](around:${radiusM},${lat},${lon});
        node["amenity"="kindergarten"](around:${radiusM},${lat},${lon});
        way["amenity"="kindergarten"](around:${radiusM},${lat},${lon});
        node["amenity"="college"](around:${radiusM},${lat},${lon});
        way["amenity"="college"](around:${radiusM},${lat},${lon});
      );
      out center;
    `;
    const resp = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!resp.ok) {
      return { ...empty, coverage: "error" as Coverage };
    }
    const data = await resp.json();
    const elements = data.elements || [];
    if (elements.length === 0) {
      return { ...empty, coverage: "ok" as Coverage, score: 30 };
    }
    const ecoles: EcoleInfo[] = [];
    for (const el of elements) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;
      const dist = haversineDistance(lat, lon, elLat, elLon);
      const type = el.tags?.amenity === "kindergarten" ? "maternelle" : el.tags?.amenity === "college" ? "college" : "ecole";
      ecoles.push({
        nom: el.tags?.name || `${type} sans nom`,
        type,
        distance_m: Math.round(dist),
        lat: elLat,
        lon: elLon,
      });
    }
    ecoles.sort((a, b) => a.distance_m - b.distance_m);
    let score = 50;
    if (ecoles.length >= 5) score += 25;
    else if (ecoles.length >= 3) score += 15;
    else if (ecoles.length >= 1) score += 5;
    const hasMaternelle = ecoles.some((e) => e.type === "maternelle");
    const hasCollege = ecoles.some((e) => e.type === "college");
    if (hasMaternelle) score += 10;
    if (hasCollege) score += 10;
    if (ecoles.length > 0 && ecoles[0].distance_m < 500) score += 5;
    score = Math.max(0, Math.min(100, score));
    return { total_ecoles: ecoles.length, ecoles: ecoles.slice(0, 15), score, coverage: "ok" as Coverage };
  } catch (err) {
    console.error("[fetchEcoles] Error:", err);
    return { ...empty, coverage: "error" as Coverage };
  }
}

// ----------------------------------------------------
// SENIOR/ETUDIANT/COMMERCE/HOTEL ENRICHMENT
// ----------------------------------------------------
async function enrichSenior(lat: number, lon: number, communeInsee: string | null): Promise<SeniorStats> {
  const empty: SeniorStats = { score: 0, coverage: "no_data" as Coverage };
  try {
    const ehpadData = await finessEhpadNearby(lat, lon, 10000);
    const ehpadList = ehpadData?.etablissements?.slice(0, 5).map((e: { nom: string; distance_m: number; capacite?: number }) => ({
      nom: e.nom,
      distance_m: e.distance_m,
      capacite: e.capacite ?? null,
    })) ?? [];
    let score = 50;
    if (ehpadList.length > 0) score += 20;
    if (ehpadList.length >= 3) score += 10;
    return { ehpad_nearby: ehpadList, score, coverage: "ok" as Coverage };
  } catch (err) {
    console.error("[enrichSenior] Error:", err);
    return { ...empty, coverage: "error" as Coverage };
  }
}

async function enrichEtudiant(lat: number, lon: number): Promise<EtudiantStats> {
  const empty: EtudiantStats = { universities_nearby: [], total_students_nearby: 0, score: 0, coverage: "no_data" as Coverage };
  try {
    const query = `
      [out:json][timeout:15];
      (
        node["amenity"="university"](around:5000,${lat},${lon});
        way["amenity"="university"](around:5000,${lat},${lon});
      );
      out center;
    `;
    const resp = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!resp.ok) {
      return { ...empty, coverage: "error" as Coverage };
    }
    const data = await resp.json();
    const elements = data.elements || [];
    const unis: UniversityInfo[] = [];
    for (const el of elements) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;
      const dist = haversineDistance(lat, lon, elLat, elLon);
      unis.push({
        nom: el.tags?.name || "Université",
        type: "university",
        distance_m: Math.round(dist),
      });
    }
    unis.sort((a, b) => a.distance_m - b.distance_m);
    let score = 40;
    if (unis.length >= 3) score += 35;
    else if (unis.length >= 1) score += 20;
    if (unis.length > 0 && unis[0].distance_m < 1000) score += 15;
    else if (unis.length > 0 && unis[0].distance_m < 2000) score += 10;
    score = Math.max(0, Math.min(100, score));
    return { universities_nearby: unis.slice(0, 10), total_students_nearby: 0, score, coverage: "ok" as Coverage };
  } catch (err) {
    console.error("[enrichEtudiant] Error:", err);
    return { ...empty, coverage: "error" as Coverage };
  }
}

async function enrichCommerce(_lat: number, _lon: number, _communeInsee: string | null): Promise<CommerceStats> {
  return { score: 50, coverage: "ok" as Coverage };
}

async function enrichHotel(_lat: number, _lon: number): Promise<HotelStats> {
  return { score: 50, coverage: "ok" as Coverage };
}

// ----------------------------------------------------
// MARKET STUDY HANDLER
// ----------------------------------------------------
async function handleMarketStudy(payload: Record<string, unknown>): Promise<MarketStudyResult> {
  resetProviderErrors();
  let lat: number, lon: number;
  const point = resolvePoint(payload);
  if (point) {
    lat = point.lat;
    lon = point.lon;
  } else if (typeof payload.address === "string") {
    const geo = await geocodeAddress(payload.address);
    if (!geo) throw new Error("Unable to geocode address");
    lat = geo.lat;
    lon = geo.lon;
  } else {
    throw new Error("Missing coordinates (lat/lon) or address");
  }
  const communeInfo = await fetchCommuneInfo(lat, lon);
  const projectType = normalizeProjectType(payload.project_nature as string | null);
  const isRural = communeInfo.is_rural;
  const config = getProjectConfig(projectType, isRural, 5, 24);
  const [dvf, insee, transport, bpe] = await Promise.all([
    communeInfo.departement ? fetchDvfStats(lat, lon, communeInfo.departement, config.dvf.radius_km, config.dvf.horizon_months, config.dvf.type_local) : Promise.resolve(null),
    communeInfo.code_insee ? fetchInseeStatsHybrid(communeInfo.code_insee, lat, lon) : Promise.resolve(null),
    fetchTransportScore(lat, lon, 1500, isInGrandeAgglomeration(communeInfo.code_insee)),
    fetchBpeEquipments(lat, lon, config.bpe.radius_m),
  ]);
  const demande: MarketStudyDemand = {
    population_zone: insee?.population ?? null,
    evolution_pop_5ans_pct: null,
    revenu_median: insee?.revenu_median ?? null,
    taux_proprietaires_pct: null,
    part_menages_1_2_pers_pct: null,
    score_demande: insee?.score ?? 50,
  };
  const offre: MarketStudyOffer = {
    nb_transactions_12m: dvf?.nb_transactions ?? 0,
    prix_m2_median: dvf?.prix_m2_median ?? null,
    evolution_prix_12m_pct: dvf?.evolution_prix_pct ?? null,
    stock_actif_estimation: null,
    delai_vente_moyen_jours: null,
    score_offre: scoreDvf(dvf),
  };
  const contexte: MarketStudyContext = {
    accessibilite_score: transport?.score ?? 50,
    services_score: bpe?.score ?? 50,
    qualite_vie_score: 50,
    dynamisme_eco_score: insee?.score ?? 50,
    score_contexte: Math.round(((transport?.score ?? 50) + (bpe?.score ?? 50) + (insee?.score ?? 50)) / 3),
  };
  const score_global = Math.round((demande.score_demande * 0.35 + offre.score_offre * 0.35 + contexte.score_contexte * 0.30));
  let recommandation: MarketStudyResult["recommandation"] = "neutre";
  if (score_global >= 80) recommandation = "tres_favorable";
  else if (score_global >= 65) recommandation = "favorable";
  else if (score_global >= 45) recommandation = "neutre";
  else if (score_global >= 30) recommandation = "defavorable";
  else recommandation = "tres_defavorable";
  const points_forts: string[] = [];
  const points_vigilance: string[] = [];
  if (demande.revenu_median && demande.revenu_median > 22000) points_forts.push("Revenus élevés dans la zone");
  if (demande.revenu_median && demande.revenu_median < 18000) points_vigilance.push("Revenus modestes dans la zone");
  if (offre.evolution_prix_12m_pct && offre.evolution_prix_12m_pct > 3) points_forts.push("Marché dynamique avec prix en hausse");
  if (offre.evolution_prix_12m_pct && offre.evolution_prix_12m_pct < -2) points_vigilance.push("Baisse des prix observée");
  if (contexte.accessibilite_score >= 70) points_forts.push("Bonne accessibilité transport");
  if (contexte.accessibilite_score < 40) points_vigilance.push("Accessibilité transport limitée");
  if (contexte.services_score >= 70) points_forts.push("Bonne offre de services");
  if (contexte.services_score < 40) points_vigilance.push("Services de proximité limités");
  return {
    lat,
    lon,
    commune_insee: communeInfo.code_insee,
    commune_nom: communeInfo.nom,
    departement: communeInfo.departement,
    code_postal: communeInfo.code_postal,
    is_rural: isRural,
    project_type: projectType,
    demande,
    offre,
    contexte,
    score_global,
    recommandation,
    points_forts,
    points_vigilance,
    debug: {
      envDebug: envDebugInfo,
      errors: Object.keys(providerErrors).length > 0 ? { ...providerErrors } : undefined,
    },
  };
}

// ----------------------------------------------------
// STANDARD ENRICHMENT HANDLER
// ----------------------------------------------------
async function handleStandard(payload: Record<string, unknown>): Promise<EnrichedResult> {
  resetProviderErrors();
  let lat: number, lon: number;
  const point = resolvePoint(payload);
  if (point) {
    lat = point.lat;
    lon = point.lon;
  } else if (typeof payload.address === "string") {
    const geo = await geocodeAddress(payload.address);
    if (!geo) throw new Error("Unable to geocode address");
    lat = geo.lat;
    lon = geo.lon;
  } else {
    throw new Error("Missing coordinates (lat/lon) or address");
  }
  const communeInfo = await fetchCommuneInfo(lat, lon);
  const projectType = normalizeProjectType(payload.project_nature as string | null);
  const payloadRadius = typeof payload.radius_km === "number" ? payload.radius_km : 5;
  const payloadHorizon = typeof payload.horizon_months === "number" ? payload.horizon_months : 24;
  const isRural = communeInfo.is_rural;
  const config = getProjectConfig(projectType, isRural, payloadRadius, payloadHorizon);
  const dept = communeInfo.departement || getDepartementFromInsee(communeInfo.code_insee);
  const isGrandeAgglo = isInGrandeAgglomeration(communeInfo.code_insee);
  const transportRadius = isGrandeAgglo ? 1000 : (isRural ? 5000 : 2000);
  const [dvf, transport, bpe, ecoles, sante, insee] = await Promise.all([
    dept ? fetchDvfStats(lat, lon, dept, config.dvf.radius_km, config.dvf.horizon_months, config.dvf.type_local) : Promise.resolve(null),
    fetchTransportScore(lat, lon, transportRadius, isGrandeAgglo),
    fetchBpeEquipments(lat, lon, config.bpe.radius_m),
    fetchEcoles(lat, lon, config.bpe.radius_m),
    communeInfo.code_insee ? fetchHealthFicheForCommune(communeInfo.code_insee) : Promise.resolve(null),
    communeInfo.code_insee ? fetchInseeStatsHybrid(communeInfo.code_insee, lat, lon) : Promise.resolve(null),
  ]);
  let etudiant: EtudiantStats | null = null;
  let senior: SeniorStats | null = null;
  let commerce: CommerceStats | null = null;
  let hotel: HotelStats | null = null;
  if (config.modules.enableStudent) {
    etudiant = await enrichEtudiant(lat, lon);
  }
  if (config.modules.enableSenior) {
    senior = await enrichSenior(lat, lon, communeInfo.code_insee);
  }
  if (config.modules.enableCommerce) {
    commerce = await enrichCommerce(lat, lon, communeInfo.code_insee);
  }
  if (config.modules.enableHotel) {
    hotel = await enrichHotel(lat, lon);
  }
  const hasTransport = transport && transport.coverage === "ok" && transport.stops.length > 0;
  const weights = hasTransport ? config.weights : config.weightsNoTransport;
  const { global: globalScore, details: scoreDetails } = computeGlobalScore(dvf, transport, bpe, ecoles, sante, insee, weights);
  const coverageSummary: Record<string, Coverage> = {
    dvf: dvf && dvf.nb_transactions > 0 ? "ok" : "no_data",
    transport: transport?.coverage ?? "no_data",
    bpe: bpe?.coverage ?? "no_data",
    ecoles: ecoles?.coverage ?? "no_data",
    sante: sante?.coverage ?? "no_data",
    insee: insee?.coverage ?? "no_data",
  };
  if (etudiant) coverageSummary.etudiant = etudiant.coverage;
  if (senior) coverageSummary.senior = senior.coverage;
  if (commerce) coverageSummary.commerce = commerce.coverage;
  if (hotel) coverageSummary.hotel = hotel.coverage;
  return {
    lat,
    lon,
    commune_insee: communeInfo.code_insee,
    commune_nom: communeInfo.nom,
    departement: communeInfo.departement,
    region: communeInfo.region,
    code_postal: communeInfo.code_postal,
    is_rural: isRural,
    project_type: projectType,
    project_config: config,
    dvf,
    transport,
    bpe,
    ecoles,
    sante,
    insee,
    etudiant,
    senior,
    commerce,
    hotel,
    global_score: globalScore,
    score_details: scoreDetails,
    coverage_summary: coverageSummary,
    debug: {
      dvf_params: { radius_km: config.dvf.radius_km, horizon_months: config.dvf.horizon_months, type_local: config.dvf.type_local, dept },
      bpe_params: { radius_m: config.bpe.radius_m },
      weights_used: weights,
      envDebug: envDebugInfo,
      errors: Object.keys(providerErrors).length > 0 ? { ...providerErrors } : undefined,
    },
  };
}

// ----------------------------------------------------
// MAIN SERVE
// ----------------------------------------------------
serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const payload = await req.json();
    const mode = (payload.mode as string) || "standard";
    let result: EnrichedResult | MarketStudyResult;
    if (mode === "market_study") {
      result = await handleMarketStudy(payload);
    } else {
      result = await handleStandard(payload);
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[smartscore-enriched-v3] Error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message, debug: { envDebug: envDebugInfo } }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});