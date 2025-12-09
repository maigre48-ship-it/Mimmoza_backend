// supabase/functions/smartscore-manual-v1/index.ts
import { serve } from "https://deno.land/std/http/server.ts";

// ---------- CORS ----------
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Helper pour toujours répondre avec 200 + JSON
function ok(body: any) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Types d'entrée : tous les champs sont optionnels
 */
type SmartScoreInputs = {
  price?: number | null;
  estimatedRent?: number | null;
  estimatedMarketPrice?: number | null;

  // Pilier 1 : Emplacement & environnement (0-10)
  location_macro?: number | null;
  location_micro?: number | null;
  transport_access?: number | null;
  amenities?: number | null;

  // Pilier 2 : Marché & liquidité (0-10)
  market_dynamism?: number | null;
  market_liquidity?: number | null;
  market_demand_depth?: number | null;

  // Pilier 3 : Qualité intrinsèque du bien (0-10)
  condition_interior?: number | null;
  condition_building?: number | null;
  layout_quality?: number | null;
  value_creation_potential?: number | null;

  // Pilier 4 : Rentabilité & prix
  rental_yield_manual?: number | null;
  price_vs_market_manual?: number | null;
  cashflow_feeling?: number | null;

  // Pilier 5 : Risques & complexités (0-10)
  risk_complexity?: number | null;
};

type SmartScorePillarScores = {
  emplacement_env: number | null;
  marche_liquidite: number | null;
  qualite_bien: number | null;
  rentabilite_prix: number | null;
  risques_complexite: number | null;
};

type SmartScoreResultV1 = {
  success: boolean;
  globalScore: number | null;
  pillarScores: SmartScorePillarScores;
  usedCriteriaCount: number;
  activePillars: (keyof SmartScorePillarScores)[];
  messages: string[];
};

/**
 * Nettoie une note 0-10 (ignore undefined, null, NaN, valeurs hors bornes)
 */
function cleanNote(value?: number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (isNaN(n)) return null;
  if (n < 0 || n > 10) return null;
  return n;
}

/**
 * Convertit un rendement brut (en %) en note 0-10.
 */
function yieldPercentToScore(yieldPercent: number): number {
  if (yieldPercent <= 0) return 0;
  if (yieldPercent < 3) return 2;
  if (yieldPercent < 4) return 4;
  if (yieldPercent < 5) return 6;
  if (yieldPercent < 6) return 8;
  if (yieldPercent < 7) return 9;
  return 10;
}

/**
 * Convertit un écart prix / marché en note 0-10.
 */
function priceDeltaToScore(delta: number): number {
  if (delta >= 0.30) return 1;
  if (delta >= 0.20) return 3;
  if (delta >= 0.10) return 5;
  if (delta >= -0.05) return 7;
  if (delta >= -0.15) return 8;
  if (delta >= -0.25) return 9;
  return 10;
}

/**
 * Calcule un score de pilier (0-100) à partir de notes 0-10 + poids internes.
 * Retourne null si moins de 2 critères renseignés.
 */
function computePillarScore(
  notes: (number | null)[],
  weights: number[],
): { score: number | null; usedCount: number } {
  const filled: { value: number; weight: number }[] = [];
  notes.forEach((n, i) => {
    if (n !== null && !isNaN(n)) {
      filled.push({ value: n, weight: weights[i] });
    }
  });

  const usedCount = filled.length;
  if (usedCount === 0) {
    return { score: null, usedCount: 0 };
  }
  if (usedCount < 2) {
    return { score: null, usedCount };
  }

  const totalWeight = filled.reduce((sum, item) => sum + item.weight, 0);
  let sum = 0;
  for (const item of filled) {
    const normalizedWeight = item.weight / totalWeight;
    sum += (item.value / 10) * 100 * normalizedWeight;
  }

  const finalScore = Math.round(Math.max(0, Math.min(100, sum)));
  return { score: finalScore, usedCount };
}

/**
 * SmartScore V1 "manuel" multi-critères.
 */
