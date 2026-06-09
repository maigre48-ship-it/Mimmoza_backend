// ============================================================================
// MARKET STUDY PROMOTEUR V1 - VERSION 1.2.3
// ============================================================================
// CHANGEMENTS v1.2.3:
// - FIX CRITIQUE BPE: suppression du filtre .like("typequ") côté DB
//   Ce filtre échouait silencieusement (casing TYPEQU vs typequ selon la table)
//   → tous les domaines retournaient 0 lignes en v1.2.2.
//   Solution: filtrage par domainPrefix en JavaScript après réception.
//
// CHANGEMENTS v1.2.2:
// - FIX BPE: 5 requêtes parallèles par domaine (A/B/C/D/F) — résout loisirs=0
//   sur Paris et toute commune avec >10k équipements dans le département.
//   L'approche limit(10000) sur le dept entier échouait pour Paris (~50k lignes).
// - FIX INSEE: 3e niveau de fallback revenu médian par département (table statique)
//   quand filosofi ET insee_socioeco_communes sont tous les deux vides.
// - NOUVEAU: pension_retraite_moyenne dans InseeData (depuis insee_socioeco_communes)
// - NOUVEAU: champs supplémentaires dans la réponse API (taux_pauvrete,
//   part_menages_imposes, pension_retraite_moyenne)
//
// CHANGEMENTS v1.2.1:
// - FIX: Revenu médian en cascade filosofi → insee_socioeco_communes
// - FIX: BPE requête géographique sans limit depcom
//
// CHANGEMENTS v1.2.0:
// - Revenu médian depuis table FiLoSoFi Supabase
// - Debug filosofi complet quand debug=true
//
// CHANGEMENTS v1.1.0:
// - Scoring différencié par type de projet
// - Fusion EHPAD + Résidence senior
// - Données INSEE enrichies
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

type ProjectType = 'logement' | 'commerce' | 'bureaux' | 'hotel' | 'residence_etudiante' | 'ehpad';
type Coverage = 'ok' | 'no_data' | 'partial' | 'error';

const VERSION = "1.3.5";
const GEO_API_BASE = "https://geo.api.gouv.fr";
const OVERPASS_API_URL = "https://overpass-api.de/api/interpreter";
const BAN_API_URL = "https://api-adresse.data.gouv.fr";

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

// v1.2.2: Fallback de dernier recours pour revenu médian par département
// Source: Filosofi 2021 (mediane UC en EUR/an)
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
  // Services (A)
  'A101': { label: 'Police', category: 'services' },
  'A104': { label: 'Gendarmerie', category: 'services' },
  'A203': { label: 'Banque', category: 'services' },
  'A206': { label: 'Bureau de poste', category: 'services' },
  'A207': { label: 'Relais poste', category: 'services' },
  'A208': { label: 'Agence postale', category: 'services' },
  // Commerces (B)
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
  // Éducation (C)
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
  // Santé (D)
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
  // Loisirs (F)
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

// Rayon BPE en mètres
const RAYON_BPE_M = 5000;
// API BPE externe data.gouv.fr (même source que smartscore-enriched-v3)
const DATA_GOUV_BPE_API = "https://tabular-api.data.gouv.fr/api/resources";
const BPE_RESOURCE_ID = "7257eb8b-f2eb-48f5-9c06-172675496269";

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
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
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
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
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
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
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
// DVF FROM SUPABASE
// ============================================================================

interface DvfData {
  nb_transactions: number;
  prix_m2_median: number | null;
  prix_m2_moyen: number | null;
  prix_m2_min: number | null;
  prix_m2_max: number | null;
  evolution_prix_pct: number | null;
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

async function fetchDvfFromSupabase(dept: string | null, communeNom: string | null): Promise<DvfData> {
  const empty: DvfData = {
    nb_transactions: 0, prix_m2_median: null, prix_m2_moyen: null,
    prix_m2_min: null, prix_m2_max: null, evolution_prix_pct: null,
    transactions: [], coverage: "no_data"
  };

  if (!dept) return empty;

  try {
    const supabase = getSupabaseClient();
    let query = supabase
      .from("dvf")
      .select("date_mutation, valeur_fonciere, surface_reelle_bati, type_local, commune, prix_m2")
      .eq("code_departement", dept)
      .not("prix_m2", "is", null)
      .gte("prix_m2", 500)
      .lte("prix_m2", 25000)
      .order("date_mutation", { ascending: false })
      .limit(500);

    // v1.2.4: On ne filtre PAS par nom de commune — le nom retourné par l'API
    // géo peut différer du format en base (accents, majuscules, abréviations).
    // Le filtre dept + prix suffit pour avoir des données représentatives.
    // La commune sera filtrée visuellement côté frontend si besoin.

    const { data, error } = await query;
    if (error || !data?.length) return empty;

    const prixM2Values = data.map(d => d.prix_m2).filter((p): p is number => p != null);
    const medianPrice = median(prixM2Values);
    const avgPrice = prixM2Values.length ? Math.round(prixM2Values.reduce((a, b) => a + b, 0) / prixM2Values.length) : null;

    return {
      nb_transactions: data.length,
      prix_m2_median: medianPrice ? Math.round(medianPrice) : null,
      prix_m2_moyen: avgPrice,
      prix_m2_min: prixM2Values.length ? Math.min(...prixM2Values) : null,
      prix_m2_max: prixM2Values.length ? Math.max(...prixM2Values) : null,
      evolution_prix_pct: null,
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
    // v1.3.4 : table réelle = filosofi_staging (pas "filosofi" qui n'existe pas)
    const { data, error } = await supabase.from("filosofi_staging").select("*").eq("codgeo", codeInsee).limit(1).maybeSingle();

    let row = data;
    if (!row && !error) {
      // Pas de seconde tentative nécessaire
      const data2 = null;
      row = data2;
    }

    if (error) {
      empty.warnings.push(`Erreur requête filosofi: ${error.message}`);
      empty.coverage = 'error';
      return empty;
    }

    if (!row) {
      empty.warnings.push(`Aucune donnée FiLoSoFi pour la commune ${codeInsee}`);
      return empty;
    }

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
        debug.med_latest = medCol;
        debug.med_value_raw = row[medCol.key];
        const v = safeNum(row[medCol.key]);
        if (v !== null && v > 0) {
          result.revenu_median = Math.round(v);
          result.incomeMedianUcEur = Math.round(v);
          result.incomeMedianUcYear = medCol.year;
          result.source = 'filosofi_short';
        }
      }
    } else {
      const medCol = findLatestColumn(allKeys, FILOSOFI_MED_RE);
      if (medCol) {
        result.incomeMedianUcYear = medCol.year;
        debug.med_latest = medCol;
        debug.med_value_raw = row[medCol.key];
      }
    }

    if (result.taux_pauvrete === null) {
      const txpauCol = findLatestColumn(allKeys, FILOSOFI_TXPAU_RE);
      if (txpauCol) {
        debug.txpau_latest = txpauCol;
        debug.txpau_value_raw = row[txpauCol.key];
        const v = safeNum(row[txpauCol.key]);
        if (v !== null) result.taux_pauvrete = Math.round(v * 10) / 10;
      }
    }

    if (result.part_menages_imposes === null) {
      const partimpCol = findLatestColumn(allKeys, FILOSOFI_PARTIMP_RE);
      if (partimpCol) {
        debug.partimp_latest = partimpCol;
        debug.partimp_value_raw = row[partimpCol.key];
        const v = safeNum(row[partimpCol.key]);
        if (v !== null) result.part_menages_imposes = Math.round(v * 10) / 10;
      }
    }

    result.coverage = result.revenu_median !== null ? 'ok' : 'partial';
    if (result.revenu_median === null) {
      result.warnings.push(`Ligne FiLoSoFi trouvée pour ${codeInsee} mais aucune colonne MEDxx/mediane_* exploitable.`);
    }

    return result;
  } catch (e) {
    console.error("[FILOSOFI] Error:", e);
    empty.warnings.push(`Exception filosofi: ${String(e)}`);
    empty.coverage = 'error';
    return empty;
  }
}

// ============================================================================
// INSEE DATA - v1.2.2
// Cascade: filosofi → insee_socioeco_communes → fallback département statique
// + pension_retraite_moyenne
// ============================================================================

interface InseeData {
  code_commune: string;
  commune_nom: string;
  departement: string;
  region: string;
  population: number;
  densite: number;
  revenu_median: number | null;
  revenu_median_source: 'filosofi' | 'socioeco' | 'dept_fallback' | 'none';
  incomeMedianUcEur: number | null;
  incomeMedianUcYear: number | null;
  taux_pauvrete: number | null;
  part_menages_imposes: number | null;
  pension_retraite_moyenne: number | null;
  taux_chomage: number | null;
  pct_proprietaires: number | null;
  pct_moins_15: number | null;
  pct_15_29: number | null;
  pct_30_44: number | null;
  pct_45_59: number | null;
  pct_60_74: number | null;
  pct_75_plus: number | null;
  pct_etudiants: number | null;
  pct_actifs: number | null;
  pct_logements_vacants: number | null;
  pct_locataires: number | null;
  // v1.3.2 — qualité de donnée enrichie
  economic_data_quality?: {
    revenu_median: "real" | "fallback" | "estimated" | "missing";
    revenu_moyen: "real" | "missing";
    niveau_vie_median: "real" | "derived" | "missing";
    tax_data: "real" | "missing";
    pcs_data: "real" | "partial" | "missing";
    evolution_data: "real" | "missing";
    socioeco_profile: "partial" | "complete" | "missing";
    fields_found_count: number;
  };
  // v1.3.0 — champs économiques enrichis (tous nullable, jamais inventés)
  revenu_median_uc?: number | null;
  revenu_moyen?: number | null;
  niveau_vie_median?: number | null;
  part_cadres?: number | null;
  part_professions_intermediaires?: number | null;
  part_employes?: number | null;
  part_ouvriers?: number | null;
  part_actifs_occupes?: number | null;
  evolution_population_5y?: number | null;
  evolution_revenu_5y?: number | null;
  evolution_chomage_5y?: number | null;
  taxe_fonciere_moyenne?: number | null;
  taxe_fonciere_evolution_3y?: number | null;
  // legacy compat
  revenu_source: 'filosofi' | 'none';
  coverage: Coverage;
  warnings: string[];
}

