// ===== PARTIE 1/6 =====
// supabase/functions/smartscore-enriched-v3/index.ts
// VERSION v3.24 - Project-aware Market Study + Robustesse
// CHANGELOG v3.24:
//    - NEW: CanonicalProjectType et normalizeProjectType()
//    - NEW: getProjectConfig() pour rayons/ponderations/modules par type de projet
//    - NEW: computeInseeScore() pour scoring INSEE contextualise
//    - NEW: computeMarketIndicesV2() avec ponderations configurables
//    - NEW: market.project_type, market.config, market.modules dans output
//    - FIX: G101 station-service traite correctement dans scoring BPE
//    - FIX: fixMojibakeText() pour corriger encodage latin1->utf8
//    - FIX: Labels MEDECIN_SPECIALITE_LABELS harmonises
//    - FIX: fetchBpeStats() - bpe-proxy source primaire, API tabular fallback

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as turf from "https://esm.sh/@turf/turf@6.5.0";

// Providers existants (FINESS + scoring)
import { finessEhpadNearby } from "../_shared/providers/finess.ts";
import { servicesProximiteV1 } from "../_shared/providers/services_proximite.ts";
import { weightedAverage } from "../_shared/providers/scoring.ts";
import type { Coverage } from "../_shared/providers/types.ts";

console.log("smartscore-enriched-v3 orchestrator loaded (v3.24 Project-aware)");

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
  "B101", "B102", "B104", "B105",
  "B201", "B202", "B207", "B208", "B210",
  "G101", // Station-service
  "D301", // Pharmacie
  "B203", "B204", "B205", "B206",
]);

const CODES_SERVICES_ESSENTIELS = new Set([
  "A203", "A204", // Banque / DAB
  "A206", "A207", "A208", // Poste
  "A101", "A104", // Police / Gendarmerie
]);

// v3.15: Sante MAX COVERAGE
const CODES_SANTE_ESSENTIELS = new Set([
  "D201", // Generaliste
  "D202", "D203", "D204", "D205", "D206", "D207", "D208", "D209", "D210", "D211",
  "D221", // Dentiste
  "D231", "D232", "D233", "D235", "D236", "D237", "D238", "D239", "D240", "D241",
  "D301", // Pharmacie
]);

// ----------------------------------------------------
// GRANDES AGGLOMERATIONS AVEC RESEAU TC SIGNIFICATIF
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
  "69279", "69281", "69282", "69283", "69284", "69286", "69290", "69291", "69292", "69293",
  "69296",
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
// v3.24: CANONICAL PROJECT TYPE
// ----------------------------------------------------
type CanonicalProjectType = 
  | "LOGEMENT" 
  | "COMMERCE" 
  | "BUREAUX" 
  | "HOTEL" 
  | "ETUDIANT" 
  | "RSS" 
  | "EHPAD";

function normalizeProjectType(projectNature: string | null | undefined): CanonicalProjectType {
  if (!projectNature) return "LOGEMENT";
  
  const normalized = projectNature
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  
  if (normalized === "logement" || normalized === "habitation" || normalized === "residential") {
    return "LOGEMENT";
  }
  if (normalized === "commerce" || normalized === "retail" || normalized === "boutique") {
    return "COMMERCE";
  }
  if (normalized === "bureaux" || normalized === "bureau" || normalized === "office" || normalized === "offices") {
    return "BUREAUX";
  }
  if (normalized === "hotel" || normalized === "hotellerie" || normalized === "hospitality") {
    return "HOTEL";
  }
  if (
    normalized === "residence_etudiante" || 
    normalized === "etudiant" || 
    normalized === "residence etudiante" ||
    normalized === "student" ||
    normalized === "etudiants"
  ) {
    return "ETUDIANT";
  }
  if (
    normalized === "residence_senior" || 
    normalized === "senior" || 
    normalized === "rss" ||
    normalized === "residence senior" ||
    normalized === "residence seniors" ||
    normalized === "residence autonomie"
  ) {
    return "RSS";
  }
  if (normalized === "ehpad" || normalized === "maison de retraite" || normalized === "nursing home") {
    return "EHPAD";
  }
  
  if (normalized.includes("etudiant") || normalized.includes("student")) return "ETUDIANT";
  if (normalized.includes("senior") || normalized.includes("rss")) return "RSS";
  if (normalized.includes("ehpad") || normalized.includes("retraite")) return "EHPAD";
  if (normalized.includes("hotel")) return "HOTEL";
  if (normalized.includes("bureau") || normalized.includes("office")) return "BUREAUX";
  if (normalized.includes("commerce") || normalized.includes("boutique") || normalized.includes("magasin")) return "COMMERCE";
  if (normalized.includes("logement") || normalized.includes("appartement") || normalized.includes("maison")) return "LOGEMENT";
  
  return "LOGEMENT";
}

// ----------------------------------------------------
// v3.24: PROJECT CONFIG TYPE
// ----------------------------------------------------
type ProjectWeights = {
  dvf: number;
  transport: number;
  bpe: number;
  ecoles: number;
  sante: number;
  insee: number;
};

type ProjectConfig = {
  projectType: CanonicalProjectType;
  dvf: {
    radius_km: number;
    horizon_months: number;
    type_local: string | null;
  };
  bpe: {
    radius_m: number;
    essential_radius_m: number;
  };
  weights: ProjectWeights;
  weightsNoTransport: ProjectWeights;
  modules: {
    enableSenior: boolean;
    enableStudent: boolean;
    enableCommerce: boolean;
    enableHotel: boolean;
  };
  notes: string[];
};

function getProjectConfig(
  projectType: CanonicalProjectType,
  isRural: boolean,
  payloadRadiusKm: number,
  payloadHorizonMonths: number
): ProjectConfig {
  const clampRadius = (min: number, max: number, val: number) => Math.max(min, Math.min(max, val));
  const clampMonths = (min: number, max: number, val: number) => Math.max(min, Math.min(max, val));
  
  const baseBpeRadius = isRural ? RAYON_RURAL_MIN_M : RAYON_URBAIN_M;
  const baseEssentialRadius = isRural ? RAYON_RURAL_MAX_M : RAYON_URBAIN_M;
  
  switch (projectType) {
    case "LOGEMENT":
      return {
        projectType,
        dvf: {
          radius_km: clampRadius(1, isRural ? 20 : 5, payloadRadiusKm),
          horizon_months: clampMonths(12, 36, payloadHorizonMonths),
          type_local: null,
        },
        bpe: { radius_m: baseBpeRadius, essential_radius_m: baseEssentialRadius },
        weights: { dvf: 0.35, transport: 0.20, bpe: 0.20, ecoles: 0.15, sante: 0.10, insee: 0 },
        weightsNoTransport: { dvf: 0.40, transport: 0, bpe: 0.25, ecoles: 0.20, sante: 0.15, insee: 0 },
        modules: { enableSenior: false, enableStudent: false, enableCommerce: false, enableHotel: false },
        notes: ["Projet logement standard"],
      };
      
    case "COMMERCE":
      return {
        projectType,
        dvf: {
          radius_km: clampRadius(1, isRural ? 15 : 3, payloadRadiusKm),
          horizon_months: clampMonths(12, 24, payloadHorizonMonths),
          type_local: "Local",
        },
        bpe: { radius_m: isRural ? baseBpeRadius : 800, essential_radius_m: baseEssentialRadius },
        weights: { dvf: 0.20, transport: 0.30, bpe: 0.35, ecoles: 0, sante: 0, insee: 0.15 },
        weightsNoTransport: { dvf: 0.25, transport: 0, bpe: 0.45, ecoles: 0, sante: 0, insee: 0.30 },
        modules: { enableSenior: false, enableStudent: false, enableCommerce: true, enableHotel: false },
        notes: ["Projet commerce - focus flux et accessibilite", "INSEE: revenu_median, taux_pauvrete"],
      };
      
    case "BUREAUX":
      return {
        projectType,
        dvf: {
          radius_km: clampRadius(1, isRural ? 10 : 3, payloadRadiusKm),
          horizon_months: clampMonths(12, 36, payloadHorizonMonths),
          type_local: "Local",
        },
        bpe: { radius_m: baseBpeRadius, essential_radius_m: baseEssentialRadius },
        weights: { dvf: 0.25, transport: 0.35, bpe: 0.20, ecoles: 0, sante: 0, insee: 0.20 },
        weightsNoTransport: { dvf: 0.35, transport: 0, bpe: 0.35, ecoles: 0, sante: 0, insee: 0.30 },
        modules: { enableSenior: false, enableStudent: false, enableCommerce: false, enableHotel: false },
        notes: ["Projet bureaux - transport critique", "INSEE: taux_chomage, revenu"],
      };
      
    case "HOTEL":
      return {
        projectType,
        dvf: {
          radius_km: clampRadius(1, isRural ? 10 : 3, payloadRadiusKm),
          horizon_months: clampMonths(12, 24, payloadHorizonMonths),
          type_local: "Local",
        },
        bpe: { radius_m: isRural ? baseBpeRadius : 1000, essential_radius_m: baseEssentialRadius },
        weights: { dvf: 0.20, transport: 0.25, bpe: 0.25, ecoles: 0, sante: 0.10, insee: 0.20 },
        weightsNoTransport: { dvf: 0.30, transport: 0, bpe: 0.35, ecoles: 0, sante: 0.15, insee: 0.20 },
        modules: { enableSenior: false, enableStudent: false, enableCommerce: false, enableHotel: true },
        notes: ["Projet hotel - accessibilite et services"],
      };
      
    case "ETUDIANT":
      return {
        projectType,
        dvf: {
          radius_km: clampRadius(1, isRural ? 10 : 3, payloadRadiusKm),
          horizon_months: clampMonths(12, 24, payloadHorizonMonths),
          type_local: "Appartement",
        },
        bpe: { radius_m: baseBpeRadius, essential_radius_m: baseEssentialRadius },
        weights: { dvf: 0.20, transport: 0.30, bpe: 0.25, ecoles: 0.25, sante: 0, insee: 0 },
        weightsNoTransport: { dvf: 0.25, transport: 0, bpe: 0.35, ecoles: 0.40, sante: 0, insee: 0 },
        modules: { enableSenior: false, enableStudent: true, enableCommerce: false, enableHotel: false },
        notes: ["Projet etudiant - ecoles et transport critiques"],
      };
      
    case "RSS":
    case "EHPAD":
      return {
        projectType,
        dvf: {
          radius_km: clampRadius(3, isRural ? 20 : 10, Math.max(payloadRadiusKm, 3)),
          horizon_months: clampMonths(24, 36, Math.max(payloadHorizonMonths, 24)),
          type_local: projectType === "EHPAD" ? "Local" : "Appartement",
        },
        bpe: { radius_m: isRural ? RAYON_RURAL_MIN_M : 1000, essential_radius_m: baseEssentialRadius },
        weights: { dvf: 0.10, transport: 0.10, bpe: 0.20, ecoles: 0, sante: 0.30, insee: 0.30 },
        weightsNoTransport: { dvf: 0.15, transport: 0, bpe: 0.25, ecoles: 0, sante: 0.30, insee: 0.30 },
        modules: { enableSenior: true, enableStudent: false, enableCommerce: false, enableHotel: false },
        notes: [
          "Projet " + projectType + " - focus seniors",
          "INSEE: pct_plus_65, pension_retraite_moyenne, taux_chomage",
          "Sante critique: medecins, pharmacies, hopital"
        ],
      };
      
    default:
      return getProjectConfig("LOGEMENT", isRural, payloadRadiusKm, payloadHorizonMonths);
  }
}
// ===== PARTIE 2/6 =====

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

type InseeHybridData = {
  code_commune: string;
  commune?: string | null;
  population?: number | null;
  pct_moins_25?: number | null;
  pct_plus_65?: number | null;
  densite_pop?: number | null;
  revenu_median?: number | null;
  taux_pauvrete?: number | null;
  pct_proprietaires?: number | null;
  pension_retraite_moyenne?: number | null;
  taux_chomage?: number | null;
  nb_menages?: number | null;
  nb_logements?: number | null;
  source_comparateur?: boolean;
  [key: string]: unknown;
};

type InseeSocioEcoDebug = {
  ok: boolean;
  source: string;
  commune_insee: string;
  found: boolean;
  fields_present: string[];
  error: string | null;
};

type SeniorModule = {
  pct_plus_65: number | null;
  pension_retraite_moyenne: number | null;
  professionnels_sante: ProfessionnelsSanteDetails | null;
  ehpad_count: number;
  residences_seniors_count: number;
  hopital_distance_km: number | null;
  senior_demand_score: number | null;
  competition_score: number | null;
};

type StudentModule = {
  ecoles_count_1km: number;
  ecoles_nearest_distance_m: number | null;
  transport_score: number | null;
  student_accessibility_score: number | null;
};

type CommerceModule = {
  commerces_count: number;
  commerce_alimentaire_count: number;
  revenu_median: number | null;
  taux_pauvrete: number | null;
  flux_score: number | null;
};

type HotelModule = {
  transport_score: number | null;
  services_count: number;
  accessibility_score: number | null;
};

type ProjectModules = {
  senior?: SeniorModule;
  etudiant?: StudentModule;
  commerce?: CommerceModule;
  hotel?: HotelModule;
};

type UsedConfig = {
  dvf_radius_km: number;
  dvf_horizon_months: number;
  bpe_radius_m: number;
  essential_radius_m: number;
  weights_used: ProjectWeights;
  transport_applicable: boolean;
};

// ----------------------------------------------------
// MAPPINGS BPE UNIFIES (v3.24 - sans accents pour eviter mojibake)
// ----------------------------------------------------
const ESSENTIAL_BUCKET_BY_TYPE_CODE: Record<string, EssentialServiceBucket> = {
  D301: "pharmacie",
  D201: "medecin_generaliste",
  D202: "medecin_specialiste", D203: "medecin_specialiste", D204: "medecin_specialiste",
  D205: "medecin_specialiste", D206: "medecin_specialiste", D207: "medecin_specialiste",
  D208: "medecin_specialiste", D209: "medecin_specialiste", D210: "medecin_specialiste",
  D211: "medecin_specialiste",
  D221: "dentiste",
  D231: "infirmier", D232: "infirmier",
  D233: "kinesitherapeute", D235: "kinesitherapeute", D236: "kinesitherapeute",
  D237: "kinesitherapeute", D238: "kinesitherapeute", D239: "kinesitherapeute",
  D240: "kinesitherapeute", D241: "kinesitherapeute",
  A203: "banque_dab", A204: "banque_dab",
  A206: "poste", A207: "poste", A208: "poste",
  A101: "commissariat", A104: "gendarmerie",
  G101: "station_service",
  B101: "commerce_alimentaire", B104: "commerce_alimentaire", B102: "commerce_alimentaire",
  B105: "commerce_alimentaire", B201: "commerce_alimentaire", B208: "commerce_alimentaire",
  B202: "commerce_alimentaire", B207: "commerce_alimentaire", B210: "commerce_alimentaire",
  B203: "commerce_alimentaire", B204: "commerce_alimentaire", B205: "commerce_alimentaire",
  B206: "commerce_alimentaire",
};

