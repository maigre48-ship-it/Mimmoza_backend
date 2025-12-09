// supabase/functions/plu-extract-ruleset/index.ts
// Version : plu-extract-ruleset-v1 + heuristiques locales
//
// Objectif :
//  - Entrée : texte brut du règlement d’une ZONE de PLU (UC, UG, etc.)
//  - Sortie : JSON normalisé PLURulesetV2, enrichi si possible par des heuristiques
//  - Optionnel : enregistre dans la table plu_rulesets
//
// Dépendances :
//  - @supabase/supabase-js v2
//  - ../_shared/cors.ts
//  - Variable d'env OPENAI_API_KEY

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

// Optionnel : nom de la table Supabase où on stocke les règles PLU
const PLU_RULESETS_TABLE = "plu_rulesets";

// Modèle OpenAI utilisé (tu peux ajuster)
const OPENAI_MODEL = "gpt-4.1-mini";

// -------------------------------------------------
// Client Supabase (service role)
// -------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -------------------------------------------------
// Types
// -------------------------------------------------

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
  inputs?: PluExtractInput;
  ruleset?: JsonValue;
  db?: {
    saved: boolean;
    record_id?: string;
    table?: string;
    error?: string;
  };
  error?: string;
  details?: unknown;
};

// -------------------------------------------------
// Prompt système : définit le format PLURulesetV2 + consignes strictes
// -------------------------------------------------
const SYSTEM_PROMPT = `
Tu es un expert en urbanisme français et en PLU.
Ta tâche est de convertir un règlement de zone de PLU (texte brut) en un JSON strictement au format PLURulesetV2.

Le schéma PLURulesetV2 est le suivant (types conceptuels) :

type PLURulesetV2 = {
  meta: {
    commune_insee: string;
    commune_nom: string;
    zone_code: string;
    secteur?: string | null;
    source_label: string;
    source_type: "pdf_upload" | "plui" | "test" | "autre";
  };

  usages: {
    autorises: string[];
    interdits?: string[];
    sous_conditions?: string[];
  };

  implantation: {
    alignement_rue?: "obligatoire" | "facultatif" | "interdit" | null;
    recul_min_rue_m?: number | null;
    recul_min_limite_laterale_m?: number | null;
    recul_min_fond_parcelle_m?: number | null;
    regles_prospect?: string | null;
  };

  densite_emprise: {
    emprise_max_ratio?: number | null;
    emprise_max_surface_m2?: number | null;
    cos_existe: boolean;
    cos_max?: number | null;
    max_sdp_m2_par_m2_terrain?: number | null;
    commentaires?: string | null;
  };

  hauteurs: {
    h_max_egout_m?: number | null;
    h_max_faitage_m?: number | null;
    nb_niveaux_max?: number | null;
    secteurs_overrides?: {
      [secteurCode: string]: {
        h_max_egout_m?: number | null;
        h_max_faitage_m?: number | null;
        nb_niveaux_max?: number | null;
      };
    };
    regle_prospect?: string | null;
    commentaires?: string | null;
  };

  pleine_terre: {
    ratio_min?: number | null;
    commentaire?: string | null;
  };

  stationnement: {
    logement?: {
      places_par_logement?: number | null;
      places_par_m2_sdp?: number | null;
      min_places_par_logement?: number | null;
      places_visiteur_par_logements?: {
        logements: number;
        places: number;
      } | null;
    };
    bureau?: {
      places_par_m2_sdp?: number | null;
    };
    commerce?: {
      places_par_m2_sdp?: number | null;
    };
    commentaires?: string | null;
  };

  voirie_acces: {
    largeur_min_acces_m?: number | null;
    observations?: string | null;
  };

  divers: {
    contraintes_patrimoniales?: string | null;
    contraintes_paysageres?: string | null;
    autres?: string | null;
  };

  brut: {
    articles: {
      [articleKey: string]: {
        titre?: string | null;
        contenu: string;
      };
    };
    notes_generales?: string | null;
  };
};

CONSIGNES IMPORTANTES :
- Tu DOIS renvoyer un JSON strictement valide, sans texte avant ou après.
- Ne mets PAS de commentaires dans le JSON.
- Pour les champs numériques, utilise des nombres (ex: 0.4) et pas des chaînes.
- Si une information n’est pas présente, mets null ou un tableau vide selon le type.
- Tu peux choisir librement les clés de brut.articles, par exemple "UC1", "Art 1", "Article 1", etc.
- Ne mets AUCUNE explication en dehors du JSON.
`;

// Fabrique le user prompt à partir de l'input
function buildUserPrompt(input: PluExtractInput): string {
  return `
Commune INSEE : ${input.commune_insee}
Commune : ${input.commune_nom}
Zone : ${input.zone_code}
Source : ${input.source_label ?? "PLU (source inconnue)"}

Texte du règlement de la zone (articles, etc.) :
"""
${input.zone_text}
"""

Tâche :
1. Analyse ce texte.
2. Extrait toutes les informations pertinentes pour remplir un objet PLURulesetV2.
3. Remplis les champs meta avec les informations ci-dessus.
4. Place les articles dans brut.articles, avec une clé par article (ex: "UC1", "UC2", "Article 9", etc.).
5. Retourne UNIQUEMENT le JSON PLURulesetV2.
`;
}