// ============================================================================
// v1.3.0 — HELPERS SOCIO-ÉCO ÉTENDUS
// ============================================================================

/**
 * Utilitaire : retourne la première valeur numérique valide parmi une liste
 * de clés candidates dans un objet, ou null si aucune n'est trouvée.
 * Indépendant du casing et des variations de nommage des colonnes Supabase.
 */
// ── v1.3.2 : Mapping centralisé des colonnes candidates ──────────────────────
// Permet de maintenir proprement les variantes de nommage sans les disperser.
const SOCIOECO_FIELD_CANDIDATES: Record<string, string[]> = {
  revenu_moyen: [
    'revenu_moyen_eur', 'revenu_moyen', 'rev_moyen', 'mean_income',
    'revenu_disponible_moyen', 'rev_disp_moyen', 'revenu_net_moyen',
  ],
  // v1.3.3 : taux_chomage dans le mapping (colonne taux_chomage_pct confirmée en base)
  taux_chomage: [
    'taux_chomage_pct', 'taux_chomage', 'tx_chomage', 'chomage_pct',
  ],
  niveau_vie_median: [
    'niveau_vie_median', 'niv_vie_median', 'mediane_niveau_vie',
    'mediane_rev_disp_uc', 'revenu_median_eur', 'med_niveau_vie',
    'niveauvie_median', 'niveau_de_vie_median',
  ],
  revenu_median_uc: [
    'revenu_median_uc_eur', 'revenu_median_uc', 'mediane_uc',
    'mediane_rev_disp_uc', 'revenu_median_eur', 'med_niveau_vie',
    'med19', 'med20', 'med21', 'med22',
  ],
  taux_pauvrete: [
    'taux_pauvrete_pct', 'taux_pauvrete', 'tx_pauvrete', 'txpau',
    'txpau19', 'txpau20', 'txpau21', 'txpau22', 'part_pauvrete',
  ],
  part_menages_imposes: [
    'part_menages_imposes_pct',  // ← colonne réelle en base (audit 2026-03)
    'part_menages_imposes', 'pct_menages_imposes', 'partimp',
    'part_imp', 'partimp19', 'partimp20', 'partimp21', 'partimp22',
  ],
  pension_retraite_moyenne: [
    'pension_retraite_moyenne_eur_mois', 'pension_retraite_moyenne',
    'pension_moyenne_eur', 'retraite_moyenne', 'pension_moy',
    'montant_pension_moyen', 'pension_moyenne_mensuelle',
  ],
  part_cadres: [
    'part_cadres', 'pct_cadres', 'part_cadres_pct', 'cadres_pct',
    'cs3_pct', 'p_cadres', 'part_cs3', 'c3_pct',
  ],
  part_professions_intermediaires: [
    'part_professions_intermediaires', 'pct_professions_intermediaires',
    'prof_inter_pct', 'cs4_pct', 'p_pi', 'part_cs4', 'c4_pct',
    'professions_intermediaires_pct',
  ],
  part_employes: [
    'part_employes', 'pct_employes', 'employes_pct', 'cs5_pct',
    'p_employes', 'part_cs5', 'c5_pct',
  ],
  part_ouvriers: [
    'part_ouvriers', 'pct_ouvriers', 'ouvriers_pct', 'cs6_pct',
    'p_ouvriers', 'part_cs6', 'c6_pct',
  ],
  part_actifs_occupes: [
    'part_actifs_occupes', 'pct_actifs_occupes', 'taux_emploi',
    'emploi_pct', 'actifs_occupes_pct', 'part_emploi',
    'taux_activite', 'p_actifs_occupes',
  ],
  evolution_revenu_5y: [
    'evolution_revenu_5y', 'evol_revenu_5y', 'variation_revenu_5y',
    'rev_evol_5y', 'delta_revenu_5y', 'tx_evol_revenu_5y',
  ],
  evolution_chomage_5y: [
    'evolution_chomage_5y', 'evol_chomage_5y', 'variation_chomage_5y',
    'delta_chomage_5y', 'tx_evol_chomage_5y',
  ],
  taxe_fonciere_moyenne: [
    'taxe_fonciere_moyenne', 'tf_moyenne', 'taxe_fonciere_moy',
    'tf_moy', 'taxe_fonciere_eur', 'montant_tf_moyen',
  ],
  taxe_fonciere_evolution_3y: [
    'taxe_fonciere_evolution_3y', 'tf_evol_3y', 'taxe_fonciere_evol',
    'delta_tf_3y', 'evolution_tf_3y',
  ],
  evolution_population_5y: [
    'evolution_population_5y', 'evol_pop_5y', 'variation_pop_5y',
    'pop_evol_5y', 'tx_evol_pop_5y', 'evolution_pop', 'pop_evolution',
    'delta_pop_5y',
  ],
};

/**
 * Retourne la première valeur numérique valide parmi les clés candidates.
 * Insensible à la casse. Retourne null si aucune clé ne correspond.
 */
function pickFirstNumeric(
  row: Record<string, unknown> | null | undefined,
  candidateKeys: string[],
): number | null {
  if (!row) return null;
  // Index insensible à la casse (construit une seule fois par appel)
  const lowerIndex: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    lowerIndex[k.toLowerCase()] = v;
  }
  for (const key of candidateKeys) {
    const val = lowerIndex[key.toLowerCase()];
    if (val == null || val === '' || val === 'ns' || val === 'nd') continue;
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.').replace(/\s/g, ''));
    if (Number.isFinite(n)) return Math.round(n * 100) / 100;
  }
  return null;
}

/** Raccourci : utilise le mapping centralisé */
function pickField(
  row: Record<string, unknown> | null | undefined,
  fieldName: keyof typeof SOCIOECO_FIELD_CANDIDATES,
): number | null {
  return pickFirstNumeric(row, SOCIOECO_FIELD_CANDIDATES[fieldName] ?? []);
}

interface SocioEcoExtended {
  revenu_moyen: number | null;
  niveau_vie_median: number | null;
  revenu_median_uc: number | null;
  part_cadres: number | null;
  part_professions_intermediaires: number | null;
  part_employes: number | null;
  part_ouvriers: number | null;
  part_actifs_occupes: number | null;
  taux_pauvrete: number | null;
  taux_chomage: number | null;          // v1.3.3 : taux_chomage_pct confirmé en base
  part_menages_imposes: number | null;
  pension_retraite_moyenne: number | null;
  evolution_revenu_5y: number | null;
  evolution_chomage_5y: number | null;
  taxe_fonciere_moyenne: number | null;
  taxe_fonciere_evolution_3y: number | null;
  // debug
  _fields_found: string[];
}

interface PopulationEvolution {
  evolution_population_5y: number | null;
}

/**
 * Enrichissement socio-éco étendu depuis insee_socioeco_communes.
 * Utilise pickFirstNumeric pour être robuste aux variations de schéma.
 * Ne retourne jamais de fausse donnée — null si non trouvée.
 */
async function fetchSocioEcoExtended(codeInsee: string): Promise<SocioEcoExtended> {
  const empty: SocioEcoExtended = {
    revenu_moyen: null, niveau_vie_median: null, revenu_median_uc: null,
    part_cadres: null, part_professions_intermediaires: null,
    part_employes: null, part_ouvriers: null, part_actifs_occupes: null,
    taux_pauvrete: null, taux_chomage: null, part_menages_imposes: null,
    pension_retraite_moyenne: null, evolution_revenu_5y: null, evolution_chomage_5y: null,
    taxe_fonciere_moyenne: null, taxe_fonciere_evolution_3y: null,
    _fields_found: [],
  };

  if (!codeInsee) return empty;

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("insee_socioeco_communes")
      .select("*")
      .eq("code_commune", codeInsee)
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      if (error) console.warn("[SocioEco] Erreur:", error.message);
      return empty;
    }

    const row = data as Record<string, unknown>;
    const found: string[] = [];

    // v1.3.2 : utilise pickField + SOCIOECO_FIELD_CANDIDATES centralisé
    const pf = (field: keyof typeof SOCIOECO_FIELD_CANDIDATES): number | null => {
      const v = pickField(row, field);
      if (v !== null) found.push(field);
      return v;
    };

    const result: SocioEcoExtended = {
      revenu_moyen:                    pf('revenu_moyen'),
      niveau_vie_median:               pf('niveau_vie_median'),
      revenu_median_uc:                pf('revenu_median_uc'),
      part_cadres:                     pf('part_cadres'),
      part_professions_intermediaires: pf('part_professions_intermediaires'),
      part_employes:                   pf('part_employes'),
      part_ouvriers:                   pf('part_ouvriers'),
      part_actifs_occupes:             pf('part_actifs_occupes'),
      taux_pauvrete:                   pf('taux_pauvrete'),
      taux_chomage:                    pf('taux_chomage'),
      part_menages_imposes:            pf('part_menages_imposes'),
      pension_retraite_moyenne:        pf('pension_retraite_moyenne'),
      evolution_revenu_5y:             pf('evolution_revenu_5y'),
      evolution_chomage_5y:            pf('evolution_chomage_5y'),
      taxe_fonciere_moyenne:           pf('taxe_fonciere_moyenne'),
      taxe_fonciere_evolution_3y:      pf('taxe_fonciere_evolution_3y'),
      _fields_found: found,
    };

    console.log(`[SocioEco] ${codeInsee} — ${found.length} champs trouvés: [${found.join(', ')}]`);
    return result;
  } catch (e) {
    console.warn("[SocioEco] Exception:", e);
    return empty;
  }
}