const DOMAINE_MAP: Record<string, string> = {
  A: "services", B: "commerces", C: "enseignement", D: "sante",
  E: "transport", F: "sport_culture", G: "tourisme",
};

function getEffectiveDomaine(typeCode: string): string {
  if (typeCode === "G101") return "services";
  const domaine = typeCode.charAt(0);
  return DOMAINE_MAP[domaine] || "autre";
}

const SANTE_TYPE_MAP: Record<string, string> = {
  D201: "medecin_generaliste",
  D202: "medecin_specialiste", D203: "medecin_specialiste", D204: "medecin_specialiste",
  D205: "medecin_specialiste", D206: "medecin_specialiste", D207: "medecin_specialiste",
  D208: "medecin_specialiste", D209: "medecin_specialiste", D210: "medecin_specialiste",
  D211: "medecin_specialiste",
  D221: "dentiste",
  D231: "infirmier", D232: "infirmier",
  D233: "kinesitherapeute", D235: "kinesitherapeute", D236: "kinesitherapeute",
  D237: "kinesitherapeute", D238: "kinesitherapeute", D239: "kinesitherapeute",
  D240: "kinesitherapeute", D241: "kinesitherapeute",
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

const COMMERCE_TYPE_LABELS: Record<string, string> = {
  B101: "Hypermarche", B102: "Supermarche", B103: "Grande surface de bricolage",
  B104: "Hypermarche", B105: "Supermarche", B201: "Superette", B202: "Epicerie",
  B203: "Boulangerie", B204: "Boucherie charcuterie", B205: "Produits surgeles",
  B206: "Poissonnerie", B207: "Epicerie", B208: "Superette", B210: "Commerce alimentaire",
  B301: "Librairie papeterie journaux", B302: "Magasin de vetements",
  B303: "Magasin d'equipements du foyer", B304: "Magasin de chaussures",
  B305: "Magasin d'electromenager", B306: "Magasin de meubles",
  B307: "Magasin d'articles de sports", B308: "Droguerie quincaillerie bricolage",
  B309: "Parfumerie", B310: "Horlogerie Bijouterie", B311: "Fleuriste",
  B312: "Magasin d'optique", G101: "Station service",
};

const MEDECIN_SPECIALITE_LABELS: Record<string, string> = {
  D201: "Medecin generaliste", D202: "Specialiste en cardiologie",
  D203: "Specialiste en dermatologie", D204: "Specialiste en gastro-enterologie",
  D205: "Specialiste en psychiatrie", D206: "Specialiste en ophtalmologie",
  D207: "Specialiste en ORL", D208: "Specialiste en pediatrie",
  D209: "Specialiste en radiologie", D210: "Specialiste en gynecologie medicale",
  D211: "Specialiste en gynecologie obstetrique", D221: "Chirurgien-dentiste",
  D231: "Sage-femme", D232: "Infirmier", D233: "Masseur kinesitherapeute",
  D235: "Orthophoniste", D236: "Orthoptiste", D237: "Pedicure-podologue",
  D238: "Audio prothesiste", D239: "Ergotherapeute", D240: "Psychomotricien",
  D241: "Dieteticien", D301: "Pharmacie", D302: "Laboratoire d'analyses medicales",
  D303: "Ambulance", D307: "Transfusion sanguine", D310: "Maison de sante pluridisciplinaire",
};

const SERVICE_TYPE_LABELS: Record<string, string> = {
  A101: "Commissariat de police", A104: "Gendarmerie", A203: "Banque",
  A204: "DAB (distributeur automatique)", A206: "Bureau de poste",
  A207: "Relais poste", A208: "Agence postale communale", G101: "Station service",
};

const FORCE_TYPE_LABEL_CODES = new Set(["G101"]);

const ALL_ESSENTIAL_BUCKETS: EssentialServiceBucket[] = [
  "pharmacie", "banque_dab", "poste", "station_service", "commerce_alimentaire",
  "medecin_generaliste", "medecin_specialiste", "dentiste", "infirmier",
  "kinesitherapeute", "gendarmerie", "commissariat",
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
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function metersToKm(m: number): number {
  return Math.round(m / 100) / 10;
}

function normalizeTextForSearch(text: string | null | undefined): string {
  if (!text) return "";
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// FIX: fixMojibakeText retourne toujours string, "" si null/undefined
function fixMojibakeText(text: string | null | undefined): string {
  if (text == null) return "";
  if (typeof text !== "string") return String(text);
  if (text.trim() === "") return text;
  
  const replacements: Array<[RegExp, string]> = [
    [/Ã©/g, "e"], [/Ã¨/g, "e"], [/Ãª/g, "e"], [/Ã«/g, "e"],
    [/Ã /g, "a"], [/Ã¢/g, "a"], [/Ã¤/g, "a"],
    [/Ã¹/g, "u"], [/Ã»/g, "u"], [/Ã¼/g, "u"],
    [/Ã®/g, "i"], [/Ã¯/g, "i"],
    [/Ã´/g, "o"], [/Ã¶/g, "o"],
    [/Ã§/g, "c"], [/Å"/g, "oe"], [/Ã¦/g, "ae"],
    [/Ã‰/g, "E"], [/Ãˆ/g, "E"], [/Ã€/g, "A"], [/Ã‡/g, "C"], [/Ã"/g, "O"],
    [/â€™/g, "'"], [/â€"/g, "-"], [/â€œ/g, '"'],
  ];
  
  let result = text;
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function computeIndex(value: number | null, min: number, max: number, invert = false): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (max === min) return 50;
  const clamped = Math.max(min, Math.min(max, value));
  const normalized = (clamped - min) / (max - min);
  const score = Math.round((invert ? 1 - normalized : normalized) * 100);
  return Math.max(0, Math.min(100, score));
}

function computeInseeScore(inseeData: InseeHybridData | null, projectType: CanonicalProjectType): number | null {
  if (!inseeData) return null;
  
  const scores: Array<{ w: number; v: number | null }> = [];
  
  switch (projectType) {
    case "LOGEMENT": {
      const chomage = computeIndex(inseeData.taux_chomage ?? null, 3, 15, true);
      const pauvrete = computeIndex(inseeData.taux_pauvrete ?? null, 5, 30, true);
      const proprio = computeIndex(inseeData.pct_proprietaires ?? null, 30, 80, false);
      if (chomage != null) scores.push({ w: 0.4, v: chomage });
      if (pauvrete != null) scores.push({ w: 0.3, v: pauvrete });
      if (proprio != null) scores.push({ w: 0.3, v: proprio });
      break;
    }
    case "COMMERCE": {
      const revenu = computeIndex(inseeData.revenu_median ?? null, 15000, 45000, false);
      const pauvrete = computeIndex(inseeData.taux_pauvrete ?? null, 5, 30, true);
      if (revenu != null) scores.push({ w: 0.6, v: revenu });
      if (pauvrete != null) scores.push({ w: 0.4, v: pauvrete });
      break;
    }
    case "BUREAUX": {
      const revenu = computeIndex(inseeData.revenu_median ?? null, 18000, 50000, false);
      const chomage = computeIndex(inseeData.taux_chomage ?? null, 3, 15, true);
      if (revenu != null) scores.push({ w: 0.5, v: revenu });
      if (chomage != null) scores.push({ w: 0.5, v: chomage });
      break;
    }
    case "HOTEL": {
      const revenu = computeIndex(inseeData.revenu_median ?? null, 18000, 45000, false);
      const proprio = computeIndex(inseeData.pct_proprietaires ?? null, 30, 80, true);
      if (revenu != null) scores.push({ w: 0.6, v: revenu });
      if (proprio != null) scores.push({ w: 0.4, v: proprio });
      break;
    }
    case "ETUDIANT": {
      const jeunes = computeIndex(inseeData.pct_moins_25 ?? null, 15, 40, false);
      if (jeunes != null) scores.push({ w: 1.0, v: jeunes });
      break;
    }
    case "RSS":
    case "EHPAD": {
      const seniors = computeIndex(inseeData.pct_plus_65 ?? null, 10, 35, false);
      const pension = computeIndex(inseeData.pension_retraite_moyenne ?? null, 1000, 2500, false);
      const chomage = computeIndex(inseeData.taux_chomage ?? null, 3, 15, true);
      if (seniors != null) scores.push({ w: 0.5, v: seniors });
      if (pension != null) scores.push({ w: 0.3, v: pension });
      if (chomage != null) scores.push({ w: 0.2, v: chomage });
      break;
    }
    default:
      return null;
  }
  
  if (scores.length === 0) return null;
  const result = weightedAverage(scores);
  return result != null ? Math.round(result) : null;
}

// ----------------------------------------------------
// CACHE UNIVERSEL (table api_cache)
// ----------------------------------------------------
async function getFromCache(cacheKey: string): Promise<unknown | null> {
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
        .update({ hit_count: ((data as Record<string, unknown>).hit_count as number ?? 0) + 1 })
        .eq("cache_key", cacheKey)
        .then(() => {});
      return data.data;
    }
  } catch (e) {
    console.warn("Cache read error:", e);
  }
  return null;
}

async function saveToCache(cacheKey: string, provider: string, data: unknown, ttlSeconds: number): Promise<void> {
  if (!supabase) return;
  try {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await supabase
      .from("api_cache")
      .upsert({ cache_key: cacheKey, provider, data, expires_at: expiresAt, hit_count: 0 }, { onConflict: "cache_key" });
  } catch (e) {
    console.warn("Cache write error:", e);
  }
}
// ===== PARTIE 3/6 =====

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

// ----------------------------------------------------
// CADASTRE NATIONAL (hors IDF) via API Carto
// ----------------------------------------------------
function isIdfDepFromInsee(communeInsee: string | null): boolean {
  if (!communeInsee || communeInsee.length < 2) return false;
  const dep = communeInsee.slice(0, 2);
  return ["75", "77", "78", "91", "92", "93", "94", "95"].includes(dep);
}

function parseParcelIdu(idu: string): { code_insee: string | null; com_abs: string | null; section: string | null; numero: string | null } {
  const s = (idu ?? "").trim();
  if (!s) return { code_insee: null, com_abs: null, section: null, numero: null };
  if (s.length >= 14) {
    return { code_insee: s.slice(0, 5), com_abs: s.slice(5, 8), section: s.slice(8, 10), numero: s.slice(10, 14) };
  }
  return {
    code_insee: s.length >= 5 ? s.slice(0, 5) : null,
    com_abs: s.length >= 8 ? s.slice(5, 8) : null,
    section: s.length >= 10 ? s.slice(8, 10) : null,
    numero: s.length >= 14 ? s.slice(10, 14) : null,
  };
}

type CadastreFetchDebug = { url?: string; status?: number; ok?: boolean; numberReturned?: number | null; error?: string | null };

async function fetchParcelFromApiCarto(idu: string, communeInseeHint?: string | null, debug = false): Promise<{ point: ResolvedPoint | null; dbg: CadastreFetchDebug }> {
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

  const url = "https://apicarto.ign.fr/api/cadastre/parcelle?code_insee=" + encodeURIComponent(code_insee) +
    "&section=" + encodeURIComponent(section) + "&numero=" + encodeURIComponent(numero) +
    "&com_abs=" + encodeURIComponent(com_abs) + "&_limit=1";

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

    dbg.numberReturned = numOrNull((json as Record<string, unknown>).numberReturned) ?? null;
    const features = (json as Record<string, unknown>).features;
    const feature = Array.isArray(features) && features.length > 0 ? features[0] : null;

    if (!feature?.geometry) {
      dbg.error = "no feature.geometry";
      return { point: null, dbg };
    }

    const centroid = turf.centroid(feature as turf.helpers.Feature);
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
    try { surface_m2 = turf.area(feature as turf.helpers.Feature); } catch { surface_m2 = null; }

    return {
      point: { lat, lon, source: "parcel", parcel_id: idu, commune_insee: code_insee, surface_m2: surface_m2 ?? undefined },
      dbg,
    };
  } catch (e) {
    dbg.error = "fetch exception: " + String(e);
    return { point: null, dbg };
  }
}

async function resolvePointFromParcelId(parcelId: string, communeInsee?: string | number | null, debug = false): Promise<{ point: ResolvedPoint | null; cadastreDebug?: CadastreFetchDebug; rpcDebug?: Record<string, unknown> }> {
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
    return await supabase.rpc("get_parcelle_centroid", { p_parcel_id: parcelId, p_commune_insee: comm });
  };

  let { data, error } = await tryRpc(communeInsee?.toString() ?? null);
  if (!error && (!Array.isArray(data) || data.length === 0)) {
    ({ data, error } = await tryRpc(null));
  }

  if (error) {
    console.error("RPC get_parcelle_centroid error:", error);
    return { point: null, rpcDebug: { error: error.message } };
  }

  if (Array.isArray(data) && data.length > 0) {
    const row = data[0] as Record<string, unknown>;
    const rLat = numOrNull(row.lat);
    const rLon = numOrNull(row.lon);
    if (rLat != null && rLon != null) {
      return {
        point: { lat: rLat, lon: rLon, source: "parcel", parcel_id: parcelId, commune_insee: safeToString(row.commune_insee) ?? communeInsee?.toString() ?? undefined, surface_m2: numOrNull(row.surface_m2) ?? undefined },
        rpcDebug: { row },
      };
    }
  }
  return { point: null, rpcDebug: { data_len: Array.isArray(data) ? data.length : null } };
}

async function resolveAnalysisPoint(payload: MarketStudyPayload): Promise<{ point: ResolvedPoint | null; error: string | null; inseeMeta?: Record<string, unknown>; debugResolve?: Record<string, unknown> }> {
  const { parcel_id, commune_insee, lat, lon, debug } = payload;

  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    console.log("Point resolu depuis payload lat/lon");
    return { point: { lat, lon, source: "payload", parcel_id: parcel_id ?? undefined, commune_insee: commune_insee?.toString() }, error: null };
  }

  if (parcel_id) {
    console.log("Resolution point via parcel_id:", parcel_id);
    const res = await resolvePointFromParcelId(parcel_id, commune_insee ?? null, !!debug);
    if (res.point) {
      console.log("Point resolu depuis parcelle:", res.point.lat, res.point.lon);
      return { point: res.point, error: null };
    }
    if (debug) {
      return { point: null, error: "Parcelle non resolue", debugResolve: { parcel_id, commune_insee: commune_insee?.toString() ?? null, cadastre: res.cadastreDebug, rpc: res.rpcDebug } };
    }
  }

  if (supabase && commune_insee) {
    const { data: inseeData } = await supabase.from("insee_communes_stats").select("*").eq("code_commune", commune_insee.toString()).limit(1).maybeSingle();
    if (inseeData) {
      return { point: null, error: "Coordonnees absentes pour cette commune.", inseeMeta: inseeData as Record<string, unknown> };
    }
  }

  return { point: null, error: "Impossible de resoudre le point d'analyse. Fournir lat/lon, parcel_id ou commune_insee valide." };
}

async function resolveStandardPoint(payload: StandardPayload): Promise<{ point: ResolvedPoint | null; error: string | null; debugResolve?: Record<string, unknown> }> {
  const { parcel_id, commune_insee, commune_code, lat, lon, debug } = payload;

  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    console.log("[Standard] Point resolu depuis payload lat/lon");
    return { point: { lat, lon, source: "payload", parcel_id: parcel_id ?? undefined, commune_insee: commune_insee?.toString() ?? commune_code ?? undefined }, error: null };
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
  kpis: { n: number; median_price_m2: number | null; avg_price_m2: number | null; q1_price_m2: number | null; q3_price_m2: number | null };
  comps: MarketComp[];
};

function getDvfCacheKey(communeInsee: string | null, lat: number, lon: number, months: number, typeLocal: string | null): string {
  const key = communeInsee ?? (String(Math.round(lat * 100)) + "_" + String(Math.round(lon * 100)));
  return "dvf:" + key + ":" + String(months) + ":" + (typeLocal || "all");
}

async function dvfMarketKpis(params: { lat: number; lon: number; radius_m?: number; horizon_months?: number; type_local?: string | null; commune_insee?: string | null; ttl_seconds?: number; debug?: boolean }): Promise<DvfApiResult> {
  const { lat, lon, radius_m = 2000, horizon_months = 24, type_local = null, commune_insee = null, ttl_seconds = 86400, debug = false } = params;

  const cacheKey = getDvfCacheKey(commune_insee, lat, lon, horizon_months, type_local);
  const cached = await getFromCache(cacheKey);
  if (cached) {
    if (debug) console.log("DVF from cache");
    return { ...(cached as DvfApiResult), source: "cache" };
  }

  let codeCommune = commune_insee;
  let nomCommune: string | null = null;
  
  if (!codeCommune) {
    try {
      const geoResp = await fetch(GEO_API_BASE + "/communes?lat=" + String(lat) + "&lon=" + String(lon) + "&fields=code,nom&limit=1");
      if (geoResp.ok) {
        const communes = await geoResp.json() as Array<{ code: string; nom: string }>;
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
        const communeData = await geoResp.json() as { nom: string };
        nomCommune = communeData.nom;
      }
    } catch { /* ignore */ }
  }

  if (!codeCommune) {
    return { provider: "dvf", source: "csv", coverage: "not_covered", reason: "Impossible de determiner le code commune", kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null }, comps: [] };
  }

  const dep = codeCommune.slice(0, 2);
  const dateLimit = new Date();
  dateLimit.setMonth(dateLimit.getMonth() - horizon_months);
  const dateLimitStr = dateLimit.toISOString().split("T")[0];

  const currentYear = new Date().getFullYear();
  const yearsToFetch: number[] = [];
  for (let y = currentYear; y >= currentYear - 3 && y >= 2019; y--) { yearsToFetch.push(y); }

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
    return { provider: "dvf", source: "csv", coverage: "no_data", reason: "Aucune donnee DVF trouvee pour " + codeCommune, kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null }, comps: [] };
  }

  const transactions: Array<{ price_m2: number; valeur: number; surface: number; record: Record<string, unknown> }> = [];
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
      price_m2: Math.round(valeur / surface), valeur, surface,
      record: { id: idMutation, date_mutation: dateMutation, adresse: [row.adresse_numero, row.adresse_suffixe, row.adresse_nom_voie].filter(Boolean).join(" ") || null, type_local: rowTypeLocal, latitude: tLat || null, longitude: tLon || null, distance_m, nom_commune: row.nom_commune || nomCommune || null },
    });
  }

  transactions.sort((a, b) => ((b.record.date_mutation as string) || "").localeCompare((a.record.date_mutation as string) || ""));
  const prices = transactions.map(t => t.price_m2).sort((a, b) => a - b);
  const n = prices.length;

  let median_price_m2: number | null = null, avg_price_m2: number | null = null, q1_price_m2: number | null = null, q3_price_m2: number | null = null;
  if (n > 0) {
    median_price_m2 = prices[Math.floor(n / 2)];
    avg_price_m2 = Math.round(prices.reduce((a, b) => a + b, 0) / n);
    q1_price_m2 = prices[Math.floor(n * 0.25)];
    q3_price_m2 = prices[Math.floor(n * 0.75)];
  }

  const comps: MarketComp[] = transactions.slice(0, 20).map((t, idx) => ({
    id: (t.record.id as string) || String(idx), address: (t.record.adresse as string) ?? undefined, price_m2: t.price_m2, surface_m2: t.surface, date: (t.record.date_mutation as string) ?? undefined, type_local: (t.record.type_local as string) ?? undefined, distance_m: t.record.distance_m as number | undefined, commune: (t.record.nom_commune as string) ?? nomCommune ?? undefined,
  }));

  const result: DvfApiResult = { provider: "dvf", source: "csv:" + csvSources.join(","), coverage: n > 0 ? "ok" : "no_data", kpis: { n, median_price_m2, avg_price_m2, q1_price_m2, q3_price_m2 }, comps };
  await saveToCache(cacheKey, "dvf", result, ttl_seconds);
  if (debug) console.log("DVF result:", result.kpis);
  return result;
}

