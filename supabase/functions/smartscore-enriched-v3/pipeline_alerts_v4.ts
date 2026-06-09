// ============================================================================
// SMARTSCORE V4 — PHASE 3C : Alertes Pipeline
// ============================================================================
// Détecte les changements significatifs de score sur les deals du pipeline
// et génère des alertes exploitables.
//
// Architecture :
//   - Cron job quotidien recalcule les scores des deals actifs
//   - Compare avec le dernier score stocké dans smartscore_history
//   - Si delta > seuil → crée une alerte dans `pipeline_alerts`
//   - Le frontend affiche les alertes dans le Pipeline
// ============================================================================

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertCategory =
  | "score_change"        // Score global a bougé significativement
  | "pillar_change"       // Un pilier spécifique a changé
  | "new_competition"     // Nouveau permis de construire détecté
  | "market_shift"        // Tendance prix inversée
  | "liquidity_drop"      // Liquidité en chute
  | "price_alert"         // Prix dépasse un seuil
  | "demographic_shift";  // Changement démographique notable

export type PipelineAlert = {
  id?: string;
  deal_id: string;
  deal_label: string;
  user_id: string;
  category: AlertCategory;
  severity: AlertSeverity;
  title: string;
  description: string;
  // Données de changement
  previous_value: number | null;
  current_value: number | null;
  delta: number | null;
  delta_pct: number | null;
  pillar?: string;
  // Méta
  created_at?: string;
  read_at?: string | null;
  dismissed_at?: string | null;
  // Action suggérée
  action_label?: string;
  action_route?: string;
};

// ────────────────────────────────────────────────────────────────────────────
// SEUILS D'ALERTE
// ────────────────────────────────────────────────────────────────────────────

const THRESHOLDS = {
  // Score global
  score_change_warning: 8,      // ±8 points → warning
  score_change_critical: 15,    // ±15 points → critical

  // Pilier individuel
  pillar_change_warning: 15,    // ±15 points sur un pilier
  pillar_change_critical: 25,

  // Marché
  price_change_pct_warning: 10,   // ±10% sur le prix médian
  price_change_pct_critical: 20,
  liquidity_drop_threshold: 20,   // Chute de 20 points de liquidité

  // Concurrence
  new_permits_threshold: 3,       // 3+ nouveaux permis → alerte
  new_housing_units_threshold: 50, // 50+ logements concurrents → alerte
};

// ────────────────────────────────────────────────────────────────────────────
// DETECTION DE CHANGEMENTS
// ────────────────────────────────────────────────────────────────────────────

type ScoreSnapshot = {
  score_global: number;
  pillar_scores: Record<string, number | null>;
  dvf_median_m2: number | null;
  dvf_transactions_count: number | null;
  liquidity_score: number | null;
  competition_count: number | null;
  computed_at: string;
};

/**
 * Compare deux snapshots et génère les alertes.
 */
