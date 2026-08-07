// ============================================================================
// MARKET STUDY PROMOTEUR V1 - VERSION 1.3.21
// ============================================================================
// CHANGEMENTS v1.3.21:
// - FEATURE DVF : calcul de evolution_prix_pct par comparaison de deux périodes
//   glissantes (médiane 0-12 mois vs médiane 12-24 mois). Minimum 5 transactions
//   par période requis ; valeurs aberrantes (|écart| > 50%) rejetées → null.
//   → 3 requêtes Supabase parallèles (récente, ancienne, toutes+absorption)
//   → log console [DVF] avec détail des deux médianes
//
// CHANGEMENTS v1.3.20:
// - AJOUT absorption_mensuelle + absorption_annuelle dans DvfData
//   → Calculé via COUNT sur 12 mois glissants sur le département
//   → Exposé dans les insights avec qualification du marché
//
// CHANGEMENTS v1.3.19:
// - FIX SCORING : Suppression du pilier Accessibilité/Transport pour les communes
//   non-urbaines (population < 50 000 et aucun arrêt Overpass trouvé).
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

type ProjectType = 'logement' | 'commerce' | 'bureaux' | 'hotel' | 'residence_etudiante' | 'ehpad';
type Coverage = 'ok' | 'no_data' | 'partial' | 'error';

const VERSION = "1.3.24";
const GEO_API_BASE = "https://geo.api.gouv.fr";
const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const BAN_API_URL = "https://api-adresse.data.gouv.fr";

async function queryOverpass(query: string): Promise<Response> {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) return res;
      console.warn(`[Overpass] ${endpoint} → ${res.status}`);
    } catch (e) {
      console.warn(`[Overpass] ${endpoint} → timeout/erreur`);
    }
  }
  throw new Error("Tous les endpoints Overpass ont échoué");
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============================================================================
// PROJECT CONFIG avec SCORING DIFFÉRENCIÉ
// ============================================================================

interface ScoringWeights {
  demande: number;
  offre: number;
  accessibilite: number;
  environnement: number;
}

interface ProjectConfig {
  label: string;
  defaultRadiusKm: number;
  maxRadiusKm: number;
  weights: ScoringWeights;
  description: string;
}

const PROJECT_CONFIG: Record<ProjectType, ProjectConfig> = {
  logement: {
    label: "Logement",
    defaultRadiusKm: 5,
    maxRadiusKm: 10,
    weights: { demande: 0.30, offre: 0.25, accessibilite: 0.25, environnement: 0.20 },
    description: "Résidentiel - Pondération équilibrée",
  },
  commerce: {
    label: "Commerce",
    defaultRadiusKm: 3,
    maxRadiusKm: 5,
    weights: { demande: 0.35, offre: 0.15, accessibilite: 0.25, environnement: 0.25 },
    description: "Commerce - Focus pouvoir d'achat et flux",
  },
  bureaux: {
    label: "Bureaux",
    defaultRadiusKm: 3,
    maxRadiusKm: 5,
    weights: { demande: 0.20, offre: 0.20, accessibilite: 0.45, environnement: 0.15 },
    description: "Bureaux - Accessibilité prioritaire",
  },
  hotel: {
    label: "Hôtel",
    defaultRadiusKm: 5,
    maxRadiusKm: 10,
    weights: { demande: 0.30, offre: 0.25, accessibilite: 0.30, environnement: 0.15 },
    description: "Hôtel - Accessibilité et attractivité",
  },
  residence_etudiante: {
    label: "Résidence étudiante",
    defaultRadiusKm: 5,
    maxRadiusKm: 10,
    weights: { demande: 0.35, offre: 0.20, accessibilite: 0.30, environnement: 0.15 },
    description: "Étudiant - Pop jeune et transports",
  },
  ehpad: {
    label: "EHPAD / Résidence senior",
    defaultRadiusKm: 20,
    maxRadiusKm: 30,
    weights: { demande: 0.40, offre: 0.30, accessibilite: 0.15, environnement: 0.15 },
    description: "EHPAD - Pop senior et équipement zone",
  },
};

// ============================================================================
// DONNÉES DE RÉFÉRENCE STATIQUES
// ============================================================================

const TAUX_CHOMAGE_DEPT: Record<string, number> = {
  "75": 6.5, "92": 6.8, "78": 5.9, "69": 6.8, "13": 9.2, "31": 7.5, "33": 7.8, "06": 7.2,
  "59": 9.5, "62": 10.2, "93": 10.8, "95": 8.2, "default": 7.5
};

const REVENU_MEDIAN_DEPT_FALLBACK: Record<string, number> = {
  "01": 23800, "02": 20900, "03": 20600, "04": 21500, "05": 22100,
  "06": 26200, "07": 20900, "08": 21000, "09": 19800, "10": 21800,
  "11": 19800, "12": 21200, "13": 22000, "14": 22500, "15": 21400,
  "16": 20600, "17": 21600, "18": 20600, "19": 21000, "21": 22700,
  "22": 21400, "23": 19200, "24": 20500, "25": 23100, "26": 22000,
  "27": 22000, "28": 22800, "29": 22000, "30": 21000, "31": 23100,
  "32": 20500, "33": 23100, "34": 22000, "35": 23500, "36": 20200,
  "37": 22300, "38": 24200, "39": 22400, "40": 22100, "41": 22100,
  "42": 22000, "43": 21300, "44": 24100, "45": 22600, "46": 20700,
  "47": 20600, "48": 20600, "49": 22800, "50": 22200, "51": 23400,
  "52": 21200, "53": 22000, "54": 22100, "55": 20800, "56": 22500,
  "57": 22200, "58": 21000, "59": 21800, "60": 23200, "61": 21200,
  "62": 20800, "63": 22200, "64": 23200, "65": 21200, "66": 20200,
  "67": 24000, "68": 23300, "69": 25500, "70": 21600, "71": 21700,
  "72": 22300, "73": 23500, "74": 26800, "75": 27500, "76": 22600,
  "77": 25900, "78": 29200, "79": 21600, "80": 21100, "81": 20900,
  "82": 20700, "83": 24000, "84": 22900, "85": 22700, "86": 21900,
  "87": 20900, "88": 21300, "89": 21400, "90": 22600, "91": 26800,
  "92": 33500, "93": 20500, "94": 27000, "95": 24900,
  "2A": 21000, "2B": 20500,
  "971": 18500, "972": 18800, "973": 16500, "974": 18000, "976": 14500,
  "default": 22000,
};

const DEMOGRAPHICS_DEPT: Record<string, {
  pct_moins_15: number; pct_15_29: number; pct_30_44: number;
  pct_45_59: number; pct_60_74: number; pct_75_plus: number;
  pct_etudiants: number; pct_actifs: number
}> = {
  "75": { pct_moins_15: 14, pct_15_29: 22, pct_30_44: 24, pct_45_59: 18, pct_60_74: 13, pct_75_plus: 9, pct_etudiants: 12, pct_actifs: 52 },
  "69": { pct_moins_15: 18, pct_15_29: 20, pct_30_44: 22, pct_45_59: 19, pct_60_74: 13, pct_75_plus: 8, pct_etudiants: 10, pct_actifs: 48 },
  "31": { pct_moins_15: 18, pct_15_29: 21, pct_30_44: 22, pct_45_59: 18, pct_60_74: 13, pct_75_plus: 8, pct_etudiants: 11, pct_actifs: 49 },
  "33": { pct_moins_15: 17, pct_15_29: 18, pct_30_44: 20, pct_45_59: 20, pct_60_74: 15, pct_75_plus: 10, pct_etudiants: 8, pct_actifs: 46 },
  "34": { pct_moins_15: 17, pct_15_29: 19, pct_30_44: 19, pct_45_59: 19, pct_60_74: 16, pct_75_plus: 10, pct_etudiants: 9, pct_actifs: 44 },
  "92": { pct_moins_15: 18, pct_15_29: 18, pct_30_44: 24, pct_45_59: 20, pct_60_74: 12, pct_75_plus: 8, pct_etudiants: 8, pct_actifs: 52 },
  "93": { pct_moins_15: 22, pct_15_29: 20, pct_30_44: 22, pct_45_59: 18, pct_60_74: 11, pct_75_plus: 7, pct_etudiants: 7, pct_actifs: 46 },
  "94": { pct_moins_15: 20, pct_15_29: 18, pct_30_44: 22, pct_45_59: 20, pct_60_74: 12, pct_75_plus: 8, pct_etudiants: 7, pct_actifs: 48 },
  "06": { pct_moins_15: 15, pct_15_29: 14, pct_30_44: 17, pct_45_59: 20, pct_60_74: 20, pct_75_plus: 14, pct_etudiants: 5, pct_actifs: 40 },
  "83": { pct_moins_15: 16, pct_15_29: 13, pct_30_44: 17, pct_45_59: 21, pct_60_74: 20, pct_75_plus: 13, pct_etudiants: 4, pct_actifs: 40 },
  "23": { pct_moins_15: 14, pct_15_29: 11, pct_30_44: 14, pct_45_59: 22, pct_60_74: 23, pct_75_plus: 16, pct_etudiants: 2, pct_actifs: 38 },
  "03": { pct_moins_15: 15, pct_15_29: 12, pct_30_44: 15, pct_45_59: 22, pct_60_74: 22, pct_75_plus: 14, pct_etudiants: 3, pct_actifs: 39 },
  "default": { pct_moins_15: 18, pct_15_29: 16, pct_30_44: 19, pct_45_59: 20, pct_60_74: 17, pct_75_plus: 10, pct_etudiants: 6, pct_actifs: 45 },
};

// ============================================================================
// BPE TYPE CODES MAPPING
// ============================================================================

const BPE_TYPES: Record<string, { label: string; category: 'commerces' | 'sante' | 'services' | 'education' | 'loisirs' }> = {
  'A101': { label: 'Police', category: 'services' },
  'A104': { label: 'Gendarmerie', category: 'services' },
  'A203': { label: 'Banque', category: 'services' },
  'A206': { label: 'Bureau de poste', category: 'services' },
  'A207': { label: 'Relais poste', category: 'services' },
  'A208': { label: 'Agence postale', category: 'services' },
  'B101': { label: 'Hypermarché', category: 'commerces' },
  'B102': { label: 'Supermarché', category: 'commerces' },
  'B103': { label: 'Grande surface bricolage', category: 'commerces' },
  'B104': { label: 'Supérette', category: 'commerces' },
  'B105': { label: 'Épicerie', category: 'commerces' },
  'B201': { label: 'Boulangerie', category: 'commerces' },
  'B202': { label: 'Boucherie', category: 'commerces' },
  'B206': { label: 'Librairie', category: 'commerces' },
  'B207': { label: 'Magasin vêtements', category: 'commerces' },
  'B304': { label: 'Magasin électroménager', category: 'commerces' },
  'B305': { label: 'Magasin meubles', category: 'commerces' },
  'B311': { label: 'Station service', category: 'commerces' },
  'C101': { label: 'École maternelle', category: 'education' },
  'C102': { label: 'École maternelle RPI', category: 'education' },
  'C104': { label: 'École élémentaire', category: 'education' },
  'C105': { label: 'École élémentaire RPI', category: 'education' },
  'C201': { label: 'Collège', category: 'education' },
  'C301': { label: 'Lycée général', category: 'education' },
  'C302': { label: 'Lycée technologique', category: 'education' },
  'C303': { label: 'Lycée professionnel', category: 'education' },
  'C401': { label: 'STS-CPGE', category: 'education' },
  'C402': { label: 'Formation santé', category: 'education' },
  'C403': { label: 'Formation commerce', category: 'education' },
  'C409': { label: 'UFR', category: 'education' },
  'C501': { label: 'Institut universitaire', category: 'education' },
  'C502': { label: 'École ingénieurs', category: 'education' },
  'C503': { label: 'Enseignement général supérieur', category: 'education' },
  'C504': { label: 'EPCI', category: 'education' },
  'C509': { label: 'Autre enseignement supérieur', category: 'education' },
  'D101': { label: 'Hôpital', category: 'sante' },
  'D102': { label: 'Hôpital de proximité', category: 'sante' },
  'D103': { label: 'Clinique', category: 'sante' },
  'D106': { label: 'Urgences', category: 'sante' },
  'D107': { label: 'Maternité', category: 'sante' },
  'D108': { label: 'Centre de santé', category: 'sante' },
  'D201': { label: 'Médecin généraliste', category: 'sante' },
  'D202': { label: 'Spécialiste', category: 'sante' },
  'D206': { label: 'Chirurgien-dentiste', category: 'sante' },
  'D221': { label: 'Dentiste', category: 'sante' },
  'D232': { label: 'Infirmier', category: 'sante' },
  'D233': { label: 'Kinésithérapeute', category: 'sante' },
  'D301': { label: 'Pharmacie', category: 'sante' },
  'D302': { label: 'Laboratoire', category: 'sante' },
  'D307': { label: 'EHPAD', category: 'sante' },
  'F101': { label: 'Bassin de natation', category: 'loisirs' },
  'F102': { label: 'Boulodrome', category: 'loisirs' },
  'F103': { label: 'Tennis', category: 'loisirs' },
  'F104': { label: 'Équipement athlétisme', category: 'loisirs' },
  'F106': { label: 'Terrain de foot', category: 'loisirs' },
  'F107': { label: 'Salle multisports', category: 'loisirs' },
  'F108': { label: 'Salle de combat', category: 'loisirs' },
  'F109': { label: 'Salle fitness', category: 'loisirs' },
  'F111': { label: 'Roller-Skate', category: 'loisirs' },
  'F112': { label: 'Sports nautiques', category: 'loisirs' },
  'F113': { label: 'Terrain de golf', category: 'loisirs' },
  'F114': { label: 'Équitation', category: 'loisirs' },
  'F116': { label: 'Cinéma', category: 'loisirs' },
  'F117': { label: 'Théâtre', category: 'loisirs' },
  'F303': { label: 'Musée', category: 'loisirs' },
  'F306': { label: 'Bibliothèque', category: 'loisirs' },
};