function unwrapRpcSingleRow(data: unknown): Record<string, unknown> | null {
  if (!data) return null;
  if (Array.isArray(data)) return data.length > 0 ? data[0] as Record<string, unknown> : null;
  return data as Record<string, unknown>;
}

async function fetchDvfMarketStatsRpc(point: ResolvedPoint, radiusKm: number, months: number, typeLocal: string | null): Promise<{ stats: DvfMarketStats | null; comps: MarketComp[]; error: string | null }> {
  if (!supabase) return { stats: null, comps: [], error: "Supabase non initialise" };
  const radiusM = Math.round(radiusKm * 1000);
  console.log("Fallback -> RPC get_dvf_market_stats_radius");

  try {
    let statsData: unknown = null;
    let statsError: { message?: string } | null = null;

    const attempt1 = await supabase.rpc("get_dvf_market_stats_radius", { p_lat: point.lat, p_lon: point.lon, p_months: months, p_radius_m: radiusM, p_type_local: typeLocal });
    if (attempt1.error) {
      const attempt2 = await supabase.rpc("get_dvf_market_stats_radius", { p_lat: point.lat, p_lon: point.lon, p_radius_m: radiusM, p_months: months, p_type_local: typeLocal });
      if (attempt2.error) { statsError = attempt2.error; } else { statsData = attempt2.data; }
    } else { statsData = attempt1.data; }

    if (statsError) return { stats: null, comps: [], error: statsError.message ?? String(statsError) };

    const row = unwrapRpcSingleRow(statsData);
    const rawStats = row?.stats ? row.stats as Record<string, unknown> : row;
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

    const { data: compsData } = await supabase.rpc("get_dvf_comps_radius", { p_lat: point.lat, p_lon: point.lon, p_radius_m: Math.min(radiusM, 1500), p_months: Math.min(months, 12), p_type_local: typeLocal, p_limit: 15 });
    let comps: MarketComp[] = [];
    if (Array.isArray(compsData)) {
      comps = compsData.map((c: Record<string, unknown>, idx: number) => ({ id: safeToString(c.id) ?? String(idx), address: safeToString(c.adresse) ?? undefined, price_m2: numOrNull(c.price_m2) ?? undefined, surface_m2: numOrNull(c.surface_m2) ?? undefined, date: safeToString(c.date_mutation) ?? undefined, type_local: safeToString(c.type_local) ?? undefined, distance_m: numOrNull(c.distance_m) ?? undefined, commune: safeToString(c.commune) ?? undefined }));
    }
    return { stats, comps, error: null };
  } catch (e) {
    console.error("fetchDvfMarketStatsRpc error:", e);
    return { stats: null, comps: [], error: String(e) };
  }
}
// ===== PARTIE 4/6 =====

// ============================================================================
// BPE PROVIDER - bpe-proxy (PRIMAIRE) + API tabular (fallback) + RPC
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

type BpeResult = { scoreCommodites: number | null; details: BpeKpis | null; coverage: Coverage; totalEquipements: number };

async function fetchBpeStatsViaProxy(lat: number, lon: number, radiusM: number, debug = false): Promise<BpeResult> {
  const functionsUrl = Deno.env.get("FUNCTIONS_URL") ?? (supabaseUrl ? (supabaseUrl + "/functions/v1") : "");
  if (!functionsUrl) return { scoreCommodites: null, details: null, coverage: "not_covered", totalEquipements: 0 };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceKey) { headers["Authorization"] = "Bearer " + serviceKey; headers["apikey"] = serviceKey; }

  try {
    const resp = await fetch(functionsUrl + "/bpe-proxy", {
      method: "POST", headers,
      body: JSON.stringify({ lat, lon, radius_m: radiusM, limit: 2000 }),
    });

    const json = await resp.json().catch(() => null) as { success?: boolean; items?: Array<Record<string, unknown>> } | null;
    if (!resp.ok || !json?.success) {
      if (debug) console.warn("[BPE via proxy] non-OK:", resp.status, json);
      return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 };
    }

    const rows = Array.isArray(json.items) ? json.items : [];
    if (rows.length === 0) return { scoreCommodites: null, details: null, coverage: "no_data", totalEquipements: 0 };

    const byDomaine: Record<string, number> = {};
    const santeByType: Record<string, { count: number; minDist: number | null }> = {};
    const commercesProches: CommerceProche[] = [];
    const medecinsProches: MedecinProche[] = [];
    let totalInRadius = 0;

    for (const r of rows) {
      const typeCode = String(r.type_code ?? "").trim();
      const distM = Number(r.distance_m ?? 0);
      if (!typeCode || !Number.isFinite(distM) || distM < 0) continue;
      totalInRadius++;

      const domaineLabel = getEffectiveDomaine(typeCode);
      byDomaine[domaineLabel] = (byDomaine[domaineLabel] || 0) + 1;

      const domaine = typeCode.charAt(0);
      if ((domaine === "B" || typeCode === "G101") && commercesProches.length < 15) {
        commercesProches.push({ nom: fixMojibakeText(String(r.nom || COMMERCE_TYPE_LABELS[typeCode] || "Commerce")), type: COMMERCE_TYPE_LABELS[typeCode] || typeCode, type_code: typeCode, distance_m: Math.round(distM), distance_km: metersToKm(distM), commune: r.commune ? fixMojibakeText(String(r.commune)) : undefined, adresse: r.adresse ? fixMojibakeText(String(r.adresse)) : undefined });
      }

      if (domaine === "D") {
        const santeType = SANTE_TYPE_MAP[typeCode] || "autre_sante";
        if (!santeByType[santeType]) santeByType[santeType] = { count: 0, minDist: null };
        santeByType[santeType].count++;
        if (santeByType[santeType].minDist === null || distM < santeByType[santeType].minDist!) santeByType[santeType].minDist = Math.round(distM);
        if (medecinsProches.length < 15) {
          medecinsProches.push({ nom: fixMojibakeText(String(r.nom || MEDECIN_SPECIALITE_LABELS[typeCode] || "Professionnel de sante")), specialite: MEDECIN_SPECIALITE_LABELS[typeCode] || typeCode, type_code: typeCode, distance_m: Math.round(distM), distance_km: metersToKm(distM), commune: r.commune ? fixMojibakeText(String(r.commune)) : undefined, adresse: r.adresse ? fixMojibakeText(String(r.adresse)) : undefined });
        }
      }
    }

    commercesProches.sort((a, b) => a.distance_m - b.distance_m);
    medecinsProches.sort((a, b) => a.distance_m - b.distance_m);

    const nb_commerces = byDomaine.commerces || 0, nb_sante = byDomaine.sante || 0, nb_services = byDomaine.services || 0;
    const nb_enseignement = byDomaine.enseignement || 0, nb_sport_culture = byDomaine.sport_culture || 0;
    const score_commerces = Math.min(100, nb_commerces * 2.5);
    const score_sante = Math.min(100, nb_sante * 3.0);
    const score_services = Math.min(100, nb_services * 1.5);
    const scoreCommodites = Math.round((score_commerces + score_sante + score_services) / 3);

    const sante_details = Object.entries(santeByType).map(([type, data]) => ({ type, label: SANTE_LABELS[type] || type, count: data.count, min_distance_m: data.minDist }));

    const details: BpeKpis = { total_equipements: totalInRadius, nb_commerces, nb_sante, nb_services, nb_enseignement, nb_sport_culture, score_commerces, score_sante, score_services, scoreCommodites, rayon_m: radiusM, sante_details, commerces_proches: commercesProches.slice(0, 10), medecins_proches: medecinsProches.slice(0, 10) };

    if (debug) console.log("[BPE via proxy] OK, totalEquipements:", totalInRadius, "scoreCommodites:", scoreCommodites);
    return { scoreCommodites, details, coverage: "ok", totalEquipements: totalInRadius };
  } catch (e) {
    if (debug) console.error("[BPE via proxy] exception:", e);
    return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 };
  }
}

function getBpeCacheKey(lat: number, lon: number, radiusM: number): string {
  return "bpe:" + String(Math.round(lat * 100) / 100) + ":" + String(Math.round(lon * 100) / 100) + ":" + String(radiusM);
}

async function getCommuneCenter(communeCode: string): Promise<{ lat: number; lon: number; nom: string } | null> {
  try {
    const resp = await fetch(GEO_API_BASE + "/communes/" + communeCode + "?fields=centre,nom");
    if (!resp.ok) return null;
    const data = await resp.json() as { centre?: { coordinates: [number, number] }; nom: string };
    if (data.centre?.coordinates) return { lon: data.centre.coordinates[0], lat: data.centre.coordinates[1], nom: data.nom || communeCode };
  } catch { /* ignore */ }
  return null;
}