/**
 * Évolution de la population sur 5 ans depuis la table insee_communes_stats
 * ou insee_socioeco_communes. Retourne null si non disponible.
 */
async function fetchPopulationEvolution(codeInsee: string): Promise<PopulationEvolution> {
  const empty: PopulationEvolution = { evolution_population_5y: null };
  if (!codeInsee) return empty;

  try {
    const supabase = getSupabaseClient();

    // Tentative 1 : insee_communes_stats
    const { data: statsRow } = await supabase
      .from("insee_communes_stats")
      .select("*")
      .eq("code_commune", codeInsee)
      .limit(1)
      .maybeSingle();

    if (statsRow) {
      const v = pickField(statsRow as Record<string, unknown>, 'evolution_population_5y');
      if (v !== null) return { evolution_population_5y: v };
    }

    // Tentative 2 : insee_socioeco_communes
    const { data: socioRow } = await supabase
      .from("insee_socioeco_communes")
      .select("evolution_population_5y, evol_pop_5y, variation_pop_5y")
      .eq("code_commune", codeInsee)
      .limit(1)
      .maybeSingle();

    if (socioRow) {
      const v = pickFirstNumeric(
        socioRow as Record<string, unknown>,
        ['evolution_population_5y', 'evol_pop_5y', 'variation_pop_5y']
      );
      if (v !== null) return { evolution_population_5y: v };
    }

    return empty;
  } catch (e) {
    console.warn("[PopEvol] Exception:", e);
    return empty;
  }
}

async function fetchInseeData(codeInsee: string, communeNom: string | null, dept: string | null): Promise<InseeData | null> {
  try {
    // v1.3.5 : ne jamais retourner null si GEO échoue — fallback local
    const url = `${GEO_API_BASE}/communes/${codeInsee}?fields=code,nom,departement,region,population,surface`;
    let data: {
      nom?: string; population?: number; surface?: number;
      departement?: { code?: string }; region?: { nom?: string };
    } = {};
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) data = await res.json();
      else console.warn(`[INSEE] GEO HTTP ${res.status} — fallback local pour ${codeInsee}`);
    } catch (geoErr) {
      console.warn("[INSEE] GEO indisponible — fallback local pour", codeInsee);
    }

    const deptCode = dept ?? data.departement?.code ?? codeInsee.substring(0, 2);
    const surface = data.surface ? data.surface / 100 : 1;
    const densite = surface > 0 ? Math.round((data.population ?? 0) / surface) : 0;

    const demoData = DEMOGRAPHICS_DEPT[deptCode] || DEMOGRAPHICS_DEPT["default"];

    let pct75Adjusted = demoData.pct_75_plus;
    if (densite < 100) pct75Adjusted = Math.min(18, demoData.pct_75_plus + 4);
    else if (densite < 500) pct75Adjusted = Math.min(14, demoData.pct_75_plus + 2);
    else if (densite > 5000) pct75Adjusted = Math.max(6, demoData.pct_75_plus - 2);

    let pctEtudiantsAdjusted = demoData.pct_etudiants;
    if (densite > 5000) pctEtudiantsAdjusted = Math.min(15, demoData.pct_etudiants + 3);
    else if (densite < 500) pctEtudiantsAdjusted = Math.max(1, demoData.pct_etudiants - 3);

    // ── STEP 1 : FiLoSoFi ──────────────────────────────────────────────────
    const filosofi = await fetchFilosofiData(codeInsee);

    let revenuMedian: number | null = filosofi.revenu_median;
    let tauxPauvrete: number | null = filosofi.taux_pauvrete;
    let partMenagesImposes: number | null = filosofi.part_menages_imposes;
    let pensionRetraiteMoyenne: number | null = null;
    let revenuMedianSource: InseeData['revenu_median_source'] = revenuMedian !== null ? 'filosofi' : 'none';

    // ── STEP 2 : Cascade → insee_socioeco_communes (via fetchSocioEcoExtended) ─
    // v1.3.0 : on appelle toujours fetchSocioEcoExtended pour récupérer
    // TOUS les champs enrichis, pas seulement revenu_median.
    const [socioEco, popEvol] = await Promise.all([
      fetchSocioEcoExtended(codeInsee),
      fetchPopulationEvolution(codeInsee),
    ]);

    if (revenuMedian === null) {
      // Cascade revenu médian depuis socioeco
      // v1.3.3 : revenu_median_eur est la colonne réelle confirmée par audit SQL
      const socioMedian = socioEco.revenu_median_uc ?? socioEco.niveau_vie_median;
      if (socioMedian != null) {
        revenuMedian = socioMedian;
        revenuMedianSource = 'socioeco';
        console.log(`[INSEE] Revenu médian via socioeco: ${revenuMedian} €/an (${codeInsee})`);
      }
    }

    // Compléter les champs depuis socioeco si filosofi les a manqués
    if (tauxPauvrete === null)        tauxPauvrete = socioEco.taux_pauvrete;
    if (partMenagesImposes === null)  partMenagesImposes = socioEco.part_menages_imposes;
    if (pensionRetraiteMoyenne === null) pensionRetraiteMoyenne = socioEco.pension_retraite_moyenne;



    // ── STEP 3 : Fallback département statique ─────────────────────────────
    // v1.2.2: dernier recours si les deux tables sont vides
    if (revenuMedian === null) {
      const deptFallback = REVENU_MEDIAN_DEPT_FALLBACK[deptCode] ?? REVENU_MEDIAN_DEPT_FALLBACK["default"];
      revenuMedian = deptFallback;
      revenuMedianSource = 'dept_fallback';
      console.log(`[INSEE] Revenu médian via fallback dept ${deptCode}: ${revenuMedian} €/an (estimation)`);
    }

    const warnings: string[] = [...filosofi.warnings];

    // Avertir seulement si on utilise le fallback département (estimation grossière)
    // Avertissement selon la source
    if (revenuMedianSource === 'dept_fallback') {
      warnings.push(
        `Revenu médian estimé (département ${deptCode}) — données FiLoSoFi et socioeco absentes pour ${codeInsee}.`
      );
    }
    
    // Sécurité finale : si toujours null après tous les fallbacks, forcer le fallback dept
    if (revenuMedian === null) {
      const ultimateFallback = REVENU_MEDIAN_DEPT_FALLBACK[deptCode] ?? REVENU_MEDIAN_DEPT_FALLBACK["default"] ?? 22000;
      revenuMedian = ultimateFallback;
      revenuMedianSource = 'dept_fallback';
      console.warn(`[INSEE] Fallback ultime revenu médian dept ${deptCode}: ${ultimateFallback}`);
    }

    // v1.3.3 : taux_chomage depuis socioeco en priorité (taux_chomage_pct en base)
    // sinon fallback département
    const tauxChomage = socioEco.taux_chomage
      ?? TAUX_CHOMAGE_DEPT[deptCode]
      ?? TAUX_CHOMAGE_DEPT["default"]
      ?? null;

    const coverage: Coverage = revenuMedianSource === 'filosofi' ? 'ok'
      : revenuMedianSource === 'socioeco' ? 'ok'
      : 'partial';

    return {
      code_commune: codeInsee,
      commune_nom: data.nom || communeNom || "",
      departement: deptCode,
      region: data.region?.nom || "",
      population: data.population ?? 0,
      densite,
      revenu_median: revenuMedian,
      revenu_median_source: revenuMedianSource,
      incomeMedianUcEur: filosofi.incomeMedianUcEur ?? revenuMedian,
      incomeMedianUcYear: filosofi.incomeMedianUcYear,
      taux_pauvrete: tauxPauvrete,
      part_menages_imposes: partMenagesImposes,
      pension_retraite_moyenne: pensionRetraiteMoyenne,
      taux_chomage: tauxChomage,
      pct_proprietaires: 58,
      pct_moins_15: demoData.pct_moins_15,
      pct_15_29: demoData.pct_15_29,
      pct_30_44: demoData.pct_30_44,
      pct_45_59: demoData.pct_45_59,
      pct_60_74: demoData.pct_60_74,
      pct_75_plus: pct75Adjusted,
      pct_etudiants: pctEtudiantsAdjusted,
      pct_actifs: demoData.pct_actifs,
      pct_logements_vacants: densite < 200 ? 12 : densite < 1000 ? 8 : 5,
      pct_locataires: densite > 3000 ? 55 : densite > 1000 ? 45 : 35,
      // v1.3.0 — champs économiques enrichis (null si non disponibles en base)
      revenu_median_uc:                socioEco.revenu_median_uc,
      revenu_moyen:                    socioEco.revenu_moyen,
      niveau_vie_median:               socioEco.niveau_vie_median ?? revenuMedian,
      part_cadres:                     socioEco.part_cadres,
      part_professions_intermediaires: socioEco.part_professions_intermediaires,
      part_employes:                   socioEco.part_employes,
      part_ouvriers:                   socioEco.part_ouvriers,
      part_actifs_occupes:             socioEco.part_actifs_occupes,
      evolution_population_5y:         popEvol.evolution_population_5y,
      evolution_revenu_5y:             socioEco.evolution_revenu_5y,
      evolution_chomage_5y:            socioEco.evolution_chomage_5y,
      taxe_fonciere_moyenne:           socioEco.taxe_fonciere_moyenne,
      taxe_fonciere_evolution_3y:      socioEco.taxe_fonciere_evolution_3y,
      // v1.3.1 — qualité de donnée exposée au front
      // v1.3.2 — qualité de donnée plus cohérente et exploitable
      economic_data_quality: (() => {
        const revenuQuality: "real" | "fallback" | "estimated" | "missing" =
          revenuMedianSource === 'filosofi'     ? 'real'
          : revenuMedianSource === 'socioeco'   ? 'real'
          : revenuMedianSource === 'dept_fallback' ? 'fallback'
          : 'missing';

        const ff = socioEco._fields_found;
        const pcsFields = ['part_cadres', 'part_employes', 'part_ouvriers', 'part_professions_intermediaires'];
        const pcsFound = pcsFields.filter(f => ff.includes(f)).length;

        // Profil socio-éco : missing / partial / complete
        // complete = revenu + pauvreté + PCS + actifs
        // partial = au moins revenu ou 2 champs
        // missing = rien
        const coreFields = ['taux_pauvrete', 'part_menages_imposes', 'pension_retraite_moyenne'];
        const coreFound = coreFields.filter(f => ff.includes(f)).length;
        const totalFound = ff.length;

        const socioProfile: "partial" | "complete" | "missing" =
          totalFound === 0        ? 'missing'
          : totalFound >= 6 && pcsFound >= 2 && coreFound >= 2 ? 'complete'
          : 'partial';

        return {
          revenu_median: revenuQuality,
          revenu_moyen: socioEco.revenu_moyen != null ? 'real' : 'missing',
          niveau_vie_median:
            socioEco.niveau_vie_median != null ? 'real'
            : revenuMedian != null              ? 'derived'
            : 'missing',
          tax_data: socioEco.taxe_fonciere_moyenne != null ? 'real' : 'missing',
          pcs_data: pcsFound >= 2 ? 'real' : pcsFound === 1 ? 'partial' : 'missing',
          evolution_data:
            (socioEco.evolution_revenu_5y != null || socioEco.evolution_chomage_5y != null)
            ? 'real' : 'missing',
          socioeco_profile: socioProfile,
          fields_found_count: totalFound,
        };
      })(),
      // legacy
      revenu_source: revenuMedianSource !== 'none' ? 'filosofi' : 'none',
      coverage,
      warnings,
    };
  } catch (e) {
    console.error("[INSEE] Error:", e);
    return null;
  }
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
  coverage: Coverage;
}

