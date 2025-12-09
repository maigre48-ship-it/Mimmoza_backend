// supabase/functions/smartscore-enriched-v1/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// 🔐 Variables d'environnement
const openaiApiKey = Deno.env.get("OPENAI_API_KEY")!;

// 🌐 Headers CORS
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 📦 Type principal : toutes les infos d'entrée Mimmoza
type MimmozaSmartscoreInput = {
  // Identité du bien
  listingId?: string;
  propertyType: "appartement" | "maison" | "immeuble" | "terrain" | "autre";
  usage:
    | "residence_principale"
    | "investissement_locatif"
    | "residence_secondaire"
    | "autre";

  // Localisation
  address: string;
  zipCode: string;
  city: string;
  country?: string;
  latitude?: number;
  longitude?: number;

  // Caractéristiques principales
  surfaceHabitable: number;
  surfaceCarrez?: number;
  rooms: number;
  bedrooms: number;
  bathrooms?: number;
  floor?: number;
  totalFloors?: number;

  // Immeuble & état
  buildingYear?: number;
  buildingType?: "ancien" | "recent" | "neuf" | "tres_ancien";
  condition: "neuf" | "tres_bon" | "bon" | "a_rafraichir" | "a_renover";

  // Confort / atouts
  hasElevator?: boolean;
  hasBalcony?: boolean;
  hasTerrace?: boolean;
  hasParking?: boolean;
  hasCellar?: boolean;
  exposure?:
    | "nord"
    | "sud"
    | "est"
    | "ouest"
    | "nord-est"
    | "nord-ouest"
    | "sud-est"
    | "sud-ouest"
    | "multiple"
    | "inconnue";
  viewQuality?: "bouchee" | "moyenne" | "degagee" | "exceptionnelle" | "inconnue";
  noiseLevel?: "calme" | "moyen" | "bruyant" | "inconnu";

  // Énergie
  dpeClass?: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "inconnu";
  gesClass?: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "inconnu";

  // Prix & finances
  priceAsked?: number;
  priceEstimated?: number;
  monthlyCharges?: number;
  propertyTax?: number;
  expectedRent?: number;

  // Infos contextuelles
  marketContext?: any;
  environmentData?: any;

  // (optionnel, pour maison)
  surfaceTerrain?: number;
  hasPool?: boolean;
  hasOutbuildings?: boolean;
  houseFloors?: number;
};

// Résultat des scores
type SmartscorePillars = {
  emplacement_env: number;
  marche_liquidite: number;
  qualite_bien: number;
  rentabilite_prix: number;
  risques_complexite: number;
};

type SmartscoreResult = {
  global: number;
  pillars: SmartscorePillars;
};

// 🔧 Helpers
const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));