const RAYON_BPE_M = 5000;
const OPENDATASOFT_BPE_API = "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/buildingref-france-bpe-all-geolocated/records";
const FISCALITE_API = "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/fiscalite-locale-des-particuliers-geo/records";
const POPULATION_API = "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/population-francaise-communes/records";

const COMMUNES_AVEC_ARRONDISSEMENTS = new Set(["75056", "69123", "13055"]);
const URBAN_POP_THRESHOLD = 50_000;

// ============================================================================
// SUPABASE CLIENT
// ============================================================================

function getSupabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key);
}

// ============================================================================
// UTILITIES
// ============================================================================

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function safeNum(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === "number") return isNaN(val) ? null : val;
  const str = String(val).replace(",", ".").trim();
  if (!str) return null;
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

function normalizeProjectType(input: string | null | undefined): ProjectType {
  if (!input) return "logement";
  const n = input.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (n.includes("ehpad") || n.includes("retraite") || n.includes("senior") || n === "rss" || n.includes("residence_senior")) return "ehpad";
  if (n.includes("etudiant") || n === "residence_etudiante") return "residence_etudiante";
  if (n === "hotel" || n === "hotellerie") return "hotel";
  if (n === "bureaux" || n === "bureau" || n === "office") return "bureaux";
  if (n === "commerce" || n === "retail") return "commerce";
  return "logement";
}

// ============================================================================
// GEOCODING
// ============================================================================

interface GeocodedLocation {
  lat: number;
  lon: number;
  source: 'address' | 'insee' | 'parcel' | 'coordinates';
  label?: string;
}

async function geocodeAddress(address: string): Promise<GeocodedLocation | null> {
  try {
    const url = `${BAN_API_URL}/search/?q=${encodeURIComponent(address)}&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.features?.length) return null;
    const feature = data.features[0];
    const [lon, lat] = feature.geometry.coordinates;
    return { lat, lon, source: 'address', label: feature.properties?.label || address };
  } catch { return null; }
}

async function geocodeInseeCode(codeInsee: string): Promise<GeocodedLocation | null> {
  try {
    const url = `${GEO_API_BASE}/communes/${codeInsee}?fields=centre,nom&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.centre?.coordinates) return null;
    const [lon, lat] = data.centre.coordinates;
    return { lat, lon, source: 'insee', label: data.nom || codeInsee };
  } catch { return null; }
}

async function geocodeParcel(parcelId: string): Promise<GeocodedLocation | null> {
  try {
    const cleanId = parcelId.replace(/\s/g, '').toUpperCase();
    const codeInsee = cleanId.substring(0, 5);
    const communeGeo = await geocodeInseeCode(codeInsee);
    if (communeGeo) return { ...communeGeo, source: 'parcel', label: `Parcelle ${parcelId}` };
    return null;
  } catch { return null; }
}

async function resolveCoordinates(payload: {
  lat?: number; lon?: number; address?: string;
  commune_insee?: string; code_insee?: string;
  parcel_id?: string; zipCode?: string; city?: string;
}): Promise<GeocodedLocation | null> {
  if (typeof payload.lat === 'number' && typeof payload.lon === 'number' && !isNaN(payload.lat) && !isNaN(payload.lon)) {
    return { lat: payload.lat, lon: payload.lon, source: 'coordinates' };
  }
  if (payload.address && payload.address.trim().length > 3) {
    const result = await geocodeAddress(payload.address);
    if (result) return result;
  }
  if (payload.zipCode && payload.city) {
    const result = await geocodeAddress(`${payload.city}, ${payload.zipCode}`);
    if (result) return result;
  }
  if (payload.parcel_id && payload.parcel_id.length >= 10) {
    const result = await geocodeParcel(payload.parcel_id);
    if (result) return result;
  }
  const inseeCode = payload.commune_insee || payload.code_insee;
  if (inseeCode && inseeCode.length === 5) {
    const result = await geocodeInseeCode(inseeCode);
    if (result) return result;
  }
  return null;
}

// ============================================================================
// COMMUNE RESOLUTION
// ============================================================================

interface CommuneInfo {
  code_insee: string;
  nom: string | null;
  departement: string | null;
  region: string | null;
  population: number | null;
}

