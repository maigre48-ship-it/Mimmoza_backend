/**
 * Sourcing Score V1 - Edge Function
 * Calcule le SmartScore complet avec tous les sous-scores
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

// ============================================================================
// TYPES (inline pour Edge Functions)
// ============================================================================

type ProfileTarget = 'mdb' | 'promoteur' | 'particulier';
type PropertyType = 'appartement' | 'maison' | 'terrain' | 'immeuble' | 'local_commercial' | 'bureau';
type FloorType = 'rdc' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10+' | 'dernier' | 'n/a';
type ProximityTransport = 'metro' | 'rer' | 'tramway' | 'bus' | 'gare' | 'aucun' | 'unknown';
type NuisanceLevel = 'aucune' | 'faible' | 'moyenne' | 'forte' | 'unknown';
type StandingLevel = 'basique' | 'standard' | 'premium' | 'luxe' | 'unknown';

interface NormalizedLocation {
  codePostal: string;
  rueProche: string;
  ville?: string;
  adresseExacte?: string;
  communeInsee?: string;
  departementCode?: string;
  regionCode?: string;
  latitude?: number;
  longitude?: number;
  geocodeConfidence?: number;
}

interface NormalizedInput {
  price: number;
  surface: number;
  propertyType: PropertyType;
  floor: FloorType;
  pricePerSqm: number;
  surfaceCategory: 'studio' | 'small' | 'medium' | 'large' | 'very_large';
  nbPieces?: number;
  nbChambres?: number;
  anneeConstruction?: number;
  etatGeneral?: 'neuf' | 'tres_bon' | 'bon' | 'moyen' | 'a_renover' | 'ruine';
  dpe?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'unknown';
  ascenseur?: boolean;
  balcon?: boolean;
  terrasse?: boolean;
  cave?: boolean;
  parking?: boolean;
  gardien?: boolean;
  digicode?: boolean;
  jardin?: boolean;
  jardinSurface?: number;
  piscine?: boolean;
  garage?: boolean;
  dependances?: boolean;
  viabilise?: boolean;
  constructible?: boolean;
  pluZone?: string;
  nbLots?: number;
  nbEtages?: number;
  copropriete?: boolean;
}

interface SourcingQuartier {
  proximiteTransport?: ProximityTransport;
  distanceTransport?: number;
  nuisances?: NuisanceLevel;
  standing?: StandingLevel;
  commercesProximite?: boolean;
  ecolesProximite?: boolean;
  espacesVerts?: boolean;
  securite?: 'bonne' | 'moyenne' | 'faible' | 'unknown';
}

interface SourcingItemNormalized {
  profileTarget: ProfileTarget;
  location: NormalizedLocation;
  input: NormalizedInput;
  quartier: SourcingQuartier;
  notes?: string;
  sourceUrl?: string;
  sourceType?: string;
  normalizedAt: string;
  version: string;
}

interface GeocodeResult {
  found: boolean;
  confidence: number;
  lat?: number;
  lon?: number;
  label?: string;
  communeInsee?: string;
  communeName?: string;
}

interface GeocodeResponse {
  bestMatch: GeocodeResult | null;
  alternatives: GeocodeResult[];
  query: string;
  source: string;
  fetchedAt: string;
}

interface MarketContext {
  available: boolean;
  medianPricePerSqm?: number;
  minPricePerSqm?: number;
  maxPricePerSqm?: number;
  transactionsCount?: number;
  marketTension?: 'tres_tendu' | 'tendu' | 'equilibre' | 'detendu' | 'unknown';
}

interface RiskContext {
  available: boolean;
  inondation?: { level: number; label: string };
  seisme?: { level: number; label: string };
  radon?: { level: number; label: string };
  argiles?: { level: number; label: string };
  industriel?: { level: number; label: string };
}

interface UrbanismContext {
  available: boolean;
  pluZone?: string;
  pluLabel?: string;
  constructible?: boolean;
}

interface SourcingContext {
  market?: MarketContext;
  risks?: RiskContext;
  urbanism?: UrbanismContext;
}

interface ScoreComponent {
  key: string;
  label: string;
  points: number;
  maxPoints: number;
  inputUsed: string;
  rationale?: string;
}

interface ScoreBlocker {
  key: string;
  label: string;
  severity: 'warning' | 'critical';
  message: string;
}

interface SubScore {
  value: number;
  weight: number;
  rationale: string;
  components: ScoreComponent[];
  blockers: ScoreBlocker[];
  confidence: number;
}

interface SmartScoreResult {
  globalScore: number;
  globalConfidence: number;
  globalRationale: string;
  subScores: {
    location: SubScore;
    liquidity: SubScore;
    value: SubScore;
    worksRisk: SubScore;
    legalUrbanism: SubScore;
    risk: SubScore;
    dealStructure: SubScore;
  };
  profileTarget: ProfileTarget;
  weightsUsed: Record<string, number>;
  penaltiesApplied: Array<{ reason: string; points: number }>;
  warnings: string[];
  version: string;
  computedAt: string;
  inputHash: string;
}

interface ScoreResponse {
  success: boolean;
  score: SmartScoreResult | null;
  warnings: string[];
  errors: string[];
  processingTimeMs: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SCORING_VERSION = '1.0.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PROFILE_WEIGHTS: Record<ProfileTarget, Record<string, number>> = {
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

const PRICE_REFERENCE_BY_DEPT: Record<string, { median: number; min: number; max: number }> = {
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
  'default': { median: 2500, min: 1500, max: 4500 },
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hashInput(normalized: SourcingItemNormalized): string {
  const str = JSON.stringify({
    profile: normalized.profileTarget,
    location: normalized.location,
    input: normalized.input,
    quartier: normalized.quartier,
  });
  // Simple hash for traceability
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function getPriceReference(deptCode: string): { median: number; min: number; max: number } {
  return PRICE_REFERENCE_BY_DEPT[deptCode] || PRICE_REFERENCE_BY_DEPT['default'];
}

// ============================================================================
// SCORING FUNCTIONS
// ============================================================================

function computeLocationScore(
  normalized: SourcingItemNormalized,
  geocode: GeocodeResponse | null,
  _context: SourcingContext | null,
  profile: ProfileTarget
): SubScore {
  const components: ScoreComponent[] = [];
  const blockers: ScoreBlocker[] = [];
  let baseScore = 60; // Score neutre de départ
  let confidence = 0.5;
  
  // === Géocodage ===
  if (geocode?.bestMatch?.found) {
    const geoConf = geocode.bestMatch.confidence || 0;
    confidence = Math.max(confidence, geoConf * 0.8);
    
    if (geoConf >= 0.8) {
      components.push({
        key: 'geocode_quality',
        label: 'Qualité géocodage',
        points: 10,
        maxPoints: 10,
        inputUsed: `confidence=${geoConf.toFixed(2)}`,
        rationale: 'Adresse localisée avec précision',
      });
      baseScore += 10;
    } else if (geoConf >= 0.5) {
      components.push({
        key: 'geocode_quality',
        label: 'Qualité géocodage',
        points: 5,
        maxPoints: 10,
        inputUsed: `confidence=${geoConf.toFixed(2)}`,
        rationale: 'Localisation approximative',
      });
      baseScore += 5;
    }
  } else {
    blockers.push({
      key: 'no_geocode',
      label: 'Géocodage absent',
      severity: 'warning',
      message: 'Impossible de localiser précisément - score de localisation dégradé',
    });
    confidence = 0.3;
  }
  
  // === Proximité transport ===
  const transport = normalized.quartier.proximiteTransport;
  const distance = normalized.quartier.distanceTransport;
  
  if (transport && transport !== 'unknown') {
    if (['metro', 'rer'].includes(transport)) {
      if (distance !== undefined && distance <= 600) {
        components.push({
          key: 'transport_metro_proche',
          label: 'Métro/RER < 600m',
          points: 15,
          maxPoints: 15,
          inputUsed: `${transport}, ${distance}m`,
          rationale: 'Excellente desserte transport',
        });
        baseScore += 15;
      } else {
        components.push({
          key: 'transport_metro',
          label: 'Métro/RER disponible',
          points: 10,
          maxPoints: 15,
          inputUsed: transport,
          rationale: 'Bonne desserte transport',
        });
        baseScore += 10;
      }
      confidence = Math.min(confidence + 0.2, 1);
    } else if (['tramway', 'gare'].includes(transport)) {
      components.push({
        key: 'transport_tram_gare',
        label: 'Tramway/Gare',
        points: 7,
        maxPoints: 15,
        inputUsed: transport,
        rationale: 'Desserte correcte',
      });
      baseScore += 7;
      confidence = Math.min(confidence + 0.15, 1);
    } else if (transport === 'bus') {
      components.push({
        key: 'transport_bus',
        label: 'Bus uniquement',
        points: 3,
        maxPoints: 15,
        inputUsed: transport,
        rationale: 'Desserte limitée',
      });
      baseScore += 3;
      confidence = Math.min(confidence + 0.1, 1);
    } else if (transport === 'aucun') {
      components.push({
        key: 'transport_aucun',
        label: 'Pas de transport',
        points: -5,
        maxPoints: 15,
        inputUsed: transport,
        rationale: 'Zone non desservie',
      });
      baseScore -= 5;
      confidence = Math.min(confidence + 0.1, 1);
    }
  } else {
    blockers.push({
      key: 'transport_unknown',
      label: 'Transport non renseigné',
      severity: 'warning',
      message: 'Précisez la proximité transport pour affiner le score',
    });
  }
  
  // === Nuisances ===
  const nuisances = normalized.quartier.nuisances;
  if (nuisances && nuisances !== 'unknown') {
    const nuisancePoints: Record<string, number> = {
      'aucune': 10,
      'faible': 5,
      'moyenne': 0,
      'forte': -10,
    };
    const pts = nuisancePoints[nuisances] ?? 0;
    components.push({
      key: 'nuisances',
      label: `Nuisances: ${nuisances}`,
      points: pts,
      maxPoints: 10,
      inputUsed: nuisances,
      rationale: pts > 0 ? 'Environnement calme' : pts < 0 ? 'Zone bruyante' : 'Nuisances modérées',
    });
    baseScore += pts;
    confidence = Math.min(confidence + 0.1, 1);
  }
  
  // === Commodités (bonus particulier) ===
  if (profile === 'particulier') {
    if (normalized.quartier.commercesProximite === true) {
      components.push({
        key: 'commerces',
        label: 'Commerces proches',
        points: 5,
        maxPoints: 5,
        inputUsed: 'true',
        rationale: 'Commodités à proximité',
      });
      baseScore += 5;
    }
    if (normalized.quartier.ecolesProximite === true) {
      components.push({
        key: 'ecoles',
        label: 'Écoles proches',
        points: 5,
        maxPoints: 5,
        inputUsed: 'true',
        rationale: 'Établissements scolaires accessibles',
      });
      baseScore += 5;
    }
    if (normalized.quartier.espacesVerts === true) {
      components.push({
        key: 'espaces_verts',
        label: 'Espaces verts',
        points: 3,
        maxPoints: 3,
        inputUsed: 'true',
        rationale: 'Parcs et jardins à proximité',
      });
      baseScore += 3;
    }
  }
  
  // === Sécurité ===
  const securite = normalized.quartier.securite;
  if (securite && securite !== 'unknown') {
    const secuPoints: Record<string, number> = { 'bonne': 5, 'moyenne': 0, 'faible': -8 };
    const pts = secuPoints[securite] ?? 0;
    components.push({
      key: 'securite',
      label: `Sécurité: ${securite}`,
      points: pts,
      maxPoints: 5,
      inputUsed: securite,
      rationale: pts > 0 ? 'Quartier sûr' : pts < 0 ? 'Quartier sensible' : 'Sécurité normale',
    });
    baseScore += pts;
  }
  
  const finalScore = clamp(baseScore, 0, 100);
  const weights = PROFILE_WEIGHTS[profile];
  
  return {
    value: finalScore,
    weight: weights.location,
    rationale: finalScore >= 75 
      ? 'Localisation attractive avec bonne desserte'
      : finalScore >= 50 
        ? 'Localisation correcte'
        : 'Localisation à améliorer ou données insuffisantes',
    components,
    blockers,
    confidence: clamp(confidence, 0, 1),
  };
}

function computeLiquidityScore(
  normalized: SourcingItemNormalized,
  _geocode: GeocodeResponse | null,
  context: SourcingContext | null,
  profile: ProfileTarget
): SubScore {
  const components: ScoreComponent[] = [];
  const blockers: ScoreBlocker[] = [];
  let baseScore = 60;
  let confidence = 0.4;
  
  // === Tension marché ===
  if (context?.market?.available && context.market.marketTension) {
    const tensionScores: Record<string, number> = {
      'tres_tendu': 95,
      'tendu': 80,
      'equilibre': 60,
      'detendu': 40,
      'unknown': 60,
    };
    const score = tensionScores[context.market.marketTension] ?? 60;
    components.push({
      key: 'market_tension',
      label: `Marché ${context.market.marketTension}`,
      points: score - 60,
      maxPoints: 35,
      inputUsed: context.market.marketTension,
      rationale: score > 70 ? 'Forte demande' : score < 50 ? 'Marché calme' : 'Marché équilibré',
    });
    baseScore = score;
    confidence = 0.8;
  } else {
    blockers.push({
      key: 'no_market_data',
      label: 'Données marché absentes',
      severity: 'warning',
      message: 'Score de liquidité estimé sans données de marché locales',
    });
  }
  
  // === Standing ===
  const standing = normalized.quartier.standing;
  if (standing && standing !== 'unknown') {
    const standingBonus: Record<string, number> = {
      'luxe': 10,
      'premium': 7,
      'standard': 3,
      'basique': 0,
    };
    const bonus = standingBonus[standing] ?? 0;
    components.push({
      key: 'standing',
      label: `Standing: ${standing}`,
      points: bonus,
      maxPoints: 10,
      inputUsed: standing,
      rationale: bonus > 5 ? 'Quartier recherché' : 'Standing standard',
    });
    baseScore += bonus;
    confidence = Math.min(confidence + 0.1, 1);
  }
  
  // === Type de bien et surface (impact liquidité) ===
  const propType = normalized.input.propertyType;
  const surfCat = normalized.input.surfaceCategory;
  
  // Les petites surfaces se vendent mieux
  if (['appartement', 'maison'].includes(propType)) {
    if (surfCat === 'studio' || surfCat === 'small') {
      components.push({
        key: 'surface_liquide',
        label: 'Petite surface (liquide)',
        points: 8,
        maxPoints: 10,
        inputUsed: `${surfCat}, ${normalized.input.surface}m²`,
        rationale: 'Les petites surfaces se revendent facilement',
      });
      baseScore += 8;
    } else if (surfCat === 'medium') {
      components.push({
        key: 'surface_standard',
        label: 'Surface standard',
        points: 5,
        maxPoints: 10,
        inputUsed: `${surfCat}, ${normalized.input.surface}m²`,
        rationale: 'Surface familiale classique',
      });
      baseScore += 5;
    } else if (surfCat === 'very_large') {
      components.push({
        key: 'surface_grande',
        label: 'Grande surface',
        points: -3,
        maxPoints: 10,
        inputUsed: `${surfCat}, ${normalized.input.surface}m²`,
        rationale: 'Les grandes surfaces mettent plus de temps à vendre',
      });
      baseScore -= 3;
    }
  }
  
  // === DPE (impact liquidité) ===
  const dpe = normalized.input.dpe;
  if (dpe && dpe !== 'unknown') {
    const dpeImpact: Record<string, number> = {
      'A': 8, 'B': 6, 'C': 4, 'D': 2, 'E': 0, 'F': -5, 'G': -10,
    };
    const impact = dpeImpact[dpe] ?? 0;
    components.push({
      key: 'dpe_liquidite',
      label: `DPE ${dpe}`,
      points: impact,
      maxPoints: 8,
      inputUsed: dpe,
      rationale: impact > 0 ? 'Bon DPE = revente facilitée' : impact < 0 ? 'Passoire thermique = revente difficile' : 'DPE moyen',
    });
    baseScore += impact;
    confidence = Math.min(confidence + 0.1, 1);
  }
  
  const finalScore = clamp(baseScore, 0, 100);
  const weights = PROFILE_WEIGHTS[profile];
  
  return {
    value: finalScore,
    weight: weights.liquidity,
    rationale: finalScore >= 75 
      ? 'Bien très liquide, revente rapide anticipée'
      : finalScore >= 50 
        ? 'Liquidité normale'
        : 'Revente potentiellement plus longue',
    components,
    blockers,
    confidence: clamp(confidence, 0, 1),
  };
}

function computeValueScore(
  normalized: SourcingItemNormalized,
  _geocode: GeocodeResponse | null,
  context: SourcingContext | null,
  profile: ProfileTarget
): SubScore {
  const components: ScoreComponent[] = [];
  const blockers: ScoreBlocker[] = [];
  let confidence = 0.5;
  
  const pricePerSqm = normalized.input.pricePerSqm;
  const deptCode = normalized.location.departementCode || normalized.location.codePostal.substring(0, 2);
  
  // Déterminer la référence de prix
  let referencePrice: number;
  let refSource: string;
  
  if (context?.market?.available && context.market.medianPricePerSqm) {
    referencePrice = context.market.medianPricePerSqm;
    refSource = 'données marché locales';
    confidence = 0.85;
  } else {
    const ref = getPriceReference(deptCode);
    referencePrice = ref.median;
    refSource = `heuristique département ${deptCode}`;
    blockers.push({
      key: 'no_local_market',
      label: 'Pas de données marché locales',
      severity: 'warning',
      message: `Prix évalué sur heuristique département (${ref.median}€/m²)`,
    });
  }
  
  // Calcul du ratio
  const ratio = pricePerSqm / referencePrice;
  
  // Score basé sur le ratio
  let valueScore: number;
  let rationale: string;
  
  if (ratio <= 0.85) {
    valueScore = 100;
    rationale = 'Excellente affaire - bien en-dessous du marché';
  } else if (ratio <= 0.95) {
    valueScore = 85;
    rationale = 'Bonne opportunité - légèrement sous le marché';
  } else if (ratio <= 1.05) {
    valueScore = 70;
    rationale = 'Prix dans le marché';
  } else if (ratio <= 1.15) {
    valueScore = 50;
    rationale = 'Prix légèrement au-dessus du marché';
  } else if (ratio <= 1.30) {
    valueScore = 35;
    rationale = 'Prix élevé par rapport au marché';
  } else {
    valueScore = 20;
    rationale = 'Prix très au-dessus du marché';
  }
  
  components.push({
    key: 'price_ratio',
    label: `Ratio prix (${(ratio * 100).toFixed(0)}%)`,
    points: valueScore,
    maxPoints: 100,
    inputUsed: `${pricePerSqm}€/m² vs ${referencePrice}€/m² (${refSource})`,
    rationale,
  });
  
  // === Ajustements selon profil ===
  if (profile === 'mdb') {
    // MDB cherche des décotes plus fortes
    if (ratio > 1.0) {
      const malus = Math.min(15, Math.round((ratio - 1) * 30));
      components.push({
        key: 'mdb_price_sensitivity',
        label: 'Sensibilité MDB au prix',
        points: -malus,
        maxPoints: 15,
        inputUsed: `ratio=${ratio.toFixed(2)}`,
        rationale: 'MDB recherche des décotes significatives',
      });
      valueScore -= malus;
    }
  }
  
  // === Qualité des données prix ===
  if (context?.market?.transactionsCount !== undefined) {
    if (context.market.transactionsCount >= 50) {
      confidence = Math.min(confidence + 0.1, 1);
    } else if (context.market.transactionsCount < 10) {
      confidence = Math.max(confidence - 0.15, 0.3);
      blockers.push({
        key: 'few_transactions',
        label: 'Peu de transactions',
        severity: 'warning',
        message: 'Référence basée sur moins de 10 transactions',
      });
    }
  }
  
  const finalScore = clamp(valueScore, 0, 100);
  const weights = PROFILE_WEIGHTS[profile];
  
  return {
    value: finalScore,
    weight: weights.value,
    rationale,
    components,
    blockers,
    confidence: clamp(confidence, 0, 1),
  };
}

function computeWorksRiskScore(
  normalized: SourcingItemNormalized,
  _geocode: GeocodeResponse | null,
  _context: SourcingContext | null,
  profile: ProfileTarget
): SubScore {
  const components: ScoreComponent[] = [];
  const blockers: ScoreBlocker[] = [];
  let baseScore = 70; // Score neutre-bon
  let confidence = 0.4;
  
  // === État général ===
  const etat = normalized.input.etatGeneral;
  if (etat) {
    const etatScores: Record<string, { points: number; rationale: string }> = {
      'neuf': { points: 30, rationale: 'Aucun travaux à prévoir' },
      'tres_bon': { points: 25, rationale: 'Travaux mineurs' },
      'bon': { points: 15, rationale: 'Rafraîchissement possible' },
      'moyen': { points: 0, rationale: 'Travaux de rénovation attendus' },
      'a_renover': { points: -15, rationale: 'Rénovation importante nécessaire' },
      'ruine': { points: -30, rationale: 'Reconstruction quasi-totale' },
    };
    const e = etatScores[etat] ?? { points: 0, rationale: 'État inconnu' };
    components.push({
      key: 'etat_general',
      label: `État: ${etat}`,
      points: e.points,
      maxPoints: 30,
      inputUsed: etat,
      rationale: e.rationale,
    });
    baseScore += e.points;
    confidence = Math.min(confidence + 0.25, 1);
  } else {
    blockers.push({
      key: 'no_etat',
      label: 'État non renseigné',
      severity: 'warning',
      message: 'Précisez l\'état général pour évaluer le risque travaux',
    });
  }
  
  // === DPE (risque travaux énergétiques) ===
  const dpe = normalized.input.dpe;
  if (dpe && dpe !== 'unknown') {
    const dpeRisk: Record<string, { points: number; rationale: string }> = {
      'A': { points: 15, rationale: 'Performance énergétique excellente' },
      'B': { points: 12, rationale: 'Bon DPE' },
      'C': { points: 8, rationale: 'DPE correct' },
      'D': { points: 3, rationale: 'DPE moyen' },
      'E': { points: -5, rationale: 'Travaux énergétiques recommandés' },
      'F': { points: -15, rationale: 'Passoire thermique - travaux obligatoires' },
      'G': { points: -25, rationale: 'Passoire thermique sévère - travaux majeurs' },
    };
    const d = dpeRisk[dpe] ?? { points: 0, rationale: 'DPE inconnu' };
    components.push({
      key: 'dpe_risk',
      label: `DPE ${dpe}`,
      points: d.points,
      maxPoints: 15,
      inputUsed: dpe,
      rationale: d.rationale,
    });
    baseScore += d.points;
    confidence = Math.min(confidence + 0.15, 1);
  } else {
    blockers.push({
      key: 'no_dpe',
      label: 'DPE absent',
      severity: 'warning',
      message: 'Le DPE est essentiel pour évaluer les travaux énergétiques',
    });
  }
  
  // === Année de construction ===
  const annee = normalized.input.anneeConstruction;
  if (annee !== undefined) {
    let agePoints = 0;
    let ageRationale = '';
    
    if (annee >= 2012) {
      agePoints = 10;
      ageRationale = 'Construction récente (RT2012+)';
    } else if (annee >= 2000) {
      agePoints = 5;
      ageRationale = 'Construction années 2000';
    } else if (annee >= 1980) {
      agePoints = 0;
      ageRationale = 'Construction années 80-90';
    } else if (annee >= 1950) {
      agePoints = -5;
      ageRationale = 'Immeuble ancien - vérifier réseaux';
    } else {
      agePoints = -10;
      ageRationale = 'Très ancien - risque travaux structurels';
    }
    
    components.push({
      key: 'annee_construction',
      label: `Construit en ${annee}`,
      points: agePoints,
      maxPoints: 10,
      inputUsed: annee.toString(),
      rationale: ageRationale,
    });
    baseScore += agePoints;
    confidence = Math.min(confidence + 0.1, 1);
  }
  
  // === Pour MDB: bonus si travaux (opportunité de valeur) ===
  if (profile === 'mdb' && etat && ['a_renover', 'moyen'].includes(etat)) {
    components.push({
      key: 'mdb_travaux_opportunite',
      label: 'Opportunité travaux (MDB)',
      points: 10,
      maxPoints: 10,
      inputUsed: etat,
      rationale: 'Les travaux créent de la valeur pour MDB',
    });
    baseScore += 10;
  }
  
  const finalScore = clamp(baseScore, 0, 100);
  const weights = PROFILE_WEIGHTS[profile];
  
  return {
    value: finalScore,
    weight: weights.worksRisk,
    rationale: finalScore >= 70 
      ? 'Peu de travaux à prévoir'
      : finalScore >= 50 
        ? 'Travaux modérés envisageables'
        : 'Travaux importants probables',
    components,
    blockers,
    confidence: clamp(confidence, 0, 1),
  };
}

function computeLegalUrbanismScore(
  normalized: SourcingItemNormalized,
  _geocode: GeocodeResponse | null,
  context: SourcingContext | null,
  profile: ProfileTarget
): SubScore {
  const components: ScoreComponent[] = [];
  const blockers: ScoreBlocker[] = [];
  let baseScore = 60; // Neutre par défaut
  let confidence = 0.3;
  
  // === Données urbanisme disponibles? ===
  if (context?.urbanism?.available) {
    confidence = 0.7;
    
    if (context.urbanism.constructible === true) {
      components.push({
        key: 'constructible',
        label: 'Terrain constructible',
        points: 20,
        maxPoints: 20,
        inputUsed: 'constructible=true',
        rationale: 'Droit à construire confirmé',
      });
      baseScore += 20;
    } else if (context.urbanism.constructible === false) {
      components.push({
        key: 'non_constructible',
        label: 'Non constructible',
        points: -30,
        maxPoints: 20,
        inputUsed: 'constructible=false',
        rationale: 'Pas de constructibilité',
      });
      baseScore -= 30;
      
      if (profile === 'promoteur') {
        blockers.push({
          key: 'blocker_non_constructible',
          label: 'Zone non constructible',
          severity: 'critical',
          message: 'Bloquant pour un projet de promotion',
        });
      }
    }
    
    if (context.urbanism.pluZone) {
      components.push({
        key: 'plu_zone',
        label: `Zone PLU: ${context.urbanism.pluZone}`,
        points: 5,
        maxPoints: 10,
        inputUsed: context.urbanism.pluZone,
        rationale: context.urbanism.pluLabel || 'Zone identifiée',
      });
      baseScore += 5;
    }
  } else {
    blockers.push({
      key: 'no_urbanism_data',
      label: 'Données urbanisme absentes',
      severity: 'warning',
      message: 'Score urbanisme neutre sans données PLU',
    });
  }
  
  // === Pour terrain: vérifier viabilisation ===
  if (normalized.input.propertyType === 'terrain') {
    if (normalized.input.viabilise === true) {
      components.push({
        key: 'viabilise',
        label: 'Terrain viabilisé',
        points: 15,
        maxPoints: 15,
        inputUsed: 'viabilise=true',
        rationale: 'Raccordements disponibles',
      });
      baseScore += 15;
    } else if (normalized.input.viabilise === false) {
      components.push({
        key: 'non_viabilise',
        label: 'Terrain non viabilisé',
        points: -10,
        maxPoints: 15,
        inputUsed: 'viabilise=false',
        rationale: 'Coûts de viabilisation à prévoir',
      });
      baseScore -= 10;
    }
    
    if (normalized.input.constructible === true) {
      components.push({
        key: 'input_constructible',
        label: 'Marqué constructible',
        points: 10,
        maxPoints: 10,
        inputUsed: 'constructible=true',
        rationale: 'Constructibilité indiquée par vendeur',
      });
      baseScore += 10;
    } else if (normalized.input.constructible === false) {
      components.push({
        key: 'input_non_constructible',
        label: 'Marqué non constructible',
        points: -25,
        maxPoints: 10,
        inputUsed: 'constructible=false',
        rationale: 'Non constructible selon vendeur',
      });
      baseScore -= 25;
    }
  }
  
  // === Copropriété (pour appartement/immeuble) ===
  if (['appartement', 'immeuble'].includes(normalized.input.propertyType)) {
    if (normalized.input.copropriete !== undefined) {
      const copro = normalized.input.copropriete;
      components.push({
        key: 'copropriete',
        label: copro ? 'En copropriété' : 'Mono-propriété',
        points: copro ? 0 : 5,
        maxPoints: 5,
        inputUsed: String(copro),
        rationale: copro ? 'Règles de copropriété applicables' : 'Liberté de gestion',
      });
      baseScore += copro ? 0 : 5;
    }
  }
  
  const finalScore = clamp(baseScore, 0, 100);
  const weights = PROFILE_WEIGHTS[profile];
  
  return {
    value: finalScore,
    weight: weights.legalUrbanism,
    rationale: finalScore >= 70 
      ? 'Situation juridique/urbanisme favorable'
      : finalScore >= 50 
        ? 'Situation urbanisme standard ou à vérifier'
        : 'Points d\'attention urbanisme/juridique',
    components,
    blockers,
    confidence: clamp(confidence, 0, 1),
  };
}

function computeRiskScore(
  normalized: SourcingItemNormalized,
  _geocode: GeocodeResponse | null,
  context: SourcingContext | null,
  profile: ProfileTarget
): SubScore {
  const components: ScoreComponent[] = [];
  const blockers: ScoreBlocker[] = [];
  let baseScore = 70; // Neutre-bon par défaut
  let confidence = 0.3;
  
  if (context?.risks?.available) {
    confidence = 0.75;
    
    // === Inondation ===
    if (context.risks.inondation) {
      const level = context.risks.inondation.level;
      let points = 0;
      if (level === 0) points = 10;
      else if (level === 1) points = 0;
      else if (level === 2) points = -10;
      else if (level >= 3) points = -25;
      
      components.push({
        key: 'risk_inondation',
        label: `Inondation: ${context.risks.inondation.label}`,
        points,
        maxPoints: 10,
        inputUsed: `level=${level}`,
        rationale: points > 0 ? 'Zone non inondable' : points < 0 ? 'Risque inondation présent' : 'Risque faible',
      });
      baseScore += points;
      
      if (level >= 3) {
        blockers.push({
          key: 'high_flood_risk',
          label: 'Risque inondation élevé',
          severity: profile === 'particulier' ? 'critical' : 'warning',
          message: 'Zone à risque d\'inondation fort',
        });
      }
    }
    
    // === Séisme ===
    if (context.risks.seisme) {
      const level = context.risks.seisme.level;
      let points = 0;
      if (level <= 1) points = 5;
      else if (level === 2) points = 0;
      else if (level >= 3) points = -10;
      
      components.push({
        key: 'risk_seisme',
        label: `Séisme: ${context.risks.seisme.label}`,
        points,
        maxPoints: 5,
        inputUsed: `level=${level}`,
      });
      baseScore += points;
    }
    
    // === Radon ===
    if (context.risks.radon) {
      const level = context.risks.radon.level;
      let points = 0;
      if (level <= 1) points = 3;
      else if (level === 2) points = -3;
      else if (level >= 3) points = -8;
      
      components.push({
        key: 'risk_radon',
        label: `Radon: ${context.risks.radon.label}`,
        points,
        maxPoints: 5,
        inputUsed: `level=${level}`,
      });
      baseScore += points;
    }
    
    // === Argiles ===
    if (context.risks.argiles) {
      const level = context.risks.argiles.level;
      let points = 0;
      if (level <= 1) points = 3;
      else if (level === 2) points = -5;
      else if (level >= 3) points = -12;
      
      components.push({
        key: 'risk_argiles',
        label: `Argiles: ${context.risks.argiles.label}`,
        points,
        maxPoints: 5,
        inputUsed: `level=${level}`,
      });
      baseScore += points;
    }
    
    // === Industriel ===
    if (context.risks.industriel) {
      const level = context.risks.industriel.level;
      let points = 0;
      if (level === 0) points = 5;
      else if (level === 1) points = -5;
      else if (level >= 2) points = -15;
      
      components.push({
        key: 'risk_industriel',
        label: `Industriel: ${context.risks.industriel.label}`,
        points,
        maxPoints: 5,
        inputUsed: `level=${level}`,
      });
      baseScore += points;
    }
    
  } else {
    blockers.push({
      key: 'no_risk_data',
      label: 'Données risques absentes',
      severity: 'warning',
      message: 'Score risque neutre sans données Géorisques',
    });
  }
  
  const finalScore = clamp(baseScore, 0, 100);
  const weights = PROFILE_WEIGHTS[profile];
  
  return {
    value: finalScore,
    weight: weights.risk,
    rationale: finalScore >= 75 
      ? 'Zone à faible risque environnemental'
      : finalScore >= 50 
        ? 'Risques modérés identifiés'
        : 'Risques environnementaux à surveiller',
    components,
    blockers,
    confidence: clamp(confidence, 0, 1),
  };
}

function computeDealStructureScore(
  normalized: SourcingItemNormalized,
  _geocode: GeocodeResponse | null,
  _context: SourcingContext | null,
  profile: ProfileTarget
): SubScore {
  const components: ScoreComponent[] = [];
  const blockers: ScoreBlocker[] = [];
  let baseScore = 65;
  let confidence = 0.6;
  
  const propType = normalized.input.propertyType;
  const floor = normalized.input.floor;
  
  // === Cohérence type/étage ===
  if (propType === 'terrain' && floor !== 'n/a') {
    components.push({
      key: 'terrain_floor_mismatch',
      label: 'Terrain avec étage',
      points: -10,
      maxPoints: 10,
      inputUsed: `type=${propType}, floor=${floor}`,
      rationale: 'Incohérence: terrain ne devrait pas avoir d\'étage',
    });
    baseScore -= 10;
    blockers.push({
      key: 'data_inconsistency',
      label: 'Incohérence données',
      severity: 'warning',
      message: 'Vérifiez les données saisies',
    });
  }
  
  // === Appartement: étage et ascenseur ===
  if (propType === 'appartement') {
    const highFloors = ['4', '5', '6', '7', '8', '9', '10+'];
    const isHighFloor = highFloors.includes(floor);
    const hasElevator = normalized.input.ascenseur;
    
    if (floor === 'rdc') {
      // RDC sans jardin = moins attractif
      if (!normalized.input.jardin) {
        components.push({
          key: 'rdc_sans_jardin',
          label: 'RDC sans jardin',
          points: -5,
          maxPoints: 10,
          inputUsed: `floor=${floor}, jardin=false`,
          rationale: 'RDC moins attractif sans espace extérieur',
        });
        baseScore -= 5;
      } else {
        components.push({
          key: 'rdc_avec_jardin',
          label: 'RDC avec jardin',
          points: 8,
          maxPoints: 10,
          inputUsed: `floor=${floor}, jardin=true`,
          rationale: 'RDC valorisé par le jardin',
        });
        baseScore += 8;
      }
    } else if (isHighFloor && hasElevator === false) {
      components.push({
        key: 'etage_eleve_sans_ascenseur',
        label: 'Étage élevé sans ascenseur',
        points: -15,
        maxPoints: 15,
        inputUsed: `floor=${floor}, ascenseur=false`,
        rationale: 'Pénalisant pour la revente',
      });
      baseScore -= 15;
    } else if (floor === 'dernier' && hasElevator !== false) {
      components.push({
        key: 'dernier_etage',
        label: 'Dernier étage',
        points: 10,
        maxPoints: 10,
        inputUsed: floor,
        rationale: 'Dernier étage souvent recherché',
      });
      baseScore += 10;
    }
    
    // === Extérieur (balcon/terrasse) ===
    if (normalized.input.balcon || normalized.input.terrasse) {
      const bonus = profile === 'particulier' ? 8 : 5;
      components.push({
        key: 'exterieur',
        label: 'Espace extérieur',
        points: bonus,
        maxPoints: 10,
        inputUsed: `balcon=${normalized.input.balcon}, terrasse=${normalized.input.terrasse}`,
        rationale: 'Plus-value extérieur',
      });
      baseScore += bonus;
    }
    
    // === Cave/Parking ===
    if (normalized.input.cave) {
      components.push({
        key: 'cave',
        label: 'Cave',
        points: 3,
        maxPoints: 5,
        inputUsed: 'true',
      });
      baseScore += 3;
    }
    if (normalized.input.parking) {
      const parkingBonus = ['75', '92', '93', '94'].includes(normalized.location.departementCode || '') ? 8 : 4;
      components.push({
        key: 'parking',
        label: 'Parking',
        points: parkingBonus,
        maxPoints: 10,
        inputUsed: 'true',
        rationale: 'Parking valorisant en zone dense',
      });
      baseScore += parkingBonus;
    }
  }
  
  // === Maison: jardin, garage, piscine ===
  if (propType === 'maison') {
    if (normalized.input.jardin) {
      const jardinBonus = profile === 'particulier' ? 10 : profile === 'mdb' ? 5 : 3;
      components.push({
        key: 'jardin',
        label: 'Jardin',
        points: jardinBonus,
        maxPoints: 10,
        inputUsed: `jardin=true, surface=${normalized.input.jardinSurface || 'N/A'}`,
        rationale: 'Plus-value jardin',
      });
      baseScore += jardinBonus;
    }
    
    if (normalized.input.garage) {
      components.push({
        key: 'garage',
        label: 'Garage',
        points: 5,
        maxPoints: 5,
        inputUsed: 'true',
      });
      baseScore += 5;
    }
    
    if (normalized.input.piscine) {
      const piscineBonus = profile === 'particulier' ? 5 : 2;
      components.push({
        key: 'piscine',
        label: 'Piscine',
        points: piscineBonus,
        maxPoints: 5,
        inputUsed: 'true',
        rationale: profile === 'particulier' ? 'Atout confort' : 'Atout modéré (entretien)',
      });
      baseScore += piscineBonus;
    }
  }
  
  // === Cohérence surface/pièces ===
  if (normalized.input.nbPieces !== undefined && normalized.input.surface) {
    const surfaceParPiece = normalized.input.surface / normalized.input.nbPieces;
    if (surfaceParPiece < 10) {
      components.push({
        key: 'surface_piece_faible',
        label: 'Pièces petites',
        points: -5,
        maxPoints: 5,
        inputUsed: `${surfaceParPiece.toFixed(1)}m²/pièce`,
        rationale: 'Surface par pièce faible',
      });
      baseScore -= 5;
    } else if (surfaceParPiece >= 20) {
      components.push({
        key: 'surface_piece_bonne',
        label: 'Belles surfaces',
        points: 5,
        maxPoints: 5,
        inputUsed: `${surfaceParPiece.toFixed(1)}m²/pièce`,
        rationale: 'Pièces spacieuses',
      });
      baseScore += 5;
    }
  }
  
  const finalScore = clamp(baseScore, 0, 100);
  const weights = PROFILE_WEIGHTS[profile];
  
  return {
    value: finalScore,
    weight: weights.dealStructure,
    rationale: finalScore >= 75 
      ? 'Structure de bien attractive'
      : finalScore >= 50 
        ? 'Structure correcte'
        : 'Points d\'attention sur la structure',
    components,
    blockers,
    confidence: clamp(confidence, 0, 1),
  };
}

// ============================================================================
// MAIN SCORING FUNCTION
// ============================================================================

function computeSmartScore(
  normalized: SourcingItemNormalized,
  geocode: GeocodeResponse | null,
  context: SourcingContext | null
): SmartScoreResult {
  const profile = normalized.profileTarget;
  const weights = PROFILE_WEIGHTS[profile];
  
  // Compute all subscores
  const subScores = {
    location: computeLocationScore(normalized, geocode, context, profile),
    liquidity: computeLiquidityScore(normalized, geocode, context, profile),
    value: computeValueScore(normalized, geocode, context, profile),
    worksRisk: computeWorksRiskScore(normalized, geocode, context, profile),
    legalUrbanism: computeLegalUrbanismScore(normalized, geocode, context, profile),
    risk: computeRiskScore(normalized, geocode, context, profile),
    dealStructure: computeDealStructureScore(normalized, geocode, context, profile),
  };
  
  // Calculate weighted average
  let weightedSum = 0;
  let totalWeight = 0;
  let avgConfidence = 0;
  const warnings: string[] = [];
  const penaltiesApplied: Array<{ reason: string; points: number }> = [];
  
  for (const [key, subScore] of Object.entries(subScores)) {
    weightedSum += subScore.value * subScore.weight;
    totalWeight += subScore.weight;
    avgConfidence += subScore.confidence * subScore.weight;
    
    // Collect warnings from blockers
    for (const blocker of subScore.blockers) {
      if (blocker.severity === 'warning') {
        warnings.push(`[${key}] ${blocker.message}`);
      } else if (blocker.severity === 'critical') {
        warnings.push(`⚠️ [${key}] ${blocker.message}`);
      }
    }
  }
  
  let globalScore = totalWeight > 0 ? weightedSum / totalWeight : 50;
  const globalConfidence = totalWeight > 0 ? avgConfidence / totalWeight : 0.3;
  
  // Apply confidence penalty if too low
  if (globalConfidence < 0.4) {
    const penalty = Math.round((0.4 - globalConfidence) * 25);
    penaltiesApplied.push({
      reason: 'Confiance globale faible (données insuffisantes)',
      points: -penalty,
    });
    globalScore -= penalty;
    warnings.push(`Score pénalisé de ${penalty} points car données incomplètes`);
  }
  
  // Check for critical blockers
  const hasCriticalBlocker = Object.values(subScores).some(
    ss => ss.blockers.some(b => b.severity === 'critical')
  );
  
  if (hasCriticalBlocker) {
    const penalty = 10;
    penaltiesApplied.push({
      reason: 'Bloqueur critique détecté',
      points: -penalty,
    });
    globalScore -= penalty;
  }
  
  globalScore = clamp(globalScore, 0, 100);
  
  // Generate global rationale
  let globalRationale: string;
  if (globalScore >= 80) {
    globalRationale = 'Excellente opportunité selon votre profil';
  } else if (globalScore >= 65) {
    globalRationale = 'Bonne opportunité à étudier';
  } else if (globalScore >= 50) {
    globalRationale = 'Opportunité correcte avec points d\'attention';
  } else if (globalScore >= 35) {
    globalRationale = 'Opportunité limitée ou données insuffisantes';
  } else {
    globalRationale = 'Opportunité peu recommandée selon les critères';
  }
  
  return {
    globalScore: Math.round(globalScore),
    globalConfidence: Math.round(globalConfidence * 100) / 100,
    globalRationale,
    subScores,
    profileTarget: profile,
    weightsUsed: weights,
    penaltiesApplied,
    warnings,
    version: SCORING_VERSION,
    computedAt: new Date().toISOString(),
    inputHash: hashInput(normalized),
  };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req: Request) => {
  const startTime = Date.now();
  
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, errors: ['Method not allowed'] }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
  
  try {
    const body = await req.json();
    
    let normalized: SourcingItemNormalized;
    let geocode: GeocodeResponse | null = null;
    let context: SourcingContext | null = null;
    
    // Option 1: Direct input
    if (body.normalized) {
      normalized = body.normalized;
      geocode = body.geocode || null;
      context = body.context || null;
    }
    // Option 2: Load from DB by ID
    else if (body.sourcing_item_id) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      
      if (!supabaseUrl || !supabaseKey) {
        throw new Error('Database configuration missing');
      }
      
      const supabase = createClient(supabaseUrl, supabaseKey);
      
      const { data, error } = await supabase
        .from('sourcing_items')
        .select('normalized_json, geocode_json, context_json')
        .eq('id', body.sourcing_item_id)
        .single();
      
      if (error || !data) {
        throw new Error(`Item not found: ${body.sourcing_item_id}`);
      }
      
      if (!data.normalized_json) {
        throw new Error('Item not yet analyzed');
      }
      
      normalized = data.normalized_json;
      geocode = data.geocode_json;
      context = data.context_json;
    }
    else {
      throw new Error('Must provide either "normalized" object or "sourcing_item_id"');
    }
    
    // Validate normalized data
    if (!normalized.profileTarget || !normalized.location || !normalized.input) {
      throw new Error('Invalid normalized data structure');
    }
    
    // Compute score
    const score = computeSmartScore(normalized, geocode, context);
    
    // Optionally update DB
    if (body.sourcing_item_id && body.updateDb !== false) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        
        if (supabaseUrl && supabaseKey) {
          const supabase = createClient(supabaseUrl, supabaseKey);
          
          await supabase
            .from('sourcing_items')
            .update({
              score_json: score,
              status: 'scored',
              updated_at: new Date().toISOString(),
            })
            .eq('id', body.sourcing_item_id);
        }
      } catch (dbError) {
        console.error('DB update error:', dbError);
        score.warnings.push('Score calculé mais non sauvegardé en base');
      }
    }
    
    const response: ScoreResponse = {
      success: true,
      score,
      warnings: score.warnings,
      errors: [],
      processingTimeMs: Date.now() - startTime,
    };
    
    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('Handler error:', error);
    
    return new Response(
      JSON.stringify({
        success: false,
        score: null,
        warnings: [],
        errors: [error instanceof Error ? error.message : 'Unknown error'],
        processingTimeMs: Date.now() - startTime,
      } as ScoreResponse),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});