// Calcul du SmartScore Mimmoza (figé, déterministe)
function computeSmartscore(input: MimmozaSmartscoreInput): SmartscoreResult {
  // 1️⃣ Emplacement & environnement (35%)
  let emplacement = 70;

  if (
    input.environmentData &&
    typeof input.environmentData.emplacementScore === "number"
  ) {
    emplacement = input.environmentData.emplacementScore;
  } else {
    if (input.city.toLowerCase().includes("paris")) {
      emplacement += 10;
    }
    if (input.noiseLevel === "bruyant") emplacement -= 10;
    if (input.noiseLevel === "calme") emplacement += 5;
    if (
      input.viewQuality === "degagee" ||
      input.viewQuality === "exceptionnelle"
    ) {
      emplacement += 5;
    }
  }

  emplacement = clamp(emplacement);

  // 2️⃣ Marché & liquidité (20%)
  let marche = 70;

  // Si marketContext présent, on utilise sa liquidityScore
  if (
    input.marketContext &&
    input.marketContext.scores &&
    typeof input.marketContext.scores.liquidityScore === "number"
  ) {
    marche = input.marketContext.scores.liquidityScore;
  } else if (
    input.marketContext &&
    typeof input.marketContext.liquidityScore === "number"
  ) {
    marche = input.marketContext.liquidityScore;
  } else {
    // Fallback : estimation grossière si pas de contexte marché
    if (input.propertyType === "appartement" && input.rooms === 2) {
      marche += 5;
    }
    if (input.surfaceHabitable < 20 || input.surfaceHabitable > 120) {
      marche -= 5;
    }
  }

  marche = clamp(marche);

  // 3️⃣ Qualité intrinsèque du bien (20%)
  let qualite = 70;

  switch (input.condition) {
    case "neuf":
      qualite += 15;
      break;
    case "tres_bon":
      qualite += 10;
      break;
    case "bon":
      qualite += 5;
      break;
    case "a_rafraichir":
      qualite -= 5;
      break;
    case "a_renover":
      qualite -= 15;
      break;
  }

  if (input.hasBalcony || input.hasTerrace) qualite += 5;
  if (input.hasElevator && input.floor && input.floor >= 3) qualite += 5;
  if (input.viewQuality === "exceptionnelle") qualite += 10;
  if (input.noiseLevel === "bruyant") qualite -= 10;

  if (input.dpeClass === "F" || input.dpeClass === "G") qualite -= 5;
  if (input.dpeClass === "A" || input.dpeClass === "B") qualite += 3;

  // Bonus maison (terrain, piscine, annexes)
  if (input.propertyType === "maison") {
    if (input.surfaceTerrain && input.surfaceTerrain > 300) qualite += 3;
    if (input.hasPool) qualite += 4;
    if (input.hasOutbuildings) qualite += 2;
  }

  qualite = clamp(qualite);

  // 4️⃣ Rentabilité & prix (15%)
  let rentabilite = 60;

  if (input.priceAsked && input.priceEstimated) {
    const diff = (input.priceAsked - input.priceEstimated) / input.priceEstimated;
    if (diff > 0.15) rentabilite -= 15;
    else if (diff > 0.05) rentabilite -= 5;
    else if (diff < -0.15) rentabilite += 10;
    else if (diff < -0.05) rentabilite += 5;
  }

  if (input.expectedRent && input.priceAsked) {
    const brut = (input.expectedRent * 12) / input.priceAsked;
    if (brut >= 0.05) rentabilite += 10;
    else if (brut >= 0.035) rentabilite += 5;
    else if (brut < 0.025) rentabilite -= 5;
  }

  if (input.monthlyCharges && input.surfaceHabitable) {
    const chargesM2 = input.monthlyCharges / input.surfaceHabitable;
    if (chargesM2 > 6) rentabilite -= 5;
    if (chargesM2 > 8) rentabilite -= 10;
  }

  rentabilite = clamp(rentabilite);

  // 5️⃣ Risques & complexités (10%)
  let risques = 75;

  if (input.dpeClass === "F" || input.dpeClass === "G") risques -= 10;
  if (input.dpeClass === "A" || input.dpeClass === "B") risques += 5;

  if (input.buildingYear && input.buildingYear < 1949) risques -= 5;

  if (input.monthlyCharges && input.surfaceHabitable) {
    const chargesM2 = input.monthlyCharges / input.surfaceHabitable;
    if (chargesM2 > 8) risques -= 5;
  }

  if (input.noiseLevel === "bruyant") risques -= 5;

  risques = clamp(risques);

  const pillars: SmartscorePillars = {
    emplacement_env: emplacement,
    marche_liquidite: marche,
    qualite_bien: qualite,
    rentabilite_prix: rentabilite,
    risques_complexite: risques,
  };

  const global =
    0.35 * emplacement +
    0.2 * marche +
    0.2 * qualite +
    0.15 * rentabilite +
    0.1 * risques;

  return {
    global: Math.round(global),
    pillars,
  };
}

