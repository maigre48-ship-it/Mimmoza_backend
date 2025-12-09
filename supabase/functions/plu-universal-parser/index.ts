// supabase/functions/plu-universal-parser/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? null;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------
// Helper : appel LLM OpenAI
// ---------------------------------------------------------
async function callLLM(
  texteReglement: string,
  meta: {
    commune_insee: string;
    commune_nom: string;
    zone_code: string;
  },
) {
  if (!OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY non défini dans les variables d'environnement",
    );
  }

  const { commune_insee, commune_nom, zone_code } = meta;

  const systemPrompt = `
Tu es un expert en urbanisme français, spécialisé dans les PLU.
Tu dois produire un JSON STRICTEMENT au format suivant :

{
  "commune_insee": "...",
  "commune_nom": "...",
  "zone_code": "...",
  "zone_libelle": "...",
  "plu_version_label": "...",
  "densite": { "cos_existe": true/false, "cos_max": number|null, "max_sdp_m2_par_m2_terrain": number|null, "commentaire": "..." },
  "hauteur": { "hauteur_max_m": number|null, "hauteur_min_m": number|null, "commentaire": "..." },
  "emprise_sol": { "emprise_sol_max": number|null, "commentaire": "..." },
  "reculs_alignements": { "commentaire": "..." },
  "stationnement": { "commentaire": "..." },
  "autres_regles": { "commentaire": "..." },
  "articles_source": ["..."]
}

Règles :
- Utilise un pourcentage sous forme de décimal (0.6 = 60%).
- Si une info n'est pas dans le texte, mets null ou cos_existe=false.
- S'il y a plusieurs hauteurs possibles (par exemple : une règle générale et des cas particuliers ou dérogations),
  mets dans "hauteur_max_m" la HAUTEUR GÉNÉRALE applicable à la majorité des cas,
  et décris les cas particuliers (ex : angle de rue, linéaire spécifique, équipements publics) uniquement dans le commentaire.
- De même, pour "emprise_sol_max", mets la règle générale (par exemple 0.6 pour 60%)
  et décris les dérogations (par exemple 0.7 pour certains équipements) dans le commentaire sans modifier la valeur générale.
- "articles_source" doit contenir les articles que tu as réellement utilisés (ex : "UG.6", "UG.7").
- Réponds UNIQUEMENT avec le JSON, sans texte avant ou après.
`;

  const userPrompt = `Commune INSEE : ${commune_insee}
Commune : ${commune_nom}
Zone : ${zone_code}

=== TEXTE DU RÈGLEMENT EXTRAIT ===
${texteReglement}
=== FIN ===`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Erreur OpenAI: ${response.status} - ${text}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;

  try {
    return JSON.parse(content);
  } catch (e) {
    console.error("Réponse LLM non JSON : ", content);
    throw new Error("Réponse non parseable : " + content);
  }
}

