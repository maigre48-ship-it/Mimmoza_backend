/**
 * supabase/functions/promoteur-from-parcelle-v3/bilan.ts
 * 
 * Bilan Promoteur – Étape 4
 * Module de calcul financier pour la faisabilité de promotion immobilière.
 * 
 * Appelé APRÈS : analyse PLU, faisabilité, implantation/massing
 * La SDP est connue ou estimée à ce stade.
 * 
 * Contraintes :
 * - Aucun throw (robustesse)
 * - Valeurs null acceptées (progressivité)
 * - Compatible Deno / Supabase Edge
 * - Aucune dépendance externe
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Hypothèses financières du bilan promoteur.
 * Toutes les valeurs en pourcentage sont exprimées en décimal (0.20 = 20%).
 */
export type Assumptions = {
  /** Marge cible du promoteur (0.20 = 20%) */
  marge_cible_pct: number;
  /** Prix de vente moyen estimé €/m² SDP */
  prix_vente_eur_m2: number | null;
  /** Coût de construction €/m² SDP (TCE) */
  cout_construction_eur_m2: number | null;
  /** Frais de maîtrise d'œuvre en % du coût construction */
  frais_moe_pct: number;
  /** Frais techniques (études, géotechnique, etc.) en % du coût construction */
  frais_tech_pct: number;
  /** Frais de commercialisation en % du CA */
  frais_commercialisation_pct: number;
  /** Frais financiers en % du CA */
  frais_financiers_pct: number;
};

/**
 * Détail des coûts annexes ventilés.
 */
type CoutsAnnexesDetail = {
  moe: number | null;
  technique: number | null;
  commercialisation: number | null;
  financiers: number | null;
};

/**
 * Détails des calculs du bilan.
 */
type BilanDetails = {
  cout_construction_eur: number | null;
  couts_annexes_eur: number | null;
  couts_annexes_detail: CoutsAnnexesDetail;
};

/**
 * Sorties principales du bilan.
 */
type BilanOutputs = {
  surface_sdp_m2: number | null;
  ca_total_eur: number | null;
  cout_total_eur: number | null;
  marge_eur: number | null;
  marge_pct: number | null;
  details: BilanDetails;
};

/**
 * Entrées du bilan (données d'entrée utilisées).
 */
type BilanInputs = {
  surface_sdp_m2: number | null;
  prix_vente_eur_m2: number | null;
  cout_construction_eur_m2: number | null;
};

/**
 * Indicateurs premium du bilan.
 */
type BilanPremium = {
  /** Prix terrain maximum pour atteindre la marge cible */
  prix_terrain_max_eur: number | null;
  /** SDP minimum pour atteindre le seuil de rentabilité */
  seuil_rentabilite_sdp_m2: number | null;
  /** Indicateur de décision basé sur la marge */
  indicateur_decision: "GO" | "GO_AVEC_RESERVES" | "NO_GO" | null;
};

/**
 * Bloc de synthèse pour consommation IA (Claude).
 */
type SynthesisReady = {
  decision: string | null;
  points_forts: string[];
  points_risques: string[];
  resume_financier: string | null;
};

/**
 * Structure complète de sortie du bilan promoteur.
 */
type BilanPromoteurResult = {
  ok: true;
  inputs: BilanInputs;
  assumptions: Assumptions;
  outputs: BilanOutputs;
  premium: BilanPremium;
  synthesis_ready: SynthesisReady;
};

// =============================================================================
// CONSTANTES
// =============================================================================

/** Valeurs par défaut des hypothèses */
const DEFAULT_MARGE_CIBLE_PCT = 0.20;
const DEFAULT_FRAIS_MOE_PCT = 0.08;
const DEFAULT_FRAIS_TECH_PCT = 0.05;
const DEFAULT_FRAIS_COMMERCIALISATION_PCT = 0.03;
const DEFAULT_FRAIS_FINANCIERS_PCT = 0.04;

