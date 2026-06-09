// ============================================================================
// SMARTSCORE V4 — PHASE 2B-2 : Signal Démographique
// ============================================================================
// 1. Tendance population (delta 5 ans / 10 ans depuis INSEE RP)
// 2. Projections Omphale par département (2030/2040/2050)
// 3. Indicateurs structurels (vieillissement, ménages, taille)
// ============================================================================

/**
 * Source : INSEE Recensement de la Population (RP)
 * Les données historiques par commune sont dans les fichiers
 * "Populations légales" (base-cc-evol-struct-pop-XXXX.csv)
 *
 * Pour le delta, on compare pop actuelle vs pop N-5 / N-10.
 * Données importables dans une table Supabase `insee_pop_historique`.
 */

export type PopulationTrendResult = {
  score: number;                // 0-100 (100 = forte croissance)
  population_actuelle: number | null;
  delta_5ans_pct: number | null;
  delta_10ans_pct: number | null;
  trend_label: string;
  trend_annuel_pct: number | null;
  // Indicateurs structurels
  pct_plus_65: number | null;
  pct_moins_25: number | null;
  indice_vieillissement: number | null;  // ratio 65+ / -25ans
  taille_menage_moyenne: number | null;
  // Projection
  projection_2030: number | null;
  projection_2040: number | null;
  // Interprétation par nature de projet
  interpretation: string;
};

/**
 * Calcule le signal démographique.
 *
 * @param popActuelle    Population actuelle (INSEE)
 * @param pop5AnsAvant   Population il y a 5 ans (ou null)
 * @param pop10AnsAvant  Population il y a 10 ans (ou null)
 * @param pctPlus65      % de 65+ (INSEE)
 * @param pctMoins25     % de -25 ans (INSEE)
 * @param nbMenages      Nombre de ménages (INSEE)
 * @param projectNature  Nature du projet (pour interprétation)
 * @param projections    Projections Omphale (optionnel)
 */
