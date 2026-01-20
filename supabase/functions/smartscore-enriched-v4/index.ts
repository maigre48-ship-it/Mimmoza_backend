// supabase/functions/smartscore-enriched-v3/index.ts
// ✅ VERSION v3.19 - Corrections BPE + INSEE enrichi + suppression EHPAD
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

console.log("🚀 smartscore-enriched-v3 v3.19 loaded");

// ============================================================================
// TYPES
// ============================================================================
type Coverage = "ok" | "partial" | "no_data" | "not_covered" | "error";

interface CoverageMap {
  dvf: Coverage;
  transport: Coverage;
  ecoles: Coverage;
  bpe: Coverage;
  sante: Coverage;
  insee: Coverage;
}

interface MarketStudyPayload {
  mode: "market_study";
  parcel_id?: string;
  commune_insee?: string | number;
  project_nature: string;
  radius_km?: number;
  horizon_months?: number;
  targets?: Record<string, number>;
  debug?: boolean;
}

interface StandardPayload {
  address?: string;
  cp?: string;
  ville?: string;
  surface?: number;
  prix?: number;
  travaux?: any;
  userCriteria?: any;
  meloId?: string;
  type_local?: string;
  dep_code?: string;
  commune_code?: string;
  parcel_id?: string;
  commune_insee?: string | number;
  transports?: any;
  radius_km?: number;
  horizon_months?: number;
  debug?: boolean;
}

interface ServiceProche {
  nom: string;
  type: string;
  distance_km: number;
  commune?: string;
}

interface MedecinProche {
  nom: string;
  specialite: string;
  distance_km: number;
  commune?: string;
}

interface ServicesRuraux {
  pharmacie_proche: ServiceProche | null;
  supermarche_proche: ServiceProche | null;
  hypermarche_proche: ServiceProche | null;
  superette_proche: ServiceProche | null;
  station_service_proche: ServiceProche | null;
  poste_proche: ServiceProche | null;
  banque_proche: ServiceProche | null;
  commissariat_proche: ServiceProche | null;
  gendarmerie_proche: ServiceProche | null;
  medecin_proche: MedecinProche | null;
  rayon_recherche_m: number;
}

interface ServiceEssentiel {
  type_code: string;
  nom: string | null;
  distance_m: number;
  distance_km: number;
  commune: string | null;
  code_commune?: string | null;
}

interface EssentialServiceBucket {
  radius_km: number;
  count: number;
  nearest: ServiceEssentiel | null;
  top: ServiceEssentiel[];
}

interface EssentialServicesBlock {
  zone_type: "rural" | "urbain";
  radius_km: number;
  pharmacie: EssentialServiceBucket;
  banque_agence: EssentialServiceBucket;
  poste: EssentialServiceBucket;
  station_service: EssentialServiceBucket;
  commerce_alimentaire: EssentialServiceBucket;
  medecin_generaliste: EssentialServiceBucket;
  medecin_specialiste: EssentialServiceBucket;
  dentiste: EssentialServiceBucket;
  infirmier: EssentialServiceBucket;
  kinesitherapeute: EssentialServiceBucket;
  gendarmerie: EssentialServiceBucket;
  commissariat: EssentialServiceBucket;
}

interface DvfMarketStats {
  transactions_count: number;
  transactions_count_previous: number;
  price_median_eur_m2: number | null;
  price_mean_eur_m2: number | null;
  price_q1_eur_m2: number | null;
  price_q3_eur_m2: number | null;
  evolution_pct: number | null;
  volume_total_eur: number | null;
  surface_mean_m2: number | null;
}

interface MarketComp {
  id: string;
  address: string;
  price_m2: number;
  surface_m2: number;
  date: string;
  type_local: string;
  distance_m: number;
  commune?: string;
}

interface SmartScoreComponents {
  transport_score: number | null;
  ecoles_score: number | null;
  commodites_score: number | null;
  marche_score: number | null;
  sante_score: number | null;
}

interface HealthFicheEnriched {
  code_commune: string;
  commune: string;
  population: number | null;
  densite_medecins_10000: number | null;
  desert_medical_score: number | null;
  densite_label: string;
  professionnels_details: {
    medecins_generalistes: number;
    medecins_specialistes: number;
    dentistes: number;
    infirmiers: number;
    kinesitherapeutes: number;
    pharmacies: number;
    autres: number;
  };
  hopital_proche: {
    nom: string;
    commune: string;
    distance_km: number;
  } | null;
}

// ✅ INSEE enrichi
interface InseeEnriched {
  code_commune: string;
  commune: string | null;
  population: number | null;
  pct_moins_25: number | null;
  pct_plus_65: number | null;
  // Nouvelles données
  revenu_median: number | null;
  taux_pauvrete: number | null;
  nb_menages: number | null;
  pct_proprietaires: number | null;
  pct_locataires: number | null;
  taux_chomage: number | null;
  densite_pop: number | null;
}

// ============================================================================
// CONSTANTES
// ============================================================================
const RAYON_URBAIN_M = 500;
const RAYON_RURAL_MIN_M = 3000;
const RAYON_RURAL_MAX_M = 20000;

// ✅ Mapping corrigé des codes BPE vers les buckets
const ESSENTIAL_BUCKET_BY_TYPE_CODE: Record<string, string> = {
  // Pharmacie
  "D301": "pharmacie",
  
  // Médecin généraliste
  "D201": "medecin_generaliste",
  
  // Médecins spécialistes
  "D202": "medecin_specialiste",
  "D203": "medecin_specialiste",
  "D204": "medecin_specialiste",
  "D205": "medecin_specialiste",
  "D206": "medecin_specialiste",
  "D207": "medecin_specialiste",
  "D208": "medecin_specialiste",
  "D209": "medecin_specialiste",
  "D210": "medecin_specialiste",
  "D211": "medecin_specialiste",
  
  // Dentiste
  "D221": "dentiste",
  
  // Infirmier
  "D232": "infirmier",
  
  // Kiné
  "D233": "kinesitherapeute",
  
  // ✅ Banque (agences uniquement, pas DAB)
  "A203": "banque_agence",
  
  // Poste
  "A206": "poste",
  "A207": "poste",
  "A208": "poste",
  
  // Commerces alimentaires
  "B101": "commerce_alimentaire", // Hypermarché
  "B102": "commerce_alimentaire", // Supermarché
  "B103": "commerce_alimentaire", // Supérette
  "B201": "commerce_alimentaire", // Boulangerie
  "B202": "commerce_alimentaire", // Boucherie
  "B203": "commerce_alimentaire", // Produits surgelés
  "B204": "commerce_alimentaire", // Poissonnerie
  
  // ✅ Station service (corrigé: B306, pas B313)
  "B306": "station_service",
  
  // Sécurité
  "A101": "commissariat",
  "A104": "gendarmerie",
};

const ALL_ESSENTIAL_BUCKETS = [
  "pharmacie", "banque_agence", "poste", "station_service", "commerce_alimentaire",
  "medecin_generaliste", "medecin_specialiste", "dentiste", "infirmier", "kinesitherapeute",
  "gendarmerie", "commissariat"
];