// FIX CRITIQUE: fetchBpeStats avec signature correcte et bpe-proxy comme source primaire
async function fetchBpeStats(lat: number, lon: number, radiusM = 500, communeInsee?: string | null, debug = false): Promise<BpeResult> {
  const cacheKey = getBpeCacheKey(lat, lon, radiusM);

  // 1) Cache
  const cached = await getFromCache(cacheKey);
  if (cached) {
    if (debug) console.log("BPE from cache");
    return cached as BpeResult;
  }

  // 2) SOURCE PRIMAIRE: bpe-proxy (fiable)
  const viaProxy = await fetchBpeStatsViaProxy(lat, lon, radiusM, debug);
  if (viaProxy.coverage === "ok" || viaProxy.coverage === "no_data") {
    await saveToCache(cacheKey, "bpe-proxy", viaProxy, 86400);
    return viaProxy;
  }

  // 3) FALLBACK: API tabular data.gouv.fr (peut retourner 404)
  let effectiveCommune = communeInsee;
  let communeCenter: { lat: number; lon: number; nom: string } | null = null;
  
  if (!effectiveCommune) {
    try {
      const geoResp = await fetch(GEO_API_BASE + "/communes?lat=" + String(lat) + "&lon=" + String(lon) + "&fields=code,nom,centre&limit=1");
      if (geoResp.ok) {
        const communes = await geoResp.json() as Array<{ code: string; nom: string; centre?: { coordinates: [number, number] } }>;
        if (communes.length > 0) {
          effectiveCommune = communes[0].code;
          if (communes[0].centre?.coordinates) communeCenter = { lon: communes[0].centre.coordinates[0], lat: communes[0].centre.coordinates[1], nom: communes[0].nom };
          if (debug) console.log("BPE: commune detectee:", effectiveCommune, communes[0].nom);
        }
      }
    } catch (e) { console.warn("BPE: erreur detection commune:", e); }
  } else {
    communeCenter = await getCommuneCenter(effectiveCommune);
  }

  if (!effectiveCommune) {
    if (supabase) { console.log("BPE: Fallback vers RPC (pas de commune)"); return await fetchBpeStatsRpc(lat, lon, radiusM); }
    return { scoreCommodites: null, details: null, coverage: "not_covered", totalEquipements: 0 };
  }

  try {
    const apiUrl = DATA_GOUV_BPE_API + "/" + BPE_RESOURCE_ID + "/data/?DEPCOM__exact=" + effectiveCommune + "&page_size=2000";
    if (debug) console.log("BPE API URL:", apiUrl);

    const resp = await fetch(apiUrl, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      console.warn("BPE API error:", resp.status, "- fallback vers RPC");
      if (supabase) return await fetchBpeStatsRpc(lat, lon, radiusM);
      return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 };
    }

    const json = await resp.json() as { data?: Array<Record<string, string>> };
    const records = json.data || [];
    if (debug) console.log("BPE: " + String(records.length) + " equipements pour commune " + effectiveCommune);

    if (records.length === 0) {
      if (supabase) { console.log("BPE: Aucune donnee API, fallback vers RPC"); return await fetchBpeStatsRpc(lat, lon, radiusM); }
      return { scoreCommodites: null, details: null, coverage: "no_data", totalEquipements: 0 };
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
        if (communeCenter) { eqLat = communeCenter.lat; eqLon = communeCenter.lon; } else continue;
      }

      const distance = haversineDistance(lat, lon, eqLat, eqLon);
      if (distance <= radiusM) {
        totalInRadius++;
        const typeCode = r.TYPEQU || r.typequ || "";
        const domaineLabel = getEffectiveDomaine(typeCode);
        byDomaine[domaineLabel] = (byDomaine[domaineLabel] || 0) + 1;

        const domaine = typeCode.charAt(0);
        if ((domaine === "B" || typeCode === "G101") && commercesProches.length < 15) {
          commercesProches.push({ nom: fixMojibakeText(r.NOM || r.nom || COMMERCE_TYPE_LABELS[typeCode] || "Commerce"), type: COMMERCE_TYPE_LABELS[typeCode] || typeCode, type_code: typeCode, distance_m: Math.round(distance), distance_km: metersToKm(distance), adresse: fixMojibakeText(r.ADRESSE || r.adresse) || undefined, commune: fixMojibakeText(r.LIBCOM || r.libcom || communeCenter?.nom) || undefined });
        }

        if (domaine === "D") {
          const santeType = SANTE_TYPE_MAP[typeCode] || "autre_sante";
          if (!santeByType[santeType]) santeByType[santeType] = { count: 0, minDist: null };
          santeByType[santeType].count++;
          if (santeByType[santeType].minDist === null || distance < santeByType[santeType].minDist!) santeByType[santeType].minDist = Math.round(distance);

          if ((typeCode.startsWith("D2") || typeCode.startsWith("D3")) && medecinsProches.length < 15) {
            medecinsProches.push({ nom: fixMojibakeText(r.NOM || r.nom || MEDECIN_SPECIALITE_LABELS[typeCode] || "Professionnel de sante"), specialite: MEDECIN_SPECIALITE_LABELS[typeCode] || typeCode, type_code: typeCode, distance_m: Math.round(distance), distance_km: metersToKm(distance), adresse: fixMojibakeText(r.ADRESSE || r.adresse) || undefined, commune: fixMojibakeText(r.LIBCOM || r.libcom || communeCenter?.nom) || undefined });
          }
        }
      }
    }

    commercesProches.sort((a, b) => a.distance_m - b.distance_m);
    medecinsProches.sort((a, b) => a.distance_m - b.distance_m);

    const nb_commerces = byDomaine.commerces || 0, nb_sante = byDomaine.sante || 0, nb_services = byDomaine.services || 0;
    const nb_enseignement = byDomaine.enseignement || 0, nb_sport_culture = byDomaine.sport_culture || 0;
    const score_commerces = Math.min(100, nb_commerces * 2.5);
    const score_sante = Math.min(100, nb_sante * 3.0);
    const score_services = Math.min(100, nb_services * 1.5);
    const scoreCommodites = totalInRadius > 0 ? Math.round((score_commerces + score_sante + score_services) / 3) : 0;

    const sante_details = Object.entries(santeByType).map(([type, data]) => ({ type, label: SANTE_LABELS[type] || type, count: data.count, min_distance_m: data.minDist }));
    const coverage: Coverage = totalInRadius > 0 ? "ok" : "no_data";
    const details: BpeKpis = { total_equipements: totalInRadius, nb_commerces, nb_sante, nb_services, nb_enseignement, nb_sport_culture, score_commerces, score_sante, score_services, scoreCommodites, rayon_m: radiusM, sante_details, commerces_proches: commercesProches.slice(0, 10), medecins_proches: medecinsProches.slice(0, 10) };

    const result: BpeResult = { scoreCommodites: coverage === "ok" ? scoreCommodites : null, details, coverage, totalEquipements: totalInRadius };
    await saveToCache(cacheKey, "bpe", result, 86400);
    if (debug) console.log("BPE result:", { totalInRadius, nb_commerces, nb_sante, nb_services });
    return result;
  } catch (e) {
    console.error("BPE API error:", e);
    if (supabase) { console.log("BPE: Fallback vers RPC apres exception"); return await fetchBpeStatsRpc(lat, lon, radiusM); }
    return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 };
  }
}

async function fetchBpeStatsRpc(lat: number, lon: number, radiusM = 500): Promise<BpeResult> {
  if (!supabase) return { scoreCommodites: null, details: null, coverage: "not_covered", totalEquipements: 0 };
  try {
    const { data, error } = await supabase.rpc("get_bpe_proximite", { p_lat: lat, p_lon: lon, p_rayon_m: radiusM, p_types: null });
    if (error) { console.error("RPC get_bpe_proximite error:", error); return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 }; }
    const dataObj = data as Record<string, unknown> | null;
    const score = numOrNull(dataObj?.scoreCommodites);
    const totalEquipements = numOrNull(dataObj?.total_equipements_proximite) ?? 0;
    if (totalEquipements === 0 && (score === 0 || score == null)) return { scoreCommodites: null, details: dataObj as BpeKpis | null, coverage: "no_data", totalEquipements: 0 };
    return { scoreCommodites: score, details: dataObj as BpeKpis | null, coverage: score != null ? "ok" : "no_data", totalEquipements };
  } catch (e) { console.error("fetchBpeStatsRpc error:", e); return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 }; }
}

// ============================================================================
// PHARMACIE FALLBACK OSM OVERPASS
// ============================================================================
async function fetchNearestPharmacyOverpass(lat: number, lon: number, maxRadiusM = 20000, debug = false): Promise<ServiceEssentiel | null> {
  const radii = [2000, 5000, 10000, maxRadiusM].filter(r => r <= maxRadiusM);
  for (const radiusM of radii) {
    if (debug) console.log("OSM Overpass: recherche pharmacie rayon " + String(radiusM) + "m");
    const query = "[out:json][timeout:10];\n(\n  node[\"amenity\"=\"pharmacy\"](around:" + String(radiusM) + "," + String(lat) + "," + String(lon) + ");\n  way[\"amenity\"=\"pharmacy\"](around:" + String(radiusM) + "," + String(lat) + "," + String(lon) + ");\n);\nout center;";
    try {
      const resp = await fetch(OVERPASS_API_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(query) });
      if (!resp.ok) { if (debug) console.warn("OSM Overpass HTTP " + String(resp.status)); continue; }
      const json = await resp.json() as { elements?: Array<{ lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> };
      const elements = json.elements || [];
      if (elements.length === 0) { if (debug) console.log("OSM Overpass: aucune pharmacie dans " + String(radiusM) + "m"); continue; }

      let nearest: ServiceEssentiel | null = null, minDistance = Infinity;
      for (const el of elements) {
        const elLat = el.lat ?? el.center?.lat, elLon = el.lon ?? el.center?.lon;
        if (elLat == null || elLon == null) continue;
        const distance = haversineDistance(lat, lon, elLat, elLon);
        if (distance < minDistance) {
          minDistance = distance;
          const tags = el.tags || {};
          nearest = { nom: fixMojibakeText(tags.name || tags["name:fr"] || "Pharmacie"), type: "Pharmacie", type_code: "OSM_PHARMACY", distance_m: Math.round(distance), distance_km: metersToKm(distance), adresse: fixMojibakeText([tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ")) || undefined, commune: fixMojibakeText(tags["addr:city"] || tags["addr:municipality"]) || undefined };
        }
      }
      if (nearest) { if (debug) console.log("OSM Overpass: pharmacie trouvee a " + String(nearest.distance_km) + "km"); return nearest; }
    } catch (e) { if (debug) console.warn("OSM Overpass error:", e); }
  }
  return null;
}

// ============================================================================
// ESSENTIAL SERVICES BLOCK BUILDER
// ============================================================================
function normalizeEquipmentName(eq: Record<string, unknown>, typeCode: string): string {
  if (FORCE_TYPE_LABEL_CODES.has(typeCode)) {
    if (COMMERCE_TYPE_LABELS[typeCode]) return COMMERCE_TYPE_LABELS[typeCode];
    if (SERVICE_TYPE_LABELS[typeCode]) return SERVICE_TYPE_LABELS[typeCode];
  }
  const nom = eq.nom || eq.NOM || eq.name || null;
  if (nom && String(nom).trim()) return fixMojibakeText(String(nom).trim());
  const typeLibelle = eq.type_libelle || eq.TYPE_LIBELLE || null;
  if (typeLibelle && String(typeLibelle).trim()) return fixMojibakeText(String(typeLibelle).trim());
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

function createEmptySummary(radiusKm: number): EssentialServiceSummary { return { radius_km: radiusKm, count: 0, nearest: null, top: [] }; }

function getEquipmentTextForFallback(eq: Record<string, unknown>): string {
  const parts: string[] = [];
  if (eq.nom) parts.push(String(eq.nom));
  if (eq.NOM) parts.push(String(eq.NOM));
  if (eq.name) parts.push(String(eq.name));
  if (eq.type_libelle) parts.push(String(eq.type_libelle));
  if (eq.TYPE_LIBELLE) parts.push(String(eq.TYPE_LIBELLE));
  return normalizeTextForSearch(parts.join(" "));
}

function containsOptiqueKeywords(text: string): boolean {
  const normalized = normalizeTextForSearch(text);
  return normalized.includes("optique") || normalized.includes("opticien") || normalized.includes("lunette");
}

function buildEssentialServicesBlock(rawItems: Array<Record<string, unknown>>, radiusM: number, isRural: boolean, debug = false): EssentialServicesBlock {
  const radiusKm = metersToKm(radiusM);
  const buckets: Record<EssentialServiceBucket, EssentialServiceItem[]> = { pharmacie: [], banque_dab: [], poste: [], station_service: [], commerce_alimentaire: [], medecin_generaliste: [], medecin_specialiste: [], dentiste: [], infirmier: [], kinesitherapeute: [], gendarmerie: [], commissariat: [] };

  for (const eq of rawItems) {
    const typeCode = String(eq.type_code ?? "").trim();
    if (!typeCode) continue;
    const distM = Number(eq.distance_m ?? 0);
    if (!Number.isFinite(distM) || distM < 0) continue;

    let bucket = ESSENTIAL_BUCKET_BY_TYPE_CODE[typeCode];
    if (!bucket) {
      const textContent = getEquipmentTextForFallback(eq);
      if (textContent.includes("pharmacie") || textContent.includes("pharma")) bucket = "pharmacie";
    }
    if (!bucket) continue;

    if (bucket === "station_service") {
      if (typeCode !== "G101") continue;
      const textContent = getEquipmentTextForFallback(eq);
      if (containsOptiqueKeywords(textContent)) continue;
    }

    let typeLabel = getTypeLabel(typeCode);
    if (bucket === "pharmacie" && !ESSENTIAL_BUCKET_BY_TYPE_CODE[typeCode]) typeLabel = "Pharmacie";

    const item: EssentialServiceItem = { name: normalizeEquipmentName(eq, typeCode), type_label: typeLabel, type_code: typeCode, distance_m: Math.round(distM), distance_km: metersToKm(distM), commune: fixMojibakeText(String(eq.commune || eq.LIBCOM || eq.libcom || "")) || undefined, adresse: fixMojibakeText(String(eq.adresse || eq.ADRESSE || "")) || undefined };
    buckets[bucket].push(item);
  }

  const buildSummary = (bucket: EssentialServiceBucket): EssentialServiceSummary => {
    const items = buckets[bucket];
    if (items.length === 0) return createEmptySummary(radiusKm);
    items.sort((a, b) => a.distance_m - b.distance_m);
    return { radius_km: radiusKm, count: items.length, nearest: items[0], top: items.slice(0, 5) };
  };

  return { zone_type: isRural ? "rural" : "urbain", radius_km: radiusKm, pharmacie: buildSummary("pharmacie"), banque_dab: buildSummary("banque_dab"), poste: buildSummary("poste"), station_service: buildSummary("station_service"), commerce_alimentaire: buildSummary("commerce_alimentaire"), medecin_generaliste: buildSummary("medecin_generaliste"), medecin_specialiste: buildSummary("medecin_specialiste"), dentiste: buildSummary("dentiste"), infirmier: buildSummary("infirmier"), kinesitherapeute: buildSummary("kinesitherapeute"), gendarmerie: buildSummary("gendarmerie"), commissariat: buildSummary("commissariat") };
}

type EssentialServicesRawItem = Record<string, unknown>;
type EssentialServicesRawResult = { items: EssentialServicesRawItem[]; type_codes_sent: string[] };

async function fetchEssentialServicesRaw(lat: number, lon: number, radiusM: number, debug = false): Promise<EssentialServicesRawResult> {
  const functionsUrl = Deno.env.get("FUNCTIONS_URL") ?? (supabaseUrl ? (supabaseUrl + "/functions/v1") : "");
  if (!functionsUrl) { if (debug) console.warn("fetchEssentialServicesRaw: no FUNCTIONS_URL"); return { items: [], type_codes_sent: [] }; }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceKey) { headers["Authorization"] = "Bearer " + serviceKey; headers["apikey"] = serviceKey; }
  const type_codes = Object.keys(ESSENTIAL_BUCKET_BY_TYPE_CODE);
  if (debug) console.log("Essential services: sending " + String(type_codes.length) + " type_codes to bpe-proxy");

  try {
    const resp = await fetch(functionsUrl + "/bpe-proxy", { method: "POST", headers, body: JSON.stringify({ lat, lon, radius_m: radiusM, type_codes, limit: 500 }) });
    const json = await resp.json().catch(() => null) as { success?: boolean; items?: Array<Record<string, unknown>> } | null;
    if (!resp.ok || !json?.success) { if (debug) console.warn("bpe-proxy non-OK:", resp.status, json); return { items: [], type_codes_sent: type_codes }; }
    const items: EssentialServicesRawItem[] = [];
    const rows = Array.isArray(json.items) ? json.items : [];
    if (debug) console.log("Essential services raw: " + String(rows.length) + " items from bpe-proxy");
    for (const eq of rows) {
      const typeCode = String(eq.type_code ?? "").trim();
      const distM = Number(eq.distance_m ?? 0);
      if (!typeCode || !Number.isFinite(distM) || distM < 0) continue;
      items.push({ type_code: typeCode, distance_m: distM, nom: eq.nom || eq.name || undefined, type_libelle: eq.type_libelle || undefined, commune: eq.commune || eq.code_commune || undefined, adresse: eq.adresse || undefined });
    }
    return { items, type_codes_sent: type_codes };
  } catch (e) { if (debug) console.error("fetchEssentialServicesRaw error:", e); return { items: [], type_codes_sent: type_codes }; }
}

async function fetchEssentialServicesViaRpc(lat: number, lon: number, radiusM: number, debug = false): Promise<EssentialServicesRawItem[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc("get_bpe_essentiels_radius", { p_lat: lat, p_lon: lon, p_radius_m: radiusM });
    if (error) { if (debug) console.warn("RPC get_bpe_essentiels_radius error:", error); return []; }
    if (!Array.isArray(data)) return [];
    if (debug) console.log("RPC get_bpe_essentiels_radius: " + String(data.length) + " items");
    return (data as Array<Record<string, unknown>>).map((item) => ({ type_code: item.type_code || item.typequ || "", distance_m: item.distance_m || 0, nom: item.nom || item.name || undefined, type_libelle: item.type_libelle || undefined, commune: item.commune || item.libcom || undefined, adresse: item.adresse || undefined }));
  } catch (e) { if (debug) console.error("fetchEssentialServicesViaRpc error:", e); return []; }
}

async function fetchResidencesSeniors(lat: number, lon: number, radiusKm = 20, debug = false): Promise<ResidenceSenior[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from("finess_etablissements").select("finess, raison_sociale, commune, categorie, latitude, longitude").not("latitude", "is", null).not("longitude", "is", null).or("categorie.ilike.%Residence autonomie%,categorie.ilike.%Residence services%,categorie.ilike.%Logement foyer%,categorie.ilike.%Foyer logement%,categorie.ilike.%MARPA%").limit(200);
    if (error || !data) { if (debug) console.warn("fetchResidencesSeniors error:", error); return []; }
    const residences: ResidenceSenior[] = [];
    for (const r of data as Array<Record<string, unknown>>) {
      const rLat = parseFloat(String(r.latitude)), rLon = parseFloat(String(r.longitude));
      if (Number.isNaN(rLat) || Number.isNaN(rLon)) continue;
      const dist = haversineDistance(lat, lon, rLat, rLon);
      if (dist <= radiusKm * 1000) residences.push({ nom: fixMojibakeText(String(r.raison_sociale || "Residence seniors")), type: fixMojibakeText(String(r.categorie || "Residence seniors")), commune: fixMojibakeText(String(r.commune || "")), distance_km: metersToKm(dist), finess: String(r.finess || "") });
    }
    residences.sort((a, b) => a.distance_km - b.distance_km);
    if (debug) console.log("fetchResidencesSeniors found:", residences.length);
    return residences.slice(0, 10);
  } catch (e) { if (debug) console.warn("fetchResidencesSeniors exception:", e); return []; }
}
// ===== PARTIE 5/6 =====

// ============================================================================
// TRANSPORT PROVIDER - Conditionnel selon agglomeration
// ============================================================================
async function fetchTransportScore(lat: number, lon: number, communeInsee: string | null): Promise<{ score: number | null; label: string | null; summary: string | null; coverage: Coverage; applicable: boolean }> {
  const isInMetro = isInGrandeAgglomeration(communeInsee);
  if (!isInMetro) {
    console.log("[Transport] zone hors grande agglomeration, critere non applicable");
    return { score: null, label: "Non applicable", summary: "Hors grande agglomeration - critere non evalue", coverage: "ok", applicable: false };
  }

  const functionsUrl = Deno.env.get("FUNCTIONS_URL") ?? (supabaseUrl ? supabaseUrl + "/functions/v1" : "");
  if (!functionsUrl) { console.warn("[fetchTransportScore] no FUNCTIONS_URL"); return { score: null, label: null, summary: null, coverage: "not_covered", applicable: true }; }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceKey) { headers["Authorization"] = "Bearer " + serviceKey; headers["apikey"] = serviceKey; }

  try {
    console.log("[fetchTransportScore] calling:", functionsUrl + "/transport-score");
    const resp = await fetch(functionsUrl + "/transport-score", { method: "POST", headers, body: JSON.stringify({ lat, lng: lon, radius_m: 800 }) });
    const json = await resp.json().catch(() => null) as { success?: boolean; scoring?: Record<string, unknown> } | null;
    if (!resp.ok) { console.warn("[fetchTransportScore] non-OK:", resp.status, json); return { score: null, label: null, summary: null, coverage: "error", applicable: true }; }
    if (json?.success) {
      const scoring = json.scoring ?? {};
      const score = numOrNull(scoring.scoreTransport);
      console.log("[fetchTransportScore] success, score:", score);
      return { score, label: safeToString(scoring.label), summary: safeToString(scoring.summary), coverage: score != null ? "ok" : "no_data", applicable: true };
    }
    return { score: null, label: null, summary: null, coverage: "error", applicable: true };
  } catch (e) {
    console.error("[fetchTransportScore] error:", e);
    return { score: null, label: null, summary: null, coverage: "error", applicable: true };
  }
}

