// ============================================
// PLU Rules Engine v1 - Edge Function
// ============================================
// Normalise les règles PLU brutes en règles chiffrées
// exploitables par l'Implantation 2D.
//
// Version: heuristic_v1
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================
// Configuration
// ============================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const ENGINE_VERSION = "heuristic_v1";

// ============================================
// Types
// ============================================

interface RequestBody {
  document_id: string;
  overwrite?: boolean;
}

type RegleType = "FIXED" | "H_OVER_2" | "H_OVER_2_MIN" | null;

interface FacadeRecul {
  recul_min_m: number | null;
  regle: RegleType;
  min_m: number | null;
  note: string | null;
}

interface FacadesReculs {
  avant: FacadeRecul;
  laterales: FacadeRecul;
  fond: FacadeRecul;
}

interface NormalizedRules {
  implantation: {
    recul_voirie_min_m: number | null;
    recul_limite_separative_min_m: number | null;
    implantation_en_limite_autorisee: boolean | null;
    facades: FacadesReculs;
  };
  emprise: {
    ces_max_percent: number | null;
  };
  hauteur: {
    hauteur_max_m: number | null;
    hauteur_max_niveaux: number | null;
  };
  stationnement: {
    places_par_logement: number | null;
    places_par_100m2: number | null;
  };
}

interface NormalizedRulesWithMeta extends NormalizedRules {
  meta: {
    engine_version: string;
    notes: string[];
  };
}

interface ZoneRuleset {
  zone_code?: string;
  zone_libelle?: string;
  articles?: Record<string, string>;
  raw_text?: string;
  [key: string]: unknown;
}

interface ExtractionResult {
  rules: NormalizedRules;
  confidence_score: number;
  notes: string[];
}

interface FacadeExtractionResult {
  value: number | null;
  regle: RegleType;
  min_m: number | null;
  note: string | null;
}

// ============================================
// Heuristiques d'extraction - Version 1
// ============================================

/**
 * Normalise un texte pour faciliter l'extraction
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrait un nombre décimal d'un texte
 */
function extractNumber(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (match && match[1]) {
    const num = parseFloat(match[1].replace(",", "."));
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Détecte une règle H/2 et extrait le minimum si présent
 */
function detectHOver2Rule(
  text: string,
  contextPatterns: RegExp[]
): { isHOver2: boolean; min_m: number | null } {
  const normalized = normalizeText(text);

  // Vérifier si le contexte correspond
  let contextMatch = false;
  for (const pattern of contextPatterns) {
    if (pattern.test(normalized)) {
      contextMatch = true;
      break;
    }
  }

  if (!contextMatch) {
    return { isHOver2: false, min_m: null };
  }

  // Patterns H/2
  const hOver2Patterns = [
    /h\s*\/\s*2/i,
    /l\s*=\s*h\s*\/\s*2/i,
    /moitie\s+(?:de\s+)?(?:la\s+)?hauteur/i,
    /hauteur\s+divisee\s+par\s+2/i,
  ];

  let isHOver2 = false;
  for (const pattern of hOver2Patterns) {
    if (pattern.test(normalized)) {
      isHOver2 = true;
      break;
    }
  }

  if (!isHOver2) {
    return { isHOver2: false, min_m: null };
  }

  // Chercher le minimum associé
  const minPatterns = [
    /h\s*\/\s*2\s+(?:avec\s+)?(?:un\s+)?minimum\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*m/i,
    /minimum\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*m[^.]*h\s*\/\s*2/i,
    /(\d+(?:[.,]\d+)?)\s*m\s+minimum[^.]*h\s*\/\s*2/i,
    /h\s*\/\s*2[^.]*(?:sans\s+(?:etre|pouvoir)[^.]*inferieur[^.]*a\s+)?(\d+(?:[.,]\d+)?)\s*m/i,
  ];

  for (const pattern of minPatterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const min_m = parseFloat(match[1].replace(",", "."));
      if (!isNaN(min_m) && min_m >= 0 && min_m <= 50) {
        return { isHOver2: true, min_m };
      }
    }
  }

  return { isHOver2: true, min_m: null };
}

/**
 * Extrait le recul par rapport à la voirie (façade AVANT)
 */
function extractReculVoirie(text: string): { value: number | null; note: string | null } {
  const normalized = normalizeText(text);

  // Patterns pour recul voirie / alignement
  const patterns = [
    // NOUVEAUX PATTERNS PRIORITAIRES (ajoutés pour capturer "Recul minimum de 3 m par rapport à la voirie")
    /recul[^0-9]{0,20}(\d+(?:[.,]\d+)?)\s*m(?:etres?)?[^.]{0,60}(?:voirie|voie|alignement)/i,
    /recul\s+(?:minimum\s+)?(?:de\s+)?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:par\s+rapport\s+a)\s+(?:la\s+)?(?:voie|voirie|alignement)/i,
    // PATTERNS EXISTANTS
    // "recul de X m par rapport à la voie/voirie/alignement"
    /recul\s+(?:minimum\s+)?(?:de\s+)?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:par rapport|depuis|de)\s+(?:la\s+)?(?:voie|voirie|alignement|emprise)/i,
    // "X m de recul par rapport à la voirie"
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:de\s+)?recul\s+(?:par rapport|depuis)\s+(?:la\s+)?(?:voie|voirie)/i,
    // "implantation à X m minimum de la voie"
    /implantation\s+a\s+(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:minimum\s+)?(?:de\s+)?(?:la\s+)?(?:voie|voirie)/i,
    // "à X m de l'alignement"
    /a\s+(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:minimum\s+)?(?:de\s+)?l'alignement/i,
    // "recul minimum : X m" ou "recul min. X m"
    /recul\s+(?:minimum|min\.?)\s*:?\s*(\d+(?:[.,]\d+)?)\s*m/i,
    // Simple: "recul X m" dans contexte voirie
    /(?:voirie|voie|alignement)[^.]*recul[^.]*?(\d+(?:[.,]\d+)?)\s*m/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const value = parseFloat(match[1].replace(",", "."));
      if (!isNaN(value) && value >= 0 && value <= 100) {
        return { value, note: null };
      }
    }
  }

  // Chercher mention sans valeur numérique claire
  if (/recul\s+(?:par rapport|depuis)\s+(?:la\s+)?(?:voie|voirie)/.test(normalized)) {
    return { value: null, note: "Recul voirie mentionné mais valeur non extraite" };
  }

  return { value: null, note: null };
}