// ---------------------------------------------------------
// Handler principal
// ---------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      commune_insee,
      commune_nom,
      zone_code,
      source_id,
      mode = "auto",      // "auto" (LLM) ou "manual" (JSON fourni)
      extracted_json,     // utilisé en mode "manual"
      plu_source_url,     // 🔹 URL du PDF / page PLU d'origine (optionnel)
    } = body;

    if (!commune_insee || !commune_nom || !zone_code || !source_id) {
      throw new Error(
        "Paramètres manquants (commune_insee, commune_nom, zone_code, source_id)",
      );
    }

    let jsonResult: any;

    // -----------------------------------------------------
    // MODE MANUAL : on reçoit déjà le JSON normalisé
    // -----------------------------------------------------
    if (mode === "manual") {
      if (!extracted_json) {
        throw new Error(
          "En mode 'manual', le champ 'extracted_json' est obligatoire.",
        );
      }

      // On s'assure que les champs clés sont présents
      jsonResult = {
        ...extracted_json,
        commune_insee: extracted_json.commune_insee ?? commune_insee,
        commune_nom: extracted_json.commune_nom ?? commune_nom,
        zone_code: extracted_json.zone_code ?? zone_code,
      };
    } else {
      // ---------------------------------------------------
      // MODE AUTO : on lit les chunks + appel LLM
      // ---------------------------------------------------
      const { data: chunks, error: chunksError } = await supabase
        .from("plu_text_chunks")
        .select("page_number, section_label, raw_text, zone_code")
        .eq("source_id", source_id)
        // on prend soit les chunks avec zone_code = zone_code,
        // soit les chunks où zone_code est NULL (pour compat v1)
        .or(`zone_code.is.null,zone_code.eq.${zone_code}`)
        .order("page_number", { ascending: true });

      if (chunksError) {
        throw chunksError;
      }

      if (!chunks || chunks.length === 0) {
        throw new Error("Aucun chunk trouvé pour cette source / zone.");
      }

      const texteReglement = chunks
        .map(
          (c: any) =>
            `[PAGE ${c.page_number} - ${c.section_label ?? ""}]\n${c.raw_text}`,
        )
        .join("\n\n");

      const llmJson = await callLLM(texteReglement, {
        commune_insee,
        commune_nom,
        zone_code,
      });

      // On s'assure aussi ici que les champs clés sont bien renseignés
      jsonResult = {
        ...llmJson,
        commune_insee: llmJson.commune_insee ?? commune_insee,
        commune_nom: llmJson.commune_nom ?? commune_nom,
        zone_code: llmJson.zone_code ?? zone_code,
      };
    }

    // -----------------------------------------------------
    // 3) Sauvegarde brut
    // -----------------------------------------------------
    const { data: rawRow, error: rawErr } = await supabase
      .from("plu_rules_raw")
      .insert({
        commune_insee,
        commune_nom,
        zone_code,
        extraction_mode: mode,
        source_id,
        extracted_json: jsonResult,
      })
      .select()
      .single();

    if (rawErr) {
      throw rawErr;
    }

    // -----------------------------------------------------
    // 4) Normalisation vers plu_rulesets (UPSERT)
// -----------------------------------------------------
    const d: any = jsonResult;

    const rulesetPayload = {
      commune_insee: d.commune_insee ?? commune_insee,
      commune_nom: d.commune_nom ?? commune_nom,
      zone_code: d.zone_code ?? zone_code,
      zone_libelle: d.zone_libelle ?? null,
      plu_version_label: d.plu_version_label ?? null,
      plu_source_type:
        mode === "manual"
          ? "universal_parser_manual"
          : "universal_parser_auto",

      // on garde la source d'origine (PDF / page web du PLU)
      plu_source_url: plu_source_url ?? null,

      cos_existe: d.densite?.cos_existe ?? false,
      cos_max: d.densite?.cos_max ?? null,
      max_sdp_m2_par_m2_terrain:
        d.densite?.max_sdp_m2_par_m2_terrain ?? null,

      hauteur_max_m: d.hauteur?.hauteur_max_m ?? null,
      hauteur_min_m: d.hauteur?.hauteur_min_m ?? null,
      hauteur_commentaire: d.hauteur?.commentaire ?? null,

      emprise_sol_max: d.emprise_sol?.emprise_sol_max ?? null,
      emprise_commentaire: d.emprise_sol?.commentaire ?? null,

      reculs_commentaire: d.reculs_alignements?.commentaire ?? null,
      stationnement_commentaire: d.stationnement?.commentaire ?? null,
      autres_commentaires: d.autres_regles?.commentaire ?? null,

      raw_rules: jsonResult,
    };

    const { data: rulesetRow, error: rulesetErr } = await supabase
      .from("plu_rulesets")
      .upsert(rulesetPayload, {
        onConflict: "commune_insee,zone_code",
      })
      .select()
      .single();

    if (rulesetErr) {
      throw rulesetErr;
    }

    return new Response(
      JSON.stringify({
        success: true,
        version: "plu-universal-parser-v2",
        raw_id: rawRow.id,
        mode,
        ruleset_id: rulesetRow?.id ?? null,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error(e);
    return new Response(
      JSON.stringify({ success: false, error: String(e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
