// =============================================================================
// Mimmoza · Valuation Engine · index.ts (v1.1.0)
// 1 seule Edge Function.  Déploiement : supabase functions deploy valuation-engine
//
// Changements v1.1 (rétro-compatibles) :
//  - Bandes de surface élargies : ±10 / ±20 / ±30 / ±50 % (poids dégressifs).
//  - Récence étendue jusqu'à 10 ans (poids résiduel) au lieu de couper à 8 ans.
//  - REPLI GARANTI : si les comparables ne donnent pas de prix/m², le moteur
//    utilise `marketReference.pricePerM2` (SmartScore / DVF commune-CP-IRIS).
//    -> Une adresse valide ne renvoie JAMAIS 0 €. Champ `valuationBasis`.
//  - Le score de localisation et son détail (transports/commerces/écoles/marché)
//    sont exposés dans le résultat (`locationScore`, `locationBreakdown`).
//  - Bloc Réhabilitation (`rehab`) calculé pour le profil réhabilitateur.
//  - Bloc Promoteur (`promoteur`) calculé quand des règles PLU sont fournies.
// =============================================================================

// =============================================================================
// TYPES
// =============================================================================

export type AnalysisType = 'investisseur' | 'rehabilitateur' | 'promoteur';

export type PropertyType =
  | 'appartement'
  | 'maison'
  | 'immeuble'
  | 'terrain'
  | 'local_commercial'
  | 'autre';

export type MarketPosition = 'underpriced' | 'fair' | 'overpriced';

/** Base de calcul effectivement utilisée pour la valeur. */
export type ValuationBasis =
  | 'comparables' // prix issu des ventes DVF comparables
  | 'market_reference' // repli sur une médiane SmartScore / DVF commune
  | 'insufficient'; // aucune donnée -> valeur 0 (cas extrême)

export interface MimmozaValuationInput {
  // Localisation
  address: string;
  city: string;
  postalCode: string;
  latitude: number;
  longitude: number;

  // Bien
  surface: number; // m² habitables / utiles
  landSurface?: number; // m² terrain (promoteur + ajustement prix maison/immeuble)
  hasPool?: boolean; // présence d'une piscine (plus-value maison/immeuble)
  askingPrice?: number; // prix demandé
  propertyType: PropertyType;

  analysisType: AnalysisType;

  // Données injectables (le moteur les utilise telles quelles)
  dvfSales?: RawDvfSale[];
  risk?: RiskInput;
  locationSignals?: LocationSignals;
  marketContext?: MarketContext;
  medianRentM2?: number; // €/m²/mois -> rendement

  // REPLI : prix de marché de secours quand les comparables manquent.
  marketReference?: MarketReference;

  // Réhabilitation
  worksAmount?: number; // budget travaux €
  resaleTarget?: number; // prix de revente cible €

  // Promoteur : règles PLU (constructibilité)
  plu?: PluConstructibility;

  // Présence des sources (score de confiance)
  sources?: DataSourcePresence;

  options?: ValuationOptions;
  extensions?: Record<string, unknown>;
}

export interface RawDvfSale {
  price: number;
  surface: number;
  latitude: number;
  longitude: number;
  saleDate: string;
  propertyType?: PropertyType;
  rooms?: number;
}

export interface MarketReference {
  pricePerM2?: number; // €/m² de secours
  source?: string; // ex: "SmartScore", "DVF commune", "DVF CP", "DVF IRIS"
}

export interface RiskInput {
  globalRiskLevel?: 'faible' | 'modere' | 'eleve' | number;
  floodRisk?: boolean;
  seismicZone?: number;
  clayShrinkSwell?: 'faible' | 'moyen' | 'fort';
  technologicalRisk?: boolean;
  securityScore?: number;
}

export interface LocationSignals {
  transportScore?: number;
  shopsScore?: number;
  schoolsScore?: number;
  localMarketScore?: number;
  urbanDensityScore?: number;
  transportStops?: number;
  shopsCount?: number;
  schoolsCount?: number;
  populationDensity?: number;
}

export interface MarketContext {
  trend12mPct?: number;
  liquidity?: 'faible' | 'normale' | 'forte';
  tensionIndex?: number;
}

export interface PluConstructibility {
  zone?: string;
  cesMaxPercent?: number; // emprise au sol max (%)
  hauteurMaxM?: number;
  hauteurMaxNiveaux?: number;
  pleineTerrePercent?: number;
}

export interface DataSourcePresence {
  dvf?: boolean;
  georisques?: boolean;
  plu?: boolean;
  cadastre?: boolean;
  sitadel?: boolean;
}

export interface ValuationOptions {
  maxDistanceMeters?: number;
  minComparables?: number;
  uncertaintyFloorPct?: number;
  chargesRatio?: number; // netYield (défaut 0.22)
  notaryRatio?: number; // frais notaire achat (défaut 0.08)
  resaleFeesRatio?: number; // frais de revente (défaut 0.06)
  rehabDurationMonths?: number; // durée opération réhab (défaut 12)
  // Anti-aberrations DVF (filtrage du prix/m² avant calcul du marché)
  outlierFloorRatio?: number; // borne basse relative à la médiane (défaut 0.5)
  outlierCeilRatio?: number; // borne haute relative à la médiane (défaut 2.0)
  priceM2AbsFloor?: number; // plancher absolu €/m² (défaut 0 = désactivé)
  priceM2AbsCeiling?: number; // plafond absolu €/m² (défaut 0 = désactivé)
  // Pertinence : un comparable dont le prix/m² s'écarte de plus de ce ratio de
  // la médiane DVF est déclassé "hors marché" (défaut 0.35 = ±35 %).
  pertinenceBandPct?: number;
}