// -------------------------------------------------
// Heuristiques locales (style plu-extract-article-v1)
// -------------------------------------------------

// 1) Emprise max (40% → 0.4)
function parseEmpriseMaxRatioFromText(text: string): number | null {
  const regex = /(\d+(?:[.,]\d+)?)\s*%/;
  const match = text.match(regex);
  if (!match) return null;

  const raw = match[1].replace(",", ".");
  const value = Number(raw);
  if (isNaN(value)) return null;

  return value / 100;
}

// 2) Hauteur max (en m) – on cible les mentions avec “hauteur”, “à l’égout du toit”, etc.
function parseHauteurMaxFromText(text: string): number | null {
  // Cherche un pattern du type "7 mètres" ou "9 m" proche de "hauteur" ou "égout du toit"
  const regex =
    /hauteur[^.]{0,80}?(\d+(?:[.,]\d+)?)\s*m(?:è|e)?tres?|(\d+(?:[.,]\d+)?)\s*m(?:è|e)?tres?[^.]{0,80}?égout du toit/gi;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const numStr = (match[1] ?? match[2])?.toString().replace(",", ".");
    if (!numStr) continue;
    const value = Number(numStr);
    if (!isNaN(value)) return value;
  }

  // fallback très simple : premier "nombre m" dans le texte
  const simple = /(\d+(?:[.,]\d+)?)\s*m(?:è|e)?tres?/i.exec(text);
  if (simple) {
    const raw = simple[1].replace(",", ".");
    const value = Number(raw);
    if (!isNaN(value)) return value;
  }

  return null;
}

// 3) Pleine terre (ratio en %) – on cible les phrases contenant "pleine terre" ou "espaces verts"
function parsePleineTerreRatioFromText(text: string): number | null {
  const regex =
    /(\d+(?:[.,]\d+)?)\s*%[^.]{0,80}?(pleine terre|espaces verts|espaces plantés)/i;
  const match = regex.exec(text);
  if (!match) return null;

  const raw = match[1].replace(",", ".");
  const value = Number(raw);
  if (isNaN(value)) return null;

  return value / 100;
}

// 4) Stationnement logements – "X places par logement"
function parsePlacesParLogementFromText(text: string): number | null {
  const regex =
    /(\d+(?:[.,]\d+)?)\s*(?:places?|pl\.)\s+par\s+logement/i;
  const match = regex.exec(text);
  if (!match) return null;

  const raw = match[1].replace(",", ".");
  const value = Number(raw);
  if (isNaN(value)) return null;

  return value;
}

// Surcouche : enrichit le ruleset produit par OpenAI avec les heuristiques locales
function enhanceRulesetWithHeuristics(
  ruleset: JsonValue,
  zoneText: string,
): JsonValue {
  try {
    const obj = ruleset as any;
    if (!obj || typeof obj !== "object") return ruleset;

    // --------- Sécurise la structure minimale ----------
    if (!obj.densite_emprise || typeof obj.densite_emprise !== "object") {
      obj.densite_emprise = {
        cos_existe: false,
      };
    }
    if (!obj.hauteurs || typeof obj.hauteurs !== "object") {
      obj.hauteurs = {
        h_max_egout_m: null,
        h_max_faitage_m: null,
        nb_niveaux_max: null,
        secteurs_overrides: {},
        regle_prospect: null,
        commentaires: null,
      };
    }
    if (!obj.pleine_terre || typeof obj.pleine_terre !== "object") {
      obj.pleine_terre = {
        ratio_min: null,
        commentaire: null,
      };
    }
    if (!obj.stationnement || typeof obj.stationnement !== "object") {
      obj.stationnement = {
        logement: null,
        bureau: null,
        commerce: null,
        commentaires: null,
      };
    }

    const densite = obj.densite_emprise as any;
    const hauteurs = obj.hauteurs as any;
    const pleineTerre = obj.pleine_terre as any;
    const stationnement = obj.stationnement as any;

    // --------- 1) Emprise au sol (UC9 & cie) ----------
    if (
      densite.emprise_max_ratio === null ||
      typeof densite.emprise_max_ratio === "undefined"
    ) {
      const ratio = parseEmpriseMaxRatioFromText(zoneText);
      if (ratio !== null) {
        densite.emprise_max_ratio = ratio;

        const commentaireExist = densite.commentaires ?? "";
        const ajout =
          "Valeur d'emprise_max_ratio déduite automatiquement du texte brut (heuristique locale).";

        densite.commentaires = commentaireExist
          ? `${commentaireExist} ${ajout}`
          : ajout;
      }
    }

    // --------- 2) Hauteurs (UC10 & assimilés) ----------
    if (
      hauteurs.h_max_egout_m === null ||
      typeof hauteurs.h_max_egout_m === "undefined"
    ) {
      const h = parseHauteurMaxFromText(zoneText);
      if (h !== null) {
        hauteurs.h_max_egout_m = h;

        const commentaireExist = hauteurs.commentaires ?? "";
        const ajout =
          "Hauteur maximale déduite automatiquement du texte brut (heuristique locale).";

        hauteurs.commentaires = commentaireExist
          ? `${commentaireExist} ${ajout}`
          : ajout;
      }
    }

    // --------- 3) Pleine terre (ratio minimal %) ----------
    if (
      pleineTerre.ratio_min === null ||
      typeof pleineTerre.ratio_min === "undefined"
    ) {
      const ratioPT = parsePleineTerreRatioFromText(zoneText);
      if (ratioPT !== null) {
        pleineTerre.ratio_min = ratioPT;

        const commentaireExist = pleineTerre.commentaire ?? "";
        const ajout =
          "Ratio de pleine terre déduit automatiquement du texte brut (heuristique locale).";

        pleineTerre.commentaire = commentaireExist
          ? `${commentaireExist} ${ajout}`
          : ajout;
      }
    }

    // --------- 4) Stationnement logement (places / logement) ----------
    if (stationnement.logement === null) {
      stationnement.logement = {
        places_par_logement: null,
        places_par_m2_sdp: null,
        min_places_par_logement: null,
        places_visiteur_par_logements: null,
      };
    }

    if (
      stationnement.logement.places_par_logement === null ||
      typeof stationnement.logement.places_par_logement === "undefined"
    ) {
      const places = parsePlacesParLogementFromText(zoneText);
      if (places !== null) {
        stationnement.logement.places_par_logement = places;

        const commentaireExist = stationnement.commentaires ?? "";
        const ajout =
          "Nombre de places par logement déduit automatiquement du texte brut (heuristique locale).";

        stationnement.commentaires = commentaireExist
          ? `${commentaireExist} ${ajout}`
          : ajout;
      }
    }

    return obj;
  } catch (_err) {
    // En cas de souci, on renvoie le ruleset brut sans planter la fonction
    return ruleset;
  }
}

