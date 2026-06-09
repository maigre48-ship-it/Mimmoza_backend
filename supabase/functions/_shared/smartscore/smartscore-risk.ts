// ============================================================================
// SmartScore × Risk Engine — Mimmoza
// Module d'intégration des risques dans le SmartScore global
// Usage : Supabase Edge Function / module pur TypeScript
// ============================================================================

// ---------------------------------------------------------------------------
// 1. TYPES
// ---------------------------------------------------------------------------

/** Niveau de risque normalisé retourné par le Risk Engine */
export type RiskLevel = "faible" | "moyen" | "fort" | "inconnu" | "non_concerne";

/** Entrée unitaire du Risk Engine (16 clés fixes) */
export type RiskItem = {
  key: string;
  label: string;
  level: RiskLevel;
  scoreImpact?: number;
  source?: string;
};

/** Poids stratégique d'un risque (1 = mineur, 3 = critique) */
export type RiskWeight = 1 | 2 | 3;

/** Décomposition du SmartScore existant (avant intégration risques) */
export type SmartScoreBase = {
  totalScore: number;
  breakdown: {
    market: number;
    faisabilite: number;
    localisation: number;
    finance: number;
  };
};

/** Détail d'impact pour un risque individuel — traçabilité comité */
export type RiskDetail = {
  key: string;
  level: RiskLevel;
  weight: RiskWeight;
  /** Pénalité brute du niveau (ex: -15 pour "fort") */
  penalty: number;
  /** Impact pondéré = penalty × weight */
  impact: number;
};

/** Sortie finale : SmartScore global intégrant les risques */
export type SmartScoreWithRisk = {
  /** Score global final (0–100, entier) */
  totalScore: number;
  /** Score risques normalisé (0–100) — 100 = aucun risque */
  riskScore: number;
  /** Somme brute des pénalités pondérées (≤ 0) */
  riskPenaltyRaw: number;
  breakdown: {
    market: number;
    faisabilite: number;
    localisation: number;
    finance: number;
    risques: number;
  };
  /** Détail par risque pour justification en comité crédit */
  riskDetails: RiskDetail[];
};

// ---------------------------------------------------------------------------
// 2. CONSTANTES MÉTIER (documentées pour audit / comité)
// ---------------------------------------------------------------------------

/**
 * Pénalité par niveau de risque.
 *
 * Justification comité :
 * - faible / non_concerné : aucun impact
 * - moyen : pénalité modérée (-5), signale une vigilance sans dégrader fortement
 * - fort : pénalité significative (-15), jamais bloquante seule
 *   (un seul risque fort poids 3 = -45 → riskScore 55, impact final ~4.5 pts)
 * - inconnu : pénalité prudentielle (-3), incite à la levée d'incertitude
 */
const RISK_LEVEL_PENALTY: Record<RiskLevel, number> = {
  faible: 0,
  moyen: -5,
  fort: -15,
  inconnu: -3,
  non_concerne: 0,
} as const;

/**
 * Pondération stratégique de chaque risque (16 clés).
 *
 * Poids 3 : risques pouvant remettre en cause la faisabilité du projet
 *           (inondation, pollution, côtier, minier)
 * Poids 2 : risques structurels nécessitant des études complémentaires
 *           (sismique, mouvement terrain, industriel, retrait-gonflement argiles,
 *            feu de forêt, avalanche)
 * Poids 1 : risques maîtrisables ou à faible impact financier
 *           (radon, bruit, tempête, technologique, rupture barrage, volcanique)
 */
const RISK_WEIGHTS: Record<string, RiskWeight> = {
  flood: 3,
  seismic: 2,
  pollution: 3,
  landslide: 2,
  radon: 1,
  noise: 1,
  industrial: 2,
  clay_shrinkage: 2,       // retrait-gonflement des argiles
  coastal_erosion: 3,      // érosion côtière
  wildfire: 2,             // feu de forêt
  avalanche: 2,
  storm: 1,                // tempête
  technological: 1,        // risque technologique (SEVESO, etc.)
  dam_failure: 1,          // rupture de barrage
  volcanic: 1,
  mining: 3,               // cavités minières / souterraines
} as const;

/** Nombre attendu de risques — garde-fou d'intégrité */
const EXPECTED_RISK_COUNT = 16;

/**
 * Pondérations du SmartScore global.
 * Total = 1.00 — les risques représentent 10 % du score final.
 *
 * Justification comité :
 * - market + faisabilité = 60 % → cœur de la décision promoteur
 * - localisation = 20 % → qualité intrinsèque du site
 * - finance = 10 % → viabilité économique
 * - risques = 10 % → conformité réglementaire & aléas naturels
 */
