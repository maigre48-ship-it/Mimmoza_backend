/**
 * Sourcing Module - Shared Types
 * Types partagés pour le système de scoring Mimmoza
 */

// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

export type ProfileTarget = 'mdb' | 'promoteur' | 'particulier';

export type PropertyType = 
  | 'appartement'
  | 'maison'
  | 'terrain'
  | 'immeuble'
  | 'local_commercial'
  | 'bureau';

export type FloorType = 
  | 'rdc'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10+'
  | 'dernier'
  | 'n/a';

export type ProximityTransport = 
  | 'metro'
  | 'rer'
  | 'tramway'
  | 'bus'
  | 'gare'
  | 'aucun'
  | 'unknown';

export type NuisanceLevel = 'aucune' | 'faible' | 'moyenne' | 'forte' | 'unknown';

export type StandingLevel = 'basique' | 'standard' | 'premium' | 'luxe' | 'unknown';

export type SourcingItemStatus = 
  | 'draft'
  | 'analyzed'
  | 'scored'
  | 'archived'
  | 'error';

// ============================================================================
// INPUT TYPES (from frontend)
// ============================================================================

export interface SourcingLocation {
  codePostal: string; // obligatoire
  rueProche: string;  // obligatoire
  ville?: string;
  adresseExacte?: string;
  commune?: string;
  departement?: string;
}

export interface SourcingInputBase {
  price: number;      // obligatoire
  surface: number;    // obligatoire
  propertyType: PropertyType; // obligatoire
  floor: FloorType;   // obligatoire
  
  // Options communes
  nbPieces?: number;
  nbChambres?: number;
  anneeConstruction?: number;
  etatGeneral?: 'neuf' | 'tres_bon' | 'bon' | 'moyen' | 'a_renover' | 'ruine';
  dpe?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'unknown';
  
  // Options appartement
  ascenseur?: boolean;
  balcon?: boolean;
  terrasse?: boolean;
  cave?: boolean;
  parking?: boolean;
  gardien?: boolean;
  digicode?: boolean;
  
  // Options maison
  jardin?: boolean;
  jardinSurface?: number;
  piscine?: boolean;
  garage?: boolean;
  dependances?: boolean;
  
  // Options terrain
  viabilise?: boolean;
  constructible?: boolean;
  pluZone?: string;
  
  // Options immeuble
  nbLots?: number;
  nbEtages?: number;
  copropriete?: boolean;
}

export interface SourcingQuartier {
  proximiteTransport?: ProximityTransport;
  distanceTransport?: number; // en mètres
  nuisances?: NuisanceLevel;
  standing?: StandingLevel;
  commercesProximite?: boolean;
  ecolesProximite?: boolean;
  espacesVerts?: boolean;
  securite?: 'bonne' | 'moyenne' | 'faible' | 'unknown';
}

export interface SourcingItemDraft {
  profileTarget: ProfileTarget;
  location: SourcingLocation;
  input: SourcingInputBase;
  quartier?: SourcingQuartier;
  notes?: string;
  sourceUrl?: string;
  sourceType?: 'seloger' | 'leboncoin' | 'pap' | 'notaire' | 'autre' | 'manual';
}

// ============================================================================
// NORMALIZED TYPES (after analysis)
// ============================================================================

export interface NormalizedLocation extends SourcingLocation {
  communeInsee?: string;
  departementCode?: string;
  regionCode?: string;
  latitude?: number;
  longitude?: number;
  geocodeConfidence?: number;
}

export interface NormalizedInput extends SourcingInputBase {
  pricePerSqm: number;
  surfaceCategory: 'studio' | 'small' | 'medium' | 'large' | 'very_large';
}

export interface SourcingItemNormalized {
  profileTarget: ProfileTarget;
  location: NormalizedLocation;
  input: NormalizedInput;
  quartier: SourcingQuartier; // toujours présent, avec defaults
  notes?: string;
  sourceUrl?: string;
  sourceType?: string;
  normalizedAt: string;
  version: string;
}

// ============================================================================
// GEOCODE TYPES
// ============================================================================

export interface GeocodeResult {
  found: boolean;
  confidence: number; // 0..1
  lat?: number;
  lon?: number;
  label?: string;
  communeInsee?: string;
  communeName?: string;
  departement?: string;
  region?: string;
  postcode?: string;
  citycode?: string;
  type?: string;
  score?: number;
}

export interface GeocodeResponse {
  bestMatch: GeocodeResult | null;
  alternatives: GeocodeResult[];
  query: string;
  source: 'geo.api.gouv.fr';
  fetchedAt: string;
}

// ============================================================================
// CONTEXT TYPES (optional enrichment)
// ============================================================================

export interface MarketContext {
  available: boolean;
  medianPricePerSqm?: number;
  minPricePerSqm?: number;
  maxPricePerSqm?: number;
  transactionsCount?: number;
  marketTension?: 'tres_tendu' | 'tendu' | 'equilibre' | 'detendu' | 'unknown';
  source?: string;
  fetchedAt?: string;
}

