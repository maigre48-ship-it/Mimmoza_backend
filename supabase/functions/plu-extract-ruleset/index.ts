// supabase/functions/plu-extract-ruleset/index.ts
// Version : v2.1 — security hardening, no sensitive logs/responses

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const PLU_RULESETS_TABLE = "plu_rulesets";
const OPENAI_MODEL = "gpt-4.1-mini";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type PluExtractInput = {
  commune_insee: string;
  commune_nom: string;
  zone_code: string;
  source_label?: string;
  source_type?: string;
  zone_text: string;
  save_to_db?: boolean;
};

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type PluExtractResponse = {
  success: boolean;
  version: string;
  ruleset?: JsonValue;
  db?: {
    saved: boolean;
  };
  error?: string;
};

function jsonResponse(body: PluExtractResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SYSTEM_PROMPT = `
Tu es un expert en urbanisme français et en PLU.
Ta tâche est de convertir un règlement de zone de PLU (texte brut) en un JSON strictement au format PLURulesetV2.
Tu DOIS renvoyer uniquement un JSON strictement valide, sans texte avant ou après.
Ne mets PAS de commentaires dans le JSON.
Pour les champs numériques : utilise des nombres, jamais des chaînes.
Si une information n'est pas présente, mets null ou tableau vide.
`;

function buildUserPrompt(input: PluExtractInput): string {
  return `
Commune INSEE : ${input.commune_insee}
Commune : ${input.commune_nom}
Zone : ${input.zone_code}
Source : ${input.source_label ?? "PLU"}

Texte du règlement de la zone :
"""
${input.zone_text}
"""

Retourne UNIQUEMENT le JSON PLURulesetV2.
`;
}

function parsePleineTerreRatio(text: string): { ratio: number | null; note: string | null } {
  const re1 = /(\d+(?:[.,]\d+)?)\s*%\s*(?:minimum\s+)?(?:de\s+)?[^.\n]{0,150}?pleine\s+terre/gi;
  const re2 = /pleine\s+terre[^.\n]{0,150}?(\d+(?:[.,]\d+)?)\s*%/gi;

  const tryMatch = (re: RegExp): { raw: string } | null => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const raw = (m[1] ?? m[2]) as string;
      const ctx = m[0];
      if (/stationnement|parc\s+de\s+stat|vélo|velo|capacité|bicyclette/i.test(ctx)) continue;
      return { raw };
    }
    return null;
  };

  const found = tryMatch(re1) ?? tryMatch(re2);
  if (!found) return { ratio: null, note: null };

  const value = Number(found.raw.replace(",", "."));
  if (isNaN(value) || value <= 0 || value > 100) return { ratio: null, note: null };

  return {
    ratio: value / 100,
    note: `${value}% de l'unité foncière minimum.`,
  };
}

function parseHauteurs(text: string): {
  egout: number | null;
  egout_note: string | null;
  faitage: number | null;
  faitage_note: string | null;
} {
  let egout: number | null = null;
  let faitage: number | null = null;

  for (const re of [
    /(\d+(?:[.,]\d+)?)\s*m(?:ètres?)?\s*[^.\n]{0,80}?(?:égout|acrotère)/i,
    /(?:égout|acrotère)[^.\n]{0,80}?(\d+(?:[.,]\d+)?)\s*m/i,
  ]) {
    const m = re.exec(text);
    if (m) {
      const v = Number((m[1] ?? m[2]).replace(",", "."));
      if (!isNaN(v) && v > 0 && v < 60) {
        egout = v;
        break;
      }
    }
  }

  for (const re of [
    /(\d+(?:[.,]\d+)?)\s*m(?:ètres?)?\s*[^.\n]{0,80}?faîtage/i,
    /faîtage[^.\n]{0,80}?(\d+(?:[.,]\d+)?)\s*m/i,
  ]) {
    const m = re.exec(text);
    if (m) {
      const v = Number((m[1] ?? m[2]).replace(",", "."));
      if (!isNaN(v) && v > 0 && v < 70) {
        faitage = v;
        break;
      }
    }
  }

  return {
    egout,
    egout_note: egout !== null ? `${egout}m à l'égout/acrotère.` : null,
    faitage,
    faitage_note: faitage !== null ? `${faitage}m au faîtage.` : null,
  };
}

function parsePlacesParLogement(text: string): { places: number | null; note: string | null } {
  const re = /(\d+(?:[.,]\d+)?)\s*(?:places?|pl\.?)\s+(?:par|\/)\s+logement/i;
  const m = re.exec(text);
  if (!m) return { places: null, note: null };

  const v = Number(m[1].replace(",", "."));
  if (isNaN(v)) return { places: null, note: null };

  return {
    places: v,
    note: `Minimum ${v} place(s)/logement.`,
  };
}

