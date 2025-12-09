// supabase/functions/ssmartscore-report-v2/index.ts
import { corsHeaders } from "../_shared/cors.ts";

console.log("📝 smartscore-report-v2 – function loaded");

/* ============================================================================
   TYPES UTILISÉS DANS LE RAPPORT
============================================================================ */

type PillarScores = {
  emplacement_env?: number | null;
  marche_liquidite?: number | null;
  qualite_bien?: number | null;
  rentabilite_prix?: number | null;
  risques_complexite?: number | null;
  [key: string]: number | null | undefined;
};

type SmartscorePayload = {
  success?: boolean;
  globalScore?: number | null;
  pillarScores?: PillarScores;
  usedCriteriaCount?: number;
  activePillars?: string[];
  mode?: string;
  report?: {
    executiveSummary?: string;
    pillarDetails?: Record<string, string>;
    recommendations?: string;
    forecast?: {
      horizon?: string;
      appreciationScenario?: string;
      cashflowScenario?: string;
    };
  };
};

type DVFSummary = {
  pricePerM2?: number | null;
  medianM2?: number | null;
  meanM2?: number | null;
  transactions?: number | null;
  deltaVsMedian?: number | null;
};

type InseeStats = {
  code_commune?: string | null;
  commune?: string | null;
  population?: number | null;
  pct_moins_25?: number | null;
  pct_plus_65?: number | null;
};

type MarketInsights = {
  pricePerM2?: number | null;
  medianM2?: number | null;
  deltaVsMedian?: number | null;
  classification?: string | null;
  liquidityBand?: string | null;
  note?: string | null;
};

type EnrichedModules = {
  plu?: { status: string; notes: string[] };
  risques?: { status: string; notes: string[] };
  transports?: { status: string; notes: string[] };
  socioEco?: any;
  marketInsights?: MarketInsights;
};

type EnrichedV4Input = {
  success?: boolean;
  version?: string;
  orchestrator?: string;
  smartscore?: SmartscorePayload;
  dvfSummary?: DVFSummary;
  travauxSummary?: any;
  insee_stats?: InseeStats | null;
  enrichedModules?: EnrichedModules;
  input?: {
    address?: string;
    cp?: string;
    ville?: string;
    surface?: number;
    prix?: number;
    type_local?: string;
    loyer_mensuel?: number;
    [key: string]: any;
  };
};

/* ============================================================================
   HELPERS FORMATAGE
============================================================================ */

function fmtPercent(v: number | null | undefined): string {
  if (v == null) return "N/A";
  return `${v.toFixed(2).replace(".", ",")} %`;
}

function fmtEuro(v: number | null | undefined): string {
  if (v == null) return "N/A";
  return `${Math.round(v).toLocaleString("fr-FR")} €`;
}

function fmtEuroM2(v: number | null | undefined): string {
  if (v == null) return "N/A";
  return `${Math.round(v).toLocaleString("fr-FR")} €/m²`;
}

function fmtInt(v: number | null | undefined): string {
  if (v == null) return "N/A";
  return `${Math.round(v).toLocaleString("fr-FR")}`;
}

/* ============================================================================
   FONCTION DE CONSTRUCTION DU RAPPORT MARKDOWN
============================================================================ */

function buildReportMarkdown(payload: EnrichedV4Input): string {
  const input = payload.input ?? {};
  const smartscore = payload.smartscore ?? {};
  const dvf = payload.dvfSummary ?? {};
  const travaux = payload.travauxSummary ?? {};
  const insee = payload.insee_stats ?? null;
  const modules = payload.enrichedModules ?? {};
  const market = modules.marketInsights ?? {};

  const address = input.address ?? "Adresse non renseignée";
  const cp = input.cp ?? (input as any).postal_code ?? "";
  const ville = input.ville ?? (input as any).city ?? "";
  const typeLocal = input.type_local ?? "Bien immobilier";
  const surface = input.surface ?? null;
  const prix = input.prix ?? null;

  const globalScore = smartscore.globalScore ?? null;
  const ps = smartscore.pillarScores ?? {};

  const execSummary =
    smartscore.report?.executiveSummary ??
    "Le bien présente un équilibre global entre emplacement, marché et valorisation potentielle.";

  const recommandations =
    smartscore.report?.recommendations ??
    "Vérifiez le détail des ventes comparables, le niveau de loyers réalistes et les risques techniques ou juridiques.";

  const horizon =
    smartscore.report?.forecast?.horizon ?? "3 à 5 ans";
  const appreciationScenario =
    smartscore.report?.forecast?.appreciationScenario ??
    "La valorisation dépendra de l’exécution des travaux et du positionnement prix.";
  const cashflowScenario =
    smartscore.report?.forecast?.cashflowScenario ??
    "Le cashflow dépend de la fiscalité, du mode de financement et de la qualité locative.";

  /* --- Introduction du bien --- */
  let introBien = `Ce rapport porte sur un **${typeLocal.toLowerCase()}** situé au **${address}** à **${cp} ${ville}**.`;

  if (surface && prix) {
    introBien += ` Le bien offre **${surface} m²** pour un prix proposé de **${fmtEuro(prix)}**, soit **${fmtEuroM2(
      dvf.pricePerM2 ?? null
    )}**.`;
  }

  /* --- Bloc DVF --- */
  let dvfBloc = "";
  if (dvf.medianM2 != null) {
    const delta = dvf.deltaVsMedian ?? null;
    let deltaStr = delta != null ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1).replace(".", ",")} %` : "N/A";

    dvfBloc = `
