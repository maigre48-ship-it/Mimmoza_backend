// supabase/functions/smartscore-ultra-v1/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("PROJECT_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") ?? "";

// Initialise le client Supabase pour les requêtes DVF
const supabase =
  SUPABASE_URL && SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

interface SmartscoreInput {
  address: string;
  city?: string;
  postalCode?: string;
  propertyType?: string;
  surface?: number;
  rooms?: number;
  price?: number;
  customNotes?: string;
}

interface DvfStats {
  transaction_count: number;
  median_price_m2: number | null;
  q1_price_m2: number | null;
  q3_price_m2: number | null;
  mean_price_m2: number | null;
  last_transaction_date: string | null;
  period_label: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function fetchDvfStats(
  postalCode?: string,
  propertyType?: string,
): Promise<DvfStats | null> {
  if (!postalCode) return null;
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc("get_dvf_stats", {
      p_code_postal: postalCode,
      p_type_local: propertyType ?? null,
    });

    if (error) {
      console.error("Erreur get_dvf_stats:", error);
      return null;
    }

    if (!data) return null;

    const row = Array.isArray(data) ? data[0] : data;
    return row as DvfStats;
  } catch (e) {
    console.error("Exception DVF:", e);
    return null;
  }
}

serve(async (req: Request): Promise<Response> => {
  // --- CORS preflight ---
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Only POST allowed" }, 405);
  }

  try {
    const body = (await req.json()) as SmartscoreInput;

    if (!body.address) {
      return jsonResponse({ error: "Champ 'address' obligatoire" }, 400);
    }

    // --- MODE TEST ---
    if (body.customNotes === "__test__") {
      return jsonResponse(
        {
          success: true,
          globalScore: 73,
          pillarScores: {
            emplacement_env: 90,
            marche_liquidite: 70,
            qualite_bien: 75,
            rentabilite_prix: 60,
            risques_complexite: 40,
          },
          summary:
            "Rapport de test SmartScore généré sans appel OpenAI (mode __test__).",
          reportSections: [
            {
              title: "Présentation (test)",
              content:
                "Ceci est un rapport de TEST interne pour vérifier la fonction Supabase.",
            },
          ],
          warnings: [],
          dvfStats: null,
          subjectPricePerM2: null,
          discountVsMedian: null,
        },
        200,
      );
    }

    if (!OPENAI_API_KEY) {
      return jsonResponse(
        { error: "OPENAI_API_KEY manquant dans Supabase secrets" },
        500,
      );
    }

    // --- 1) Récupérer DVF ---
    const dvfStats = await fetchDvfStats(
      body.postalCode,
      body.propertyType,
    );

    // --- 2) Calcul prix/m² du bien ---
    let subjectPricePerM2: number | null = null;
    if (body.price && body.surface && body.surface > 0) {
      subjectPricePerM2 = body.price / body.surface;
    }

    // --- 3) Écart vs médiane ---
    let discountVsMedian: number | null = null;
    if (
      subjectPricePerM2 &&
      dvfStats?.median_price_m2 &&
      dvfStats.median_price_m2 > 0
    ) {
      discountVsMedian =
        ((subjectPricePerM2 - dvfStats.median_price_m2) /
          dvfStats.median_price_m2) *
        100;
    }

    // --- 4) Contexte DVF ---
    const dvfContext = dvfStats
      ? `
Données DVF réelles pour le code postal ${body.postalCode} :
- Transactions analysées : ${dvfStats.transaction_count}
- Médiane €/m² : ${dvfStats.median_price_m2 ?? "N/A"}
- Quartile bas (Q1) €/m² : ${dvfStats.q1_price_m2 ?? "N/A"}
- Quartile haut (Q3) €/m² : ${dvfStats.q3_price_m2 ?? "N/A"}
- Prix moyen €/m² : ${dvfStats.mean_price_m2 ?? "N/A"}
- Dernière transaction : ${dvfStats.last_transaction_date ?? "N/A"}
- Période : ${dvfStats.period_label ?? "N/A"}

Bien analysé :
- Prix : ${body.price ?? "N/A"} €
- Surface : ${body.surface ?? "N/A"} m²
- Prix/m² calculé : ${
          subjectPricePerM2 ? `${subjectPricePerM2.toFixed(0)} €` : "N/A"
        }
- Écart vs médiane : ${
          discountVsMedian ? discountVsMedian.toFixed(1) + "%" : "N/A"
        }
`
      : `
Les données DVF ne sont pas disponibles ou insuffisantes pour ce code postal.
Tu dois néanmoins réaliser une évaluation complète en te basant sur :
- l'adresse, la ville et le contexte supposé,
- le type de bien,
- la surface,
- le prix demandé,
- les commentaires de l'utilisateur.

Ne dis pas que l'évaluation est impossible : propose des ordres de grandeur et une analyse argumentée en te basant sur ton expertise.
`;

    // --- 5) Prompt OpenAI enrichi ---
    const prompt = `
Tu es un expert immobilier Mimmoza.
Tu dois produire un rapport SmartScore détaillé, concret, et CHIFFRÉ.

Données du bien :
- Adresse : ${body.address}, ${body.postalCode ?? ""} ${body.city ?? ""}
- Type de bien : ${body.propertyType ?? "non précisé"}
- Surface : ${body.surface ?? "non précisée"} m²
- Nombre de pièces : ${body.rooms ?? "non précisé"}
- Prix demandé : ${body.price ?? "non précisé"} €
- Commentaires utilisateur : ${body.customNotes ?? "aucun"}

CONTEXTE MARCHÉ :
${dvfContext}

Instructions IMPORTANTES :
- Même en l'absence de données DVF, tu dois produire une évaluation complète et des scores NON NULS, basés sur les informations disponibles.
- Ne dis JAMAIS que l'évaluation est impossible.
- Si les données sont partielles, précise simplement que certains éléments sont estimés ou à confirmer.

Objectif :
1. Calculer un SmartScore global (0 à 100).
2. Donner 5 sous-scores (0 à 100) :
   - emplacement_env
   - marche_liquidite
   - qualite_bien
   - rentabilite_prix
   - risques_complexite
3. Produire un rapport structuré, clair et chiffré, qui :
   - s'appuie explicitement sur les données disponibles (DVF si présentes, sinon prix, surface, type de bien, contexte supposé),
   - commente le niveau de sur/sous-valorisation du bien,
   - mentionne des ordres de grandeur chiffrés quand c'est possible.

Réponds STRICTEMENT en JSON :
{
  "globalScore": number,
  "pillarScores": {
    "emplacement_env": number,
    "marche_liquidite": number,
    "qualite_bien": number,
    "rentabilite_prix": number,
    "risques_complexite": number | null
  },
  "summary": string,
  "reportSections": [
    { "title": string, "content": string }
  ],
  "warnings": string[]
}
    `.trim();

    // --- 6) Appel OpenAI ---
    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Tu es un assistant qui répond STRICTEMENT en JSON valide.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      },
    );

    if (!openaiRes.ok) {
      const txt = await openaiRes.text();
      return jsonResponse({ error: "OpenAI error", details: txt }, 500);
    }

    const data = await openaiRes.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content || typeof content !== "string") {
      return jsonResponse(
        { error: "OpenAI format inattendu", raw: data },
        500,
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return jsonResponse(
        { error: "JSON.parse error", rawContent: content },
        500,
      );
    }

    // --- Payload final ---
    return jsonResponse(
      {
        success: true,
        dvfStats,
        subjectPricePerM2,
        discountVsMedian,
        ...parsed,
      },
      200,
    );
  } catch (err) {
    return jsonResponse(
      { error: "Server error", details: String(err) },
      500,
    );
  }
});