// ============================================================================
// SANTE ENRICHIE
// ============================================================================
async function fetchHealthFicheForCommune(codeCommune: string): Promise<{ data: HealthFicheEnriched | null; coverage: Coverage }> {
  if (!supabase || !codeCommune) return { data: null, coverage: "not_covered" };
  try {
    const { data, error } = await supabase.rpc("get_fiche_sante_commune", { p_code_commune: codeCommune });
    if (error) { console.error("[RPC get_fiche_sante_commune] error:", error); return { data: null, coverage: "error" }; }
    return { data: data as HealthFicheEnriched | null, coverage: data ? "ok" : "no_data" };
  } catch (e) { console.error("[fetchHealthFicheForCommune] error:", e); return { data: null, coverage: "error" }; }
}

async function fetchHopitalProche(lat: number, lon: number, maxRadiusKm = 50): Promise<HopitalProche> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.rpc("get_hopital_proche", { p_lat: lat, p_lon: lon, p_radius_km: maxRadiusKm });
    if (!error && data && Array.isArray(data) && data.length > 0) {
      const h = data[0] as Record<string, unknown>;
      return { nom: fixMojibakeText(String(h.raison_sociale || h.nom || "Hopital")), commune: fixMojibakeText(String(h.commune || "")), distance_km: Math.round((Number(h.distance_m) || 0) / 100) / 10, type: fixMojibakeText(String(h.categorie || "Etablissement de sante")) };
    }

    const { data: finessData, error: finessError } = await supabase.from("finess_etablissements").select("finess, raison_sociale, commune, categorie, latitude, longitude").not("latitude", "is", null).not("longitude", "is", null).in("categorie", ["Centre Hospitalier Regional", "Centre Hospitalier", "Centre Hospitalier Specialise", "Hopital local", "Clinique MCO", "Hopital des armees"]).limit(100);
    if (finessError || !finessData) return null;

    let closest: HopitalProche = null, minDistance = Infinity;
    for (const h of finessData as Array<Record<string, unknown>>) {
      const hLat = parseFloat(String(h.latitude)), hLon = parseFloat(String(h.longitude));
      if (isNaN(hLat) || isNaN(hLon)) continue;
      const dist = haversineDistance(lat, lon, hLat, hLon);
      if (dist < minDistance && dist <= maxRadiusKm * 1000) {
        minDistance = dist;
        closest = { nom: fixMojibakeText(String(h.raison_sociale || "Hopital")), commune: fixMojibakeText(String(h.commune || "")), distance_km: Math.round(dist / 100) / 10, type: fixMojibakeText(String(h.categorie || "Etablissement de sante")) };
      }
    }
    return closest;
  } catch (e) { console.warn("[fetchHopitalProche] error:", e); return null; }
}

async function enrichHealthData(lat: number, lon: number, healthData: HealthFicheEnriched | null, bpeSanteDetails: Array<{ type: string; label: string; count: number; min_distance_m: number | null }> | null, medecinsProches?: MedecinProche[]): Promise<HealthFicheEnriched | null> {
  const baseData: HealthFicheEnriched = healthData || { code_commune: "", commune: "", population: null, densite_medecins_10000: null, densite_label: "Donnees insuffisantes", desert_medical_score: null, resume: "", kpi: { medecins_total: null, generalistes_total: null, generalistes_densite_10000: null, infirmiers_total: null, pharmacies_total: null, dentistes_total: null, autres_professionnels: null, etablissements_sante: null } };
  const hopital = await fetchHopitalProche(lat, lon, 50);
  const professionnels_details: ProfessionnelsSanteDetails = { medecins_generalistes: baseData.kpi.generalistes_total ?? 0, medecins_specialistes: Math.max(0, (baseData.kpi.medecins_total ?? 0) - (baseData.kpi.generalistes_total ?? 0)), dentistes: baseData.kpi.dentistes_total ?? 0, infirmiers: baseData.kpi.infirmiers_total ?? 0, kinesitherapeutes: 0, pharmacies: baseData.kpi.pharmacies_total ?? 0, autres: baseData.kpi.autres_professionnels ?? 0 };

  if (bpeSanteDetails && bpeSanteDetails.length > 0) {
    for (const detail of bpeSanteDetails) {
      switch (detail.type) {
        case "medecin_generaliste": professionnels_details.medecins_generalistes = Math.max(professionnels_details.medecins_generalistes, detail.count); break;
        case "medecin_specialiste": professionnels_details.medecins_specialistes = Math.max(professionnels_details.medecins_specialistes, detail.count); break;
        case "dentiste": professionnels_details.dentistes = Math.max(professionnels_details.dentistes, detail.count); break;
        case "infirmier": professionnels_details.infirmiers = Math.max(professionnels_details.infirmiers, detail.count); break;
        case "kinesitherapeute": professionnels_details.kinesitherapeutes = Math.max(professionnels_details.kinesitherapeutes, detail.count); break;
        case "pharmacie": professionnels_details.pharmacies = Math.max(professionnels_details.pharmacies, detail.count); break;
        case "autre_sante": professionnels_details.autres = Math.max(professionnels_details.autres, detail.count); break;
      }
    }
  }

  if (medecinsProches && medecinsProches.length > 0) {
    const countByType: Record<string, number> = {};
    for (const m of medecinsProches) { const type = SANTE_TYPE_MAP[m.type_code] || "autre_sante"; countByType[type] = (countByType[type] || 0) + 1; }
    if (countByType["medecin_generaliste"]) professionnels_details.medecins_generalistes = Math.max(professionnels_details.medecins_generalistes, countByType["medecin_generaliste"]);
    if (countByType["medecin_specialiste"]) professionnels_details.medecins_specialistes = Math.max(professionnels_details.medecins_specialistes, countByType["medecin_specialiste"]);
    if (countByType["dentiste"]) professionnels_details.dentistes = Math.max(professionnels_details.dentistes, countByType["dentiste"]);
    if (countByType["infirmier"]) professionnels_details.infirmiers = Math.max(professionnels_details.infirmiers, countByType["infirmier"]);
    if (countByType["pharmacie"]) professionnels_details.pharmacies = Math.max(professionnels_details.pharmacies, countByType["pharmacie"]);
    if (countByType["kinesitherapeute"]) professionnels_details.kinesitherapeutes = Math.max(professionnels_details.kinesitherapeutes, countByType["kinesitherapeute"]);
  }

  const resumeParts: string[] = [];
  const communeName = baseData.commune || "la commune";
  if (baseData.population) resumeParts.push("La commune de " + communeName + " compte " + baseData.population.toLocaleString("fr-FR") + " habitants.");
  else resumeParts.push("La commune de " + communeName + ".");

  const profList: string[] = [];
  if (professionnels_details.medecins_generalistes > 0) profList.push(String(professionnels_details.medecins_generalistes) + " medecin(s) generaliste(s)");
  if (professionnels_details.medecins_specialistes > 0) profList.push(String(professionnels_details.medecins_specialistes) + " specialiste(s)");
  if (professionnels_details.dentistes > 0) profList.push(String(professionnels_details.dentistes) + " dentiste(s)");
  if (professionnels_details.infirmiers > 0) profList.push(String(professionnels_details.infirmiers) + " infirmier(s)");
  if (professionnels_details.kinesitherapeutes > 0) profList.push(String(professionnels_details.kinesitherapeutes) + " kinesitherapeute(s)");
  if (professionnels_details.pharmacies > 0) profList.push(String(professionnels_details.pharmacies) + " pharmacie(s)");

  if (profList.length > 0) resumeParts.push("Professionnels de sante : " + profList.join(", ") + ".");
  else resumeParts.push("Aucun professionnel de sante recense sur la commune.");
  if (hopital) resumeParts.push("Hopital le plus proche : " + hopital.nom + " a " + hopital.commune + " (" + String(hopital.distance_km) + " km).");

  return { ...baseData, resume: resumeParts.join(" "), professionnels_details, hopital_proche: hopital, medecins_proches: medecinsProches };
}