export function computeDemographicScore(
  popActuelle: number | null,
  pop5AnsAvant: number | null,
  pop10AnsAvant: number | null,
  pctPlus65: number | null,
  pctMoins25: number | null,
  nbMenages: number | null,
  projectNature: string = "logement",
  projections?: { pop_2030?: number; pop_2040?: number },
): PopulationTrendResult {

  // ─── 1. Delta population ───
  let delta_5ans_pct: number | null = null;
  let delta_10ans_pct: number | null = null;
  let trend_annuel_pct: number | null = null;

  if (popActuelle != null && pop5AnsAvant != null && pop5AnsAvant > 0) {
    delta_5ans_pct = Math.round(((popActuelle - pop5AnsAvant) / pop5AnsAvant) * 1000) / 10;
    trend_annuel_pct = Math.round(delta_5ans_pct / 5 * 10) / 10;
  }

  if (popActuelle != null && pop10AnsAvant != null && pop10AnsAvant > 0) {
    delta_10ans_pct = Math.round(((popActuelle - pop10AnsAvant) / pop10AnsAvant) * 1000) / 10;
    // Préférer le trend 10 ans si disponible (plus stable)
    if (trend_annuel_pct == null) {
      trend_annuel_pct = Math.round(delta_10ans_pct / 10 * 10) / 10;
    }
  }

  // ─── 2. Indice de vieillissement ───
  let indice_vieillissement: number | null = null;
  if (pctPlus65 != null && pctMoins25 != null && pctMoins25 > 0) {
    indice_vieillissement = Math.round((pctPlus65 / pctMoins25) * 100) / 100;
  }

  // ─── 3. Taille moyenne des ménages ───
  let taille_menage_moyenne: number | null = null;
  if (popActuelle != null && nbMenages != null && nbMenages > 0) {
    taille_menage_moyenne = Math.round((popActuelle / nbMenages) * 100) / 100;
  }

  // ─── 4. Score brut basé sur la tendance ───
  // Croissance démographique positive = bon signal pour le logement
  // Mais pour l'EHPAD, c'est le vieillissement qui compte
  let scoreBase = 50;
  if (trend_annuel_pct != null) {
    // +1%/an → score 80, 0% → 50, -1%/an → 20
    scoreBase = Math.round(50 + trend_annuel_pct * 30);
    scoreBase = Math.min(100, Math.max(0, scoreBase));
  }

  // ─── 5. Ajustement par nature de projet ───
  const nature = projectNature.toLowerCase();
  let score = scoreBase;
  let interpretation = "";

  if (nature === "ehpad" || nature === "residence_senior") {
    // Pour les seniors : vieillissement = OPPORTUNITÉ
    // On inverse la logique : plus de 65+ = mieux
    if (pctPlus65 != null) {
      const seniorBonus = Math.round((pctPlus65 - 20) * 3); // 20% = neutre
      score = Math.min(100, Math.max(0, 50 + seniorBonus));
    }
    if (indice_vieillissement != null && indice_vieillissement > 1.5) {
      score = Math.min(100, score + 10);
    }
    // Décroissance pop + vieillissement = bon combo pour EHPAD
    if (trend_annuel_pct != null && trend_annuel_pct < 0 && pctPlus65 != null && pctPlus65 > 25) {
      score = Math.min(100, score + 5);
      interpretation = "Population en déclin mais fort vieillissement — demande EHPAD/résidence senior soutenue.";
    } else if (pctPlus65 != null && pctPlus65 > 30) {
      interpretation = "Zone très âgée (" + pctPlus65.toFixed(1) + "% de 65+) — forte demande potentielle en hébergement seniors.";
    } else {
      interpretation = "Profil démographique " + (score >= 60 ? "favorable" : "neutre") + " pour un projet senior.";
    }

  } else if (nature === "residence_etudiante") {
    // Étudiants : -25 ans et croissance = bien
    if (pctMoins25 != null) {
      const jeuneBonus = Math.round((pctMoins25 - 25) * 3);
      score = Math.min(100, Math.max(0, scoreBase + jeuneBonus));
    }
    interpretation = pctMoins25 != null
      ? pctMoins25 + "% de moins de 25 ans — " + (pctMoins25 > 30 ? "bassin étudiant significatif." : "bassin étudiant limité.")
      : "Données démographiques jeunes non disponibles.";

  } else if (nature === "logement" || nature === "coliving") {
    // Logement classique : croissance pop = demande
    if (trend_annuel_pct != null && trend_annuel_pct > 0.5) {
      interpretation = "Croissance démographique de +" + trend_annuel_pct + "%/an — demande de logements soutenue.";
    } else if (trend_annuel_pct != null && trend_annuel_pct < -0.5) {
      interpretation = "Population en déclin (" + trend_annuel_pct + "%/an) — prudence sur les volumes de commercialisation.";
    } else {
      interpretation = "Population stable — marché du logement équilibré.";
    }

  } else if (nature === "commerce") {
    // Commerce : population + pouvoir d'achat
    interpretation = popActuelle != null
      ? "Bassin de " + popActuelle.toLocaleString("fr-FR") + " habitants — " +
        (popActuelle > 10000 ? "chalandise suffisante." : "chalandise limitée, analyser la zone de chalandise élargie.")
      : "Population communale non disponible.";

  } else {
    interpretation = "Tendance démographique " +
      (trend_annuel_pct != null ? (trend_annuel_pct > 0 ? "positive" : trend_annuel_pct < 0 ? "négative" : "stable") : "non évaluée") +
      " pour ce type de projet.";
  }

  // ─── 6. Trend label ───
  let trend_label: string;
  if (trend_annuel_pct == null)        trend_label = "Tendance inconnue";
  else if (trend_annuel_pct >= 1.0)    trend_label = "Forte croissance";
  else if (trend_annuel_pct >= 0.3)    trend_label = "Croissance modérée";
  else if (trend_annuel_pct >= -0.3)   trend_label = "Population stable";
  else if (trend_annuel_pct >= -1.0)   trend_label = "Déclin modéré";
  else                                  trend_label = "Déclin marqué";

  return {
    score,
    population_actuelle: popActuelle,
    delta_5ans_pct,
    delta_10ans_pct,
    trend_label,
    trend_annuel_pct,
    pct_plus_65: pctPlus65,
    pct_moins_25: pctMoins25,
    indice_vieillissement,
    taille_menage_moyenne,
    projection_2030: projections?.pop_2030 ?? null,
    projection_2040: projections?.pop_2040 ?? null,
    interpretation,
  };
}