const MAJOR_CITIES_FALLBACK: Record<string, TransportData> = {
  "75": { score: 95, stops: [{ name: "Transport Paris (estimation)", type: "metro", distance_m: 300 }], nearest_stop_m: 300, has_metro_train: true, has_tram: true, coverage: "ok" },
  "69": { score: 85, stops: [{ name: "Transport Métropole (estimation)", type: "metro", distance_m: 300 }], nearest_stop_m: 300, has_metro_train: true, has_tram: true, coverage: "ok" },
  "13": { score: 80, stops: [{ name: "Transport Métropole (estimation)", type: "metro", distance_m: 400 }], nearest_stop_m: 400, has_metro_train: true, has_tram: true, coverage: "ok" },
  "31": { score: 80, stops: [{ name: "Transport Métropole (estimation)", type: "metro", distance_m: 300 }], nearest_stop_m: 300, has_metro_train: true, has_tram: false, coverage: "ok" },
  "59": { score: 75, stops: [{ name: "Transport Métropole (estimation)", type: "metro", distance_m: 350 }], nearest_stop_m: 350, has_metro_train: true, has_tram: true, coverage: "ok" },
  "33": { score: 75, stops: [{ name: "Transport Métropole (estimation)", type: "tram", distance_m: 350 }], nearest_stop_m: 350, has_metro_train: false, has_tram: true, coverage: "ok" },
  "44": { score: 70, stops: [{ name: "Transport Métropole (estimation)", type: "tram", distance_m: 400 }], nearest_stop_m: 400, has_metro_train: false, has_tram: true, coverage: "ok" },
  "67": { score: 75, stops: [{ name: "Transport Métropole (estimation)", type: "tram", distance_m: 350 }], nearest_stop_m: 350, has_metro_train: false, has_tram: true, coverage: "ok" },
  "06": { score: 70, stops: [{ name: "Transport Métropole (estimation)", type: "tram", distance_m: 400 }], nearest_stop_m: 400, has_metro_train: false, has_tram: true, coverage: "ok" },
  "34": { score: 70, stops: [{ name: "Transport Métropole (estimation)", type: "tram", distance_m: 400 }], nearest_stop_m: 400, has_metro_train: false, has_tram: true, coverage: "ok" },
};

async function fetchTransport(lat: number, lon: number, dept: string | null): Promise<TransportData> {
  const emptyTransport: TransportData = { score: 30, stops: [], nearest_stop_m: null, has_metro_train: false, has_tram: false, coverage: "no_data" };

  if (dept && MAJOR_CITIES_FALLBACK[dept]) return MAJOR_CITIES_FALLBACK[dept];

  try {
    const radius = 1000;
    const query = `[out:json][timeout:10];(node["public_transport"="stop_position"](around:${radius},${lat},${lon});node["railway"="station"](around:${radius},${lat},${lon});node["railway"="halt"](around:${radius},${lat},${lon});node["highway"="bus_stop"](around:${radius},${lat},${lon}););out tags 30;`;

    const res = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) return emptyTransport;

    const data = await res.json();
    if (!data?.elements?.length) return emptyTransport;

    const stops: Array<{ name: string; type: string; distance_m: number }> = [];
    let hasMetroTrain = false;
    let hasTram = false;

    for (const el of data.elements) {
      if (!el.lat || !el.lon) continue;
      const dist = haversine(lat, lon, el.lat, el.lon);
      const tags = el.tags || {};

      let type = "bus";
      if (tags.railway === "station" || tags.railway === "halt" || tags.train === "yes") {
        type = "train"; hasMetroTrain = true;
      } else if (tags.subway === "yes" || tags.station === "subway") {
        type = "metro"; hasMetroTrain = true;
      } else if (tags.tram === "yes" || tags.railway === "tram_stop") {
        type = "tram"; hasTram = true;
      }

      stops.push({ name: tags.name || "Arrêt", type, distance_m: Math.round(dist) });
    }

    stops.sort((a, b) => a.distance_m - b.distance_m);
    const nearest = stops[0]?.distance_m ?? null;

    let score = 30;
    if (nearest !== null) {
      if (nearest < 300) score = 90;
      else if (nearest < 500) score = 75;
      else if (nearest < 800) score = 60;
      else score = 45;
    }
    if (hasMetroTrain) score = Math.min(100, score + 10);
    if (hasTram) score = Math.min(100, score + 5);

    return { score, stops: stops.slice(0, 15), nearest_stop_m: nearest, has_metro_train: hasMetroTrain, has_tram: hasTram, coverage: "ok" };
  } catch {
    return emptyTransport;
  }
}

// ============================================================================
// BPE FROM SUPABASE - v1.2.2
// 5 REQUÊTES PARALLÈLES PAR DOMAINE (A/B/C/D/F)
//
// PROBLÈME des versions précédentes :
//   v1.2.0 : .eq("depcom", codeInsee).limit(500) → tronquait D/C/F sur communes denses
//   v1.2.1 : .like("depcom", dept%).limit(10000) → insuffisant pour Paris (~50k lignes)
//
// SOLUTION v1.2.2 : une requête par préfixe de domaine BPE (A/B/C/D/F), exécutées
// en Promise.all. Chaque requête est filtrée sur le domaine ET le département,
// avec une limite haute (5000 par domaine = 25000 max total). Le filtre géo
// haversine est appliqué ensuite côté client.
// ============================================================================

interface BpeData {
  total_equipements: number;
  score: number;
  commerces: { count: number; details: Array<{ label: string; distance_m: number }> };
  sante: { count: number; details: Array<{ label: string; distance_m: number }> };
  services: { count: number; details: Array<{ label: string; distance_m: number }> };
  education: { count: number; details: Array<{ label: string; distance_m: number }> };
  loisirs: { count: number; details: Array<{ label: string; distance_m: number }> };
  nb_ecoles: number;
  nb_pharmacies: number;
  nb_supermarches: number;
  nb_universites: number;
  coverage: Coverage;
  // v1.3.2 — qualité de la source BPE (enrichie)
  bpe_quality?: {
    source: "api_datagouv" | "supabase" | "none";
    raw_count: number;
    full_coverage: boolean;
    zero_categories: string[];
    /** Catégories à 0 mais dont on suspecte que la source est partielle */
    suspected_partial_categories: string[];
    /** Niveau de confiance global de la couverture BPE */
    confidence: "forte" | "moyenne" | "faible";
  };
}

type BpeDomainRow = {
  depcom: string;
  typequ: string;
  nomrs: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
};

