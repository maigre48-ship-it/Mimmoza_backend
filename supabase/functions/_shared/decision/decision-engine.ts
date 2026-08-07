// ============================================================================
// decision-engine.ts — Moteur de décision GO / NO GO (comité crédit)
// Pure logique déterministe, sans IA, sans dépendances externes.
// ============================================================================

// ---------------------------------------------------------------------------
// CONSTANTES MÉTIER
// ---------------------------------------------------------------------------

/** Score minimum pour un GO sans réserves */
const GO_MIN_SCORE = 75;

/** Score maximum pour un NO_GO automatique */
const NO_GO_MAX_SCORE = 59;

/** Bande de score déclenchant GO_AVEC_RESERVES */
const RESERVE_BAND: [number, number] = [60, 74];

/** Base du score de confiance déterministe */
const CONFIDENCE_BASE = 85;

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export type RiskLevel = "faible" | "moyen" | "fort" | "inconnu" | "non_concerne";

export type RiskDetail = {
  key: string;
  level: RiskLevel;
  weight: number;
  penalty: number;
  impact: number;
};

export type ScoreBreakdown = {
  market: number;
  faisabilite: number;
  localisation: number;
  finance: number;
  risques: number;
};

export type DecisionInput = {
  smartScore: {
    totalScore: number;
    riskScore: number;
    riskPenaltyRaw: number;
    breakdown: ScoreBreakdown;
    riskDetails: RiskDetail[];
  };
};

export type Decision = "GO" | "GO_AVEC_RESERVES" | "NO_GO";

export type DecisionReasonSeverity = "info" | "warning" | "critical";

export type DecisionReason = {
  code: string;
  label: string;
  severity: DecisionReasonSeverity;
  details?: string;
  related?: {
    module?: "market" | "faisabilite" | "localisation" | "finance" | "risques";
    riskKey?: string;
  };
};

export type DecisionOutput = {
  decision: Decision;
  confidence: number;
  summary: string;
  reasons: DecisionReason[];
  conditions: string[];
  redFlags: string[];
  thresholds: {
    goMinScore: number;
    noGoMaxScore: number;
    reserveBand: [number, number];
  };
};

// ---------------------------------------------------------------------------
// HELPERS PURS
// ---------------------------------------------------------------------------