/** Seuils pour l'indicateur de décision */
const SEUIL_GO = 0.15; // Marge >= 15% → GO
const SEUIL_GO_AVEC_RESERVES = 0.08; // Marge >= 8% → GO_AVEC_RESERVES

// =============================================================================
// FONCTIONS UTILITAIRES INTERNES
// =============================================================================

/**
 * Multiplie deux nombres si tous deux sont définis, sinon retourne null.
 */
function safeMultiply(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a * b;
}

/**
 * Additionne des nombres, en ignorant les null.
 * Retourne null si tous les paramètres sont null.
 */
function safeSum(...values: (number | null)[]): number | null {
  const validValues = values.filter((v): v is number => v !== null);
  if (validValues.length === 0) return null;
  return validValues.reduce((acc, val) => acc + val, 0);
}

/**
 * Soustrait b de a si les deux sont définis.
 */
function safeSubtract(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a - b;
}

/**
 * Divise a par b si les deux sont définis et b != 0.
 */
function safeDivide(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

/**
 * Arrondit un nombre à 2 décimales si défini.
 */
function round2(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 100) / 100;
}

// =============================================================================
// EXPORTS PRINCIPAUX
// =============================================================================

/**
 * Retourne les hypothèses par défaut du bilan promoteur.
 * Ces valeurs sont basées sur les standards du marché français.
 */
export function getDefaultAssumptions(): Assumptions {
  return {
    marge_cible_pct: DEFAULT_MARGE_CIBLE_PCT,
    prix_vente_eur_m2: null,
    cout_construction_eur_m2: null,
    frais_moe_pct: DEFAULT_FRAIS_MOE_PCT,
    frais_tech_pct: DEFAULT_FRAIS_TECH_PCT,
    frais_commercialisation_pct: DEFAULT_FRAIS_COMMERCIALISATION_PCT,
    frais_financiers_pct: DEFAULT_FRAIS_FINANCIERS_PCT,
  };
}

/**
 * Fusionne les hypothèses de base avec des surcharges fournies.
 * Les valeurs non définies ou invalides dans override sont ignorées.
 */
export function mergeAssumptions(
  base: Assumptions,
  override?: Record<string, unknown> | null
): Assumptions {
  if (!override || typeof override !== "object") return base;

  const out: Assumptions = { ...base };

  // Fonction helper pour extraire une valeur numérique valide
  const extractNumber = (key: string): number | undefined => {
    const val = (override as Record<string, unknown>)[key];
    return typeof val === "number" && !Number.isNaN(val) ? val : undefined;
  };

  // Fonction helper pour extraire une valeur numérique nullable
  const extractNullableNumber = (key: string): number | null | undefined => {
    const val = (override as Record<string, unknown>)[key];
    if (val === null) return null;
    return typeof val === "number" && !Number.isNaN(val) ? val : undefined;
  };

  // Surcharges des pourcentages (doivent être des nombres valides)
  const margeCible = extractNumber("marge_cible_pct");
  if (margeCible !== undefined) out.marge_cible_pct = margeCible;

  const fraisMoe = extractNumber("frais_moe_pct");
  if (fraisMoe !== undefined) out.frais_moe_pct = fraisMoe;

  const fraisTech = extractNumber("frais_tech_pct");
  if (fraisTech !== undefined) out.frais_tech_pct = fraisTech;

  const fraisComm = extractNumber("frais_commercialisation_pct");
  if (fraisComm !== undefined) out.frais_commercialisation_pct = fraisComm;

  const fraisFin = extractNumber("frais_financiers_pct");
  if (fraisFin !== undefined) out.frais_financiers_pct = fraisFin;

  // Surcharges des valeurs nullables
  const prixVente = extractNullableNumber("prix_vente_eur_m2");
  if (prixVente !== undefined) out.prix_vente_eur_m2 = prixVente;

  const coutConstruction = extractNullableNumber("cout_construction_eur_m2");
  if (coutConstruction !== undefined) out.cout_construction_eur_m2 = coutConstruction;

  return out;
}

