// supabase/functions/smartscore-enriched-v4/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";
import { corsHeaders } from "../_shared/cors.ts";

console.log("🚀 smartscore-enriched-v4 – function loaded");

type StatusFlag = "ok" | "missing" | "not_implemented";

type InseeCommuneStats = {
  code_commune: string | null;
  commune: string | null;
  population: number | null;
  pct_moins_25: number | null;
  pct_plus_65: number | null;
};

type SocioEcoModule = {
  status: StatusFlag;
  notes: string[];
  code_commune?: string | null;
  commune?: string | null;
  population?: number | null;
  pct_moins_25?: number | null;
  pct_plus_65?: number | null;
};

/* ============================================================================================
   🔧 Helpers — Supabase client & API secret
============================================================================================ */

function getSupabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE");

  if (!url || !key) {
    throw new Error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

function getApiSecretFromEnv(): string {
  const apiSecret =
    Deno.env.get("API_SECRET_KEY") ??
    Deno.env.get("MIMMOZA_API_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE") ??
    "";

  if (!apiSecret) {
    throw new Error("❌ Missing API_SECRET_KEY / MIMMOZA_API_KEY / SERVICE_ROLE");
  }

  return apiSecret;
}

/* ============================================================================================
   📊 DVF Summary
============================================================================================ */

async function fetchDVFSummary(
  supabase: any,
  cp: string | undefined,
  type_local: string | undefined,
  prix: number | undefined,
  surface: number | undefined,
) {
  if (!cp || !type_local) return null;

  const { data, error } = await supabase.rpc("get_dvf_stats_for_cp_type", {
    p_code_postal: cp,
    p_type_local: type_local,
  });

  if (error) {
    console.error("❌ DVF error:", error);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;

  const pricePerM2 =
    prix && surface && surface > 0 ? prix / surface : null;

  const medianM2 = row?.median_price_m2 ?? null;
  const meanM2 = row?.avg_price_m2 ?? null;
  const transactions = row?.total_transactions ?? null;

  const deltaVsMedian =
    pricePerM2 && medianM2 && medianM2 > 0
      ? ((pricePerM2 - medianM2) / medianM2) * 100
      : null;

  return {
    pricePerM2,
    medianM2,
    meanM2,
    transactions,
    deltaVsMedian,
    raw: Array.isArray(data) ? data : [data],
  };
}

/* ============================================================================================
   👥 INSEE communes – helper
============================================================================================ */

async function fetchInseeCommuneStats(
  supabase: any,
  codeInsee: string | null,
): Promise<InseeCommuneStats | null> {
  if (!codeInsee) {
    console.log("ℹ️ Aucun code INSEE fourni, skip INSEE stats");
    return null;
  }

  const { data, error } = await supabase
    .from("insee_communes_stats")
    .select("code_commune, commune, population, pct_moins_25, pct_plus_65")
    .eq("code_commune", codeInsee)
    .maybeSingle();

  if (error) {
    console.error("❌ Erreur fetchInseeCommuneStats:", error);
    return null;
  }

  if (!data) {
    console.log("ℹ️ Aucune ligne INSEE trouvée pour", codeInsee);
    return null;
  }

  return {
    code_commune: data.code_commune,
    commune: data.commune,
    population: data.population,
    pct_moins_25: data.pct_moins_25,
    pct_plus_65: data.pct_plus_65,
  };
}

/* ============================================================================================
   🔨 Travaux Summary
============================================================================================ */

function computeTravauxSummary(
  travaux: any,
  prix: number | undefined,
  surface: number | undefined,
) {
  if (!travaux) {
    return {
      montant_total: null,
      description: null,
      travauxParM2: null,
      ratioTravauxPrix: null,
    };
  }

  const montant: number | null =
    typeof travaux.montant_total === "number" ? travaux.montant_total : null;
  const description: string | null = travaux.description ?? null;

  let travauxParM2: number | null = null;
  let ratioTravauxPrix: number | null = null;

  if (montant !== null && surface && surface > 0) {
    travauxParM2 = montant / surface;
  }

  if (montant !== null && prix && prix > 0) {
    ratioTravauxPrix = montant / prix;
  }

  return {
    montant_total: montant,
    description,
    travauxParM2,
    ratioTravauxPrix,
  };
}

/* ============================================================================================
   🏙️ PLU (stub)
============================================================================================ */

async function fetchPLUSummary() {
  const plu: {
    status: StatusFlag;
    notes: string[];
  } = {
    status: "not_implemented",
    notes: ["PLU non encore connecté — prévu en v4.1"],
  };

  return plu;
}

/* ============================================================================================
   ⚠️ Risques (stub)
============================================================================================ */

async function fetchRisksSummary() {
  const risques: {
    status: StatusFlag;
    notes: string[];
  } = {
    status: "not_implemented",
    notes: ["Risques non encore intégrés — prévu en v4.1"],
  };

  return risques;
}

/* ============================================================================================
   🚆 Transport (stub)
============================================================================================ */

async function fetchTransportSummary() {
  const transports: {
    status: StatusFlag;
    notes: string[];
  } = {
    status: "not_implemented",
    notes: ["Transport GTFS pas encore connecté — prévu en v4.1"],
  };

  return transports;
}

/* ============================================================================================
   👥 Socio-éco INSEE (réel)
============================================================================================ */

async function fetchSocioEcoSummary(
  supabase: any,
  body: any,
): Promise<SocioEcoModule> {
  // On essaye plusieurs clés possibles pour le code INSEE
  const codeInsee: string | null =
    body.code_insee_commune ??
    body.code_insee ??
    body.insee ??
    body?.bien?.code_insee_commune ??
    null;

  if (!codeInsee) {
    return {
      status: "missing",
      notes: [
        "Code INSEE non fourni dans la requête — impossible de récupérer les stats démographiques.",
      ],
    };
  }

  const stats = await fetchInseeCommuneStats(supabase, codeInsee);

  if (!stats) {
    return {
      status: "missing",
      notes: [
        `Aucune donnée INSEE trouvée pour le code commune ${codeInsee} dans insee_communes_stats.`,
      ],
      code_commune: codeInsee,
    };
  }

  return {
    status: "ok",
    notes: [
      `Données INSEE récupérées pour la commune ${stats.commune} (${stats.code_commune}).`,
      `Population totale ≈ ${stats.population?.toLocaleString("fr-FR") ?? "N/A"} habitants.`,
      `Moins de 25 ans : ${stats.pct_moins_25 ?? "N/A"} %, 65 ans et plus : ${stats.pct_plus_65 ?? "N/A"} %.`,
    ],
    code_commune: stats.code_commune,
    commune: stats.commune,
    population: stats.population,
    pct_moins_25: stats.pct_moins_25,
    pct_plus_65: stats.pct_plus_65,
  };
}

/* ============================================================================================
   📊 MarketInsights
============================================================================================ */

function computeMarketInsights(dvf: any) {
  if (!dvf || !dvf.pricePerM2 || !dvf.medianM2 || dvf.deltaVsMedian == null) {
    return {
      pricePerM2: dvf?.pricePerM2 ?? null,
      medianM2: dvf?.medianM2 ?? null,
      deltaVsMedian: dvf?.deltaVsMedian ?? null,
      classification: "inconnu",
      liquidityBand: "inconnue",
      note: "Pas assez de données DVF.",
    };
  }

  let classification = "Prix cohérent";
  if (dvf.deltaVsMedian < -10) classification = "Bonne affaire (prix bas)";
  if (dvf.deltaVsMedian > 10) classification = "Prix élevé";

  let liquidityBand = "Normale";
  if (dvf.transactions && dvf.transactions > 300) liquidityBand = "Très liquide";
  else if (dvf.transactions && dvf.transactions < 50) liquidityBand = "Peu liquide";

  return {
    pricePerM2: dvf.pricePerM2,
    medianM2: dvf.medianM2,
    deltaVsMedian: dvf.deltaVsMedian,
    classification,
    liquidityBand,
    note: `Le bien est ${classification}, marché ${liquidityBand}.`,
  };
}

/* ============================================================================================
   🧩 SmartScore Stub (fallback) – dynamique DVF + travaux + rendement
============================================================================================ */

function buildSmartscoreStub(raw: any) {
  // raw = { mode, context }
  const mode = raw?.mode ?? "standard";
  const ctx = raw?.context ?? raw ?? {};

  const dvf = ctx.dvfSummary ?? null;
  const travauxSummary = ctx.travauxSummary ?? null;

  const delta =
    typeof dvf?.deltaVsMedian === "number" ? dvf.deltaVsMedian : null;
  const transactions =
    typeof dvf?.transactions === "number" ? dvf.transactions : null;
  const travauxParM2 =
    typeof travauxSummary?.travauxParM2 === "number"
      ? travauxSummary.travauxParM2
      : null;
  const ratioTravauxPrix =
    typeof travauxSummary?.ratioTravauxPrix === "number"
      ? travauxSummary.ratioTravauxPrix
      : null;

  const prix =
    typeof ctx.prix === "number" ? ctx.prix : null;
  const loyerMensuel =
    typeof ctx.loyer_mensuel === "number" ? ctx.loyer_mensuel : null;

  const rendementBrut =
    prix && loyerMensuel ? (loyerMensuel * 12) / prix : null; // ex: 0.035 = 3,5%

  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  /* ============================================================================
     🧮 Score global – base 70, DVF continu + rendement + travaux + liquidité
  ============================================================================ */

  let globalScore = 70;

  // Impact continu du delta vs médiane DVF
  if (delta !== null) {
    const impactDVF = Math.max(-15, Math.min(15, delta / 5));
    // delta > 0 (trop cher) → impactDVF positif → on soustrait → score baisse
    // delta < 0 (sous le marché) → impactDVF négatif → on soustrait un négatif → score monte
    globalScore -= impactDVF;
  }

  // Impact du rendement brut
  if (rendementBrut !== null) {
    if (rendementBrut < 0.02) {
      globalScore -= 10; // < 2% → très faible
    } else if (rendementBrut < 0.03) {
      globalScore -= 5;  // 2–3%
    } else if (rendementBrut > 0.05) {
      globalScore += 6;  // > 5% → très bon
    } else if (rendementBrut > 0.04) {
      globalScore += 3;  // 4–5%
    }
  }

  // Poids des travaux dans le prix
  if (ratioTravauxPrix !== null) {
    if (ratioTravauxPrix > 0.25) globalScore -= 5;
    else if (ratioTravauxPrix > 0.15) globalScore -= 3;
    else if (ratioTravauxPrix < 0.05) globalScore += 2;
  }

  // Volume de transactions DVF (liquidité)
  if (transactions !== null) {
    if (transactions > 800) globalScore += 2;
    else if (transactions < 100) globalScore -= 3;
  }

  globalScore = clamp(globalScore, 0, 100);

  /* ============================================================================
     🧱 Pilier 1 – Emplacement & environnement
  ============================================================================ */

  let emplacement_env = 70;
  if (transactions !== null) {
    if (transactions > 800) emplacement_env = 85;
    else if (transactions > 300) emplacement_env = 78;
    else if (transactions < 50) emplacement_env = 60;
  }

  /* ============================================================================
     📈 Pilier 2 – Marché & liquidité
  ============================================================================ */

  let marche_liquidite = 70;
  if (transactions !== null) {
    if (transactions > 800) marche_liquidite = 85;
    else if (transactions > 300) marche_liquidite = 75;
    else if (transactions < 50) marche_liquidite = 55;
  }

  /* ============================================================================
     🏡 Pilier 3 – Qualité du bien (proxy : travaux/m²)
  ============================================================================ */

  let qualite_bien = 70;
  if (travauxParM2 !== null) {
    if (travauxParM2 > 1000) qualite_bien -= 10;
    else if (travauxParM2 > 500) qualite_bien -= 5;
  }

  /* ============================================================================
     💰 Pilier 4 – Rentabilité & prix
     → gros poids sur DVF + rendement brut
  ============================================================================ */

  let rentabilite_prix = 70;

  if (delta !== null) {
    const impactDVF = Math.max(-20, Math.min(20, delta / 4)); // plus sensible qu’en global
    rentabilite_prix -= impactDVF;
  }

  if (rendementBrut !== null) {
    if (rendementBrut < 0.02) {
      rentabilite_prix -= 15;
    } else if (rendementBrut < 0.03) {
      rentabilite_prix -= 8;
    } else if (rendementBrut > 0.05) {
      rentabilite_prix += 12;
    } else if (rendementBrut > 0.04) {
      rentabilite_prix += 8;
    }
  }

  /* ============================================================================
     ⚠️ Pilier 5 – Risques & complexités
     → gros travaux, faible liquidité, rendement faible = plus de risque
  ============================================================================ */

  let risques_complexite = 45;

  if (ratioTravauxPrix !== null && ratioTravauxPrix > 0.25) {
    risques_complexite -= 5;
  }

  if (transactions !== null && transactions < 50) {
    risques_complexite -= 5;
  }

  if (rendementBrut !== null && rendementBrut < 0.025) {
    risques_complexite -= 5;
  }

  emplacement_env = clamp(emplacement_env, 0, 100);
  marche_liquidite = clamp(marche_liquidite, 0, 100);
  qualite_bien = clamp(qualite_bien, 0, 100);
  rentabilite_prix = clamp(rentabilite_prix, 0, 100);
  risques_complexite = clamp(risques_complexite, 0, 100);

  /* ============================================================================
     📝 Executive summary dynamique
  ============================================================================ */

  let execSummary =
    "Le bien présente un équilibre global entre emplacement, marché et valorisation potentielle.";

  if (delta !== null && dvf?.medianM2 && dvf.pricePerM2) {
    if (delta < -10) {
      execSummary =
        "Le bien semble attractif en prix par rapport au marché local, avec un potentiel intéressant de valorisation patrimoniale.";
    } else if (delta > 10) {
      execSummary =
        "Le bien apparaît positionné au-dessus de la médiane du marché, ce qui impose une vigilance particulière sur la négociation et la stratégie de sortie.";
    } else {
      execSummary =
        "Le bien est globalement aligné avec les niveaux de prix observés sur le marché local, sans décote ni surcote majeure.";
    }
  }

  if (rendementBrut !== null) {
    if (rendementBrut < 0.025) {
      execSummary +=
        " Le rendement locatif brut ressort à un niveau plutôt faible, ce qui réduit l’attrait en termes de cashflow.";
    } else if (rendementBrut > 0.045) {
      execSummary +=
        " Le rendement locatif brut est intéressant, ce qui améliore l’équilibre global entre prix et cashflow.";
    }
  }

  return {
    success: true,
    globalScore,
    pillarScores: {
      emplacement_env,
      marche_liquidite,
      qualite_bien,
      rentabilite_prix,
      risques_complexite,
    },
    usedCriteriaCount: 15,
    activePillars: [
      "emplacement_env",
      "marche_liquidite",
      "qualite_bien",
      "rentabilite_prix",
      "risques_complexite",
    ],
    mode,
    messages: [
      "SmartScore calculé par le moteur interne Mimmoza v4 (fallback sans IA externe).",
    ],
    report: {
      executiveSummary: execSummary,
      pillarDetails: {
        emplacement_env:
          "Le score d’emplacement reflète l’attractivité générale du secteur, en lien avec le volume de transactions et la profondeur de marché.",
        marche_liquidite:
          "Le score de liquidité traduit la facilité potentielle de revente, basée sur le nombre de ventes DVF observées.",
        qualite_bien:
          "La qualité intrinsèque du bien est approchée à travers l’importance des travaux rapportée à la surface.",
        rentabilite_prix:
          "Le score prix/rentabilité repose sur l’écart entre le prix au m² du bien et la médiane DVF locale, complété par le rendement locatif brut.",
        risques_complexite:
          "Les risques et complexités intègrent l’effort travaux, la dynamique de marché et le niveau de rendement locatif, à surveiller dans les due diligences.",
      },
      recommendations:
        "Avant de se positionner, vérifier le détail des ventes DVF comparables, la nature des travaux à réaliser, le niveau de loyers réalistes et les risques techniques ou juridiques associés.",
      forecast: {
        horizon: "3 à 5 ans",
        appreciationScenario:
          "Sous hypothèse de marché neutre, le potentiel de valorisation dépendra du niveau d’entrée en prix et de la bonne exécution des travaux éventuels.",
        cashflowScenario:
          "Le cashflow dépendra fortement du couple prix d’acquisition / loyers, à simuler en tenant compte de la fiscalité et du financement.",
      },
    },
    debug: {
      fallback: true,
      dvfUsed: dvf !== null,
      travauxUsed: travauxSummary !== null,
      rendementBrut,
    },
  };
}

/* ============================================================================================
   🤖 SmartScore Agent – appel interne avec fallback stub
============================================================================================ */

async function callSmartscoreAgentOrStub(
  context: any,
  mode: string,
) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const apiSecret = getApiSecretFromEnv();

  if (!supabaseUrl || !apiSecret) {
    console.error("❌ Missing SUPABASE_URL or API secret – using stub SmartScore.");
    return buildSmartscoreStub({ mode, context });
  }

  const url = `${supabaseUrl}/functions/v1/smartscore-agent-v1`;

  const payload = {
    mode,
    source: "smartscore-enriched-v4",
    context,
  };

  console.log("📤 Calling smartscore-agent-v1 with payload (short):", {
    mode,
    hasDvfs: !!context.dvfSummary,
    hasTravaux: !!context.travauxSummary,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiSecret,
        Authorization: `Bearer ${apiSecret}`,
      },
      body: JSON.stringify(payload),
    });

    let json: any = null;
    try {
      json = await res.json();
    } catch {
      const text = await res.text().catch(() => "");
      console.error("❌ smartscore-agent-v1 invalid JSON:", res.status, text);
      return buildSmartscoreStub({ mode, context });
    }

    if (!res.ok || !json || json.success === false || json.code) {
      console.error(
        "⚠️ smartscore-agent-v1 non-success, using stub. Status:",
        res.status,
        "Body:",
        json,
      );
      return buildSmartscoreStub({ mode, context });
    }

    console.log("✅ smartscore-agent-v1 response (used):", json);
    return json;
  } catch (e) {
    console.error("❌ smartscore-agent-v1 call failed, using stub:", e);
    return buildSmartscoreStub({ mode, context });
  }
}

