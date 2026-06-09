// ============================================================================
// SMARTSCORE V4 — PHASE 1 : Fondations
// ============================================================================
// A. Pondération dynamique par nature de projet
// B. Score essential_services (0-100)
// C. Score accessibilité rurale (remplace transport=null en zone rurale)
// D. Helpers pour smartscore_history (benchmark / percentile)
// ============================================================================

// ----------------------------------------------------
// A. PONDERATION DYNAMIQUE PAR NATURE DE PROJET
// ----------------------------------------------------

/**
 * Piliers du SmartScore V4.
 * Chaque pilier produit un score 0-100 indépendant.
 */
export type SmartScorePillar =
  | "transport"          // TC en zone métro / accessibilité rurale hors métro
  | "commodites"         // BPE global (densité équipements)
  | "ecoles"             // Proximité scolaire
  | "marche"             // DVF : volume, prix, liquidité
  | "sante"              // Densité pro de santé + hôpital
  | "essential_services" // Pharmacie, commerce, médecin, poste, banque…
  | "environnement"      // (Phase 2 : Géorisques, DPE, bruit, air)
  | "concurrence"        // (Phase 2 : Sitadel permis concurrents)
  | "demographie";       // (Phase 2 : tendance pop, projections Omphale)

/**
 * Profils de pondération par nature de projet.
 *
 * Règles de conception :
 *  - Les poids sont sur 100 et doivent sommer à 100.
 *  - Un pilier à 0 = non évalué pour ce type de projet.
 *  - Les piliers Phase 2 (environnement, concurrence, demographie)
 *    sont à 0 tant qu'ils ne sont pas implémentés ;
 *    quand on les active, on réduit les autres proportionnellement.
 */
export const WEIGHTS_BY_PROJECT_NATURE: Record<string, Record<SmartScorePillar, number>> = {

  // --- LOGEMENT (résidentiel classique) ---
  logement: {
    transport:          20,
    commodites:         10,
    ecoles:             20,
    marche:             20,
    sante:               5,
    essential_services: 15,
    environnement:       5,  // Phase 2
    concurrence:         5,  // Phase 2
    demographie:         0,  // Phase 2
  },

  // --- RESIDENCE SENIOR ---
  residence_senior: {
    transport:          10,
    commodites:          5,
    ecoles:              0,  // Non pertinent
    marche:             15,
    sante:              30,  // Pilier dominant
    essential_services: 20,
    environnement:       5,
    concurrence:        10,  // Concurrence EHPAD/résidences
    demographie:         5,  // Vieillissement = opportunité
  },

  // --- EHPAD ---
  ehpad: {
    transport:           5,
    commodites:          5,
    ecoles:              0,
    marche:             10,
    sante:              35,  // Pilier dominant
    essential_services: 15,
    environnement:       5,
    concurrence:        15,  // Concurrence EHPAD cruciale
    demographie:        10,  // Pop 65+ croissante = GO
  },

  // --- RESIDENCE ETUDIANTE ---
  residence_etudiante: {
    transport:          30,  // Pilier dominant — étudiants sans voiture
    commodites:         15,
    ecoles:             20,  // Universités / écoles supérieures
    marche:             15,
    sante:               5,
    essential_services: 10,
    environnement:       5,
    concurrence:         0,
    demographie:         0,
  },

  // --- BUREAUX ---
  bureaux: {
    transport:          30,  // Dominant — accessibilité salariés
    commodites:         15,
    ecoles:              0,
    marche:             25,
    sante:               0,
    essential_services: 15,  // Restaurants, services
    environnement:       5,
    concurrence:        10,
    demographie:         0,
  },

  // --- COMMERCE ---
  commerce: {
    transport:          25,  // Flux piéton lié aux TC
    commodites:         20,  // Densité commerciale = chalandise
    ecoles:              0,
    marche:             25,
    sante:               0,
    essential_services: 15,
    environnement:       5,
    concurrence:        10,
    demographie:         0,
  },

  // --- HOTEL ---
  hotel: {
    transport:          25,
    commodites:         15,
    ecoles:              0,
    marche:             20,
    sante:               5,
    essential_services: 15,
    environnement:      10,  // Touristes sensibles au cadre
    concurrence:        10,
    demographie:         0,
  },

  // --- COLIVING ---
  coliving: {
    transport:          25,
    commodites:         15,
    ecoles:             10,
    marche:             15,
    sante:               5,
    essential_services: 15,
    environnement:       5,
    concurrence:        10,
    demographie:         0,
  },
};