export interface ComparableSale {
  price: number;
  surface: number;
  priceM2: number;
  distanceMeters: number;
  saleDate: string;
  ageYears: number;
  weight: number;
  outOfMarket?: boolean; // prix/m² hors bande de pertinence (±35 % médiane)
}

export interface MarketStats {
  medianPriceM2: number;
  meanPriceM2: number;
  weightedPriceM2: number;
  sampleSize: number;
  p25PriceM2?: number;
  p75PriceM2?: number;
}

export interface LocationScoreResult {
  score: number;
  breakdown: Record<string, number>;
  available: boolean;
}

export interface ConfidenceResult {
  score: number;
  factors: Record<string, number>;
}

export interface OpportunityResult {
  score: number;
  marketPosition: MarketPosition;
  deltaPct: number;
}

export interface ValuationDriver {
  key: string;
  label: string;
  impactPct: number;
  weight: number;
}

export interface ValuationComputation {
  estimatedValue: number;
  minEstimatedValue: number;
  maxEstimatedValue: number;
  drivers: ValuationDriver[];
  adjustmentMultiplier: number;
  basis: ValuationBasis;
  marketPriceM2Used: number;
}

export interface RehabPotential {
  budgetTravaux: number;
  prixAchat: number;
  valeurApresTravaux: number;
  coutTotal: number; // achat + frais notaire + travaux
  margeBrute: number; // revente - achat - travaux
  margeNette: number; // revente - coût total - frais revente
  margeNettePct: number; // marge nette / coût total
  triEstime?: number; // annualisé (hypothèse durée), indicatif
}

export interface PromoteurPotential {
  empriseAuSolM2: number;
  niveaux: number;
  sdpPotentielM2: number;
  constructibiliteScore: number; // 0..100
  densificationScore: number; // 0..100
  chargeFonciereM2Sdp: number; // €/m² SDP
}

export interface RecommendationOutput {
  strengths: string[];
  weaknesses: string[];
  warnings: string[];
  recommendation: string;
}

export interface ValuationMeta {
  engineVersion: string;
  analysisType: AnalysisType;
  comparablesUsed: number;
  computedAt: string;
  marketStats: MarketStats;
}

export interface MimmozaValuationResult {
  estimatedValue: number;
  minEstimatedValue: number;
  maxEstimatedValue: number;

  marketPriceM2: number;
  valuationBasis: ValuationBasis; // d'où vient le prix retenu

  confidenceScore: number;
  opportunityScore: number;
  marketPosition: MarketPosition;
  securityScore: number;

  // Localisation exposée pour l'affichage
  locationScore: number;
  locationBreakdown: Record<string, number>;
  locationAvailable: boolean;

  estimatedRent?: number;
  grossYield?: number;
  netYield?: number;

  rehab?: RehabPotential;
  promoteur?: PromoteurPotential;

  valuationDrivers: ValuationDriver[];
  comparables: ComparableSale[];

  strengths: string[];
  weaknesses: string[];
  warnings: string[];

  recommendation: string;

  meta: ValuationMeta;
}

export const ENGINE_VERSION = 'valuation-engine-v1.1.0';

