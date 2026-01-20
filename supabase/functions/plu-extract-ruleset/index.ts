// supabase/functions/plu-extract-ruleset/index.ts
// Version : plu-extract-ruleset-v2.1 (PLURulesetV2 + enrichissements juridiques + reculs_objets)
// -----------------------------------------------------------------------------
// Objectif :
//  - Entrée : texte brut du règlement d’une ZONE de PLU (UC, UG, etc.)
//  - Sortie : JSON normalisé PLURulesetV2, enrichi si possible par des heuristiques
//  - Optionnel : enregistre dans la table plu_rulesets
//
// Dépendances :
//  - @supabase/supabase-js v2
//  - ../_shared/cors.ts
//  - Variable d'env OPENAI_API_KEY
//
// Ajout v2 :
//  - Ajout d'une structure "implantation.setbacks" pour porter l'information
//    juridique cruciale : référence de mesure des retraits
//    (ALIGNEMENT / LIMITE_SEPARATIVE / AXE_VOIE / UNKNOWN).
//
// Ajout v2.1 :
//  - Ajout d'une structure "implantation.reculs_objets" pour porter des reculs
//    vis-à-vis d'objets/contraintes (cours d’eau, fossés, ANC, ouvrages EP, etc.).
// -----------------------------------------------------------------------------

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
//
// NOTE v2 : On garde le schéma PLURulesetV2, mais on y ajoute (sans casser)
// la compatibilité) un objet optionnel implantation.setbacks qui contient
// la référence juridique de mesure des retraits.
//
// NOTE v2.1 : On ajoute aussi implantation.reculs_objets pour les reculs
// vis-à-vis d'objets/contraintes (cours d'eau, ANC, ouvrages EP, etc.)
// qui influencent l'implantation réelle mais ne sont pas "voie/limites/fond".
//
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

    // IMPORTANT (v2) : informations juridiques sur la référence de mesure des retraits.
    // reference:
    //  - "ALIGNEMENT" : retrait mesuré depuis l'alignement / limite domaine public / voie
    //  - "AXE_VOIE" : retrait mesuré depuis l'axe de la voie
    //  - "LIMITE_SEPARATIVE" : retrait mesuré depuis les limites séparatives
    //  - "UNKNOWN" : non déterminé (le texte ne le permet pas clairement)
    setbacks?: {
      rue?: { value_m?: number | null; reference?: "ALIGNEMENT" | "AXE_VOIE" | "LIMITE_SEPARATIVE" | "UNKNOWN"; source?: string | null; notes?: string | null; };
      laterale?: { value_m?: number | null; reference?: "ALIGNEMENT" | "AXE_VOIE" | "LIMITE_SEPARATIVE" | "UNKNOWN"; source?: string | null; notes?: string | null; };
      fond?: { value_m?: number | null; reference?: "ALIGNEMENT" | "AXE_VOIE" | "LIMITE_SEPARATIVE" | "UNKNOWN"; source?: string | null; notes?: string | null; };
    } | null;

    // IMPORTANT (v2.1) : reculs vis-à-vis d'objets/contraintes (cours d’eau, fossés, ANC, ouvrages, etc.)
    // Ces règles ne remplacent pas les retraits "voie/limites/fond" : elles les complètent.
    reculs_objets?: Array<{
      objet:
        | "COURS_EAU"
        | "FOSSE"
        | "OUVRAGE_EP_ENTERRE"
        | "ASSAINISSEMENT_INDIVIDUEL_ANC"
        | "BASSIN_RETENTION_NON_ETANCHE"
        | "CONSTRUCTIONS_EXISTANTES"
        | "AUTRE";
      distance_m: number;
      reference?: string | null;
      portee?: "DE_PART_ET_DAUTRE" | "VIS_A_VIS" | "AUTRE" | null;
      condition?: string | null;
      source?: string | null;
      notes?: string | null;
    }> | null;

    commentaires?: string | null;
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
- Si tu identifies des reculs vis-à-vis d'objets (cours d'eau, fossé, ANC, ouvrages enterrés, bassins, etc.), renseigne implantation.reculs_objets.
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
5. Remplis si possible implantation.setbacks.*.reference en fonction du texte :
   - ALIGNEMENT si "alignement", "voie", "domaine public", "limite du domaine public"
   - AXE_VOIE si "axe de la voie"
   - LIMITE_SEPARATIVE si "limite séparative", "limites séparatives", "limite de propriété"
   - UNKNOWN si indéterminé