async function resolveCommune(lat: number, lon: number): Promise<CommuneInfo | null> {
  try {
    const url = `${GEO_API_BASE}/communes?lat=${lat}&lon=${lon}&fields=code,nom,departement,region,population&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.length) return null;
    const c = data[0];
    return {
      code_insee: c.code,
      nom: c.nom,
      departement: c.departement?.code,
      region: c.region?.nom,
      population: c.population,
    };
  } catch { return null; }
}

// ============================================================================
// DVF FROM SUPABASE — v1.3.21 : + evolution_prix_pct sur périodes glissantes
// ============================================================================

interface DvfData {
  nb_transactions: number;        // échantillon analysé (cappé à 500)
  nb_transactions_total: number;  // vrai total sur la zone
  prix_m2_median: number | null;
  prix_m2_moyen: number | null;
  prix_m2_min: number | null;
  prix_m2_max: number | null;
  evolution_prix_pct: number | null;
  // v1.3.20 : absorption du marché sur 12 mois glissants (périmètre département)
  absorption_mensuelle: number | null;
  absorption_annuelle: number | null;
  horizon_mois_absorption: number;
  transactions: Array<{
    date_mutation: string;
    valeur_fonciere: number;
    surface_reelle_bati: number | null;
    type_local: string;
    commune: string;
    prix_m2: number | null;
  }>;
  coverage: Coverage;
}

async function fetchDvfFromSupabase(dept: string | null, communeNom: string | null, codeInsee: string | null = null): Promise<DvfData> {
  const empty: DvfData = {
    nb_transactions: 0, nb_transactions_total: 0, prix_m2_median: null, prix_m2_moyen: null,
    prix_m2_min: null, prix_m2_max: null, evolution_prix_pct: null,
    absorption_mensuelle: null, absorption_annuelle: null, horizon_mois_absorption: 12,
    transactions: [], coverage: "no_data"
  };

  if (!dept) return empty;

  try {
    const supabase = getSupabaseClient();
    const HORIZON_MOIS = 12;

    // Conversion code INSEE arrondissement → code_commune DVF (vérifié en base).
    // Paris 75116→116 | Lyon 69386→386 | Marseille 13216→216
    let dvfCommuneCode: string | null = null;
    if (codeInsee && codeInsee.length === 5) {
      const dep = codeInsee.substring(0, 2);
      if (dep === "75") dvfCommuneCode = "1" + codeInsee.substring(3);
      else if (dep === "69") dvfCommuneCode = "3" + codeInsee.substring(3);
      else if (dep === "13") dvfCommuneCode = "2" + codeInsee.substring(3);
      else dvfCommuneCode = codeInsee; // commune normale : code_commune = INSEE
    }

    // Filtre commune/arrondissement si assez de transactions, sinon département.
    // code_commune n'est PAS unique en France → on filtre TOUJOURS aussi par département.
    let useCommune = false;
    if (dvfCommuneCode && dept) {
      const { count: communeCount } = await supabase
        .from("dvf")
        .select("*", { count: "exact", head: true })
        .eq("code_departement", dept)
        .eq("code_commune", dvfCommuneCode)
        .not("prix_m2", "is", null)
        .gte("prix_m2", 500).lte("prix_m2", 25000);
      if ((communeCount ?? 0) >= 30) useCommune = true;
      console.log(`[DVF] granularité: ${useCommune ? `${dept}/${dvfCommuneCode}` : `dept ${dept}`} (${communeCount ?? 0} tx)`);
    }

    // Filtre géo : toujours le département, + la commune si assez de volume.
    const applyGeo = (q: any): any => {
      let r = q.eq("code_departement", dept);
      if (useCommune) r = r.eq("code_commune", dvfCommuneCode!);
      return r;
    };

    // Vrai total de transactions sur la zone (toutes périodes, filtres prix).
    const { count: totalCount } = await applyGeo(
      supabase.from("dvf").select("*", { count: "exact", head: true })
    )
      .not("prix_m2", "is", null)
      .gte("prix_m2", 500)
      .lte("prix_m2", 25000);
    const nbTransactionsTotal = totalCount ?? 0;

    // Calcul des bornes temporelles dynamiques
    const now = new Date();
    const dateRecente = new Date(now);
    dateRecente.setFullYear(dateRecente.getFullYear() - 1);
    const dateAncienne = new Date(now);
    dateAncienne.setFullYear(dateAncienne.getFullYear() - 2);
    const dateRecenteStr  = dateRecente.toISOString().split("T")[0];
    const dateAncienneStr = dateAncienne.toISOString().split("T")[0];

    // ── 4 requêtes parallèles ────────────────────────────────────────────────
    const [resAll, resRecent, resOld, resAbsorption] = await Promise.all([
      // Toutes transactions — stats globales + liste des 30 dernières
      applyGeo(
        supabase
          .from("dvf")
          .select("date_mutation, valeur_fonciere, surface_reelle_bati, type_local, commune, prix_m2")
      )
        .not("prix_m2", "is", null)
        .gte("prix_m2", 500)
        .lte("prix_m2", 25000)
        .order("date_mutation", { ascending: false })
        .limit(500),

      // Période récente : 0-12 mois
      applyGeo(
        supabase.from("dvf").select("prix_m2")
      )
        .not("prix_m2", "is", null)
        .gte("prix_m2", 500)
        .lte("prix_m2", 25000)
        .gte("date_mutation", dateRecenteStr)
        .limit(500),

      // Période ancienne : 12-24 mois
      applyGeo(
        supabase.from("dvf").select("prix_m2")
      )
        .not("prix_m2", "is", null)
        .gte("prix_m2", 500)
        .lte("prix_m2", 25000)
        .gte("date_mutation", dateAncienneStr)
        .lt("date_mutation", dateRecenteStr)
        .limit(500),

      // Absorption : COUNT sur 12 mois glissants
      applyGeo(
        supabase.from("dvf").select("*", { count: "exact", head: true })
      )
        .not("prix_m2", "is", null)
        .gte("date_mutation", dateRecenteStr),
    ]);

    if (resAll.error || !resAll.data?.length) return empty;
    const data = resAll.data;

    // ── Stats globales ───────────────────────────────────────────────────────
    const prixM2Values = data
      .map(d => d.prix_m2)
      .filter((p): p is number => p != null);
    const medianPrice = median(prixM2Values);
    const avgPrice = prixM2Values.length
      ? Math.round(prixM2Values.reduce((a, b) => a + b, 0) / prixM2Values.length)
      : null;

    // ── Calcul évolution — v1.3.21 ───────────────────────────────────────────
    let evolution_prix_pct: number | null = null;
    const prixRecents = (resRecent.data ?? [])
      .map((d: Record<string, unknown>) => d.prix_m2 as number)
      .filter((p): p is number => p != null);
    const prixAnciens = (resOld.data ?? [])
      .map((d: Record<string, unknown>) => d.prix_m2 as number)
      .filter((p): p is number => p != null);

    if (prixRecents.length >= 5 && prixAnciens.length >= 5) {
      const medianeRecente  = median(prixRecents);
      const medianeAncienne = median(prixAnciens);
      if (medianeRecente !== null && medianeAncienne !== null && medianeAncienne > 0) {
        const pct = ((medianeRecente - medianeAncienne) / medianeAncienne) * 100;
        if (Math.abs(pct) <= 50) {
          evolution_prix_pct = Math.round(pct * 10) / 10;
        } else {
          console.warn(`[DVF] évolution ${dept}: écart aberrant (${Math.round(pct * 10) / 10}%) → null`);
        }
        console.log(
          `[DVF] évolution ${dept}: récents=${prixRecents.length} (${Math.round(medianeRecente ?? 0)}€/m²)` +
          ` anciens=${prixAnciens.length} (${Math.round(medianeAncienne ?? 0)}€/m²)` +
          ` → ${evolution_prix_pct !== null ? evolution_prix_pct + "%" : "null (aberrant)"}`
        );
      }
    } else {
      console.log(
        `[DVF] évolution ${dept}: données insuffisantes — récents=${prixRecents.length}, anciens=${prixAnciens.length} (min 5 requis)`
      );
    }

    // ── Absorption — v1.3.20 ─────────────────────────────────────────────────
    let absorption_annuelle: number | null = null;
    let absorption_mensuelle: number | null = null;

    if (!resAbsorption.error && resAbsorption.count != null && resAbsorption.count > 0) {
      absorption_annuelle  = resAbsorption.count;
      absorption_mensuelle = Math.round((resAbsorption.count / HORIZON_MOIS) * 10) / 10;
    } else if (resAbsorption.error) {
      console.warn("[DVF] Absorption count failed:", resAbsorption.error.message);
    }

    return {
      nb_transactions: data.length,
      nb_transactions_total: nbTransactionsTotal,
      prix_m2_median: medianPrice ? Math.round(medianPrice) : null,
      prix_m2_moyen: avgPrice,
      prix_m2_min: prixM2Values.length ? Math.min(...prixM2Values) : null,
      prix_m2_max: prixM2Values.length ? Math.max(...prixM2Values) : null,
      evolution_prix_pct,
      absorption_mensuelle,
      absorption_annuelle,
      horizon_mois_absorption: HORIZON_MOIS,
      transactions: data.slice(0, 30).map(d => ({
        date_mutation: d.date_mutation,
        valeur_fonciere: d.valeur_fonciere,
        surface_reelle_bati: d.surface_reelle_bati,
        type_local: d.type_local || "Inconnu",
        commune: d.commune || "",
        prix_m2: d.prix_m2,
      })),
      coverage: "ok"
    };
  } catch (e) {
    console.error("[DVF] Error:", e);
    return empty;
  }
}

// ============================================================================
// EHPAD TARIFS FROM SUPABASE
// ============================================================================

interface EhpadTarifRow {
  finessEt: string;
  prixHebPermCs: string | null;
  prixHebPermCd: string | null;
  prixHebTempCs: string | null;
  prixHebTempCd: string | null;
  TARIF_GIR_12: string | null;
  TARIF_GIR_34: string | null;
  TARIF_GIR_56: string | null;
}

interface EhpadTarifParsed {
  finess: string;
  departement: string;
  prix_hebergement_simple: number | null;
  prix_hebergement_double: number | null;
  tarif_gir_1_2: number | null;
  tarif_gir_3_4: number | null;
  tarif_gir_5_6: number | null;
}

async function fetchEhpadTarifsFromSupabase(dept: string | null): Promise<EhpadTarifParsed[]> {
  if (!dept) return [];
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("ehpad_tarifs")
      .select(`"finessEt", "prixHebPermCs", "prixHebPermCd", "prixHebTempCs", "prixHebTempCd", "TARIF_GIR_12", "TARIF_GIR_34", "TARIF_GIR_56"`)
      .ilike("finessEt", `${dept}%`)
      .limit(200);
    if (error || !data?.length) return [];
    return data.map((row: EhpadTarifRow) => ({
      finess: row.finessEt,
      departement: row.finessEt?.substring(0, 2) || dept,
      prix_hebergement_simple: safeNum(row.prixHebPermCs),
      prix_hebergement_double: safeNum(row.prixHebPermCd),
      tarif_gir_1_2: safeNum(row.TARIF_GIR_12),
      tarif_gir_3_4: safeNum(row.TARIF_GIR_34),
      tarif_gir_5_6: safeNum(row.TARIF_GIR_56),
    }));
  } catch (e) {
    console.error("[EHPAD_TARIFS] Error:", e);
    return [];
  }
}

// ============================================================================
// FILOSOFI DATA FROM SUPABASE
// ============================================================================

const FILOSOFI_MED_RE = /^med(\d{2})$/i;
const FILOSOFI_TXPAU_RE = /^txpau(\d{2})$/i;
const FILOSOFI_PARTIMP_RE = /^partimp(\d{2})$/i;

const LONG_FORM_MED_CANDIDATES = ["mediane_du_niveau_de_vie", "mediane_niveau_de_vie", "mediane_revenu_disponible", "med_niveau_vie", "mediane_rev_disp_uc"];
const LONG_FORM_TXPAU_CANDIDATES = ["taux_de_pauvrete", "taux_pauvrete", "tx_pauvrete"];
const LONG_FORM_PARTIMP_CANDIDATES = ["part_des_menages_fiscaux_imposes", "part_menages_imposes", "pct_menages_imposes"];

interface FilosofiResult {
  revenu_median: number | null;
  incomeMedianUcEur: number | null;
  incomeMedianUcYear: number | null;
  taux_pauvrete: number | null;
  part_menages_imposes: number | null;
  source: 'filosofi_long' | 'filosofi_short' | 'none';
  coverage: Coverage;
  warnings: string[];
  _debug: {
    used_code: string | null;
    med_latest: { key: string; year: number } | null;
    med_value_raw: unknown;
    txpau_latest: { key: string; year: number } | null;
    txpau_value_raw: unknown;
    partimp_latest: { key: string; year: number } | null;
    partimp_value_raw: unknown;
    sample_keys: string[];
    row_found: boolean;
  };
}

function findLatestColumn(keys: string[], pattern: RegExp): { key: string; year: number } | null {
  let best: { key: string; year: number } | null = null;
  for (const k of keys) {
    const m = k.match(pattern);
    if (m) {
      const yearSuffix = parseInt(m[1], 10);
      const year = yearSuffix < 100 ? 2000 + yearSuffix : yearSuffix;
      if (!best || year > best.year) best = { key: k, year };
    }
  }
  return best;
}

function findLongFormValue(row: Record<string, unknown>, rowKeysLower: Map<string, string>, candidates: string[]): { key: string; value: number } | null {
  for (const candidate of candidates) {
    const originalKey = rowKeysLower.get(candidate.toLowerCase());
    if (originalKey) {
      const v = safeNum(row[originalKey]);
      if (v !== null) return { key: originalKey, value: v };
    }
  }
  return null;
}

async function fetchFilosofiData(codeInsee: string): Promise<FilosofiResult> {
  const emptyDebug: FilosofiResult['_debug'] = {
    used_code: codeInsee, med_latest: null, med_value_raw: null,
    txpau_latest: null, txpau_value_raw: null, partimp_latest: null, partimp_value_raw: null,
    sample_keys: [], row_found: false,
  };
  const empty: FilosofiResult = {
    revenu_median: null, incomeMedianUcEur: null, incomeMedianUcYear: null,
    taux_pauvrete: null, part_menages_imposes: null,
    source: 'none', coverage: 'no_data', warnings: [], _debug: emptyDebug,
  };
  if (!codeInsee) return empty;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from("filosofi_staging").select("*").eq("codgeo", codeInsee).limit(1).maybeSingle();
    if (error) { empty.warnings.push(`Erreur requête filosofi: ${error.message}`); empty.coverage = 'error'; return empty; }
    if (!data) { empty.warnings.push(`Aucune donnée FiLoSoFi pour la commune ${codeInsee}`); return empty; }
    const row = data;
    const allKeys = Object.keys(row);
    const rowKeysLower = new Map<string, string>();
    for (const k of allKeys) rowKeysLower.set(k.toLowerCase(), k);
    const sampleKeys: string[] = [];
    for (const k of allKeys) {
      const kl = k.toLowerCase();
      if (kl.startsWith("med") || kl.startsWith("txpau") || kl.startsWith("partimp") || kl === "codgeo" || kl.includes("mediane") || kl.includes("pauvrete") || kl.includes("imposes")) {
        sampleKeys.push(k);
        if (sampleKeys.length >= 60) break;
      }
    }
    const debug: FilosofiResult['_debug'] = {
      used_code: codeInsee, med_latest: null, med_value_raw: null,
      txpau_latest: null, txpau_value_raw: null, partimp_latest: null, partimp_value_raw: null,
      sample_keys: sampleKeys, row_found: true,
    };
    const result: FilosofiResult = {
      revenu_median: null, incomeMedianUcEur: null, incomeMedianUcYear: null,
      taux_pauvrete: null, part_menages_imposes: null,
      source: 'none', coverage: 'partial', warnings: [], _debug: debug,
    };
    const longMed = findLongFormValue(row, rowKeysLower, LONG_FORM_MED_CANDIDATES);
    const longTxpau = findLongFormValue(row, rowKeysLower, LONG_FORM_TXPAU_CANDIDATES);
    const longPartimp = findLongFormValue(row, rowKeysLower, LONG_FORM_PARTIMP_CANDIDATES);
    if (longMed) {
      result.revenu_median = Math.round(longMed.value);
      result.incomeMedianUcEur = Math.round(longMed.value);
      result.source = 'filosofi_long';
      debug.med_latest = { key: longMed.key, year: 0 };
      debug.med_value_raw = row[longMed.key];
    }
    if (longTxpau) result.taux_pauvrete = Math.round(longTxpau.value * 10) / 10;
    if (longPartimp) result.part_menages_imposes = Math.round(longPartimp.value * 10) / 10;
    if (!result.revenu_median) {
      const medCol = findLatestColumn(allKeys, FILOSOFI_MED_RE);
      if (medCol) {
        debug.med_latest = medCol; debug.med_value_raw = row[medCol.key];
        const v = safeNum(row[medCol.key]);
        if (v !== null && v > 0) {
          result.revenu_median = Math.round(v); result.incomeMedianUcEur = Math.round(v);
          result.incomeMedianUcYear = medCol.year; result.source = 'filosofi_short';
        }
      }
    } else {
      const medCol = findLatestColumn(allKeys, FILOSOFI_MED_RE);
      if (medCol) { result.incomeMedianUcYear = medCol.year; debug.med_latest = medCol; debug.med_value_raw = row[medCol.key]; }
    }
    if (result.taux_pauvrete === null) {
      const txpauCol = findLatestColumn(allKeys, FILOSOFI_TXPAU_RE);
      if (txpauCol) {
        debug.txpau_latest = txpauCol; debug.txpau_value_raw = row[txpauCol.key];
        const v = safeNum(row[txpauCol.key]);
        if (v !== null) result.taux_pauvrete = Math.round(v * 10) / 10;
      }
    }
    if (result.part_menages_imposes === null) {
      const partimpCol = findLatestColumn(allKeys, FILOSOFI_PARTIMP_RE);
      if (partimpCol) {
        debug.partimp_latest = partimpCol; debug.partimp_value_raw = row[partimpCol.key];
        const v = safeNum(row[partimpCol.key]);
        if (v !== null) result.part_menages_imposes = Math.round(v * 10) / 10;
      }
    }
    result.coverage = result.revenu_median !== null ? 'ok' : 'partial';
    if (result.revenu_median === null) result.warnings.push(`Ligne FiLoSoFi trouvée pour ${codeInsee} mais aucune colonne exploitable.`);
    return result;
  } catch (e) {
    console.error("[FILOSOFI] Error:", e);
    empty.warnings.push(`Exception filosofi: ${String(e)}`);
    empty.coverage = 'error';
    return empty;
  }
}

// ============================================================================
// INSEE DATA
// ============================================================================

interface InseeData {
  code_commune: string; commune_nom: string; departement: string; region: string;
  population: number; densite: number;
  revenu_median: number | null; revenu_median_source: 'filosofi' | 'socioeco' | 'dept_fallback' | 'none';
  incomeMedianUcEur: number | null; incomeMedianUcYear: number | null;
  taux_pauvrete: number | null; part_menages_imposes: number | null;
  pension_retraite_moyenne: number | null; taux_chomage: number | null;
  pct_proprietaires: number | null; pct_moins_15: number | null; pct_15_29: number | null;
  pct_30_44: number | null; pct_45_59: number | null; pct_60_74: number | null;
  pct_75_plus: number | null; pct_etudiants: number | null; pct_actifs: number | null;
  pct_logements_vacants: number | null; pct_locataires: number | null;
  economic_data_quality?: {
    revenu_median: "real" | "fallback" | "estimated" | "missing";
    revenu_moyen: "real" | "missing"; niveau_vie_median: "real" | "derived" | "missing";
    tax_data: "real" | "missing"; pcs_data: "real" | "partial" | "missing";
    evolution_data: "real" | "missing"; socioeco_profile: "partial" | "complete" | "missing";
    fields_found_count: number;
  };
  revenu_median_uc?: number | null; revenu_moyen?: number | null; niveau_vie_median?: number | null;
  part_cadres?: number | null; part_professions_intermediaires?: number | null;
  part_employes?: number | null; part_ouvriers?: number | null; part_actifs_occupes?: number | null;
  evolution_population_5y?: number | null; evolution_revenu_5y?: number | null;
  evolution_chomage_5y?: number | null; taxe_fonciere_moyenne?: number | null;
  taxe_fonciere_evolution_3y?: number | null;
  revenu_source: 'filosofi' | 'none'; coverage: Coverage; warnings: string[];
}

// ============================================================================
// SOCIOECO FIELD CANDIDATES
// ============================================================================

const SOCIOECO_FIELD_CANDIDATES: Record<string, string[]> = {
  revenu_moyen: ['revenu_moyen_eur', 'revenu_moyen', 'rev_moyen', 'mean_income', 'revenu_disponible_moyen'],
  taux_chomage: ['taux_chomage_pct', 'taux_chomage', 'tx_chomage', 'chomage_pct'],
  niveau_vie_median: ['niveau_vie_median', 'niv_vie_median', 'mediane_niveau_vie', 'mediane_rev_disp_uc', 'revenu_median_eur'],
  revenu_median_uc: ['revenu_median_uc_eur', 'revenu_median_uc', 'mediane_uc', 'med19', 'med20', 'med21', 'med22'],
  taux_pauvrete: ['taux_pauvrete_pct', 'taux_pauvrete', 'tx_pauvrete', 'txpau19', 'txpau20', 'txpau21', 'txpau22'],
  part_menages_imposes: ['part_menages_imposes_pct', 'part_menages_imposes', 'partimp19', 'partimp20', 'partimp21', 'partimp22'],
  pension_retraite_moyenne: ['pension_retraite_moyenne_eur_mois', 'pension_retraite_moyenne', 'pension_moyenne_eur', 'retraite_moyenne'],
  part_cadres: ['part_cadres_pct', 'part_cadres', 'pct_cadres', 'cs3_pct'],
  part_professions_intermediaires: ['part_professions_intermediaires_pct', 'part_professions_intermediaires', 'cs4_pct'],
  part_employes: ['part_employes_pct', 'part_employes', 'pct_employes', 'cs5_pct'],
  part_ouvriers: ['part_ouvriers_pct', 'part_ouvriers', 'pct_ouvriers', 'cs6_pct'],
  part_actifs_occupes: ['part_actifs_occupes_pct', 'part_actifs_occupes', 'taux_emploi'],
  evolution_revenu_5y: ['evolution_revenu_5y', 'evol_revenu_5y', 'variation_revenu_5y'],
  evolution_chomage_5y: ['evolution_chomage_5y', 'evol_chomage_5y', 'variation_chomage_5y'],
  taxe_fonciere_moyenne: ['taxe_fonciere_moyenne', 'tf_moyenne', 'taxe_fonciere_moy'],
  taxe_fonciere_evolution_3y: ['taxe_fonciere_evolution_3y', 'tf_evol_3y', 'delta_tf_3y'],
  evolution_population_5y: ['evolution_population_5y', 'evol_pop_5y', 'variation_pop_5y', 'pop_evol_5y'],
};

function pickFirstNumeric(row: Record<string, unknown> | null | undefined, candidateKeys: string[]): number | null {
  if (!row) return null;
  const lowerIndex: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) lowerIndex[k.toLowerCase()] = v;
  for (const key of candidateKeys) {
    const val = lowerIndex[key.toLowerCase()];
    if (val == null || val === '' || val === 'ns' || val === 'nd') continue;
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.').replace(/\s/g, ''));
    if (Number.isFinite(n)) return Math.round(n * 100) / 100;
  }
  return null;
}

function pickField(row: Record<string, unknown> | null | undefined, fieldName: keyof typeof SOCIOECO_FIELD_CANDIDATES): number | null {
  return pickFirstNumeric(row, SOCIOECO_FIELD_CANDIDATES[fieldName] ?? []);
}

interface SocioEcoExtended {
  revenu_moyen: number | null; niveau_vie_median: number | null; revenu_median_uc: number | null;
  part_cadres: number | null; part_professions_intermediaires: number | null;
  part_employes: number | null; part_ouvriers: number | null; part_actifs_occupes: number | null;
  taux_pauvrete: number | null; taux_chomage: number | null; part_menages_imposes: number | null;
  pension_retraite_moyenne: number | null; evolution_revenu_5y: number | null;
  evolution_chomage_5y: number | null; taxe_fonciere_moyenne: number | null;
  taxe_fonciere_evolution_3y: number | null; _fields_found: string[];
}

interface PopulationEvolution { evolution_population_5y: number | null; }

async function fetchSocioEcoExtended(codeInsee: string): Promise<SocioEcoExtended> {
  const empty: SocioEcoExtended = {
    revenu_moyen: null, niveau_vie_median: null, revenu_median_uc: null,
    part_cadres: null, part_professions_intermediaires: null,
    part_employes: null, part_ouvriers: null, part_actifs_occupes: null,
    taux_pauvrete: null, taux_chomage: null, part_menages_imposes: null,
    pension_retraite_moyenne: null, evolution_revenu_5y: null, evolution_chomage_5y: null,
    taxe_fonciere_moyenne: null, taxe_fonciere_evolution_3y: null, _fields_found: [],
  };
  if (!codeInsee) return empty;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from("insee_socioeco_communes").select("*").eq("code_commune", codeInsee).limit(1).maybeSingle();
    if (error || !data) { if (error) console.warn("[SocioEco] Erreur:", error.message); return empty; }
    const row = data as Record<string, unknown>;
    const found: string[] = [];
    const pf = (field: keyof typeof SOCIOECO_FIELD_CANDIDATES): number | null => { const v = pickField(row, field); if (v !== null) found.push(field); return v; };
    return {
      revenu_moyen: pf('revenu_moyen'), niveau_vie_median: pf('niveau_vie_median'), revenu_median_uc: pf('revenu_median_uc'),
      part_cadres: pf('part_cadres'), part_professions_intermediaires: pf('part_professions_intermediaires'),
      part_employes: pf('part_employes'), part_ouvriers: pf('part_ouvriers'), part_actifs_occupes: pf('part_actifs_occupes'),
      taux_pauvrete: pf('taux_pauvrete'), taux_chomage: pf('taux_chomage'), part_menages_imposes: pf('part_menages_imposes'),
      pension_retraite_moyenne: pf('pension_retraite_moyenne'), evolution_revenu_5y: pf('evolution_revenu_5y'),
      evolution_chomage_5y: pf('evolution_chomage_5y'), taxe_fonciere_moyenne: pf('taxe_fonciere_moyenne'),
      taxe_fonciere_evolution_3y: pf('taxe_fonciere_evolution_3y'), _fields_found: found,
    };
  } catch (e) { console.warn("[SocioEco] Exception:", e); return empty; }
}

async function fetchPopulationEvolution(codeInsee: string): Promise<PopulationEvolution> {
  if (!codeInsee) return { evolution_population_5y: null };
  try {
    const supabase = getSupabaseClient();
    const { data: statsRow } = await supabase.from("insee_communes_stats").select("*").eq("code_commune", codeInsee).limit(1).maybeSingle();
    if (statsRow) { const v = pickField(statsRow as Record<string, unknown>, 'evolution_population_5y'); if (v !== null) return { evolution_population_5y: v }; }
    const { data: socioRow } = await supabase.from("insee_socioeco_communes").select("evolution_population_5y, evol_pop_5y, variation_pop_5y").eq("code_commune", codeInsee).limit(1).maybeSingle();
    if (socioRow) { const v = pickFirstNumeric(socioRow as Record<string, unknown>, ['evolution_population_5y', 'evol_pop_5y', 'variation_pop_5y']); if (v !== null) return { evolution_population_5y: v }; }
    return { evolution_population_5y: null };
  } catch (e) { console.warn("[PopEvol] Exception:", e); return { evolution_population_5y: null }; }
}

async function fetchTaxeFonciere(codeInsee: string): Promise<{ taux_actuel: number | null; evolution_3y: number | null }> {
  const empty = { taux_actuel: null, evolution_3y: null };
  if (!codeInsee) return empty;
  try {
    const url = `${FISCALITE_API}?where=insee_com%3D%22${codeInsee}%22&limit=10&select=taux_global_tfb,exercice&order_by=exercice%20DESC`;
    const resp = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3500) });
    if (!resp.ok) return empty;
    const json = await resp.json();
    const rows: Array<{ taux_global_tfb: number; exercice: string }> = json.results || [];
    if (!rows.length) return empty;
    const latest = rows[0];
    const tauxActuel = parseFloat(String(latest.taux_global_tfb));
    if (isNaN(tauxActuel)) return empty;
    let evolution3y: number | null = null;
    const latestYear = parseInt(latest.exercice, 10);
    const old3y = rows.find(r => parseInt(r.exercice, 10) <= latestYear - 3);
    const fallbackOld = old3y ?? (rows.length >= 2 ? rows[rows.length - 1] : null);
    if (fallbackOld) {
      const tauxOld = parseFloat(String(fallbackOld.taux_global_tfb));
      if (!isNaN(tauxOld) && tauxOld > 0) evolution3y = Math.round(((tauxActuel - tauxOld) / tauxOld) * 100 * 10) / 10;
    }
    return { taux_actuel: Math.round(tauxActuel * 10) / 10, evolution_3y: evolution3y };
  } catch (e) { console.warn("[TaxeFonciere] Exception:", String(e).substring(0, 100)); return empty; }
}

async function fetchPopulationEvolutionApi(codeInsee: string): Promise<number | null> {
  if (!codeInsee) return null;
  try {
    const url = `${POPULATION_API}?where=code_insee%3D%22${codeInsee}%22&select=population_municipale,annee_recensement&order_by=annee_recensement%20DESC&limit=10`;
    const resp = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3500) });
    if (!resp.ok) return null;
    const json = await resp.json();
    const rows: Array<{ population_municipale: number; annee_recensement: string }> = json.results || [];
    if (rows.length < 2) return null;
    const latest = rows[0];
    const latestYear = parseInt(latest.annee_recensement, 10);
    const old5y = rows.find(r => parseInt(r.annee_recensement, 10) <= latestYear - 5) ?? rows[rows.length - 1];
    if (!old5y.population_municipale) return null;
    return Math.round(((latest.population_municipale - old5y.population_municipale) / old5y.population_municipale) * 100 * 10) / 10;
  } catch (e) { console.warn("[PopEvol] Exception:", String(e).substring(0, 100)); return null; }
}

async function fetchInseeData(
  codeInsee: string, communeNom: string | null, dept: string | null,
  communeInfo?: { population?: number | null; region?: string | null } | null,
  codeInseeCommune?: string | null,
): Promise<InseeData | null> {
  try {
    const url = `${GEO_API_BASE}/communes/${codeInsee}?fields=code,nom,departement,region,population,surface`;
    let data: { nom?: string; population?: number; surface?: number; departement?: { code?: string }; region?: { nom?: string } } = {};
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) data = await res.json();
      else console.warn(`[INSEE] GEO HTTP ${res.status} — fallback local pour ${codeInsee}`);
    } catch { console.warn("[INSEE] GEO indisponible — fallback local pour", codeInsee); }

    const deptCode = dept ?? data.departement?.code ?? codeInsee.substring(0, 2);
    const surface = data.surface ? data.surface / 100 : 1;
    const population = (data.population as number | undefined) ?? (communeInfo?.population ?? 0);
    const regionNom = (data.region as { nom?: string } | undefined)?.nom || (communeInfo?.region ?? "");
    const densite = surface > 0 ? Math.round(population / surface) : 0;
    const demoData = DEMOGRAPHICS_DEPT[deptCode] || DEMOGRAPHICS_DEPT["default"];

    let pct75Adjusted = demoData.pct_75_plus;
    if (densite < 100) pct75Adjusted = Math.min(18, demoData.pct_75_plus + 4);
    else if (densite < 500) pct75Adjusted = Math.min(14, demoData.pct_75_plus + 2);
    else if (densite > 5000) pct75Adjusted = Math.max(6, demoData.pct_75_plus - 2);

    let pctEtudiantsAdjusted = demoData.pct_etudiants;
    if (densite > 5000) pctEtudiantsAdjusted = Math.min(15, demoData.pct_etudiants + 3);
    else if (densite < 500) pctEtudiantsAdjusted = Math.max(1, demoData.pct_etudiants - 3);

    const filosofi = await fetchFilosofiData(codeInsee);
    let revenuMedian: number | null = filosofi.revenu_median;
    let tauxPauvrete: number | null = filosofi.taux_pauvrete;
    let partMenagesImposes: number | null = filosofi.part_menages_imposes;
    let pensionRetraiteMoyenne: number | null = null;
    let revenuMedianSource: InseeData['revenu_median_source'] = revenuMedian !== null ? 'filosofi' : 'none';

    const [socioEco, popEvol, taxeFonciere, popEvolApi] = await Promise.all([
      fetchSocioEcoExtended(codeInsee), fetchPopulationEvolution(codeInsee),
      (async () => {
        // La fiscalité est clé par commune (75056), pas par arrondissement (75114).
        let tf = await fetchTaxeFonciere(codeInsee);
        if (tf.taux_actuel == null && codeInseeCommune && codeInseeCommune !== codeInsee) {
          tf = await fetchTaxeFonciere(codeInseeCommune);
        }
        return tf;
      })(),
      fetchPopulationEvolutionApi(codeInsee),
    ]);

    if (revenuMedian === null) {
      const socioMedian = socioEco.revenu_median_uc ?? socioEco.niveau_vie_median;
      if (socioMedian != null) { revenuMedian = socioMedian; revenuMedianSource = 'socioeco'; }
    }
    if (tauxPauvrete === null) tauxPauvrete = socioEco.taux_pauvrete;
    if (partMenagesImposes === null) partMenagesImposes = socioEco.part_menages_imposes;
    if (pensionRetraiteMoyenne === null) pensionRetraiteMoyenne = socioEco.pension_retraite_moyenne;

    if (revenuMedian === null) {
      revenuMedian = REVENU_MEDIAN_DEPT_FALLBACK[deptCode] ?? REVENU_MEDIAN_DEPT_FALLBACK["default"];
      revenuMedianSource = 'dept_fallback';
    }

    const warnings: string[] = [...filosofi.warnings];
    if (revenuMedianSource === 'dept_fallback') warnings.push(`Revenu médian estimé (département ${deptCode}) — données FiLoSoFi et socioeco absentes pour ${codeInsee}.`);

    const tauxChomage = socioEco.taux_chomage ?? TAUX_CHOMAGE_DEPT[deptCode] ?? TAUX_CHOMAGE_DEPT["default"] ?? null;
    const coverage: Coverage = revenuMedianSource === 'filosofi' || revenuMedianSource === 'socioeco' ? 'ok' : 'partial';

    return {
      code_commune: codeInsee, commune_nom: data.nom || communeNom || "",
      departement: deptCode, region: regionNom, population, densite,
      revenu_median: revenuMedian, revenu_median_source: revenuMedianSource,
      incomeMedianUcEur: filosofi.incomeMedianUcEur ?? revenuMedian, incomeMedianUcYear: filosofi.incomeMedianUcYear,
      taux_pauvrete: tauxPauvrete, part_menages_imposes: partMenagesImposes,
      pension_retraite_moyenne: pensionRetraiteMoyenne, taux_chomage: tauxChomage,
      pct_proprietaires: 58, pct_moins_15: demoData.pct_moins_15, pct_15_29: demoData.pct_15_29,
      pct_30_44: demoData.pct_30_44, pct_45_59: demoData.pct_45_59, pct_60_74: demoData.pct_60_74,
      pct_75_plus: pct75Adjusted, pct_etudiants: pctEtudiantsAdjusted, pct_actifs: demoData.pct_actifs,
      pct_logements_vacants: densite < 200 ? 12 : densite < 1000 ? 8 : 5,
      pct_locataires: densite > 3000 ? 55 : densite > 1000 ? 45 : 35,
      revenu_median_uc: socioEco.revenu_median_uc, revenu_moyen: socioEco.revenu_moyen,
      niveau_vie_median: socioEco.niveau_vie_median ?? revenuMedian,
      part_cadres: socioEco.part_cadres, part_professions_intermediaires: socioEco.part_professions_intermediaires,
      part_employes: socioEco.part_employes, part_ouvriers: socioEco.part_ouvriers,
      part_actifs_occupes: socioEco.part_actifs_occupes,
      evolution_population_5y: popEvolApi ?? popEvol.evolution_population_5y,
      evolution_revenu_5y: socioEco.evolution_revenu_5y, evolution_chomage_5y: socioEco.evolution_chomage_5y,
      taxe_fonciere_moyenne: taxeFonciere.taux_actuel ?? socioEco.taxe_fonciere_moyenne,
      taxe_fonciere_evolution_3y: taxeFonciere.evolution_3y ?? socioEco.taxe_fonciere_evolution_3y,
      economic_data_quality: (() => {
        const ff = socioEco._fields_found;
        const pcsFields = ['part_cadres', 'part_employes', 'part_ouvriers', 'part_professions_intermediaires'];
        const pcsFound = pcsFields.filter(f => ff.includes(f)).length;
        const coreFields = ['taux_pauvrete', 'part_menages_imposes', 'pension_retraite_moyenne'];
        const coreFound = coreFields.filter(f => ff.includes(f)).length;
        const totalFound = ff.length;
        const revenuQuality: "real" | "fallback" | "estimated" | "missing" =
          revenuMedianSource === 'filosofi' ? 'real' : revenuMedianSource === 'socioeco' ? 'real'
          : revenuMedianSource === 'dept_fallback' ? 'fallback' : 'missing';
        return {
          revenu_median: revenuQuality,
          revenu_moyen: socioEco.revenu_moyen != null ? 'real' : 'missing',
          niveau_vie_median: socioEco.niveau_vie_median != null ? 'real' : revenuMedian != null ? 'derived' : 'missing',
          tax_data: socioEco.taxe_fonciere_moyenne != null ? 'real' : 'missing',
          pcs_data: pcsFound >= 2 ? 'real' : pcsFound === 1 ? 'partial' : 'missing',
          evolution_data: (socioEco.evolution_revenu_5y != null || socioEco.evolution_chomage_5y != null) ? 'real' : 'missing',
          socioeco_profile: totalFound === 0 ? 'missing' : totalFound >= 6 && pcsFound >= 2 && coreFound >= 2 ? 'complete' : 'partial',
          fields_found_count: totalFound,
        };
      })(),
      revenu_source: revenuMedianSource !== 'none' ? 'filosofi' : 'none',
      coverage, warnings,
    };
  } catch (e) { console.error("[INSEE] Error:", e); return null; }
}

// ============================================================================
// TRANSPORT DATA
// ============================================================================

interface TransportData {
  score: number;
  stops: Array<{ name: string; type: string; distance_m: number }>;
  nearest_stop_m: number | null;
  has_metro_train: boolean;
  has_tram: boolean;
  is_urban: boolean;
  coverage: Coverage;
}

const MAJOR_CITIES_FALLBACK: Record<string, TransportData> = {
  "75": { score: 95, stops: [{ name: "Transport Paris (estimation)", type: "metro", distance_m: 300 }], nearest_stop_m: 300, has_metro_train: true, has_tram: true, is_urban: true, coverage: "ok" },
  "69": { score: 85, stops: [{ name: "Transport Métropole (estimation)", type: "metro", distance_m: 300 }], nearest_stop_m: 300, has_metro_train: true, has_tram: true, is_urban: true, coverage: "ok" },
  "13": { score: 80, stops: [{ name: "Transport Métropole (estimation)", type: "metro", distance_m: 400 }], nearest_stop_m: 400, has_metro_train: true, has_tram: true, is_urban: true, coverage: "ok" },
  "31": { score: 80, stops: [{ name: "Transport Métropole (estimation)", type: "metro", distance_m: 300 }], nearest_stop_m: 300, has_metro_train: true, has_tram: false, is_urban: true, coverage: "ok" },
  "59": { score: 75, stops: [{ name: "Transport Métropole (estimation)", type: "metro", distance_m: 350 }], nearest_stop_m: 350, has_metro_train: true, has_tram: true, is_urban: true, coverage: "ok" },
  "33": { score: 75, stops: [{ name: "Transport Métropole (estimation)", type: "tram", distance_m: 350 }], nearest_stop_m: 350, has_metro_train: false, has_tram: true, is_urban: true, coverage: "ok" },
  "44": { score: 70, stops: [{ name: "Transport Métropole (estimation)", type: "tram", distance_m: 400 }], nearest_stop_m: 400, has_metro_train: false, has_tram: true, is_urban: true, coverage: "ok" },
  "67": { score: 75, stops: [{ name: "Transport Métropole (estimation)", type: "tram", distance_m: 350 }], nearest_stop_m: 350, has_metro_train: false, has_tram: true, is_urban: true, coverage: "ok" },
  "06": { score: 70, stops: [{ name: "Transport Métropole (estimation)", type: "tram", distance_m: 400 }], nearest_stop_m: 400, has_metro_train: false, has_tram: true, is_urban: true, coverage: "ok" },
  "34": { score: 70, stops: [{ name: "Transport Métropole (estimation)", type: "tram", distance_m: 400 }], nearest_stop_m: 400, has_metro_train: false, has_tram: true, is_urban: true, coverage: "ok" },
};

async function fetchTransport(lat: number, lon: number, dept: string | null, population: number | null = null): Promise<TransportData> {
  const emptyTransport: TransportData = { score: 0, stops: [], nearest_stop_m: null, has_metro_train: false, has_tram: false, is_urban: false, coverage: "no_data" };
  try {
    const radius = 1000;
    const query = `[out:json][timeout:20];(node["public_transport"="stop_position"](around:${radius},${lat},${lon});node["public_transport"="platform"](around:${radius},${lat},${lon});node["highway"="bus_stop"](around:${radius},${lat},${lon});node["railway"="station"](around:${radius},${lat},${lon});node["railway"="halt"](around:${radius},${lat},${lon});node["railway"="tram_stop"](around:${radius},${lat},${lon});node["railway"="subway_entrance"](around:${radius},${lat},${lon});node["station"="subway"](around:${radius},${lat},${lon}););out tags 50;`;
    const res = await queryOverpass(query);
    if (!res.ok) {
  console.warn(`[Transport] Overpass !res.ok, dept=${dept}, status=${res.status}`);
  if (dept && ["75","69","13","31","59","33","44","67","06","34","92","93","94"].includes(dept)) {
    const fallbackScores: Record<string, number> = { "75": 95, "69": 85, "13": 80, "31": 80, "59": 75, "33": 75, "44": 70, "67": 75, "06": 70, "34": 70, "92": 90, "93": 80, "94": 85 };
    const hasMetro = ["75","69","13","59","92","93","94"].includes(dept);
    const hasTram = ["75","69","13","31","33","44","67","06","34","92","93","94"].includes(dept);
    return { score: fallbackScores[dept] ?? 70, stops: [], nearest_stop_m: null, has_metro_train: hasMetro, has_tram: hasTram, is_urban: true, coverage: "partial" };
  }
  const isUrban = (population ?? 0) >= URBAN_POP_THRESHOLD;
  return { ...emptyTransport, is_urban: isUrban };
}
    const data = await res.json();
    console.log(`[Transport] elements=${data?.elements?.length ?? 0}, dept=${dept}`);
    if (!data?.elements?.length) {
      const isUrban = (population ?? 0) >= URBAN_POP_THRESHOLD;
      // Fallback métropoles : score estimé sans noms fictifs
      if (dept && ["75","69","13","31","59","33","44","67","06","34","92","93","94"].includes(dept)) {
        const fallbackScores: Record<string, number> = { "75": 95, "69": 85, "13": 80, "31": 80, "59": 75, "33": 75, "44": 70, "67": 75, "06": 70, "34": 70, "92": 90, "93": 80, "94": 85 };
        const hasMetro = ["75","69","13","59","92","93","94"].includes(dept);
        const hasTram = ["75","69","13","31","33","44","67","06","34","92","93","94"].includes(dept);
        return { score: fallbackScores[dept] ?? 70, stops: [], nearest_stop_m: null, has_metro_train: hasMetro, has_tram: hasTram, is_urban: true, coverage: "partial" };
      }
      return { ...emptyTransport, is_urban: isUrban };
    }
    const stops: Array<{ name: string; type: string; distance_m: number }> = [];
    let hasMetroTrain = false; let hasTram = false;
    console.log(`[Transport] Overpass: ${data.elements.length} éléments, lat=${lat}, lon=${lon}`);
    for (const el of data.elements) {
      if (!el.lat || !el.lon) continue;
      const dist = haversine(lat, lon, el.lat, el.lon);
      const tags = el.tags || {};
      let type = "bus";
      if (tags.railway === "station" || tags.railway === "halt" || tags.train === "yes") { type = "train"; hasMetroTrain = true; }
      else if (tags.subway === "yes" || tags.station === "subway") { type = "metro"; hasMetroTrain = true; }
      else if (tags.tram === "yes" || tags.railway === "tram_stop") { type = "tram"; hasTram = true; }
      stops.push({ name: tags.name || "Arrêt", type, distance_m: Math.round(dist) });
    }
    stops.sort((a, b) => a.distance_m - b.distance_m);
    const nearest = stops[0]?.distance_m ?? null;
    let score = 30;
    if (nearest !== null) { if (nearest < 300) score = 90; else if (nearest < 500) score = 75; else if (nearest < 800) score = 60; else score = 45; }
    if (hasMetroTrain) score = Math.min(100, score + 10);
    if (hasTram) score = Math.min(100, score + 5);
    return { score, stops: stops.slice(0, 15), nearest_stop_m: nearest, has_metro_train: hasMetroTrain, has_tram: hasTram, is_urban: true, coverage: "ok" };
  } catch (e) {
    console.warn("[Transport] Overpass timeout ou indisponible:", String(e).substring(0, 100));
    const isUrban = (population ?? 0) >= URBAN_POP_THRESHOLD;
    if (dept && ["75","69","13","31","59","33","44","67","06","34","92","93","94"].includes(dept)) {
      const fallbackScores: Record<string, number> = { "75": 95, "69": 85, "13": 80, "31": 80, "59": 75, "33": 75, "44": 70, "67": 75, "06": 70, "34": 70, "92": 90, "93": 80, "94": 85 };
      const hasMetro = ["75","69","13","59","92","93","94"].includes(dept);
      const hasTram = ["75","69","13","31","33","44","67","06","34","92","93","94"].includes(dept);
      return { score: fallbackScores[dept] ?? 70, stops: [], nearest_stop_m: null, has_metro_train: hasMetro, has_tram: hasTram, is_urban: true, coverage: "partial" };
    }
    return { ...emptyTransport, is_urban: isUrban };
  }
}

// ============================================================================
// BPE FROM SUPABASE
// ============================================================================

interface BpeData {
  total_equipements: number; score: number;
  commerces: { count: number; details: Array<{ label: string; distance_m: number }> };
  sante: { count: number; details: Array<{ label: string; distance_m: number }> };
  services: { count: number; details: Array<{ label: string; distance_m: number }> };
  education: { count: number; details: Array<{ label: string; distance_m: number }> };
  loisirs: { count: number; details: Array<{ label: string; distance_m: number }> };
  nb_ecoles: number; nb_pharmacies: number; nb_supermarches: number; nb_universites: number;
  coverage: Coverage;
  bpe_quality?: {
    source: "api_datagouv" | "supabase" | "none";
    raw_count: number; full_coverage: boolean;
    zero_categories: string[]; suspected_partial_categories: string[];
    confidence: "forte" | "moyenne" | "faible";
  };
}

async function resolveArrondissementInsee(communeInsee: string, lat: number, lon: number): Promise<string> {
  if (!COMMUNES_AVEC_ARRONDISSEMENTS.has(communeInsee)) return communeInsee;
  try {
    const url = `${GEO_API_BASE}/communes?lat=${lat}&lon=${lon}&type=arrondissement-municipal&fields=code&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return communeInsee;
    const data = await res.json();
    if (data?.length > 0 && data[0].code) return data[0].code;
  } catch (e) { console.warn("[BPE] résolution arrondissement échouée:", String(e).substring(0, 80)); }
  return communeInsee;
}