/**
 * Fallback universel si nature inconnue.
 */
export const WEIGHTS_DEFAULT: Record<SmartScorePillar, number> = {
  transport:          20,
  commodites:         15,
  ecoles:             15,
  marche:             20,
  sante:              10,
  essential_services: 15,
  environnement:       5,
  concurrence:         0,
  demographie:         0,
};

/**
 * Résout le profil de pondération.
 * Normalise les noms (minuscules, underscores).
 */
export function resolveWeights(projectNature: string | null | undefined): Record<SmartScorePillar, number> {
  if (!projectNature) return { ...WEIGHTS_DEFAULT };

  const key = projectNature
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/é/g, "e")
    .replace(/è/g, "e");

  return { ...(WEIGHTS_BY_PROJECT_NATURE[key] ?? WEIGHTS_DEFAULT) };
}

/**
 * Filtre les piliers Phase 2 non encore implémentés
 * et redistribue leurs poids proportionnellement.
 */
export function getActiveWeights(
  weights: Record<SmartScorePillar, number>,
  implementedPillars: Set<SmartScorePillar>,
): Record<SmartScorePillar, number> {
  const active: Partial<Record<SmartScorePillar, number>> = {};
  let totalActive = 0;
  let totalAll = 0;

  for (const [pillar, w] of Object.entries(weights) as Array<[SmartScorePillar, number]>) {
    totalAll += w;
    if (implementedPillars.has(pillar) && w > 0) {
      active[pillar] = w;
      totalActive += w;
    }
  }

  // Redistribution proportionnelle
  const result: Record<SmartScorePillar, number> = { ...weights };
  if (totalActive === 0) return result;

  const scale = totalAll / totalActive;
  for (const pillar of Object.keys(result) as SmartScorePillar[]) {
    if (active[pillar] != null) {
      result[pillar] = Math.round(active[pillar]! * scale * 10) / 10;
    } else {
      result[pillar] = 0;
    }
  }

  return result;
}


// ----------------------------------------------------
// B. SCORE ESSENTIAL SERVICES (0-100)
// ----------------------------------------------------

/**
 * Seuils de distance par catégorie de service (en mètres).
 * - excellent : score 100
 * - bon : score 70
 * - acceptable : score 40
 * - au-delà : décroissance vers 0
 */
const DISTANCE_THRESHOLDS: Record<string, { excellent: number; bon: number; acceptable: number; max: number; poids: number }> = {
  pharmacie:            { excellent:  500, bon: 1500, acceptable: 5000,  max: 15000, poids: 20 },
  commerce_alimentaire: { excellent:  500, bon: 1500, acceptable: 5000,  max: 15000, poids: 20 },
  medecin_generaliste:  { excellent:  800, bon: 2000, acceptable: 8000,  max: 20000, poids: 15 },
  banque_dab:           { excellent:  500, bon: 1500, acceptable: 5000,  max: 15000, poids: 10 },
  poste:                { excellent:  500, bon: 2000, acceptable: 5000,  max: 15000, poids: 10 },
  station_service:      { excellent: 1000, bon: 3000, acceptable: 10000, max: 20000, poids:  5 },
  dentiste:             { excellent: 1000, bon: 3000, acceptable: 10000, max: 20000, poids:  5 },
  medecin_specialiste:  { excellent: 1500, bon: 5000, acceptable: 15000, max: 30000, poids:  5 },
  infirmier:            { excellent: 1000, bon: 3000, acceptable: 10000, max: 20000, poids:  5 },
  gendarmerie:          { excellent: 2000, bon: 5000, acceptable: 15000, max: 30000, poids:  3 },
  commissariat:         { excellent: 1000, bon: 3000, acceptable: 10000, max: 20000, poids:  2 },
};

/**
 * Score individuel d'un service basé sur la distance au plus proche.
 * Interpolation linéaire entre les seuils.
 */
