// supabase/functions/smartscore-agent-v2/index.ts
import { corsHeaders } from "../_shared/cors.ts";

console.log("✅ smartscore-agent-v2 – function loaded");

// -----------------------------
// Helpers génériques
// -----------------------------

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(n: unknown): number | null {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : null;
}

function round(value: number | null, decimals = 0): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function formatEuro(
  value: number | null,
  { decimals = 0, suffix = "€" }: { decimals?: number; suffix?: string } = {},
): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const r = round(value, decimals);
  if (r == null) return "N/A";
  return `${r.toLocaleString("fr-FR")} ${suffix}`.trim();
}

function formatPercent(value: number | null, decimals = 1): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const r = round(value, decimals);
  if (r == null) return "N/A";
  return `${r.toLocaleString("fr-FR")}%`;
}

// -----------------------------
// Interprétations DVF & SocioFiscal
// -----------------------------

function describeDeltaVsMedian(deltaVsMedian: number | null): string {
  if (deltaVsMedian == null || !Number.isFinite(deltaVsMedian)) {
    return "Le positionnement prix ne peut pas être comparé précisément à la médiane DVF locale (données insuffisantes ou incohérentes).";
  }

  if (deltaVsMedian <= -10) {
    return "Le prix se situe nettement en dessous de la médiane des transactions DVF du secteur (décote supérieure à 10%), ce qui peut traduire une opportunité intéressante sous réserve de vérifier l’état du bien et d’éventuels risques cachés.";
  }

  if (deltaVsMedian <= -3) {
    return "Le prix est légèrement en dessous de la médiane DVF (décote de l’ordre de 3 à 10%), ce qui est plutôt favorable pour l’acheteur si l’état du bien est conforme au marché.";
  }

  if (deltaVsMedian < 3) {
    return "Le prix est globalement aligné avec la médiane des transactions DVF récentes du secteur (écart inférieur à ±3%), ce qui suggère un positionnement cohérent avec le marché local.";
  }

  if (deltaVsMedian < 10) {
    return "Le prix est légèrement au-dessus de la médiane DVF (surcote de l’ordre de 3 à 10%), ce qui peut s’expliquer par des atouts spécifiques du bien (état, vue, étage, etc.) mais mérite une négociation argumentée.";
  }

  return "Le prix se situe nettement au-dessus de la médiane des transactions DVF (surcote supérieure à 10%), ce qui suppose des qualités exceptionnelles ou un potentiel de valorisation fort ; à défaut, le risque de surpaiement est réel.";
}

function describeSocioFiscal(socio: any): string {
  if (!socio) {
    return "Les données socio-fiscales détaillées ne sont pas disponibles pour cette commune, ce qui limite légèrement la finesse de l’analyse du profil des ménages locaux.";
  }

  const revMed = safeNumber(socio.revenu_fiscal_median_mensuel_euros);
  const retMed = safeNumber(socio.retraite_median_mensuel_euros);
  const revMin = safeNumber(socio.revenu_min_tranche_mensuel_euros);
  const revMax = safeNumber(socio.revenu_max_tranche_mensuel_euros);

  const parts: string[] = [];

  if (revMed != null) {
    parts.push(
      `Le revenu fiscal médian des foyers est estimé autour de ${formatEuro(
        revMed,
        { decimals: 0, suffix: "€/mois" },
      )}, ce qui donne une première idée du pouvoir d’achat local.`,
    );
  } else {
    parts.push(
      "Le revenu fiscal médian des foyers n’est pas disponible, ce qui limite la précision de l’analyse du pouvoir d’achat local.",
    );
  }

  if (retMed != null) {
    parts.push(
      `Pour les retraités, le revenu médian se situe autour de ${formatEuro(
        retMed,
        { decimals: 0, suffix: "€/mois" },
      )}, ce qui permet d’apprécier l’adéquation du bien avec une cible “seniors” ou investisseurs patrimoniaux.`,
    );
  }

  if (revMin != null && revMax != null) {
    parts.push(
      `Les tranches de revenus vont globalement d’environ ${formatEuro(
        revMin,
        { decimals: 0, suffix: "€/mois" },
      )} à ${formatEuro(revMax, {
        decimals: 0,
        suffix: "€/mois",
      })}, reflétant une population plutôt ${
        revMax > 8000 ? "aisée" : "mixte"
      } sur le plan socio-économique.`,
    );
  }

  return parts.join(" ");
}