/**
 * Extrait le recul façade AVANT avec règle détaillée
 */
function extractReculAvant(text: string): FacadeExtractionResult {
  // Contextes pour façade avant
  const contextPatterns = [
    /voirie|voie|alignement|facade\s+(?:sur\s+)?(?:rue|voie)|front\s+(?:de\s+)?(?:rue|parcelle)/i,
  ];

  // D'abord vérifier H/2
  const hOver2 = detectHOver2Rule(text, contextPatterns);
  if (hOver2.isHOver2) {
    const regle: RegleType = hOver2.min_m !== null ? "H_OVER_2_MIN" : "H_OVER_2";
    const noteText =
      hOver2.min_m !== null
        ? `H/2 avec minimum ${hOver2.min_m} m par rapport à la voirie`
        : "H/2 par rapport à la voirie";
    return {
      value: null,
      regle,
      min_m: hOver2.min_m,
      note: noteText,
    };
  }

  // Sinon extraction classique
  const extraction = extractReculVoirie(text);

  if (extraction.value !== null) {
    return {
      value: extraction.value,
      regle: "FIXED",
      min_m: null,
      note: null,
    };
  }

  return {
    value: null,
    regle: null,
    min_m: null,
    note: extraction.note,
  };
}

/**
 * Extrait le recul par rapport aux limites séparatives LATÉRALES
 */
function extractReculLateral(text: string): FacadeExtractionResult {
  const normalized = normalizeText(text);

  // Contextes pour limites latérales
  const contextPatterns = [
    /limit(?:es?)?\s+(?:separativ[es]*\s+)?lateral/i,
    /lateral[es]?\s+(?:limit|separativ)/i,
    /limites?\s+separativ/i, // contexte général si pas de "fond" ou "arrière"
  ];

  // Vérifier H/2 dans contexte latéral
  const hOver2 = detectHOver2Rule(text, contextPatterns);
  if (hOver2.isHOver2) {
    const regle: RegleType = hOver2.min_m !== null ? "H_OVER_2_MIN" : "H_OVER_2";
    const noteText =
      hOver2.min_m !== null
        ? `H/2 avec minimum ${hOver2.min_m} m aux limites latérales`
        : "H/2 aux limites latérales";
    return {
      value: null,
      regle,
      min_m: hOver2.min_m,
      note: noteText,
    };
  }

  // Patterns spécifiques latéral
  const lateralPatterns = [
    // "limites séparatives latérales ... X m"
    /limit(?:es?)?\s+(?:separativ[es]*\s+)?lateral[es]?[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    // "recul latéral ... X m"
    /recul\s+lateral[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    // "X m des limites latérales"
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:des?\s+)?limit(?:es?)?\s+(?:separativ[es]*\s+)?lateral/i,
    // "distance aux limites latérales : X m"
    /distance\s+(?:aux?\s+)?limit(?:es?)?\s+(?:separativ[es]*\s+)?lateral[es]?\s*:?\s*(\d+(?:[.,]\d+)?)\s*m/i,
    // "X m minimum des limites latérales"
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:minimum\s+)?(?:des?\s+)?(?:limites?\s+)?lateral/i,
  ];

  for (const pattern of lateralPatterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const value = parseFloat(match[1].replace(",", "."));
      if (!isNaN(value) && value >= 0 && value <= 100) {
        return {
          value,
          regle: "FIXED",
          min_m: null,
          note: null,
        };
      }
    }
  }

  // Mention latéral sans valeur
  if (/lateral/.test(normalized) && /limit|recul|distance/.test(normalized)) {
    return {
      value: null,
      regle: null,
      min_m: null,
      note: "Recul latéral mentionné mais valeur non extraite",
    };
  }

  return {
    value: null,
    regle: null,
    min_m: null,
    note: null,
  };
}