function scoreServiceByDistance(distanceM: number | null, thresholds: { excellent: number; bon: number; acceptable: number; max: number }): number {
  if (distanceM == null) return 0; // Absent = 0

  if (distanceM <= thresholds.excellent) return 100;
  if (distanceM <= thresholds.bon) {
    // Interpolation 100 → 70
    const ratio = (distanceM - thresholds.excellent) / (thresholds.bon - thresholds.excellent);
    return Math.round(100 - ratio * 30);
  }
  if (distanceM <= thresholds.acceptable) {
    // Interpolation 70 → 40
    const ratio = (distanceM - thresholds.bon) / (thresholds.acceptable - thresholds.bon);
    return Math.round(70 - ratio * 30);
  }
  if (distanceM <= thresholds.max) {
    // Interpolation 40 → 5
    const ratio = (distanceM - thresholds.acceptable) / (thresholds.max - thresholds.acceptable);
    return Math.round(40 - ratio * 35);
  }
  return 5; // Très loin mais existe
}

/**
 * Calcule le score Essential Services (0-100) depuis un EssentialServicesBlock.
 *
 * Chaque bucket a un poids et un score basé sur la distance au nearest.
 * Le score final est la moyenne pondérée.
 */
export type EssentialServicesScoreResult = {
  score: number;
  details: Record<string, { distance_m: number | null; score: number; poids: number }>;
  missing: string[];        // Buckets sans aucun résultat
  coverage_pct: number;     // % de buckets couverts
};

export function computeEssentialServicesScore(
  essentialServices: {
    [bucket: string]: {
      count: number;
      nearest: { distance_m: number } | null;
    };
  },
): EssentialServicesScoreResult {
  const details: Record<string, { distance_m: number | null; score: number; poids: number }> = {};
  const missing: string[] = [];
  let totalPoids = 0;
  let totalScore = 0;
  let coveredCount = 0;

  for (const [bucket, thresholds] of Object.entries(DISTANCE_THRESHOLDS)) {
    const data = essentialServices[bucket];
    const nearest = data?.nearest;
    const distanceM = nearest?.distance_m ?? null;
    const score = scoreServiceByDistance(distanceM, thresholds);

    details[bucket] = {
      distance_m: distanceM,
      score,
      poids: thresholds.poids,
    };

    totalPoids += thresholds.poids;
    totalScore += score * thresholds.poids;

    if (distanceM == null || data?.count === 0) {
      missing.push(bucket);
    } else {
      coveredCount++;
    }
  }

  const finalScore = totalPoids > 0 ? Math.round(totalScore / totalPoids) : 0;
  const totalBuckets = Object.keys(DISTANCE_THRESHOLDS).length;
  const coverage_pct = Math.round((coveredCount / totalBuckets) * 100);

  return {
    score: finalScore,
    details,
    missing,
    coverage_pct,
  };
}


// ----------------------------------------------------
// C. SCORE ACCESSIBILITE RURALE (0-100)
// ----------------------------------------------------

/**
 * En zone rurale (hors grande agglomération), le transport en commun
 * n'est pas pertinent. On le remplace par un score d'accessibilité
 * basé sur la proximité des services essentiels du quotidien.
 *
 * Ce score mesure : "est-ce que les gens peuvent vivre ici
 * sans être totalement isolés ?"
 *
 * Piliers ruraux :
 *  - Pharmacie (poids 25) — besoin vital
 *  - Commerce alimentaire (poids 25) — besoin quotidien
 *  - Médecin généraliste (poids 20) — accès santé de base
 *  - Poste / banque (poids 15) — services administratifs
 *  - Station service (poids 15) — mobilité en zone rurale
 */
const RURAL_ACCESSIBILITY_WEIGHTS: Record<string, { poids: number; thresholds: { excellent: number; bon: number; acceptable: number; max: number } }> = {
  pharmacie: {
    poids: 25,
    thresholds: { excellent: 1000, bon: 3000, acceptable: 8000, max: 20000 },
  },
  commerce_alimentaire: {
    poids: 25,
    thresholds: { excellent: 1000, bon: 3000, acceptable: 8000, max: 20000 },
  },
  medecin_generaliste: {
    poids: 20,
    thresholds: { excellent: 1500, bon: 5000, acceptable: 10000, max: 25000 },
  },
  poste_banque: {
    poids: 15,
    thresholds: { excellent: 1000, bon: 3000, acceptable: 8000, max: 20000 },
  },
  station_service: {
    poids: 15,
    thresholds: { excellent: 2000, bon: 5000, acceptable: 12000, max: 25000 },
  },
};