// -----------------------------
// Analyse Commodités (BPE) – Version 3 adaptative
// -----------------------------

function buildCommoditesAnalysis(bpe: any): string | null {
  if (!bpe) return null;

  const score = safeNumber(bpe.scoreCommodites);
  if (score == null) return null;

  const r = safeNumber(bpe.rayon_m) ?? 400;
  const nbCom = safeNumber(bpe.nb_commerces_proximite) ?? 0;
  const nbSant = safeNumber(bpe.nb_sante_proximite) ?? 0;
  const nbServ = safeNumber(bpe.nb_services_proximite) ?? 0;

  const intro =
    `L’environnement immédiat est analysé à partir des commodités et services dans un rayon de ${r.toLocaleString(
      "fr-FR",
    )} m. ` +
    `Dans ce périmètre, on dénombre environ ${nbCom.toLocaleString(
      "fr-FR",
    )} commerces, ${nbSant.toLocaleString(
      "fr-FR",
    )} équipements de santé et ${nbServ.toLocaleString(
      "fr-FR",
    )} services publics ou privés.`;

  // Score très élevé
  if (score >= 80) {
    return (
      intro +
      " " +
      `L’environnement immédiat est **particulièrement bien doté**, avec une densité d’équipements proche de celle des zones très centrales. ` +
      "Ce niveau de services permet une **vie quotidienne largement possible à pied** : commerces, santé et services essentiels sont accessibles en quelques minutes. " +
      `Le score « Commodités & services » atteint **${round(
        score,
        0,
      )}/100**, ce qui constitue un **atout majeur** pour une résidence principale comme pour un investissement locatif.`
    );
  }

  // Score correct
  if (score >= 60) {
    return (
      intro +
      " " +
      "L’offre de commodités est **globalement bonne**, permettant de couvrir la plupart des besoins du quotidien sans déplacements excessifs. " +
      "Certains types d’équipements sont bien représentés (santé, services ou commerces), même si la densité reste plus modérée que dans les secteurs hyper-centraux. " +
      `Le score « Commodités & services » est de **${round(
        score,
        0,
      )}/100**, ce qui traduit un **bon niveau d’attractivité locale**.`
    );
  }

  // Score faible
  if (score >= 40) {
    return (
      intro +
      " " +
      "L’environnement immédiat offre un **niveau de commodités intermédiaire**. Les équipements essentiels restent accessibles, mais leur densité est limitée dans ce rayon. " +
      "Selon le profil recherché (familles, seniors, actifs sans voiture), des déplacements plus longs pourront être nécessaires pour certains services ou commerces spécifiques. " +
      `Le score « Commodités & services » est de **${round(
        score,
        0,
      )}/100**, ce qui reflète une **attractivité moyenne à limitée** en termes de vie quotidienne.`
    );
  }

  // Score très faible
  return (
    intro +
    " " +
    "La zone apparaît **faiblement équipée en commodités**, avec une densité nettement inférieure à la moyenne. " +
    "L’accès à de nombreux services (santé, commerces variés, équipements publics) nécessite des déplacements en voiture ou en transports. " +
    "Pour une résidence principale, cela peut réduire le confort de vie au quotidien ; pour un investissement, cela peut limiter l’attrait locatif pour certains profils de locataires. " +
    `Le score « Commodités & services » est de **${round(
      score,
      0,
    )}/100**, ce qui traduit un **niveau faible d’équipements de proximité**.`
  );
}

// -----------------------------
// Scoring à partir des données
// -----------------------------

function scoreMarcheLiquidite(dvfSummary: any): number {
  const tx = safeNumber(dvfSummary?.transactions);
  if (tx == null) return 55; // valeur neutre si on ne sait pas

  if (tx >= 300) return 85;
  if (tx >= 200) return 78;
  if (tx >= 100) return 70;
  if (tx >= 50) return 62;
  if (tx >= 20) return 55;
  return 48;
}

function scoreRentabilitePrix(dvfSummary: any): number {
  const delta = safeNumber(dvfSummary?.deltaVsMedian);
  if (delta == null) return 55;

  // sous-marché => bon pour l’acheteur
  if (delta <= -15) return 88;
  if (delta <= -10) return 82;
  if (delta <= -5) return 75;
  if (delta <= -3) return 68;

  // aligné
  if (Math.abs(delta) < 3) return 60;

  // surcote légère
  if (delta < 10) return 52;

  // grosse surcote
  if (delta < 20) return 45;
  return 38;
}