// -------------------------------------------------
// Appel OpenAI Chat Completions
// -------------------------------------------------
async function callOpenAIForRuleset(
  input: PluExtractInput,
): Promise<JsonValue> {
  if (!OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY est manquant dans les variables d'environnement.",
    );
  }

  const body = {
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: buildUserPrompt(input),
      },
    ],
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("OpenAI error:", errorText);
    throw new Error(`Erreur OpenAI : ${response.status} ${errorText}`);
  }

  const data = await response.json();

  const content =
    data.choices?.[0]?.message?.content ??
    (() => {
      throw new Error("Réponse OpenAI sans contenu.");
    })();

  // On parse le JSON brut renvoyé par le modèle
  try {
    const parsed = JSON.parse(content);
    return parsed as JsonValue;
  } catch (err) {
    console.error("Erreur parse JSON OpenAI:", err, "content:", content);
    throw new Error("Impossible de parser le JSON renvoyé par OpenAI.");
  }
}

// -------------------------------------------------
// Handler principal
// -------------------------------------------------

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  if (req.method !== "POST") {
    const resp: PluExtractResponse = {
      success: false,
      version: "plu-extract-ruleset-v1",
      error: "Méthode non supportée. Utilise POST.",
    };
    return new Response(JSON.stringify(resp), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  try {
    const body = (await req.json()) as Partial<PluExtractInput>;

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
      const resp: PluExtractResponse = {
        success: false,
        version: "plu-extract-ruleset-v1",
        error:
          "Champs requis manquants : commune_insee, commune_nom, zone_code, zone_text.",
      };
      return new Response(JSON.stringify(resp), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
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

    // 1) Appel OpenAI → JSON PLURulesetV2
    const rulesetRaw = await callOpenAIForRuleset(input);

    // 2) Enrichissement local avec heuristiques (emprise, hauteurs, pleine terre, stationnement)
    const ruleset = enhanceRulesetWithHeuristics(rulesetRaw, input.zone_text);

    let dbInfo: PluExtractResponse["db"] = {
      saved: false,
    };

    // 3) Optionnel : enregistrement dans plu_rulesets
    if (input.save_to_db) {
      const { data, error } = await supabase
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

      if (error) {
        console.error("Erreur insert plu_rulesets:", error);
        dbInfo = {
          saved: false,
          error: error.message,
          table: PLU_RULESETS_TABLE,
        };
      } else {
        dbInfo = {
          saved: true,
          record_id: data.id,
          table: PLU_RULESETS_TABLE,
        };
      }
    }

    const resp: PluExtractResponse = {
      success: true,
      version: "plu-extract-ruleset-v1",
      inputs: input,
      ruleset,
      db: dbInfo,
    };

    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error("Erreur plu-extract-ruleset:", err);
    const resp: PluExtractResponse = {
      success: false,
      version: "plu-extract-ruleset-v1",
      error: "Erreur interne plu-extract-ruleset",
      details: String(err),
    };
    return new Response(JSON.stringify(resp), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
});