async function fetchBpeFromSupabase(lat: number, lon: number, codeInsee: string | null, dept: string | null, communeNom: string | null = null): Promise<BpeData> {
  const emptyBpe: BpeData = {
    total_equipements: 0, score: 30,
    commerces: { count: 0, details: [] }, sante: { count: 0, details: [] },
    services: { count: 0, details: [] }, education: { count: 0, details: [] }, loisirs: { count: 0, details: [] },
    nb_ecoles: 0, nb_pharmacies: 0, nb_supermarches: 0, nb_universites: 0, coverage: "no_data",
  };
  if (!codeInsee) return emptyBpe;
  const effectiveInsee = await resolveArrondissementInsee(codeInsee, lat, lon);
  try {
    const supabase = getSupabaseClient();
    const { data: agg, error: aggError } = await supabase.from("bpe_depcom_aggregates").select("nb_commerces, nb_sante, nb_services, nb_education, nb_loisirs, nb_ecoles, nb_supermarches, nb_universites, total_equipements, score").eq("depcom", effectiveInsee).limit(1).maybeSingle();
    if (!aggError && agg) {
      const buildDetails = (rows: Array<Record<string, unknown>>) => rows.map(row => {
        const rawType = String(row.typequ || ""); const typeCode = rawType.toUpperCase();
        const typeInfo = BPE_TYPES[rawType] ?? BPE_TYPES[typeCode];
        const eqLat = parseFloat(String(row.latitude || "")); const eqLon = parseFloat(String(row.longitude || ""));
        const distance_m = (!isNaN(eqLat) && !isNaN(eqLon)) ? Math.round(haversine(lat, lon, eqLat, eqLon)) : 500;
        return { label: String(row.nomrs || typeInfo?.label || typeCode), distance_m };
      }).sort((a, b) => a.distance_m - b.distance_m);
      const [dA, dB, dC, dD] = await Promise.all([
        supabase.from("bpe_equipements").select("typequ,nomrs,latitude,longitude").eq("depcom", effectiveInsee).like("typequ", "A%").limit(300),
        supabase.from("bpe_equipements").select("typequ,nomrs,latitude,longitude").eq("depcom", effectiveInsee).like("typequ", "B%").limit(300),
        supabase.from("bpe_equipements").select("typequ,nomrs,latitude,longitude").eq("depcom", effectiveInsee).like("typequ", "C%").limit(300),
        supabase.from("bpe_equipements").select("typequ,nomrs,latitude,longitude").eq("depcom", effectiveInsee).like("typequ", "D%").limit(300),
      ]);
      const totalFromAgg = (agg.total_equipements as number) || 0;
      const zeroCats: string[] = [];
      if (!agg.nb_commerces) zeroCats.push("commerces");
      if (!agg.nb_sante) zeroCats.push("sante");
      if (!agg.nb_services) zeroCats.push("services");
      if (!agg.nb_education) zeroCats.push("education");
      return {
        total_equipements: totalFromAgg, score: (agg.score as number) || 30,
        commerces: { count: (agg.nb_commerces as number) || 0, details: buildDetails((dB.data || []) as Array<Record<string, unknown>>).slice(0, 10) },
        sante: { count: (agg.nb_sante as number) || 0, details: buildDetails((dD.data || []) as Array<Record<string, unknown>>).slice(0, 10) },
        services: { count: (agg.nb_services as number) || 0, details: buildDetails((dA.data || []) as Array<Record<string, unknown>>).slice(0, 10) },
        education: { count: (agg.nb_education as number) || 0, details: buildDetails((dC.data || []) as Array<Record<string, unknown>>).slice(0, 10) },
        loisirs: await fetchLoisirsBpe(communeNom || "", lat, lon),
        nb_ecoles: (agg.nb_ecoles as number) || 0, nb_pharmacies: 0,
        nb_supermarches: (agg.nb_supermarches as number) || 0, nb_universites: (agg.nb_universites as number) || 0,
        coverage: "ok",
        bpe_quality: { source: "api_datagouv", raw_count: totalFromAgg, full_coverage: true, zero_categories: zeroCats, suspected_partial_categories: agg.nb_loisirs ? [] : ["loisirs"], confidence: "forte" },
      };
    }
    if (aggError) console.warn("[BPE] bpe_depcom_aggregates erreur:", aggError.message);
  } catch (e) { console.warn("[BPE] bpe_depcom_aggregates exception:", e); }
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from("bpe_equipements").select("depcom, typequ, nomrs, latitude, longitude").eq("depcom", effectiveInsee);
    if (!error && data && data.length > 0) {
      const records = (data as Array<Record<string, unknown>>).map(r => ({ TYPEQU: String(r.typequ || ""), NOM: String(r.nomrs || ""), LATITUDE: String(r.latitude || ""), LONGITUDE: String(r.longitude || ""), DEPCOM: String(r.depcom || "") }));
      return processBpeRecords(records, lat, lon, "supabase");
    }
  } catch (e) { console.error("[BPE] Fallback erreur:", e); }
  return emptyBpe;
}