// Liste des grandes agglomérations (codes INSEE)
const GRANDES_AGGLOMERATIONS = new Set([
  "75056", "13055", "69123", "31555", "33063", "59350", "34172", "44109",
  "67482", "06088", "21231", "37261", "51454", "35238", "76540", "54395",
  "49007", "38185", "42218", "63113", "80021", "87085", "25056"
]);

// ============================================================================
// SUPABASE CLIENT
// ============================================================================
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase: SupabaseClient | null = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  : null;

// ============================================================================
// HELPERS
// ============================================================================
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function metersToKm(m: number): number {
  return Math.round((m / 1000) * 10) / 10;
}

function isInGrandeAgglomeration(communeInsee: string | null): boolean {
  if (!communeInsee) return false;
  if (GRANDES_AGGLOMERATIONS.has(communeInsee)) return true;
  const prefix = communeInsee.substring(0, 2);
  return ["75", "92", "93", "94"].includes(prefix);
}

function computeIndex(value: number | null, min: number, max: number, inverse = false): number | null {
  if (value == null) return null;
  const clamped = Math.max(min, Math.min(max, value));
  const normalized = (clamped - min) / (max - min);
  const score = inverse ? (1 - normalized) * 100 : normalized * 100;
  return Math.round(score);
}

function weightedAverage(items: Array<{ w: number; v: number | null }>): number | null {
  let sumW = 0, sumWV = 0;
  for (const { w, v } of items) {
    if (v != null) { sumW += w; sumWV += w * v; }
  }
  return sumW > 0 ? sumWV / sumW : null;
}

function coverageLabel(c: Coverage): string {
  switch (c) {
    case "ok": return "Données disponibles";
    case "partial": return "Données partielles";
    case "no_data": return "Aucune donnée trouvée";
    case "not_covered": return "Zone non couverte";
    case "error": return "Erreur de récupération";
    default: return "Inconnu";
  }
}

// ============================================================================
// CACHE
// ============================================================================
const apiCache: Map<string, { data: any; expires: number }> = new Map();

function getCached<T>(key: string): T | null {
  const entry = apiCache.get(key);
  if (entry && Date.now() < entry.expires) return entry.data as T;
  return null;
}

function setCache(key: string, data: any, ttlSeconds: number): void {
  apiCache.set(key, { data, expires: Date.now() + ttlSeconds * 1000 });
}// ============================================================================
// DVF - MARKET KPIS (CSV data.gouv.fr)
// ============================================================================
interface DvfMarketKpisParams {
  lat: number;
  lon: number;
  radius_m: number;
  horizon_months: number;
  type_local?: string | null;
  commune_insee?: string | null;
  ttl_seconds?: number;
  debug?: boolean;
}

interface DvfMarketKpisResult {
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
}

async function dvfMarketKpis(params: DvfMarketKpisParams): Promise<DvfMarketKpisResult> {
  const { lat, lon, radius_m, horizon_months, type_local, commune_insee, ttl_seconds = 86400, debug } = params;
  
  const cacheKey = `dvf_csv_${lat.toFixed(4)}_${lon.toFixed(4)}_${radius_m}_${horizon_months}_${type_local || "all"}_${commune_insee || "none"}`;
  const cached = getCached<DvfMarketKpisResult>(cacheKey);
  if (cached) {
    console.log("📦 DVF from cache");
    return cached;
  }

  const allTransactions: any[] = [];
  const years = [2025, 2024, 2023, 2022];
  const loadedYears: number[] = [];
  
  for (const year of years) {
    try {
      const dept = commune_insee?.substring(0, 2) || "64";
      const url = `https://files.data.gouv.fr/geo-dvf/latest/csv/${year}/full.csv.gz`;
      
      // Fallback sur le département spécifique
      const deptUrl = `https://files.data.gouv.fr/geo-dvf/latest/csv/${year}/departements/${dept}.csv.gz`;
      
      // Essayer d'abord par département (plus léger)
      let resp = await fetch(deptUrl, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      
      if (!resp?.ok) {
        console.log(`⚠️ DVF ${year} dept ${dept} not available, skipping`);
        continue;
      }
      
      // Pour l'instant, on utilise la RPC Supabase si disponible
      if (supabase) {
        const { data, error } = await supabase.rpc("get_dvf_transactions_radius", {
          p_lat: lat,
          p_lon: lon,
          p_radius_m: radius_m,
          p_months: horizon_months,
          p_type_local: type_local || null,
        });
        
        if (!error && data && Array.isArray(data)) {
          allTransactions.push(...data);
          loadedYears.push(year);
          break; // RPC retourne déjà les données filtrées
        }
      }
      
      loadedYears.push(year);
    } catch (e) {
      console.warn(`DVF ${year} error:`, e);
    }
  }

  if (allTransactions.length === 0) {
    // Fallback RPC
    if (supabase) {
      const { data, error } = await supabase.rpc("get_dvf_transactions_radius", {
        p_lat: lat,
        p_lon: lon,
        p_radius_m: radius_m,
        p_months: horizon_months,
        p_type_local: type_local || null,
      });
      
      if (!error && data && Array.isArray(data) && data.length > 0) {
        allTransactions.push(...data);
      }
    }
  }

  if (allTransactions.length === 0) {
    const result: DvfMarketKpisResult = {
      provider: "dvf",
      source: "csv/rpc",
      coverage: "no_data",
      reason: "Aucune transaction trouvée",
      kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null },
      comps: [],
    };
    setCache(cacheKey, result, ttl_seconds);
    return result;
  }

  // Calculer les statistiques
  const prices = allTransactions
    .map((t: any) => t.price_m2 || (t.valeur_fonciere && t.surface_reelle_bati ? t.valeur_fonciere / t.surface_reelle_bati : null))
    .filter((p: any): p is number => p != null && p > 0 && p < 50000);
  
  prices.sort((a, b) => a - b);
  
  const n = prices.length;
  const median = n > 0 ? prices[Math.floor(n / 2)] : null;
  const avg = n > 0 ? prices.reduce((a, b) => a + b, 0) / n : null;
  const q1 = n >= 4 ? prices[Math.floor(n * 0.25)] : null;
  const q3 = n >= 4 ? prices[Math.floor(n * 0.75)] : null;

  const comps: MarketComp[] = allTransactions.slice(0, 20).map((t: any, i: number) => ({
    id: t.id_mutation || `${loadedYears[0] || 2024}-${i}`,
    address: t.adresse_nom_voie || t.adresse || "Adresse inconnue",
    price_m2: Math.round(t.price_m2 || (t.valeur_fonciere / t.surface_reelle_bati) || 0),
    surface_m2: t.surface_reelle_bati || t.surface || 0,
    date: t.date_mutation || t.date || "",
    type_local: t.type_local || "Inconnu",
    distance_m: Math.round(t.distance_m || 0),
    commune: t.nom_commune || t.commune || "",
  }));

  const result: DvfMarketKpisResult = {
    provider: "dvf",
    source: `csv:${loadedYears.join(",")}`,
    coverage: n > 0 ? "ok" : "no_data",
    kpis: {
      n,
      median_price_m2: median ? Math.round(median) : null,
      avg_price_m2: avg ? Math.round(avg) : null,
      q1_price_m2: q1 ? Math.round(q1) : null,
      q3_price_m2: q3 ? Math.round(q3) : null,
    },
    comps,
  };

  setCache(cacheKey, result, ttl_seconds);
  return result;
}