/**
 * Emplacement & environnement :
 * - base : socio-fiscal + CP (revenus, CP premium)
 * - enrichi : ecolesScore (0-100) si dispo => mix pondéré
 */
function scoreEmplacementEnv(
  socio: any,
  cp: string | null,
  ecolesScore: number | null,
): number {
  // base neutre socio + CP
  let base = 70;

  const revMed = safeNumber(socio?.revenu_fiscal_median_mensuel_euros);
  const revMax = safeNumber(socio?.revenu_max_tranche_mensuel_euros);

  if (revMed != null) {
    if (revMed < 1200) base -= 8;
    else if (revMed < 1800) base -= 2;
    else if (revMed < 2500) base += 3;
    else if (revMed < 3500) base += 6;
    else base += 10;
  }

  if (revMax != null && revMax > 8000) {
    base += 3; // présence d’une frange très aisée
  }

  // petit bonus sur certains CP "premium"
  if (cp && (cp.startsWith("92") || cp.startsWith("75"))) {
    base += 2;
  }

  base = clamp(base);

  // Si on a un score écoles, on le mélange avec la base
  const ecoles = safeNumber(ecolesScore);
  if (ecoles != null) {
    // 60% socio / 40% écoles
    const mixed = 0.6 * base + 0.4 * clamp(ecoles);
    return clamp(mixed);
  }

  return base;
}

function scoreQualiteBienFromUserCriteria(userCriteria: any): number {
  if (!userCriteria || typeof userCriteria !== "object") {
    return 70; // neutre
  }

  const keys = [
    "etat_interieur",
    "etat_batiment",
    "agencement",
    "potentiel_valorisation",
    "etat_general",
  ];

  const values: number[] = [];

  for (const k of keys) {
    const v = safeNumber(userCriteria[k]);
    if (v != null && v >= 0 && v <= 10) {
      values.push(v);
    }
  }

  if (!values.length) return 70;

  const avg10 = values.reduce((a, b) => a + b, 0) / values.length;
  return clamp(avg10 * 10);
}

function scoreRisquesComplexite(
  dvfSummary: any,
  socio: any,
  context: any,
): number {
  let score = 55; // neutre

  const delta = safeNumber(dvfSummary?.deltaVsMedian);
  const tx = safeNumber(dvfSummary?.transactions);
  const revMed = safeNumber(socio?.revenu_fiscal_median_mensuel_euros);

  // Surcote importante = risque de surpaiement
  if (delta != null) {
    if (delta > 20) score -= 12;
    else if (delta > 10) score -= 8;
    else if (delta > 5) score -= 4;
  }

  // Marché peu liquide = risque de revente plus lente
  if (tx != null) {
    if (tx < 20) score -= 8;
    else if (tx < 50) score -= 4;
  }

  // Très bas revenus médians = risque locatif / impayés un peu plus élevé
  if (revMed != null && revMed < 1200) {
    score -= 5;
  }

  // Si l’utilisateur a fourni un ressenti "risques & complexités" (0–10)
  const ressenti = safeNumber(context?.userCriteria?.risques_complexite);
  if (ressenti != null && ressenti >= 0 && ressenti <= 10) {
    // on mappe autour du neutre (5/10 -> pas de changement)
    score += (ressenti - 5) * 3;
  }

  return clamp(score);
}

// -----------------------------
// Calcul global
// -----------------------------

type PillarKey =
  | "emplacement_env"
  | "marche_liquidite"
  | "qualite_bien"
  | "rentabilite_prix"
  | "risques_complexite";

type PillarScores = Record<PillarKey, number | null>;