async function fetchBpeFromSupabase(
  lat: number,
  lon: number,
  codeInsee: string | null,
  dept: string | null,
): Promise<BpeData> {
  const emptyBpe: BpeData = {
    total_equipements: 0, score: 30,
    commerces: { count: 0, details: [] },
    sante: { count: 0, details: [] },
    services: { count: 0, details: [] },
    education: { count: 0, details: [] },
    loisirs: { count: 0, details: [] },
    nb_ecoles: 0, nb_pharmacies: 0, nb_supermarches: 0, nb_universites: 0,
    coverage: "no_data",
  };

  // ── v1.2.9 : DIAGNOSTIC & FIX DÉFINITIF ───────────────────────────────
  //
  // CAUSE RACINE IDENTIFIÉE après 8 versions :
  //   La table Supabase `bpe_equipements` ne contient QUE les domaines A
  //   (services) et B (commerces). Les domaines C (éducation), D (santé)
  //   et F (loisirs) n'ont JAMAIS été chargés dans cette table.
  //   → Toutes les approches Supabase (eq, like, gte/lt, pagination)
  //     retournaient exactement 186+314 = 500 équipements pour Bordeaux,
  //     sans jamais voir D/C/F.
  //
  // SOLUTION : utiliser l'API externe data.gouv.fr (même source que
  //   smartscore-enriched-v3 qui obtient les bons résultats).
  //   Fallback : Supabase si l'API externe échoue.
  //
  // API : tabular-api.data.gouv.fr, resource BPE 2023, filtre DEPCOM__exact

  const deptCode = dept ?? (codeInsee ? codeInsee.slice(0, 2) : null);
  if (!codeInsee && !deptCode) {
    console.warn("[BPE] Pas de commune/département disponible");
    return emptyBpe;
  }

  // ── v1.3.4 : ORDRE DE PRIORITÉ BPE RÉVISÉ ───────────────────────────────
  // 1. bpe_import_temp (Supabase, tous domaines A/B/C/D/F)
  // 2. API data.gouv.fr (externe)
  // 3. bpe_equipements (A+B seulement, dernier recours)

  // ── STEP 1 : bpe_import_temp ──────────────────────────────────────────
  if (codeInsee) {
    try {
      const supabase = getSupabaseClient();
      // v1.3.5 : schéma réel = depcom, typequ, latitude, longitude, nb_equip (pas nomrs)
      const { data: importData, error: importError } = await supabase
        .from("bpe_import_temp")
        .select("depcom, typequ, latitude, longitude, nb_equip")
        .eq("depcom", codeInsee);

      if (!importError && importData && importData.length > 0) {
        // Table agrégée : nb_equip = nb d'équipements de ce type
        // On expand pour que processBpeRecords compte correctement
        const records = (importData as Array<Record<string, unknown>>).flatMap(r => {
          const count = Math.max(1, Number(r.nb_equip ?? 1));
          return Array.from({ length: count }, () => ({
            TYPEQU: String(r.typequ || ""),
            NOM: "",
            LATITUDE: String(r.latitude || ""),
            LONGITUDE: String(r.longitude || ""),
            DEPCOM: String(r.depcom || ""),
          }));
        });
        console.log(`[BPE] v1.3.5 bpe_import_temp: ${importData.length} types → ${records.length} équipements`);
        return processBpeRecords(records, lat, lon, "api_datagouv");
      }
      if (importError) console.warn("[BPE] bpe_import_temp erreur:", importError.message);
      else console.log("[BPE] bpe_import_temp vide pour", codeInsee, "— fallback API");
    } catch (e) {
      console.warn("[BPE] bpe_import_temp exception:", e);
    }
  }

  // ── STEP 2 : API data.gouv.fr ─────────────────────────────────────────
  if (codeInsee) {
    try {
      const apiUrl = `${DATA_GOUV_BPE_API}/${BPE_RESOURCE_ID}/data/?DEPCOM__exact=${codeInsee}&page_size=2000`;
      console.log(`[BPE] v1.3.4 API data.gouv.fr: ${apiUrl}`);
      const resp = await fetch(apiUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        const json = await resp.json();
        const records: Array<Record<string, string>> = json.data || [];
        console.log(`[BPE] API: ${records.length} équipements pour ${codeInsee}`);
        if (records.length > 0) return processBpeRecords(records, lat, lon, "api_datagouv");
      } else {
        console.warn(`[BPE] API HTTP ${resp.status}`);
      }
    } catch (e) {
      console.warn("[BPE] API erreur:", e);
    }
  }

  // ── STEP 3 : bpe_equipements (A+B seulement) ─────────────────────────
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("bpe_equipements")
      .select("depcom, typequ, nomrs, latitude, longitude")
      .eq("depcom", codeInsee || "");
    if (!error && data && data.length > 0) {
      console.log(`[BPE] Fallback bpe_equipements: ${data.length} lignes`);
      const records = (data as Array<Record<string, unknown>>).map(r => ({
        TYPEQU: String(r.typequ || ""),
        NOM: String(r.nomrs || ""),
        LATITUDE: String(r.latitude || ""),
        LONGITUDE: String(r.longitude || ""),
        DEPCOM: String(r.depcom || ""),
      }));
      return processBpeRecords(records, lat, lon, "supabase");
    }
  } catch (e) {
    console.error("[BPE] bpe_equipements erreur:", e);
  }

  return emptyBpe;
}

/**
 * Traite les enregistrements BPE (format API data.gouv.fr ou Supabase normalisé)
 * et retourne un BpeData complet.
 */
function processBpeRecords(
  records: Array<Record<string, string>>,
  lat: number,
  lon: number,
  source: string,
): BpeData {
  const emptyBpe: BpeData = {
    total_equipements: 0, score: 30,
    commerces: { count: 0, details: [] },
    sante: { count: 0, details: [] },
    services: { count: 0, details: [] },
    education: { count: 0, details: [] },
    loisirs: { count: 0, details: [] },
    nb_ecoles: 0, nb_pharmacies: 0, nb_supermarches: 0, nb_universites: 0,
    coverage: "no_data",
  };

  const commerces: Array<{ label: string; distance_m: number }> = [];
  const sante: Array<{ label: string; distance_m: number }> = [];
  const services: Array<{ label: string; distance_m: number }> = [];
  const education: Array<{ label: string; distance_m: number }> = [];
  const loisirs: Array<{ label: string; distance_m: number }> = [];

  let nbEcoles = 0, nbPharmacies = 0, nbSupermarches = 0, nbUniversites = 0;

  for (const r of records) {
    // Colonnes possibles selon la source (API = TYPEQU/LATITUDE/LONGITUDE, Supabase = typequ/latitude/longitude)
    const rawCode = (r.TYPEQU || r.typequ || r.typequ || "").toString().trim();
    const typeCode = rawCode.toUpperCase();
    const typeInfo = BPE_TYPES[rawCode] ?? BPE_TYPES[typeCode];

    // Coordonnées
    const eqLat = parseFloat(r.LATITUDE || r.latitude || "");
    const eqLon = parseFloat(r.LONGITUDE || r.longitude || "");

    // Distance : réelle si dispo, sinon 500m (équipement communal sans coords)
    const distance_m = (!isNaN(eqLat) && !isNaN(eqLon))
      ? Math.round(Math.sqrt(
          Math.pow((eqLat - lat) * 111000, 2) +
          Math.pow((eqLon - lon) * 111000 * Math.cos(lat * Math.PI / 180), 2)
        ))
      : 500;

    const label = r.NOM || r.nomrs || typeInfo?.label || typeCode;
    const item = { label, distance_m };

    if (typeCode === "D301") nbPharmacies++;
    if (typeCode.startsWith("C1") || typeCode.startsWith("C2")) nbEcoles++;
    if (typeCode === "B101" || typeCode === "B102") nbSupermarches++;
    if (typeCode.startsWith("C4") || typeCode.startsWith("C5")) nbUniversites++;

    if (typeInfo) {
      switch (typeInfo.category) {
        case "commerces": commerces.push(item); break;
        case "sante":     sante.push(item);     break;
        case "services":  services.push(item);  break;
        case "education": education.push(item); break;
        case "loisirs":   loisirs.push(item);   break;
      }
    } else {
      if (typeCode.startsWith("B"))      commerces.push(item);
      else if (typeCode.startsWith("D")) sante.push(item);
      else if (typeCode.startsWith("A")) services.push(item);
      else if (typeCode.startsWith("C")) education.push(item);
      else if (typeCode.startsWith("F")) loisirs.push(item);
    }
  }

  [commerces, sante, services, education, loisirs].forEach(arr =>
    arr.sort((a, b) => a.distance_m - b.distance_m)
  );

  const total = commerces.length + sante.length + services.length + education.length + loisirs.length;

  let score = 30;
  if (total >= 30)      score = 90;
  else if (total >= 20) score = 80;
  else if (total >= 10) score = 65;
  else if (total >= 5)  score = 50;
  else if (total >= 2)  score = 40;
  if (sante.length >= 3) score = Math.min(100, score + 5);

  console.log(`[BPE] v1.2.9 (${source}) — commerces=${commerces.length} sante=${sante.length} education=${education.length} loisirs=${loisirs.length} services=${services.length}`);

  // v1.3.2 — qualité BPE enrichie
  // full_coverage : on a reçu assez de lignes pour que les zéros soient fiables.
  // On considère full_coverage si :
  //   - source API datagouv avec >20 lignes (couvre tous les domaines BPE)
  //   - ou total équipements > 30 (preuve que la source est dense)
  const isApiSource = source === "api_datagouv";
  const fullCoverage = (isApiSource && records.length > 20) || total > 30;

  // Catégories à 0
  const zeroCats: string[] = [];
  if (commerces.length === 0)  zeroCats.push("commerces");
  if (sante.length === 0)      zeroCats.push("sante");
  if (services.length === 0)   zeroCats.push("services");
  if (education.length === 0)  zeroCats.push("education");
  if (loisirs.length === 0)    zeroCats.push("loisirs");

  // suspected_partial : catégories à 0 qu'on suspecte être dues à une source
  // partielle plutôt qu'à un vrai zéro.
  // Heuristique : si la source Supabase (partielle par construction) retourne 0
  // sur une catégorie, on la marque suspecte.
  // Si la source est l'API datagouv et que raw_count > 100, les 0 sont réels.
  const suspectedPartial: string[] = [];
  if (!fullCoverage) {
    // Source partielle : tous les 0 sont suspects
    suspectedPartial.push(...zeroCats);
  } else if (!isApiSource) {
    // Source Supabase mais coverage semblable : loisirs/education souvent absents
    if (loisirs.length === 0)   suspectedPartial.push("loisirs");
    if (education.length === 0) suspectedPartial.push("education");
    if (sante.length === 0)     suspectedPartial.push("sante");
  }
  // API datagouv + full_coverage : les 0 sont réels, rien à suspecter

  // Niveau de confiance global
  const confidence: "forte" | "moyenne" | "faible" =
    fullCoverage && isApiSource ? "forte"
    : fullCoverage              ? "moyenne"
    : "faible";

  // Si couverture faible, signaler dans coverage
  const coverageValue: Coverage = fullCoverage ? "ok" : (total > 0 ? "ok" : "no_data");

  return {
    total_equipements: total,
    score,
    commerces: { count: commerces.length, details: commerces.slice(0, 10) },
    sante:     { count: sante.length,     details: sante.slice(0, 10) },
    services:  { count: services.length,  details: services.slice(0, 10) },
    education: { count: education.length, details: education.slice(0, 10) },
    loisirs:   { count: loisirs.length,   details: loisirs.slice(0, 10) },
    nb_ecoles: nbEcoles,
    nb_pharmacies: nbPharmacies,
    nb_supermarches: nbSupermarches,
    nb_universites: nbUniversites,
    coverage: coverageValue,
    bpe_quality: {
      source: source === "api_datagouv" ? "api_datagouv"
             : source === "supabase"    ? "supabase"
             : "none",
      raw_count: records.length,
      full_coverage: fullCoverage,
      zero_categories: zeroCats,
      suspected_partial_categories: suspectedPartial,
      confidence,
    },
  };
}

