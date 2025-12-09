// supabase/functions/smartscore-enriched-v2/index.ts
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

console.log("✅ smartscore-enriched-v2 – function loaded");

// Petit helper pour vérifier la clé API
function checkApiKey(req: Request) {
  const headerKey = req.headers.get("x-api-key");
  const secretKey = Deno.env.get("API_SECRET_KEY"); // à définir dans Supabase secrets
  const origin = req.headers.get("origin") || "";

  // 🔓 Mode "dev front" : requête venant d'un navigateur sans x-api-key → on autorise
  if (origin && !headerKey) {
    console.log(
      "⚠️ smartscore-enriched-v2 – requête sans x-api-key mais avec Origin, on autorise temporairement. Origin:",
      origin,
    );
    return true;
  }

  // Si pas de secret défini côté Supabase, on n'applique pas de contrôle strict
  if (!secretKey) {
    console.log(
      "⚠️ smartscore-enriched-v2 – API_SECRET_KEY non défini, aucune vérification stricte appliquée.",
    );
    return true;
  }

  // Mode "secure" classique (scripts backend)
  return headerKey === secretKey;
}

interface UserCriteriaScores {
  [key: string]: unknown;
}

interface SmartscoreInput {
  address: string;
  postal_code: string;
  city: string;
  type_local: "Appartement" | "Maison" | "Immeuble" | "Terrain" | string;
  surface: number | null;
  price: number | null;

  expected_rent?: number | null;
  charges_mensuelles?: number | null;

  userCriteriaScores?: UserCriteriaScores;

  userProfile?: {
    persona?: string;
    horizon?: string;
    fiscalite?: string | null;
  };

  // données de l'estimateur travaux (si dispo)
  travaux_estimation?: any;

  mode?: "standard" | "advanced";
}