/* ============================================================================================
   💾 Stockage du rapport en base
============================================================================================ */

async function storeSmartscoreReport(
  supabase: any,
  record: {
    input: any;
    smartscore: any;
    dvfSummary: any;
    travauxSummary: any;
    enrichedModules: any;
  },
) {
  try {
    const input = record.input ?? {};

    const { error } = await supabase.from("smartscore_reports_v4").insert({
      source: "smartscore-enriched-v4",

      // Infos bien
      address: input.address ?? null,
      cp: input.cp ?? null,
      ville: input.ville ?? null,
      surface: input.surface ?? null,
      prix: input.prix ?? null,
      type_local: input.type_local ?? null,
      melo_id: input.meloId ?? null,

      // Données utilisateur
      user_criteria: input.userCriteria ?? null,

      // Blocs calculés
      dvf_summary: record.dvfSummary ?? null,
      travaux_summary: record.travauxSummary ?? null,
      enriched_modules: record.enrichedModules ?? null,
      smartscore: record.smartscore ?? null,

      // Body brut reçu
      raw_input: input ?? null,
    });

    if (error) {
      console.error("❌ storeSmartscoreReport – insert error:", error);
    } else {
      console.log("✅ storeSmartscoreReport – insert OK");
    }
  } catch (e) {
    console.error("❌ storeSmartscoreReport – unexpected error:", e);
  }
}