/**
 * Extrait le recul par rapport au FOND de parcelle
 */
function extractReculFond(text: string): FacadeExtractionResult {
  const normalized = normalizeText(text);

  // Contextes pour fond de parcelle
  const contextPatterns = [
    /fond\s+(?:de\s+)?parcelle/i,
    /limite?\s+(?:separativ[es]*)?\s*(?:de\s+)?fond/i,
    /limite?\s+(?:separativ[es]*)?\s*arriere/i,
    /recul\s+arriere/i,
    /facade\s+arriere/i,
  ];

  // Vérifier H/2 dans contexte fond
  const hOver2 = detectHOver2Rule(text, contextPatterns);
  if (hOver2.isHOver2) {
    const regle: RegleType = hOver2.min_m !== null ? "H_OVER_2_MIN" : "H_OVER_2";
    const noteText =
      hOver2.min_m !== null
        ? `H/2 avec minimum ${hOver2.min_m} m en fond de parcelle`
        : "H/2 en fond de parcelle";
    return {
      value: null,
      regle,
      min_m: hOver2.min_m,
      note: noteText,
    };
  }

  // Patterns spécifiques fond/arrière
  const fondPatterns = [
    // "fond de parcelle ... X m"
    /fond\s+(?:de\s+)?parcelle[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    // "recul arrière ... X m"
    /recul\s+arriere[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    // "limite séparative arrière ... X m"
    /limite?\s+(?:separativ[es]*)?\s*arriere[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    // "X m du fond de parcelle"
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:du\s+)?fond\s+(?:de\s+)?parcelle/i,
    // "X m de la limite arrière"
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:de\s+)?(?:la\s+)?limite?\s+arriere/i,
    // "distance au fond : X m"
    /distance\s+(?:au\s+)?fond[^.]*?(\d+(?:[.,]\d+)?)\s*m/i,
    // "limite de fond ... X m"
    /limite?\s+(?:de\s+)?fond[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    // "X m minimum en fond"
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:minimum\s+)?(?:en\s+)?fond/i,
  ];

  for (const pattern of fondPatterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const value = parseFloat(match[1].replace(",", "."));
      if (!isNaN(value) && value >= 0 && value <= 100) {
        return {
          value,
          regle: "FIXED",
          min_m: null,
          note: null,
        };
      }
    }
  }

  // Mention fond/arrière sans valeur
  if (
    /fond\s+(?:de\s+)?parcelle|arriere/.test(normalized) &&
    /limit|recul|distance/.test(normalized)
  ) {
    return {
      value: null,
      regle: null,
      min_m: null,
      note: "Recul fond/arrière mentionné mais valeur non extraite",
    };
  }

  return {
    value: null,
    regle: null,
    min_m: null,
    note: null,
  };
}

/**
 * Extrait le recul par rapport aux limites séparatives (global - conservé pour rétrocompatibilité)
 */
function extractReculLimiteSeparative(text: string): { value: number | null; note: string | null } {
  const normalized = normalizeText(text);

  const patterns = [
    // "recul de X m par rapport aux limites séparatives"
    /recul\s+(?:minimum\s+)?(?:de\s+)?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:par rapport|depuis|des?)\s+(?:aux?\s+)?limit(?:es?)?\s+separativ/i,
    // "X m des limites séparatives"
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:minimum\s+)?(?:des?\s+)?limit(?:es?)?\s+separativ/i,
    // "distance aux limites : X m"
    /distance\s+(?:aux?\s+)?limit(?:es?)?\s+(?:separativ[es]*)?\s*:?\s*(\d+(?:[.,]\d+)?)\s*m/i,
    // "limite séparative ... X m"
    /limit(?:es?)?\s+separativ[^.]*?(\d+(?:[.,]\d+)?)\s*m/i,
    // "H/2 avec minimum de X m" (pattern courant)
    /h\/2\s+(?:avec\s+)?(?:un\s+)?minimum\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*m/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const value = parseFloat(match[1].replace(",", "."));
      if (!isNaN(value) && value >= 0 && value <= 100) {
        return { value, note: null };
      }
    }
  }

  // Détecter formule H/2 sans minimum fixe
  if (/l\s*=\s*h\s*\/\s*2|distance.*h\/2|recul.*h\/2/.test(normalized)) {
    return { value: null, note: "Recul calculé en H/2 (variable selon hauteur)" };
  }

  if (/limit(?:es?)?\s+separativ/.test(normalized)) {
    return { value: null, note: "Limites séparatives mentionnées mais valeur non extraite" };
  }

  return { value: null, note: null };
}