export type RuralAccessibilityResult = {
  score: number;
  details: Record<string, { distance_m: number | null; score: number; poids: number }>;
  label: string;
  summary: string;
};

export function computeRuralAccessibilityScore(
  servicesRuraux: {
    pharmacie_proche?: { distance_m: number } | null;
    supermarche_proche?: { distance_m: number } | null;
    hypermarche_proche?: { distance_m: number } | null;
    superette_proche?: { distance_m: number } | null;
    medecin_proche?: { distance_m: number } | null;
    poste_proche?: { distance_m: number } | null;
    banque_proche?: { distance_m: number } | null;
    station_service_proche?: { distance_m: number } | null;
  },
): RuralAccessibilityResult {
  const details: Record<string, { distance_m: number | null; score: number; poids: number }> = {};
  let totalPoids = 0;
  let totalScore = 0;

  // Pharmacie
  const pharmDist = servicesRuraux.pharmacie_proche?.distance_m ?? null;
  const pharmScore = scoreServiceByDistance(pharmDist, RURAL_ACCESSIBILITY_WEIGHTS.pharmacie.thresholds);
  details.pharmacie = { distance_m: pharmDist, score: pharmScore, poids: 25 };
  totalPoids += 25;
  totalScore += pharmScore * 25;

  // Commerce alimentaire (meilleur des 3)
  const commerceDists = [
    servicesRuraux.supermarche_proche?.distance_m,
    servicesRuraux.hypermarche_proche?.distance_m,
    servicesRuraux.superette_proche?.distance_m,
  ].filter((d): d is number => d != null && Number.isFinite(d));
  const commerceDist = commerceDists.length > 0 ? Math.min(...commerceDists) : null;
  const commerceScore = scoreServiceByDistance(commerceDist, RURAL_ACCESSIBILITY_WEIGHTS.commerce_alimentaire.thresholds);
  details.commerce_alimentaire = { distance_m: commerceDist, score: commerceScore, poids: 25 };
  totalPoids += 25;
  totalScore += commerceScore * 25;

  // Médecin
  const medecinDist = servicesRuraux.medecin_proche?.distance_m ?? null;
  const medecinScore = scoreServiceByDistance(medecinDist, RURAL_ACCESSIBILITY_WEIGHTS.medecin_generaliste.thresholds);
  details.medecin_generaliste = { distance_m: medecinDist, score: medecinScore, poids: 20 };
  totalPoids += 20;
  totalScore += medecinScore * 20;

  // Poste / Banque (meilleur des 2)
  const posteBanqueDists = [
    servicesRuraux.poste_proche?.distance_m,
    servicesRuraux.banque_proche?.distance_m,
  ].filter((d): d is number => d != null && Number.isFinite(d));
  const posteBanqueDist = posteBanqueDists.length > 0 ? Math.min(...posteBanqueDists) : null;
  const posteBanqueScore = scoreServiceByDistance(posteBanqueDist, RURAL_ACCESSIBILITY_WEIGHTS.poste_banque.thresholds);
  details.poste_banque = { distance_m: posteBanqueDist, score: posteBanqueScore, poids: 15 };
  totalPoids += 15;
  totalScore += posteBanqueScore * 15;

  // Station service
  const stationDist = servicesRuraux.station_service_proche?.distance_m ?? null;
  const stationScore = scoreServiceByDistance(stationDist, RURAL_ACCESSIBILITY_WEIGHTS.station_service.thresholds);
  details.station_service = { distance_m: stationDist, score: stationScore, poids: 15 };
  totalPoids += 15;
  totalScore += stationScore * 15;

  const finalScore = totalPoids > 0 ? Math.round(totalScore / totalPoids) : 0;

  // Labels
  let label: string;
  let summary: string;

  if (finalScore >= 75) {
    label = "Bourg bien desservi";
    summary = "Services essentiels accessibles à proximité. Bonne autonomie quotidienne.";
  } else if (finalScore >= 55) {
    label = "Accessibilité correcte";
    summary = "La plupart des services essentiels sont à distance raisonnable.";
  } else if (finalScore >= 35) {
    label = "Zone isolée";
    summary = "Certains services essentiels sont éloignés. Dépendance à la voiture.";
  } else {
    label = "Zone très isolée";
    summary = "Faible accessibilité aux services. Isolement significatif.";
  }

  return { score: finalScore, details, label, summary };
}