// ============================================================================
// CADASTRE - POINT RESOLUTION
// ============================================================================
interface ResolvedPoint {
  lat: number;
  lon: number;
  source: string;
  parcel_id?: string;
  commune_insee?: string;
  surface_m2?: number;
}

async function resolveMarketStudyPoint(payload: MarketStudyPayload): Promise<{ point: ResolvedPoint | null; error: string | null; debugResolve?: any }> {
  const { parcel_id, commune_insee } = payload;
  const debugInfo: any = { parcel_id, commune_insee, steps: [] };

  // 1. Par parcelle cadastrale
  if (parcel_id) {
    debugInfo.steps.push("trying_parcel");
    
    // API Carto IGN
    try {
      const url = `https://apicarto.ign.fr/api/cadastre/parcelle?code_insee=${parcel_id.substring(0, 5)}&section=${parcel_id.substring(5, 7)}&numero=${parcel_id.substring(7)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      
      if (resp.ok) {
        const data = await resp.json();
        if (data.features && data.features.length > 0) {
          const feature = data.features[0];
          const centroid = feature.geometry?.coordinates;
          
          if (centroid && feature.geometry.type === "Polygon") {
            // Calculer le centroïde
            const coords = feature.geometry.coordinates[0];
            let sumLat = 0, sumLon = 0;
            for (const c of coords) {
              sumLon += c[0];
              sumLat += c[1];
            }
            const lat = sumLat / coords.length;
            const lon = sumLon / coords.length;
            
            return {
              point: {
                lat,
                lon,
                source: "parcel",
                parcel_id,
                commune_insee: parcel_id.substring(0, 5),
                surface_m2: feature.properties?.contenance,
              },
              error: null,
              debugResolve: debugInfo,
            };
          }
        }
      }
    } catch (e) {
      debugInfo.steps.push({ parcel_error: String(e) });
    }

    // Fallback RPC Supabase
    if (supabase) {
      try {
        const { data, error } = await supabase.rpc("get_parcel_centroid", { p_parcel_id: parcel_id });
        if (!error && data) {
          return {
            point: {
              lat: data.lat,
              lon: data.lon,
              source: "parcel_rpc",
              parcel_id,
              commune_insee: data.commune_insee || parcel_id.substring(0, 5),
              surface_m2: data.surface_m2,
            },
            error: null,
            debugResolve: debugInfo,
          };
        }
      } catch (e) {
        debugInfo.steps.push({ rpc_error: String(e) });
      }
    }
  }

  // 2. Par commune INSEE (centre)
  if (commune_insee) {
    debugInfo.steps.push("trying_commune_center");
    try {
      const url = `https://geo.api.gouv.fr/communes/${commune_insee}?fields=centre,nom`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      
      if (resp.ok) {
        const data = await resp.json();
        if (data.centre?.coordinates) {
          return {
            point: {
              lat: data.centre.coordinates[1],
              lon: data.centre.coordinates[0],
              source: "commune_center",
              commune_insee: String(commune_insee),
            },
            error: null,
            debugResolve: debugInfo,
          };
        }
      }
    } catch (e) {
      debugInfo.steps.push({ commune_error: String(e) });
    }
  }

  return { point: null, error: "Impossible de résoudre les coordonnées", debugResolve: debugInfo };
}

async function resolveStandardPoint(payload: StandardPayload): Promise<{ point: ResolvedPoint | null; error: string | null; debugResolve?: any }> {
  const { address, cp, ville, parcel_id, commune_insee } = payload;
  
  // Priorité 1: Parcelle
  if (parcel_id) {
    const result = await resolveMarketStudyPoint({ mode: "market_study", parcel_id, project_nature: "standard" });
    if (result.point) return result;
  }

  // Priorité 2: Adresse via API Adresse
  if (address && (cp || ville)) {
    try {
      const q = encodeURIComponent(`${address} ${cp || ""} ${ville || ""}`);
      const url = `https://api-adresse.data.gouv.fr/search/?q=${q}&limit=1`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      
      if (resp.ok) {
        const data = await resp.json();
        if (data.features && data.features.length > 0) {
          const f = data.features[0];
          return {
            point: {
              lat: f.geometry.coordinates[1],
              lon: f.geometry.coordinates[0],
              source: "address",
              commune_insee: f.properties.citycode,
            },
            error: null,
          };
        }
      }
    } catch (e) {
      console.warn("Address resolution error:", e);
    }
  }

  // Priorité 3: Centre commune
  if (commune_insee) {
    return resolveMarketStudyPoint({ mode: "market_study", commune_insee, project_nature: "standard" });
  }

  return { point: null, error: "Impossible de résoudre les coordonnées" };
}

// ============================================================================
// ✅ INSEE ENRICHI - OpenDataSoft API
// ============================================================================
const ODS_INSEE_REVENUS = "insee-filosofi-revenus-pauvrete-menages-communes";
const ODS_INSEE_POP = "population-francaise-communes";
const ODS_INSEE_LOGEMENT = "logements-et-logements-vacants-par-commune";
const ODS_INSEE_EMPLOI = "taux-de-chomage-par-commune";