export interface RiskContext {
  available: boolean;
  inondation?: { level: number; label: string };
  seisme?: { level: number; label: string };
  radon?: { level: number; label: string };
  argiles?: { level: number; label: string };
  industriel?: { level: number; label: string };
  fetchedAt?: string;
}

export interface UrbanismContext {
  available: boolean;
  pluZone?: string;
  pluLabel?: string;
  constructible?: boolean;
  hauteurMax?: number;
  cosMax?: number;
  fetchedAt?: string;
}

export interface SourcingContext {
  market?: MarketContext;
  risks?: RiskContext;
  urbanism?: UrbanismContext;
}

// ============================================================================
// SCORING TYPES
// ============================================================================

export interface ScoreComponent {
  key: string;
  label: string;
  points: number;
  maxPoints: number;
  inputUsed: string;
  rationale?: string;
}

export interface ScoreBlocker {
  key: string;
  label: string;
  severity: 'warning' | 'critical';
  message: string;
}

export interface SubScore {
  value: number;       // 0..100
  weight: number;      // poids pour ce profil
  rationale: string;   // explication courte
  components: ScoreComponent[];
  blockers: ScoreBlocker[];
  confidence: number;  // 0..1
}

export interface SmartScoreResult {
  // Score global
  globalScore: number;           // 0..100
  globalConfidence: number;      // 0..1
  globalRationale: string;
  
  // Sous-scores détaillés
  subScores: {
    location: SubScore;
    liquidity: SubScore;
    value: SubScore;
    worksRisk: SubScore;
    legalUrbanism: SubScore;
    risk: SubScore;
    dealStructure: SubScore;
  };
  
  // Méta
  profileTarget: ProfileTarget;
  weightsUsed: Record<string, number>;
  penaltiesApplied: Array<{ reason: string; points: number }>;
  warnings: string[];
  
  // Traçabilité
  version: string;
  computedAt: string;
  inputHash: string;
}

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

export interface AnalyzeResponse {
  success: boolean;
  normalized: SourcingItemNormalized | null;
  geocode: GeocodeResponse | null;
  hints: string[];
  warnings: string[];
  errors: string[];
  processingTimeMs: number;
}

export interface ScoreResponse {
  success: boolean;
  score: SmartScoreResult | null;
  warnings: string[];
  errors: string[];
  processingTimeMs: number;
}

// ============================================================================
// DATABASE TYPES
// ============================================================================

export interface SourcingItemRow {
  id: string;
  created_at: string;
  updated_at: string;
  user_id: string | null;
  profile_target: ProfileTarget;
  status: SourcingItemStatus;
  input_json: SourcingItemDraft;
  normalized_json: SourcingItemNormalized | null;
  geocode_json: GeocodeResponse | null;
  context_json: SourcingContext | null;
  score_json: SmartScoreResult | null;
  code_postal: string;
  commune_insee: string | null;
}

// ============================================================================
// WEIGHT CONFIGURATIONS
// ============================================================================

export const PROFILE_WEIGHTS: Record<ProfileTarget, Record<string, number>> = {
  mdb: {
    location: 0.10,
    liquidity: 0.20,
    value: 0.30,
    worksRisk: 0.20,
    legalUrbanism: 0.05,
    risk: 0.05,
    dealStructure: 0.10,
  },
  promoteur: {
    location: 0.20,
    liquidity: 0.10,
    value: 0.20,
    worksRisk: 0.10,
    legalUrbanism: 0.25,
    risk: 0.10,
    dealStructure: 0.05,
  },
  particulier: {
    location: 0.25,
    liquidity: 0.15,
    value: 0.15,
    worksRisk: 0.10,
    legalUrbanism: 0.05,
    risk: 0.15,
    dealStructure: 0.15,
  },
};

// ============================================================================
// REFERENCE DATA (heuristiques prix/m² par département)
// ============================================================================

export const PRICE_REFERENCE_BY_DEPT: Record<string, { median: number; min: number; max: number }> = {
  '75': { median: 10500, min: 7000, max: 18000 },
  '92': { median: 6500, min: 4000, max: 12000 },
  '93': { median: 4200, min: 2500, max: 7000 },
  '94': { median: 5200, min: 3000, max: 9000 },
  '78': { median: 4000, min: 2500, max: 8000 },
  '91': { median: 3200, min: 2000, max: 6000 },
  '95': { median: 3500, min: 2200, max: 6500 },
  '77': { median: 2800, min: 1800, max: 5000 },
  '69': { median: 4500, min: 2800, max: 8000 },
  '13': { median: 3800, min: 2200, max: 7000 },
  '31': { median: 3500, min: 2000, max: 6000 },
  '33': { median: 4000, min: 2500, max: 7500 },
  '59': { median: 2800, min: 1500, max: 5000 },
  '44': { median: 3800, min: 2200, max: 6500 },
  '67': { median: 3200, min: 2000, max: 5500 },
  '06': { median: 5500, min: 3000, max: 12000 },
  '34': { median: 3500, min: 2000, max: 6000 },
  // Default pour départements non listés
  'default': { median: 2500, min: 1500, max: 4500 },
};

export const SCORING_VERSION = '1.0.0';