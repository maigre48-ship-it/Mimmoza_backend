// ============================================================================
// SMARTSCORE V4 — PHASE 2A : Intelligence Marché
// ============================================================================
// A. Micro-marché prédictif (régression linéaire DVF → tendance prix 12 mois)
// B. Score de liquidité (volume, vélocité, dispersion)
// C. Tension locative (ratio prix/loyer, rendement brut)
// ============================================================================


// ────────────────────────────────────────────────────────────────────────────
// A. MICRO-MARCHE PREDICTIF
// ────────────────────────────────────────────────────────────────────────────
//
// Principe : régression linéaire sur les prix DVF historiques (5 ans max)
// pour estimer la tendance et projeter le prix médian à 12 mois.
//
// On utilise les transactions DVF déjà récupérées (comps + allRows),
// regroupées par trimestre, avec un decay exponentiel pour pondérer
// les données récentes plus fortement.
//

export type PriceDataPoint = {
  date: string;         // YYYY-MM-DD ou YYYY-QN
  price_m2: number;
  weight?: number;      // Pondération temporelle (decay)
};

export type PriceTrendResult = {
  // Régression
  slope_eur_m2_per_month: number;      // Pente (€/m²/mois)
  slope_pct_per_year: number;          // Pente annualisée en %
  r_squared: number;                    // Qualité du fit (0-1)
  intercept: number;

  // Projection
  current_estimated_m2: number;         // Prix estimé aujourd'hui
  projected_12m_m2: number;             // Prix projeté à 12 mois
  projected_12m_range: {                // Intervalle de confiance
    low: number;
    high: number;
  };

  // Métadonnées
  data_points_count: number;
  period_months: number;
  trend_label: string;                  // "Hausse soutenue", "Stable", etc.
  confidence: "high" | "medium" | "low";

  // Données trimestrielles pour chart
  quarterly_prices: Array<{
    quarter: string;     // "2024-Q1"
    median_m2: number;
    count: number;
  }>;
};

/**
 * Régression linéaire pondérée (weighted least squares).
 *
 * Les transactions récentes comptent plus grâce au decay exponentiel.
 * halflife_months = 12 → une transaction de 12 mois a 50% du poids d'une transaction d'aujourd'hui.
 */
function weightedLinearRegression(
  points: Array<{ x: number; y: number; w: number }>,
): { slope: number; intercept: number; r_squared: number } {
  if (points.length < 2) {
    return { slope: 0, intercept: points[0]?.y ?? 0, r_squared: 0 };
  }

  let sumW = 0, sumWx = 0, sumWy = 0, sumWx2 = 0, sumWxy = 0;

  for (const { x, y, w } of points) {
    sumW   += w;
    sumWx  += w * x;
    sumWy  += w * y;
    sumWx2 += w * x * x;
    sumWxy += w * x * y;
  }

  const denom = sumW * sumWx2 - sumWx * sumWx;
  if (Math.abs(denom) < 1e-10) {
    return { slope: 0, intercept: sumWy / sumW, r_squared: 0 };
  }

  const slope     = (sumW * sumWxy - sumWx * sumWy) / denom;
  const intercept = (sumWy - slope * sumWx) / sumW;

  // R² pondéré
  const meanY = sumWy / sumW;
  let ssTot = 0, ssRes = 0;
  for (const { x, y, w } of points) {
    const predicted = slope * x + intercept;
    ssRes += w * (y - predicted) ** 2;
    ssTot += w * (y - meanY) ** 2;
  }

  const r_squared = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  return { slope, intercept, r_squared };
}

/**
 * Regroupe les transactions par trimestre et calcule la médiane pondérée.
 */