/**
 * Détermine si l'implantation en limite est autorisée
 */
function extractImplantationEnLimite(text: string): { value: boolean | null; note: string | null } {
  const normalized = normalizeText(text);

  // Patterns positifs (implantation en limite autorisée)
  const positivePatterns = [
    /implantation\s+(?:en|sur)\s+(?:la\s+)?limite/i,
    /(?:peut|peuvent)\s+(?:etre\s+)?implant[ée]s?\s+(?:en|sur)\s+limite/i,
    /construction\s+(?:en|sur)\s+limite\s+(?:est\s+)?autoris[ée]/i,
    /autoris[ée]\s+(?:en|sur)\s+(?:la\s+)?limite/i,
    /(?:en|sur)\s+limite\s+separative\s+(?:est\s+)?(?:possible|autoris[ée]|admis)/i,
    /implantation\s+(?:possible|autorisee)\s+(?:en|sur)\s+limite/i,
  ];

  // Patterns négatifs (implantation en limite interdite)
  const negativePatterns = [
    /implantation\s+(?:en|sur)\s+limite\s+(?:est\s+)?(?:interdite?|prohib[ée])/i,
    /(?:ne\s+(?:peut|peuvent)\s+(?:pas\s+)?(?:etre\s+)?implant|pas\s+d'implantation)\s+(?:en|sur)\s+limite/i,
    /(?:interdiction|prohibition)\s+(?:d')?implantation\s+(?:en|sur)\s+limite/i,
  ];

  for (const pattern of positivePatterns) {
    if (pattern.test(normalized)) {
      return { value: true, note: null };
    }
  }

  for (const pattern of negativePatterns) {
    if (pattern.test(normalized)) {
      return { value: false, note: null };
    }
  }

  // Mention ambiguë
  if (/limite\s+separative/.test(normalized) || /implantation/.test(normalized)) {
    return { value: null, note: "Règles d'implantation présentes mais clarté insuffisante" };
  }

  return { value: null, note: null };
}

/**
 * Extrait le Coefficient d'Emprise au Sol (CES)
 */
function extractCES(text: string): { value: number | null; note: string | null } {
  const normalized = normalizeText(text);

  const patterns = [
    // "emprise au sol maximale de X%"
    /emprise\s+(?:au\s+)?sol\s+(?:maximale?\s+)?(?:de\s+)?(\d+(?:[.,]\d+)?)\s*%/i,
    // "CES : X%" ou "CES max : X%"
    /ces\s+(?:max(?:imale?)?\s*)?:?\s*(\d+(?:[.,]\d+)?)\s*%/i,
    // "coefficient d'emprise au sol : X%"
    /coefficient\s+(?:d')?emprise\s+(?:au\s+)?sol\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/i,
    // "X% d'emprise au sol"
    /(\d+(?:[.,]\d+)?)\s*%\s+(?:d')?emprise\s+(?:au\s+)?sol/i,
    // "emprise maximale X%"
    /emprise\s+(?:maximale?|max\.?)\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/i,
    // "ne peut excéder X% de la surface"
    /(?:ne\s+(?:peut|doit)\s+(?:pas\s+)?exceder|maximum)\s+(\d+(?:[.,]\d+)?)\s*%\s+(?:de\s+)?(?:la\s+)?(?:surface|parcelle)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const value = parseFloat(match[1].replace(",", "."));
      if (!isNaN(value) && value > 0 && value <= 100) {
        return { value, note: null };
      }
    }
  }

  // Chercher mention sans valeur
  if (/emprise\s+(?:au\s+)?sol|ces\b/.test(normalized)) {
    return { value: null, note: "Emprise au sol mentionnée mais valeur non extraite" };
  }

  return { value: null, note: null };
}

/**
 * Extrait la hauteur maximale en mètres
 */
function extractHauteurMetres(text: string): { value: number | null; note: string | null } {
  const normalized = normalizeText(text);

  const patterns = [
    // "hauteur maximale de X m"
    /hauteur\s+(?:maximale?|max\.?)\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?(?!\s*²)/i,
    // "hauteur : X m" ou "hauteur max : X m"
    /hauteur\s+(?:max(?:imale?)?\s*)?:?\s*(\d+(?:[.,]\d+)?)\s*m(?:etres?)?(?!\s*²)/i,
    // "X m de hauteur"
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:de\s+)?hauteur/i,
    // "ne peut excéder X m"
    /(?:hauteur|construction)[^.]*(?:ne\s+(?:peut|doit)\s+(?:pas\s+)?exceder|maximum)\s+(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    // "plafond à X m" ou "limitée à X m"
    /(?:plafond|limit[ée]e?)\s+a\s+(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    // "X m au faîtage/à l'égout"
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:au\s+)?(?:faitage|egout|acrotere)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const value = parseFloat(match[1].replace(",", "."));
      // Hauteur réaliste entre 3m et 100m
      if (!isNaN(value) && value >= 3 && value <= 100) {
        return { value, note: null };
      }
    }
  }

  if (/hauteur/.test(normalized)) {
    return { value: null, note: "Hauteur mentionnée mais valeur non extraite" };
  }

  return { value: null, note: null };
}

/**
 * Extrait la hauteur maximale en niveaux (R+X)
 */
function extractHauteurNiveaux(text: string): { value: number | null; note: string | null } {
  const normalized = normalizeText(text);

  const patterns = [
    // "R+X" - le plus courant
    /\br\s*\+\s*(\d+)\b/i,
    // "rez-de-chaussée + X étages"
    /rez[- ]de[- ]chaussee\s*\+\s*(\d+)\s*etages?/i,
    // "X niveaux" ou "X étages"
    /(\d+)\s*(?:niveaux|etages?)\s+(?:maximum|max\.?|au\s+plus)/i,
    // "maximum X niveaux"
    /(?:maximum|max\.?)\s+(\d+)\s*(?:niveaux|etages?)/i,
    // "hauteur limitée à X niveaux"
    /hauteur\s+(?:limitee|maximale?)\s+(?:a\s+)?(\d+)\s*(?:niveaux|etages?)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      let value = parseInt(match[1], 10);

      // Si c'est un pattern R+X, ajouter 1 pour le RDC
      if (/r\s*\+/i.test(match[0])) {
        value = value + 1;
      }

      // Niveaux réalistes entre 1 et 20
      if (!isNaN(value) && value >= 1 && value <= 20) {
        return { value, note: null };
      }
    }
  }

  if (/niveaux?|etages?|r\s*\+/.test(normalized)) {
    return { value: null, note: "Niveaux mentionnés mais valeur non extraite" };
  }

  return { value: null, note: null };
}

/**
 * Extrait le nombre de places de stationnement par logement
 */
function extractPlacesParLogement(text: string): { value: number | null; note: string | null } {
  const normalized = normalizeText(text);

  const patterns = [
    // "X place(s) par logement"
    /(\d+(?:[.,]\d+)?)\s*places?\s+(?:de\s+stationnement\s+)?par\s+logement/i,
    // "X places/logement"
    /(\d+(?:[.,]\d+)?)\s*places?\s*\/\s*logement/i,
    // "1 place pour X logements" → inverser
    /1\s*place\s+(?:pour|par)\s+(\d+)\s*logements?/i,
    // "stationnement : X places par logement"
    /stationnement[^.]*?(\d+(?:[.,]\d+)?)\s*places?\s+(?:par|pour\s+chaque)\s+logement/i,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const match = normalized.match(patterns[i]);
    if (match && match[1]) {
      let value = parseFloat(match[1].replace(",", "."));

      // Pattern "1 place pour X logements" → inverser
      if (i === 2 && value > 1) {
        value = 1 / value;
      }

      // Valeurs réalistes entre 0.5 et 5
      if (!isNaN(value) && value >= 0.25 && value <= 5) {
        return { value, note: null };
      }
    }
  }

  if (/stationnement|parking|places?/.test(normalized) && /logement/.test(normalized)) {
    return { value: null, note: "Stationnement/logement mentionné mais valeur non extraite" };
  }

  return { value: null, note: null };
}

/**
 * Extrait le nombre de places de stationnement par 100m²
 */
function extractPlacesPar100m2(text: string): { value: number | null; note: string | null } {
  const normalized = normalizeText(text);

  const patterns = [
    // "X place(s) par/pour 100 m²"
    /(\d+(?:[.,]\d+)?)\s*places?\s+(?:par|pour)\s+100\s*m(?:2|²)/i,
    // "1 place pour X m²" → convertir en places/100m²
    /1\s*place\s+(?:pour|par)\s+(\d+)\s*m(?:2|²)/i,
    // "X places/100m²"
    /(\d+(?:[.,]\d+)?)\s*places?\s*\/\s*100\s*m(?:2|²)/i,
    // "stationnement : X places pour 100 m² de SHON/SDP"
    /stationnement[^.]*?(\d+(?:[.,]\d+)?)\s*places?\s+(?:par|pour)\s+100\s*m(?:2|²)/i,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const match = normalized.match(patterns[i]);
    if (match && match[1]) {
      let value = parseFloat(match[1].replace(",", "."));

      // Pattern "1 place pour X m²" → convertir
      if (i === 1 && value > 0) {
        value = 100 / value;
      }

      // Valeurs réalistes entre 0.5 et 10
      if (!isNaN(value) && value >= 0.1 && value <= 10) {
        return { value: Math.round(value * 100) / 100, note: null };
      }
    }
  }

  if (/stationnement|parking|places?/.test(normalized) && /m(?:2|²)|surface/.test(normalized)) {
    return { value: null, note: "Stationnement/surface mentionné mais valeur non extraite" };
  }

  return { value: null, note: null };
}

// ============================================
// Extraction principale
// ============================================

/**
 * Crée un objet FacadeRecul vide
 */
function createEmptyFacadeRecul(): FacadeRecul {
  return {
    recul_min_m: null,
    regle: null,
    min_m: null,
    note: null,
  };
}

/**
 * Crée un objet rules vide
 */
function createEmptyRules(): NormalizedRules {
  return {
    implantation: {
      recul_voirie_min_m: null,
      recul_limite_separative_min_m: null,
      implantation_en_limite_autorisee: null,
      facades: {
        avant: createEmptyFacadeRecul(),
        laterales: createEmptyFacadeRecul(),
        fond: createEmptyFacadeRecul(),
      },
    },
    emprise: {
      ces_max_percent: null,
    },
    hauteur: {
      hauteur_max_m: null,
      hauteur_max_niveaux: null,
    },
    stationnement: {
      places_par_logement: null,
      places_par_100m2: null,
    },
  };
}

/**
 * Patch minimal priorité façades:
 * - On récupère d'abord les valeurs FIXED (si présentes) sans se faire court-circuiter par H/2
 * - Puis on merge avec les résultats "façades" existants selon priorité:
 *   FIXED > H_OVER_2_MIN > H_OVER_2 > null
 *
 * NB: On ne refactor pas les extractReculAvant/Lateral/Fond; on corrige à l'assemblage.
 */
function extractFixedReculLateralOnly(text: string): number | null {
  const normalized = normalizeText(text);
  const lateralPatterns = [
    /limit(?:es?)?\s+(?:separativ[es]*\s+)?lateral[es]?[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    /recul\s+lateral[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:des?\s+)?limit(?:es?)?\s+(?:separativ[es]*\s+)?lateral/i,
    /distance\s+(?:aux?\s+)?limit(?:es?)?\s+(?:separativ[es]*\s+)?lateral[es]?\s*:?\s*(\d+(?:[.,]\d+)?)\s*m/i,
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:minimum\s+)?(?:des?\s+)?(?:limites?\s+)?lateral/i,
  ];

  for (const pattern of lateralPatterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const value = parseFloat(match[1].replace(",", "."));
      if (!isNaN(value) && value >= 0 && value <= 100) return value;
    }
  }
  return null;
}