/**
 * Calcule le bilan promoteur complet.
 * 
 * LOGIQUE DE CALCUL :
 * 
 * 1) Chiffre d'affaires (CA) = SDP × prix_vente_eur_m2
 * 
 * 2) Coût construction = SDP × cout_construction_eur_m2
 * 
 * 3) Coûts annexes :
 *    - MOE : frais_moe_pct × coût_construction (maîtrise d'œuvre)
 *    - Technique : frais_tech_pct × coût_construction (études, BET, etc.)
 *    - Commercialisation : frais_commercialisation_pct × CA (vente, marketing)
 *    - Financiers : frais_financiers_pct × CA (intérêts, portage)
 * 
 * 4) Coût total = coût_construction + coûts_annexes
 * 
 * 5) Marge :
 *    - marge_eur = CA - coût_total
 *    - marge_pct = marge_eur / CA
 * 
 * 6) Premium :
 *    - prix_terrain_max = CA × (1 - marge_cible) - coûts_hors_foncier
 *    - indicateur_decision basé sur marge_pct vs seuils
 * 
 * @param params - Paramètres d'entrée du calcul
 * @returns Bilan complet avec tous les indicateurs
 */
export function computeBilanPromoteur(params: {
  sdp_m2?: number | null;
  assumptions?: Assumptions;
}): BilanPromoteurResult {
  // Extraction et validation des entrées
  const sdp = typeof params.sdp_m2 === "number" && params.sdp_m2 > 0
    ? params.sdp_m2
    : null;

  const assumptions = params.assumptions ?? getDefaultAssumptions();

  // -------------------------------------------------------------------------
  // ÉTAPE 1 : Chiffre d'affaires
  // -------------------------------------------------------------------------
  const ca_total_eur = round2(safeMultiply(sdp, assumptions.prix_vente_eur_m2));

  // -------------------------------------------------------------------------
  // ÉTAPE 2 : Coût de construction
  // -------------------------------------------------------------------------
  const cout_construction_eur = round2(
    safeMultiply(sdp, assumptions.cout_construction_eur_m2)
  );

  // -------------------------------------------------------------------------
  // ÉTAPE 3 : Coûts annexes
  // Calcul ventilé pour transparence et audit
  // -------------------------------------------------------------------------

  // MOE et technique sont calculés sur le coût de construction
  // (car ils sont directement liés aux travaux)
  const couts_moe = round2(
    safeMultiply(cout_construction_eur, assumptions.frais_moe_pct)
  );
  const couts_technique = round2(
    safeMultiply(cout_construction_eur, assumptions.frais_tech_pct)
  );

  // Commercialisation et financiers sont calculés sur le CA
  // (car ils sont proportionnels au volume d'affaires)
  const couts_commercialisation = round2(
    safeMultiply(ca_total_eur, assumptions.frais_commercialisation_pct)
  );
  const couts_financiers = round2(
    safeMultiply(ca_total_eur, assumptions.frais_financiers_pct)
  );

  // Total des coûts annexes
  const couts_annexes_eur = round2(
    safeSum(couts_moe, couts_technique, couts_commercialisation, couts_financiers)
  );

  // -------------------------------------------------------------------------
  // ÉTAPE 4 : Coût total
  // -------------------------------------------------------------------------
  const cout_total_eur = round2(
    safeSum(cout_construction_eur, couts_annexes_eur)
  );

  // -------------------------------------------------------------------------
  // ÉTAPE 5 : Marge
  // -------------------------------------------------------------------------
  const marge_eur = round2(safeSubtract(ca_total_eur, cout_total_eur));
  const marge_pct = round2(safeDivide(marge_eur, ca_total_eur));

  // -------------------------------------------------------------------------
  // ÉTAPE 6 : Indicateurs premium
  // -------------------------------------------------------------------------

  // Prix terrain maximum pour atteindre la marge cible
  // Formule : prix_terrain_max = CA × (1 - marge_cible) - coûts_hors_foncier
  // où coûts_hors_foncier = coût_construction + coûts_annexes
  let prix_terrain_max_eur: number | null = null;
  if (ca_total_eur !== null && cout_total_eur !== null) {
    const budget_disponible = ca_total_eur * (1 - assumptions.marge_cible_pct);
    // Le terrain est ce qui reste après les coûts de construction et annexes
    prix_terrain_max_eur = round2(budget_disponible - cout_total_eur);
    // Si négatif, le projet n'est pas viable au prix de vente estimé
    if (prix_terrain_max_eur !== null && prix_terrain_max_eur < 0) {
      prix_terrain_max_eur = 0;
    }
  }

  // Seuil de rentabilité en SDP
  // C'est la SDP minimum pour avoir une marge positive, à prix constant
  // En simplifié : on utilise la SDP actuelle comme référence
  let seuil_rentabilite_sdp_m2: number | null = null;
  if (
    sdp !== null &&
    marge_pct !== null &&
    marge_pct > 0 &&
    assumptions.prix_vente_eur_m2 !== null &&
    assumptions.cout_construction_eur_m2 !== null
  ) {
    // Calcul basé sur les coûts fixes vs variables
    // Approximation : on considère que le seuil est atteint quand marge = 0
    // marge = CA - coûts = sdp × prix_vente × (1 - taux_couts) = 0
    // En pratique, on calcule le ratio actuel
    const taux_cout_sur_ca = safeDivide(cout_total_eur, ca_total_eur);
    if (taux_cout_sur_ca !== null && taux_cout_sur_ca < 1) {
      // Point mort approximatif basé sur structure de coûts actuelle
      // Si marge > 0, le seuil est inférieur à la SDP actuelle
      seuil_rentabilite_sdp_m2 = round2(sdp * taux_cout_sur_ca);
    }
  }

  // Indicateur de décision
  let indicateur_decision: "GO" | "GO_AVEC_RESERVES" | "NO_GO" | null = null;
  if (marge_pct !== null) {
    if (marge_pct >= SEUIL_GO) {
      indicateur_decision = "GO";
    } else if (marge_pct >= SEUIL_GO_AVEC_RESERVES) {
      indicateur_decision = "GO_AVEC_RESERVES";
    } else {
      indicateur_decision = "NO_GO";
    }
  }

  // -------------------------------------------------------------------------
  // ÉTAPE 7 : Synthèse pour IA
  // -------------------------------------------------------------------------
  const synthesis_ready = buildSynthesis({
    sdp,
    ca_total_eur,
    cout_total_eur,
    marge_eur,
    marge_pct,
    indicateur_decision,
    prix_terrain_max_eur,
    assumptions,
  });

  // -------------------------------------------------------------------------
  // CONSTRUCTION DU RÉSULTAT FINAL
  // -------------------------------------------------------------------------
  return {
    ok: true,

    inputs: {
      surface_sdp_m2: sdp,
      prix_vente_eur_m2: assumptions.prix_vente_eur_m2,
      cout_construction_eur_m2: assumptions.cout_construction_eur_m2,
    },

    assumptions: {
      marge_cible_pct: assumptions.marge_cible_pct,
      prix_vente_eur_m2: assumptions.prix_vente_eur_m2,
      cout_construction_eur_m2: assumptions.cout_construction_eur_m2,
      frais_moe_pct: assumptions.frais_moe_pct,
      frais_tech_pct: assumptions.frais_tech_pct,
      frais_commercialisation_pct: assumptions.frais_commercialisation_pct,
      frais_financiers_pct: assumptions.frais_financiers_pct,
    },

    outputs: {
      surface_sdp_m2: sdp,
      ca_total_eur,
      cout_total_eur,
      marge_eur,
      marge_pct,

      details: {
        cout_construction_eur,
        couts_annexes_eur,
        couts_annexes_detail: {
          moe: couts_moe,
          technique: couts_technique,
          commercialisation: couts_commercialisation,
          financiers: couts_financiers,
        },
      },
    },

    premium: {
      prix_terrain_max_eur,
      seuil_rentabilite_sdp_m2,
      indicateur_decision,
    },

    synthesis_ready,
  };
}

