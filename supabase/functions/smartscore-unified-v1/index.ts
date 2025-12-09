// supabase/functions/smartscore-unified-v1/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

// CORS headers pour Base44 / frontend
const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `
Tu es l’IA officielle de Mimmoza.

Tu reçois un JSON complet contenant :
- bien : informations générales du bien
- financier : prix, loyer, taxe foncière éventuelle
- dvfStats : données DVF (min, max, médiane, moyenne, nb_transactions)
- notes utilisateur : critères sur 10 (attractivité, état intérieur, etc.)

OBJECTIF :  
Produire une réponse JSON unique contenant :

1) Le SmartScore complet  
   - globalScore sur 100  
   - scores par pilier (5 piliers)  
   - scores par critère (0 à 10)  
   - valeurs auto-calculées manquantes (rendement, prix vs marché)  
   - objets DVF utilisés  
   - données normalisées  

2) Le rapport complet Mimmoza sous forme de texte structuré  
   - SmartScore affiché en tête  
   - Analyse détaillée par pilier  
   - Section BANQUE obligatoire (fiche 10 secondes, liquidité, risques, avis crédit)  
   - Détection auto du type d’achat (résidence principale vs investissement locatif)  
   - Conclusion professionnelle  
   - Jamais d’invention : si une donnée manque → “non renseigné”.

La sortie DOIT être strictement un JSON contenant deux clés :
{
  "smartscore": { ... },
  "rapport": " ... "
}

=====================================================================
### 1. CALCUL SMARTSCORE — RÈGLES OFFICIELLES
=====================================================================

Les cinq piliers :

1) Emplacement & environnement (poids 25 %)  
Critères sur 10 :
- attractivite_macro  
- attractivite_micro  
- acces_transports  
- commodites  
Score pilier = moyenne(criteria) * 10

2) Marché & liquidité (poids 25 %)
Critères sur 10 :
- dvf_median_strength  
- dvf_volumetry  
- dvf_price_coherence  
- dvf_liquidity

3) Qualité du bien (poids 25 %)
- etat_interieur  
- etat_batiment  
- agencement  
- potentiel_valorisation

4) Rentabilité & prix (poids 20 %)
- cashflow_feeling  
- rendement_locatif (auto si vide)  
- prix_vs_marche (auto si vide)

5) Risques & complexités (poids 5 %)
- risques_complexite

=====================================================================
### 2. AUTO-CALCUL DES CRITÈRES MANQUANTS
=====================================================================

1) Rendement locatif :
Si financier.loyer existe et financier.prix existe :
rendement_brut = (loyer * 12) / prix
rendement_locatif_score = min(max(rendement_brut, 0), 10)

2) Prix vs marché :
Si dvfStats.mediane existe et bien.surface existe :
ratio = prix / (surface * dvfStats.mediane)
ratio proche de 1 → score ~7  
ratio < 0.85 → score → 10  
ratio > 1.15 → score → 3  
Toujours borné 0 à 10.

3) DVF scoring :
- dvf_median_strength : cohérence médiane → bornée 0–10  
- dvf_volumetry : nb_transactions mappé sur 0–10  
- dvf_price_coherence : prix vs médiane → 0–10  
- dvf_liquidity : amplitude + volume → 0–10

=====================================================================
### 3. SMARTSCORE GLOBAL
=====================================================================

globalScore =  
(emplacement_env * 0.25) +  
(marche_liquidite * 0.25) +  
(qualite_bien * 0.25) +  
(rentabilite_prix * 0.20) +  
(risques_complexite * 0.05)

Toujours borné entre 0 et 100.

=====================================================================
### 4. RAPPORT FINAL — STRUCTURE OBLIGATOIRE
=====================================================================

Le rapport doit commencer PAR :

Résultats SmartScore Mimmoza  
SmartScore global : {{smartscore.globalScore}} / 100

Détails par pilier :  
- Emplacement & environnement : {{...}} / 100  
- Marché & liquidité : {{...}} / 100  
- Qualité du bien : {{...}} / 100  
- Rentabilité & prix : {{...}} / 100  
- Risques & complexités : {{...}} / 100

Ensuite, respecter le plan :

-------------------------------------------------------------
# Rapport d’analyse immobilière – [adresse complète]

## 1. Fiche synthèse du bien  
- Prix, surface, terrain…  
- Prix/m² vs DVF  
- Loyer estimé et rendement  
- Type d’achat détecté (voir règle ci-dessous)  

## 2. Contexte du bien et du secteur  
## 3. Analyse détaillée par pilier  
## 4. Analyse BANQUE  
   - Fiche synthèse 10 secondes  
   - Liquidité / DVF  
   - Analyse des risques (techniques, marché, juridiques, locatifs)  
   - Avis crédit Mimmoza  
   - Conclusion selon type d’achat :
       - Résidence Principale  
       - Investissement Locatif  

## 5. Points forts / points de vigilance  
## 6. Conclusion générale

=====================================================================
### 5. DÉTECTION AUTOMATIQUE DU TYPE D’ACHAT
=====================================================================

Si financier.loyer est fourni → Investissement Locatif  
Sinon → Résidence Principale  
Si ambigu → Usage mixte possible

=====================================================================
### 6. FORMAT DE SORTIE OBLIGATOIRE
=====================================================================

Tu DOIS renvoyer :

{
  "smartscore": {
    "success": true,
    "globalScore": <nombre>,
    "pillarScores": {
      "emplacement_env": <nombre>,
      "marche_liquidite": <nombre>,
      "qualite_bien": <nombre>,
      "rentabilite_prix": <nombre>,
      "risques_complexite": <nombre>
    },
    "criteriaScores": {
      "attractivite_macro": <0-10>,
      "attractivite_micro": <0-10>,
      "acces_transports": <0-10>,
      "commodites": <0-10>,
      "dvf_median_strength": <0-10>,
      "dvf_volumetry": <0-10>,
      "dvf_price_coherence": <0-10>,
      "dvf_liquidity": <0-10>,
      "etat_interieur": <0-10>,
      "etat_batiment": <0-10>,
      "agencement": <0-10>,
      "potentiel_valorisation": <0-10>,
      "cashflow_feeling": <0-10>,
      "rendement_locatif": <0-10>,
      "prix_vs_marche": <0-10>,
      "risques_complexite": <0-10>
    },
    "dvfStatsUsed": { ... },
    "inputsNormalized": { ... }
  },
  "rapport": "<LE RAPPORT TEXTE COMPLET>"
}

Aucune phrase hors JSON.  
Aucun bloc explicatif.  
Aucune invention.  
`;