// ============================================================================
// EHPAD CONCURRENCE
// ============================================================================

interface EhpadEtablissement {
  nom: string;
  distance_m: number;
  capacite: number;
  capacite_estimee?: boolean;
  finess?: string;
}

async function fetchOverpassEhpad(lat: number, lon: number, radiusKm: number): Promise<EhpadEtablissement[]> {
  try {
    const radiusM = Math.min(radiusKm * 1000, 15000);
    const query = `[out:json][timeout:12];(node["healthcare"="nursing_home"](around:${radiusM},${lat},${lon});way["healthcare"="nursing_home"](around:${radiusM},${lat},${lon});node["amenity"="nursing_home"](around:${radiusM},${lat},${lon});way["amenity"="nursing_home"](around:${radiusM},${lat},${lon});node["social_facility"~"nursing_home|assisted_living"](around:${radiusM},${lat},${lon}););out center tags 40;`;

    const res = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const etablissements: EhpadEtablissement[] = [];

    for (const el of data.elements || []) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;
      const dist = haversine(lat, lon, elLat, elLon);
      if (dist > radiusM) continue;
      const tags = el.tags || {};
      etablissements.push({
        nom: tags.name || "Établissement",
        distance_m: Math.round(dist),
        capacite: safeNum(tags.capacity || tags.beds) || 0,
      });
    }

    etablissements.sort((a, b) => a.distance_m - b.distance_m);
    return etablissements;
  } catch {
    return [];
  }
}

async function fetchEhpadConcurrence(lat: number, lon: number, radiusKm: number, dept: string | null) {
  const [overpassResults, tarifs] = await Promise.all([
    fetchOverpassEhpad(lat, lon, radiusKm),
    fetchEhpadTarifsFromSupabase(dept),
  ]);

  const etablissements: EhpadEtablissement[] = overpassResults.map(e => ({
    ...e,
    capacite: e.capacite || 60,
    capacite_estimee: !e.capacite || e.capacite === 0,
  }));

  const prices = tarifs.map(t => t.prix_hebergement_simple).filter((p): p is number => p != null && p > 0);

  const prixStats = prices.length > 0 ? {
    prix_hebergement_min: Math.round(Math.min(...prices) * 100) / 100,
    prix_hebergement_max: Math.round(Math.max(...prices) * 100) / 100,
    prix_hebergement_median: median(prices) ? Math.round(median(prices)! * 100) / 100 : null,
    prix_hebergement_moyen: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
    nb_etablissements_avec_prix: prices.length,
  } : null;

  const girsStats = tarifs.length > 0 ? {
    tarif_gir_1_2_moyen: (() => { const v = tarifs.map(t => t.tarif_gir_1_2).filter((v): v is number => v != null && v > 0); return v.length > 0 ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; })(),
    tarif_gir_3_4_moyen: (() => { const v = tarifs.map(t => t.tarif_gir_3_4).filter((v): v is number => v != null && v > 0); return v.length > 0 ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; })(),
    tarif_gir_5_6_moyen: (() => { const v = tarifs.map(t => t.tarif_gir_5_6).filter((v): v is number => v != null && v > 0); return v.length > 0 ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; })(),
  } : null;

  const withCapacity = etablissements.filter(e => !e.capacite_estimee && e.capacite > 0);
  const avgCapacity = withCapacity.length > 0 ? Math.round(withCapacity.reduce((s, e) => s + e.capacite, 0) / withCapacity.length) : 60;
  for (const e of etablissements) { if (e.capacite_estimee) e.capacite = avgCapacity; }
  const totalLits = etablissements.reduce((s, e) => s + e.capacite, 0);

  return {
    etablissements: etablissements.slice(0, 25),
    count: etablissements.length,
    total_lits: totalLits,
    prix_stats: prixStats,
    tarifs_gir: girsStats,
    nb_ehpad_departement: tarifs.length,
    sources: { cnsa_tarifs: tarifs.length, overpass: overpassResults.length },
    coverage: (tarifs.length > 0 || overpassResults.length > 0) ? "ok" as Coverage : "no_data" as Coverage,
  };
}

// ============================================================================
// SPECIFIC DATA COMPUTATION
// ============================================================================

function computeEhpadSpecific(insee: InseeData | null, bpe: BpeData | null, concurrence: Awaited<ReturnType<typeof fetchEhpadConcurrence>>) {
  const population = insee?.population ?? 50000;
  const pct75 = insee?.pct_75_plus ?? 10;
  const pop75 = Math.round(population * (pct75 / 100));
  const densiteLits = pop75 > 0 ? Math.round((concurrence.total_lits / pop75) * 1000 * 10) / 10 : null;

  let tauxEquipement: "sous_equipe" | "equilibre" | "sur_equipe" = "equilibre";
  let potentiel: "fort" | "moyen" | "faible" = "moyen";
  if (densiteLits !== null) {
    if (densiteLits < 80) { tauxEquipement = "sous_equipe"; potentiel = "fort"; }
    else if (densiteLits > 150) { tauxEquipement = "sur_equipe"; potentiel = "faible"; }
  }

  const coutMensuelEstime = concurrence.prix_stats?.prix_hebergement_moyen && concurrence.tarifs_gir?.tarif_gir_1_2_moyen
    ? Math.round((concurrence.prix_stats.prix_hebergement_moyen + concurrence.tarifs_gir.tarif_gir_1_2_moyen) * 30.5)
    : null;

  return {
    concurrence,
    demographie_senior: { population_75_plus: pop75, pct_75_plus: pct75 },
    offre_sante: { pharmacies: bpe?.nb_pharmacies ?? 0 },
    indicateurs_marche: { densite_lits_1000_seniors: densiteLits, taux_equipement_zone: tauxEquipement, potentiel_marche: potentiel },
    analyse_prix: concurrence.prix_stats ? {
      ...concurrence.prix_stats, ...concurrence.tarifs_gir,
      cout_mensuel_moyen_gir_1_2: coutMensuelEstime,
      interpretation: concurrence.prix_stats.prix_hebergement_median
        ? (concurrence.prix_stats.prix_hebergement_median < 70 ? "Prix compétitifs" : concurrence.prix_stats.prix_hebergement_median < 90 ? "Prix dans la moyenne" : "Prix élevés")
        : null,
    } : null,
  };
}

function computeLogementSpecific(insee: InseeData | null, dvf: DvfData | null, bpe: BpeData | null) {
  const population = insee?.population ?? 50000;
  const prixNeuf = dvf?.prix_m2_median ? Math.round(dvf.prix_m2_median * 1.2) : null;
  return {
    demographie: {
      menages_total: Math.round(population / 2.2),
      pct_logements_vacants: insee?.pct_logements_vacants ?? 5,
      pct_moins_15: insee?.pct_moins_15 ?? 18,
      pct_familles: (insee?.pct_30_44 ?? 19) + (insee?.pct_moins_15 ?? 18),
    },
    marche_immobilier: { prix_m2_ancien: dvf?.prix_m2_median ?? null, prix_m2_neuf: prixNeuf, evolution_prix_pct: dvf?.evolution_prix_pct ?? null },
    cadre_vie: { nb_ecoles: bpe?.nb_ecoles ?? 0, nb_commerces: bpe?.commerces?.count ?? 0, nb_sante: bpe?.sante?.count ?? 0 },
    indicateurs_marche: {
      tension_locative: (insee?.densite ?? 0) > 3000 ? "forte" : (insee?.densite ?? 0) > 1000 ? "moyenne" : "faible",
      attractivite_familiale: (bpe?.nb_ecoles ?? 0) >= 3 ? "forte" : "moyenne",
    },
  };
}

function computeCommerceSpecific(insee: InseeData | null, bpe: BpeData | null, transport: TransportData | null) {
  const revenuMedian = insee?.revenu_median ?? null;
  const revenuForCalc = revenuMedian ?? 21500;
  const pouvoirAchat = revenuForCalc > 25000 ? "élevé" : revenuForCalc > 20000 ? "moyen" : "faible";
  return {
    zone_chalandise: { population: insee?.population ?? 0, revenu_median: revenuMedian, pouvoir_achat: pouvoirAchat, pouvoir_achat_indice: Math.round((revenuForCalc / 21500) * 100) },
    concurrence: { commerces_total: bpe?.commerces?.count ?? 0, supermarches: bpe?.nb_supermarches ?? 0 },
    flux_pietons: { score_flux: transport?.score ?? 50, proximite_metro: transport?.has_metro_train ?? false, proximite_tram: transport?.has_tram ?? false },
    indicateurs_marche: { dynamisme_zone: (transport?.score ?? 0) > 70 ? "fort" : "moyen", saturation_commerciale: (bpe?.commerces?.count ?? 0) > 30 ? "élevée" : "normale" },
  };
}

function computeBureauxSpecific(insee: InseeData | null, transport: TransportData | null) {
  const population = insee?.population ?? 50000;
  const pctActifs = insee?.pct_actifs ?? 45;
  return {
    accessibilite: { score_transport: transport?.score ?? 50, metro_train: transport?.has_metro_train ?? false, tram: transport?.has_tram ?? false },
    bassin_emploi: { population_active_estimee: Math.round(population * (pctActifs / 100)), pct_actifs: pctActifs, taux_chomage: insee?.taux_chomage ?? 7.5 },
    indicateurs_marche: { attractivite_entreprises: (transport?.score ?? 0) > 75 ? "forte" : "moyenne", accessibilite_critique: transport?.has_metro_train ?? false },
  };
}