6. Si le texte contient des reculs vis-à-vis d'objets/contraintes (cours d’eau, fossés, ANC, ouvrages enterrés, bassins de rétention, etc.),
   remplis implantation.reculs_objets (liste structurée).
7. Retourne UNIQUEMENT le JSON PLURulesetV2.
`;
}

// -------------------------------------------------
// Heuristiques locales (style plu-extract-article-v1)
// -------------------------------------------------

// Helpers text
function normText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
  const regex =
    /hauteur[^.]{0,80}?(\d+(?:[.,]\d+)?)\s*m(?:è|e)?tres?|(\d+(?:[.,]\d+)?)\s*m(?:è|e)?tres?[^.]{0,80}?egout du toit/gi;

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
    /(\d+(?:[.,]\d+)?)\s*%[^.]{0,80}?(pleine terre|espaces verts|espaces plantes)/i;
  const match = regex.exec(text);
  if (!match) return null;

  const raw = match[1].replace(",", ".");
  const value = Number(raw);
  if (isNaN(value)) return null;

  return value / 100;
}

// 4) Stationnement logements – "X places par logement"
function parsePlacesParLogementFromText(text: string): number | null {
  const regex = /(\d+(?:[.,]\d+)?)\s*(?:places?|pl\.)\s+par\s+logement/i;
  const match = regex.exec(text);
  if (!match) return null;

  const raw = match[1].replace(",", ".");
  const value = Number(raw);
  if (isNaN(value)) return null;

  return value;
}

// 5) Implantation : détecte un mode d'alignement (obligatoire / facultatif / interdit)
function detectAlignementRueFromText(
  text: string,
): "obligatoire" | "facultatif" | "interdit" | null {
  const t = normText(text);

  // Interdiction explicite de l'alignement (rare)
  if (/(interdit|proscri)t[^.]{0,40}(alignement)/i.test(t)) return "interdit";

  // Implantation obligatoire à l'alignement
  if (
    /(a|à)\s+l[' ]?alignement/.test(t) &&
    /(obligatoire|doit|doivent|est impose|imposee|impose)/.test(t)
  ) {
    return "obligatoire";
  }

  // Mention "implantation à l'alignement" sans obligation claire → facultatif
  if (/(a|à)\s+l[' ]?alignement/.test(t)) return "facultatif";

  // Mention d'un "recul par rapport à l'alignement/voie" peut indiquer que l'alignement
  // n'est pas obligatoire, mais qu'il existe un recul minimal par rapport à la voie.
  if (
    /(recul|retrait)[^.]{0,60}(alignement|voie|domaine public|emprise publique)/.test(
      t,
    )
  ) {
    return "facultatif";
  }

  return null;
}

type SetbackReference = "ALIGNEMENT" | "AXE_VOIE" | "LIMITE_SEPARATIVE" | "UNKNOWN";

function detectRueReferenceFromText(text: string): SetbackReference {
  const t = normText(text);

  // Axe de la voie (mesure depuis axe)
  if (
    /(axe de la voie|axe de la rue|axe de l[' ]?emprise|axe de la chaussee|axe de la chaussée)/.test(
      t,
    )
  ) {
    return "AXE_VOIE";
  }

  // Alignement / voie / domaine public
  if (
    /(alignement|voie|rue|domaine public|emprise publique|limite du domaine public|limite de la voie|bord de voie)/.test(
      t,
    )
  ) {
    return "ALIGNEMENT";
  }

  // On laisse UNKNOWN plutôt que de deviner confirmant "limite séparative"
  return "UNKNOWN";
}

function detectLimitesSeparativesReferenceFromText(text: string): SetbackReference {
  const t = normText(text);
  if (
    /(limite separative|limites separatives|limite de propriete|limites de propriete|limite parcellaire)/.test(
      t,
    )
  ) {
    return "LIMITE_SEPARATIVE";
  }
  return "UNKNOWN";
}

// Ajoute/complète implantation.setbacks à partir de l'extraction OpenAI + heuristiques texte
function enhanceImplantationSetbacks(rulesetObj: any, zoneText: string): void {
  if (!rulesetObj || typeof rulesetObj !== "object") return;

  if (!rulesetObj.implantation || typeof rulesetObj.implantation !== "object") {
    rulesetObj.implantation = {
      alignement_rue: null,
      recul_min_rue_m: null,
      recul_min_limite_laterale_m: null,
      recul_min_fond_parcelle_m: null,
      regles_prospect: null,
      setbacks: null,
      reculs_objets: null,
      commentaires: null,
    };
  }

  const impl = rulesetObj.implantation as any;

  // Normalise champs attendus
  if (!("commentaires" in impl)) impl.commentaires = null;

  // 1) alignement_rue par heuristique si absent
  if (impl.alignement_rue === null || typeof impl.alignement_rue === "undefined") {
    const al = detectAlignementRueFromText(zoneText);
    if (al) {
      impl.alignement_rue = al;
      const ajout =
        "alignement_rue déduit automatiquement du texte brut (heuristique locale).";
      impl.commentaires = impl.commentaires ? `${impl.commentaires} ${ajout}` : ajout;
    }
  }

  // 2) setbacks structure
  if (!impl.setbacks || typeof impl.setbacks !== "object") {
    impl.setbacks = {
      rue: {
        value_m: impl.recul_min_rue_m ?? null,
        reference: "UNKNOWN",
        source: null,
        notes: null,
      },
      laterale: {
        value_m: impl.recul_min_limite_laterale_m ?? null,
        reference: "UNKNOWN",
        source: null,
        notes: null,
      },
      fond: {
        value_m: impl.recul_min_fond_parcelle_m ?? null,
        reference: "UNKNOWN",
        source: null,
        notes: null,
      },
    };
  } else {
    // Ensure keys exist
    if (!impl.setbacks.rue) {
      impl.setbacks.rue = {
        value_m: impl.recul_min_rue_m ?? null,
        reference: "UNKNOWN",
        source: null,
        notes: null,
      };
    }
    if (!impl.setbacks.laterale) {
      impl.setbacks.laterale = {
        value_m: impl.recul_min_limite_laterale_m ?? null,
        reference: "UNKNOWN",
        source: null,
        notes: null,
      };
    }
    if (!impl.setbacks.fond) {
      impl.setbacks.fond = {
        value_m: impl.recul_min_fond_parcelle_m ?? null,
        reference: "UNKNOWN",
        source: null,
        notes: null,
      };
    }
  }

  // 3) Complète les références si UNKNOWN
  const rueRef = detectRueReferenceFromText(zoneText);
  if (
    (!impl.setbacks.rue.reference || impl.setbacks.rue.reference === "UNKNOWN") &&
    rueRef !== "UNKNOWN"
  ) {
    impl.setbacks.rue.reference = rueRef;
    impl.setbacks.rue.notes = "Référence rue déduite automatiquement du texte brut (heuristique locale).";
  }

  // Latéral / fond : si le texte parle de limites séparatives, on force LIMITE_SEPARATIVE
  const sepRef = detectLimitesSeparativesReferenceFromText(zoneText);
  if (
    (!impl.setbacks.laterale.reference || impl.setbacks.laterale.reference === "UNKNOWN") &&
    sepRef !== "UNKNOWN"
  ) {
    impl.setbacks.laterale.reference = "LIMITE_SEPARATIVE";
    impl.setbacks.laterale.notes =
      "Référence latérale déduite automatiquement (limites séparatives).";
  }
  if (
    (!impl.setbacks.fond.reference || impl.setbacks.fond.reference === "UNKNOWN") &&
    sepRef !== "UNKNOWN"
  ) {
    impl.setbacks.fond.reference = "LIMITE_SEPARATIVE";
    impl.setbacks.fond.notes =
      "Référence fond déduite automatiquement (limites séparatives).";
  }

  // Si alignement_rue est "obligatoire", la référence rue est quasi-certainement ALIGNEMENT
  if (impl.alignement_rue === "obligatoire") {
    impl.setbacks.rue.reference = "ALIGNEMENT";
    impl.setbacks.rue.notes = impl.setbacks.rue.notes
      ? `${impl.setbacks.rue.notes} Alignement obligatoire: référence rue forcée à ALIGNEMENT.`
      : "Alignement obligatoire: référence rue forcée à ALIGNEMENT.";
  }

  // Trace enrichissement global
  const ajoutGlobal =
    "implantation.setbacks (références juridiques des retraits) enrichi automatiquement (heuristique locale).";
  impl.commentaires = impl.commentaires ? `${impl.commentaires} ${ajoutGlobal}` : ajoutGlobal;
}

// -----------------------------
// v2.1 : reculs vis-à-vis d'objets
// -----------------------------

type ReculObjet = {
  objet:
    | "COURS_EAU"
    | "FOSSE"
    | "OUVRAGE_EP_ENTERRE"
    | "ASSAINISSEMENT_INDIVIDUEL_ANC"
    | "BASSIN_RETENTION_NON_ETANCHE"
    | "CONSTRUCTIONS_EXISTANTES"
    | "AUTRE";
  distance_m: number;
  reference?: string | null;
  portee?: "DE_PART_ET_DAUTRE" | "VIS_A_VIS" | "AUTRE" | null;
  condition?: string | null;
  source?: string | null;
  notes?: string | null;
};

function parseMetersListFromSentence(s: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:[.,]\d+)?)\s*m\b/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const v = Number(m[1].replace(",", "."));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function extractReculsObjetsFromText(zoneText: string): ReculObjet[] {
  const t = normText(zoneText);
  const items: ReculObjet[] = [];

  const hasPartEtDautre = /de part et d[' ]?autre/.test(t);
  const hasRecul = /(recul|retrait)/.test(t);

  // Cours d'eau / haut de berge
  if (hasRecul && /(cours d[' ]?eau|haut de berge)/.test(t)) {
    // on essaie de capturer le mètre de la phrase "cours d'eau"
    const re = /cours d[' ]?eau[^.]{0,200}?(recul|retrait)[^.]{0,80}?(\d+(?:[.,]\d+)?)\s*m/i;
    const m = re.exec(zoneText);
    const v = m ? Number(m[2].replace(",", ".")) : null;
    if (v !== null && Number.isFinite(v)) {
      items.push({
        objet: "COURS_EAU",
        distance_m: v,
        reference: "haut de berge",
        portee: hasPartEtDautre ? "DE_PART_ET_DAUTRE" : null,
        condition: "à proximité de cours d’eau",
        source: null,
        notes: "Déduit automatiquement (heuristique locale).",
      });
    } else {
      const meters = parseMetersListFromSentence(zoneText);
      if (meters.length) {
        items.push({
          objet: "COURS_EAU",
          distance_m: meters[0],
          reference: "haut de berge",
          portee: hasPartEtDautre ? "DE_PART_ET_DAUTRE" : null,
          condition: "à proximité de cours d’eau",
          source: null,
          notes: "Déduit automatiquement (heuristique locale, fallback).",
        });
      }
    }
  }

  // Fossé
  if (hasRecul && /(fosse|fossé)/.test(t)) {
    const re = /(fosse|fossé)[^.]{0,200}?(recul|retrait)[^.]{0,80}?(\d+(?:[.,]\d+)?)\s*m/i;
    const m = re.exec(zoneText);
    const v = m ? Number(m[3].replace(",", ".")) : null;
    if (v !== null && Number.isFinite(v)) {
      items.push({
        objet: "FOSSE",
        distance_m: v,
        reference: "fossé",
        portee: hasPartEtDautre ? "DE_PART_ET_DAUTRE" : null,
        condition: null,
        source: null,
        notes: "Déduit automatiquement (heuristique locale).",
      });
    }
  }

  // Ouvrage enterré EP (nu extérieur)
  if (hasRecul && /(ouvrage enterre|ouvrage enterré)/.test(t) && /(eaux pluviales|transit)/.test(t)) {
    const re = /(recul|retrait)[^.]{0,120}?(\d+(?:[.,]\d+)?)\s*m[^.]{0,120}?(nu exterieur|nu extérieur)[^.]{0,120}?(ouvrage enterre|ouvrage enterré)/i;
    const m = re.exec(zoneText);
    if (m) {
      const v = Number(m[2].replace(",", "."));
      if (Number.isFinite(v)) {
        items.push({
          objet: "OUVRAGE_EP_ENTERRE",
          distance_m: v,
          reference: "nu extérieur",
          portee: hasPartEtDautre ? "DE_PART_ET_DAUTRE" : null,
          condition: "ouvrage enterré de transit des eaux pluviales",
          source: null,
          notes: "Déduit automatiquement (heuristique locale).",
        });
      }
    }
  }

  // Bassin de rétention non étanche (ANC 3m + constructions 5m)
  if (/(bassin de retention|bassin de rétention)/.test(t) && /(non etanche|non étanche)/.test(t)) {
    // ANC
    const reAnc = /(recul|retrait)[^.]{0,180}?(\d+(?:[.,]\d+)?)\s*m[^.]{0,180}?(assainissement individuel|anc)\b/i;
    const mAnc = reAnc.exec(zoneText);
    if (mAnc) {
      const v = Number(mAnc[2].replace(",", "."));
      if (Number.isFinite(v)) {
        items.push({
          objet: "ASSAINISSEMENT_INDIVIDUEL_ANC",
          distance_m: v,
          reference: null,
          portee: "VIS_A_VIS",
          condition: "bassin de rétention non étanche",
          source: null,
          notes: "Déduit automatiquement (heuristique locale).",
        });
      }
    }

    // Constructions
    const reConstr = /(recul|retrait)[^.]{0,220}?(\d+(?:[.,]\d+)?)\s*m[^.]{0,220}?(vis[- ]a[- ]vis des constructions|vis-à-vis des constructions|vis a vis des constructions|constructions)\b/i;
    const mConstr = reConstr.exec(zoneText);
    if (mConstr) {
      const v = Number(mConstr[2].replace(",", "."));
      if (Number.isFinite(v)) {
        items.push({
          objet: "CONSTRUCTIONS_EXISTANTES",
          distance_m: v,
          reference: null,
          portee: "VIS_A_VIS",
          condition: "bassin de rétention non étanche",
          source: null,
          notes: "Déduit automatiquement (heuristique locale).",
        });
      }
    }

    // Contrainte qualitative (aval hydraulique)
    if (/(aval hydraulique)/.test(t)) {
      items.push({
        objet: "BASSIN_RETENTION_NON_ETANCHE",
        distance_m: 0.1, // marqueur technique (non métrique)
        reference: null,
        portee: "AUTRE",
        condition: "doit être implanté en aval hydraulique du dispositif ANC",
        source: null,
        notes:
          "Contrainte qualitative (non métrique) – à traiter comme règle de faisabilité (pas comme un recul en mètres).",
      });
    }
  }

  // Dé-doublonnage simple
  const key = (x: ReculObjet) =>
    `${x.objet}|${x.distance_m}|${x.reference ?? ""}|${x.portee ?? ""}|${x.condition ?? ""}`;
  const seen = new Set<string>();
  return items.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function enhanceImplantationReculsObjets(rulesetObj: any, zoneText: string): void {
  if (!rulesetObj || typeof rulesetObj !== "object") return;

  if (!rulesetObj.implantation || typeof rulesetObj.implantation !== "object") {
    rulesetObj.implantation = {
      alignement_rue: null,
      recul_min_rue_m: null,
      recul_min_limite_laterale_m: null,
      recul_min_fond_parcelle_m: null,
      regles_prospect: null,
      setbacks: null,
      reculs_objets: null,
      commentaires: null,
    };
  }

  const impl = rulesetObj.implantation as any;

  if (!("reculs_objets" in impl)) impl.reculs_objets = null;

  const extracted = extractReculsObjetsFromText(zoneText);
  if (!extracted.length) return;

  const existing = Array.isArray(impl.reculs_objets) ? impl.reculs_objets : [];
  impl.reculs_objets = [...existing, ...extracted];

  const ajout =
    "implantation.reculs_objets enrichi automatiquement (heuristique locale : cours d’eau / fossé / ANC / ouvrages / bassins).";
  impl.commentaires = impl.commentaires ? `${impl.commentaires} ${ajout}` : ajout;
}

// Surcouche : enrichit le ruleset produit par OpenAI avec les heuristiques locales
function enhanceRulesetWithHeuristics(ruleset: JsonValue, zoneText: string): JsonValue {
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
    if (!obj.implantation || typeof obj.implantation !== "object") {
      obj.implantation = {
        alignement_rue: null,
        recul_min_rue_m: null,
        recul_min_limite_laterale_m: null,
        recul_min_fond_parcelle_m: null,
        regles_prospect: null,
        setbacks: null,
        reculs_objets: null,
        commentaires: null,
      };
    }

    const densite = obj.densite_emprise as any;
    const hauteurs = obj.hauteurs as any;
    const pleineTerre = obj.pleine_terre as any;
    const stationnement = obj.stationnement as any;

    // --------- 1) Emprise au sol ----------
    if (densite.emprise_max_ratio === null || typeof densite.emprise_max_ratio === "undefined") {
      const ratio = parseEmpriseMaxRatioFromText(zoneText);
      if (ratio !== null) {
        densite.emprise_max_ratio = ratio;

        const commentaireExist = densite.commentaires ?? "";
        const ajout =
          "Valeur d'emprise_max_ratio déduite automatiquement du texte brut (heuristique locale).";

        densite.commentaires = commentaireExist ? `${commentaireExist} ${ajout}` : ajout;
      }
    }

    // --------- 2) Hauteurs ----------
    if (hauteurs.h_max_egout_m === null || typeof hauteurs.h_max_egout_m === "undefined") {
      const h = parseHauteurMaxFromText(zoneText);
      if (h !== null) {
        hauteurs.h_max_egout_m = h;

        const commentaireExist = hauteurs.commentaires ?? "";
        const ajout =
          "Hauteur maximale déduite automatiquement du texte brut (heuristique locale).";

        hauteurs.commentaires = commentaireExist ? `${commentaireExist} ${ajout}` : ajout;
      }
    }

    // --------- 3) Pleine terre ----------
    if (pleineTerre.ratio_min === null || typeof pleineTerre.ratio_min === "undefined") {
      const ratioPT = parsePleineTerreRatioFromText(zoneText);
      if (ratioPT !== null) {
        pleineTerre.ratio_min = ratioPT;

        const commentaireExist = pleineTerre.commentaire ?? "";
        const ajout =
          "Ratio de pleine terre déduit automatiquement du texte brut (heuristique locale).";

        pleineTerre.commentaire = commentaireExist ? `${commentaireExist} ${ajout}` : ajout;
      }
    }

    // --------- 4) Stationnement logement ----------
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

        stationnement.commentaires = commentaireExist ? `${commentaireExist} ${ajout}` : ajout;
      }
    }

    // --------- 5) Implantation : références juridiques des retraits ----------
    enhanceImplantationSetbacks(obj, zoneText);

    // --------- 6) Implantation : reculs vis-à-vis d'objets/contraintes ----------
    enhanceImplantationReculsObjets(obj, zoneText);

    return obj;
  } catch (_err) {
    // En cas de souci, on renvoie le ruleset brut sans planter la fonction
    return ruleset;
  }
}

// -------------------------------------------------
// Appel OpenAI Chat Completions
// -------------------------------------------------
async function callOpenAIForRuleset(input: PluExtractInput): Promise<JsonValue> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY est manquant dans les variables d'environnement.");
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
      version: "plu-extract-ruleset-v2.1",
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

    const { commune_insee, commune_nom, zone_code, source_label, source_type, zone_text, save_to_db } =
      body;

    if (!commune_insee || !commune_nom || !zone_code || !zone_text) {
      const resp: PluExtractResponse = {
        success: false,
        version: "plu-extract-ruleset-v2.1",
        error: "Champs requis manquants : commune_insee, commune_nom, zone_code, zone_text.",
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

    // 1) Appel OpenAI → JSON PLURulesetV2(+setbacks + reculs_objets)
    const rulesetRaw = await callOpenAIForRuleset(input);

    // 2) Enrichissement local avec heuristiques (emprise, hauteurs, pleine terre, stationnement, implantation.setbacks, implantation.reculs_objets)
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
      version: "plu-extract-ruleset-v2.1",
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
      version: "plu-extract-ruleset-v2.1",
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
