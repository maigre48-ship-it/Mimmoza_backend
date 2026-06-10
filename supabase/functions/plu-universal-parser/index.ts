// supabase/functions/plu-universal-parser/index.ts
// Version : plu-universal-parser-v2.1 — security hardening

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? null;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type ParserMode = "auto" | "manual";

type RequestBody = {
  commune_insee?: string;
  commune_nom?: string;
  zone_code?: string;
  source_id?: string;
  mode?: ParserMode;
  extracted_json?: Record<string, unknown>;
  plu_source_url?: string | null;
};

async function callLLM(
  texteReglement: string,
  meta: {
    commune_insee: string;
    commune_nom: string;
    zone_code: string;
  },
) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY_MISSING");
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
- S'il y a plusieurs hauteurs possibles, mets dans "hauteur_max_m" la hauteur générale applicable à la majorité des cas.
- Décris les cas particuliers uniquement dans le commentaire.
- Pour "emprise_sol_max", mets la règle générale.
- Décris les dérogations dans le commentaire sans modifier la valeur générale.
- "articles_source" doit contenir les articles réellement utilisés.
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
      Authorization: `Bearer ${OPENAI_API_KEY}`,
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
    throw new Error("OPENAI_CALL_FAILED");
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content || typeof content !== "string") {
    throw new Error("OPENAI_EMPTY_RESPONSE");
  }

  try {
    return JSON.parse(content);
  } catch (_e) {
    console.error("[plu-universal-parser] llm json parse failed");
    throw new Error("OPENAI_JSON_PARSE_FAILED");
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.error("[plu-universal-parser] missing environment configuration");
    return jsonResponse({ success: false, error: "MISSING_ENV" }, 500);
  }

  try {
    const body = (await req.json().catch(() => null)) as RequestBody | null;

    if (!body) {
      return jsonResponse({ success: false, error: "INVALID_JSON_BODY" }, 400);
    }

    const commune_insee =
      typeof body.commune_insee === "string" ? body.commune_insee.trim() : "";

    const commune_nom =
      typeof body.commune_nom === "string" ? body.commune_nom.trim() : "";

    const zone_code =
      typeof body.zone_code === "string" ? body.zone_code.trim().toUpperCase() : "";

    const source_id =
      typeof body.source_id === "string" ? body.source_id.trim() : "";

    const mode: ParserMode = body.mode === "manual" ? "manual" : "auto";

    const extracted_json =
      body.extracted_json && typeof body.extracted_json === "object"
        ? body.extracted_json
        : null;

    const plu_source_url =
      typeof body.plu_source_url === "string" && body.plu_source_url.trim()
        ? body.plu_source_url.trim()
        : null;

    if (!commune_insee || !commune_nom || !zone_code || !source_id) {
      return jsonResponse({ success: false, error: "INVALID_INPUT" }, 400);
    }

    let jsonResult: any;

    if (mode === "manual") {
      if (!extracted_json) {
        return jsonResponse({ success: false, error: "INVALID_INPUT" }, 400);
      }

      jsonResult = {
        ...extracted_json,
        commune_insee: (extracted_json as any).commune_insee ?? commune_insee,
        commune_nom: (extracted_json as any).commune_nom ?? commune_nom,
        zone_code: (extracted_json as any).zone_code ?? zone_code,
      };
    } else {
      const { data: chunks, error: chunksError } = await supabase
        .from("plu_text_chunks")
        .select("page_number, section_label, raw_text, zone_code")
        .eq("source_id", source_id)
        .or(`zone_code.is.null,zone_code.eq.${zone_code}`)
        .order("page_number", { ascending: true });

      if (chunksError) {
        console.error("[plu-universal-parser] chunks query error");
        return jsonResponse({ success: false, error: "CHUNKS_QUERY_FAILED" }, 500);
      }

      if (!chunks || chunks.length === 0) {
        return jsonResponse({ success: false, error: "NO_CHUNKS_FOUND" }, 404);
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

      jsonResult = {
        ...llmJson,
        commune_insee: llmJson.commune_insee ?? commune_insee,
        commune_nom: llmJson.commune_nom ?? commune_nom,
        zone_code: llmJson.zone_code ?? zone_code,
      };
    }

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
      .select("id")
      .single();

    if (rawErr) {
      console.error("[plu-universal-parser] raw insert error");
      return jsonResponse({ success: false, error: "RAW_INSERT_FAILED" }, 500);
    }

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
      plu_source_url,
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
      .select("id")
      .single();

    if (rulesetErr) {
      console.error("[plu-universal-parser] ruleset upsert error");
      return jsonResponse({ success: false, error: "RULESET_UPSERT_FAILED" }, 500);
    }

    return jsonResponse(
      {
        success: true,
        version: "plu-universal-parser-v2.1",
        raw_id: rawRow?.id ?? null,
        mode,
        ruleset_id: rulesetRow?.id ?? null,
      },
      200,
    );
  } catch (_e) {
    console.error("[plu-universal-parser] internal error");
    return jsonResponse({ success: false, error: "INTERNAL_ERROR" }, 500);
  }
});