function computeEtudiantSpecific(insee: InseeData | null, bpe: BpeData | null, transport: TransportData | null) {
  const population = insee?.population ?? 50000;
  const pctEtudiants = insee?.pct_etudiants ?? 6;
  const pct15_29 = insee?.pct_15_29 ?? 16;
  const hasUniv = (bpe?.nb_universites ?? 0) >= 1;
  return {
    population_etudiante: { estimee: Math.round(population * (pctEtudiants / 100)), pct_etudiants: pctEtudiants, pct_15_29: pct15_29, presence_universitaire: hasUniv, nb_etablissements_superieurs: bpe?.nb_universites ?? 0 },
    accessibilite: { score_transport: transport?.score ?? 50, metro_train: transport?.has_metro_train ?? false },
    cadre_vie: { nb_bibliotheques: bpe?.loisirs?.count ?? 0, nb_loisirs: bpe?.loisirs?.count ?? 0 },
    indicateurs_marche: { potentiel_marche: hasUniv || pctEtudiants > 8 ? "fort" : pctEtudiants > 5 ? "moyen" : "faible", marche_locatif: insee?.pct_locataires && insee.pct_locataires > 50 ? "actif" : "modéré" },
  };
}

function computeHotelSpecific(insee: InseeData | null, bpe: BpeData | null, transport: TransportData | null) {
  return {
    accessibilite: { score_transport: transport?.score ?? 50, metro_train: transport?.has_metro_train ?? false, tram: transport?.has_tram ?? false },
    attractivite: { population: insee?.population ?? 0, densite: insee?.densite ?? 0, nb_loisirs: bpe?.loisirs?.count ?? 0, zone_touristique: (bpe?.loisirs?.count ?? 0) >= 5 },
    indicateurs_marche: { potentiel: (transport?.score ?? 0) > 60 && (bpe?.loisirs?.count ?? 0) >= 3 ? "fort" : "moyen" },
  };
}

// ============================================================================
// SCORING DIFFÉRENCIÉ
// ============================================================================

interface ScoreAdjustment {
  label: string;
  value: number;
  type: 'bonus' | 'malus';
}

interface ScoringResult {
  demande: number;
  offre: number;
  accessibilite: number;
  environnement: number;
  global: number;
  adjustments: ScoreAdjustment[];
  explanation: string;
}