async function fetchOpendatasoftBpe(communeNom: string, lat: number, lon: number, category: string, logLabel: string): Promise<{ count: number; details: Array<{ label: string; distance_m: number }> }> {
  const empty = { count: 0, details: [] };
  if (!communeNom) return empty;
  try {
    const encodedName = encodeURIComponent(`"${communeNom}"`);
    const encodedCat = encodeURIComponent(`"${category}"`);
    const url = `${OPENDATASOFT_BPE_API}?where=com_arm_name%3D${encodedName}%20AND%20category%3D${encodedCat}&limit=100&select=equipment_name,equipment_code,geo_point_2d`;
    const resp = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return empty;
    const json = await resp.json();
    const details = (json.results || []).map((r: Record<string, unknown>) => {
      const gp = r.geo_point_2d as { lat?: number; lon?: number } | null;
      const distance_m = (gp?.lat != null && gp?.lon != null) ? Math.round(haversine(lat, lon, gp.lat, gp.lon)) : 500;
      const nameArr = r.equipment_name as string[] | string | null;
      return { label: Array.isArray(nameArr) ? nameArr[0] : (nameArr || logLabel), distance_m };
    }).sort((a: { distance_m: number }, b: { distance_m: number }) => a.distance_m - b.distance_m);
    return { count: json.total_count as number, details: details.slice(0, 10) };
  } catch (e) { console.warn(`[${logLabel}] Exception:`, String(e).substring(0, 100)); return empty; }
}