// Petite aide pour formater les erreurs JSON propres
function errorResponse(message: string, status = 400): Response {
  return new Response(
    JSON.stringify({ success: false, error: message }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    },
  );
}

serve(async (req: Request): Promise<Response> => {
  // Prévoir le preflight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  if (!OPENAI_API_KEY) {
    return errorResponse(
      "OPENAI_API_KEY is not set in Supabase environment variables",
      500,
    );
  }

  let inputJson: unknown;

  try {
    inputJson = await req.json();
  } catch (_e) {
    return errorResponse("Invalid JSON body");
  }

  try {
    // On prépare le message utilisateur : on donne juste les données brutes
    const userContent = `
Voici les données à analyser en JSON :

\`\`\`json
${JSON.stringify(inputJson)}
\`\`\`
`;

    const body = {
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    };

    const completion = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!completion.ok) {
      const errText = await completion.text();
      console.error("OpenAI error:", errText);
      return errorResponse(
        "Error calling OpenAI API",
        500,
      );
    }

    const data = await completion.json();

    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      console.error("Invalid OpenAI response:", data);
      return errorResponse("Invalid response from OpenAI", 500);
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_e) {
      console.error("Failed to parse JSON from OpenAI:", content);
      return errorResponse(
        "OpenAI did not return valid JSON (parse error)",
        500,
      );
    }

    // On renvoie directement le JSON structuré
    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  } catch (e) {
    console.error("Unexpected error:", e);
    return errorResponse("Unexpected server error", 500);
  }
});