/* ============================================================================================
   🚀 MAIN HANDLER
============================================================================================ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    console.log("📥 smartscore-enriched-v4 – body reçu:", body);

    const mode: string = body.mode ?? "standard";

    const supabase = getSupabaseClient();

    /* 1. DVF */
    const dvfSummary = await fetchDVFSummary(
      supabase,
      body.cp,
      body.type_local,
      body.prix,
      body.surface,
    );

    /* 2. Travaux */
    const travauxSummary = computeTravauxSummary(
      body.travaux,
      body.prix,
      body.surface,
    );

    /* 3. Modules enrichis V4 (dont INSEE réel) */
    const [pluSummary, risksSummary, transportSummary, socioEcoSummary] =
      await Promise.all([
        fetchPLUSummary(),
        fetchRisksSummary(),
        fetchTransportSummary(),
        fetchSocioEcoSummary(supabase, body),
      ]);

    /* 4. Market Insights */
    const marketInsights = computeMarketInsights(dvfSummary);

    /* 5. Contexte envoyé à l’agent SmartScore (compatible V3) */
    const contextForAgent = {
      address: body.address,
      cp: body.cp,
      ville: body.ville,
      surface: body.surface,
      prix: body.prix,
      type_local: body.type_local,
      loyer_mensuel: body.loyer_mensuel, // 🔥 nouveau
      travaux: body.travaux,
      userCriteria: body.userCriteria,
      meloId: body.meloId,
      dvfSummary,
      travauxSummary,
    };

    /* 6. SmartScore AI (agent ou fallback stub) */
    const agentResponse = await callSmartscoreAgentOrStub(
      contextForAgent,
      mode,
    );

    /* 7. insee_stats dérivé du module socio-éco */
    const inseeStats =
      socioEcoSummary && socioEcoSummary.status === "ok"
        ? {
            code_commune: socioEcoSummary.code_commune ?? null,
            commune: socioEcoSummary.commune ?? null,
            population: socioEcoSummary.population ?? null,
            pct_moins_25: socioEcoSummary.pct_moins_25 ?? null,
            pct_plus_65: socioEcoSummary.pct_plus_65 ?? null,
          }
        : null;

    /* 8. Modules enrichis + payload */
    const enrichedModules = {
      plu: pluSummary,
      risques: risksSummary,
      transports: transportSummary,
      socioEco: socioEcoSummary,
      marketInsights,
    };

    const responsePayload = {
      success: true,
      version: "v4",
      orchestrator: "smartscore-enriched-v4",

      smartscore: agentResponse ?? null,
      dvfSummary,
      travauxSummary,
      insee_stats: inseeStats,
      enrichedModules,
      input: body,
    };

    console.log("✅ smartscore-enriched-v4 – response:", {
      version: responsePayload.version,
      hasSmartscore: !!responsePayload.smartscore,
      hasInsee: !!responsePayload.insee_stats,
    });

    // 💾 On stocke le rapport en base
    await storeSmartscoreReport(supabase, {
      input: body,
      smartscore: agentResponse ?? null,
      dvfSummary,
      travauxSummary,
      enrichedModules,
    });

    return new Response(JSON.stringify(responsePayload), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("❌ Error smartscore-enriched-v4:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err?.message ?? "Unexpected error in smartscore-enriched-v4",
      }),
      { status: 500, headers: corsHeaders },
    );
  }
});