function extractFixedReculFondOnly(text: string): number | null {
  const normalized = normalizeText(text);
  const fondPatterns = [
    /fond\s+(?:de\s+)?parcelle[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    /recul\s+arriere[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    /limite?\s+(?:separativ[es]*)?\s*arriere[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:du\s+)?fond\s+(?:de\s+)?parcelle/i,
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:de\s+)?(?:la\s+)?limite?\s+arriere/i,
    /distance\s+(?:au\s+)?fond[^.]*?(\d+(?:[.,]\d+)?)\s*m/i,
    /limite?\s+(?:de\s+)?fond[^.]*?(\d+(?:[.,]\d+)?)\s*m(?:etres?)?/i,
    /(\d+(?:[.,]\d+)?)\s*m(?:etres?)?\s+(?:minimum\s+)?(?:en\s+)?fond/i,
  ];

  for (const pattern of fondPatterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const value = parseFloat(match[1].replace(",", "."));
      if (!isNaN(value) && value >= 0 && value <= 100) return value;
    }
  }
  return null;
}

function mergeFacadeWithPriority(
  base: FacadeExtractionResult,
  fixedValue: number | null,
  fixedNoteHint: string | null
): FacadeRecul {
  // 1) FIXED gagne toujours si une valeur explicite existe
  if (fixedValue !== null) {
    // Option: conserver la note H/2 en info secondaire si présente
    const secondary =
      base.regle === "H_OVER_2" || base.regle === "H_OVER_2_MIN"
        ? base.note
        : null;

    const note =
      secondary && fixedNoteHint
        ? `${fixedNoteHint} (note: ${secondary})`
        : fixedNoteHint ?? secondary ?? null;

    return {
      recul_min_m: fixedValue,
      regle: "FIXED",
      min_m: null,
      note,
    };
  }

  // 2) Sinon on conserve le résultat existant (H_OVER_2_MIN > H_OVER_2 > null)
  //    NB: si base.regle === "FIXED", base.value est déjà une valeur explicite.
  return {
    recul_min_m: base.value,
    regle: base.regle,
    min_m: base.min_m,
    note: base.note,
  };
}

