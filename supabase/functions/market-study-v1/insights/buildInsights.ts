import type {
  ProjectType,
  Insight,
  Completeness,
  InseeData,
  TransportData,
  PricesData,
  SeniorCompetition,
  SubscoreKey,
} from "../types/market.types.ts";

function fmtPct(x: number) {
  return `${x.toFixed(1)}%`;
}

export function buildInsights(args: {
  project_type: ProjectType;
  score: number | null;
  subscores: Partial<Record<SubscoreKey, number | null>>;
  completeness: Completeness;
  insee: InseeData | null;
  transport: TransportData | null;
  prices: PricesData | null;
  seniorCompetition: SeniorCompetition | null;
}): Insight[] {
  const out: Insight[] = [];

  // System insights
  if (args.completeness.blocking.length > 0) {
    out.push({
      type: "negative",
      title: "Données manquantes bloquantes",
      description: `Le score global ne peut pas être calculé. Champs bloquants manquants: ${args.completeness.blocking.join(", ")}.`,
      value: null,
    });
  } else if (args.completeness.missing.length > 0 && args.score !== null) {
    out.push({
      type: "warning",
      title: "Score partiel",
      description: `Certaines données sont manquantes (${args.completeness.missing.length}). Le score est calculé sur les composantes disponibles.`,
      value: `${args.completeness.pct}% complétude`,
      evidence: [{ field: "completeness.missing", value: args.completeness.missing }],
    });
  }

  // NEW: fallback score warning (neutre 50/100)
  if (args.score === 50 && args.completeness.missing.length > 0 && args.completeness.blocking.length === 0) {
    out.push({
      type: "warning",
      title: "Score indicatif (fallback)",
      description:
        "Les données exploitables sont insuffisantes pour calculer un score fiable. Un score neutre (50/100) est affiché à titre indicatif.",
      value: "50/100",
    });
  }

  // Transport missing (jamais bloquant)
  if ((args.project_type === "ETUDIANT" || args.project_type === "BUREAUX") && args.transport?.score == null) {
    out.push({
      type: "warning",
      title: "Données transport non disponibles",
      description:
        args.project_type === "BUREAUX"
          ? "L'accessibilité en transports en commun est un critère clé pour des bureaux. Analyse complémentaire recommandée."
          : "Pour une résidence étudiante, l'accessibilité en transports en commun est un critère important. Analyse complémentaire recommandée.",
      value: null,
    });
  }

  // Demography highlights
  const evo = args.insee?.evolution_pop_5ans;
  if (typeof evo === "number") {
    if (evo >= 2.0) {
      out.push({
        type: "positive",
        title: "Croissance démographique",
        description: "La population augmente sur 5 ans, signal d'attractivité territoriale.",
        value: `+${evo.toFixed(1)}%`,
        evidence: [{ field: "insee.evolution_pop_5ans", value: evo }],
      });
    } else if (evo <= -1.0) {
      out.push({
        type: "warning",
        title: "Baisse démographique",
        description: "La population diminue sur 5 ans, ce qui peut dégrader la demande locale.",
        value: `${evo.toFixed(1)}%`,
        evidence: [{ field: "insee.evolution_pop_5ans", value: evo }],
      });
    }
  }

  // Student segment
  if (args.project_type === "ETUDIANT") {
    const pct1529 = args.insee?.pct_15_29;
    if (typeof pct1529 === "number") {
      out.push({
        type: pct1529 >= 20 ? "positive" : "warning",
        title: "Poids des 15–29 ans",
        description:
          pct1529 >= 20
            ? "Part de population jeune élevée, favorable à une résidence étudiante."
            : "Part de population jeune modérée, bassin étudiant à confirmer.",
        value: fmtPct(pct1529),
        evidence: [{ field: "insee.pct_15_29", value: pct1529 }],
      });
    } else {
      out.push({
        type: "warning",
        title: "Segments jeunes non disponibles",
        description: "Les données INSEE ne contiennent pas la tranche 15–29 ans. L'analyse étudiante est dégradée.",
        value: null,
      });
    }
  }

  // Senior segment
  if (args.project_type === "RSS" || args.project_type === "EHPAD") {
    const pct75 = args.insee?.pct_plus_75;
    if (typeof pct75 === "number") {
      out.push({
        type: pct75 >= 12 ? "positive" : "warning",
        title: "Population 75+",
        description:
          pct75 >= 12
            ? "Part de 75+ significative, favorable au senior."
            : "Part de 75+ plutôt faible; vérifier la demande effective et les communes périphériques.",
        value: fmtPct(pct75),
        evidence: [{ field: "insee.pct_plus_75", value: pct75 }],
      });
    }
    const dens = args.seniorCompetition?.densite_lits_1000_seniors;
    if (typeof dens === "number") {
      out.push({
        type: dens < 80 ? "opportunity" : "warning",
        title: "Densité d'offre senior",
        description:
          dens < 80
            ? "Densité d'offre inférieure à une référence nationale typique; zone potentiellement sous-équipée."
            : "Densité d'offre élevée; risque de concurrence plus forte.",
        value: `${dens.toFixed(1)} / 1000`,
        evidence: [{ field: "modules.senior_competition.densite_lits_1000_seniors", value: dens }],
      });
    }
  }

  // Price dynamics
  const evo1 = args.prices?.evolution_1an;
  if (typeof evo1 === "number") {
    out.push({
      type: evo1 >= 3 ? "positive" : evo1 <= -2 ? "warning" : "opportunity",
      title: "Dynamique de marché",
      description:
        evo1 >= 3
          ? "Progression des prix sur 1 an, signal de tension/demande."
          : evo1 <= -2
            ? "Baisse des prix sur 1 an, vérifier la liquidité et l'attractivité."
            : "Marché relativement stable; opportunité selon positionnement.",
      value: `${evo1 >= 0 ? "+" : ""}${evo1.toFixed(1)}%`,
      evidence: [{ field: "prices.evolution_1an", value: evo1 }],
    });
  }

  // Hotel: tourisme missing => explicit warning
  if (args.project_type === "HOTEL" && args.subscores.tourisme == null) {
    out.push({
      type: "warning",
      title: "Indicateurs tourisme manquants",
      description:
        "Les indicateurs clés hôteliers (nuitées, taux d’occupation, RevPAR/ADR, saisonnalité) ne sont pas disponibles en v1. Le score est un proxy basé sur économie/commodités/transport.",
      value: null,
    });
  }

  // If nothing, ensure at least one insight
  if (out.length === 0) {
    out.push({
      type: "warning",
      title: "Analyse limitée",
      description: "Peu d’indicateurs exploitables en v1. Connecter les sources de données pour enrichir l’analyse.",
      value: null,
    });
  }

  return out;
}