function computeSmartScoreV1(inputs: SmartScoreInputs): SmartScoreResultV1 {
  const messages: string[] = [];

  // --- Pilier 1 : Emplacement & environnement (25 %) ---
  const p1Notes = [
    cleanNote(inputs.location_macro),
    cleanNote(inputs.location_micro),
    cleanNote(inputs.transport_access),
    cleanNote(inputs.amenities),
  ];
  const p1Weights = [0.3, 0.35, 0.2, 0.15];
  const p1 = computePillarScore(p1Notes, p1Weights);

  // --- Pilier 2 : Marché & liquidité (20 %) ---
  const p2Notes = [
    cleanNote(inputs.market_dynamism),
    cleanNote(inputs.market_liquidity),
    cleanNote(inputs.market_demand_depth),
  ];
  const p2Weights = [0.4, 0.35, 0.25];
  const p2 = computePillarScore(p2Notes, p2Weights);

  // --- Pilier 3 : Qualité intrinsèque du bien (25 %) ---
  const p3Notes = [
    cleanNote(inputs.condition_interior),
    cleanNote(inputs.condition_building),
    cleanNote(inputs.layout_quality),
    cleanNote(inputs.value_creation_potential),
  ];
  const p3Weights = [0.3, 0.25, 0.25, 0.2];
  const p3 = computePillarScore(p3Notes, p3Weights);

  // --- Pilier 4 : Rentabilité & prix (25 %) ---
  let c12Score: number | null = null;
  if (inputs.price && inputs.estimatedRent) {
    const yieldPercent = (12 * inputs.estimatedRent) / inputs.price * 100;
    c12Score = yieldPercentToScore(yieldPercent);
  } else if (inputs.rental_yield_manual != null) {
    c12Score = cleanNote(inputs.rental_yield_manual);
  }

  let c13Score: number | null = null;
  if (inputs.price && inputs.estimatedMarketPrice) {
    const delta =
      (inputs.price - inputs.estimatedMarketPrice) /
      inputs.estimatedMarketPrice;
    c13Score = priceDeltaToScore(delta);
  } else if (inputs.price_vs_market_manual != null) {
    c13Score = cleanNote(inputs.price_vs_market_manual);
  }

  const c14Score = cleanNote(inputs.cashflow_feeling);

  const p4Notes = [c12Score, c13Score, c14Score];
  const p4Weights = [0.4, 0.4, 0.2];
  const p4 = computePillarScore(p4Notes, p4Weights);

  // --- Pilier 5 : Risques & complexités (5 %) ---
  const riskScore = cleanNote(inputs.risk_complexity);
  const p5 = computePillarScore([riskScore], [1]);

  const usedCriteriaCount =
    p1.usedCount + p2.usedCount + p3.usedCount + p4.usedCount + p5.usedCount;

  const pillarScores: SmartScorePillarScores = {
    emplacement_env: p1.score,
    marche_liquidite: p2.score,
    qualite_bien: p3.score,
    rentabilite_prix: p4.score,
    risques_complexite: p5.score,
  };

  const pillarWeights: Record<keyof SmartScorePillarScores, number> = {
    emplacement_env: 0.25,
    marche_liquidite: 0.20,
    qualite_bien: 0.25,
    rentabilite_prix: 0.25,
    risques_complexite: 0.05,
  };

  const activePillars = (Object.keys(pillarScores) as (keyof SmartScorePillarScores)[])
    .filter((key) => pillarScores[key] !== null);

  const requiredForReliability: (keyof SmartScorePillarScores)[] = [
    "emplacement_env",
    "qualite_bien",
    "rentabilite_prix",
  ];

  const hasAllRequired = requiredForReliability.every((k) =>
    pillarScores[k] !== null
  );

  let globalScore: number | null = null;
  const messagesOut: string[] = [];

  if (!hasAllRequired || activePillars.length < 3 || usedCriteriaCount < 6) {
    globalScore = null;
    messagesOut.push(
      "Informations insuffisantes pour calculer un SmartScore global fiable.",
      "Renseignez au minimum 6 critères répartis sur l’emplacement, la qualité du bien et la rentabilité/prix.",
    );
  } else {
    const totalActiveWeight = activePillars.reduce(
      (sum, k) => sum + pillarWeights[k],
      0,
    );

    let sum = 0;
    for (const k of activePillars) {
      const pillarScore = pillarScores[k]!;
      const normalizedWeight = pillarWeights[k] / totalActiveWeight;
      sum += pillarScore * normalizedWeight;
    }

    globalScore = Math.round(Math.max(0, Math.min(100, sum)));
  }

  // Messages explicatifs basés sur les scores de piliers
  if (pillarScores.emplacement_env != null) {
    if (pillarScores.emplacement_env >= 75) {
      messagesOut.push("Emplacement globalement très favorable.");
    } else if (pillarScores.emplacement_env <= 50) {
      messagesOut.push(
        "Emplacement perfectible : quartier / environnement à examiner de près.",
      );
    }
  }

  if (pillarScores.qualite_bien != null) {
    if (pillarScores.qualite_bien >= 75) {
      messagesOut.push("Qualité intrinsèque du bien jugée bonne à très bonne.");
    } else if (pillarScores.qualite_bien <= 50) {
      messagesOut.push(
        "Qualité du bien moyenne : état, immeuble ou agencement peuvent nécessiter des travaux.",
      );
    }
  }

  if (pillarScores.rentabilite_prix != null) {
    if (pillarScores.rentabilite_prix >= 75) {
      messagesOut.push(
        "Couple rentabilité / prix perçu comme attractif par rapport au marché.",
      );
    } else if (pillarScores.rentabilite_prix <= 50) {
      messagesOut.push(
        "Rentabilité ou niveau de prix à challenger : prudence sur la valorisation.",
      );
    }
  }

  if (pillarScores.risques_complexite != null) {
    if (pillarScores.risques_complexite <= 50) {
      messagesOut.push(
        "Dossier perçu comme complexe ou risqué : bien vérifier les aspects juridiques et techniques.",
      );
    }
  }

  if (globalScore !== null) {
    if (globalScore >= 80) {
      messagesOut.push(
        "SmartScore élevé : dossier globalement très intéressant sous réserve de vérifications classiques.",
      );
    } else if (globalScore >= 60) {
      messagesOut.push(
        "SmartScore correct : opportunité intéressante mais avec des points à analyser plus finement.",
      );
    } else {
      messagesOut.push(
        "SmartScore modéré : plusieurs dimensions sont perfectibles, une forte décote ou une stratégie spécifique peuvent être nécessaires.",
      );
    }
  }

  return {
    success: true,
    globalScore,
    pillarScores,
    usedCriteriaCount,
    activePillars,
    messages: messagesOut,
  };
}