// =============================================================================
// HELPERS
// =============================================================================

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
function clamp100(n: number): number {
  return clamp(n, 0, 100);
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

// =============================================================================
// COMPARABLES
// =============================================================================

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Distance : 0-250 / 250-500 / 500-1000 / >1000 (résiduel, pas d'exclusion). */
function distanceWeight(d: number): number {
  if (d <= 250) return 1.0;
  if (d <= 500) return 0.7;
  if (d <= 1000) return 0.45;
  if (d <= 2000) return 0.25;
  return 0.12;
}

/** Surface : ±10 / ±20 / ±30 / ±50 % (poids dégressifs). */
function surfaceWeight(target: number, surface: number): number {
  if (target <= 0 || surface <= 0) return 0;
  const ratio = Math.abs(surface - target) / target;
  if (ratio <= 0.1) return 1.0;
  if (ratio <= 0.2) return 0.6;
  if (ratio <= 0.3) return 0.35;
  if (ratio <= 0.5) return 0.15;
  return 0;
}

function ageYears(saleDate: string, now = new Date()): number {
  const d = new Date(saleDate);
  if (isNaN(d.getTime())) return Number.POSITIVE_INFINITY;
  return (now.getTime() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
}

/** Récence : < 2 / < 5 / < 8 / < 10 ans (poids résiduel au-delà de 8 ans). */
function recencyWeight(years: number): number {
  if (years < 2) return 1.0;
  if (years < 5) return 0.6;
  if (years < 8) return 0.3;
  if (years < 10) return 0.15;
  return 0;
}

/**
 * Comparables DVF pondérés (distance × surface × récence).
 * Note : si les ventes n'ont pas de coordonnées réelles (lat/lng = celles du
 * bien), la distance vaut 0 -> poids distance 1.0, le filtrage repose alors
 * sur surface + récence. C'est le comportement attendu tant que la table DVF
 * n'expose pas de géométrie par mutation.
 */
export function findComparables(
  input: MimmozaValuationInput,
  sales: RawDvfSale[],
): ComparableSale[] {
  const maxDistance = input.options?.maxDistanceMeters;
  const isLandTarget = input.propertyType === 'terrain';
  const out: ComparableSale[] = [];

  for (const s of sales) {
    if (!s.price || !s.surface || s.surface <= 0) continue;

    if (s.propertyType) {
      const isLandComp = s.propertyType === 'terrain';
      if (isLandComp !== isLandTarget) continue;
    }

    const distance = haversineMeters(
      input.latitude,
      input.longitude,
      s.latitude,
      s.longitude,
    );
    // Exclusion dure uniquement si un rayon est explicitement demandé ET que
    // la vente a une vraie coordonnée (distance > 0).
    if (maxDistance && distance > 0 && distance > maxDistance) continue;

    const dW = distanceWeight(distance);
    const sW = surfaceWeight(input.surface, s.surface);
    const years = ageYears(s.saleDate);
    const rW = recencyWeight(years);
    const weight = dW * sW * rW;
    if (weight <= 0) continue;

    out.push({
      price: s.price,
      surface: s.surface,
      priceM2: Math.round(s.price / s.surface),
      distanceMeters: Math.round(distance),
      saleDate: s.saleDate,
      ageYears: round1(years),
      weight: Math.round(weight * 1000) / 1000,
    });
  }

  out.sort((a, b) => b.weight - a.weight || a.distanceMeters - b.distanceMeters);
  return out;
}

// =============================================================================
// MARKET
// =============================================================================

export function computeMarketPrice(
  comparables: ComparableSale[],
  options?: ValuationOptions,
): MarketStats {
  if (comparables.length === 0) {
    return { medianPriceM2: 0, meanPriceM2: 0, weightedPriceM2: 0, sampleSize: 0 };
  }

  // La pertinence a-t-elle déjà été appliquée ? (applyPertinence pose le flag
  // sur tous les comparables, true ou false.)
  const pertinenceApplied = comparables.some((c) => c.outOfMarket !== undefined);

  // Exclure les comparables marqués "hors marché".
  const inMarket = comparables.filter((c) => c.outOfMarket !== true);
  const pool = inMarket.length >= 3 ? inMarket : comparables;

  let use: ComparableSale[];
  let p25: number;
  let p75: number;

  if (pertinenceApplied) {
    // La bande ±35 % a déjà fait le filtrage (et plus strictement que l'IQR).
    // On NE relance PAS l'IQR : il se resserrerait et raboterait les hauts
    // légitimes (cascade). Stats directement sur le pool en marché.
    use = pool;
    const s = pool.map((c) => c.priceM2).sort((a, b) => a - b);
    p25 = quantile(s, 0.25);
    p75 = quantile(s, 0.75);
  } else {
    // 1er passage (médiane robuste) : IQR + garde-fou anti-aberrations.
    const sortedAll = pool.map((c) => c.priceM2).sort((a, b) => a - b);
    p25 = quantile(sortedAll, 0.25);
    p75 = quantile(sortedAll, 0.75);
    const iqr = p75 - p25;
    const lo = p25 - 1.5 * iqr;
    const hi = p75 + 1.5 * iqr;
    const iqrFiltered = pool.filter((c) => c.priceM2 >= lo && c.priceM2 <= hi);
    use = iqrFiltered.length >= 3 ? iqrFiltered : pool;

    const absFloor = options?.priceM2AbsFloor ?? 0;
    const absCeil = options?.priceM2AbsCeiling ?? 0;
    const floorRatio = options?.outlierFloorRatio ?? 0.5;
    const ceilRatio = options?.outlierCeilRatio ?? 2.0;
    const guardSorted = use.map((c) => c.priceM2).sort((a, b) => a - b);
    const guardMedian = quantile(guardSorted, 0.5);
    if (guardMedian > 0) {
      const loR = guardMedian * floorRatio;
      const hiR = guardMedian * ceilRatio;
      const guarded = use.filter(
        (c) =>
          c.priceM2 >= loR &&
          c.priceM2 <= hiR &&
          (absFloor <= 0 || c.priceM2 >= absFloor) &&
          (absCeil <= 0 || c.priceM2 <= absCeil),
      );
      if (guarded.length >= 3) use = guarded;
    }
  }

  const prices = use.map((c) => c.priceM2).sort((a, b) => a - b);
  const median = quantile(prices, 0.5);
  const mean = prices.reduce((s, v) => s + v, 0) / prices.length;

  const wsum = use.reduce((s, c) => s + c.weight, 0);
  const weighted =
    wsum > 0 ? use.reduce((s, c) => s + c.priceM2 * c.weight, 0) / wsum : mean;

  return {
    medianPriceM2: Math.round(median),
    meanPriceM2: Math.round(mean),
    weightedPriceM2: Math.round(weighted),
    sampleSize: use.length,
    p25PriceM2: Math.round(p25),
    p75PriceM2: Math.round(p75),
  };
}

/**
 * Déclasse les comparables dont le prix/m² s'écarte de plus de `bandPct` de la
 * médiane DVF (défaut ±35 %). Ces ventes (démembrements, indivisions, biens
 * dégradés) sont marquées `outOfMarket` et leur poids est réduit quasi à zéro
 * -> elles n'apparaissent plus comme "pertinentes" et ne tirent plus le prix.
 */
export function applyPertinence(
  comparables: ComparableSale[],
  medianPriceM2: number,
  bandPct = 0.35,
): ComparableSale[] {
  if (medianPriceM2 <= 0) return comparables;
  const loB = medianPriceM2 * (1 - bandPct);
  const hiB = medianPriceM2 * (1 + bandPct);
  return comparables.map((c) => {
    const out = c.priceM2 < loB || c.priceM2 > hiB;
    if (!out) return { ...c, outOfMarket: false };
    return {
      ...c,
      outOfMarket: true,
      weight: Math.round(c.weight * 0.08 * 1000) / 1000,
    };
  });
}

// =============================================================================
// LOCATION
// =============================================================================

function saturate(value: number | undefined, midpoint: number): number {
  if (value === undefined || value <= 0) return 0;
  return clamp100((value / (value + midpoint)) * 100);
}

const LOCATION_WEIGHTS = {
  transport: 0.28,
  commerces: 0.22,
  ecoles: 0.18,
  marche_local: 0.2,
  densite_urbaine: 0.12,
};

export function computeLocationScore(
  signals?: LocationSignals,
): LocationScoreResult {
  const hasAny =
    !!signals &&
    Object.values(signals).some((v) => v !== undefined && v !== null);

  if (!hasAny) {
    return {
      score: 50,
      available: false,
      breakdown: {
        transport: 50,
        commerces: 50,
        ecoles: 50,
        marche_local: 50,
        densite_urbaine: 50,
      },
    };
  }

  const s = signals!;
  const transport = s.transportScore ?? saturate(s.transportStops, 4);
  const shops = s.shopsScore ?? saturate(s.shopsCount, 15);
  const schools = s.schoolsScore ?? saturate(s.schoolsCount, 5);
  const localMarket = s.localMarketScore ?? 50;
  const density = s.urbanDensityScore ?? saturate(s.populationDensity, 4000);

  const score =
    transport * LOCATION_WEIGHTS.transport +
    shops * LOCATION_WEIGHTS.commerces +
    schools * LOCATION_WEIGHTS.ecoles +
    localMarket * LOCATION_WEIGHTS.marche_local +
    density * LOCATION_WEIGHTS.densite_urbaine;

  return {
    score: Math.round(clamp100(score)),
    available: true,
    breakdown: {
      transport: Math.round(transport),
      commerces: Math.round(shops),
      ecoles: Math.round(schools),
      marche_local: Math.round(localMarket),
      densite_urbaine: Math.round(density),
    },
  };
}

// =============================================================================
// VALUATION (+ sécurité, incertitude, REPLI)
// =============================================================================

export function computeSecurityScore(risk?: RiskInput): number {
  if (!risk) return 70;
  if (typeof risk.securityScore === 'number') {
    return Math.round(clamp100(risk.securityScore));
  }
  let score = 100;
  if (risk.globalRiskLevel === 'eleve') score -= 35;
  else if (risk.globalRiskLevel === 'modere') score -= 18;
  else if (typeof risk.globalRiskLevel === 'number') {
    score = 100 - clamp100(risk.globalRiskLevel);
  }
  if (risk.floodRisk) score -= 15;
  if (risk.technologicalRisk) score -= 12;
  if (risk.clayShrinkSwell === 'fort') score -= 10;
  else if (risk.clayShrinkSwell === 'moyen') score -= 5;
  if (typeof risk.seismicZone === 'number' && risk.seismicZone >= 4) score -= 8;
  return Math.round(clamp100(score));
}

function computeUncertainty(
  market: MarketStats,
  comps: number,
  basis: ValuationBasis,
  floorPct = 0.05,
): number {
  // Sur repli marché : incertitude large d'emblée.
  if (basis === 'market_reference') return clamp(0.22, floorPct, 0.35);

  let pct = 0.18;
  if (comps >= 10) pct = 0.06;
  else if (comps >= 5) pct = 0.09;
  else if (comps >= 3) pct = 0.13;

  if (market.medianPriceM2 > 0 && market.p25PriceM2 && market.p75PriceM2) {
    const spread = (market.p75PriceM2 - market.p25PriceM2) / market.medianPriceM2;
    pct += clamp(spread, 0, 0.5) * 0.15;
  }
  return clamp(pct, floorPct, 0.3);
}

/**
 * Ajustements liés au terrain et à la piscine (maison / immeuble uniquement).
 * - Terrain : seul le foncier AU-DELÀ d'une emprise déjà intégrée aux comparables
 *   (~2× la surface bâtie) est valorisé, à un €/m² dégressif et plafonné.
 * - Piscine : plus-value proportionnelle bornée (10k–30k €).
 * Retourne des montants ABSOLUS (€) ajoutés après le multiplicateur marché.
 */
function computeLandPoolExtras(
  input: MimmozaValuationInput,
  priceM2: number,
  base: number,
): { terrainValue: number; poolValue: number; drivers: ValuationDriver[] } {
  const drivers: ValuationDriver[] = [];
  let terrainValue = 0;
  let poolValue = 0;

  const eligible =
    input.propertyType === 'maison' || input.propertyType === 'immeuble';

  // ── Terrain : surface au-delà de l'emprise standard ──
  if (eligible && input.landSurface && input.landSurface > 0 && input.surface > 0) {
    const baseline = input.surface * 2; // emprise déjà "incluse" dans les comparables
    const extraLand = Math.max(0, input.landSurface - baseline);
    if (extraLand > 0) {
      // €/m² de terrain : fraction du prix/m² bâti, bornée (rural → prime).
      const landUnit = clamp(priceM2 * 0.12, 25, 250);
      // Tranches dégressives : le jardin premium décroît.
      const t1 = Math.min(extraLand, 500);
      const t2 = Math.min(Math.max(extraLand - 500, 0), 1000);
      const t3 = Math.max(extraLand - 1500, 0);
      const raw = t1 * landUnit + t2 * landUnit * 0.4 + t3 * landUnit * 0.15;
      // Plafond anti-aberration : +35 % de la valeur bâtie.
      terrainValue = Math.round(Math.min(raw, base * 0.35));
    }
  }

  // ── Piscine : plus-value forfaitaire bornée ──
  if (eligible && input.hasPool) {
    poolValue = Math.round(clamp(base * 0.04, 10000, 30000));
  }

  if (terrainValue > 0) {
    drivers.push({
      key: 'land',
      label: 'Terrain (surface au-delà de l\'emprise standard)',
      impactPct: base > 0 ? round2((terrainValue / base) * 100) : 0,
      weight: 0.2,
    });
  }
  if (poolValue > 0) {
    drivers.push({
      key: 'pool',
      label: 'Piscine',
      impactPct: base > 0 ? round2((poolValue / base) * 100) : 0,
      weight: 0.1,
    });
  }

  return { terrainValue, poolValue, drivers };
}

export function computeValuation(
  input: MimmozaValuationInput,
  market: MarketStats,
  location: LocationScoreResult,
  securityScore: number,
  comparablesCount: number,
): ValuationComputation {
  const compsPriceM2 =
    market.weightedPriceM2 || market.medianPriceM2 || market.meanPriceM2;

  // Détermination du prix/m² + base de calcul (REPLI garanti).
  let priceM2 = compsPriceM2;
  let basis: ValuationBasis = 'comparables';

  if (!(priceM2 > 0)) {
    const ref = input.marketReference?.pricePerM2;
    if (ref && ref > 0) {
      priceM2 = ref;
      basis = 'market_reference';
    } else {
      basis = 'insufficient';
    }
  }

  if (!(priceM2 > 0) || input.surface <= 0) {
    return {
      estimatedValue: 0,
      minEstimatedValue: 0,
      maxEstimatedValue: 0,
      adjustmentMultiplier: 1,
      basis: 'insufficient',
      marketPriceM2Used: 0,
      drivers: [
        {
          key: 'no_market',
          label: 'Données de marché insuffisantes',
          impactPct: 0,
          weight: 1,
        },
      ],
    };
  }

  const base = priceM2 * input.surface;
  const drivers: ValuationDriver[] = [];

  // Sur repli marché, on n'applique pas les micro-ajustements (donnée trop large).
  const applyAdjustments = basis === 'comparables';

  const locImpact =
    applyAdjustments && location.available
      ? ((location.score - 50) / 50) * 0.05
      : 0;
  drivers.push({
    key: 'location',
    label: 'Qualité de la localisation',
    impactPct: round2(locImpact * 100),
    weight: 0.3,
  });

  const riskImpact = applyAdjustments ? ((securityScore - 85) / 85) * 0.04 : 0;
  drivers.push({
    key: 'risk',
    label: 'Exposition aux risques',
    impactPct: round2(riskImpact * 100),
    weight: 0.2,
  });

  const trend = input.marketContext?.trend12mPct ?? 0;
  const dynImpact = applyAdjustments ? clamp(trend / 100, -0.06, 0.06) * 0.5 : 0;
  drivers.push({
    key: 'dynamics',
    label: 'Dynamique du marché (12 mois)',
    impactPct: round2(dynImpact * 100),
    weight: 0.15,
  });

  drivers.push({
    key: 'comparables',
    label:
      basis === 'comparables'
        ? 'Profondeur des comparables'
        : 'Repli sur référence de marché',
    impactPct: 0,
    weight: 0.35,
  });

  const adjustmentMultiplier = clamp(
    1 + locImpact + riskImpact + dynImpact,
    0.75,
    1.25,
  );
  const marketValue = Math.round(base * adjustmentMultiplier);

  // Plus-values physiques (terrain au-delà de l'emprise standard + piscine).
  const extras = computeLandPoolExtras(input, priceM2, base);
  drivers.push(...extras.drivers);
  const estimatedValue = marketValue + extras.terrainValue + extras.poolValue;

  const uncertaintyPct = computeUncertainty(
    market,
    comparablesCount,
    basis,
    input.options?.uncertaintyFloorPct,
  );
  const minEstimatedValue = Math.round(estimatedValue * (1 - uncertaintyPct));
  const maxEstimatedValue = Math.round(estimatedValue * (1 + uncertaintyPct));

  return {
    estimatedValue,
    minEstimatedValue,
    maxEstimatedValue,
    adjustmentMultiplier: round2(adjustmentMultiplier),
    basis,
    marketPriceM2Used: Math.round(priceM2),
    drivers,
  };
}

// =============================================================================
// CONFIDENCE
// =============================================================================

export function computeConfidence(
  comparables: ComparableSale[],
  market: MarketStats,
  basis: ValuationBasis,
  sources?: DataSourcePresence,
): ConfidenceResult {
  const factors: Record<string, number> = {};

  const n = comparables.length;
  const countScore =
    n >= 12 ? 35 : n >= 8 ? 30 : n >= 5 ? 23 : n >= 3 ? 15 : n >= 1 ? 7 : 0;
  factors.comparablesCount = countScore;

  const avgWeight =
    n > 0 ? comparables.reduce((s, c) => s + c.weight, 0) / n : 0;
  const qualityScore = Math.round(avgWeight * 25);
  factors.comparablesQuality = qualityScore;

  let dispersionScore = 0;
  if (market.medianPriceM2 > 0 && market.p25PriceM2 && market.p75PriceM2) {
    const spread = (market.p75PriceM2 - market.p25PriceM2) / market.medianPriceM2;
    dispersionScore = Math.round(clamp(15 * (1 - clamp(spread / 0.5, 0, 1)), 0, 15));
  }
  factors.marketDispersion = dispersionScore;

  const s = sources ?? {};
  let sourceScore = 0;
  if (s.dvf) sourceScore += 8;
  if (s.georisques) sourceScore += 5;
  if (s.plu) sourceScore += 5;
  if (s.cadastre) sourceScore += 4;
  if (s.sitadel) sourceScore += 3;
  factors.dataSources = sourceScore;

  let score = clamp100(countScore + qualityScore + dispersionScore + sourceScore);

  // Sur repli marché : on plafonne la confiance (fiabilité faible mais > 0).
  if (basis === 'market_reference') {
    score = clamp(score, 18, 40);
    factors.marketReferenceCap = 1;
  }

  return { score: Math.round(score), factors };
}

// =============================================================================
// OPPORTUNITY
// =============================================================================

export function computeOpportunityScore(
  askingPrice: number | undefined,
  estimatedValue: number,
): OpportunityResult {
  if (!askingPrice || askingPrice <= 0 || estimatedValue <= 0) {
    return { score: 50, marketPosition: 'fair', deltaPct: 0 };
  }
  const delta = (askingPrice - estimatedValue) / estimatedValue;
  let marketPosition: MarketPosition;
  if (delta < -0.05) marketPosition = 'underpriced';
  else if (delta > 0.05) marketPosition = 'overpriced';
  else marketPosition = 'fair';
  const score = clamp100(50 - (delta / 0.3) * 50);
  return { score: Math.round(score), marketPosition, deltaPct: round1(delta * 100) };
}

// =============================================================================
// REHAB / PROMOTEUR
// =============================================================================

function computeRehab(
  input: MimmozaValuationInput,
  estimatedValue: number,
): RehabPotential | undefined {
  const works = input.worksAmount ?? 0;
  const resale = input.resaleTarget ?? 0;
  // On ne calcule que s'il y a au moins un budget travaux OU une revente cible.
  if (works <= 0 && resale <= 0) return undefined;

  const achat = input.askingPrice && input.askingPrice > 0 ? input.askingPrice : estimatedValue;
  if (achat <= 0) return undefined;

  const notaryRatio = input.options?.notaryRatio ?? 0.08;
  const resaleFeesRatio = input.options?.resaleFeesRatio ?? 0.06;
  const durationMonths = input.options?.rehabDurationMonths ?? 12;

  // Sans revente cible, on ne peut pas chiffrer la valeur après travaux :
  // on la suppose égale à l'estimation (hypothèse prudente, marge ~0).
  const valeurApresTravaux = resale > 0 ? resale : estimatedValue;

  const coutTotal = achat * (1 + notaryRatio) + works;
  const fraisRevente = valeurApresTravaux * resaleFeesRatio;
  const margeBrute = valeurApresTravaux - achat - works;
  const margeNette = valeurApresTravaux - coutTotal - fraisRevente;
  const margeNettePct = coutTotal > 0 ? (margeNette / coutTotal) * 100 : 0;

  // TRI indicatif annualisé (hypothèse simple sur la durée d'opération).
  const years = Math.max(durationMonths / 12, 0.25);
  const ratio = coutTotal > 0 ? (margeNette + coutTotal) / coutTotal : 1;
  const triEstime = ratio > 0 ? (Math.pow(ratio, 1 / years) - 1) * 100 : undefined;

  return {
    budgetTravaux: Math.round(works),
    prixAchat: Math.round(achat),
    valeurApresTravaux: Math.round(valeurApresTravaux),
    coutTotal: Math.round(coutTotal),
    margeBrute: Math.round(margeBrute),
    margeNette: Math.round(margeNette),
    margeNettePct: round1(margeNettePct),
    triEstime: triEstime !== undefined ? round1(triEstime) : undefined,
  };
}

function computePromoteur(
  input: MimmozaValuationInput,
  estimatedValue: number,
): PromoteurPotential | undefined {
  const plu = input.plu;
  const land = input.landSurface ?? 0;
  if (!plu || land <= 0) return undefined;

  const ces = plu.cesMaxPercent && plu.cesMaxPercent > 0 ? plu.cesMaxPercent / 100 : null;
  let niveaux = plu.hauteurMaxNiveaux ?? null;
  if (!niveaux && plu.hauteurMaxM && plu.hauteurMaxM > 0) {
    niveaux = Math.max(1, Math.floor(plu.hauteurMaxM / 3));
  }

  // Sans CES ni hauteur exploitables, on ne fabrique pas de SDP.
  if (ces === null && niveaux === null) return undefined;

  const empriseAuSolM2 = ces !== null ? Math.round(land * ces) : 0;
  const niv = niveaux ?? 1;
  const sdpPotentielM2 = empriseAuSolM2 > 0 ? Math.round(empriseAuSolM2 * niv) : 0;

  const charge = input.askingPrice && input.askingPrice > 0 ? input.askingPrice : estimatedValue;
  const chargeFonciereM2Sdp =
    sdpPotentielM2 > 0 && charge > 0 ? Math.round(charge / sdpPotentielM2) : 0;

  // Score constructibilité : complétude des données PLU + intensité.
  let completeness = 0;
  if (plu.zone) completeness += 25;
  if (ces !== null) completeness += 25;
  if (niveaux !== null) completeness += 25;
  if (plu.pleineTerrePercent !== undefined) completeness += 25;

  // Densification : ratio SDP / surface terrain (saturation à ~3).
  const densRatio = land > 0 ? sdpPotentielM2 / land : 0;
  const densificationScore = Math.round(clamp100((densRatio / 3) * 100));
  const constructibiliteScore = Math.round(
    clamp100(completeness * 0.6 + densificationScore * 0.4),
  );

  return {
    empriseAuSolM2,
    niveaux: niv,
    sdpPotentielM2,
    constructibiliteScore,
    densificationScore,
    chargeFonciereM2Sdp,
  };
}

// =============================================================================
// RECOMMENDATION
// =============================================================================

interface RecommendationArgs {
  input: MimmozaValuationInput;
  opportunity: OpportunityResult;
  confidence: ConfidenceResult;
  location: LocationScoreResult;
  securityScore: number;
  comparables: ComparableSale[];
  basis: ValuationBasis;
  grossYield?: number;
  marketTrend?: number;
  sources?: DataSourcePresence;
}

export function buildRecommendation(
  args: RecommendationArgs,
): RecommendationOutput {
  const { opportunity, confidence, location, securityScore, comparables, grossYield, basis } = args;

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const warnings: string[] = [];

  if (opportunity.marketPosition === 'underpriced') {
    strengths.push(`Prix inférieur au marché (${opportunity.deltaPct}%)`);
  } else if (opportunity.marketPosition === 'overpriced') {
    weaknesses.push(`Prix supérieur au marché (+${opportunity.deltaPct}%)`);
  } else if (opportunity.deltaPct !== 0) {
    strengths.push('Prix aligné sur le marché');
  }

  if (location.available && location.score >= 70) strengths.push('Secteur recherché');
  else if (location.available && location.score < 40) weaknesses.push('Localisation peu attractive');

  if (securityScore >= 80) strengths.push('Faible exposition aux risques');
  else if (securityScore < 55) weaknesses.push('Exposition aux risques notable');

  const trend = args.marketTrend ?? 0;
  if (trend > 3) strengths.push('Marché dynamique');
  else if (trend < -3) warnings.push('Marché en repli');

  if (grossYield !== undefined) {
    if (grossYield >= 6) strengths.push(`Rendement brut attractif (${grossYield}%)`);
    else if (grossYield < 4) weaknesses.push(`Rendement faible (${grossYield}%)`);
  }

  if (basis === 'market_reference') {
    warnings.push('Estimation basée sur la moyenne du secteur (peu de comparables directs)');
  } else if (comparables.length < 3) {
    warnings.push('Peu de comparables récents');
  }
  if (confidence.score < 50) warnings.push('Estimation à fiabiliser (données limitées)');

  const s = args.sources ?? {};
  if (!s.plu) warnings.push('PLU non disponible');
  if (!s.georisques) warnings.push('Données risques non disponibles');

  return { strengths, weaknesses, warnings, recommendation: buildHeadline(args) };
}

function buildHeadline(args: RecommendationArgs): string {
  const { opportunity, confidence, input, grossYield, basis } = args;

  if (basis === 'insufficient') {
    return 'Données de marché indisponibles pour cette adresse : estimation non calculable. Vérifiez la couverture DVF/SmartScore de la commune.';
  }
  if (confidence.score < 35) {
    return 'Estimation indicative : peu de données comparables. À conforter avant décision.';
  }

  const pos = opportunity.marketPosition;
  switch (input.analysisType) {
    case 'investisseur':
      if (pos === 'underpriced' && (grossYield ?? 0) >= 5) {
        return "Opportunité d'investissement : prix sous le marché et rendement correct. À étudier en priorité.";
      }
      if (pos === 'overpriced') return 'Prix au-dessus du marché : négociation nécessaire pour atteindre un rendement cible.';
      return 'Bien aligné sur le marché : intérêt conditionné au rendement et à la stratégie locative.';
    case 'rehabilitateur':
      if (pos === 'underpriced') return "Marge potentielle à l'achat : valider le budget travaux et la revente avant engagement.";
      if (pos === 'overpriced') return 'Peu de marge à ce prix pour une opération de réhabilitation : négocier.';
      return 'Opération de réhabilitation envisageable : la marge dépendra du coût des travaux.';
    case 'promoteur':
      if (pos === 'underpriced') return 'Charge foncière attractive : confirmer la constructibilité (PLU/OAP) et le bilan promoteur.';
      if (pos === 'overpriced') return 'Charge foncière élevée : le bilan promoteur sera tendu sans densité supplémentaire.';
      return "Faisabilité promoteur à confirmer via le PLU et le bilan d'opération.";
  }
}

// =============================================================================
// ORCHESTRATEUR (pur)
// =============================================================================

export function computeMimmozaValuation(
  input: MimmozaValuationInput,
): MimmozaValuationResult {
  const sales = input.dvfSales ?? [];
  const rawComparables = findComparables(input, sales);
  // Passe 1 : médiane robuste (anti-aberrations) pour fixer la bande de pertinence.
  const market0 = computeMarketPrice(rawComparables, input.options);
  // Passe 2 : déclassement "hors marché" au-delà de ±35 % de la médiane.
  const comparables = applyPertinence(
    rawComparables,
    market0.medianPriceM2,
    input.options?.pertinenceBandPct ?? 0.35,
  );
  // Prix marché final : exclut les comparables hors marché.
  const market = computeMarketPrice(comparables, input.options);
  const location = computeLocationScore(input.locationSignals);
  const securityScore = computeSecurityScore(input.risk);

  const valuation = computeValuation(
    input,
    market,
    location,
    securityScore,
    comparables.length,
  );

  const { estimatedRent, grossYield, netYield } = computeYields(
    input,
    valuation.estimatedValue,
  );

  const confidence = computeConfidence(
    comparables,
    market,
    valuation.basis,
    input.sources,
  );

  const opportunity = computeOpportunityScore(
    input.askingPrice,
    valuation.estimatedValue,
  );

  const rehab =
    input.analysisType === 'rehabilitateur'
      ? computeRehab(input, valuation.estimatedValue)
      : undefined;

  const promoteur =
    input.analysisType === 'promoteur'
      ? computePromoteur(input, valuation.estimatedValue)
      : undefined;

  const reco = buildRecommendation({
    input,
    opportunity,
    confidence,
    location,
    securityScore,
    comparables,
    basis: valuation.basis,
    grossYield,
    marketTrend: input.marketContext?.trend12mPct,
    sources: input.sources,
  });

  return {
    estimatedValue: valuation.estimatedValue,
    minEstimatedValue: valuation.minEstimatedValue,
    maxEstimatedValue: valuation.maxEstimatedValue,
    marketPriceM2: valuation.marketPriceM2Used,
    valuationBasis: valuation.basis,
    confidenceScore: confidence.score,
    opportunityScore: opportunity.score,
    marketPosition: opportunity.marketPosition,
    securityScore,
    locationScore: location.score,
    locationBreakdown: location.breakdown,
    locationAvailable: location.available,
    estimatedRent,
    grossYield,
    netYield,
    rehab,
    promoteur,
    valuationDrivers: valuation.drivers,
    comparables: comparables.slice(0, 20),
    strengths: reco.strengths,
    weaknesses: reco.weaknesses,
    warnings: reco.warnings,
    recommendation: reco.recommendation,
    meta: {
      engineVersion: ENGINE_VERSION,
      analysisType: input.analysisType,
      comparablesUsed: comparables.length,
      computedAt: new Date().toISOString(),
      marketStats: market,
    },
  };
}

function computeYields(
  input: MimmozaValuationInput,
  estimatedValue: number,
): { estimatedRent?: number; grossYield?: number; netYield?: number } {
  if (!input.medianRentM2 || input.medianRentM2 <= 0 || !input.surface) return {};
  const monthly = input.medianRentM2 * input.surface;
  const annual = monthly * 12;
  const price = input.askingPrice && input.askingPrice > 0 ? input.askingPrice : estimatedValue;
  if (price <= 0) return { estimatedRent: Math.round(monthly) };
  const gross = (annual / price) * 100;
  const chargesRatio = input.options?.chargesRatio ?? 0.22;
  const net = gross * (1 - chargesRatio);
  return {
    estimatedRent: Math.round(monthly),
    grossYield: round1(gross),
    netYield: round1(net),
  };
}

// =============================================================================
// HANDLER HTTP
// =============================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function validateInput(i: Partial<MimmozaValuationInput>): string | null {
  if (!i) return 'Payload manquant';
  if (typeof i.latitude !== 'number' || typeof i.longitude !== 'number') return 'latitude/longitude requis';
  if (typeof i.surface !== 'number' || i.surface <= 0) return 'surface invalide';
  if (!i.propertyType) return 'propertyType requis';
  if (!i.analysisType) return 'analysisType requis';
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const input = (await req.json()) as MimmozaValuationInput;
    const err = validateInput(input);
    if (err) return json({ error: err }, 400);
    const result = computeMimmozaValuation(input);
    return json(result, 200);
  } catch (e) {
    return json({ error: 'Erreur moteur de valorisation', detail: String(e) }, 500);
  }
});