function enhanceRulesetWithHeuristics(
  ruleset: Record<string, unknown>,
  zoneText: string,
): Record<string, unknown> {
  try {
    const obj = { ...ruleset } as Record<string, unknown>;

    const pleineTerre = (
      typeof obj.pleine_terre === "object" && obj.pleine_terre !== null
        ? { ...(obj.pleine_terre as object) }
        : {}
    ) as Record<string, unknown>;

    const hauteurs = (
      typeof obj.hauteurs === "object" && obj.hauteurs !== null
        ? { ...(obj.hauteurs as object) }
        : {}
    ) as Record<string, unknown>;

    const densiteEmprise = (
      typeof obj.densite_emprise === "object" && obj.densite_emprise !== null
        ? { ...(obj.densite_emprise as object) }
        : { cos_existe: false }
    ) as Record<string, unknown>;

    const stationnement = (
      typeof obj.stationnement === "object" && obj.stationnement !== null
        ? { ...(obj.stationnement as object) }
        : {}
    ) as Record<string, unknown>;

    const currentPT = typeof pleineTerre.ratio_min === "number" ? pleineTerre.ratio_min : null;
    const ptSuspect = currentPT !== null && currentPT < 0.10;

    if (currentPT === null || ptSuspect) {
      const { ratio, note } = parsePleineTerreRatio(zoneText);
      if (ratio !== null) {
        pleineTerre.ratio_min = ratio;
        pleineTerre.ratio_min_note = note;
        pleineTerre.commentaire = ptSuspect
          ? "Valeur corrigée par heuristique locale."
          : "Valeur extraite par heuristique locale.";
      }
    }

    const currentEgout = typeof hauteurs.h_max_egout_m === "number" ? hauteurs.h_max_egout_m : null;
    const currentFaitage = typeof hauteurs.h_max_faitage_m === "number" ? hauteurs.h_max_faitage_m : null;

    if (currentEgout === null || currentFaitage === null) {
      const { egout, egout_note, faitage, faitage_note } = parseHauteurs(zoneText);
      if (egout !== null && currentEgout === null) {
        hauteurs.h_max_egout_m = egout;
        if (!hauteurs.h_max_egout_note) hauteurs.h_max_egout_note = egout_note;
      }
      if (faitage !== null && currentFaitage === null) {
        hauteurs.h_max_faitage_m = faitage;
        if (!hauteurs.h_max_faitage_note) hauteurs.h_max_faitage_note = faitage_note;
      }
    }

    if (
      (densiteEmprise.emprise_max_ratio === null || densiteEmprise.emprise_max_ratio === undefined) &&
      !densiteEmprise.emprise_max_note
    ) {
      densiteEmprise.emprise_max_note = "Pas de règle fixée";
    }

    if (densiteEmprise.cos_existe === false && !densiteEmprise.cos_note) {
      densiteEmprise.cos_note = "Sans objet";
    }

    const logement = (
      typeof stationnement.logement === "object" && stationnement.logement !== null
        ? { ...(stationnement.logement as object) }
        : {}
    ) as Record<string, unknown>;

    const currentPlaces = typeof logement.places_par_logement === "number"
      ? logement.places_par_logement
      : null;

    if (currentPlaces === null) {
      const { places, note } = parsePlacesParLogement(zoneText);
      if (places !== null) {
        logement.places_par_logement = places;
        if (!logement.places_par_logement_note) logement.places_par_logement_note = note;
        stationnement.logement = logement;
      }
    }

    obj.pleine_terre = pleineTerre;
    obj.hauteurs = hauteurs;
    obj.densite_emprise = densiteEmprise;
    obj.stationnement = stationnement;

    return obj;
  } catch (_e) {
    console.error("[plu-extract-ruleset] heuristic error");
    return ruleset;
  }
}

async function callOpenAI(input: PluExtractInput): Promise<JsonValue> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY_MISSING");
  }

  const body = {
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ],
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error("OPENAI_CALL_FAILED");
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OPENAI_EMPTY_RESPONSE");
  }

  try {
    return JSON.parse(content) as JsonValue;
  } catch {
    throw new Error("OPENAI_JSON_PARSE_FAILED");
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      {
        success: false,
        version: "plu-extract-ruleset-v2.1",
        error: "METHOD_NOT_ALLOWED",
      },
      405,
    );
  }

  try {
    let body: Partial<PluExtractInput>;

    try {
      body = (await req.json()) as Partial<PluExtractInput>;
    } catch (_e) {
      return jsonResponse(
        {
          success: false,
          version: "plu-extract-ruleset-v2.1",
          error: "INVALID_JSON_BODY",
        },
        400,
      );
    }

    const {
      commune_insee,
      commune_nom,
      zone_code,
      source_label,
      source_type,
      zone_text,
      save_to_db,
    } = body;

    if (!commune_insee || !commune_nom || !zone_code || !zone_text) {
      return jsonResponse(
        {
          success: false,
          version: "plu-extract-ruleset-v2.1",
          error: "INVALID_INPUT",
        },
        400,
      );
    }

    const input: PluExtractInput = {
      commune_insee,
      commune_nom,
      zone_code,
      source_label: source_label ?? `PLU ${commune_nom} - Zone ${zone_code}`,
      source_type: (source_type as string) ?? "pdf_upload",
      zone_text,
      save_to_db: save_to_db ?? false,
    };

    const rulesetRaw = await callOpenAI(input);

    const ruleset = enhanceRulesetWithHeuristics(
      rulesetRaw as Record<string, unknown>,
      input.zone_text,
    );

    let dbInfo: PluExtractResponse["db"] = { saved: false };

    if (input.save_to_db) {
      const { error } = await supabase
        .from(PLU_RULESETS_TABLE)
        .insert({
          commune_insee: input.commune_insee,
          commune_nom: input.commune_nom,
          zone_code: input.zone_code,
          source_label: input.source_label,
          source_type: input.source_type,
          rules: ruleset,
        })
        .select("id")
        .single();

      dbInfo = error ? { saved: false } : { saved: true };
    }

    return jsonResponse(
      {
        success: true,
        version: "plu-extract-ruleset-v2.1",
        ruleset,
        db: dbInfo,
      },
      200,
    );
  } catch (_e) {
    console.error("[plu-extract-ruleset] internal error");

    return jsonResponse(
      {
        success: false,
        version: "plu-extract-ruleset-v2.1",
        error: "INTERNAL_ERROR",
      },
      500,
    );
  }
});