// ============================================================================
// INSEE SOCIO-ECO
// ============================================================================
type InseeSocioEcoData = { code_commune: string; commune: string | null; revenu_median: number | null; taux_chomage: number | null; pension_retraite_moyenne: number | null; taux_pauvrete: number | null; pct_proprietaires: number | null; annee: number | null; source: string | null };

async function fetchInseeSocioEco(communeCode: string, debug = false): Promise<{ data: InseeSocioEcoData | null; debugInfo: InseeSocioEcoDebug }> {
  const debugInfo: InseeSocioEcoDebug = { ok: false, source: "supabase", commune_insee: communeCode, found: false, fields_present: [], error: null };
  if (!communeCode) { debugInfo.error = "code_commune vide"; return { data: null, debugInfo }; }
  if (!supabase) { debugInfo.error = "supabase non initialise"; return { data: null, debugInfo }; }

  try {
    if (debug) console.log("[INSEE SocioEco] fetching for commune", communeCode);
    const { data, error } = await supabase.from("insee_socioeco_communes").select("*").eq("code_commune", communeCode).limit(1).maybeSingle();
    if (error) { debugInfo.error = "Supabase error: " + (error.message || String(error)); if (debug) console.warn("[INSEE SocioEco] Supabase error:", error); return { data: null, debugInfo }; }
    if (!data) { debugInfo.error = "commune non trouvee"; if (debug) console.log("[INSEE SocioEco] commune not found:", communeCode); return { data: null, debugInfo }; }

    debugInfo.found = true;
    const dataObj = data as Record<string, unknown>;
    const result: InseeSocioEcoData = { code_commune: communeCode, commune: safeToString(dataObj.commune), revenu_median: dataObj.revenu_median_eur != null ? Number(dataObj.revenu_median_eur) : null, taux_chomage: dataObj.taux_chomage_pct != null ? parseFloat(String(dataObj.taux_chomage_pct)) : null, taux_pauvrete: dataObj.taux_pauvrete_pct != null ? parseFloat(String(dataObj.taux_pauvrete_pct)) : null, pct_proprietaires: dataObj.pct_proprietaires != null ? parseFloat(String(dataObj.pct_proprietaires)) : null, pension_retraite_moyenne: dataObj.pension_retraite_moyenne_eur_mois != null ? Number(dataObj.pension_retraite_moyenne_eur_mois) : null, annee: dataObj.annee != null ? Number(dataObj.annee) : null, source: safeToString(dataObj.source) };

    const fieldsPresent: string[] = [];
    if (result.revenu_median != null) fieldsPresent.push("revenu_median");
    if (result.taux_chomage != null) fieldsPresent.push("taux_chomage");
    if (result.taux_pauvrete != null) fieldsPresent.push("taux_pauvrete");
    if (result.pct_proprietaires != null) fieldsPresent.push("pct_proprietaires");
    if (result.pension_retraite_moyenne != null) fieldsPresent.push("pension_retraite_moyenne");

    debugInfo.ok = true;
    debugInfo.fields_present = fieldsPresent;
    if (debug) console.log("[INSEE SocioEco] result:", { revenu_median: result.revenu_median, taux_chomage: result.taux_chomage, fields: fieldsPresent });
    return { data: result, debugInfo };
  } catch (e) { debugInfo.error = "Exception: " + String(e); console.error("[fetchInseeSocioEco] error:", e); return { data: null, debugInfo }; }
}

async function fetchInseeStatsHybrid(communeInsee: string | null, debug = false): Promise<{ data: InseeHybridData | null; coverage: Coverage; socioEcoDebug?: InseeSocioEcoDebug }> {
  if (!communeInsee) return { data: null, coverage: "not_covered" };
  let baseData: Record<string, unknown> | null = null;

  if (supabase) {
    try {
      const { data, error } = await supabase.from("insee_communes_stats").select("*").eq("code_commune", communeInsee).limit(1).maybeSingle();
      if (!error && data) { baseData = data as Record<string, unknown>; if (debug) console.log("[INSEE Supabase] found demographic fields for", communeInsee); }
    } catch (e) { if (debug) console.warn("[INSEE Supabase] error:", e); }
  }

  const socioEcoResult = await fetchInseeSocioEco(communeInsee, debug);
  const socioEcoData = socioEcoResult.data;
  if (!baseData && !socioEcoData) return { data: null, coverage: "no_data", socioEcoDebug: socioEcoResult.debugInfo };

  const hasSocioEcoData = socioEcoData != null && socioEcoResult.debugInfo.ok && socioEcoResult.debugInfo.fields_present.length > 0;
  const result: InseeHybridData = {
    code_commune: communeInsee,
    commune: safeToString(baseData?.commune) ?? safeToString(baseData?.nom_commune) ?? socioEcoData?.commune ?? null,
    population: numOrNull(baseData?.population),
    pct_moins_25: numOrNull(baseData?.pct_moins_25),
    pct_plus_65: numOrNull(baseData?.pct_plus_65),
    densite_pop: numOrNull(baseData?.densite_pop),
    revenu_median: socioEcoData?.revenu_median ?? null,
    taux_pauvrete: socioEcoData?.taux_pauvrete ?? null,
    pct_proprietaires: socioEcoData?.pct_proprietaires ?? null,
    taux_chomage: socioEcoData?.taux_chomage ?? null,
    pension_retraite_moyenne: socioEcoData?.pension_retraite_moyenne ?? null,
    nb_menages: null, nb_logements: null,
    source_comparateur: hasSocioEcoData,
  };

  if (baseData) { for (const [key, value] of Object.entries(baseData)) { if (!(key in result)) result[key] = value; } }
  if (debug) console.log("[INSEE Hybrid] result:", { population: result.population, revenu_median: result.revenu_median });
  return { data: result, coverage: "ok", socioEcoDebug: socioEcoResult.debugInfo };
}

// ============================================================================
// ECOLES
// ============================================================================
type EcolesStats = { nearestDistanceM: number | null; nearestName: string | null; nearestType: string | null; count300m: number; count500m: number; count1000m: number; scoreEcoles: number | null };

async function fetchEcolesStats(lat: number, lng: number): Promise<{ data: EcolesStats | null; coverage: Coverage }> {
  if (!supabase) return { data: null, coverage: "not_covered" };
  try {
    const { data, error } = await supabase.rpc("get_ecoles_proximite", { lat, lng, rayon_m: 1000 });
    if (error) { console.error("[RPC get_ecoles_proximite] error:", error); return { data: null, coverage: "error" }; }
    const rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
    if (rows.length === 0) return { data: { nearestDistanceM: null, nearestName: null, nearestType: null, count300m: 0, count500m: 0, count1000m: 0, scoreEcoles: null }, coverage: "no_data" };

    const nearest = rows[0];
    const count300m = rows.filter((r) => Number(r.distance_m) <= 300).length;
    const count500m = rows.filter((r) => Number(r.distance_m) <= 500).length;
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

    return { data: { nearestDistanceM: nearestDistance, nearestName: safeToString(nearest.nom), nearestType: safeToString(nearest.type_etablissement), count300m, count500m, count1000m, scoreEcoles }, coverage: "ok" };
  } catch (e) { console.error("[fetchEcolesStats] error:", e); return { data: null, coverage: "error" }; }
}

// ============================================================================
// v3.24: COMPUTE MARKET INDICES V2 - FIX: sante_index null si pas de donnees
// ============================================================================
function computeDvfComponent(dvfStats: DvfMarketStats | null, targets: MarketStudyPayload["targets"]): number | null {
  if (!dvfStats || dvfStats.transactions_count === 0) return null;
  const supply_index = computeIndex(dvfStats.transactions_count, 0, 100, false);

  let price_index: number | null = null;
  if (dvfStats.price_median_eur_m2 && targets?.unit_price_m2) {
    const ratio = dvfStats.price_median_eur_m2 / targets.unit_price_m2;
    price_index = (ratio >= 0.1 && ratio <= 10) ? computeIndex(ratio, 0.5, 1.5, true) : 50;
  } else if (dvfStats.price_median_eur_m2) price_index = 50;

  let demand_index: number | null = null;
  if (dvfStats.evolution_pct != null) demand_index = computeIndex(dvfStats.evolution_pct, -10, 10, false);

  const dvfItems: Array<{ w: number; v: number | null }> = [];
  if (supply_index != null) dvfItems.push({ w: 0.50, v: supply_index });
  if (price_index != null) dvfItems.push({ w: 0.30, v: price_index });
  if (demand_index != null) dvfItems.push({ w: 0.20, v: demand_index });
  return weightedAverage(dvfItems);
}

// FIX: computeSanteScore retourne null si pas de donnees exploitables
function computeSanteScore(healthSummary: HealthFicheEnriched | null): number | null {
  if (!healthSummary) return null;
  if (healthSummary.desert_medical_score != null) return Math.round(100 - healthSummary.desert_medical_score);
  if (healthSummary.densite_medecins_10000 != null) return computeIndex(healthSummary.densite_medecins_10000, 0, 15, false);
  if (healthSummary.professionnels_details) {
    const prof = healthSummary.professionnels_details;
    const total = prof.medecins_generalistes + prof.medecins_specialistes + prof.dentistes + prof.infirmiers + prof.pharmacies;
    if (total > 0) return computeIndex(total, 0, 30, false);
  }
  return null; // FIX: retourne null si aucune donnee sante exploitable
}

type MarketIndicesV2Result = { demand_index: number | null; supply_index: number | null; price_index: number | null; accessibility_index: number | null; risk_index: number | null; insee_index: number | null; ecoles_index: number | null; sante_index: number | null; global_score: number; weights_applied: ProjectWeights };

function computeMarketIndicesV2(params: { dvfStats: DvfMarketStats | null; transportScore: number | null; transportApplicable: boolean; commoditesScore: number | null; ecolesScore: number | null; santeScore: number | null; inseeScore: number | null; targets: MarketStudyPayload["targets"]; config: ProjectConfig; bpeCoverage: Coverage }): MarketIndicesV2Result {
  const { dvfStats, transportScore, transportApplicable, commoditesScore, ecolesScore, santeScore, inseeScore, targets, config, bpeCoverage } = params;
  const weights = transportApplicable ? config.weights : config.weightsNoTransport;
  const accessibility_index = transportApplicable ? transportScore : null;

  let supply_index: number | null = null, demand_index: number | null = null, price_index: number | null = null;
  if (dvfStats && dvfStats.transactions_count > 0) {
    supply_index = computeIndex(dvfStats.transactions_count, 0, 100, false);
    if (dvfStats.evolution_pct != null) demand_index = computeIndex(dvfStats.evolution_pct, -10, 10, false);
    if (dvfStats.price_median_eur_m2 && targets?.unit_price_m2) {
      const ratio = dvfStats.price_median_eur_m2 / targets.unit_price_m2;
      price_index = (ratio >= 0.1 && ratio <= 10) ? computeIndex(ratio, 0.5, 1.5, true) : 50;
    } else if (dvfStats.price_median_eur_m2) price_index = 50;
  }

  let risk_index: number | null = null;
  if (bpeCoverage === "ok" && commoditesScore != null) risk_index = Math.round(100 - commoditesScore);

  const items: Array<{ w: number; v: number | null }> = [];
  const dvfComponent = computeDvfComponent(dvfStats, targets);
  if (weights.dvf > 0 && dvfComponent != null) items.push({ w: weights.dvf, v: dvfComponent });
  if (weights.transport > 0 && transportApplicable && transportScore != null) items.push({ w: weights.transport, v: transportScore });
  if (weights.bpe > 0 && bpeCoverage === "ok" && commoditesScore != null) items.push({ w: weights.bpe, v: commoditesScore });
  if (weights.ecoles > 0 && ecolesScore != null) items.push({ w: weights.ecoles, v: ecolesScore });
  // FIX: Ne pas ajouter santeScore si null (missing data)
  if (weights.sante > 0 && santeScore != null) items.push({ w: weights.sante, v: santeScore });
  if (weights.insee > 0 && inseeScore != null) items.push({ w: weights.insee, v: inseeScore });

  const global = weightedAverage(items);

  return { demand_index, supply_index, price_index, accessibility_index, risk_index, insee_index: inseeScore, ecoles_index: ecolesScore, sante_index: santeScore, global_score: global == null ? 50 : Math.round(global), weights_applied: weights };
}

// ============================================================================
// VERDICT & INSIGHTS
// ============================================================================
function generateVerdict(score: number, dvfStats: DvfMarketStats | null, dvfCoverage: Coverage, projectType: CanonicalProjectType, transportApplicable: boolean): string {
  const projectLabels: Record<CanonicalProjectType, string> = { LOGEMENT: "logement", COMMERCE: "commerce", BUREAUX: "bureaux", HOTEL: "hotel", ETUDIANT: "residence etudiante", RSS: "residence senior", EHPAD: "EHPAD" };
  const projectLabel = projectLabels[projectType] || "projet";
  const transportNote = !transportApplicable ? " (zone hors metropole, transport non evalue)" : "";

  if (dvfCoverage === "not_covered") return "Prix/transactions indisponibles (DVF: " + coverageLabel(dvfCoverage) + ").";
  if (dvfCoverage === "error") return "Erreur lors de la recuperation DVF.";
  if (dvfStats == null || dvfStats.transactions_count === 0) return "Donnees de marche insuffisantes pour evaluer ce projet de " + projectLabel + ". Elargir le perimetre recommande.";
  if (score >= 70) return "Marche tres favorable pour un projet de " + projectLabel + transportNote + ". Demande soutenue et bonne liquidite.";
  if (score >= 55) return "Marche favorable pour un projet de " + projectLabel + transportNote + ". Conditions de marche correctes.";
  if (score >= 40) return "Marche modere pour un projet de " + projectLabel + transportNote + ". Analyse approfondie recommandee.";
  return "Marche tendu pour un projet de " + projectLabel + transportNote + ". Vigilance requise sur le positionnement prix.";
}

