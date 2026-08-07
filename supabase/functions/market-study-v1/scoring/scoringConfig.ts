import type { ProjectType, SubscoreKey } from "../types/market.types.ts";

export type ScoringProfile = {
  weights: Partial<Record<SubscoreKey, number>>;
  blocking_missing: string[]; // field paths
  verdict: Array<{ min: number; label: string }>;
};

export const SCORING_VERSION = "mscore_v1.0.0";

export const DEFAULT_RADIUS_BY_PROJECT: Record<ProjectType, number> = {
  LOGEMENT: 5,
  COMMERCE: 3,
  BUREAUX: 5,
  HOTEL: 20,
  ETUDIANT: 5,
  RSS: 10,
  EHPAD: 20,
};

export const SCORING_PROFILES: Record<ProjectType, ScoringProfile> = {
  LOGEMENT: {
    weights: { demographie: 0.30, marche_prix: 0.30, commodites: 0.40, transport: 0.00 },
    blocking_missing: [],
    verdict: [
      { min: 75, label: "GO — Zone attractive pour un projet résidentiel" },
      { min: 55, label: "GO avec réserves — Potentiel à confirmer" },
      { min: 0, label: "NO GO — Zone peu adaptée" },
    ],
  },

  COMMERCE: {
    weights: { demographie: 0.40, commodites: 0.40, concurrence: 0.20, transport: 0.00 },
    blocking_missing: [],
    verdict: [
      { min: 75, label: "GO — Zone favorable pour un commerce" },
      { min: 55, label: "GO avec réserves — Étude de chalandise recommandée" },
      { min: 0, label: "NO GO — Zone peu adaptée à un commerce" },
    ],
  },

  BUREAUX: {
    // transport important si disponible, mais jamais bloquant
    weights: { economie: 0.35, commodites: 0.30, marche_prix: 0.20, transport: 0.15 },
    blocking_missing: [],
    verdict: [
      { min: 75, label: "GO — Zone favorable pour un projet de bureaux" },
      { min: 55, label: "GO avec réserves — Signaux mixtes" },
      { min: 0, label: "NO GO — Accessibilité / environnement insuffisants" },
    ],
  },

  HOTEL: {
    // tourisme/transport peuvent manquer => score proxy (insights + completeness le signalent)
    weights: { economie: 0.40, commodites: 0.25, concurrence: 0.20, transport: 0.15, tourisme: 0.00 },
    blocking_missing: [],
    verdict: [
      { min: 75, label: "GO — Zone favorable pour un projet hôtelier" },
      { min: 55, label: "À approfondir — Étude de marché hôtelière recommandée" },
      { min: 0, label: "NO GO — Zone peu favorable à l’hôtellerie" },
    ],
  },

  ETUDIANT: {
    // Étude faisable même si segments jeunes / transport indisponibles.
    // Le score sera partiel et les insights signaleront les manques.
    weights: { commodites: 0.45, marche_prix: 0.35, demographie: 0.20, transport: 0.00 },
    blocking_missing: [],
    verdict: [
      { min: 75, label: "GO — Zone favorable pour une résidence étudiante" },
      { min: 55, label: "GO avec réserves — Analyse complémentaire recommandée" },
      { min: 40, label: "À approfondir — Données insuffisantes / signaux mixtes" },
      { min: 0, label: "NO GO — Zone peu adaptée à une résidence étudiante" },
    ],
  },

  RSS: {
    // senior: on peut scorer même si %75+ manque (score partiel)
    weights: { demographie: 0.35, health: 0.30, concurrence: 0.20, commodites: 0.15, transport: 0.00 },
    blocking_missing: [],
    verdict: [
      { min: 75, label: "GO — Zone favorable pour une résidence seniors" },
      { min: 55, label: "GO avec réserves — Potentiel à confirmer" },
      { min: 0, label: "NO GO — Zone peu adaptée au senior" },
    ],
  },

  EHPAD: {
    weights: { demographie: 0.35, health: 0.30, concurrence: 0.20, commodites: 0.15, transport: 0.00 },
    blocking_missing: [],
    verdict: [
      { min: 75, label: "GO — Zone favorable pour un EHPAD" },
      { min: 55, label: "GO avec réserves — Étude approfondie recommandée" },
      { min: 0, label: "NO GO — Zone peu adaptée à un EHPAD" },
    ],
  },
};