const fetchLoisirsBpe = (communeNom: string, lat: number, lon: number) =>
  fetchOpendatasoftBpe(communeNom, lat, lon, "Sports, loisirs et culture", "Loisirs");

function processBpeRecords(records: Array<Record<string, string>>, lat: number, lon: number, source: string): BpeData {
  const commerces: Array<{ label: string; distance_m: number }> = [];
  const sante: Array<{ label: string; distance_m: number }> = [];
  const services: Array<{ label: string; distance_m: number }> = [];
  const education: Array<{ label: string; distance_m: number }> = [];
  const loisirs: Array<{ label: string; distance_m: number }> = [];
  let nbEcoles = 0, nbPharmacies = 0, nbSupermarches = 0, nbUniversites = 0;
  for (const r of records) {
    const rawCode = (r.TYPEQU || r.typequ || "").toString().trim();
    const typeCode = rawCode.toUpperCase();
    const typeInfo = BPE_TYPES[rawCode] ?? BPE_TYPES[typeCode];
    const eqLat = parseFloat(r.LATITUDE || r.latitude || "");
    const eqLon = parseFloat(r.LONGITUDE || r.longitude || "");
    const distance_m = (!isNaN(eqLat) && !isNaN(eqLon)) ? Math.round(Math.sqrt(Math.pow((eqLat - lat) * 111000, 2) + Math.pow((eqLon - lon) * 111000 * Math.cos(lat * Math.PI / 180), 2))) : 500;
    const label = r.NOM || r.nomrs || typeInfo?.label || typeCode;
    const item = { label, distance_m };
    if (typeCode === "D301") nbPharmacies++;
    if (typeCode.startsWith("C1") || typeCode.startsWith("C2")) nbEcoles++;
    if (typeCode === "B101" || typeCode === "B102") nbSupermarches++;
    if (typeCode.startsWith("C4") || typeCode.startsWith("C5")) nbUniversites++;
    if (typeInfo) {
      switch (typeInfo.category) {
        case "commerces": commerces.push(item); break;
        case "sante": sante.push(item); break;
        case "services": services.push(item); break;
        case "education": education.push(item); break;
        case "loisirs": loisirs.push(item); break;
      }
    } else {
      if (typeCode.startsWith("B")) commerces.push(item);
      else if (typeCode.startsWith("D")) sante.push(item);
      else if (typeCode.startsWith("A")) services.push(item);
      else if (typeCode.startsWith("C")) education.push(item);
      else if (typeCode.startsWith("F")) loisirs.push(item);
    }
  }
  [commerces, sante, services, education, loisirs].forEach(arr => arr.sort((a, b) => a.distance_m - b.distance_m));
  const total = commerces.length + sante.length + services.length + education.length + loisirs.length;
  let score = 30;
  if (total >= 30) score = 90; else if (total >= 20) score = 80; else if (total >= 10) score = 65;
  else if (total >= 5) score = 50; else if (total >= 2) score = 40;
  if (sante.length >= 3) score = Math.min(100, score + 5);
  const isApiSource = source === "api_datagouv";
  const fullCoverage = (isApiSource && records.length > 20) || total > 30;
  const zeroCats: string[] = [];
  if (commerces.length === 0) zeroCats.push("commerces");
  if (sante.length === 0) zeroCats.push("sante");
  if (services.length === 0) zeroCats.push("services");
  if (education.length === 0) zeroCats.push("education");
  if (loisirs.length === 0) zeroCats.push("loisirs");
  return {
    total_equipements: total, score,
    commerces: { count: commerces.length, details: commerces.slice(0, 10) },
    sante: { count: sante.length, details: sante.slice(0, 10) },
    services: { count: services.length, details: services.slice(0, 10) },
    education: { count: education.length, details: education.slice(0, 10) },
    loisirs: { count: loisirs.length, details: loisirs.slice(0, 10) },
    nb_ecoles: nbEcoles, nb_pharmacies: nbPharmacies, nb_supermarches: nbSupermarches, nb_universites: nbUniversites,
    coverage: total > 0 ? "ok" : "no_data",
    bpe_quality: { source: source === "api_datagouv" ? "api_datagouv" : source === "supabase" ? "supabase" : "none", raw_count: records.length, full_coverage: fullCoverage, zero_categories: zeroCats, suspected_partial_categories: fullCoverage ? [] : zeroCats, confidence: fullCoverage && isApiSource ? "forte" : fullCoverage ? "moyenne" : "faible" },
  };
}

// ============================================================================
// EHPAD CONCURRENCE
// ============================================================================

interface EhpadEtablissement { nom: string; distance_m: number; capacite: number; capacite_estimee?: boolean; finess?: string; }

async function fetchOverpassEhpad(lat: number, lon: number, radiusKm: number): Promise<EhpadEtablissement[]> {
  try {
    const radiusM = Math.min(radiusKm * 1000, 15000);
    const query = `[out:json][timeout:10];(node["healthcare"="nursing_home"](around:${radiusM},${lat},${lon});way["healthcare"="nursing_home"](around:${radiusM},${lat},${lon});node["amenity"="nursing_home"](around:${radiusM},${lat},${lon});way["amenity"="nursing_home"](around:${radiusM},${lat},${lon});node["social_facility"~"nursing_home|assisted_living"](around:${radiusM},${lat},${lon}););out center tags 40;`;
    const res = await queryOverpass(query);
    if (!res.ok) return [];
    const data = await res.json();
    const etablissements: EhpadEtablissement[] = [];
    for (const el of data.elements || []) {
      const elLat = el.lat || el.center?.lat; const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;
      const dist = haversine(lat, lon, elLat, elLon);
      if (dist > radiusM) continue;
      const tags = el.tags || {};
      etablissements.push({ nom: tags.name || "Établissement", distance_m: Math.round(dist), capacite: safeNum(tags.capacity || tags.beds) || 0 });
    }
    etablissements.sort((a, b) => a.distance_m - b.distance_m);
    return etablissements;
  } catch { console.warn("[EHPAD Overpass] Timeout ou indisponible"); return []; }
}

async function fetchEhpadConcurrence(lat: number, lon: number, radiusKm: number, dept: string | null) {
  const [overpassResults, tarifs] = await Promise.all([fetchOverpassEhpad(lat, lon, radiusKm), fetchEhpadTarifsFromSupabase(dept)]);
  const etablissements: EhpadEtablissement[] = overpassResults.map(e => ({ ...e, capacite: e.capacite || 60, capacite_estimee: !e.capacite || e.capacite === 0 }));
  const prices = tarifs.map(t => t.prix_hebergement_simple).filter((p): p is number => p != null && p > 0);
  const prixStats = prices.length > 0 ? { prix_hebergement_min: Math.round(Math.min(...prices) * 100) / 100, prix_hebergement_max: Math.round(Math.max(...prices) * 100) / 100, prix_hebergement_median: median(prices) ? Math.round(median(prices)! * 100) / 100 : null, prix_hebergement_moyen: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100, nb_etablissements_avec_prix: prices.length } : null;
  const g = (f: (t: EhpadTarifParsed) => number | null) => { const v = tarifs.map(f).filter((v): v is number => v != null && v > 0); return v.length > 0 ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };
  const girsStats = tarifs.length > 0 ? { tarif_gir_1_2_moyen: g(t => t.tarif_gir_1_2), tarif_gir_3_4_moyen: g(t => t.tarif_gir_3_4), tarif_gir_5_6_moyen: g(t => t.tarif_gir_5_6) } : null;
  const withCapacity = etablissements.filter(e => !e.capacite_estimee && e.capacite > 0);
  const avgCapacity = withCapacity.length > 0 ? Math.round(withCapacity.reduce((s, e) => s + e.capacite, 0) / withCapacity.length) : 60;
  for (const e of etablissements) { if (e.capacite_estimee) e.capacite = avgCapacity; }
  const totalLits = etablissements.reduce((s, e) => s + e.capacite, 0);
  return { etablissements: etablissements.slice(0, 25), count: etablissements.length, total_lits: totalLits, prix_stats: prixStats, tarifs_gir: girsStats, nb_ehpad_departement: tarifs.length, sources: { cnsa_tarifs: tarifs.length, overpass: overpassResults.length }, coverage: (tarifs.length > 0 || overpassResults.length > 0) ? "ok" as Coverage : "no_data" as Coverage };
}