## 2. Positionnement prix & marché local (DVF)

- Prix médian : **${fmtEuroM2(dvf.medianM2)}**
- Prix moyen : **${fmtEuroM2(dvf.meanM2)}**
- Transactions analysées : **${fmtInt(dvf.transactions)}**
- Prix du bien : **${fmtEuroM2(dvf.pricePerM2)}**
- Écart vs médiane : **${deltaStr}**

${market.note ?? ""}
    `;
  }

  /* --- Bloc INSEE --- */
  let inseeBloc = "";
  if (insee && insee.population) {
    inseeBloc = `
## 3. Démographie de la commune

La commune de **${insee.commune}** compte environ **${fmtInt(insee.population)} habitants**.

- Moins de 25 ans : **${fmtPercent(insee.pct_moins_25)}**
- Plus de 65 ans : **${fmtPercent(insee.pct_plus_65)}**

Ces éléments permettent d'estimer la structure de la demande (familles, étudiants, seniors…).
    `;
  }

  /* --- Bloc travaux --- */
  let travauxBloc = "";
  if (travaux && (travaux.montant_total || travaux.travauxParM2)) {
    travauxBloc = `
## 4. Travaux & qualité intrinsèque du bien

- Budget travaux : **${fmtEuro(travaux.montant_total)}**
- Travaux par m² : **${fmtEuroM2(travaux.travauxParM2)}**

${travaux.description ?? "Aucune description fournie."}
    `;
  }

  /* --- Pilier scores --- */
  const piliersBloc = `
## 5. Résultats SmartScore Mimmoza

- Score global : **${globalScore ?? "N/A"}/100**
- Emplacement : **${ps.emplacement_env ?? "N/A"}/100**
- Marché & liquidité : **${ps.marche_liquidite ?? "N/A"}/100**
- Qualité du bien : **${ps.qualite_bien ?? "N/A"}/100**
- Rentabilité & prix : **${ps.rentabilite_prix ?? "N/A"}/100**
- Risques & complexités : **${ps.risques_complexite ?? "N/A"}/100**
  `;

  /* --- Conclusion --- */
  const conclusion = `
## 6. Recommandations & scénarios

${recommandations}

### Horizon d'investissement
- Horizon : **${horizon}**
- Valorisation : ${appreciationScenario}
- Cashflow : ${cashflowScenario}
  `;

  /* --- Final assembly --- */
  const full = `
# Rapport d’analyse immobilière – Mimmoza

${introBien}

---

## 1. Résumé exécutif

${execSummary}

${dvfBloc}

${inseeBloc}

${travauxBloc}

${piliersBloc}

${conclusion}
  `
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return full;
}

/* ============================================================================
   HANDLER HTTP SUPABASE EDGE FUNCTION
============================================================================ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => null)) as EnrichedV4Input | null;

    if (!body) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid JSON body – expected smartscore-enriched-v4 payload",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const reportMarkdown = buildReportMarkdown(body);

    return new Response(
      JSON.stringify({
        success: true,
        version: "v2",
        report_markdown: reportMarkdown,
        input: body.input ?? null,
        dvf: body.dvfSummary ?? null,
        insee_stats: body.insee_stats ?? null,
        smartscore: body.smartscore ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("❌ smartscore-report-v2 – erreur:", err);
    return new Response(
      JSON.stringify({ success: false, error: err?.message ?? "Internal error" }),
      { status: 500, headers: corsHeaders }
    );
  }
});