const SMARTSCORE_WEIGHTS = {
  market: 0.30,
  faisabilite: 0.30,
  localisation: 0.20,
  finance: 0.10,
  risques: 0.10,
} as const;

// ---------------------------------------------------------------------------
// 3. UTILITAIRES
// ---------------------------------------------------------------------------

/** Borne une valeur entre min et max */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Retourne le poids d'un risque. Défaut = 1 si la clé est inconnue,
 * pour garantir la robustesse face à d'éventuelles extensions futures.
 */
function getRiskWeight(key: string): RiskWeight {
  return RISK_WEIGHTS[key] ?? 1;
}

// ---------------------------------------------------------------------------
// 4. FONCTIONS PRINCIPALES
// ---------------------------------------------------------------------------

/**
 * Calcule le RiskScore agrégé à partir de la liste normalisée des risques.
 *
 * @param risks — Tableau de 16 RiskItem (retour du Risk Engine)
 * @returns { riskScore, riskPenaltyRaw, riskDetails }
 *
 * Logique :
 * 1. Pour chaque risque : impact = penalty(level) × weight
 * 2. riskPenaltyRaw = Σ impacts (toujours ≤ 0)
 * 3. riskScore = clamp(100 + riskPenaltyRaw, 0, 100)
 *
 * Exemple comité :
 *   2 risques forts (poids 3) + 3 moyens (poids 2)
 *   = 2×(-15×3) + 3×(-5×2) = -90 + -30 = -120
 *   → riskScore = clamp(100 + (-120), 0, 100) = 0
 *   → impact final sur SmartScore = 0 × 0.10 = 0 pts (sur 10 possibles)
 */
export function computeRiskScore(risks: RiskItem[]): {
  riskScore: number;
  riskPenaltyRaw: number;
  riskDetails: RiskDetail[];
} {
  const riskDetails: RiskDetail[] = risks.map((risk) => {
    const weight = getRiskWeight(risk.key);
    const penalty = RISK_LEVEL_PENALTY[risk.level] ?? 0;
    const impact = penalty * weight;

    return {
      key: risk.key,
      level: risk.level,
      weight,
      penalty,
      impact,
    };
  });

  const riskPenaltyRaw = riskDetails.reduce((sum, d) => sum + d.impact, 0);
  const riskScore = clamp(100 + riskPenaltyRaw, 0, 100);

  return { riskScore, riskPenaltyRaw, riskDetails };
}

/**
 * Calcule le SmartScore final intégrant les risques.
 *
 * @param base — SmartScore existant (market, faisabilité, localisation, finance)
 * @param risks — Tableau normalisé de risques (Risk Engine)
 * @returns SmartScoreWithRisk complet, prêt pour affichage et comité
 *
 * ⚠️ Les scores existants (market, finance, etc.) ne sont JAMAIS modifiés.
 *    Seul le riskScore est calculé puis intégré via la pondération globale.
 */
export function computeSmartScoreWithRisk(
  base: SmartScoreBase,
  risks: RiskItem[]
): SmartScoreWithRisk {
  const { riskScore, riskPenaltyRaw, riskDetails } = computeRiskScore(risks);

  // Calcul pondéré — chaque composante contribue selon son poids stratégique
  const totalScore = Math.round(
    base.breakdown.market * SMARTSCORE_WEIGHTS.market +
    base.breakdown.faisabilite * SMARTSCORE_WEIGHTS.faisabilite +
    base.breakdown.localisation * SMARTSCORE_WEIGHTS.localisation +
    base.breakdown.finance * SMARTSCORE_WEIGHTS.finance +
    riskScore * SMARTSCORE_WEIGHTS.risques
  );

  return {
    totalScore: clamp(totalScore, 0, 100),
    riskScore,
    riskPenaltyRaw,
    breakdown: {
      market: base.breakdown.market,
      faisabilite: base.breakdown.faisabilite,
      localisation: base.breakdown.localisation,
      finance: base.breakdown.finance,
      risques: riskScore,
    },
    riskDetails,
  };
}

// ---------------------------------------------------------------------------
// 5. EXPORTS SECONDAIRES (utiles pour tests & debug)
// ---------------------------------------------------------------------------

export {
  RISK_LEVEL_PENALTY,
  RISK_WEIGHTS,
  SMARTSCORE_WEIGHTS,
  EXPECTED_RISK_COUNT,
};