// ============================================================================
// SPECIFIC DATA COMPUTATION
// ============================================================================

function computeEhpadSpecific(insee: InseeData | null, bpe: BpeData | null, concurrence: Awaited<ReturnType<typeof fetchEhpadConcurrence>>) {
  const population = insee?.population ?? 50000; const pct75 = insee?.pct_75_plus ?? 10;
  const pop75 = Math.round(population * (pct75 / 100));
  const densiteLits = pop75 > 0 ? Math.round((concurrence.total_lits / pop75) * 1000 * 10) / 10 : null;
  let tauxEquipement: "sous_equipe" | "equilibre" | "sur_equipe" = "equilibre";
  let potentiel: "fort" | "moyen" | "faible" = "moyen";
  if (densiteLits !== null) { if (densiteLits < 80) { tauxEquipement = "sous_equipe"; potentiel = "fort"; } else if (densiteLits > 150) { tauxEquipement = "sur_equipe"; potentiel = "faible"; } }
  const coutMensuelEstime = concurrence.prix_stats?.prix_hebergement_moyen && concurrence.tarifs_gir?.tarif_gir_1_2_moyen ? Math.round((concurrence.prix_stats.prix_hebergement_moyen + concurrence.tarifs_gir.tarif_gir_1_2_moyen) * 30.5) : null;
  return { concurrence, demographie_senior: { population_75_plus: pop75, pct_75_plus: pct75 }, offre_sante: { pharmacies: bpe?.nb_pharmacies ?? 0 }, indicateurs_marche: { densite_lits_1000_seniors: densiteLits, taux_equipement_zone: tauxEquipement, potentiel_marche: potentiel }, analyse_prix: concurrence.prix_stats ? { ...concurrence.prix_stats, ...concurrence.tarifs_gir, cout_mensuel_moyen_gir_1_2: coutMensuelEstime, interpretation: concurrence.prix_stats.prix_hebergement_median ? (concurrence.prix_stats.prix_hebergement_median < 70 ? "Prix compétitifs" : concurrence.prix_stats.prix_hebergement_median < 90 ? "Prix dans la moyenne" : "Prix élevés") : null } : null };
}

function computeLogementSpecific(insee: InseeData | null, dvf: DvfData | null, bpe: BpeData | null) {
  const population = insee?.population ?? 50000;
  return { demographie: { menages_total: Math.round(population / 2.2), pct_logements_vacants: insee?.pct_logements_vacants ?? 5, pct_moins_15: insee?.pct_moins_15 ?? 18, pct_familles: (insee?.pct_30_44 ?? 19) + (insee?.pct_moins_15 ?? 18) }, marche_immobilier: { prix_m2_ancien: dvf?.prix_m2_median ?? null, prix_m2_neuf: dvf?.prix_m2_median ? Math.round(dvf.prix_m2_median * 1.2) : null, evolution_prix_pct: dvf?.evolution_prix_pct ?? null }, cadre_vie: { nb_ecoles: bpe?.nb_ecoles ?? 0, nb_commerces: bpe?.commerces?.count ?? 0, nb_sante: bpe?.sante?.count ?? 0 }, indicateurs_marche: { tension_locative: (insee?.densite ?? 0) > 3000 ? "forte" : (insee?.densite ?? 0) > 1000 ? "moyenne" : "faible", attractivite_familiale: (bpe?.nb_ecoles ?? 0) >= 3 ? "forte" : "moyenne" } };
}

function computeCommerceSpecific(insee: InseeData | null, bpe: BpeData | null, transport: TransportData | null) {
  const revenuMedian = insee?.revenu_median ?? null; const revenuForCalc = revenuMedian ?? 21500;
  return { zone_chalandise: { population: insee?.population ?? 0, revenu_median: revenuMedian, pouvoir_achat: revenuForCalc > 25000 ? "élevé" : revenuForCalc > 20000 ? "moyen" : "faible", pouvoir_achat_indice: Math.round((revenuForCalc / 21500) * 100) }, concurrence: { commerces_total: bpe?.commerces?.count ?? 0, supermarches: bpe?.nb_supermarches ?? 0 }, flux_pietons: { score_flux: transport?.score ?? 50, proximite_metro: transport?.has_metro_train ?? false, proximite_tram: transport?.has_tram ?? false }, indicateurs_marche: { dynamisme_zone: (transport?.score ?? 0) > 70 ? "fort" : "moyen", saturation_commerciale: (bpe?.commerces?.count ?? 0) > 30 ? "élevée" : "normale" } };
}

function computeBureauxSpecific(insee: InseeData | null, transport: TransportData | null) {
  const population = insee?.population ?? 50000; const pctActifs = insee?.pct_actifs ?? 45;
  return { accessibilite: { score_transport: transport?.score ?? 50, metro_train: transport?.has_metro_train ?? false, tram: transport?.has_tram ?? false }, bassin_emploi: { population_active_estimee: Math.round(population * (pctActifs / 100)), pct_actifs: pctActifs, taux_chomage: insee?.taux_chomage ?? 7.5 }, indicateurs_marche: { attractivite_entreprises: (transport?.score ?? 0) > 75 ? "forte" : "moyenne", accessibilite_critique: transport?.has_metro_train ?? false } };
}

function computeEtudiantSpecific(insee: InseeData | null, bpe: BpeData | null, transport: TransportData | null) {
  const population = insee?.population ?? 50000; const pctEtudiants = insee?.pct_etudiants ?? 6; const hasUniv = (bpe?.nb_universites ?? 0) >= 1;
  return { population_etudiante: { estimee: Math.round(population * (pctEtudiants / 100)), pct_etudiants: pctEtudiants, pct_15_29: insee?.pct_15_29 ?? 16, presence_universitaire: hasUniv, nb_etablissements_superieurs: bpe?.nb_universites ?? 0 }, accessibilite: { score_transport: transport?.score ?? 50, metro_train: transport?.has_metro_train ?? false }, cadre_vie: { nb_bibliotheques: bpe?.loisirs?.count ?? 0, nb_loisirs: bpe?.loisirs?.count ?? 0 }, indicateurs_marche: { potentiel_marche: hasUniv || pctEtudiants > 8 ? "fort" : pctEtudiants > 5 ? "moyen" : "faible", marche_locatif: insee?.pct_locataires && insee.pct_locataires > 50 ? "actif" : "modéré" } };
}

function computeHotelSpecific(insee: InseeData | null, bpe: BpeData | null, transport: TransportData | null) {
  return { accessibilite: { score_transport: transport?.score ?? 50, metro_train: transport?.has_metro_train ?? false, tram: transport?.has_tram ?? false }, attractivite: { population: insee?.population ?? 0, densite: insee?.densite ?? 0, nb_loisirs: bpe?.loisirs?.count ?? 0, zone_touristique: (bpe?.loisirs?.count ?? 0) >= 5 }, indicateurs_marche: { potentiel: (transport?.score ?? 0) > 60 && (bpe?.loisirs?.count ?? 0) >= 3 ? "fort" : "moyen" } };
}

// ============================================================================
// SCORING DIFFÉRENCIÉ
// ============================================================================

interface ScoreAdjustment { label: string; value: number; type: 'bonus' | 'malus'; }
interface ScoringResult {
  demande: number; offre: number; accessibilite: number; environnement: number; global: number;
  adjustments: ScoreAdjustment[]; explanation: string; transport_exclu: boolean;
}