async function fetchInseeEnriched(codeCommune: string): Promise<InseeEnriched> {
  const result: InseeEnriched = {
    code_commune: codeCommune,
    commune: null,
    population: null,
    pct_moins_25: null,
    pct_plus_65: null,
    revenu_median: null,
    taux_pauvrete: null,
    nb_menages: null,
    pct_proprietaires: null,
    pct_locataires: null,
    taux_chomage: null,
    densite_pop: null,
  };

  // 1. Données de base depuis RPC Supabase (existant)
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("insee_communes_stats")
        .select("*")
        .eq("code_commune", codeCommune)
        .maybeSingle();
      
      if (!error && data) {
        result.commune = data.commune || data.nom_commune;
        result.population = data.population;
        result.pct_moins_25 = data.pct_moins_25;
        result.pct_plus_65 = data.pct_plus_65;
      }
    } catch (e) {
      console.warn("INSEE RPC error:", e);
    }
  }

  // 2. Revenus et pauvreté via OpenDataSoft
  try {
    const url = `https://public.opendatasoft.com/api/records/1.0/search/?dataset=${ODS_INSEE_REVENUS}&rows=1&refine.codgeo=${codeCommune}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    
    if (resp.ok) {
      const data = await resp.json();
      if (data.records && data.records.length > 0) {
        const fields = data.records[0].fields;
        result.revenu_median = fields.med || fields.q2 || fields.mediane || null;
        result.taux_pauvrete = fields.tp60 || fields.taux_pauvrete || null;
        result.nb_menages = fields.nbmenfisc || fields.nb_menages || null;
        if (!result.commune) result.commune = fields.libgeo || fields.libcom || null;
      }
    }
  } catch (e) {
    console.warn("INSEE revenus ODS error:", e);
  }

  // 3. Logement via OpenDataSoft
  try {
    const url = `https://public.opendatasoft.com/api/records/1.0/search/?dataset=${ODS_INSEE_LOGEMENT}&rows=1&refine.codgeo=${codeCommune}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    
    if (resp.ok) {
      const data = await resp.json();
      if (data.records && data.records.length > 0) {
        const fields = data.records[0].fields;
        result.pct_proprietaires = fields.part_prop || fields.pct_proprietaires || null;
        result.pct_locataires = fields.part_loc || fields.pct_locataires || null;
      }
    }
  } catch (e) {
    console.warn("INSEE logement ODS error:", e);
  }

  // 4. Chômage via OpenDataSoft
  try {
    const url = `https://public.opendatasoft.com/api/records/1.0/search/?dataset=${ODS_INSEE_EMPLOI}&rows=1&refine.codgeo=${codeCommune}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    
    if (resp.ok) {
      const data = await resp.json();
      if (data.records && data.records.length > 0) {
        const fields = data.records[0].fields;
        result.taux_chomage = fields.taux_chomage || fields.chomage || null;
      }
    }
  } catch (e) {
    console.warn("INSEE emploi ODS error:", e);
  }

  // 5. Fallback API Geo pour la population si manquante
  if (!result.population || !result.commune) {
    try {
      const url = `https://geo.api.gouv.fr/communes/${codeCommune}?fields=nom,population,surface`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      
      if (resp.ok) {
        const data = await resp.json();
        if (!result.commune) result.commune = data.nom;
        if (!result.population) result.population = data.population;
        if (data.surface && data.population) {
          result.densite_pop = Math.round(data.population / (data.surface / 100)); // hab/km²
        }
      }
    } catch (e) {
      console.warn("Geo API error:", e);
    }
  }

  return result;
}// ============================================================================
// BPE - ESSENTIAL SERVICES (via bpe-proxy)
// ============================================================================
async function fetchEssentialServicesRaw(
  lat: number,
  lon: number,
  radiusM: number,
  debug: boolean = false
): Promise<{ items: any[]; type_codes_sent: string[] }> {
  const typeCodes = Object.keys(ESSENTIAL_BUCKET_BY_TYPE_CODE);
  
  if (!supabase) {
    console.warn("⚠️ Supabase not available for bpe-proxy call");
    return { items: [], type_codes_sent: typeCodes };
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    
    const url = `${supabaseUrl}/functions/v1/bpe-proxy`;
    
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        lat,
        lon,
        radius_m: radiusM,
        type_codes: typeCodes,
        limit: 500,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      console.warn("bpe-proxy error:", resp.status);
      return { items: [], type_codes_sent: typeCodes };
    }

    const data = await resp.json();
    
    if (data.success && Array.isArray(data.items)) {
      console.log(`✅ bpe-proxy returned ${data.items.length} items`);
      return { items: data.items, type_codes_sent: typeCodes };
    }
    
    return { items: [], type_codes_sent: typeCodes };
  } catch (e) {
    console.error("bpe-proxy fetch error:", e);
    return { items: [], type_codes_sent: typeCodes };
  }
}

function buildEssentialServicesBlock(
  items: any[],
  radiusM: number,
  isRural: boolean
): EssentialServicesBlock {
  const radiusKm = metersToKm(radiusM);
  
  const emptyBucket = (): EssentialServiceBucket => ({
    radius_km: radiusKm,
    count: 0,
    nearest: null,
    top: [],
  });

  const block: EssentialServicesBlock = {
    zone_type: isRural ? "rural" : "urbain",
    radius_km: radiusKm,
    pharmacie: emptyBucket(),
    banque_agence: emptyBucket(),
    poste: emptyBucket(),
    station_service: emptyBucket(),
    commerce_alimentaire: emptyBucket(),
    medecin_generaliste: emptyBucket(),
    medecin_specialiste: emptyBucket(),
    dentiste: emptyBucket(),
    infirmier: emptyBucket(),
    kinesitherapeute: emptyBucket(),
    gendarmerie: emptyBucket(),
    commissariat: emptyBucket(),
  };

  // Grouper par bucket
  const bucketItems: Record<string, any[]> = {};
  for (const bucket of ALL_ESSENTIAL_BUCKETS) {
    bucketItems[bucket] = [];
  }

  for (const item of items) {
    const bucket = ESSENTIAL_BUCKET_BY_TYPE_CODE[item.type_code];
    if (bucket && bucketItems[bucket]) {
      bucketItems[bucket].push({
        type_code: item.type_code,
        nom: item.nom,
        distance_m: item.distance_m,
        distance_km: metersToKm(item.distance_m),
        commune: item.commune,
        code_commune: item.code_commune,
      });
    }
  }

  // Remplir chaque bucket
  for (const bucket of ALL_ESSENTIAL_BUCKETS) {
    const bucketData = bucketItems[bucket];
    if (bucketData.length > 0) {
      // Trier par distance
      bucketData.sort((a, b) => a.distance_m - b.distance_m);
      
      (block as any)[bucket] = {
        radius_km: radiusKm,
        count: bucketData.length,
        nearest: bucketData[0],
        top: bucketData.slice(0, 5),
      };
    }
  }

  return block;
}

// ============================================================================
// BPE STATS (pour scores commodités)
// ============================================================================
async function fetchBpeStats(
  lat: number,
  lon: number,
  radiusM: number,
  communeInsee: string | null,
  debug: boolean = false
): Promise<{ coverage: Coverage; scoreCommodites: number | null; totalEquipements: number; details: any }> {
  // Utiliser les données de bpe-proxy
  const { items } = await fetchEssentialServicesRaw(lat, lon, radiusM, debug);
  
  if (items.length === 0) {
    return {
      coverage: "no_data",
      scoreCommodites: null,
      totalEquipements: 0,
      details: {
        rayon_m: radiusM,
        score_sante: 0,
        sante_details: [],
        score_services: 0,
        score_commerces: 0,
        scoreCommodites: 0,
        nb_sante_proximite: 0,
        nb_services_proximite: 0,
        nb_commerces_proximite: 0,
        total_equipements_proximite: 0,
      },
    };
  }

  // Compter par catégorie
  let nbSante = 0, nbServices = 0, nbCommerces = 0;
  
  for (const item of items) {
    const code = item.type_code;
    if (code.startsWith("D")) nbSante++;
    else if (code.startsWith("A")) nbServices++;
    else if (code.startsWith("B")) nbCommerces++;
  }

  const total = items.length;
  
  // Score simple basé sur la couverture
  const scoreSante = Math.min(100, nbSante * 10);
  const scoreServices = Math.min(100, nbServices * 15);
  const scoreCommerces = Math.min(100, nbCommerces * 10);
  const scoreCommodites = Math.round((scoreSante + scoreServices + scoreCommerces) / 3);

  return {
    coverage: "ok",
    scoreCommodites,
    totalEquipements: total,
    details: {
      rayon_m: radiusM,
      score_sante: scoreSante,
      sante_details: [],
      score_services: scoreServices,
      score_commerces: scoreCommerces,
      scoreCommodites,
      nb_sante_proximite: nbSante,
      nb_services_proximite: nbServices,
      nb_commerces_proximite: nbCommerces,
      total_equipements_proximite: total,
      commerces_proches: items.filter(i => i.type_code.startsWith("B")).slice(0, 5),
      medecins_proches: items.filter(i => i.type_code === "D201").slice(0, 5),
    },
  };
}