// ----------------------------------------------------
// D. CALCUL SMARTSCORE V4 — Composite pondéré
// ----------------------------------------------------

export type SmartScoreV4Input = {
  projectNature: string | null;
  isRural: boolean;

  // Scores individuels des piliers (0-100 ou null si non disponible)
  transportScore: number | null;
  transportApplicable: boolean;
  commoditesScore: number | null;
  ecolesScore: number | null;
  marcheScore: number | null;
  santeScore: number | null;
  essentialServicesScore: number | null;

  // Phase 2 (null pour l'instant)
  environnementScore?: number | null;
  concurrenceScore?: number | null;
  demographieScore?: number | null;

  // Rural fallback
  ruralAccessibilityScore?: number | null;
};

export type SmartScoreV4Result = {
  score: number;
  verdict: string;
  pillarScores: Record<SmartScorePillar, number | null>;
  weights: Record<SmartScorePillar, number>;
  activeWeights: Record<SmartScorePillar, number>;
  projectNature: string;
  isRural: boolean;
};

/**
 * Piliers actuellement implémentés (Phase 1).
 * Ajouter ici quand un nouveau pilier est prêt.
 */
const IMPLEMENTED_PILLARS = new Set<SmartScorePillar>([
  "transport",
  "commodites",
  "ecoles",
  "marche",
  "sante",
  "essential_services",
]);

export function computeSmartScoreV4(input: SmartScoreV4Input): SmartScoreV4Result {
  const {
    projectNature,
    isRural,
    transportScore,
    transportApplicable,
    commoditesScore,
    ecolesScore,
    marcheScore,
    santeScore,
    essentialServicesScore,
    environnementScore = null,
    concurrenceScore = null,
    demographieScore = null,
    ruralAccessibilityScore = null,
  } = input;

  // 1. Résoudre les poids selon la nature du projet
  const rawWeights = resolveWeights(projectNature);

  // 2. Déterminer le score transport effectif
  //    En zone rurale : on utilise le score d'accessibilité rurale
  //    En zone métro : on utilise le score transport classique
  const effectiveTransportScore = transportApplicable
    ? transportScore
    : (ruralAccessibilityScore ?? null);

  // 3. Mapper les piliers aux scores disponibles
  const pillarScores: Record<SmartScorePillar, number | null> = {
    transport:          effectiveTransportScore,
    commodites:         commoditesScore,
    ecoles:             ecolesScore,
    marche:             marcheScore,
    sante:              santeScore,
    essential_services: essentialServicesScore,
    environnement:      environnementScore,
    concurrence:        concurrenceScore,
    demographie:        demographieScore,
  };

  // 4. Filtrer les piliers non implémentés
  const activeWeights = getActiveWeights(rawWeights, IMPLEMENTED_PILLARS);

  // 5. Moyenne pondérée sur les piliers qui ont un score
  let totalWeight = 0;
  let totalWeightedScore = 0;
  let availableCount = 0;

  for (const [pillar, weight] of Object.entries(activeWeights) as Array<[SmartScorePillar, number]>) {
    if (weight <= 0) continue;
    const score = pillarScores[pillar];
    if (score == null) continue;

    totalWeight += weight;
    totalWeightedScore += score * weight;
    availableCount++;
  }

  // Score final
  const finalScore = totalWeight > 0
    ? Math.round(totalWeightedScore / totalWeight)
    : 50; // Default neutre si aucune donnée

  // 6. Verdict contextuel
  const nature = projectNature ?? "projet";
  const ruralNote = isRural ? " (zone rurale)" : "";
  let verdict: string;

  if (availableCount === 0) {
    verdict = `Analyse impossible : aucune source disponible pour ce ${nature}.`;
  } else if (finalScore >= 80) {
    verdict = `Excellent emplacement pour un projet de ${nature}${ruralNote}. Conditions très favorables sur ${availableCount} critères.`;
  } else if (finalScore >= 65) {
    verdict = `Bon emplacement pour un projet de ${nature}${ruralNote}. Cadre favorable avec quelques points d'attention.`;
  } else if (finalScore >= 50) {
    verdict = `Emplacement correct pour un projet de ${nature}${ruralNote}. Analyse approfondie recommandée.`;
  } else if (finalScore >= 35) {
    verdict = `Emplacement moyen pour un projet de ${nature}${ruralNote}. Plusieurs points de vigilance identifiés.`;
  } else {
    verdict = `Emplacement difficile pour un projet de ${nature}${ruralNote}. Risques significatifs à évaluer.`;
  }

  return {
    score: finalScore,
    verdict,
    pillarScores,
    weights: rawWeights,
    activeWeights,
    projectNature: projectNature ?? "standard",
    isRural,
  };
}