function computePillars(context: any): {
  pillarScores: PillarScores;
  usedCriteriaCount: number;
  activePillars: PillarKey[];
} {
  const dvfSummary = context?.dvfSummary ?? null;
  const socioFiscal = context?.socioFiscal ?? null;
  const userCriteria = context?.userCriteria ?? null;
  const cp = typeof context?.cp === "string" ? context.cp : null;

  // écoles : on prend d'abord ecolesScore, sinon ecolesStats.scoreEcoles
  const ecolesScoreRaw =
    safeNumber(context?.ecolesScore) ??
    safeNumber(context?.ecolesStats?.scoreEcoles);
  const ecolesScore =
    ecolesScoreRaw != null ? clamp(ecolesScoreRaw, 0, 100) : null;

  let usedCriteriaCount = 0;

  // Emplacement & environnement
  let emplacement_env: number | null = null;
  if (socioFiscal || ecolesScore != null) {
    emplacement_env = scoreEmplacementEnv(socioFiscal, cp, ecolesScore);
    // on compte un peu plus de critères si écoles incluses
    usedCriteriaCount += 3;
    if (ecolesScore != null) usedCriteriaCount += 1;
  }

  // Marché & liquidité
  let marche_liquidite: number | null = null;
  if (dvfSummary) {
    marche_liquidite = scoreMarcheLiquidite(dvfSummary);
    usedCriteriaCount += 3;
  }

  // Qualité du bien (basée sur userCriteria si dispo)
  let qualite_bien: number | null = null;
  qualite_bien = scoreQualiteBienFromUserCriteria(userCriteria);
  if (userCriteria) {
    usedCriteriaCount += 3;
  }

  // Rentabilité & prix
  let rentabilite_prix: number | null = null;
  if (dvfSummary) {
    rentabilite_prix = scoreRentabilitePrix(dvfSummary);
    usedCriteriaCount += 3;
  }

  // Risques & complexités
  let risques_complexite: number | null = null;
  risques_complexite = scoreRisquesComplexite(dvfSummary, socioFiscal, context);
  usedCriteriaCount += 2;

  const pillarScores: PillarScores = {
    emplacement_env,
    marche_liquidite,
    qualite_bien,
    rentabilite_prix,
    risques_complexite,
  };

  const activePillars = (Object.keys(pillarScores) as PillarKey[]).filter(
    (k) => pillarScores[k] != null,
  );

  return {
    pillarScores,
    usedCriteriaCount,
    activePillars,
  };
}

function computeGlobalScore(pillarScores: PillarScores): number {
  const weights: Record<PillarKey, number> = {
    emplacement_env: 0.25,
    marche_liquidite: 0.2,
    qualite_bien: 0.2,
    rentabilite_prix: 0.25,
    risques_complexite: 0.1,
  };

  let weightedSum = 0;
  let weightTotal = 0;

  (Object.keys(pillarScores) as PillarKey[]).forEach((k) => {
    const score = pillarScores[k];
    if (score != null) {
      weightedSum += score * weights[k];
      weightTotal += weights[k];
    }
  });

  if (weightTotal === 0) return 50;

  return clamp(weightedSum / weightTotal);
}

// -----------------------------
// Génération du rapport texte
// -----------------------------