// ---------- HANDLER HTTP ----------
serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return ok({ success: true, message: "ok" });
    }

    if (req.method !== "POST") {
      return ok({
        success: false,
        globalScore: null,
        pillarScores: {
          emplacement_env: null,
          marche_liquidite: null,
          qualite_bien: null,
          rentabilite_prix: null,
          risques_complexite: null,
        },
        usedCriteriaCount: 0,
        activePillars: [],
        messages: ["Méthode non autorisée (POST uniquement)."],
      });
    }

    const rawBody = await req.json().catch(() => null);

    if (!rawBody || typeof rawBody !== "object") {
      return ok({
        success: false,
        globalScore: null,
        pillarScores: {
          emplacement_env: null,
          marche_liquidite: null,
          qualite_bien: null,
          rentabilite_prix: null,
          risques_complexite: null,
        },
        usedCriteriaCount: 0,
        activePillars: [],
        messages: ["Corps de requête JSON invalide."],
      });
    }

    // Base44 peut envoyer soit { ...inputs } soit { inputs: { ... } }
    const body = rawBody as any;
    const inputs: SmartScoreInputs = (body.inputs && typeof body.inputs === "object")
      ? body.inputs
      : body;

    const result = computeSmartScoreV1(inputs);

    return ok(result);
  } catch (err) {
    console.error("GLOBAL ERROR smartscore-manual-v1", err);
    return ok({
      success: false,
      globalScore: null,
      pillarScores: {
        emplacement_env: null,
        marche_liquidite: null,
        qualite_bien: null,
        rentabilite_prix: null,
        risques_complexite: null,
      },
      usedCriteriaCount: 0,
      activePillars: [],
      messages: ["Erreur interne lors du calcul du SmartScore."],
    });
  }
});