function groupByQuarter(
  transactions: Array<{ date: string; price_m2: number }>,
): Array<{ quarter: string; median_m2: number; count: number; midMonth: number }> {
  const buckets: Record<string, number[]> = {};

  for (const t of transactions) {
    if (!t.date || t.price_m2 <= 0) continue;
    const [year, month] = t.date.split("-").map(Number);
    if (!year || !month) continue;
    const q = Math.ceil(month / 3);
    const key = `${year}-Q${q}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(t.price_m2);
  }

  return Object.entries(buckets)
    .map(([quarter, prices]) => {
      prices.sort((a, b) => a - b);
      const median = prices[Math.floor(prices.length / 2)];
      // Mois central du trimestre (pour l'axe X de la régression)
      const [y, qStr] = quarter.split("-Q");
      const midMonth = (Number(y) - 2019) * 12 + (Number(qStr) - 1) * 3 + 1; // Mois relatif depuis 2019
      return { quarter, median_m2: Math.round(median), count: prices.length, midMonth };
    })
    .sort((a, b) => a.midMonth - b.midMonth);
}

/**
 * Calcule la tendance du micro-marché.
 *
 * @param transactions  Toutes les transactions DVF avec date + prix/m²
 * @param halflifeMonths  Demi-vie pour le decay exponentiel (default 12)
 */
export function computePriceTrend(
  transactions: Array<{ date: string; price_m2: number }>,
  halflifeMonths: number = 12,
): PriceTrendResult | null {
  if (transactions.length < 5) return null;

  const quarterly = groupByQuarter(transactions);
  if (quarterly.length < 3) return null;

  const now = new Date();
  const currentMonth = (now.getFullYear() - 2019) * 12 + now.getMonth();
  const lambda = Math.LN2 / halflifeMonths;

  // Points pour la régression avec decay
  const regressionPoints = quarterly.map(q => ({
    x: q.midMonth,
    y: q.median_m2,
    w: Math.exp(-lambda * Math.max(0, currentMonth - q.midMonth)),
  }));

  const { slope, intercept, r_squared } = weightedLinearRegression(regressionPoints);

  // Projection
  const currentEstimated = Math.round(slope * currentMonth + intercept);
  const projected12m = Math.round(slope * (currentMonth + 12) + intercept);

  // Intervalle de confiance basé sur l'écart-type des résidus
  const residuals = regressionPoints.map(p => p.y - (slope * p.x + intercept));
  const stdDev = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
  const margin = Math.round(stdDev * 1.5); // ~87% confidence

  // Pente annualisée en %
  const slopePctYear = currentEstimated > 0
    ? Math.round((slope * 12 / currentEstimated) * 1000) / 10
    : 0;

  // Période couverte
  const periodMonths = quarterly.length > 0
    ? quarterly[quarterly.length - 1].midMonth - quarterly[0].midMonth
    : 0;

  // Label
  let trend_label: string;
  if (slopePctYear >= 5)       trend_label = "Hausse soutenue";
  else if (slopePctYear >= 2)  trend_label = "Hausse modérée";
  else if (slopePctYear >= -2) trend_label = "Stable";
  else if (slopePctYear >= -5) trend_label = "Baisse modérée";
  else                         trend_label = "Baisse marquée";

  // Confidence
  let confidence: "high" | "medium" | "low";
  if (r_squared >= 0.6 && transactions.length >= 30) confidence = "high";
  else if (r_squared >= 0.3 && transactions.length >= 15) confidence = "medium";
  else confidence = "low";

  return {
    slope_eur_m2_per_month: Math.round(slope * 10) / 10,
    slope_pct_per_year: slopePctYear,
    r_squared: Math.round(r_squared * 1000) / 1000,
    intercept: Math.round(intercept),
    current_estimated_m2: Math.max(0, currentEstimated),
    projected_12m_m2: Math.max(0, projected12m),
    projected_12m_range: {
      low: Math.max(0, projected12m - margin),
      high: projected12m + margin,
    },
    data_points_count: transactions.length,
    period_months: periodMonths,
    trend_label,
    confidence,
    quarterly_prices: quarterly.map(q => ({
      quarter: q.quarter,
      median_m2: q.median_m2,
      count: q.count,
    })),
  };
}


// ────────────────────────────────────────────────────────────────────────────
// B. SCORE DE LIQUIDITE
// ────────────────────────────────────────────────────────────────────────────
//
// Mesure la capacité du marché local à absorber une vente.
// Un bien dans une zone liquide se vend vite et au bon prix.
//
// 3 composantes :
//   1. Volume (nb transactions / an) → marché actif vs mort
//   2. Vélocité (variation du volume YoY) → marché accélère vs ralentit
//   3. Dispersion (écart Q1-Q3 / médiane) → prix homogènes vs chaotiques
//

export type LiquidityScoreResult = {
  score: number;             // 0-100
  label: string;             // "Très liquide", "Liquide", "Peu liquide", "Illiquide"
  components: {
    volume_score: number;    // 0-100
    velocity_score: number;  // 0-100
    dispersion_score: number; // 0-100 (inverse : faible dispersion = bon)
  };
  metrics: {
    transactions_per_year: number;
    volume_yoy_pct: number | null;       // Variation annuelle du volume
    price_dispersion_pct: number | null; // (Q3-Q1)/médiane en %
    estimated_days_to_sell: number | null;
  };
};

/**
 * Calcule le score de liquidité.
 *
 * @param currentCount     Nb transactions sur la période récente (ex: 12 mois)
 * @param previousCount    Nb transactions sur la période précédente (même durée)
 * @param medianPriceM2    Prix médian €/m²
 * @param q1PriceM2        1er quartile
 * @param q3PriceM2        3ème quartile
 * @param periodMonths     Durée de la période en mois
 * @param isRural          Zone rurale (seuils différents)
 */
export function computeLiquidityScore(
  currentCount: number,
  previousCount: number | null,
  medianPriceM2: number | null,
  q1PriceM2: number | null,
  q3PriceM2: number | null,
  periodMonths: number = 12,
  isRural: boolean = false,
): LiquidityScoreResult {

  // ─── 1. Volume score ───
  const annualizedCount = periodMonths > 0
    ? Math.round(currentCount * 12 / periodMonths)
    : currentCount;

  // Seuils adaptés rural/urbain
  const volumeThresholds = isRural
    ? { excellent: 20, bon: 10, acceptable: 5 }
    : { excellent: 60, bon: 30, acceptable: 10 };

  let volume_score: number;
  if (annualizedCount >= volumeThresholds.excellent)   volume_score = 100;
  else if (annualizedCount >= volumeThresholds.bon)     volume_score = 70 + 30 * (annualizedCount - volumeThresholds.bon) / (volumeThresholds.excellent - volumeThresholds.bon);
  else if (annualizedCount >= volumeThresholds.acceptable) volume_score = 40 + 30 * (annualizedCount - volumeThresholds.acceptable) / (volumeThresholds.bon - volumeThresholds.acceptable);
  else if (annualizedCount > 0) volume_score = 10 + 30 * annualizedCount / volumeThresholds.acceptable;
  else volume_score = 0;

  volume_score = Math.round(Math.min(100, Math.max(0, volume_score)));

  // ─── 2. Velocity score (variation YoY) ───
  let velocity_score = 50; // Neutre par défaut
  let volume_yoy_pct: number | null = null;

  if (previousCount != null && previousCount > 0) {
    volume_yoy_pct = Math.round(((currentCount - previousCount) / previousCount) * 100);

    // +20% YoY → score 80, -20% → score 20
    velocity_score = Math.round(50 + volume_yoy_pct * 1.5);
    velocity_score = Math.min(100, Math.max(0, velocity_score));
  }

  // ─── 3. Dispersion score (IQR / médiane) ───
  let dispersion_score = 50;
  let price_dispersion_pct: number | null = null;

  if (medianPriceM2 != null && q1PriceM2 != null && q3PriceM2 != null && medianPriceM2 > 0) {
    const iqr = q3PriceM2 - q1PriceM2;
    price_dispersion_pct = Math.round((iqr / medianPriceM2) * 100);

    // Faible dispersion = bon (marché prévisible)
    // < 15% → score 100, > 60% → score 10
    if (price_dispersion_pct <= 15)      dispersion_score = 100;
    else if (price_dispersion_pct <= 30) dispersion_score = 70;
    else if (price_dispersion_pct <= 45) dispersion_score = 45;
    else if (price_dispersion_pct <= 60) dispersion_score = 25;
    else                                  dispersion_score = 10;
  }

  // ─── Score composite ───
  const score = Math.round(
    volume_score * 0.50 +
    velocity_score * 0.25 +
    dispersion_score * 0.25
  );

  // ─── Estimation jours de vente ───
  // Heuristique : marché avec 60 ventes/an dans un rayon de 2km
  // → stock moyen ~X biens → délai estimé en jours
  let estimated_days_to_sell: number | null = null;
  if (annualizedCount > 0) {
    // Formule simplifiée : 365 / (annualizedCount * facteur_absorption)
    // facteur_absorption ≈ 0.3 pour un bien au prix du marché
    estimated_days_to_sell = Math.round(365 / (annualizedCount * 0.3));
    estimated_days_to_sell = Math.min(365, Math.max(14, estimated_days_to_sell));
  }

  // Label
  let label: string;
  if (score >= 75)      label = "Très liquide";
  else if (score >= 55) label = "Liquide";
  else if (score >= 35) label = "Peu liquide";
  else                  label = "Illiquide";

  return {
    score,
    label,
    components: { volume_score, velocity_score, dispersion_score },
    metrics: {
      transactions_per_year: annualizedCount,
      volume_yoy_pct,
      price_dispersion_pct,
      estimated_days_to_sell,
    },
  };
}


// ────────────────────────────────────────────────────────────────────────────
// C. TENSION LOCATIVE
// ────────────────────────────────────────────────────────────────────────────
//
// Compare le prix d'achat au loyer estimé pour calculer :
//   - Rendement brut (loyer annuel / prix achat)
//   - Ratio prix/loyer (nb d'années de loyer pour rembourser)
//   - Score de tension (offre vs demande locative)
//
// Sources de loyers :
//   1. Observatoire des loyers (Clameur, OLL) — à intégrer Phase 3
//   2. Estimation par barème départemental (fallback immédiat)
//   3. Données utilisateur (targets.monthly_rent)
//

/**
 * Barème loyer estimé par département (€/m²/mois).
 * Source : moyennes Clameur/SeLoger 2024, arrondies.
 * À remplacer par API Observatoire des loyers en Phase 3.
 */
const LOYER_MEDIAN_PAR_DEPT: Record<string, number> = {
  "75": 30.0,  // Paris
  "92": 22.0,  // Hauts-de-Seine
  "93": 18.0,  // Seine-Saint-Denis
  "94": 18.5,  // Val-de-Marne
  "69": 14.5,  // Rhône (Lyon)
  "13": 14.0,  // Bouches-du-Rhône (Marseille)
  "33": 13.0,  // Gironde (Bordeaux)
  "31": 12.5,  // Haute-Garonne (Toulouse)
  "44": 12.5,  // Loire-Atlantique (Nantes)
  "59": 12.0,  // Nord (Lille)
  "67": 12.5,  // Bas-Rhin (Strasbourg)
  "06": 17.0,  // Alpes-Maritimes (Nice)
  "34": 13.5,  // Hérault (Montpellier)
  "35": 11.5,  // Ille-et-Vilaine (Rennes)
  "38": 11.0,  // Isère (Grenoble)
  "76": 11.0,  // Seine-Maritime (Rouen)
  "83": 13.0,  // Var (Toulon)
  "77": 14.0,  // Seine-et-Marne
  "78": 16.0,  // Yvelines
  "91": 14.0,  // Essonne
  "95": 14.5,  // Val-d'Oise
  // Métropoles secondaires
  "54": 10.5,  // Meurthe-et-Moselle (Nancy)
  "57": 10.0,  // Moselle (Metz)
  "63": 10.5,  // Puy-de-Dôme (Clermont)
  "45": 10.5,  // Loiret (Orléans)
  "37": 11.0,  // Indre-et-Loire (Tours)
  "49": 10.5,  // Maine-et-Loire (Angers)
  "29": 10.0,  // Finistère (Brest)
  "56": 10.0,  // Morbihan (Vannes/Lorient)
  "14": 10.5,  // Calvados (Caen)
  "21": 10.5,  // Côte-d'Or (Dijon)
  "25": 10.0,  // Doubs (Besançon)
  "68": 10.5,  // Haut-Rhin (Mulhouse/Colmar)
  "87": 9.0,   // Haute-Vienne (Limoges)
  "86": 9.5,   // Vienne (Poitiers)
  "17": 10.5,  // Charente-Maritime (La Rochelle)
  "64": 11.0,  // Pyrénées-Atlantiques (Bayonne/Pau)
  "66": 10.5,  // Pyrénées-Orientales (Perpignan)
  "30": 10.5,  // Gard (Nîmes)
  "84": 10.0,  // Vaucluse (Avignon)
};

/** Loyer national médian par défaut */
const LOYER_MEDIAN_NATIONAL = 11.0;

export type RentalTensionResult = {
  score: number;                      // 0-100 (100 = très tendu, favorable au bailleur)
  label: string;
  loyer_estime_m2_mois: number;       // €/m²/mois
  loyer_source: "user" | "departement" | "national";
  rendement_brut_pct: number | null;  // Loyer annuel / prix achat * 100
  ratio_prix_loyer: number | null;    // Prix / (loyer mensuel * 12) = nb années
  metrics: {
    loyer_mensuel_estime: number | null;     // Pour une surface donnée
    loyer_annuel_estime: number | null;
    prix_achat_m2: number | null;
    surface_m2: number | null;
  };
};

/**
 * Calcule la tension locative.
 *
 * @param prixM2        Prix d'achat au m² (DVF médian ou cible user)
 * @param departement   Code département (2 chiffres)
 * @param surfaceM2     Surface du bien (optionnel, pour loyer mensuel absolu)
 * @param userLoyerM2   Loyer fourni par l'utilisateur (€/m²/mois, prioritaire)
 */
export function computeRentalTension(
  prixM2: number | null,
  departement: string | null,
  surfaceM2: number | null = null,
  userLoyerM2: number | null = null,
): RentalTensionResult {

  // 1. Résoudre le loyer estimé
  let loyer_m2: number;
  let loyer_source: "user" | "departement" | "national";

  if (userLoyerM2 != null && userLoyerM2 > 0) {
    loyer_m2 = userLoyerM2;
    loyer_source = "user";
  } else if (departement && LOYER_MEDIAN_PAR_DEPT[departement]) {
    loyer_m2 = LOYER_MEDIAN_PAR_DEPT[departement];
    loyer_source = "departement";
  } else {
    loyer_m2 = LOYER_MEDIAN_NATIONAL;
    loyer_source = "national";
  }

  // 2. Calculs
  let rendement_brut_pct: number | null = null;
  let ratio_prix_loyer: number | null = null;
  let loyer_mensuel: number | null = null;
  let loyer_annuel: number | null = null;

  if (prixM2 != null && prixM2 > 0) {
    // Rendement brut = (loyer annuel / prix) * 100
    rendement_brut_pct = Math.round((loyer_m2 * 12 / prixM2) * 1000) / 10;

    // Ratio prix/loyer = combien d'années de loyer pour payer le bien
    ratio_prix_loyer = Math.round(prixM2 / (loyer_m2 * 12) * 10) / 10;
  }

  if (surfaceM2 != null && surfaceM2 > 0) {
    loyer_mensuel = Math.round(loyer_m2 * surfaceM2);
    loyer_annuel = loyer_mensuel * 12;
  }

  // 3. Score de tension
  //
  // Rendement brut élevé = marché tendu favorable au bailleur
  //   > 7%  → score 90 (petite ville, fort rendement)
  //   5-7%  → score 75 (bon marché locatif)
  //   3-5%  → score 55 (correct)
  //   2-3%  → score 35 (marché cher, faible rendement)
  //   < 2%  → score 15 (très cher, bulle potentielle)
  //
  let score = 50;
  if (rendement_brut_pct != null) {
    if (rendement_brut_pct >= 8)       score = 95;
    else if (rendement_brut_pct >= 7)  score = 85;
    else if (rendement_brut_pct >= 5)  score = 70;
    else if (rendement_brut_pct >= 4)  score = 55;
    else if (rendement_brut_pct >= 3)  score = 40;
    else if (rendement_brut_pct >= 2)  score = 25;
    else                               score = 10;
  }

  // Label
  let label: string;
  if (score >= 75)      label = "Marché locatif très tendu";
  else if (score >= 55) label = "Marché locatif favorable";
  else if (score >= 35) label = "Marché locatif équilibré";
  else                  label = "Marché locatif détendu (prix élevés)";

  return {
    score,
    label,
    loyer_estime_m2_mois: loyer_m2,
    loyer_source,
    rendement_brut_pct,
    ratio_prix_loyer,
    metrics: {
      loyer_mensuel_estime: loyer_mensuel,
      loyer_annuel_estime: loyer_annuel,
      prix_achat_m2: prixM2,
      surface_m2: surfaceM2,
    },
  };
}


// ────────────────────────────────────────────────────────────────────────────
// HELPER : Score marché composite (remplace l'ancien marcheScore simple)
// ────────────────────────────────────────────────────────────────────────────
//
// Fusionne :
//   - Volume DVF (ancien marcheScore)
//   - Tendance prix (priceTrend)
//   - Liquidité
//   - Tension locative (si pertinent pour le type de projet)
//

export type MarketCompositeInput = {
  dvfTransactionsCount: number;
  dvfMedianM2: number | null;
  dvfQ1M2: number | null;
  dvfQ3M2: number | null;
  dvfPreviousCount: number | null;
  priceTrend: PriceTrendResult | null;
  liquidity: LiquidityScoreResult | null;
  rentalTension: RentalTensionResult | null;
  projectNature: string;
  isRural: boolean;
  periodMonths: number;
};

export type MarketCompositeResult = {
  score: number;
  components: {
    volume_score: number;
    trend_score: number;
    liquidity_score: number;
    tension_score: number | null;  // null si non pertinent
  };
  weights_used: {
    volume: number;
    trend: number;
    liquidity: number;
    tension: number;
  };
};

/**
 * Projets pour lesquels la tension locative est pertinente.
 */
const RENTAL_RELEVANT_NATURES = new Set([
  "logement",
  "residence_senior",
  "residence_etudiante",
  "coliving",
  "bureaux",
]);

export function computeMarketComposite(input: MarketCompositeInput): MarketCompositeResult {
  const {
    dvfTransactionsCount,
    priceTrend,
    liquidity,
    rentalTension,
    projectNature,
    isRural,
  } = input;

  // Volume score (compatibilité avec l'ancien computeIndex)
  const volumeThreshold = isRural ? 30 : 100;
  const volume_score = Math.min(100, Math.round((dvfTransactionsCount / volumeThreshold) * 100));

  // Trend score : basé sur la pente annualisée
  let trend_score = 50;
  if (priceTrend) {
    const slope = priceTrend.slope_pct_per_year;
    // +5%/an → 85, 0% → 50, -5% → 15
    trend_score = Math.round(50 + slope * 7);
    trend_score = Math.min(100, Math.max(0, trend_score));

    // Pondérer par la confiance
    if (priceTrend.confidence === "low") {
      trend_score = Math.round(trend_score * 0.5 + 50 * 0.5); // Tirer vers 50
    } else if (priceTrend.confidence === "medium") {
      trend_score = Math.round(trend_score * 0.75 + 50 * 0.25);
    }
  }

  const liquidity_score = liquidity?.score ?? 50;
  const tension_score = rentalTension?.score ?? null;

  // Pondération selon pertinence
  const isRentalRelevant = RENTAL_RELEVANT_NATURES.has(projectNature.toLowerCase());

  let weights: { volume: number; trend: number; liquidity: number; tension: number };

  if (isRentalRelevant && tension_score != null) {
    weights = { volume: 25, trend: 30, liquidity: 20, tension: 25 };
  } else {
    weights = { volume: 30, trend: 40, liquidity: 30, tension: 0 };
  }

  let totalW = weights.volume + weights.trend + weights.liquidity + weights.tension;
  let totalS = volume_score * weights.volume
             + trend_score * weights.trend
             + liquidity_score * weights.liquidity
             + (tension_score ?? 0) * weights.tension;

  const score = totalW > 0 ? Math.round(totalS / totalW) : 50;

  return {
    score,
    components: { volume_score, trend_score, liquidity_score, tension_score },
    weights_used: weights,
  };
}