function computeDifferentiatedScores(
  dvf: DvfData | null, insee: InseeData | null, transport: TransportData | null,
  bpe: BpeData | null, specific: Record<string, unknown> | null, projectType: ProjectType
): ScoringResult {
  const config = PROJECT_CONFIG[projectType];
  const weights = config.weights;
  const adjustments: ScoreAdjustment[] = [];

  let demande = 50, offre = 50, accessibilite = 50, environnement = 50;

  // ── DEMANDE ───────────────────────────────────────────────────────────────
  if (projectType === "ehpad") {
    const pct75 = insee?.pct_75_plus ?? 10;
    if (pct75 > 14) { demande += 25; adjustments.push({ label: "Pop. 75+ élevée", value: 25, type: 'bonus' }); }
    else if (pct75 > 11) { demande += 15; adjustments.push({ label: "Pop. 75+ correcte", value: 15, type: 'bonus' }); }
    else if (pct75 < 8) { demande -= 15; adjustments.push({ label: "Pop. 75+ faible", value: -15, type: 'malus' }); }
    const indicateurs = specific?.indicateurs_marche as { potentiel_marche?: string } | undefined;
    if (indicateurs?.potentiel_marche === "fort") { demande += 15; adjustments.push({ label: "Fort potentiel marché", value: 15, type: 'bonus' }); }
    else if (indicateurs?.potentiel_marche === "faible") { demande -= 20; adjustments.push({ label: "Faible potentiel", value: -20, type: 'malus' }); }

  } else if (projectType === "residence_etudiante") {
    const pctEtudiants = insee?.pct_etudiants ?? 6;
    const pct1529 = insee?.pct_15_29 ?? 16;
    if (pctEtudiants > 10) { demande += 30; adjustments.push({ label: "Zone très étudiante", value: 30, type: 'bonus' }); }
    else if (pctEtudiants > 7) { demande += 20; adjustments.push({ label: "Zone étudiante", value: 20, type: 'bonus' }); }
    else if (pctEtudiants < 4) { demande -= 15; adjustments.push({ label: "Peu d'étudiants", value: -15, type: 'malus' }); }
    if (pct1529 > 22) { demande += 10; adjustments.push({ label: "Pop. jeune élevée", value: 10, type: 'bonus' }); }
    const hasUniv = (specific?.population_etudiante as { presence_universitaire?: boolean })?.presence_universitaire;
    if (hasUniv) { demande += 15; adjustments.push({ label: "Présence universitaire", value: 15, type: 'bonus' }); }

  } else if (projectType === "commerce") {
    const revenu = insee?.revenu_median ?? 21500;
    const densite = insee?.densite ?? 0;
    if (revenu > 26000) { demande += 20; adjustments.push({ label: "Haut pouvoir d'achat", value: 20, type: 'bonus' }); }
    else if (revenu > 23000) { demande += 10; adjustments.push({ label: "Bon pouvoir d'achat", value: 10, type: 'bonus' }); }
    else if (revenu < 19000) { demande -= 15; adjustments.push({ label: "Pouvoir d'achat faible", value: -15, type: 'malus' }); }
    if (densite > 3000) { demande += 15; adjustments.push({ label: "Zone très dense", value: 15, type: 'bonus' }); }
    else if (densite > 1000) { demande += 8; }
    else if (densite < 300) { demande -= 10; adjustments.push({ label: "Zone peu dense", value: -10, type: 'malus' }); }

  } else if (projectType === "bureaux") {
    const pctActifs = insee?.pct_actifs ?? 45;
    const tauxChomage = insee?.taux_chomage ?? 7.5;
    if (pctActifs > 50) { demande += 15; adjustments.push({ label: "Fort bassin d'actifs", value: 15, type: 'bonus' }); }
    else if (pctActifs < 40) { demande -= 10; adjustments.push({ label: "Bassin d'actifs limité", value: -10, type: 'malus' }); }
    if (tauxChomage > 10) { demande -= 10; adjustments.push({ label: "Chômage élevé", value: -10, type: 'malus' }); }

  } else if (projectType === "logement") {
    const population = insee?.population ?? 0;
    const pctMoins15 = insee?.pct_moins_15 ?? 18;
    const tauxVacance = insee?.pct_logements_vacants ?? 8;
    if (population > 100000) { demande += 15; adjustments.push({ label: "Grande agglomération", value: 15, type: 'bonus' }); }
    else if (population > 30000) { demande += 8; }
    if (pctMoins15 > 20) { demande += 10; adjustments.push({ label: "Zone familiale", value: 10, type: 'bonus' }); }
    if (tauxVacance > 12) { demande -= 15; adjustments.push({ label: "Vacance élevée", value: -15, type: 'malus' }); }
    else if (tauxVacance < 5) { demande += 10; adjustments.push({ label: "Tension locative", value: 10, type: 'bonus' }); }

  } else if (projectType === "hotel") {
    const nbLoisirs = bpe?.loisirs?.count ?? 0;
    const densite = insee?.densite ?? 0;
    if (nbLoisirs >= 5) { demande += 15; adjustments.push({ label: "Zone touristique", value: 15, type: 'bonus' }); }
    if (densite > 2000) { demande += 10; }
  }

  // ── OFFRE ─────────────────────────────────────────────────────────────────
  if (projectType === "ehpad") {
    const indicateurs = specific?.indicateurs_marche as { taux_equipement_zone?: string } | undefined;
    if (indicateurs?.taux_equipement_zone === "sous_equipe") { offre += 25; adjustments.push({ label: "Zone sous-équipée", value: 25, type: 'bonus' }); }
    else if (indicateurs?.taux_equipement_zone === "sur_equipe") { offre -= 25; adjustments.push({ label: "Zone sur-équipée", value: -25, type: 'malus' }); }
    const concurrence = specific?.concurrence as { count?: number } | undefined;
    if ((concurrence?.count ?? 0) > 10) { offre -= 10; adjustments.push({ label: "Forte concurrence", value: -10, type: 'malus' }); }

  } else if (projectType === "commerce") {
    const nbCommerces = bpe?.commerces?.count ?? 0;
    if (nbCommerces > 30) { offre -= 15; adjustments.push({ label: "Forte concurrence commerciale", value: -15, type: 'malus' }); }
    else if (nbCommerces > 5 && nbCommerces < 20) { offre += 10; adjustments.push({ label: "Zone commerciale équilibrée", value: 10, type: 'bonus' }); }

  } else {
    if (dvf && dvf.nb_transactions > 50) { offre += 15; }
    else if (dvf && dvf.nb_transactions < 10) { offre -= 10; }
    if (dvf?.prix_m2_median) {
      if (dvf.prix_m2_median > 5000) { offre += 10; }
      else if (dvf.prix_m2_median < 2000) { offre -= 10; }
    }
  }

  // ── ACCESSIBILITÉ ─────────────────────────────────────────────────────────
  accessibilite = transport?.score ?? 50;
  if (projectType === "bureaux") {
    if (transport?.has_metro_train) { accessibilite += 15; adjustments.push({ label: "Métro/train à proximité", value: 15, type: 'bonus' }); }
    else if (!transport?.has_metro_train && !transport?.has_tram) { accessibilite -= 20; adjustments.push({ label: "Pas de transport lourd", value: -20, type: 'malus' }); }
  } else if (projectType === "residence_etudiante") {
    if (transport?.has_metro_train) { accessibilite += 10; adjustments.push({ label: "Transports en commun", value: 10, type: 'bonus' }); }
    if ((transport?.score ?? 0) < 40) { accessibilite -= 15; adjustments.push({ label: "Accessibilité insuffisante", value: -15, type: 'malus' }); }
  } else if (projectType === "logement" || projectType === "commerce") {
    if (transport?.has_metro_train) { accessibilite += 10; }
    if (transport?.has_tram) { accessibilite += 5; }
  }

  // ── ENVIRONNEMENT ─────────────────────────────────────────────────────────
  environnement = bpe?.score ?? 50;
  if (projectType === "logement") {
    if ((bpe?.nb_ecoles ?? 0) >= 3) { environnement += 10; adjustments.push({ label: "Écoles à proximité", value: 10, type: 'bonus' }); }
    if ((bpe?.commerces?.count ?? 0) >= 5) { environnement += 5; }
  } else if (projectType === "ehpad") {
    if ((bpe?.sante?.count ?? 0) >= 3) { environnement += 15; adjustments.push({ label: "Services de santé", value: 15, type: 'bonus' }); }
    if ((bpe?.nb_pharmacies ?? 0) >= 2) { environnement += 5; }
  } else if (projectType === "residence_etudiante") {
    if ((bpe?.loisirs?.count ?? 0) >= 3) { environnement += 10; adjustments.push({ label: "Loisirs à proximité", value: 10, type: 'bonus' }); }
  }

  // ── CLAMP & GLOBAL ────────────────────────────────────────────────────────
  demande = Math.max(0, Math.min(100, demande));
  offre = Math.max(0, Math.min(100, offre));
  accessibilite = Math.max(0, Math.min(100, accessibilite));
  environnement = Math.max(0, Math.min(100, environnement));

  const global = Math.round(
    demande * weights.demande + offre * weights.offre +
    accessibilite * weights.accessibilite + environnement * weights.environnement
  );

  const weightsStr = Object.entries(weights).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${Math.round(v * 100)}%`).join(', ');

  return {
    demande, offre, accessibilite, environnement,
    global: Math.max(0, Math.min(100, global)),
    adjustments,
    explanation: `Pondération ${projectType}: ${weightsStr}`,
  };
}

// ============================================================================
// INSIGHTS
// ============================================================================

function generateInsights(
  dvf: DvfData | null, transport: TransportData | null, bpe: BpeData | null,
  specific: Record<string, unknown> | null, scores: ScoringResult,
  projectType: ProjectType, insee: InseeData | null,
) {
  const insights: Array<{ type: "positive" | "warning" | "negative" | "neutral"; category: string; message: string }> = [];

  // Revenu médian : warning seulement si fallback département (estimation grossière)
  if (insee?.revenu_median_source === 'dept_fallback') {
    insights.push({ type: "warning", category: "insee", message: `Revenu médian estimé au niveau du département (source : référentiel Filosofi ${insee.departement})` });
  }

  if (scores.global >= 70) {
    insights.push({ type: "positive", category: "global", message: "Contexte de marché très favorable" });
  } else if (scores.global >= 55) {
    insights.push({ type: "positive", category: "global", message: "Contexte de marché favorable" });
  } else if (scores.global < 40) {
    insights.push({ type: "warning", category: "global", message: "Contexte de marché défavorable - Analyse approfondie recommandée" });
  }

  if (dvf && dvf.nb_transactions > 0) {
    const prixFormatted = dvf.prix_m2_median?.toLocaleString("fr-FR") ?? "N/A";
    insights.push({ type: "neutral", category: "dvf", message: `${dvf.nb_transactions} transactions DVF - Prix médian : ${prixFormatted} €/m²` });
  }

  if (transport?.has_metro_train) {
    insights.push({ type: "positive", category: "transport", message: "Excellente desserte transport (métro/train)" });
  } else if (transport?.has_tram) {
    insights.push({ type: "positive", category: "transport", message: "Bonne desserte transport (tramway)" });
  } else if ((transport?.score ?? 0) < 40) {
    insights.push({ type: "warning", category: "transport", message: "Accessibilité transport limitée" });
  }

  if (bpe && bpe.total_equipements > 0) {
    if (bpe.sante.count >= 3) insights.push({ type: "positive", category: "services", message: `${bpe.sante.count} établissements de santé à proximité` });
    if (bpe.commerces.count >= 5) insights.push({ type: "positive", category: "services", message: `${bpe.commerces.count} commerces de proximité` });
    if (bpe.education.count >= 2) insights.push({ type: "positive", category: "services", message: `${bpe.education.count} établissements d'enseignement à proximité` });
    if (bpe.loisirs.count >= 3) insights.push({ type: "positive", category: "services", message: `${bpe.loisirs.count} équipements de loisirs à proximité` });
  }

  const indicateurs = specific?.indicateurs_marche as { taux_equipement_zone?: string; tension_locative?: string } | undefined;
  if (indicateurs?.taux_equipement_zone === "sous_equipe") insights.push({ type: "positive", category: "concurrence", message: "Zone sous-équipée - Fort potentiel de développement" });
  else if (indicateurs?.taux_equipement_zone === "sur_equipe") insights.push({ type: "warning", category: "concurrence", message: "Zone sur-équipée - Concurrence élevée" });
  if (indicateurs?.tension_locative === "forte") insights.push({ type: "positive", category: "marche", message: "Marché locatif tendu - Forte demande" });

  const analysePrix = specific?.analyse_prix as { prix_hebergement_median?: number; interpretation?: string } | undefined;
  if (analysePrix?.prix_hebergement_median) {
    insights.push({ type: "neutral", category: "prix", message: `Prix hébergement médian : ${analysePrix.prix_hebergement_median.toFixed(0)} €/jour (${analysePrix.interpretation})` });
  }

  for (const adj of scores.adjustments.slice(0, 3)) {
    if (adj.type === 'bonus' && adj.value >= 15) insights.push({ type: "positive", category: "scoring", message: adj.label });
    else if (adj.type === 'malus' && adj.value <= -15) insights.push({ type: "warning", category: "scoring", message: adj.label });
  }

  return insights.slice(0, 10);
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const startTime = Date.now();

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ success: false, version: VERSION, error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const payload = await req.json();
    const isDebug = !!payload.debug;
    const timings: Record<string, number> = {};

    const t0 = Date.now();
    const location = await resolveCoordinates(payload);
    timings.geocoding = Date.now() - t0;

    if (!location) {
      return new Response(JSON.stringify({
        success: false, version: VERSION,
        error: "Impossible de géolocaliser. Fournir: address, commune_insee, parcel_id, ou lat/lon.",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { lat, lon } = location;
    const projectType = normalizeProjectType(payload.project_type);
    const config = PROJECT_CONFIG[projectType];
    const radiusKm = Math.min(Math.max(payload.radius_km ?? config.defaultRadiusKm, 1), config.maxRadiusKm);

    const t1 = Date.now();
    const commune = await resolveCommune(lat, lon);
    timings.commune = Date.now() - t1;

    const codeInsee = commune?.code_insee ?? null;
    const dept = commune?.departement ?? null;
    const communeNom = commune?.nom ?? null;

    const [dvf, insee, transport, bpe] = await Promise.all([
      (async () => { const t = Date.now(); const r = await fetchDvfFromSupabase(dept, communeNom); timings.dvf = Date.now() - t; return r; })(),
      (async () => { const t = Date.now(); const r = codeInsee ? await fetchInseeData(codeInsee, communeNom, dept) : null; timings.insee = Date.now() - t; return r; })(),
      (async () => { const t = Date.now(); const r = await fetchTransport(lat, lon, dept); timings.transport = Date.now() - t; return r; })(),
      (async () => { const t = Date.now(); const r = await fetchBpeFromSupabase(lat, lon, codeInsee, dept); timings.bpe = Date.now() - t; return r; })(),
    ]);

    let specific: Record<string, unknown> | null = null;
    const t2 = Date.now();
    if (projectType === "ehpad") {
      const concurrence = await fetchEhpadConcurrence(lat, lon, radiusKm, dept);
      specific = computeEhpadSpecific(insee, bpe, concurrence);
    } else if (projectType === "logement") specific = computeLogementSpecific(insee, dvf, bpe);
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
      bpe_domain_counts: bpe ? {
        commerces: bpe.commerces.count, sante: bpe.sante.count,
        education: bpe.education.count, loisirs: bpe.loisirs.count, services: bpe.services.count,
      } : null,
      revenu_median_source: insee?.revenu_median_source ?? null,
      // v1.3.1 — bloc debug enrichissement économique
      // v1.3.2 — debug enrichissement économique complet
      economic_fields: insee ? {
        revenu_median_source: insee.revenu_median_source ?? null,
        revenu_moyen_found: insee.revenu_moyen != null,
        niveau_vie_median_found: insee.niveau_vie_median != null,
        pcs_found: (
          insee.part_cadres != null ||
          insee.part_professions_intermediaires != null ||
          insee.part_employes != null ||
          insee.part_ouvriers != null
        ),
        actifs_occupes_found: insee.part_actifs_occupes != null,
        population_evolution_found: insee.evolution_population_5y != null,
        revenu_evolution_found: insee.evolution_revenu_5y != null,
        chomage_evolution_found: insee.evolution_chomage_5y != null,
        tax_fields_found: insee.taxe_fonciere_moyenne != null,
        economic_data_quality: insee.economic_data_quality ?? null,
      } : null,
      // v1.3.1 — qualité BPE
      bpe_quality: bpe?.bpe_quality ?? null,
    } : undefined;

    return new Response(JSON.stringify({
      success: true,
      version: VERSION,
      meta: {
        lat, lon,
        location_source: location.source,
        location_label: location.label,
        commune_insee: codeInsee,
        commune_nom: communeNom,
        departement: dept,
        project_type: projectType,
        project_type_label: config.label,
        radius_km: radiusKm,
        generated_at: new Date().toISOString(),
      },
      core: { dvf, insee, transport, bpe },
      specific,
      scores: {
        demande: scores.demande,
        offre: scores.offre,
        accessibilite: scores.accessibilite,
        environnement: scores.environnement,
        global: scores.global,
      },
      scoring_details: {
        weights: config.weights,
        adjustments: scores.adjustments,
        explanation: scores.explanation,
      },
      insights,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
      debug: debugPayload,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[market-study] Error:", err);
    return new Response(JSON.stringify({ success: false, version: VERSION, error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});