/**
 * Extrait et normalise les règles d'une zone PLU
 */
function extractRulesFromZone(zone: ZoneRuleset): ExtractionResult {
  const notes: string[] = [];
  // 8 champs de base + 3 façades = 11 champs
  const totalFields = 11;
  let extractedFields = 0;

  // Construire le texte complet à analyser
  let fullText = "";

  if (zone.raw_text) {
    fullText += zone.raw_text + " ";
  }

  if (zone.articles) {
    for (const [, articleText] of Object.entries(zone.articles)) {
      if (typeof articleText === "string") {
        fullText += articleText + " ";
      }
    }
  }

  // Ajouter tout autre champ textuel
  for (const [key, value] of Object.entries(zone)) {
    if (typeof value === "string" && !["zone_code", "zone_libelle", "raw_text"].includes(key)) {
      fullText += value + " ";
    }
  }

  // Si pas de texte, retourner des règles vides
  if (!fullText.trim()) {
    return {
      rules: createEmptyRules(),
      confidence_score: 0,
      notes: ["Aucun texte exploitable trouvé pour cette zone"],
    };
  }

  // ============================================
  // Extraire les règles classiques (rétrocompatibilité)
  // ============================================
  const reculVoirie = extractReculVoirie(fullText);
  const reculSeparative = extractReculLimiteSeparative(fullText);
  const implantationLimite = extractImplantationEnLimite(fullText);
  const ces = extractCES(fullText);
  const hauteurM = extractHauteurMetres(fullText);
  const hauteurN = extractHauteurNiveaux(fullText);
  const placesLogement = extractPlacesParLogement(fullText);
  const places100m2 = extractPlacesPar100m2(fullText);

  // ============================================
  // Extraire les reculs par façade (nouveau)
  // ============================================
  // Base (peut être H/2 en premier dans tes extracteurs)
  const baseFacadeAvant = extractReculAvant(fullText);
  const baseFacadeLaterale = extractReculLateral(fullText);
  const baseFacadeFond = extractReculFond(fullText);

  // FIXED "gagnant" (extrait sans court-circuit H/2)
  // - avant: on se base sur extractReculVoirie, qui est déjà numeric-first
  const fixedAvant = reculVoirie.value;
  const fixedLaterales = extractFixedReculLateralOnly(fullText);
  const fixedFond = extractFixedReculFondOnly(fullText);

  // Merge selon priorité FIXED > H_OVER_2_MIN > H_OVER_2 > null
  const facadeAvant = mergeFacadeWithPriority(
    baseFacadeAvant,
    fixedAvant,
    fixedAvant !== null ? `Recul avant fixé à ${fixedAvant} m` : null
  );

  const facadeLaterale = mergeFacadeWithPriority(
    baseFacadeLaterale,
    fixedLaterales,
    fixedLaterales !== null ? `Recul latéral fixé à ${fixedLaterales} m` : null
  );

  const facadeFond = mergeFacadeWithPriority(
    baseFacadeFond,
    fixedFond,
    fixedFond !== null ? `Recul fond fixé à ${fixedFond} m` : null
  );

  // Collecter les notes des extractions classiques
  if (reculVoirie.note) notes.push(reculVoirie.note);
  if (reculSeparative.note) notes.push(reculSeparative.note);
  if (implantationLimite.note) notes.push(implantationLimite.note);
  if (ces.note) notes.push(ces.note);
  if (hauteurM.note) notes.push(hauteurM.note);
  if (hauteurN.note) notes.push(hauteurN.note);
  if (placesLogement.note) notes.push(placesLogement.note);
  if (places100m2.note) notes.push(places100m2.note);

  // Collecter les notes des façades (éviter doublons)
  if (facadeAvant.note && !notes.includes(facadeAvant.note)) notes.push(facadeAvant.note);
  if (facadeLaterale.note && !notes.includes(facadeLaterale.note)) notes.push(facadeLaterale.note);
  if (facadeFond.note && !notes.includes(facadeFond.note)) notes.push(facadeFond.note);

  // Compter les champs extraits (classiques)
  if (reculVoirie.value !== null) extractedFields++;
  if (reculSeparative.value !== null) extractedFields++;
  if (implantationLimite.value !== null) extractedFields++;
  if (ces.value !== null) extractedFields++;
  if (hauteurM.value !== null) extractedFields++;
  if (hauteurN.value !== null) extractedFields++;
  if (placesLogement.value !== null) extractedFields++;
  if (places100m2.value !== null) extractedFields++;

  // Compter les façades (value OU regle renseignés)
  if (facadeAvant.recul_min_m !== null || facadeAvant.regle !== null) extractedFields++;
  if (facadeLaterale.recul_min_m !== null || facadeLaterale.regle !== null) extractedFields++;
  if (facadeFond.recul_min_m !== null || facadeFond.regle !== null) extractedFields++;

  // Calculer le score de confiance
  const confidence_score = Math.round((extractedFields / totalFields) * 100);

  return {
    rules: {
      implantation: {
        recul_voirie_min_m: reculVoirie.value,
        recul_limite_separative_min_m: reculSeparative.value,
        implantation_en_limite_autorisee: implantationLimite.value,
        facades: {
          avant: facadeAvant,
          laterales: facadeLaterale,
          fond: facadeFond,
        },
      },
      emprise: {
        ces_max_percent: ces.value,
      },
      hauteur: {
        hauteur_max_m: hauteurM.value,
        hauteur_max_niveaux: hauteurN.value,
      },
      stationnement: {
        places_par_logement: placesLogement.value,
        places_par_100m2: places100m2.value,
      },
    },
    confidence_score,
    notes,
  };
}