// ============================================================================
// TRANSPORT SCORE
// ============================================================================
async function fetchTransportScore(
  lat: number,
  lon: number,
  communeInsee: string | null
): Promise<{ score: number | null; label: string; summary: string; coverage: Coverage; applicable: boolean }> {
  const isGrandeAgglo = isInGrandeAgglomeration(communeInsee);
  
  if (!isGrandeAgglo) {
    return {
      score: null,
      label: "Non applicable",
      summary: "Hors grande agglomération - critère non évalué",
      coverage: "ok",
      applicable: false,
    };
  }

  // Pour les grandes agglomérations, on pourrait appeler une API de transport
  // Pour l'instant, score par défaut basé sur la densité urbaine
  return {
    score: 70,
    label: "Bien desservi",
    summary: "Zone urbaine dense avec transports en commun",
    coverage: "ok",
    applicable: true,
  };
}

// ============================================================================
// ÉCOLES
// ============================================================================
async function fetchEcolesStats(lat: number, lon: number): Promise<{ data: any; coverage: Coverage }> {
  if (!supabase) {
    return { data: null, coverage: "not_covered" };
  }

  try {
    const { data, error } = await supabase.rpc("get_ecoles_nearby", {
      p_lat: lat,
      p_lon: lon,
      p_radius_m: 1000,
    });

    if (error) {
      console.warn("Ecoles RPC error:", error);
      return { data: null, coverage: "error" };
    }

    if (!data || (Array.isArray(data) && data.length === 0)) {
      return { data: null, coverage: "no_data" };
    }

    const ecoles = Array.isArray(data) ? data : [data];
    const nearest = ecoles[0];
    
    const count300m = ecoles.filter((e: any) => e.distance_m <= 300).length;
    const count500m = ecoles.filter((e: any) => e.distance_m <= 500).length;
    const count1000m = ecoles.length;

    // Score basé sur la proximité et la densité
    let scoreEcoles = 0;
    if (nearest && nearest.distance_m < 500) scoreEcoles += 50;
    else if (nearest && nearest.distance_m < 1000) scoreEcoles += 30;
    
    scoreEcoles += Math.min(50, count1000m * 10);

    return {
      data: {
        nearestDistanceM: nearest?.distance_m || null,
        nearestName: nearest?.nom || nearest?.name || null,
        nearestType: nearest?.type || "Ecole",
        count300m,
        count500m,
        count1000m,
        scoreEcoles: Math.min(100, scoreEcoles),
      },
      coverage: "ok",
    };
  } catch (e) {
    console.error("Ecoles error:", e);
    return { data: null, coverage: "error" };
  }
}

// ============================================================================
// SANTÉ - Health Fiche
// ============================================================================
async function fetchHealthFicheForCommune(codeCommune: string): Promise<{ data: any; coverage: Coverage }> {
  if (!supabase) {
    return { data: null, coverage: "not_covered" };
  }

  try {
    const { data, error } = await supabase
      .from("health_commune_stats")
      .select("*")
      .eq("code_commune", codeCommune)
      .maybeSingle();

    if (error) {
      console.warn("Health fiche error:", error);
      return { data: null, coverage: "error" };
    }

    return { data, coverage: data ? "ok" : "no_data" };
  } catch (e) {
    return { data: null, coverage: "error" };
  }
}

async function enrichHealthData(
  lat: number,
  lon: number,
  healthFiche: any,
  bpeSanteDetails: any,
  medecinsProches?: any[]
): Promise<HealthFicheEnriched | null> {
  const codeCommune = healthFiche?.code_commune || "";
  
  return {
    code_commune: codeCommune,
    commune: healthFiche?.commune || "",
    population: healthFiche?.population || null,
    densite_medecins_10000: healthFiche?.densite_medecins_10000 || null,
    desert_medical_score: healthFiche?.desert_medical_score || null,
    densite_label: healthFiche?.densite_label || "Données insuffisantes",
    professionnels_details: {
      medecins_generalistes: healthFiche?.nb_medecins_generalistes || 0,
      medecins_specialistes: healthFiche?.nb_medecins_specialistes || 0,
      dentistes: healthFiche?.nb_dentistes || 0,
      infirmiers: healthFiche?.nb_infirmiers || 0,
      kinesitherapeutes: healthFiche?.nb_kines || 0,
      pharmacies: healthFiche?.nb_pharmacies || 0,
      autres: healthFiche?.nb_autres || 0,
    },
    hopital_proche: healthFiche?.hopital_proche || null,
  };
}// ============================================================================
// ✅ SERVICES RURAUX - Build from Essential Services
// ============================================================================
function mapToServiceProche(item: ServiceEssentiel, type: string): ServiceProche {
  return {
    nom: item.nom || type,
    type: type,
    distance_km: item.distance_km,
    commune: item.commune || undefined,
  };
}

function mapToMedecinProche(item: ServiceEssentiel): MedecinProche {
  return {
    nom: item.nom || "Médecin",
    specialite: "Médecin généraliste",
    distance_km: item.distance_km,
    commune: item.commune || undefined,
  };
}