function generateInsights(dvfStats: DvfMarketStats | null, dvfCoverage: Coverage, transportScore: number | null, transportApplicable: boolean, commoditesScore: number | null, ecolesScore: number | null, radiusKm: number, bpeCoverage: Coverage, healthSummary: HealthFicheEnriched | null, bpeDetails: BpeKpis | null, servicesRuraux: ServicesRuraux | null, isRural: boolean, _essentialServices: EssentialServicesBlock | null): MarketInsight[] {
  const insights: MarketInsight[] = [];

  if (dvfCoverage === "not_covered") insights.push({ type: "warning", title: "DVF non couvert", description: "La source DVF n'est pas disponible.", source: "DVF" });
  else if (dvfCoverage === "error") insights.push({ type: "warning", title: "Erreur DVF", description: "Erreur lors de l'appel DVF.", source: "DVF" });
  else if (dvfStats && dvfStats.transactions_count > 0) {
    insights.push({ type: dvfStats.transactions_count >= 30 ? "positive" : "neutral", title: String(dvfStats.transactions_count) + " transactions analysees", description: "Marche actif avec " + String(dvfStats.transactions_count) + " ventes dans un rayon de " + String(radiusKm) + " km.", source: "DVF" });
    if (dvfStats.price_median_eur_m2) insights.push({ type: "neutral", title: "Prix median : " + dvfStats.price_median_eur_m2.toLocaleString("fr-FR") + " EUR/m2", description: "Intervalle (Q1-Q3) : " + (dvfStats.price_q1_eur_m2?.toLocaleString("fr-FR") ?? "?") + " a " + (dvfStats.price_q3_eur_m2?.toLocaleString("fr-FR") ?? "?") + " EUR/m2.", source: "DVF" });
  } else insights.push({ type: "warning", title: "Donnees DVF insuffisantes", description: "Peu ou pas de transactions. Elargir le rayon.", source: "DVF" });

  if (transportApplicable) {
    if (transportScore != null) {
      const level = transportScore >= 70 ? "Excellente" : transportScore >= 50 ? "Bonne" : transportScore >= 30 ? "Moyenne" : "Faible";
      insights.push({ type: transportScore >= 50 ? "positive" : transportScore >= 30 ? "neutral" : "negative", title: level + " desserte transports (" + String(transportScore) + "/100)", description: "Accessibilite transports en commun.", source: "Transport" });
    }
  } else insights.push({ type: "neutral", title: "Transports en commun", description: "Zone hors grande agglomeration - critere non evalue.", source: "Transport" });

  if (servicesRuraux) {
    const radiusLabel = String(metersToKm(servicesRuraux.rayon_recherche_m)) + " km";
    if (servicesRuraux.pharmacie_proche) {
      const ph = servicesRuraux.pharmacie_proche;
      insights.push({ type: ph.distance_km <= 5 ? "positive" : ph.distance_km <= 10 ? "neutral" : "negative", title: "Pharmacie a " + String(ph.distance_km) + " km", description: ph.nom + (ph.commune ? " (" + ph.commune + ")" : "") + ".", source: "Services ruraux" });
    } else if (isRural) insights.push({ type: "warning", title: "Aucune pharmacie trouvee", description: "Pas de pharmacie dans un rayon de " + radiusLabel + ".", source: "Services ruraux" });

    const commerce = servicesRuraux.supermarche_proche || servicesRuraux.hypermarche_proche || servicesRuraux.superette_proche;
    if (commerce) insights.push({ type: commerce.distance_km <= 10 ? "positive" : commerce.distance_km <= 15 ? "neutral" : "negative", title: commerce.type + " a " + String(commerce.distance_km) + " km", description: commerce.nom + (commerce.commune ? " (" + commerce.commune + ")" : "") + ".", source: "Services ruraux" });
    else if (isRural) insights.push({ type: "warning", title: "Aucun commerce alimentaire trouve", description: "Pas de commerce alimentaire dans un rayon de " + radiusLabel + ".", source: "Services ruraux" });

    if (servicesRuraux.medecin_proche) {
      const m = servicesRuraux.medecin_proche;
      const distKm = m.distance_km ?? metersToKm(m.distance_m);
      insights.push({ type: distKm <= 10 ? "positive" : distKm <= 15 ? "neutral" : "negative", title: "Medecin generaliste a " + String(distKm) + " km", description: m.nom + (m.commune ? " (" + m.commune + ")" : "") + ".", source: "Services ruraux" });
    } else if (isRural) insights.push({ type: "warning", title: "Aucun medecin generaliste trouve", description: "Pas de medecin generaliste dans un rayon de " + radiusLabel + ".", source: "Services ruraux" });
  } else if (!isRural) {
    if (bpeDetails?.commerces_proches && bpeDetails.commerces_proches.length > 0) {
      const commercesDesc = bpeDetails.commerces_proches.slice(0, 3).map(c => c.type + " a " + String(c.distance_m) + "m").join(", ");
      insights.push({ type: bpeDetails.nb_commerces >= 5 ? "positive" : bpeDetails.nb_commerces >= 2 ? "neutral" : "negative", title: String(bpeDetails.nb_commerces) + " commerces a proximite", description: "Les plus proches : " + commercesDesc + ".", source: "BPE" });
    } else if (bpeCoverage === "no_data") insights.push({ type: "warning", title: "Donnees BPE indisponibles", description: "Aucun equipement trouve dans le perimetre.", source: "BPE" });
    else if (commoditesScore != null) {
      const level = commoditesScore >= 70 ? "Excellente" : commoditesScore >= 50 ? "Bonne" : commoditesScore >= 30 ? "Moyenne" : "Faible";
      insights.push({ type: commoditesScore >= 50 ? "positive" : commoditesScore >= 30 ? "neutral" : "negative", title: level + " proximite commerces/services", description: "Densite d'equipements a proximite (BPE).", source: "BPE" });
    }
  }

  if (ecolesScore != null) {
    const level = ecolesScore >= 70 ? "Tres bonne" : ecolesScore >= 50 ? "Bonne" : ecolesScore >= 30 ? "Moyenne" : "Faible";
    insights.push({ type: ecolesScore >= 50 ? "positive" : ecolesScore >= 30 ? "neutral" : "negative", title: level + " accessibilite scolaire (" + String(ecolesScore) + "/100)", description: "Base sur la proximite et la densite d'etablissements a 1 km.", source: "Ecoles" });
  }

  if (!isRural) {
    const medecinsProches = bpeDetails?.medecins_proches || healthSummary?.medecins_proches;
    if (medecinsProches && medecinsProches.length > 0) {
      const medecinsDesc = medecinsProches.slice(0, 3).map(m => m.specialite + " a " + String(m.distance_m) + "m").join(", ");
      insights.push({ type: medecinsProches.length >= 5 ? "positive" : medecinsProches.length >= 2 ? "neutral" : "negative", title: String(medecinsProches.length) + " professionnels de sante a proximite", description: "Les plus proches : " + medecinsDesc + ".", source: "Sante" });
    }
  }

  return insights;
}
// ===== PARTIE 6/6 =====

// ============================================================================
// SERVICES RURAUX BUILDER
// ============================================================================
function buildServicesRuraux(essentialItems: EssentialServicesRawItem[], radiusM: number, bpeDetails: BpeKpis | null): ServicesRuraux {
  const findNearest = (bucket: EssentialServiceBucket): ServiceEssentiel | null => {
    const matching = essentialItems.filter(eq => ESSENTIAL_BUCKET_BY_TYPE_CODE[String(eq.type_code)] === bucket).sort((a, b) => Number(a.distance_m) - Number(b.distance_m));
    if (matching.length === 0) return null;
    const eq = matching[0];
    const typeCode = String(eq.type_code);
    return { nom: fixMojibakeText(String(eq.nom || getTypeLabel(typeCode))), type: getTypeLabel(typeCode), type_code: typeCode, distance_m: Math.round(Number(eq.distance_m)), distance_km: metersToKm(Number(eq.distance_m)), adresse: eq.adresse ? fixMojibakeText(String(eq.adresse)) : undefined, commune: eq.commune ? fixMojibakeText(String(eq.commune)) : undefined };
  };

  const findNearestMedecin = (): MedecinProche | null => {
    const matching = essentialItems.filter(eq => ESSENTIAL_BUCKET_BY_TYPE_CODE[String(eq.type_code)] === "medecin_generaliste").sort((a, b) => Number(a.distance_m) - Number(b.distance_m));
    if (matching.length === 0 && bpeDetails?.medecins_proches && bpeDetails.medecins_proches.length > 0) {
      const m = bpeDetails.medecins_proches.find(mp => mp.type_code === "D201");
      if (m) return m;
      return bpeDetails.medecins_proches[0];
    }
    if (matching.length === 0) return null;
    const eq = matching[0];
    const typeCode = String(eq.type_code);
    return { nom: fixMojibakeText(String(eq.nom || MEDECIN_SPECIALITE_LABELS[typeCode] || "Medecin")), specialite: MEDECIN_SPECIALITE_LABELS[typeCode] || typeCode, type_code: typeCode, distance_m: Math.round(Number(eq.distance_m)), distance_km: metersToKm(Number(eq.distance_m)), adresse: eq.adresse ? fixMojibakeText(String(eq.adresse)) : undefined, commune: eq.commune ? fixMojibakeText(String(eq.commune)) : undefined };
  };

  const findNearestCommerce = (codes: string[]): ServiceEssentiel | null => {
    const matching = essentialItems.filter(eq => codes.includes(String(eq.type_code))).sort((a, b) => Number(a.distance_m) - Number(b.distance_m));
    if (matching.length === 0) return null;
    const eq = matching[0];
    const typeCode = String(eq.type_code);
    return { nom: fixMojibakeText(String(eq.nom || COMMERCE_TYPE_LABELS[typeCode] || "Commerce")), type: COMMERCE_TYPE_LABELS[typeCode] || typeCode, type_code: typeCode, distance_m: Math.round(Number(eq.distance_m)), distance_km: metersToKm(Number(eq.distance_m)), adresse: eq.adresse ? fixMojibakeText(String(eq.adresse)) : undefined, commune: eq.commune ? fixMojibakeText(String(eq.commune)) : undefined };
  };

  return {
    pharmacie_proche: findNearest("pharmacie"),
    supermarche_proche: findNearestCommerce(["B102", "B105"]),
    hypermarche_proche: findNearestCommerce(["B101", "B104"]),
    superette_proche: findNearestCommerce(["B201", "B208"]),
    station_service_proche: findNearest("station_service"),
    poste_proche: findNearest("poste"),
    banque_proche: findNearest("banque_dab"),
    commissariat_proche: findNearest("commissariat"),
    gendarmerie_proche: findNearest("gendarmerie"),
    medecin_proche: findNearestMedecin(),
    rayon_recherche_m: radiusM,
  };
}

// ============================================================================
// PROJECT MODULES BUILDERS
// ============================================================================
function buildSeniorModule(inseeData: InseeHybridData | null, healthSummary: HealthFicheEnriched | null, ehpadList: Array<{ distance_km: number }>, residencesSeniors: ResidenceSenior[]): SeniorModule {
  const pct_plus_65 = inseeData?.pct_plus_65 ?? null;
  const pension_retraite_moyenne = inseeData?.pension_retraite_moyenne ?? null;
  const professionnels_sante = healthSummary?.professionnels_details ?? null;
  const hopital_distance_km = healthSummary?.hopital_proche?.distance_km ?? null;

  let senior_demand_score: number | null = null;
  if (pct_plus_65 != null) {
    const baseScore = computeIndex(pct_plus_65, 10, 35, false) ?? 50;
    const pensionBonus = pension_retraite_moyenne != null && pension_retraite_moyenne >= 1500 ? 10 : 0;
    senior_demand_score = Math.min(100, baseScore + pensionBonus);
  }

  let competition_score: number | null = null;
  const totalCompetitors = ehpadList.length + residencesSeniors.length;
  if (totalCompetitors > 0) {
    const nearbyCompetitors = ehpadList.filter(e => e.distance_km <= 10).length + residencesSeniors.filter(r => r.distance_km <= 10).length;
    competition_score = computeIndex(nearbyCompetitors, 0, 10, true);
  } else competition_score = 100;

  return { pct_plus_65, pension_retraite_moyenne, professionnels_sante, ehpad_count: ehpadList.length, residences_seniors_count: residencesSeniors.length, hopital_distance_km, senior_demand_score, competition_score };
}

function buildStudentModule(ecolesStats: EcolesStats | null, transportScore: number | null): StudentModule {
  const ecoles_count_1km = ecolesStats?.count1000m ?? 0;
  const ecoles_nearest_distance_m = ecolesStats?.nearestDistanceM ?? null;
  let student_accessibility_score: number | null = null;

  const items: Array<{ w: number; v: number | null }> = [];
  if (ecolesStats?.scoreEcoles != null) items.push({ w: 0.6, v: ecolesStats.scoreEcoles });
  if (transportScore != null) items.push({ w: 0.4, v: transportScore });
  if (items.length > 0) student_accessibility_score = Math.round(weightedAverage(items) ?? 50);

  return { ecoles_count_1km, ecoles_nearest_distance_m, transport_score: transportScore, student_accessibility_score };
}

function buildCommerceModule(bpeDetails: BpeKpis | null, inseeData: InseeHybridData | null, transportScore: number | null): CommerceModule {
  const commerces_count = bpeDetails?.nb_commerces ?? 0;
  const commerce_alimentaire_count = bpeDetails?.commerces_proches?.filter(c => ["B101", "B102", "B104", "B105", "B201", "B208"].includes(c.type_code)).length ?? 0;
  const revenu_median = inseeData?.revenu_median ?? null;
  const taux_pauvrete = inseeData?.taux_pauvrete ?? null;

  let flux_score: number | null = null;
  const items: Array<{ w: number; v: number | null }> = [];
  if (transportScore != null) items.push({ w: 0.5, v: transportScore });
  if (commerces_count > 0) items.push({ w: 0.3, v: computeIndex(commerces_count, 0, 20, false) });
  if (revenu_median != null) items.push({ w: 0.2, v: computeIndex(revenu_median, 15000, 45000, false) });
  if (items.length > 0) flux_score = Math.round(weightedAverage(items) ?? 50);

  return { commerces_count, commerce_alimentaire_count, revenu_median, taux_pauvrete, flux_score };
}

function buildHotelModule(transportScore: number | null, bpeDetails: BpeKpis | null): HotelModule {
  const services_count = (bpeDetails?.nb_services ?? 0) + (bpeDetails?.nb_commerces ?? 0);
  let accessibility_score: number | null = null;

  const items: Array<{ w: number; v: number | null }> = [];
  if (transportScore != null) items.push({ w: 0.6, v: transportScore });
  if (services_count > 0) items.push({ w: 0.4, v: computeIndex(services_count, 0, 30, false) });
  if (items.length > 0) accessibility_score = Math.round(weightedAverage(items) ?? 50);

  return { transport_score: transportScore, services_count, accessibility_score };
}