// ============================================
// Handler principal
// ============================================

serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Vérifier la méthode
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // 1) Guard env : vérifier les variables d'environnement
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[plu-rules-engine-v1] Missing environment variables");
    return new Response(
      JSON.stringify({
        success: false,
        error: "MISSING_ENV",
      }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  try {
    // Parser le body
    const body: RequestBody = await req.json();
    const { document_id, overwrite = true } = body;

    if (!document_id) {
      return new Response(JSON.stringify({ success: false, error: "MISSING_DOCUMENT_ID" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    console.log("[plu-rules-engine-v1] processing");

    // Créer le client Supabase avec service role
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Charger le document
    const { data: document, error: docError } = await supabase
      .from("plu_documents")
      .select("id, commune_insee, commune_nom, raw_json")
      .eq("id", document_id)
      .single();

    if (docError || !document) {
      console.error("[plu-rules-engine-v1] database error");
      return new Response(
        JSON.stringify({ success: false, error: "DOCUMENT_NOT_FOUND" }),
        { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // 2) Robustifier l'accès aux zones_rulesets (supporter 2 formes)
    const rawJson = (document.raw_json as any) ?? null;
    const zonesRulesets: ZoneRuleset[] =
      (rawJson?.zones_rulesets as ZoneRuleset[]) ??
      (rawJson?.raw_json?.zones_rulesets as ZoneRuleset[]) ??
      [];

    if (!zonesRulesets || zonesRulesets.length === 0) {
      console.warn(`[plu-rules-engine-v1] No zones_rulesets found in document`);
      return new Response(
        JSON.stringify({
          success: false,
          error: "NO_ZONES_RULESETS",
        }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    console.log("[plu-rules-engine-v1] zones loaded");

    // Supprimer les anciennes normalisations si overwrite
    if (overwrite) {
      const { error: deleteError } = await supabase
        .from("plu_zone_rules_normalized")
        .delete()
        .eq("document_id", document_id);

      if (deleteError) {
        console.error("[plu-rules-engine-v1] database error");
      } else {
        console.log("[plu-rules-engine-v1] overwrite cleanup");
      }
    }

    // Traiter chaque zone
    const results: Array<{
      zone_code: string;
      zone_libelle: string | null;
      confidence_score: number;
      notes: string[];
    }> = [];

    // 3) Fix insert : type sans extraction_notes (colonne inexistante)
    const rowsToInsert: Array<{
      document_id: string;
      commune_insee: string;
      zone_code: string;
      zone_libelle: string | null;
      rules: NormalizedRulesWithMeta;
      confidence_score: number;
      source: string;
    }> = [];

    for (const zone of zonesRulesets) {
      const zoneCode = zone.zone_code || "UNKNOWN";
      const zoneLibelle = zone.zone_libelle || null;

      console.log("[plu-rules-engine-v1] zone processed");

      const extraction = extractRulesFromZone(zone);

      // 4) Conserver les notes dans rules.meta
      const rulesWithMeta: NormalizedRulesWithMeta = {
        ...extraction.rules,
        meta: {
          engine_version: ENGINE_VERSION,
          notes: extraction.notes,
        },
      };

      rowsToInsert.push({
        document_id: document_id,
        commune_insee: document.commune_insee,
        zone_code: zoneCode,
        zone_libelle: zoneLibelle,
        rules: rulesWithMeta,
        confidence_score: extraction.confidence_score,
        source: ENGINE_VERSION,
      });

      results.push({
        zone_code: zoneCode,
        zone_libelle: zoneLibelle,
        confidence_score: extraction.confidence_score,
        notes: extraction.notes,
      });
    }

    // Insérer toutes les lignes
    const { error: insertError } = await supabase.from("plu_zone_rules_normalized").insert(rowsToInsert);

    if (insertError) {
      console.error("[plu-rules-engine-v1] internal error");
      return new Response(
        JSON.stringify({ success: false, error: "INSERT_ERROR" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // Calculer les statistiques
    const zonesProcessed = results.length;
    const zonesWritten = rowsToInsert.length;
    const confidenceAvg = Math.round(results.reduce((sum, r) => sum + r.confidence_score, 0) / results.length);

    console.log("[plu-rules-engine-v1] completed");

    // Retourner le résumé
    return new Response(
      JSON.stringify({
        success: true,
        version: ENGINE_VERSION,
        zones_processed: zonesProcessed,
        zones_written: zonesWritten,
        confidence_avg: confidenceAvg,
      }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (_error: unknown) {
    console.error("[plu-rules-engine-v1] database error");
    return new Response(JSON.stringify({ success: false, error: "INTERNAL_ERROR" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});