export function detectChanges(
  dealId: string,
  dealLabel: string,
  userId: string,
  previous: ScoreSnapshot,
  current: ScoreSnapshot,
): PipelineAlert[] {
  const alerts: PipelineAlert[] = [];

  // 1. Score global
  const scoreDelta = current.score_global - previous.score_global;
  const scoreAbsDelta = Math.abs(scoreDelta);

  if (scoreAbsDelta >= THRESHOLDS.score_change_critical) {
    alerts.push({
      deal_id: dealId,
      deal_label: dealLabel,
      user_id: userId,
      category: "score_change",
      severity: "critical",
      title: scoreDelta > 0
        ? `Score en forte hausse (+${scoreDelta} pts)`
        : `Score en forte baisse (${scoreDelta} pts)`,
      description: `Le SmartScore de "${dealLabel}" est passé de ${previous.score_global} à ${current.score_global}/100.` +
        (scoreDelta < 0 ? " Vérifier les facteurs de dégradation." : " Conditions de marché améliorées."),
      previous_value: previous.score_global,
      current_value: current.score_global,
      delta: scoreDelta,
      delta_pct: Math.round((scoreDelta / previous.score_global) * 100),
      action_label: "Voir l'analyse",
      action_route: `/investisseur/analyse?deal=${dealId}`,
    });
  } else if (scoreAbsDelta >= THRESHOLDS.score_change_warning) {
    alerts.push({
      deal_id: dealId,
      deal_label: dealLabel,
      user_id: userId,
      category: "score_change",
      severity: "warning",
      title: scoreDelta > 0
        ? `Score en hausse (+${scoreDelta} pts)`
        : `Score en baisse (${scoreDelta} pts)`,
      description: `SmartScore passé de ${previous.score_global} à ${current.score_global}/100.`,
      previous_value: previous.score_global,
      current_value: current.score_global,
      delta: scoreDelta,
      delta_pct: Math.round((scoreDelta / previous.score_global) * 100),
      action_label: "Voir le détail",
      action_route: `/investisseur/analyse?deal=${dealId}`,
    });
  }

  // 2. Piliers individuels
  for (const [pillar, currentScore] of Object.entries(current.pillar_scores)) {
    if (currentScore == null) continue;
    const prevScore = previous.pillar_scores[pillar];
    if (prevScore == null) continue;

    const pillarDelta = currentScore - prevScore;
    const pillarAbsDelta = Math.abs(pillarDelta);

    if (pillarAbsDelta >= THRESHOLDS.pillar_change_critical) {
      alerts.push({
        deal_id: dealId,
        deal_label: dealLabel,
        user_id: userId,
        category: "pillar_change",
        severity: "warning",
        title: `${pillar} : ${pillarDelta > 0 ? "+" : ""}${pillarDelta} pts`,
        description: `Le pilier "${pillar}" a évolué significativement (${prevScore} → ${currentScore}).`,
        previous_value: prevScore,
        current_value: currentScore,
        delta: pillarDelta,
        delta_pct: prevScore > 0 ? Math.round((pillarDelta / prevScore) * 100) : null,
        pillar,
      });
    }
  }

  // 3. Prix médian
  if (previous.dvf_median_m2 != null && current.dvf_median_m2 != null && previous.dvf_median_m2 > 0) {
    const priceDeltaPct = Math.round(
      ((current.dvf_median_m2 - previous.dvf_median_m2) / previous.dvf_median_m2) * 100
    );

    if (Math.abs(priceDeltaPct) >= THRESHOLDS.price_change_pct_critical) {
      alerts.push({
        deal_id: dealId,
        deal_label: dealLabel,
        user_id: userId,
        category: "market_shift",
        severity: "critical",
        title: priceDeltaPct > 0
          ? `Prix en forte hausse (+${priceDeltaPct}%)`
          : `Prix en forte baisse (${priceDeltaPct}%)`,
        description: `Prix médian passé de ${previous.dvf_median_m2.toLocaleString("fr-FR")} à ${current.dvf_median_m2.toLocaleString("fr-FR")} €/m².`,
        previous_value: previous.dvf_median_m2,
        current_value: current.dvf_median_m2,
        delta: current.dvf_median_m2 - previous.dvf_median_m2,
        delta_pct: priceDeltaPct,
        action_label: "Analyser le marché",
      });
    } else if (Math.abs(priceDeltaPct) >= THRESHOLDS.price_change_pct_warning) {
      alerts.push({
        deal_id: dealId,
        deal_label: dealLabel,
        user_id: userId,
        category: "price_alert",
        severity: "info",
        title: `Prix ${priceDeltaPct > 0 ? "en hausse" : "en baisse"} (${priceDeltaPct > 0 ? "+" : ""}${priceDeltaPct}%)`,
        description: `Prix médian : ${current.dvf_median_m2.toLocaleString("fr-FR")} €/m² (était ${previous.dvf_median_m2.toLocaleString("fr-FR")}).`,
        previous_value: previous.dvf_median_m2,
        current_value: current.dvf_median_m2,
        delta: current.dvf_median_m2 - previous.dvf_median_m2,
        delta_pct: priceDeltaPct,
      });
    }
  }

  // 4. Liquidité
  if (previous.liquidity_score != null && current.liquidity_score != null) {
    const liqDelta = current.liquidity_score - previous.liquidity_score;
    if (liqDelta <= -THRESHOLDS.liquidity_drop_threshold) {
      alerts.push({
        deal_id: dealId,
        deal_label: dealLabel,
        user_id: userId,
        category: "liquidity_drop",
        severity: "warning",
        title: `Liquidité en baisse (${liqDelta} pts)`,
        description: `Le marché se raréfie. Score de liquidité : ${current.liquidity_score}/100 (était ${previous.liquidity_score}).`,
        previous_value: previous.liquidity_score,
        current_value: current.liquidity_score,
        delta: liqDelta,
        delta_pct: null,
      });
    }
  }

  // 5. Concurrence
  if (previous.competition_count != null && current.competition_count != null) {
    const newPermits = current.competition_count - previous.competition_count;
    if (newPermits >= THRESHOLDS.new_permits_threshold) {
      alerts.push({
        deal_id: dealId,
        deal_label: dealLabel,
        user_id: userId,
        category: "new_competition",
        severity: "warning",
        title: `${newPermits} nouveaux permis détectés`,
        description: `${newPermits} nouveaux permis de construire dans le périmètre. Total : ${current.competition_count} projets concurrents.`,
        previous_value: previous.competition_count,
        current_value: current.competition_count,
        delta: newPermits,
        delta_pct: null,
        action_label: "Voir la concurrence",
      });
    }
  }

  return alerts;
}


// ────────────────────────────────────────────────────────────────────────────
// HELPERS POUR LE FRONTEND
// ────────────────────────────────────────────────────────────────────────────

/**
 * Groupe les alertes par deal pour l'affichage Pipeline.
 */
export function groupAlertsByDeal(
  alerts: PipelineAlert[],
): Record<string, { deal_label: string; alerts: PipelineAlert[]; max_severity: AlertSeverity }> {
  const grouped: Record<string, { deal_label: string; alerts: PipelineAlert[]; max_severity: AlertSeverity }> = {};

  for (const alert of alerts) {
    if (!grouped[alert.deal_id]) {
      grouped[alert.deal_id] = {
        deal_label: alert.deal_label,
        alerts: [],
        max_severity: "info",
      };
    }
    grouped[alert.deal_id].alerts.push(alert);

    // Max severity
    const current = grouped[alert.deal_id].max_severity;
    if (alert.severity === "critical" || (alert.severity === "warning" && current === "info")) {
      grouped[alert.deal_id].max_severity = alert.severity;
    }
  }

  return grouped;
}

/**
 * Compte les alertes non lues par severity.
 */
export function countUnreadAlerts(
  alerts: PipelineAlert[],
): { total: number; critical: number; warning: number; info: number } {
  const unread = alerts.filter(a => !a.read_at && !a.dismissed_at);
  return {
    total: unread.length,
    critical: unread.filter(a => a.severity === "critical").length,
    warning: unread.filter(a => a.severity === "warning").length,
    info: unread.filter(a => a.severity === "info").length,
  };
}