/** Clamp une valeur entre min et max */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Ordre de sévérité pour le tri (critical en premier) */
const SEVERITY_ORDER: Record<DecisionReasonSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Trie les raisons par sévérité (critical → warning → info) */
function sortReasons(reasons: DecisionReason[]): DecisionReason[] {
  return [...reasons].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// ---------------------------------------------------------------------------
// DÉTECTION RED FLAGS
// ---------------------------------------------------------------------------

type RedFlagResult = {
  criticalFlags: string[];
  nonCriticalFlags: string[];
  reasons: DecisionReason[];
  conditions: string[];
};

function detectRedFlags(input: DecisionInput): RedFlagResult {
  const { totalScore, riskScore, breakdown, riskDetails } = input.smartScore;

  const criticalFlags: string[] = [];
  const nonCriticalFlags: string[] = [];
  const reasons: DecisionReason[] = [];
  const conditions: string[] = [];

  // --- RED FLAGS CRITIQUES ---

  // 1. Au moins 2 risques fort avec weight=3
  const highWeightedRisks = riskDetails.filter(
    (r) => r.level === "fort" && r.weight === 3
  );
  if (highWeightedRisks.length >= 2) {
    const riskKeys = highWeightedRisks.map((r) => r.key).join(", ");
    criticalFlags.push(
      `${highWeightedRisks.length} risques majeurs (poids 3) identifiés : ${riskKeys}.`
    );
    reasons.push({
      code: "MULTI_HIGH_RISKS",
      label: "Cumul de risques majeurs bloquants",
      severity: "critical",
      details: `${highWeightedRisks.length} risques de niveau fort avec pondération maximale (${riskKeys}). Exposition trop élevée.`,
      related: { module: "risques" },
    });
    for (const r of highWeightedRisks) {
      conditions.push(buildConditionForRisk(r.key, "fort"));
    }
  }

  // 2. riskScore < 55
  if (riskScore < 55) {
    criticalFlags.push(
      `Score de risque global insuffisant (${riskScore}/100, seuil critique : 55).`
    );
    reasons.push({
      code: "RISK_SCORE_CRITICAL",
      label: "Score de risque global trop bas",
      severity: "critical",
      details: `Le score de risque agrégé (${riskScore}/100) est inférieur au seuil de 55, indiquant une exposition globale inacceptable.`,
      related: { module: "risques" },
    });
    conditions.push(
      "Revoir l'ensemble du profil de risque et produire un plan de mitigation détaillé avant réexamen."
    );
  }

  // 3. breakdown.faisabilite < 45
  if (breakdown.faisabilite < 45) {
    criticalFlags.push(
      `Faisabilité réglementaire insuffisante (${breakdown.faisabilite}/100, seuil : 45).`
    );
    reasons.push({
      code: "FEASIBILITY_CRITICAL",
      label: "Faisabilité réglementaire non confirmée",
      severity: "critical",
      details: `Le score de faisabilité (${breakdown.faisabilite}/100) est en dessous du seuil critique de 45. Le cadre réglementaire est trop incertain.`,
      related: { module: "faisabilite" },
    });
    conditions.push(
      "Confirmer la faisabilité PLU (hauteur/reculs/stationnement) via note réglementaire."
    );
  }

  // --- RED FLAGS NON CRITIQUES ---

  // 1. 1 risque fort avec weight=3 (mais pas ≥2, sinon déjà critique)
  if (highWeightedRisks.length === 1) {
    const r = highWeightedRisks[0];
    nonCriticalFlags.push(
      `1 risque majeur identifié : ${r.key} (niveau fort, poids 3).`
    );
    reasons.push({
      code: `RISK_${r.key.toUpperCase()}_HIGH`,
      label: `Risque ${r.key} de niveau fort`,
      severity: "warning",
      details: `Le risque « ${r.key} » est évalué fort avec un poids de 3. Réserve nécessaire.`,
      related: { module: "risques", riskKey: r.key },
    });
    conditions.push(buildConditionForRisk(r.key, "fort"));
  }

  // 2. ≥ 3 risques moyens avec weight >= 2
  const mediumWeightedRisks = riskDetails.filter(
    (r) => r.level === "moyen" && r.weight >= 2
  );
  if (mediumWeightedRisks.length >= 3) {
    const riskKeys = mediumWeightedRisks.map((r) => r.key).join(", ");
    nonCriticalFlags.push(
      `Cumul de ${mediumWeightedRisks.length} risques moyens significatifs : ${riskKeys}.`
    );
    reasons.push({
      code: "MULTI_MEDIUM_RISKS",
      label: "Cumul de risques moyens significatifs",
      severity: "warning",
      details: `${mediumWeightedRisks.length} risques de niveau moyen avec pondération ≥ 2 (${riskKeys}). Vigilance accrue recommandée.`,
      related: { module: "risques" },
    });
    for (const r of mediumWeightedRisks) {
      conditions.push(buildConditionForRisk(r.key, "moyen"));
    }
  }

  // 3. breakdown.finance < 50
  if (breakdown.finance < 50) {
    nonCriticalFlags.push(
      `Score financier faible (${breakdown.finance}/100, seuil : 50).`
    );
    reasons.push({
      code: "FINANCE_WEAK",
      label: "Indicateurs financiers insuffisants",
      severity: "warning",
      details: `Le score financier (${breakdown.finance}/100) est inférieur au seuil de 50. Plan de financement à consolider.`,
      related: { module: "finance" },
    });
    conditions.push(
      "Sécuriser le plan de financement : marge, aléas, contingence."
    );
  }

  // 4. breakdown.market < 50
  if (breakdown.market < 50) {
    nonCriticalFlags.push(
      `Score marché faible (${breakdown.market}/100, seuil : 50).`
    );
    reasons.push({
      code: "MARKET_WEAK",
      label: "Conditions de marché défavorables",
      severity: "warning",
      details: `Le score marché (${breakdown.market}/100) est inférieur au seuil de 50. Risque de commercialisation accru.`,
      related: { module: "market" },
    });
    conditions.push(
      "Compléter l'étude de marché et confirmer le potentiel de commercialisation."
    );
  }

  // 5. Risques inconnus avec poids ≥ 2
  const unknownRisks = riskDetails.filter(
    (r) => r.level === "inconnu" && r.weight >= 2
  );
  if (unknownRisks.length > 0) {
    const riskKeys = unknownRisks.map((r) => r.key).join(", ");
    nonCriticalFlags.push(
      `${unknownRisks.length} risque(s) non évalué(s) avec poids significatif : ${riskKeys}.`
    );
    reasons.push({
      code: "UNKNOWN_RISKS",
      label: "Données manquantes sur certains risques",
      severity: "warning",
      details: `Les risques suivants n'ont pas pu être évalués : ${riskKeys}. Compléments d'information requis.`,
      related: { module: "risques" },
    });
    for (const r of unknownRisks) {
      conditions.push(
        `Compléter les données manquantes sur le risque « ${r.key} » (niveau actuellement inconnu).`
      );
    }
  }

  return { criticalFlags, nonCriticalFlags, reasons, conditions };
}

// ---------------------------------------------------------------------------
// CONDITIONS STANDARDISÉES PAR TYPE DE RISQUE
// ---------------------------------------------------------------------------

/** Génère une condition actionnable en fonction de la clé de risque et du niveau */
function buildConditionForRisk(key: string, level: "fort" | "moyen"): string {
  const prefix = level === "fort" ? "Obligatoire : " : "Recommandé : ";

  const conditionsMap: Record<string, string> = {
    flood:
      "Produire une étude hydraulique / PPRI et chiffrer les surcoûts liés au risque inondation.",
    inondation:
      "Produire une étude hydraulique / PPRI et chiffrer les surcoûts liés au risque inondation.",
    pollution:
      "Réaliser un diagnostic pollution des sols + définir une stratégie de dépollution chiffrée.",
    seisme:
      "Réaliser une étude sismique et intégrer les surcoûts de construction parasismique.",
    argile:
      "Produire une étude géotechnique (retrait-gonflement des argiles) et adapter les fondations.",
    radon:
      "Réaliser une mesure de radon et prévoir les dispositifs de ventilation nécessaires.",
    technologique:
      "Évaluer l'exposition au risque technologique (SEVESO/ICPE) et les contraintes associées.",
    bruit:
      "Réaliser une étude acoustique et chiffrer les mesures d'isolation phonique.",
    plu:
      "Confirmer la faisabilité PLU (hauteur/reculs/stationnement) via note réglementaire.",
    reglementaire:
      "Confirmer la conformité réglementaire via un avis urbanisme ou une note juridique.",
  };

  const condition =
    conditionsMap[key.toLowerCase()] ??
    `Approfondir l'analyse du risque « ${key} » et produire un rapport d'évaluation.`;

  return prefix + condition;
}

// ---------------------------------------------------------------------------
// SCORE DE CONFIANCE (DÉTERMINISTE)
// ---------------------------------------------------------------------------

function computeConfidence(input: DecisionInput, hasNonCriticalFlag: boolean): number {
  const { totalScore, riskScore, riskDetails } = input.smartScore;

  let confidence = CONFIDENCE_BASE;

  // -10 si score dans la bande réserves (60–74)
  if (totalScore >= RESERVE_BAND[0] && totalScore <= RESERVE_BAND[1]) {
    confidence -= 10;
  }

  // -15 si riskScore < 60
  if (riskScore < 60) {
    confidence -= 15;
  }

  // -5 par risque inconnu avec weight >= 2 (cap -20)
  const unknownHighWeight = riskDetails.filter(
    (r) => r.level === "inconnu" && r.weight >= 2
  );
  const unknownPenalty = Math.min(unknownHighWeight.length * 5, 20);
  confidence -= unknownPenalty;

  // -10 si red flag non critique présent
  if (hasNonCriticalFlag) {
    confidence -= 10;
  }

  return clamp(confidence, 0, 100);
}

// ---------------------------------------------------------------------------
// GÉNÉRATION DU RÉSUMÉ (1 phrase, lisible comité)
// ---------------------------------------------------------------------------

function buildSummary(
  decision: Decision,
  totalScore: number,
  criticalCount: number,
  reserveCount: number
): string {
  switch (decision) {
    case "GO":
      return `Avis favorable : le projet obtient un score de ${totalScore}/100 sans point bloquant identifié.`;
    case "GO_AVEC_RESERVES":
      return `Avis favorable sous réserves (${reserveCount} point(s) de vigilance) : score de ${totalScore}/100.`;
    case "NO_GO":
      return `Avis défavorable : score de ${totalScore}/100 avec ${criticalCount} point(s) bloquant(s).`;
  }
}

// ---------------------------------------------------------------------------
// MOTIFS INFORMATIFS (score global, breakdown)
// ---------------------------------------------------------------------------

function buildInfoReasons(input: DecisionInput): DecisionReason[] {
  const { totalScore, riskScore, breakdown } = input.smartScore;
  const reasons: DecisionReason[] = [];

  // Score global
  if (totalScore >= GO_MIN_SCORE) {
    reasons.push({
      code: "SCORE_HIGH",
      label: `Score global solide (${totalScore}/100)`,
      severity: "info",
      details: `Le SmartScore total de ${totalScore}/100 dépasse le seuil GO de ${GO_MIN_SCORE}.`,
    });
  } else if (totalScore >= RESERVE_BAND[0]) {
    reasons.push({
      code: "SCORE_RESERVE_BAND",
      label: `Score global en zone de vigilance (${totalScore}/100)`,
      severity: "warning",
      details: `Le SmartScore total de ${totalScore}/100 se situe dans la bande de réserves (${RESERVE_BAND[0]}–${RESERVE_BAND[1]}).`,
    });
  } else {
    reasons.push({
      code: "SCORE_LOW",
      label: `Score global insuffisant (${totalScore}/100)`,
      severity: "critical",
      details: `Le SmartScore total de ${totalScore}/100 est inférieur au seuil NO_GO de ${NO_GO_MAX_SCORE + 1}.`,
    });
  }

  // Localisation info si bon
  if (breakdown.localisation >= 70) {
    reasons.push({
      code: "LOCALISATION_GOOD",
      label: `Localisation favorable (${breakdown.localisation}/100)`,
      severity: "info",
      related: { module: "localisation" },
    });
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// FONCTION PRINCIPALE
// ---------------------------------------------------------------------------

export function computeDecision(input: DecisionInput): DecisionOutput {
  const { totalScore } = input.smartScore;

  // 1. Détecter les red flags
  const flags = detectRedFlags(input);
  const hasCriticalFlag = flags.criticalFlags.length > 0;
  const hasNonCriticalFlag = flags.nonCriticalFlags.length > 0;

  // 2. Déterminer la décision selon les règles métier
  let decision: Decision;

  if (totalScore < RESERVE_BAND[0] || hasCriticalFlag) {
    // NO_GO si score < 60 OU red flag critique
    decision = "NO_GO";
  } else if (totalScore >= GO_MIN_SCORE && !hasCriticalFlag && !hasNonCriticalFlag) {
    // GO si score >= 75 ET aucun red flag
    decision = "GO";
  } else {
    // GO_AVEC_RESERVES : bande 60–74, ou score ≥ 75 mais flags non critiques
    decision = "GO_AVEC_RESERVES";
  }

  // 3. Construire les raisons
  const infoReasons = buildInfoReasons(input);
  const allReasons = sortReasons([...flags.reasons, ...infoReasons]);

  // 4. Dédupliquer les conditions
  const uniqueConditions = [...new Set(flags.conditions)];

  // 5. Score de confiance
  const confidence = computeConfidence(input, hasNonCriticalFlag);

  // 6. Résumé
  const summary = buildSummary(
    decision,
    totalScore,
    flags.criticalFlags.length,
    flags.nonCriticalFlags.length
  );

  return {
    decision,
    confidence,
    summary,
    reasons: allReasons,
    conditions: uniqueConditions,
    redFlags: [...flags.criticalFlags, ...flags.nonCriticalFlags],
    thresholds: {
      goMinScore: GO_MIN_SCORE,
      noGoMaxScore: NO_GO_MAX_SCORE,
      reserveBand: RESERVE_BAND,
    },
  };
}