function buildServicesRurauxFromEssentialServices(es: EssentialServicesBlock): ServicesRuraux {
  const result: ServicesRuraux = {
    pharmacie_proche: null,
    supermarche_proche: null,
    hypermarche_proche: null,
    superette_proche: null,
    station_service_proche: null,
    poste_proche: null,
    banque_proche: null,
    commissariat_proche: null,
    gendarmerie_proche: null,
    medecin_proche: null,
    rayon_recherche_m: es.radius_km * 1000,
  };

  // Pharmacie
  if (es.pharmacie?.nearest) {
    result.pharmacie_proche = mapToServiceProche(es.pharmacie.nearest, "Pharmacie");
  }

  // Commerce alimentaire - identifier le type exact
  if (es.commerce_alimentaire?.nearest) {
    const nearest = es.commerce_alimentaire.nearest;
    const typeCode = nearest.type_code;
    const nom = nearest.nom || "Commerce alimentaire";
    
    if (typeCode === "B101") {
      result.hypermarche_proche = mapToServiceProche(nearest, "Hypermarché");
    } else if (typeCode === "B102") {
      result.supermarche_proche = mapToServiceProche(nearest, "Supermarché");
    } else if (typeCode === "B103") {
      result.superette_proche = mapToServiceProche(nearest, "Supérette");
    } else {
      // Boulangerie, boucherie, etc.
      result.supermarche_proche = mapToServiceProche(nearest, nom);
    }
  }

  // Médecin généraliste
  if (es.medecin_generaliste?.nearest) {
    result.medecin_proche = mapToMedecinProche(es.medecin_generaliste.nearest);
  }

  // Poste
  if (es.poste?.nearest) {
    result.poste_proche = mapToServiceProche(es.poste.nearest, "Bureau de poste");
  }

  // ✅ Banque (agence) - renommé
  if (es.banque_agence?.nearest) {
    result.banque_proche = mapToServiceProche(es.banque_agence.nearest, "Agence bancaire");
  }

  // Station service
  if (es.station_service?.nearest) {
    result.station_service_proche = mapToServiceProche(es.station_service.nearest, "Station-service");
  }

  // Gendarmerie
  if (es.gendarmerie?.nearest) {
    result.gendarmerie_proche = mapToServiceProche(es.gendarmerie.nearest, "Gendarmerie");
  }

  // Commissariat
  if (es.commissariat?.nearest) {
    result.commissariat_proche = mapToServiceProche(es.commissariat.nearest, "Commissariat");
  }

  return result;
}

// ============================================================================
// ✅ PROFESSIONNELS DE SANTÉ SUR LA COMMUNE
// ============================================================================
function countProfessionnelsSanteCommune(
  items: any[],
  communeInsee: string | null
): number {
  if (!communeInsee) return 0;
  
  let count = 0;
  const santeBuckets = ["medecin_generaliste", "medecin_specialiste", "dentiste", "infirmier", "kinesitherapeute", "pharmacie"];
  
  for (const item of items) {
    const bucket = ESSENTIAL_BUCKET_BY_TYPE_CODE[item.type_code];
    if (!bucket) continue;
    
    // Vérifier si sur la même commune
    if (item.code_commune === communeInsee && santeBuckets.includes(bucket)) {
      count++;
    }
  }
  
  return count;
}

// ============================================================================
// MARKET INDICES
// ============================================================================
interface MarketIndices {
  global_score: number;
  demand_index: number | null;
  supply_index: number | null;
  price_index: number | null;
  accessibility_index: number | null;
  risk_index: number | null;
}

function computeMarketIndices(
  dvfStats: DvfMarketStats | null,
  transportResult: any,
  bpeResult: any,
  ecolesResult: any,
  isRural: boolean
): MarketIndices {
  const items: Array<{ w: number; v: number | null }> = [];

  // Supply index (transactions)
  const supplyIndex = dvfStats ? computeIndex(dvfStats.transactions_count, 0, 100, false) : null;
  if (supplyIndex != null) items.push({ w: 0.25, v: supplyIndex });

  // Price index (normalisation inverse - prix bas = meilleur)
  const priceIndex = dvfStats?.price_median_eur_m2
    ? computeIndex(dvfStats.price_median_eur_m2, 2000, 10000, true)
    : null;
  if (priceIndex != null) items.push({ w: 0.25, v: priceIndex });

  // Accessibility (transport + écoles)
  let accessibilityIndex: number | null = null;
  if (transportResult.applicable && transportResult.score != null) {
    accessibilityIndex = transportResult.score;
  } else if (ecolesResult.data?.scoreEcoles != null) {
    accessibilityIndex = ecolesResult.data.scoreEcoles;
  }
  if (accessibilityIndex != null) items.push({ w: 0.25, v: accessibilityIndex });

  // Commodités
  const commoditesIndex = bpeResult.scoreCommodites;
  if (commoditesIndex != null) items.push({ w: 0.25, v: commoditesIndex });

  const globalScore = weightedAverage(items) ?? 50;

  return {
    global_score: Math.round(globalScore),
    demand_index: null, // À implémenter
    supply_index: supplyIndex,
    price_index: priceIndex,
    accessibility_index: accessibilityIndex,
    risk_index: null, // À implémenter
  };
}

// ============================================================================
// VERDICT
// ============================================================================
function generateMarketVerdict(
  indices: MarketIndices,
  projectNature: string,
  isRural: boolean,
  transportApplicable: boolean
): string {
  const score = indices.global_score;
  const zoneType = isRural ? "zone rurale" : "zone urbaine";
  const transportNote = !transportApplicable ? ", transport non évalué" : "";

  if (score >= 70) {
    return `Marché favorable pour un projet de ${projectNature} (${zoneType}${transportNote}). Bon potentiel de valorisation.`;
  } else if (score >= 50) {
    return `Marché équilibré pour un projet de ${projectNature} (${zoneType}${transportNote}). Analyse approfondie recommandée.`;
  } else {
    return `Marché tendu pour un projet de ${projectNature} (zone hors métropole${transportNote}). Vigilance requise sur le positionnement prix.`;
  }
}

// ============================================================================
// INSIGHTS
// ============================================================================
interface Insight {
  type: "positive" | "neutral" | "warning" | "negative";
  title: string;
  description: string;
  source: string;
}

