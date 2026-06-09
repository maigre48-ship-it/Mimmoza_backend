// ============================================================================
// SMARTSCORE V4 — PHASE 3A : Pondération Utilisateur (Sliders)
// ============================================================================
// Permet à chaque utilisateur d'ajuster les poids des piliers via sliders.
// Le score se recalcule en temps réel côté client.
//
// Architecture :
//   - Les presets par nature de projet restent le DEFAULT
//   - L'utilisateur peut override via sliders
//   - Les poids custom sont persistés dans Supabase (par user + espace)
//   - Le frontend envoie les poids custom, le backend les applique
// ============================================================================

import type { SmartScorePillar } from "./smartscore_weights_v4.ts";

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────

/**
 * Configuration de slider pour un pilier.
 * Le frontend affiche un slider par pilier actif.
 */
export type PillarSliderConfig = {
  pillar: SmartScorePillar;
  label_fr: string;
  description_fr: string;
  icon: string;           // Lucide icon name
  min: number;            // Poids min (0)
  max: number;            // Poids max (50)
  step: number;           // Pas du slider
  default_value: number;  // Poids par défaut (du preset)
  user_value: number;     // Poids choisi par l'utilisateur
  enabled: boolean;       // Pilier implémenté et activé
  color: string;          // Couleur du pilier pour le radar chart
};

/**
 * Profil de pondération utilisateur persisté.
 */
export type UserWeightsProfile = {
  id?: string;
  user_id: string;
  space: "promoteur" | "investisseur" | "banque";
  project_nature: string;
  label: string;                           // "Mon profil EHPAD", etc.
  weights: Record<SmartScorePillar, number>;
  is_default: boolean;
  created_at?: string;
  updated_at?: string;
};

// ────────────────────────────────────────────────────────────────────────────
// SLIDER CONFIG PAR PILIER
// ────────────────────────────────────────────────────────────────────────────

const PILLAR_META: Record<SmartScorePillar, {
  label_fr: string;
  description_fr: string;
  icon: string;
  color: string;
}> = {
  transport: {
    label_fr: "Transports",
    description_fr: "Accessibilité transports en commun (métro) ou services quotidiens (rural)",
    icon: "Train",
    color: "#3b82f6",
  },
  commodites: {
    label_fr: "Commodités",
    description_fr: "Densité d'équipements à proximité (BPE)",
    icon: "ShoppingBag",
    color: "#8b5cf6",
  },
  ecoles: {
    label_fr: "Écoles",
    description_fr: "Proximité et densité d'établissements scolaires",
    icon: "GraduationCap",
    color: "#f59e0b",
  },
  marche: {
    label_fr: "Marché",
    description_fr: "Dynamisme immobilier : prix, tendance, liquidité, rendement",
    icon: "TrendingUp",
    color: "#10b981",
  },
  sante: {
    label_fr: "Santé",
    description_fr: "Professionnels de santé, hôpital, densité médicale",
    icon: "Heart",
    color: "#ef4444",
  },
  essential_services: {
    label_fr: "Services essentiels",
    description_fr: "Pharmacie, commerce alimentaire, médecin, poste, banque",
    icon: "MapPin",
    color: "#06b6d4",
  },
  environnement: {
    label_fr: "Environnement",
    description_fr: "Risques naturels, DPE quartier, qualité de l'air, bruit",
    icon: "Leaf",
    color: "#22c55e",
  },
  concurrence: {
    label_fr: "Concurrence",
    description_fr: "Permis de construire concurrents dans le rayon (Sitadel)",
    icon: "Building2",
    color: "#f97316",
  },
  demographie: {
    label_fr: "Démographie",
    description_fr: "Tendance population, vieillissement, projections",
    icon: "Users",
    color: "#a855f7",
  },
};

/**
 * Génère la config des sliders pour un profil de projet.
 */
export function buildSliderConfigs(
  defaultWeights: Record<SmartScorePillar, number>,
  userWeights: Record<SmartScorePillar, number> | null,
  implementedPillars: Set<SmartScorePillar>,
): PillarSliderConfig[] {
  const configs: PillarSliderConfig[] = [];

  for (const [pillar, defaultValue] of Object.entries(defaultWeights) as Array<[SmartScorePillar, number]>) {
    const meta = PILLAR_META[pillar];
    if (!meta) continue;

    const enabled = implementedPillars.has(pillar);
    const userValue = userWeights?.[pillar] ?? defaultValue;

    configs.push({
      pillar,
      label_fr: meta.label_fr,
      description_fr: meta.description_fr,
      icon: meta.icon,
      min: 0,
      max: 50,
      step: 5,
      default_value: defaultValue,
      user_value: enabled ? userValue : 0,
      enabled,
      color: meta.color,
    });
  }

  // Trier : piliers actifs en premier, puis par poids décroissant
  configs.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return b.user_value - a.user_value;
  });

  return configs;
}

