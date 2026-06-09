// ============================================================================
// SMARTSCORE V4 — PHASE 3B : Comparaison Multi-Sites
// ============================================================================
// Compare 2 à 5 sites/parcelles côte à côte.
// Produit les données pour un radar chart comparatif.
// ============================================================================

import type { SmartScorePillar } from "./smartscore_weights_v4.ts";

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────

export type SiteAnalysis = {
  id: string;                             // ID unique du site
  label: string;                          // "135 rue d'Alésia", "Parcelle 92001-AB-0012"
  commune: string | null;
  commune_insee: string | null;
  lat: number;
  lon: number;
  zone_type: "rural" | "urbain";
  score_global: number;
  pillar_scores: Record<SmartScorePillar, number | null>;
  // KPIs clés pour tableau comparatif
  prix_median_m2: number | null;
  transactions_count: number | null;
  rendement_brut_pct: number | null;
  liquidite_score: number | null;
  tendance_pct_an: number | null;
  pharmacie_km: number | null;
  commerce_km: number | null;
  medecin_km: number | null;
  hopital_km: number | null;
  population: number | null;
  pct_plus_65: number | null;
};

export type ComparisonResult = {
  sites: SiteAnalysis[];
  // Classement
  ranking: Array<{ id: string; label: string; score: number; rank: number }>;
  // Données radar chart (piliers normalisés 0-100)
  radar_data: RadarChartData;
  // Synthèse
  best_site: { id: string; label: string; score: number };
  worst_site: { id: string; label: string; score: number };
  delta_score: number;                    // Écart max-min
  // Avantages distinctifs par site
  site_advantages: Record<string, string[]>;
  // Tableau comparatif
  comparison_table: ComparisonRow[];
};

export type RadarChartData = {
  axes: Array<{
    pillar: SmartScorePillar;
    label: string;
    max: number;
  }>;
  series: Array<{
    id: string;
    label: string;
    color: string;
    values: Array<{
      pillar: SmartScorePillar;
      value: number;
    }>;
  }>;
};

export type ComparisonRow = {
  metric: string;
  unit: string;
  values: Record<string, string | number | null>;  // site_id → valeur
  best_site_id: string | null;                      // Site avec la meilleure valeur
  direction: "higher_better" | "lower_better" | "neutral";
};

// ────────────────────────────────────────────────────────────────────────────
// COULEURS POUR SÉRIES
// ────────────────────────────────────────────────────────────────────────────

const SERIES_COLORS = [
  "#5247b8",  // Violet Mimmoza
  "#06b6d4",  // Cyan
  "#f59e0b",  // Amber
  "#ef4444",  // Rouge
  "#22c55e",  // Vert
];

// ────────────────────────────────────────────────────────────────────────────
// RADAR CHART DATA BUILDER
// ────────────────────────────────────────────────────────────────────────────

const PILLAR_LABELS_FR: Record<SmartScorePillar, string> = {
  transport: "Transports",
  commodites: "Commodités",
  ecoles: "Écoles",
  marche: "Marché",
  sante: "Santé",
  essential_services: "Services",
  environnement: "Environnement",
  concurrence: "Concurrence",
  demographie: "Démographie",
};

function buildRadarData(sites: SiteAnalysis[]): RadarChartData {
  // Déterminer les piliers qui ont au moins une valeur
  const activePillars: SmartScorePillar[] = [];

  for (const pillar of Object.keys(PILLAR_LABELS_FR) as SmartScorePillar[]) {
    const hasValue = sites.some(s => s.pillar_scores[pillar] != null);
    if (hasValue) activePillars.push(pillar);
  }

  const axes = activePillars.map(pillar => ({
    pillar,
    label: PILLAR_LABELS_FR[pillar],
    max: 100,
  }));

  const series = sites.map((site, idx) => ({
    id: site.id,
    label: site.label,
    color: SERIES_COLORS[idx % SERIES_COLORS.length],
    values: activePillars.map(pillar => ({
      pillar,
      value: site.pillar_scores[pillar] ?? 0,
    })),
  }));

  return { axes, series };
}

// ────────────────────────────────────────────────────────────────────────────
// TABLEAU COMPARATIF
// ────────────────────────────────────────────────────────────────────────────