function generateInsights(
  dvfStats: DvfMarketStats | null,
  servicesRuraux: ServicesRuraux | null,
  transportResult: any,
  ecolesResult: any,
  isRural: boolean,
  radiusKm: number
): Insight[] {
  const insights: Insight[] = [];

  // DVF
  if (dvfStats && dvfStats.transactions_count > 0) {
    insights.push({
      type: "neutral",
      title: `${dvfStats.transactions_count} transactions analysées`,
      description: `Marché actif avec ${dvfStats.transactions_count} ventes dans un rayon de ${radiusKm} km.`,
      source: "DVF",
    });

    if (dvfStats.price_median_eur_m2) {
      const formattedPrice = dvfStats.price_median_eur_m2.toLocaleString("fr-FR");
      const q1 = dvfStats.price_q1_eur_m2?.toLocaleString("fr-FR") || "N/A";
      const q3 = dvfStats.price_q3_eur_m2?.toLocaleString("fr-FR") || "N/A";
      
      insights.push({
        type: "neutral",
        title: `Prix médian : ${formattedPrice} €/m²`,
        description: `Intervalle (Q1–Q3) : ${q1} à ${q3} €/m².`,
        source: "DVF",
      });
    }
  }

  // Transport
  if (!transportResult.applicable) {
    insights.push({
      type: "neutral",
      title: "Transports en commun",
      description: "Zone hors grande agglomération - critère non évalué.",
      source: "Transport",
    });
  } else if (transportResult.score != null) {
    const type = transportResult.score >= 70 ? "positive" : transportResult.score >= 40 ? "neutral" : "warning";
    insights.push({
      type,
      title: `Transports : ${transportResult.label}`,
      description: transportResult.summary,
      source: "Transport",
    });
  }

  // Services ruraux
  const rayonKm = isRural ? 20 : 5;
  
  if (!servicesRuraux?.pharmacie_proche) {
    insights.push({
      type: "warning",
      title: "Aucune pharmacie trouvée",
      description: `Pas de pharmacie dans un rayon de ${rayonKm} km.`,
      source: "Services ruraux",
    });
  }

  if (!servicesRuraux?.supermarche_proche && !servicesRuraux?.hypermarche_proche && !servicesRuraux?.superette_proche) {
    insights.push({
      type: "warning",
      title: "Aucun commerce alimentaire trouvé",
      description: `Pas de commerce alimentaire dans un rayon de ${rayonKm} km.`,
      source: "Services ruraux",
    });
  }

  if (!servicesRuraux?.medecin_proche) {
    insights.push({
      type: "warning",
      title: "Aucun médecin généraliste trouvé",
      description: `Pas de médecin généraliste dans un rayon de ${rayonKm} km.`,
      source: "Services ruraux",
    });
  }

  // Écoles
  if (ecolesResult.data?.scoreEcoles != null) {
    const score = ecolesResult.data.scoreEcoles;
    const type = score >= 70 ? "positive" : score >= 40 ? "neutral" : "warning";
    insights.push({
      type,
      title: `${score >= 70 ? "Très bonne" : score >= 40 ? "Bonne" : "Faible"} accessibilité scolaire (${score}/100)`,
      description: `Basé sur la proximité et la densité d'établissements à 1 km.`,
      source: "Écoles",
    });
  }

  return insights;
}// ============================================================================
// TYPE LOCAL NORMALIZER
// ============================================================================
function normalizeStandardTypeLocal(typeLocal: string | undefined): string | null {
  if (!typeLocal) return null;
  const normalized = typeLocal.toLowerCase().trim();
  if (normalized.includes("maison")) return "Maison";
  if (normalized.includes("appartement")) return "Appartement";
  if (normalized.includes("local")) return "Local industriel. commercial ou assimilé";
  if (normalized.includes("terrain")) return "Terrain";
  return typeLocal;
}