// =============================================================================
// FONCTIONS INTERNES DE SYNTHÈSE
// =============================================================================

/**
 * Construit le bloc de synthèse pour consommation IA.
 * Phrases courtes, factuelles, neutres.
 */
function buildSynthesis(data: {
  sdp: number | null;
  ca_total_eur: number | null;
  cout_total_eur: number | null;
  marge_eur: number | null;
  marge_pct: number | null;
  indicateur_decision: "GO" | "GO_AVEC_RESERVES" | "NO_GO" | null;
  prix_terrain_max_eur: number | null;
  assumptions: Assumptions;
}): SynthesisReady {
  const points_forts: string[] = [];
  const points_risques: string[] = [];

  // Analyse de la marge
  if (data.marge_pct !== null) {
    if (data.marge_pct >= 0.20) {
      points_forts.push("Marge supérieure ou égale à 20%, projet très rentable.");
    } else if (data.marge_pct >= 0.15) {
      points_forts.push("Marge entre 15% et 20%, rentabilité satisfaisante.");
    } else if (data.marge_pct >= 0.08) {
      points_risques.push("Marge entre 8% et 15%, rentabilité limitée.");
    } else if (data.marge_pct >= 0) {
      points_risques.push("Marge inférieure à 8%, projet à risque.");
    } else {
      points_risques.push("Marge négative, projet non viable en l'état.");
    }
  }

  // Analyse du prix terrain max
  if (data.prix_terrain_max_eur !== null) {
    if (data.prix_terrain_max_eur > 0) {
      points_forts.push(
        `Budget foncier disponible : ${formatEuro(data.prix_terrain_max_eur)}.`
      );
    } else {
      points_risques.push("Aucune marge pour l'acquisition foncière.");
    }
  }

  // Analyse des données manquantes
  if (data.sdp === null) {
    points_risques.push("Surface SDP non définie, calculs incomplets.");
  }
  if (data.assumptions.prix_vente_eur_m2 === null) {
    points_risques.push("Prix de vente non défini, CA non calculable.");
  }
  if (data.assumptions.cout_construction_eur_m2 === null) {
    points_risques.push("Coût construction non défini, coûts non calculables.");
  }

  // Décision textuelle
  let decision: string | null = null;
  switch (data.indicateur_decision) {
    case "GO":
      decision = "Projet recommandé : rentabilité conforme aux objectifs.";
      break;
    case "GO_AVEC_RESERVES":
      decision = "Projet acceptable sous réserve d'optimisation des coûts ou du prix de vente.";
      break;
    case "NO_GO":
      decision = "Projet non recommandé en l'état : rentabilité insuffisante.";
      break;
    default:
      decision = "Données insuffisantes pour statuer.";
  }

  // Résumé financier
  let resume_financier: string | null = null;
  if (
    data.ca_total_eur !== null &&
    data.cout_total_eur !== null &&
    data.marge_eur !== null &&
    data.marge_pct !== null
  ) {
    resume_financier = [
      `CA prévisionnel : ${formatEuro(data.ca_total_eur)}.`,
      `Coût total : ${formatEuro(data.cout_total_eur)}.`,
      `Marge : ${formatEuro(data.marge_eur)} (${formatPercent(data.marge_pct)}).`,
    ].join(" ");
  } else if (data.sdp !== null) {
    resume_financier = `Surface SDP : ${data.sdp} m². Données financières partielles.`;
  } else {
    resume_financier = "Aucune donnée financière disponible.";
  }

  return {
    decision,
    points_forts,
    points_risques,
    resume_financier,
  };
}

/**
 * Formate un montant en euros.
 */
function formatEuro(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Formate un pourcentage.
 */
function formatPercent(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}