function buildComparisonTable(sites: SiteAnalysis[]): ComparisonRow[] {
  const rows: ComparisonRow[] = [];

  const addRow = (
    metric: string,
    unit: string,
    getter: (s: SiteAnalysis) => number | null,
    direction: "higher_better" | "lower_better" | "neutral",
    formatter?: (v: number) => string,
  ) => {
    const values: Record<string, string | number | null> = {};
    let bestId: string | null = null;
    let bestVal: number | null = null;

    for (const site of sites) {
      const v = getter(site);
      values[site.id] = v != null
        ? (formatter ? formatter(v) : v)
        : null;

      if (v != null) {
        if (bestVal == null ||
          (direction === "higher_better" && v > bestVal) ||
          (direction === "lower_better" && v < bestVal)
        ) {
          bestVal = v;
          bestId = site.id;
        }
      }
    }

    rows.push({ metric, unit, values, best_site_id: bestId, direction });
  };

  addRow("Score global", "/100", s => s.score_global, "higher_better");
  addRow("Prix médian", "€/m²", s => s.prix_median_m2, "neutral", v => v.toLocaleString("fr-FR"));
  addRow("Transactions", "nb", s => s.transactions_count, "higher_better");
  addRow("Rendement brut", "%", s => s.rendement_brut_pct, "higher_better");
  addRow("Liquidité", "/100", s => s.liquidite_score, "higher_better");
  addRow("Tendance prix", "%/an", s => s.tendance_pct_an, "higher_better", v => (v > 0 ? "+" : "") + v.toString());
  addRow("Pharmacie", "km", s => s.pharmacie_km, "lower_better");
  addRow("Commerce", "km", s => s.commerce_km, "lower_better");
  addRow("Médecin", "km", s => s.medecin_km, "lower_better");
  addRow("Hôpital", "km", s => s.hopital_km, "lower_better");
  addRow("Population", "hab.", s => s.population, "neutral", v => v.toLocaleString("fr-FR"));
  addRow("65 ans et +", "%", s => s.pct_plus_65, "neutral");

  return rows;
}

// ────────────────────────────────────────────────────────────────────────────
// AVANTAGES DISTINCTIFS
// ────────────────────────────────────────────────────────────────────────────

function findSiteAdvantages(sites: SiteAnalysis[]): Record<string, string[]> {
  const advantages: Record<string, string[]> = {};
  for (const site of sites) advantages[site.id] = [];

  if (sites.length < 2) return advantages;

  // Pour chaque pilier, identifier le meilleur site
  for (const pillar of Object.keys(PILLAR_LABELS_FR) as SmartScorePillar[]) {
    let bestId: string | null = null;
    let bestScore = -1;
    let secondScore = -1;

    for (const site of sites) {
      const score = site.pillar_scores[pillar];
      if (score != null && score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestId = site.id;
      } else if (score != null && score > secondScore) {
        secondScore = score;
      }
    }

    // Avantage significatif si > 15 points d'écart
    if (bestId && bestScore - secondScore >= 15) {
      advantages[bestId].push(
        "Meilleur en " + PILLAR_LABELS_FR[pillar] +
        " (" + bestScore + " vs " + secondScore + ")"
      );
    }
  }

  // Avantages prix
  const prixSites = sites.filter(s => s.prix_median_m2 != null);
  if (prixSites.length >= 2) {
    prixSites.sort((a, b) => (a.prix_median_m2 ?? 0) - (b.prix_median_m2 ?? 0));
    const cheapest = prixSites[0];
    const costliest = prixSites[prixSites.length - 1];
    if (cheapest.prix_median_m2! < costliest.prix_median_m2! * 0.8) {
      advantages[cheapest.id].push(
        "Prix le plus bas (" + cheapest.prix_median_m2!.toLocaleString("fr-FR") + " €/m²)"
      );
    }
  }

  // Avantage rendement
  const rendSites = sites.filter(s => s.rendement_brut_pct != null);
  if (rendSites.length >= 2) {
    rendSites.sort((a, b) => (b.rendement_brut_pct ?? 0) - (a.rendement_brut_pct ?? 0));
    const best = rendSites[0];
    if (best.rendement_brut_pct! > (rendSites[1].rendement_brut_pct ?? 0) * 1.2) {
      advantages[best.id].push(
        "Meilleur rendement (" + best.rendement_brut_pct + "%)"
      );
    }
  }

  return advantages;
}

// ────────────────────────────────────────────────────────────────────────────
// COMPARAISON PRINCIPALE
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compare 2 à 5 sites et produit toutes les données
 * pour le frontend (radar chart, tableau, ranking, avantages).
 */
export function compareSites(sites: SiteAnalysis[]): ComparisonResult {
  if (sites.length < 2) {
    throw new Error("Au moins 2 sites requis pour la comparaison");
  }
  if (sites.length > 5) {
    sites = sites.slice(0, 5);
  }

  // Ranking
  const sorted = [...sites].sort((a, b) => b.score_global - a.score_global);
  const ranking = sorted.map((site, idx) => ({
    id: site.id,
    label: site.label,
    score: site.score_global,
    rank: idx + 1,
  }));

  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  return {
    sites,
    ranking,
    radar_data: buildRadarData(sites),
    best_site: { id: best.id, label: best.label, score: best.score_global },
    worst_site: { id: worst.id, label: worst.label, score: worst.score_global },
    delta_score: best.score_global - worst.score_global,
    site_advantages: findSiteAdvantages(sites),
    comparison_table: buildComparisonTable(sites),
  };
}