// 🧠 Prompt système Mimmoza pour le rapport
const SYSTEM_PROMPT_MIMMOZA = `
Tu es Mimmoza, un assistant expert en analyse immobilière premium.

Ta mission : produire un rapport professionnel, clair, pédagogique et structuré pour un bien immobilier à partir des données suivantes :
- caractéristiques du bien (type, surface, nombre de pièces, étage, état, atouts : ascenseur, balcon, terrasse, parking, cave, exposition, vue, niveau de bruit, DPE, GES, etc.)
- localisation (adresse, ville, quartier, éventuelles données de contexte marché/environnement)
- informations financières (prix demandé, estimation de prix, charges, taxe foncière, loyer potentiel)
- SmartScore global et scores détaillés par pilier (Emplacement & environnement, Marché & liquidité, Qualité du bien, Rentabilité & prix, Risques & complexités), déjà calculés de manière déterministe par Mimmoza.
- contexte de marché local (volume de transactions DVF, prix/m² médian, tendance des prix, scores de dynamisme/liquidité/profondeur de la demande) si fourni.

IMPORTANT :
- Tu ne recalcules pas les scores, tu t’appuies STRICTEMENT sur les scores et indicateurs fournis.
- Si une information est absente, null, "inconnu" ou non présente dans les données, tu ne la devines pas et tu n’inventes aucun chiffre.
- Tu peux commenter le marché local uniquement à partir des données DVF ou de marché présentes dans le contexte (transactionsCount, priceM2Median, priceTrend12m, scores de marché, etc.) ; sinon tu restes général.

Structure obligatoire du rapport :

1. Synthèse express (3–5 phrases)
2. SmartScore et profil du bien (SmartScore global + 5 piliers commentés)
3. Analyse détaillée par pilier :
   3.1 Emplacement & environnement
   3.2 Marché & liquidité (en t’appuyant sur le contexte DVF si disponible)
   3.3 Qualité intrinsèque du bien
   3.4 Rentabilité & prix
   3.5 Risques & complexités
4. Conclusion opérationnelle (avis global, type d’acquéreur, points à surveiller/négocier)

Règles d’écriture :
- Français impeccable, style professionnel mais accessible.
- Ton posé, sérieux, sans marketing exagéré.
- Pas de jargon juridique ou technique inutile.
- Pas de phrases creuses : chaque partie doit apporter une analyse réelle.
- Tu écris comme pour un rapport que l’utilisateur peut télécharger ou présenter à son banquier.
`;

// 🚀 Edge Function
serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const input = (await req.json()) as MimmozaSmartscoreInput;

    // Validation minimale
    if (
      !input.address ||
      !input.city ||
      !input.zipCode ||
      !input.surfaceHabitable ||
      !input.rooms ||
      !input.bedrooms
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "Requête incomplète : adresse, ville, code postal, surfaceHabitable, rooms et bedrooms sont obligatoires.",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // 1️⃣ Appel market-context-v1 (DVF) pour récupérer le contexte marché
    try {
      const mcRes = await fetch(
        "https://fwvrqngbafqdaekbdfnm.functions.supabase.co/market-context-v1",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            address: input.address,
            zipCode: input.zipCode,
            city: input.city,
            propertyType: input.propertyType,
            surfaceHabitable: input.surfaceHabitable,
            priceAsked: input.priceAsked,
          }),
        }
      );

      if (mcRes.ok) {
        const mcJson = await mcRes.json();
        if (mcJson.success && mcJson.marketContext) {
          input.marketContext = mcJson.marketContext;
        }
      } else {
        console.warn(
          "market-context-v1 non OK:",
          mcRes.status,
          await mcRes.text()
        );
      }
    } catch (e) {
      console.warn("Erreur appel market-context-v1:", e);
    }

    // 2️⃣ Calcul du SmartScore
    const scores = computeSmartscore(input);

    // 3️⃣ Préparation du contexte pour OpenAI
    const contextPayload = {
      input,
      scores: {
        global: scores.global,
        pillars: scores.pillars,
      },
      context: {
        marketContext: input.marketContext ?? null,
        environmentData: input.environmentData ?? null,
      },
    };

    // 4️⃣ Appel OpenAI pour générer le rapport
    let aiSummary: string | null = null;

    try {
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content: SYSTEM_PROMPT_MIMMOZA,
            },
            {
              role: "user",
              content: JSON.stringify(contextPayload),
            },
          ],
          temperature: 0.2,
        }),
      });

      if (openaiRes.ok) {
        const openaiJson = await openaiRes.json();
        aiSummary = openaiJson.choices?.[0]?.message?.content ?? null;
      } else {
        console.warn(
          "Erreur OpenAI:",
          openaiRes.status,
          await openaiRes.text()
        );
      }
    } catch (e) {
      console.warn("Erreur appel OpenAI:", e);
    }

    const result = {
      success: true,
      createdAt: new Date().toISOString(),
      input,
      scores: {
        global: scores.global,
        pillars: scores.pillars,
      },
      report: aiSummary,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error("Erreur smartscore-enriched-v1:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Erreur interne dans smartscore-enriched-v1",
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