function computeDifferentiatedScores(dvf: DvfData | null, insee: InseeData | null, transport: TransportData | null, bpe: BpeData | null, specific: Record<string, unknown> | null, projectType: ProjectType): ScoringResult {
  const config = PROJECT_CONFIG[projectType];
  const weights = config.weights;
  const adjustments: ScoreAdjustment[] = [];
  let demande = 50, offre = 50, accessibilite = 50, environnement = 50;

  if (projectType === "ehpad") {
    const pct75 = insee?.pct_75_plus ?? 10;
    if (pct75 > 14) { demande += 25; adjustments.push({ label: "Pop. 75+ élevée", value: 25, type: 'bonus' }); }
    else if (pct75 > 11) { demande += 15; adjustments.push({ label: "Pop. 75+ correcte", value: 15, type: 'bonus' }); }
    else if (pct75 < 8) { demande -= 15; adjustments.push({ label: "Pop. 75+ faible", value: -15, type: 'malus' }); }
    const ind = specific?.indicateurs_marche as { potentiel_marche?: string } | undefined;
    if (ind?.potentiel_marche === "fort") { demande += 15; adjustments.push({ label: "Fort potentiel marché", value: 15, type: 'bonus' }); }
    else if (ind?.potentiel_marche === "faible") { demande -= 20; adjustments.push({ label: "Faible potentiel", value: -20, type: 'malus' }); }
  } else if (projectType === "residence_etudiante") {
    const pctE = insee?.pct_etudiants ?? 6;
    if (pctE > 10) { demande += 30; adjustments.push({ label: "Zone très étudiante", value: 30, type: 'bonus' }); }
    else if (pctE > 7) { demande += 20; adjustments.push({ label: "Zone étudiante", value: 20, type: 'bonus' }); }
    else if (pctE < 4) { demande -= 15; adjustments.push({ label: "Peu d'étudiants", value: -15, type: 'malus' }); }
    if ((insee?.pct_15_29 ?? 16) > 22) { demande += 10; adjustments.push({ label: "Pop. jeune élevée", value: 10, type: 'bonus' }); }
    if ((specific?.population_etudiante as { presence_universitaire?: boolean })?.presence_universitaire) { demande += 15; adjustments.push({ label: "Présence universitaire", value: 15, type: 'bonus' }); }
  } else if (projectType === "commerce") {
    const revenu = insee?.revenu_median ?? 21500; const densite = insee?.densite ?? 0;
    if (revenu > 26000) { demande += 20; adjustments.push({ label: "Haut pouvoir d'achat", value: 20, type: 'bonus' }); }
    else if (revenu > 23000) { demande += 10; adjustments.push({ label: "Bon pouvoir d'achat", value: 10, type: 'bonus' }); }
    else if (revenu < 19000) { demande -= 15; adjustments.push({ label: "Pouvoir d'achat faible", value: -15, type: 'malus' }); }
    if (densite > 3000) { demande += 15; adjustments.push({ label: "Zone très dense", value: 15, type: 'bonus' }); }
    else if (densite > 1000) demande += 8;
    else if (densite < 300) { demande -= 10; adjustments.push({ label: "Zone peu dense", value: -10, type: 'malus' }); }
  } else if (projectType === "bureaux") {
    if ((insee?.pct_actifs ?? 45) > 50) { demande += 15; adjustments.push({ label: "Fort bassin d'actifs", value: 15, type: 'bonus' }); }
    else if ((insee?.pct_actifs ?? 45) < 40) { demande -= 10; adjustments.push({ label: "Bassin d'actifs limité", value: -10, type: 'malus' }); }
    if ((insee?.taux_chomage ?? 7.5) > 10) { demande -= 10; adjustments.push({ label: "Chômage élevé", value: -10, type: 'malus' }); }
  } else if (projectType === "logement") {
    const pop = insee?.population ?? 0;
    if (pop > 100000) { demande += 15; adjustments.push({ label: "Grande agglomération", value: 15, type: 'bonus' }); }
    else if (pop > 30000) demande += 8;
    if ((insee?.pct_moins_15 ?? 18) > 20) { demande += 10; adjustments.push({ label: "Zone familiale", value: 10, type: 'bonus' }); }
    const tv = insee?.pct_logements_vacants ?? 8;
    if (tv > 12) { demande -= 15; adjustments.push({ label: "Vacance élevée", value: -15, type: 'malus' }); }
    else if (tv < 5) { demande += 10; adjustments.push({ label: "Tension locative", value: 10, type: 'bonus' }); }
  } else if (projectType === "hotel") {
    if ((bpe?.loisirs?.count ?? 0) >= 5) { demande += 15; adjustments.push({ label: "Zone touristique", value: 15, type: 'bonus' }); }
    if ((insee?.densite ?? 0) > 2000) demande += 10;
  }

  if (projectType === "ehpad") {
    const ind2 = specific?.indicateurs_marche as { taux_equipement_zone?: string } | undefined;
    if (ind2?.taux_equipement_zone === "sous_equipe") { offre += 25; adjustments.push({ label: "Zone sous-équipée", value: 25, type: 'bonus' }); }
    else if (ind2?.taux_equipement_zone === "sur_equipe") { offre -= 25; adjustments.push({ label: "Zone sur-équipée", value: -25, type: 'malus' }); }
    if ((specific?.concurrence as { count?: number } | undefined)?.count ?? 0 > 10) { offre -= 10; adjustments.push({ label: "Forte concurrence", value: -10, type: 'malus' }); }
  } else if (projectType === "commerce") {
    const nb = bpe?.commerces?.count ?? 0;
    if (nb > 30) { offre -= 15; adjustments.push({ label: "Forte concurrence commerciale", value: -15, type: 'malus' }); }
    else if (nb > 5 && nb < 20) { offre += 10; adjustments.push({ label: "Zone commerciale équilibrée", value: 10, type: 'bonus' }); }
  } else {
    if (dvf && dvf.nb_transactions > 50) offre += 15;
    else if (dvf && dvf.nb_transactions < 10) offre -= 10;
    if (dvf?.prix_m2_median) { if (dvf.prix_m2_median > 5000) offre += 10; else if (dvf.prix_m2_median < 2000) offre -= 10; }
  }

  environnement = bpe?.score ?? 50;
  if (projectType === "logement") {
    if ((bpe?.nb_ecoles ?? 0) >= 3) { environnement += 10; adjustments.push({ label: "Écoles à proximité", value: 10, type: 'bonus' }); }
    if ((bpe?.commerces?.count ?? 0) >= 5) environnement += 5;
  } else if (projectType === "ehpad") {
    if ((bpe?.sante?.count ?? 0) >= 3) { environnement += 15; adjustments.push({ label: "Services de santé", value: 15, type: 'bonus' }); }
    if ((bpe?.nb_pharmacies ?? 0) >= 2) environnement += 5;
  } else if (projectType === "residence_etudiante") {
    if ((bpe?.loisirs?.count ?? 0) >= 3) { environnement += 10; adjustments.push({ label: "Loisirs à proximité", value: 10, type: 'bonus' }); }
  }

  // v1.3.24 — is_urban déterministe : densité + population INSEE.
  // Ne dépend plus de la disponibilité d'Overpass. Overpass alimente le *score*
  // transport, jamais la décision d'inclure ou d'exclure le pilier.
  // Réf. : Ascain (241 hab./km², 4 658 hab.) oscillait entre 43 et 56.
  const densiteCommune = insee?.densite ?? 0;
  const popCommune = insee?.population ?? 0;
  const isUrban = densiteCommune >= 400 || popCommune >= 10_000;

  demande = Math.max(0, Math.min(100, demande));
  offre = Math.max(0, Math.min(100, offre));
  environnement = Math.max(0, Math.min(100, environnement));

  if (!isUrban) {
    accessibilite = 0;
    adjustments.push({ label: "Transport non évalué (zone non-urbaine)", value: 0, type: 'bonus' });
    const totalOther = weights.demande + weights.offre + weights.environnement;
    const wd = weights.demande / totalOther;
    const wo = weights.offre / totalOther;
    const we = weights.environnement / totalOther;
    const global = Math.max(0, Math.min(100, Math.round(demande * wd + offre * wo + environnement * we)));
    return { demande, offre, accessibilite, environnement, global, adjustments, transport_exclu: true, explanation: `Pondération ${projectType} (transport non applicable) : demande ${Math.round(wd * 100)}%, offre ${Math.round(wo * 100)}%, environnement ${Math.round(we * 100)}%` };
  }

  accessibilite = transport?.score ?? 50;
  if (projectType === "bureaux") {
    if (transport?.has_metro_train) { accessibilite += 15; adjustments.push({ label: "Métro/train à proximité", value: 15, type: 'bonus' }); }
    else if (!transport?.has_metro_train && !transport?.has_tram) { accessibilite -= 20; adjustments.push({ label: "Pas de transport lourd", value: -20, type: 'malus' }); }
  } else if (projectType === "residence_etudiante") {
    if (transport?.has_metro_train) { accessibilite += 10; adjustments.push({ label: "Transports en commun", value: 10, type: 'bonus' }); }
    if ((transport?.score ?? 0) < 40) { accessibilite -= 15; adjustments.push({ label: "Accessibilité insuffisante", value: -15, type: 'malus' }); }
  } else if (projectType === "logement" || projectType === "commerce") {
    if (transport?.has_metro_train) accessibilite += 10;
    if (transport?.has_tram) accessibilite += 5;
  }

  accessibilite = Math.max(0, Math.min(100, accessibilite));
  const global = Math.max(0, Math.min(100, Math.round(demande * weights.demande + offre * weights.offre + accessibilite * weights.accessibilite + environnement * weights.environnement)));
  return { demande, offre, accessibilite, environnement, global, adjustments, transport_exclu: false, explanation: `Pondération ${projectType}: ${Object.entries(weights).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${Math.round(v * 100)}%`).join(', ')}` };
}

// ============================================================================
// INSIGHTS — v1.3.20 : + insight absorption mensuelle
// ============================================================================

function generateInsights(dvf: DvfData | null, transport: TransportData | null, bpe: BpeData | null, specific: Record<string, unknown> | null, scores: ScoringResult, projectType: ProjectType, insee: InseeData | null) {
  const insights: Array<{ type: "positive" | "warning" | "negative" | "neutral"; category: string; message: string }> = [];

  if (insee?.revenu_median_source === 'dept_fallback') insights.push({ type: "warning", category: "insee", message: `Revenu médian estimé au niveau du département (source : référentiel Filosofi ${insee.departement})` });
  if (scores.global >= 70) insights.push({ type: "positive", category: "global", message: "Contexte de marché très favorable" });
  else if (scores.global >= 55) insights.push({ type: "positive", category: "global", message: "Contexte de marché favorable" });
  else if (scores.global < 40) insights.push({ type: "warning", category: "global", message: "Contexte de marché défavorable - Analyse approfondie recommandée" });

  if (dvf && dvf.nb_transactions > 0) {
    insights.push({ type: "neutral", category: "dvf", message: `${dvf.nb_transactions} transactions DVF analysées — prix médian : ${dvf.prix_m2_median?.toLocaleString("fr-FR") ?? "N/A"} €/m²` });
  }

  // v1.3.20 : insight absorption mensuelle
  if (dvf?.absorption_mensuelle != null) {
    const abs = dvf.absorption_mensuelle;
    const absAn = dvf.absorption_annuelle ?? 0;
    let rythme: string;
    let type: "positive" | "warning" | "neutral";
    if (abs < 5) { rythme = "marché peu liquide — délais de vente longs"; type = "warning"; }
    else if (abs < 20) { rythme = "rythme de vente modéré"; type = "neutral"; }
    else if (abs < 80) { rythme = "bon rythme de commercialisation"; type = "positive"; }
    else { rythme = "marché très actif"; type = "positive"; }
    insights.push({ type, category: "absorption", message: `Absorption : ${abs} transaction${abs > 1 ? 's' : ''}/mois sur le département (${absAn}/an sur 12 mois glissants) — ${rythme}` });
  }

  if (transport?.is_urban) {
    if (transport.has_metro_train) insights.push({ type: "positive", category: "transport", message: "Excellente desserte transport (métro/train)" });
    else if (transport.has_tram) insights.push({ type: "positive", category: "transport", message: "Bonne desserte transport (tramway)" });
    else if ((transport.score ?? 0) < 40) insights.push({ type: "warning", category: "transport", message: "Accessibilité transport limitée" });
  } else {
    insights.push({ type: "neutral", category: "transport", message: "Zone non-urbaine — critère transport non applicable" });
  }

  if (bpe && bpe.total_equipements > 0) {
    if (bpe.sante.count >= 3) insights.push({ type: "positive", category: "services", message: `${bpe.sante.count} établissements de santé à proximité` });
    if (bpe.commerces.count >= 5) insights.push({ type: "positive", category: "services", message: `${bpe.commerces.count} commerces de proximité` });
    if (bpe.education.count >= 2) insights.push({ type: "positive", category: "services", message: `${bpe.education.count} établissements d'enseignement à proximité` });
    if (bpe.loisirs.count >= 3) insights.push({ type: "positive", category: "services", message: `${bpe.loisirs.count} équipements de loisirs à proximité` });
  }

  const ind = specific?.indicateurs_marche as { taux_equipement_zone?: string; tension_locative?: string } | undefined;
  if (ind?.taux_equipement_zone === "sous_equipe") insights.push({ type: "positive", category: "concurrence", message: "Zone sous-équipée - Fort potentiel de développement" });
  else if (ind?.taux_equipement_zone === "sur_equipe") insights.push({ type: "warning", category: "concurrence", message: "Zone sur-équipée - Concurrence élevée" });
  if (ind?.tension_locative === "forte") insights.push({ type: "positive", category: "marche", message: "Marché locatif tendu - Forte demande" });

  const ap = specific?.analyse_prix as { prix_hebergement_median?: number; interpretation?: string } | undefined;
  if (ap?.prix_hebergement_median) insights.push({ type: "neutral", category: "prix", message: `Prix hébergement médian : ${ap.prix_hebergement_median.toFixed(0)} €/jour (${ap.interpretation})` });

  for (const adj of scores.adjustments.slice(0, 3)) {
    if (adj.type === 'bonus' && adj.value >= 15) insights.push({ type: "positive", category: "scoring", message: adj.label });
    else if (adj.type === 'malus' && adj.value <= -15) insights.push({ type: "warning", category: "scoring", message: adj.label });
  }

  return insights.slice(0, 12);
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const startTime = Date.now();
  try {
    if (req.method !== "POST") return new Response(JSON.stringify({ success: false, version: VERSION, error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const payload = await req.json();
    const isDebug = !!payload.debug;
    const timings: Record<string, number> = {};

    const t0 = Date.now();
    const location = await resolveCoordinates(payload);
    timings.geocoding = Date.now() - t0;

    if (!location) return new Response(JSON.stringify({ success: false, version: VERSION, error: "Impossible de géolocaliser. Fournir: address, commune_insee, parcel_id, ou lat/lon." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { lat, lon } = location;
    const projectType = normalizeProjectType(payload.project_type);
    const config = PROJECT_CONFIG[projectType];
    const radiusKm = Math.min(Math.max(payload.radius_km ?? config.defaultRadiusKm, 1), config.maxRadiusKm);

    const t1 = Date.now();
    const commune = await resolveCommune(lat, lon);
    timings.commune = Date.now() - t1;

    const codeInseeCommune = commune?.code_insee ?? null;
    const dept = commune?.departement ?? null;
    const communeNom = commune?.nom ?? null;
    const communePopulation = commune?.population ?? null;

    // Résout l'arrondissement (75056 → 75114, etc.) pour aligner INSEE/Filosofi sur le BPE.
    const codeInsee = codeInseeCommune
      ? await resolveArrondissementInsee(codeInseeCommune, lat, lon)
      : null;

    const [dvf, insee, transport, bpe] = await Promise.all([
      (async () => { const t = Date.now(); const r = await fetchDvfFromSupabase(dept, communeNom, codeInsee); timings.dvf = Date.now() - t; return r; })(),
      (async () => { const t = Date.now(); const r = codeInsee ? await fetchInseeData(codeInsee, communeNom, dept, commune, codeInseeCommune) : null; timings.insee = Date.now() - t; return r; })(),
      (async () => { const t = Date.now(); const r = await fetchTransport(lat, lon, dept, communePopulation); timings.transport = Date.now() - t; return r; })(),
      (async () => { const t = Date.now(); const r = await fetchBpeFromSupabase(lat, lon, codeInsee, dept, communeNom); timings.bpe = Date.now() - t; return r; })(),
    ]);

    let specific: Record<string, unknown> | null = null;
    const t2 = Date.now();
    if (projectType === "ehpad") { const concurrence = await fetchEhpadConcurrence(lat, lon, radiusKm, dept); specific = computeEhpadSpecific(insee, bpe, concurrence); }
    else if (projectType === "logement") specific = computeLogementSpecific(insee, dvf, bpe);
    else if (projectType === "commerce") specific = computeCommerceSpecific(insee, bpe, transport);
    else if (projectType === "bureaux") specific = computeBureauxSpecific(insee, transport);
    else if (projectType === "residence_etudiante") specific = computeEtudiantSpecific(insee, bpe, transport);
    else if (projectType === "hotel") specific = computeHotelSpecific(insee, bpe, transport);
    timings.specific = Date.now() - t2;

    const scores = computeDifferentiatedScores(dvf, insee, transport, bpe, specific, projectType);
    const insights = generateInsights(dvf, transport, bpe, specific, scores, projectType, insee);
    timings.total = Date.now() - startTime;

    const allWarnings: string[] = [];
    if (insee?.warnings?.length) allWarnings.push(...insee.warnings);

    const debugPayload = isDebug ? {
      timings,
      transport_is_urban: transport?.is_urban ?? false,
      transport_exclu: scores.transport_exclu,
      dvf_absorption: { mensuelle: dvf?.absorption_mensuelle ?? null, annuelle: dvf?.absorption_annuelle ?? null, horizon_mois: dvf?.horizon_mois_absorption ?? 12 },
      dvf_evolution: { pct: dvf?.evolution_prix_pct ?? null },
      bpe_domain_counts: bpe ? { commerces: bpe.commerces.count, sante: bpe.sante.count, education: bpe.education.count, loisirs: bpe.loisirs.count, services: bpe.services.count } : null,
      revenu_median_source: insee?.revenu_median_source ?? null,
      bpe_quality: bpe?.bpe_quality ?? null,
    } : undefined;

    return new Response(JSON.stringify({
      success: true, version: VERSION,
      meta: {
        lat, lon, location_source: location.source, location_label: location.label,
        commune_insee: codeInsee, commune_nom: communeNom, departement: dept,
        project_type: projectType, project_type_label: config.label,
        radius_km: radiusKm, generated_at: new Date().toISOString(),
      },
      core: { dvf, insee, transport, bpe },
      specific,
      scores: {
        demande: scores.demande, offre: scores.offre,
        ...(scores.transport_exclu ? {} : { accessibilite: scores.accessibilite }),
        environnement: scores.environnement, global: scores.global,
        transport_exclu: scores.transport_exclu,
      },
      scoring_details: { weights: config.weights, adjustments: scores.adjustments, explanation: scores.explanation, transport_exclu: scores.transport_exclu },
      insights,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
      debug: debugPayload,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[market-study] Error:", err);
    return new Response(JSON.stringify({ success: false, version: VERSION, error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});