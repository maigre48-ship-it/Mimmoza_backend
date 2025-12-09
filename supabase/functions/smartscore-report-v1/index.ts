// supabase/functions/smartscore-enriched-v2/index.ts
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

console.log("✅ smartscore-enriched-v2 – function loaded");

// Petit helper pour vérifier la clé API
function checkApiKey(req: Request) {
  const headerKey = req.headers.get("x-api-key");
  const secretKey = Deno.env.get("API_SECRET_KEY"); // à définir dans Supabase secrets
  const origin = req.headers.get("origin") || "";

  // 🔓 Mode "dev front" : si la requête vient d'un navigateur (Origin présent)
  // et qu'aucune x-api-key n'est envoyée, on autorise temporairement.
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

  // Mode "secure" classique (scripts backend, PowerShell, etc.)
  return headerKey === secretKey;
}

interface UserCriteriaScores {
  emplacement_env?: number;
  marche_liquidite?: number;
  qualite_bien?: number;
  rentabilite_prix?: number;
  risques_complexite?: number;
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

    // 3️⃣ Calculs dérivés
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

    // Rendement brut simple si loyer attendu fourni
    let gross_yield: number | null = null;
    if (expected_rent && price && price > 0) {
      gross_yield = (expected_rent * 12 * 100) / price;
    }

    // 4️⃣ Calcul SmartScore basique à partir des notes utilisateur (0–10 → 0–100)
    const rawEmpl = userCriteriaScores["emplacement_env"] as number | undefined;
    const rawMarche = userCriteriaScores["marche_liquidite"] as number | undefined;
    const rawQualite = userCriteriaScores["qualite_bien"] as number | undefined;
    const rawRentab = userCriteriaScores["rentabilite_prix"] as number | undefined;
    const rawRisques = userCriteriaScores["risques_complexite"] as number | undefined;

    const pillarScores: {
      emplacement_env: number | null;
      marche_liquidite: number | null;
      qualite_bien: number | null;
      rentabilite_prix: number | null;
      risques_complexite: number | null;
    } = {
      emplacement_env: rawEmpl != null ? rawEmpl * 10 : null,
      marche_liquidite: rawMarche != null ? rawMarche * 10 : null,
      qualite_bien: rawQualite != null ? rawQualite * 10 : null,
      rentabilite_prix: rawRentab != null ? rawRentab * 10 : null,
      risques_complexite: rawRisques != null ? rawRisques * 10 : null,
    };

    const activePillars: string[] = [];
    const numericPillars: number[] = [];

    (Object.entries(pillarScores) as [keyof typeof pillarScores, number | null][]).forEach(
      ([key, value]) => {
        if (value != null) {
          activePillars.push(key);
          numericPillars.push(value);
        }
      }
    );

    let globalScore: number | null = null;
    if (numericPillars.length > 0) {
      const sum = numericPillars.reduce((acc, v) => acc + v, 0);
      globalScore = Math.round(sum / numericPillars.length);
    }

    const usedCriteriaCount = Object.values(userCriteriaScores).filter(
      (v) => typeof v === "number"
    ).length;

    // 5️⃣ Structure d’enrichissement renvoyée à l’IA + SmartScore pour le front
    const enrichedPayload = {
      success: true,
      mode,
      timestamp: new Date().toISOString(),

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
      },

      // SmartScore calculé pour le front Mimmoza
      smartscore: {
        globalScore,            // 0–100 ou null
        pillarScores,           // par pilier (0–100)
        usedCriteriaCount,
        activePillars,
      },

      // Contexte marché DVF
      dvfContext: {
        has_data: !!dvfStats,
        raw: dvfStats,
        price_per_m2,
        dvf_median_price_m2: dvfMedian,
        delta_vs_median_percent: delta_vs_median,
        price_position_vs_market: price_position,
      },

      // Contexte PLU / urbanisme
      pluContext: {
        has_data: !!pluContext,
        raw: pluContext,
      },

      // KPIs calculés pour l’IA
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