export async function handlePost(req: Request): Promise<Response> {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    // Vérif clé API (assouplie pour le front)
    if (!checkApiKey(req)) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = (await req.json().catch(() => null)) as SmartscoreInput | null;
    console.log("📥 smartscore-enriched-v2 – body reçu:", body);

    if (!body) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid JSON body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const {
      address,
      postal_code,
      city,
      type_local,
      surface,
      price,
      userCriteriaScores = {},
      userProfile,
      travaux_estimation,
      mode = "standard",
      expected_rent,
      charges_mensuelles,
    } = body;

    if (!postal_code || !type_local) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "postal_code et type_local sont obligatoires",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // 1️⃣ Récup DVF
    const { data: dvfStats, error: dvfError } = await supabase.rpc(
      "get_dvf_stats_for_cp_type",
      {
        p_code_postal: postal_code,
        p_type_local: type_local,
      }
    );

    if (dvfError) {
      console.error("❌ Erreur DVF:", dvfError);
    } else {
      console.log("📊 DVF stats:", dvfStats);
    }

    // 2️⃣ Récup PLU (optionnel)
    const { data: pluContext, error: pluError } = await supabase.rpc(
      "get_plu_context_for_address",
      {
        p_address: address,
        p_postal_code: postal_code,
        p_city: city,
      }
    );

    if (pluError) {
      console.error("❌ Erreur PLU:", pluError);
    } else {
      console.log("🏗️ PLU context:", pluContext);
    }

    // 3️⃣ Calculs dérivés DVF / rentabilité
    let price_per_m2: number | null = null;
    if (price && surface && surface > 0) {
      price_per_m2 = price / surface;
    }

    const dvfMedian = (dvfStats as any)?.median_price_m2 ?? null;
    let delta_vs_median: number | null = null;
    let price_position: "au-dessus" | "dans_la_fourchette" | "en-dessous" | null = null;

    if (price_per_m2 && dvfMedian && dvfMedian > 0) {
      delta_vs_median = ((price_per_m2 - dvfMedian) / dvfMedian) * 100;
      if (delta_vs_median > 10) price_position = "au-dessus";
      else if (delta_vs_median < -10) price_position = "en-dessous";
      else price_position = "dans_la_fourchette";
    }

    let gross_yield: number | null = null;
    if (expected_rent && price && price > 0) {
      gross_yield = (expected_rent * 12 * 100) / price;
    }

    // 4️⃣ Calcul SmartScore global & par pilier

    // Toutes les valeurs numériques pour info / fallback
    const allNumeric: number[] = [];
    for (const v of Object.values(userCriteriaScores)) {
      if (typeof v === "number" && !Number.isNaN(v)) {
        allNumeric.push(v);
      }
    }
    const usedCriteriaCount = allNumeric.length;

    // Buckets par pilier basés sur les noms de critères
    const pillarBuckets: Record<string, string[]> = {
      emplacement_env: [
        "location_macro",
        "location_micro",
        "transport_access",
        "amenities",
      ],
      marche_liquidite: [
        "market_dynamism",
        "market_liquidity",
        "market_demand_depth",
      ],
      qualite_bien: [
        "condition_interior",
        "condition_building",
        "layout_quality",
        "value_creation_potential",
      ],
      rentabilite_prix: [
        "cashflow_feeling",
        "yield_manual",
        "price_vs_market_manual",
      ],
      risques_complexite: [
        "risk_complexity",
      ],
    };

    function avgScoreForKeys(keys: string[]): number | null {
      const vals: number[] = [];
      for (const k of keys) {
        const raw = (userCriteriaScores as any)[k];
        if (typeof raw === "number" && !Number.isNaN(raw)) {
          vals.push(raw);
        }
      }
      if (vals.length === 0) return null;
      const avg10 = vals.reduce((a, v) => a + v, 0) / vals.length;
      return Math.round(avg10 * 10); // → 0–100
    }

    // Calcul des scores par pilier
    const pillarScores: {
      emplacement_env: number | null;
      marche_liquidite: number | null;
      qualite_bien: number | null;
      rentabilite_prix: number | null;
      risques_complexite: number | null;
    } = {
      emplacement_env: avgScoreForKeys(pillarBuckets.emplacement_env),
      marche_liquidite: avgScoreForKeys(pillarBuckets.marche_liquidite),
      qualite_bien: avgScoreForKeys(pillarBuckets.qualite_bien),
      rentabilite_prix: avgScoreForKeys(pillarBuckets.rentabilite_prix),
      risques_complexite: avgScoreForKeys(pillarBuckets.risques_complexite),
    };

    const numericPillars: number[] = [];
    const activePillars: string[] = [];

    (Object.entries(pillarScores) as [keyof typeof pillarScores, number | null][])
      .forEach(([key, value]) => {
        if (value != null) {
          numericPillars.push(value);
          activePillars.push(key as string);
        }
      });

    // Global = moyenne des piliers non nuls, sinon fallback sur toutes les notes
    let globalScore: number | null = null;
    if (numericPillars.length > 0) {
      const avg = numericPillars.reduce((a, v) => a + v, 0) / numericPillars.length;
      globalScore = Math.round(avg);
    } else if (usedCriteriaCount > 0) {
      const avg10 = allNumeric.reduce((a, v) => a + v, 0) / usedCriteriaCount;
      globalScore = Math.round(avg10 * 10);
    }

    // 5️⃣ Payload enrichi renvoyé au front + IA
    const enrichedPayload = {
      success: true,
      mode,
      timestamp: new Date().toISOString(),

      // SmartScore pour le front
      globalScore,
      pillarScores,
      usedCriteriaCount,
      activePillars,

      smartscore: {
        globalScore,
        pillarScores,
        usedCriteriaCount,
        activePillars,
      },

      input: {
        address,
        postal_code,
        city,
        type_local,
        surface,
        price,
        expected_rent,
        charges_mensuelles,
        userProfile,
        userCriteriaScores,
        travaux_estimation,
      },

      dvfContext: {
        has_data: !!dvfStats,
        raw: dvfStats,
        price_per_m2,
        dvf_median_price_m2: dvfMedian,
        delta_vs_median_percent: delta_vs_median,
        price_position_vs_market: price_position,
      },

      pluContext: {
        has_data: !!pluContext,
        raw: pluContext,
      },

      derivedMetrics: {
        gross_yield_percent: gross_yield,
      },
    };

    return new Response(JSON.stringify(enrichedPayload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ smartscore-enriched-v2 – erreur:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

Deno.serve(handlePost);