function buildReport(
  context: any,
  pillarScores: PillarScores,
  globalScore: number,
): any {
  const address = context?.address ?? "";
  const cp = context?.cp ?? "";
  const ville = context?.ville ?? "";
  const surface = safeNumber(context?.surface);
  const prix = safeNumber(context?.prix);
  const type_local = context?.type_local ?? "bien immobilier";

  const dvfSummary = context?.dvfSummary ?? null;
  const socioFiscal = context?.socioFiscal ?? null;
  const ecolesStats = context?.ecolesStats ?? null;
  const bpeStats = context?.bpeStats ?? null; // 👈 BPE / commodités

  const pricePerM2 = safeNumber(dvfSummary?.pricePerM2);
  const medianM2 = safeNumber(dvfSummary?.medianM2);
  const deltaVsMedian = safeNumber(dvfSummary?.deltaVsMedian);
  const transactions = safeNumber(dvfSummary?.transactions);

  const executiveSummaryParts: string[] = [];

  executiveSummaryParts.push(
    `Le bien analysé est un ${type_local.toLowerCase()} de ${
      surface != null ? `${surface} m²` : "surface inconnue"
    } situé au ${address || "adresse non renseignée"} ${
      cp ? `${cp} ` : ""
    }${ville || ""}.`,
  );

  if (prix != null && surface != null) {
    executiveSummaryParts.push(
      `Le prix demandé est de ${formatEuro(prix)} soit environ ${
        formatEuro(pricePerM2, { decimals: 0, suffix: "€/m²" })
      }.`,
    );
  }

  executiveSummaryParts.push(
    `Le SmartScore global ressort à ${round(globalScore, 0)}/100, ce qui traduit un niveau d’attractivité ${
      globalScore >= 80
        ? "élevé"
        : globalScore >= 60
        ? "correct à bon"
        : globalScore >= 45
        ? "mitigé"
        : "plutôt faible"
    } compte tenu du marché local, de la qualité intrinsèque du bien et des risques identifiés.`,
  );

  // Si on a un score écoles très bon ou très mauvais, on le mentionne dans le résumé
  const ecolesScore = safeNumber(
    context?.ecolesScore ?? context?.ecolesStats?.scoreEcoles,
  );
  if (ecolesStats && ecolesScore != null) {
    const nearestName = ecolesStats.nearestName ?? "une école";
    const nearestDist = safeNumber(ecolesStats.nearestDistanceM);
    const distTxt =
      nearestDist != null
        ? `${round(nearestDist, 0)} m`
        : "quelques centaines de mètres";

    if (ecolesScore >= 80) {
      executiveSummaryParts.push(
        `La proximité des établissements scolaires constitue un point fort : ${nearestName} se situe à environ ${distTxt}, avec plusieurs écoles accessibles à pied.`,
      );
    } else if (ecolesScore <= 50) {
      executiveSummaryParts.push(
        "L’accessibilité aux établissements scolaires apparaît plus moyenne, ce qui pourra être un point de vigilance pour un projet familial.",
      );
    }
  }

  const executiveSummary = executiveSummaryParts.join(" ");

  // Détails par pilier
  const pillarDetails: Record<string, string> = {};

  // Emplacement
  let emplTxt =
    `Le pilier “Emplacement & environnement” obtient ${
      round(pillarScores.emplacement_env, 0) ?? "N/A"
    }/100. ` + describeSocioFiscal(socioFiscal);

  if (ecolesStats) {
    const nearestName = ecolesStats.nearestName ?? "un établissement scolaire";
    const nearestDist = safeNumber(ecolesStats.nearestDistanceM);
    const count500 = safeNumber(ecolesStats.count500m);
    const distTxt =
      nearestDist != null
        ? `environ ${round(nearestDist, 0)} m`
        : "quelques centaines de mètres";

    emplTxt += " ";
    emplTxt += `Sur le plan pratique, ${nearestName} se situe à ${distTxt}, `;
    if (count500 != null) {
      emplTxt += `avec environ ${count500.toLocaleString(
        "fr-FR",
      )} établissement(s) scolaire(s) recensé(s) dans un rayon de 500 m, ce qui renforce l’attractivité du secteur pour un projet de vie familiale.`;
    } else {
      emplTxt +=
        "ce qui constitue un atout pour les ménages avec enfants ou les investisseurs ciblant une clientèle familiale.";
    }
  }

  // 👉 Ajout analyse Commodités & services (BPE)
  const commoditesAnalysis = buildCommoditesAnalysis(bpeStats);
  if (commoditesAnalysis) {
    emplTxt += "\n\n" + commoditesAnalysis;
  }

  pillarDetails["emplacement_env"] = emplTxt;

  // Marché & liquidité
  let marcheTxt = `Le pilier “Marché & liquidité” est noté ${
    round(pillarScores.marche_liquidite, 0) ?? "N/A"
  }/100. `;
  if (transactions != null) {
    marcheTxt += `Sur la période récente, environ ${transactions.toLocaleString(
      "fr-FR",
    )} transactions DVF ont été recensées pour ce segment, ce qui donne un niveau de liquidité ${
      transactions >= 200
        ? "élevé"
        : transactions >= 100
        ? "correct"
        : transactions >= 50
        ? "modéré"
        : "plus restreint"
    }.`;
  } else {
    marcheTxt +=
      "Le nombre de transactions DVF disponibles est insuffisant pour caractériser précisément la liquidité du marché.";
  }
  pillarDetails["marche_liquidite"] = marcheTxt;

  // Qualité du bien
  pillarDetails["qualite_bien"] =
    `Le pilier “Qualité du bien” affiche ${
      round(pillarScores.qualite_bien, 0) ?? "N/A"
    }/100. ` +
    "Ce score synthétise les critères renseignés par l’utilisateur (état intérieur, état du bâtiment, agencement, potentiel de valorisation). Une analyse technique plus détaillée (diagnostics, PV d’AG, travaux récents) permettra de confirmer ou d’ajuster cette appréciation.";

  // Rentabilité & prix
  let rentTxt = `Le pilier “Rentabilité & prix” est noté ${
    round(pillarScores.rentabilite_prix, 0) ?? "N/A"
  }/100. `;
  if (pricePerM2 != null && medianM2 != null) {
    rentTxt += `Le prix au m² du bien (≈ ${
      formatEuro(pricePerM2, { decimals: 0, suffix: "€/m²" })
    }) est comparé à une médiane DVF locale d’environ ${
      formatEuro(medianM2, { decimals: 0, suffix: "€/m²" })
    }. `;
  }
  rentTxt += describeDeltaVsMedian(deltaVsMedian);
  pillarDetails["rentabilite_prix"] = rentTxt;

  // Risques & complexité
  pillarDetails["risques_complexite"] =
    `Le pilier “Risques & complexités” obtient ${
      round(pillarScores.risques_complexite, 0) ?? "N/A"
    }/100. ` +
    "Ce score tient compte du niveau de surcote ou de décote par rapport au marché, de la profondeur de marché (nombre de transactions) et, le cas échéant, du ressenti de l’utilisateur sur la complexité du dossier (copropriété, urbanisme, travaux, locataire en place, etc.). Une revue détaillée des diagnostics, du règlement de copropriété, des servitudes et de la situation locative reste indispensable avant décision.";

  // Recommandations générales
  const recommendations =
    "Avant de se positionner définitivement, il est recommandé de : " +
    "(1) vérifier la cohérence du prix avec les dernières ventes DVF et les annonces comparables, " +
    "(2) analyser les documents juridiques (titre de propriété, règlement de copropriété, diagnostics, éventuels baux en cours), " +
    "(3) simuler plusieurs scénarios de financement et de loyer (taux, durée, apport, fiscalité) pour valider la rentabilité nette, " +
    "(4) confronter le profil socio-fiscal local (revenus médians, part de retraités) avec la stratégie cible : résidence principale, locatif, seniors, etc., " +
    "(5) intégrer la proximité des écoles et des transports comme critère clé si la cible est une clientèle familiale.";

  // Forecast simple
  const forecast = {
    horizon: "3 à 5 ans",
    appreciationScenario:
      "Dans un scénario de marché neutre à légèrement porteur, un bien correctement positionné en prix et présentant un bon emplacement a des chances de maintenir voire d’améliorer sa valeur sur un horizon de 3 à 5 ans. À l’inverse, une forte surcote initiale ou un marché peu liquide augmentent le risque de baisse ou de stagnation.",
    cashflowScenario:
      "En optimisant le financement (montant d’apport, durée, taux) et la stratégie locative (meublé vs nu, loyer de marché, vacance locative), le cashflow peut être rapproché de l’équilibre voire devenir positif, sous réserve de maîtriser les charges de copropriété, la fiscalité et les travaux structurants.",
  };

  return {
    executiveSummary,
    pillarDetails,
    recommendations,
    forecast,
  };
}

// -----------------------------
// Handler principal
// -----------------------------

async function handlePost(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => null);
    console.log("📥 smartscore-agent-v2 – body reçu:", body);

    if (!body || typeof body !== "object") {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid JSON" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const mode =
      typeof (body as any).mode === "string" ? (body as any).mode : "standard";
    const context = (body as any).context ?? {};

    // Calcul des scores
    const {
      pillarScores,
      usedCriteriaCount,
      activePillars,
    } = computePillars(context);

    const globalScore = computeGlobalScore(pillarScores);

    const report = buildReport(context, pillarScores, globalScore);

    const responsePayload = {
      success: true,
      mode,
      globalScore,
      pillarScores,
      usedCriteriaCount,
      activePillars,
      messages: [
        "SmartScore calculé via smartscore-agent-v2 (DVF + socio-fiscal + proximité écoles + commodités intégrés).",
      ],
      report,
      debug: {
        receivedBody: body,
      },
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ smartscore-agent-v2 – erreur:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: "internal_error",
        details: String(err),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}

// -----------------------------
// Deno.serve
// -----------------------------

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method === "POST") {
    return handlePost(req);
  }
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