// ============================================================================
// HANDLER - MARKET STUDY
// ============================================================================
async function handleMarketStudy(payload: MarketStudyPayload): Promise<Response> {
  const {
    parcel_id, commune_insee, project_nature,
    radius_km = 2, horizon_months = 12, targets, debug = false
  } = payload;

  console.log("🏪 [Market Study v3.19] payload:", { parcel_id, commune_insee, project_nature, debug });

  // 1. Résoudre le point
  const { point, error: pointError, debugResolve } = await resolveMarketStudyPoint(payload);
  if (!point) {
    return json({ success: false, error: pointError || "Impossible de résoudre le point", version: "v3.19" }, 400);
  }

  console.log("📍 Point résolu:", point);

  const communeInseeFinal = point.commune_insee || commune_insee?.toString() || null;
  const isRural = !isInGrandeAgglomeration(communeInseeFinal);
  const zoneType: "rural" | "urbain" = isRural ? "rural" : "urbain";

  console.log(`🏘️ Zone: ${zoneType.toUpperCase()}`);

  // 2. DVF
  const dvfTypeLocal = null; // Market study = tous types
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

  const dvfStats: DvfMarketStats | null = dvfApi.coverage === "ok" ? {
    transactions_count: dvfApi.kpis.n,
    transactions_count_previous: 0,
    price_median_eur_m2: dvfApi.kpis.median_price_m2,
    price_mean_eur_m2: dvfApi.kpis.avg_price_m2,
    price_q1_eur_m2: dvfApi.kpis.q1_price_m2,
    price_q3_eur_m2: dvfApi.kpis.q3_price_m2,
    evolution_pct: null,
    volume_total_eur: null,
    surface_mean_m2: null,
  } : null;

  // 3. Transport
  const transportResult = await fetchTransportScore(point.lat, point.lon, communeInseeFinal);

  // 4. BPE Stats
  const bpeRadius = isRural ? RAYON_RURAL_MIN_M : RAYON_URBAIN_M;
  const bpeResult = await fetchBpeStats(point.lat, point.lon, bpeRadius, communeInseeFinal, debug);

  // 5. Écoles
  const ecolesResult = await fetchEcolesStats(point.lat, point.lon);

  // 6. ✅ INSEE enrichi
  const inseeResult = communeInseeFinal 
    ? await fetchInseeEnriched(communeInseeFinal)
    : null;

  // 7. Essential Services (via bpe-proxy)
  const essentialServicesRadius = isRural ? RAYON_RURAL_MAX_M : RAYON_URBAIN_M;
  const essentialServicesRawResult = await fetchEssentialServicesRaw(point.lat, point.lon, essentialServicesRadius, debug);
  const essentialServices = buildEssentialServicesBlock(essentialServicesRawResult.items, essentialServicesRadius, isRural);

  // 8. Services Ruraux (depuis essential_services)
  const servicesRuraux = buildServicesRurauxFromEssentialServices(essentialServices);
  console.log("🏘️ services_ruraux construit depuis essential_services");

  // 9. ✅ Professionnels de santé sur la commune
  const profSanteCommune = countProfessionnelsSanteCommune(essentialServicesRawResult.items, communeInseeFinal);

  // 10. Health Summary
  const healthFiche = communeInseeFinal ? await fetchHealthFicheForCommune(communeInseeFinal) : { data: null, coverage: "not_covered" as Coverage };
  const healthSummary = await enrichHealthData(
    point.lat, point.lon,
    { ...healthFiche.data, code_commune: communeInseeFinal, commune: inseeResult?.commune, population: inseeResult?.population },
    bpeResult.details?.sante_details,
    bpeResult.details?.medecins_proches
  );

  // 11. Calcul des indices
  const indices = computeMarketIndices(dvfStats, transportResult, bpeResult, ecolesResult, isRural);
  const verdict = generateMarketVerdict(indices, project_nature, isRural, transportResult.applicable);
  const insights = generateInsights(dvfStats, servicesRuraux, transportResult, ecolesResult, isRural, radius_km);

  // 12. KPIs
  const rayonKm = isRural ? 20 : 5;
  const kpis: any[] = [
    { label: "Score global", value: indices.global_score, unit: "/100", description: verdict },
    { label: "Transactions (DVF)", value: dvfStats?.transactions_count || null, description: `Dans un rayon de ${radius_km} km` },
    { label: "Prix médian", value: dvfStats?.price_median_eur_m2 || null, unit: "€/m²" },
    { label: "Écoles", value: ecolesResult.data?.nearestDistanceM ? Math.round(ecolesResult.data.nearestDistanceM) : null, unit: "m", description: ecolesResult.data ? `${ecolesResult.data.nearestName} · ${ecolesResult.data.count1000m} établissements dans 1 km` : "Aucune donnée" },
  ];

  // Pharmacie
  if (servicesRuraux.pharmacie_proche) {
    kpis.push({ label: "Pharmacie", value: servicesRuraux.pharmacie_proche.distance_km, unit: "km", description: `${servicesRuraux.pharmacie_proche.nom} (${servicesRuraux.pharmacie_proche.commune || ""})` });
  } else {
    kpis.push({ label: "Pharmacie", value: null, unit: "km", description: `Aucune dans ${rayonKm} km` });
  }

  // Commerce alimentaire
  const commerceAlim = servicesRuraux.supermarche_proche || servicesRuraux.hypermarche_proche || servicesRuraux.superette_proche;
  if (commerceAlim) {
    kpis.push({ label: "Commerce alimentaire", value: commerceAlim.distance_km, unit: "km", description: `${commerceAlim.type}: ${commerceAlim.nom} (${commerceAlim.commune || ""})` });
  } else {
    kpis.push({ label: "Commerce alimentaire", value: null, unit: "km", description: `Aucun dans ${rayonKm} km` });
  }

  // Médecin
  if (servicesRuraux.medecin_proche) {
    kpis.push({ label: "Médecin généraliste", value: servicesRuraux.medecin_proche.distance_km, unit: "km", description: `${servicesRuraux.medecin_proche.nom} (${servicesRuraux.medecin_proche.commune || ""})` });
  } else {
    kpis.push({ label: "Médecin généraliste", value: null, unit: "km", description: `Aucun dans ${rayonKm} km` });
  }

  // Poste
  if (servicesRuraux.poste_proche) {
    kpis.push({ label: "Poste", value: servicesRuraux.poste_proche.distance_km, unit: "km", description: `${servicesRuraux.poste_proche.type}: ${servicesRuraux.poste_proche.nom} (${servicesRuraux.poste_proche.commune || ""})` });
  } else {
    kpis.push({ label: "Poste", value: null, unit: "km", description: `Aucun dans ${rayonKm} km` });
  }

  // ✅ Agence bancaire (renommé)
  if (servicesRuraux.banque_proche) {
    kpis.push({ label: "Agence bancaire", value: servicesRuraux.banque_proche.distance_km, unit: "km", description: `${servicesRuraux.banque_proche.nom} (${servicesRuraux.banque_proche.commune || ""})` });
  } else {
    kpis.push({ label: "Agence bancaire", value: null, unit: "km", description: `Aucune dans ${rayonKm} km` });
  }

  // Station service (rural only)
  if (isRural && servicesRuraux.station_service_proche) {
    kpis.push({ label: "Station service", value: servicesRuraux.station_service_proche.distance_km, unit: "km", description: `${servicesRuraux.station_service_proche.nom} (${servicesRuraux.station_service_proche.commune || ""})` });
  }

  // Population
  kpis.push({ label: "Population", value: inseeResult?.population || null, description: "Population communale (INSEE)" });

  // ✅ Professionnels de santé sur la commune (calculé)
  kpis.push({
    label: "Professionnels de santé (commune)",
    value: profSanteCommune > 0 ? profSanteCommune : 0,
    description: profSanteCommune > 0 ? `${profSanteCommune} sur la commune` : "Aucun sur la commune"
  });

  // ✅ INSEE enrichi - Revenus si disponible
  if (inseeResult?.revenu_median) {
    kpis.push({ label: "Revenu médian", value: inseeResult.revenu_median, unit: "€/an", description: "Revenu médian des ménages" });
  }

  // ❌ SUPPRIMÉ: Établissements seniors / EHPAD

  // 13. Output
  const output: any = {
    success: true,
    version: "v3.19",
    orchestrator: "smartscore-enriched-v3",
    mode: "market_study",
    zone_type: zoneType,
    input: {
      parcel_id: parcel_id || null,
      commune_insee: communeInseeFinal,
      project_nature,
      radius_km,
      horizon_months,
      targets: targets || null,
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
      dvf: { coverage: dvfApi.coverage, reason: dvfApi.reason || null, source: dvfApi.source },
      prices: dvfStats ? { median_eur_m2: dvfStats.price_median_eur_m2, mean_eur_m2: dvfStats.price_mean_eur_m2, q1_eur_m2: dvfStats.price_q1_eur_m2, q3_eur_m2: dvfStats.price_q3_eur_m2 } : null,
      transactions: dvfStats ? { count: dvfStats.transactions_count, count_previous: 0 } : null,
      transport: transportResult,
      ecoles: ecolesResult.data,
      bpe: bpeResult.details,
      bpeCoverage: bpeResult.coverage,
      commoditesScore: bpeResult.scoreCommodites,
      commerces_proches: bpeResult.details?.commerces_proches || [],
      medecins_proches: bpeResult.details?.medecins_proches || [],
      essential_services: essentialServices,
      services_ruraux: servicesRuraux,
      healthSummary,
      // ✅ INSEE enrichi
      insee: inseeResult,
      kpis,
      insights,
      comps: dvfApi.comps,
    },
  };

  if (debug) {
    output.debug = {
      timestamp: new Date().toISOString(),
      dvfApi,
      transportResult,
      bpeResult,
      ecolesResult,
      servicesRuraux,
      profSanteCommune,
      isInGrandeAgglomeration: !isRural,
      bpeRadius,
      essential_services_debug: {
        radius_m: essentialServicesRadius,
        radius_km: metersToKm(essentialServicesRadius),
        type_codes_sent_count: essentialServicesRawResult.type_codes_sent.length,
        raw_items_count: essentialServicesRawResult.items.length,
      },
    };
  }

  console.log("✅ market_study response ready, score:", indices.global_score);
  return json(output, 200);
}

// ============================================================================
// HANDLER - STANDARD (simplifié)
// ============================================================================
async function handleStandard(payload: StandardPayload): Promise<Response> {
  console.log("📦 [Standard v3.19] - redirect to market_study logic");
  
  // Convertir en market_study payload
  const marketPayload: MarketStudyPayload = {
    mode: "market_study",
    parcel_id: payload.parcel_id,
    commune_insee: payload.commune_insee || payload.commune_code,
    project_nature: payload.type_local || "logement",
    radius_km: payload.radius_km || 2,
    horizon_months: payload.horizon_months || 24,
    debug: payload.debug,
  };

  return handleMarketStudy(marketPayload);
}

// ============================================================================
// JSON HELPER
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
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const payload = await req.json().catch(() => null);
    console.log("📥 Reçu enriched-v3 (v3.19):", payload);

    if (!payload) {
      return json({ success: false, error: "Invalid JSON" }, 400);
    }

    if ((payload as any).mode === "market_study") {
      console.log("🏪 Mode market_study détecté → routage enrichi v3.19");
      return await handleMarketStudy(payload as MarketStudyPayload);
    }

    console.log("📦 Mode standard détecté → routage standard v3.19");
    return await handleStandard(payload as StandardPayload);
  } catch (err) {
    console.error("❌ Internal error enriched-v3 (v3.19):", err);
    return json({ success: false, error: "Internal error", details: String(err), version: "v3.19" }, 500);
  }
});