// ----------------------------------------------------
// E. SMARTSCORE HISTORY — Helpers pour benchmark
// ----------------------------------------------------

/**
 * Structure d'un enregistrement dans smartscore_history.
 */
export type SmartScoreHistoryEntry = {
  id?: string;
  computed_at: string;           // ISO timestamp
  commune_insee: string;
  departement: string;
  lat: number;
  lon: number;
  project_nature: string;
  zone_type: "rural" | "urbain";
  score_global: number;
  pillar_scores: Record<SmartScorePillar, number | null>;
  weights_used: Record<SmartScorePillar, number>;
  essential_services_score: number | null;
  rural_accessibility_score: number | null;
  // Contexte pour le percentile
  dvf_median_m2: number | null;
  dvf_transactions_count: number | null;
  population: number | null;
};

/**
 * Calcule le percentile d'un score par rapport à un historique.
 *
 * Exemple : score=72, historique=[45,50,55,60,65,70,75,80,85,90]
 *   → 6 scores <= 72 sur 10 → percentile = 60 → "top 40%"
 */
export function computePercentile(score: number, historicalScores: number[]): {
  percentile: number;       // 0-100 (100 = meilleur que tout le monde)
  rank_label: string;       // "Top 15%", "Médiane", etc.
  sample_size: number;
} {
  if (historicalScores.length === 0) {
    return { percentile: 50, rank_label: "Données insuffisantes", sample_size: 0 };
  }

  const sorted = [...historicalScores].sort((a, b) => a - b);
  const belowCount = sorted.filter(s => s <= score).length;
  const percentile = Math.round((belowCount / sorted.length) * 100);

  let rank_label: string;
  const topPct = 100 - percentile;

  if (topPct <= 5)       rank_label = "Top 5% — Exceptionnel";
  else if (topPct <= 10) rank_label = "Top 10% — Excellent";
  else if (topPct <= 15) rank_label = "Top 15%";
  else if (topPct <= 25) rank_label = "Top 25%";
  else if (topPct <= 40) rank_label = "Au-dessus de la médiane";
  else if (topPct <= 60) rank_label = "Médiane";
  else if (topPct <= 75) rank_label = "Sous la médiane";
  else                   rank_label = "Quartile inférieur";

  return {
    percentile,
    rank_label,
    sample_size: sorted.length,
  };
}

/**
 * Filtre les scores historiques pertinents pour le benchmark.
 *
 * On compare :
 *  - Même nature de projet (obligatoire)
 *  - Même département (si assez de données, sinon national)
 *  - Même zone_type (rural/urbain)
 */
export function filterHistoricalScores(
  history: SmartScoreHistoryEntry[],
  current: { project_nature: string; departement: string; zone_type: "rural" | "urbain" },
  minSample: number = 20,
): { scores: number[]; scope: "departement" | "national" | "zone" } {

  // 1. Essai : même nature + même département
  const deptScores = history
    .filter(h =>
      h.project_nature === current.project_nature &&
      h.departement === current.departement
    )
    .map(h => h.score_global);

  if (deptScores.length >= minSample) {
    return { scores: deptScores, scope: "departement" };
  }

  // 2. Fallback : même nature + même zone_type (national)
  const zoneScores = history
    .filter(h =>
      h.project_nature === current.project_nature &&
      h.zone_type === current.zone_type
    )
    .map(h => h.score_global);

  if (zoneScores.length >= minSample) {
    return { scores: zoneScores, scope: "zone" };
  }

  // 3. Fallback : même nature (tout confondu)
  const nationalScores = history
    .filter(h => h.project_nature === current.project_nature)
    .map(h => h.score_global);

  return { scores: nationalScores, scope: "national" };
}