/**
 * Normalise les poids utilisateur pour qu'ils somment à 100.
 * Appelé après chaque modification de slider.
 */
export function normalizeUserWeights(
  rawWeights: Record<SmartScorePillar, number>,
  implementedPillars: Set<SmartScorePillar>,
): Record<SmartScorePillar, number> {
  const result: Record<SmartScorePillar, number> = { ...rawWeights };

  // Mettre à 0 les piliers non implémentés
  for (const pillar of Object.keys(result) as SmartScorePillar[]) {
    if (!implementedPillars.has(pillar)) {
      result[pillar] = 0;
    }
  }

  // Somme des poids actifs
  const total = Object.values(result).reduce((sum, w) => sum + w, 0);

  if (total === 0) return result;

  // Normaliser à 100
  const scale = 100 / total;
  for (const pillar of Object.keys(result) as SmartScorePillar[]) {
    result[pillar] = Math.round(result[pillar] * scale * 10) / 10;
  }

  return result;
}

/**
 * Recalcule le SmartScore avec les poids custom utilisateur.
 * Utilisé côté client pour le recalcul temps réel.
 */
export function recalculateWithUserWeights(
  pillarScores: Record<SmartScorePillar, number | null>,
  userWeights: Record<SmartScorePillar, number>,
): { score: number; contributionByPillar: Record<SmartScorePillar, number> } {
  let totalWeight = 0;
  let totalScore = 0;
  const contributions: Record<string, number> = {};

  for (const [pillar, weight] of Object.entries(userWeights) as Array<[SmartScorePillar, number]>) {
    if (weight <= 0) continue;
    const score = pillarScores[pillar];
    if (score == null) continue;

    totalWeight += weight;
    const contribution = score * weight;
    totalScore += contribution;
    contributions[pillar] = Math.round(contribution / 100); // Contribution en points
  }

  const finalScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 50;

  return {
    score: finalScore,
    contributionByPillar: contributions as Record<SmartScorePillar, number>,
  };
}


// ────────────────────────────────────────────────────────────────────────────
// PRESETS PAR ESPACE
// ────────────────────────────────────────────────────────────────────────────

/**
 * Presets de pondération par espace Mimmoza.
 * L'investisseur surpondère le marché, le banquier le risque, etc.
 */
export const SPACE_PRESETS: Record<string, Partial<Record<SmartScorePillar, number>>> = {
  promoteur: {
    marche: 25,
    concurrence: 20,
    transport: 15,
    essential_services: 15,
    environnement: 10,
    ecoles: 10,
    demographie: 5,
  },
  investisseur: {
    marche: 35,           // Rendement et liquidité dominent
    essential_services: 15,
    transport: 15,
    environnement: 10,
    sante: 5,
    ecoles: 10,
    commodites: 10,
  },
  banque: {
    environnement: 25,    // Risques = priorité banque
    marche: 25,
    essential_services: 15,
    transport: 10,
    concurrence: 10,
    demographie: 10,
    sante: 5,
  },
};

/**
 * Applique un preset espace sur les poids par nature de projet.
 * Le preset espace modifie les poids de ±30% par rapport au preset nature.
 */
export function applySpacePreset(
  natureWeights: Record<SmartScorePillar, number>,
  space: string,
  blendRatio: number = 0.3, // 30% espace, 70% nature
): Record<SmartScorePillar, number> {
  const spacePreset = SPACE_PRESETS[space.toLowerCase()];
  if (!spacePreset) return { ...natureWeights };

  const result: Record<SmartScorePillar, number> = { ...natureWeights };

  for (const [pillar, spaceWeight] of Object.entries(spacePreset) as Array<[SmartScorePillar, number]>) {
    const natureWeight = natureWeights[pillar] ?? 0;
    result[pillar] = Math.round((natureWeight * (1 - blendRatio) + spaceWeight * blendRatio) * 10) / 10;
  }

  return result;
}