// ============================================================================
// MAIN HANDLER - MARKET STUDY MODE
// ============================================================================
async function handleMarketStudy(payload: MarketStudyPayload): Promise<Response> {
  const startTime = Date.now();
  const { project_nature, radius_km = 2, horizon_months = 24, targets = {}, debug = false } = payload;

  const resolution = await resolveAnalysisPoint(payload);
  if (!resolution.point) {
    return new Response(JSON.stringify({ success: false, error: resolution.error ?? "Point non resolu", debug: debug ? { resolve: resolution.debugResolve, inseeMeta: resolution.inseeMeta } : undefined }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const point = resolution.point;
  const communeInsee = point.commune_insee ?? payload.commune_insee?.toString() ?? null;
  const projectType = normalizeProjectType(project_nature);
  const isInMetro = isInGrandeAgglomeration(communeInsee);
  const isRural = !isInMetro;
  const config = getProjectConfig(projectType, isRural, radius_km, horizon_months);

  if (debug) console.log("[MarketStudy] projectType:", projectType, "isRural:", isRural, "config:", config);

  const dvfTypeLocal = config.dvf.type_local;
  const dvfRadiusM = Math.round(config.dvf.radius_km * 1000);
  const bpeRadiusM = config.bpe.radius_m;
  const essentialRadiusM = config.bpe.essential_radius_m;

  const [dvfResult, bpeResult, transportResult, ecolesResult, inseeResult, healthResult] = await Promise.all([
    dvfMarketKpis({ lat: point.lat, lon: point.lon, radius_m: dvfRadiusM, horizon_months: config.dvf.horizon_months, type_local: dvfTypeLocal, commune_insee: communeInsee, debug }),
    fetchBpeStats(point.lat, point.lon, bpeRadiusM, communeInsee, debug),
    fetchTransportScore(point.lat, point.lon, communeInsee),
    fetchEcolesStats(point.lat, point.lon),
    fetchInseeStatsHybrid(communeInsee, debug),
    communeInsee ? fetchHealthFicheForCommune(communeInsee) : Promise.resolve({ data: null, coverage: "not_covered" as Coverage }),
  ]);

  const [essentialRaw, ehpadList, residencesSeniors] = await Promise.all([
    fetchEssentialServicesRaw(point.lat, point.lon, essentialRadiusM, debug),
    config.modules.enableSenior && communeInsee ? finessEhpadNearby(communeInsee, 20) : Promise.resolve([]),
    config.modules.enableSenior ? fetchResidencesSeniors(point.lat, point.lon, 20, debug) : Promise.resolve([]),
  ]);

  const essentialServices = buildEssentialServicesBlock(essentialRaw.items, essentialRadiusM, isRural, debug);
  const servicesRuraux = isRural ? buildServicesRuraux(essentialRaw.items, essentialRadiusM, bpeResult.details) : null;

  let pharmacieFallback: ServiceEssentiel | null = null;
  if (isRural && !servicesRuraux?.pharmacie_proche && essentialServices.pharmacie.count === 0) {
    pharmacieFallback = await fetchNearestPharmacyOverpass(point.lat, point.lon, essentialRadiusM, debug);
    if (pharmacieFallback && servicesRuraux) servicesRuraux.pharmacie_proche = pharmacieFallback;
  }

  const healthSummary = await enrichHealthData(point.lat, point.lon, healthResult.data, bpeResult.details?.sante_details ?? null, bpeResult.details?.medecins_proches);
  const santeScore = computeSanteScore(healthSummary);
  const inseeScore = computeInseeScore(inseeResult.data, projectType);

  const transportApplicable = transportResult.applicable;
  const indices = computeMarketIndicesV2({
    dvfStats: dvfResult.kpis.n > 0 ? { transactions_count: dvfResult.kpis.n, transactions_count_previous: 0, price_median_eur_m2: dvfResult.kpis.median_price_m2, price_mean_eur_m2: dvfResult.kpis.avg_price_m2, price_q1_eur_m2: dvfResult.kpis.q1_price_m2, price_q3_eur_m2: dvfResult.kpis.q3_price_m2, evolution_pct: null, volume_total_eur: null, surface_mean_m2: null } : null,
    transportScore: transportResult.score,
    transportApplicable,
    commoditesScore: bpeResult.scoreCommodites,
    ecolesScore: ecolesResult.data?.scoreEcoles ?? null,
    santeScore,
    inseeScore,
    targets,
    config,
    bpeCoverage: bpeResult.coverage,
  });

  const projectModules: ProjectModules = {};
  if (config.modules.enableSenior) projectModules.senior = buildSeniorModule(inseeResult.data, healthSummary, ehpadList.map(e => ({ distance_km: e.distance_km ?? 0 })), residencesSeniors);
  if (config.modules.enableStudent) projectModules.etudiant = buildStudentModule(ecolesResult.data, transportResult.score);
  if (config.modules.enableCommerce) projectModules.commerce = buildCommerceModule(bpeResult.details, inseeResult.data, transportResult.score);
  if (config.modules.enableHotel) projectModules.hotel = buildHotelModule(transportResult.score, bpeResult.details);

  const dvfStats: DvfMarketStats | null = dvfResult.kpis.n > 0 ? { transactions_count: dvfResult.kpis.n, transactions_count_previous: 0, price_median_eur_m2: dvfResult.kpis.median_price_m2, price_mean_eur_m2: dvfResult.kpis.avg_price_m2, price_q1_eur_m2: dvfResult.kpis.q1_price_m2, price_q3_eur_m2: dvfResult.kpis.q3_price_m2, evolution_pct: null, volume_total_eur: null, surface_mean_m2: null } : null;
  const verdict = generateVerdict(indices.global_score, dvfStats, dvfResult.coverage, projectType, transportApplicable);
  const insights = generateInsights(dvfStats, dvfResult.coverage, transportResult.score, transportApplicable, bpeResult.scoreCommodites, ecolesResult.data?.scoreEcoles ?? null, config.dvf.radius_km, bpeResult.coverage, healthSummary, bpeResult.details, servicesRuraux, isRural, essentialServices);

  const kpis: MarketKpi[] = [
    { label: "Transactions", value: dvfResult.kpis.n, unit: "ventes", description: "Nombre de transactions dans le perimetre" },
    { label: "Prix median", value: dvfResult.kpis.median_price_m2, unit: "EUR/m2", description: "Prix median au m2" },
    { label: "Prix moyen", value: dvfResult.kpis.avg_price_m2, unit: "EUR/m2", description: "Prix moyen au m2" },
    { label: "Q1-Q3", value: dvfResult.kpis.q1_price_m2 && dvfResult.kpis.q3_price_m2 ? (String(dvfResult.kpis.q1_price_m2) + "-" + String(dvfResult.kpis.q3_price_m2)) : null, unit: "EUR/m2", description: "Fourchette interquartile" },
  ];

  const coverages: CoverageMap = { dvf: dvfResult.coverage, transport: transportResult.coverage, ecoles: ecolesResult.coverage, bpe: bpeResult.coverage, sante: healthResult.coverage, insee: inseeResult.coverage, ehpad: config.modules.enableSenior ? (ehpadList.length > 0 ? "ok" : "no_data") : "not_covered" };

  const usedConfig: UsedConfig = { dvf_radius_km: config.dvf.radius_km, dvf_horizon_months: config.dvf.horizon_months, bpe_radius_m: bpeRadiusM, essential_radius_m: essentialRadiusM, weights_used: indices.weights_applied, transport_applicable: transportApplicable };

  const response = {
    success: true,
    mode: "market_study",
    point: { lat: point.lat, lon: point.lon, source: point.source, parcel_id: point.parcel_id, commune_insee: communeInsee, surface_m2: point.surface_m2 },
    market: {
      project_type: projectType,
      config: usedConfig,
      indices,
      kpis,
      comps: dvfResult.comps.slice(0, 15),
      verdict,
      insights,
      modules: projectModules,
    },
    transport: { score: transportResult.score, label: transportResult.label, summary: transportResult.summary, applicable: transportApplicable },
    ecoles: ecolesResult.data,
    bpe: { score: bpeResult.scoreCommodites, details: bpeResult.details, coverage: bpeResult.coverage },
    essential_services: essentialServices,
    services_ruraux: servicesRuraux,
    sante: healthSummary,
    insee: inseeResult.data,
    ehpad: config.modules.enableSenior ? { count: ehpadList.length, list: ehpadList.slice(0, 5) } : null,
    residences_seniors: config.modules.enableSenior ? residencesSeniors : null,
    coverages,
    timing_ms: Date.now() - startTime,
    debug: debug ? {
      point_resolution: resolution.debugResolve,
      dvfSource: dvfResult.source,
      bpeResult: { coverage: bpeResult.coverage, totalEquipements: bpeResult.totalEquipements, scoreCommodites: bpeResult.scoreCommodites },
      essential_services_debug: { radius_m: essentialRadiusM, type_codes_sent_count: essentialRaw.type_codes_sent.length, raw_items_count: essentialRaw.items.length, counts_by_bucket: Object.fromEntries(ALL_ESSENTIAL_BUCKETS.map(b => [b, essentialServices[b].count])) },
      transportResult,
      inseeDebug: inseeResult.socioEcoDebug,
      pharmacieFallback: pharmacieFallback ? { source: "OSM_Overpass", distance_km: pharmacieFallback.distance_km } : null,
    } : undefined,
  };

  return new Response(JSON.stringify(response), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ============================================================================
// MAIN HANDLER - STANDARD MODE
// ============================================================================
async function handleStandard(payload: StandardPayload): Promise<Response> {
  const startTime = Date.now();
  const { debug = false, radius_km = 2, horizon_months = 24 } = payload;

  const resolution = await resolveStandardPoint(payload);
  if (!resolution.point) {
    return new Response(JSON.stringify({ success: false, error: resolution.error ?? "Point non resolu", debug: debug ? { resolve: resolution.debugResolve } : undefined }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const point = resolution.point;
  const communeInsee = point.commune_insee ?? payload.commune_code ?? null;
  const typeLocal = normalizeStandardTypeLocal(payload.type_local);
  const isInMetro = isInGrandeAgglomeration(communeInsee);
  const isRural = !isInMetro;
  const bpeRadiusM = isRural ? RAYON_RURAL_MIN_M : RAYON_URBAIN_M;
  const essentialRadiusM = isRural ? RAYON_RURAL_MAX_M : RAYON_URBAIN_M;

  const [dvfResult, bpeResult, transportResult, ecolesResult, inseeResult, healthResult] = await Promise.all([
    dvfMarketKpis({ lat: point.lat, lon: point.lon, radius_m: Math.round(radius_km * 1000), horizon_months, type_local: typeLocal, commune_insee: communeInsee, debug }),
    fetchBpeStats(point.lat, point.lon, bpeRadiusM, communeInsee, debug),
    fetchTransportScore(point.lat, point.lon, communeInsee),
    fetchEcolesStats(point.lat, point.lon),
    fetchInseeStatsHybrid(communeInsee, debug),
    communeInsee ? fetchHealthFicheForCommune(communeInsee) : Promise.resolve({ data: null, coverage: "not_covered" as Coverage }),
  ]);

  const essentialRaw = await fetchEssentialServicesRaw(point.lat, point.lon, essentialRadiusM, debug);
  const essentialServices = buildEssentialServicesBlock(essentialRaw.items, essentialRadiusM, isRural, debug);
  const servicesRuraux = isRural ? buildServicesRuraux(essentialRaw.items, essentialRadiusM, bpeResult.details) : null;

  let pharmacieFallback: ServiceEssentiel | null = null;
  if (isRural && !servicesRuraux?.pharmacie_proche && essentialServices.pharmacie.count === 0) {
    pharmacieFallback = await fetchNearestPharmacyOverpass(point.lat, point.lon, essentialRadiusM, debug);
    if (pharmacieFallback && servicesRuraux) servicesRuraux.pharmacie_proche = pharmacieFallback;
  }

  const healthSummary = await enrichHealthData(point.lat, point.lon, healthResult.data, bpeResult.details?.sante_details ?? null, bpeResult.details?.medecins_proches);
  const santeScore = computeSanteScore(healthSummary);

  const transportApplicable = transportResult.applicable;
  const scores: SmartScoreComponents = { transport_score: transportApplicable ? transportResult.score : null, ecoles_score: ecolesResult.data?.scoreEcoles ?? null, commodites_score: bpeResult.scoreCommodites, marche_score: dvfResult.kpis.n > 0 ? computeIndex(dvfResult.kpis.n, 0, 100, false) : null, sante_score: santeScore };

  const scoreItems: Array<{ w: number; v: number | null }> = [];
  if (scores.marche_score != null) scoreItems.push({ w: 0.35, v: scores.marche_score });
  if (transportApplicable && scores.transport_score != null) scoreItems.push({ w: 0.20, v: scores.transport_score });
  else if (!transportApplicable) scoreItems.push({ w: 0.20, v: 50 });
  if (scores.commodites_score != null) scoreItems.push({ w: 0.20, v: scores.commodites_score });
  if (scores.ecoles_score != null) scoreItems.push({ w: 0.15, v: scores.ecoles_score });
  if (scores.sante_score != null) scoreItems.push({ w: 0.10, v: scores.sante_score });

  const smartScore = Math.round(weightedAverage(scoreItems) ?? 50);
  const coverages: CoverageMap = { dvf: dvfResult.coverage, transport: transportResult.coverage, ecoles: ecolesResult.coverage, bpe: bpeResult.coverage, sante: healthResult.coverage, insee: inseeResult.coverage, ehpad: "not_covered" };

  const response = {
    success: true,
    mode: "standard",
    point: { lat: point.lat, lon: point.lon, source: point.source, parcel_id: point.parcel_id, commune_insee: communeInsee, surface_m2: point.surface_m2 },
    smartScore,
    scores,
    dvf: { source: dvfResult.source, coverage: dvfResult.coverage, kpis: dvfResult.kpis, comps: dvfResult.comps.slice(0, 10) },
    transport: { score: transportResult.score, label: transportResult.label, summary: transportResult.summary, applicable: transportApplicable },
    ecoles: ecolesResult.data,
    bpe: { score: bpeResult.scoreCommodites, details: bpeResult.details, coverage: bpeResult.coverage },
    essential_services: essentialServices,
    services_ruraux: servicesRuraux,
    sante: healthSummary,
    insee: inseeResult.data,
    coverages,
    timing_ms: Date.now() - startTime,
    debug: debug ? {
      point_resolution: resolution.debugResolve,
      dvfSource: dvfResult.source,
      bpeResult: { coverage: bpeResult.coverage, totalEquipements: bpeResult.totalEquipements, scoreCommodites: bpeResult.scoreCommodites },
      essential_services_debug: { radius_m: essentialRadiusM, type_codes_sent_count: essentialRaw.type_codes_sent.length, raw_items_count: essentialRaw.items.length, counts_by_bucket: Object.fromEntries(ALL_ESSENTIAL_BUCKETS.map(b => [b, essentialServices[b].count])) },
      transportResult,
      inseeDebug: inseeResult.socioEcoDebug,
      pharmacieFallback: pharmacieFallback ? { source: "OSM_Overpass", distance_km: pharmacieFallback.distance_km } : null,
    } : undefined,
  };

  return new Response(JSON.stringify(response), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ============================================================================
// SERVE
// ============================================================================
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    console.log("[smartscore-enriched-v3] mode:", payload.mode ?? "standard");

    if (payload.mode === "market_study") {
      return await handleMarketStudy(payload as MarketStudyPayload);
    }
    return await handleStandard(payload as StandardPayload);
  } catch (e) {
    console.error("[smartscore-enriched-v3] error:", e);
    return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});