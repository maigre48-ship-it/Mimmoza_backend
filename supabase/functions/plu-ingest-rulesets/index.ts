// supabase/functions/plu-ingest-rulesets/index.ts
// Version: plu-ingest-rulesets-v4.10 (security cleanup pass: INVALID_INPUT, generic business logs, generic DB throws, normalizeError removed — business logic & public success structure unchanged; response.version intentionally kept "v4.9" to preserve public contract)
//
// Objectif :
//  - Entrée : { commune_insee, commune_nom, storage_path, (optionnel) zones_rulesets, plu_version_label, source_document, target_zone_code }
//  - Étapes :
//      1) Si zones_rulesets fourni => PAS d'appel parser (ingestion directe)
//      2) Sinon :
//         - Construire une URL publique du PDF via Supabase Storage
//         - Appeler le parser (Render ou URL env) avec Authorization Bearer
//         - Transmettre target_zone_code (+ target_zone + targetZone pour compat) si fourni
//         - Valider que le parser a bien appliqué le mode target_zone
//         - Si parser n'a pas appliqué target_zone_mode:
//           - Tenter filtrage client-side
//           - Si filtrage échoue => erreur 502 TARGET_ZONE_NOT_APPLIED_BY_PARSER, AUCUNE opération DB
//           - Si filtrage réussit mais ruleset vide => erreur 502 TARGET_ZONE_RULESET_EMPTY, AUCUNE opération DB
//           - Si filtrage réussit => continuer avec flag target_zone_applied_client_side
//         - Filtrer les zones côté ingestion si nécessaire
//      3) Overwrite :
//         - v4.8: Si plu_version_label null/vide => forcer à "DEFAULT" pour éviter unique constraint error
//         - Rechercher par (commune_insee + plu_version_label)
//         - Si trouvé => supprimer zones + update doc + réinsérer zones
//         - Sinon => insert doc + insert zones
//      4) Extraire champs numériques depuis ruleset (structured mapping prioritaire, regex fallback)
//  - Sortie : résumé de l'opération (document_id, nb de zones, payload parser / source)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// ----------------------------------------------------------------------------
// Env helpers (robust for local `functions serve` which may skip SUPABASE_*)
// ----------------------------------------------------------------------------
function env(name: string): string | null {
  const v = Deno.env.get(name);
  const s = (v ?? "").toString().trim();
  return s ? s : null;
}

function requireEnvOneOf(names: string[]): string {
  for (const n of names) {
    const v = env(n);
    if (v) return v;
  }
  throw new Error(`MISSING_ENV:${names.join("|")}`);
}

// ✅ Helper for JSON responses
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ✅ v4.5: Helper to normalize zone code (trim + uppercase, null if empty)
function normalizeZoneCode(z: string | null | undefined): string | null {
  if (z === null || z === undefined) return null;
  const normalized = z.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

const SUPABASE_URL = requireEnvOneOf(["SUPABASE_URL", "MIMMOZA_SUPABASE_URL"]);
const SUPABASE_SERVICE_ROLE_KEY = requireEnvOneOf([
  "SUPABASE_SERVICE_ROLE_KEY",
  "MIMMOZA_SERVICE_ROLE_KEY",
]);

// URL du parser PLU : d'abord env, sinon Render
const PLU_PARSER_URL =
  env("PLU_PARSER_API_URL") ??
  "https://mimmoza-plu-parser.onrender.com/api/plu-parse";

// On lit la clé du parser depuis l'env puis on la TRIM pour éviter les espaces parasites
const RAW_PARSER_KEY = env("PLU_PARSER_API_KEY") ?? "";
const PLU_PARSER_API_KEY = RAW_PARSER_KEY.trim();

const PLU_STORAGE_BUCKET = env("PLU_STORAGE_BUCKET") ?? "plu_raw";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
type ZoneRuleset = {
  zone_code: string;
  zone_libelle: string;
  ruleset: unknown;
};

type IngestInput = {
  commune_insee: string;
  commune_nom?: string;
  storage_path: string;

  // ✅ permet de bypass le parser
  zones_rulesets?: ZoneRuleset[];

  // ✅ Optionnels (si fournis, on les stocke dans plu_documents)
  plu_version_label?: string | null;
  source_document?: string | null;
  
  // ✅ v4.4: target_zone_code pour ne traiter qu'une zone
  target_zone_code?: string | null;
};

// ✅ v4.5: Parser meta type for target zone validation
type ParserMeta = {
  target_zone_mode?: boolean;
  target_zone_code?: string | null;
  [key: string]: unknown;
};

type ParserResponse = {
  success: boolean;
  commune_insee: string;
  commune_nom: string;
  plu_version_label?: string;
  source_document?: string;
  zones_rulesets?: ZoneRuleset[];
  meta?: ParserMeta;
  [key: string]: unknown;
};

// ----------------------------------------------------------------------------
// Numeric extraction types & helpers (v4.4)
// ----------------------------------------------------------------------------

// ✅ v4.2: Aligned to DB columns exactly
type ExtractedNumericFields = {
  retrait_min_m: number | null;
  retrait_voirie_min_m: number | null;
  retrait_limites_separatives_min_m: number | null;
  retrait_fond_parcelle_min_m: number | null;
  places_par_logement: number | null;
  surface_par_place_m2: number | null;
};

// v4.3: Diagnostic info (not persisted to DB)
type ExtractionDiagnostics = {
  hasNumbers: boolean;
  hasMeterText: boolean;
  hasParkingText: boolean;
  sampleTexts: string[];
  topKeys: string[];
  // v4.4: track extraction source
  extractionSource: {
    voirie: "structured" | "regex" | null;
    limites: "structured" | "regex" | null;
    fond: "structured" | "regex" | null;
    parking: "structured" | "regex" | null;
  };
};

// v4.3: Extended result with diagnostics
type ExtractedNumericFieldsWithDiag = ExtractedNumericFields & {
  _diag: ExtractionDiagnostics;
};

type TextWithPath = {
  text: string;
  path: string;
};

type MeterMatch = {
  value: number;
  priority: number; // 2 = min/minimum, 1 = generic
  context: string;
};

/**
 * v4.3.1: HARDENED - Check if a string is a non-specified / placeholder value
 * Uses includes() for robust detection instead of anchored regex.
 */
function isNonSpecified(text: string): boolean {
  // Normalize: lowercase, trim, collapse multiple spaces
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
  
  // Very short or empty strings
  if (normalized.length < 2) return true;
  
  // Only punctuation, dashes, dots
  if (/^[-.\s/\\:;,_*]+$/.test(normalized)) return true;
  
  // Placeholder patterns (using includes for tolerance)
  const placeholderPatterns = [
    "non spécifié",
    "non specifie",
    "non spécifie",
    "non specifié",
    "sans objet",
    "non renseigné",
    "non renseigne",
    "néant",
    "neant",
    "n/a",
    "non applicable",
    "non concerné",
    "non concerne",
    "non défini",
    "non defini",
    "non précisé",
    "non precise",
    "aucune indication",
    "aucune prescription",
    "pas de prescription",
    "pas d'indication",
    "pas de disposition",
  ];
  
  for (const pattern of placeholderPatterns) {
    if (normalized.includes(pattern)) return true;
  }
  
  // Reference patterns (starts with or contains as main content)
  const referencePatterns = [
    "voir règlement",
    "voir reglement",
    "voir le règlement",
    "voir le reglement",
    "se référer",
    "se referer",
    "cf.",
    "cf ",
    "conformément au",
    "conformement au",
  ];
  
  for (const pattern of referencePatterns) {
    // Check if starts with or is primarily this reference
    if (normalized.startsWith(pattern) || normalized === pattern) return true;
  }
  
  // Common short placeholders (exact or near-exact)
  const shortPlaceholders = ["aucun", "aucune", "néant", "neant", "na", "nd", "nc", "nr"];
  for (const p of shortPlaceholders) {
    if (normalized === p || normalized === p + ".") return true;
  }
  
  return false;
}

/**
 * v4.3.1: Diagnostic function to check if ruleset has meaningful extractable content
 * - hasNumbers only true if path contains relevant keywords
 * - topKeys limited to 10
 */
function hasMeaningfulContent(obj: unknown, maxDepth = 8): Omit<ExtractionDiagnostics, 'extractionSource'> {
  const result: Omit<ExtractionDiagnostics, 'extractionSource'> = {
    hasNumbers: false,
    hasMeterText: false,
    hasParkingText: false,
    sampleTexts: [],
    topKeys: [],
  };
  
  // Get top keys if object (v4.3.1: limit to 10)
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    result.topKeys = Object.keys(obj).slice(0, 10);
  }
  
  // Regex for meter text (excluding m²/m2)
  const meterPattern = /\b\d+(?:[,.]\d+)?\s*(?:m(?:è|e)?tre?s?|m)(?!\s*(?:²|2))/i;
  
  // Regex for parking text
  const parkingPatterns = [
    /place[s]?\s*(?:par|\/|pour)\s*logement/i,
    /\d+(?:[,.]\d+)?\s*m[²2]\s*(?:par|pour|\/)\s*place/i,
    /place\s+(?:de\s+)?(?:\d+(?:[,.]\d+)?)\s*m[²2]/i,
  ];
  
  // v4.3.1: Keywords that make a numeric value relevant
  const relevantNumberKeywords = [
    "recul", "retrait", "align", "station", "parking", "place",
    "implant", "min_m", "hauteur", "distance", "marge", "emprise",
    "limite", "voirie", "fond", "lateral", "separativ"
  ];
  
  function isRelevantPath(path: string): boolean {
    const lowerPath = path.toLowerCase();
    return relevantNumberKeywords.some(kw => lowerPath.includes(kw));
  }
  
  function traverse(current: unknown, depth: number, path: string): void {
    if (depth > maxDepth) return;
    
    if (typeof current === "number" && !isNaN(current) && current !== null) {
      // v4.3.1: Only count as relevant if path contains meaningful keywords
      if (isRelevantPath(path)) {
        result.hasNumbers = true;
      }
    } else if (typeof current === "string") {
      const trimmed = current.trim();
      
      // Skip non-specified values
      if (!isNonSpecified(trimmed) && trimmed.length > 0) {
        // Collect sample texts (max 5, truncated to 80 chars)
        if (result.sampleTexts.length < 5) {
          const sample = trimmed.length > 80 ? trimmed.substring(0, 80) + "..." : trimmed;
          result.sampleTexts.push(sample);
        }
        
        // Check for meter text
        if (meterPattern.test(trimmed)) {
          result.hasMeterText = true;
        }
        
        // Check for parking text
        for (const pattern of parkingPatterns) {
          if (pattern.test(trimmed)) {
            result.hasParkingText = true;
            break;
          }
        }
      }
    } else if (Array.isArray(current)) {
      current.forEach((item, idx) => {
        traverse(item, depth + 1, `${path}[${idx}]`);
      });
    } else if (current !== null && typeof current === "object") {
      for (const [key, value] of Object.entries(current)) {
        const childPath = path ? `${path}.${key}` : key;
        traverse(value, depth + 1, childPath);
      }
    }
  }
  
  traverse(obj, 0, "");
  
  return result;
}

/**
 * Collect all string values from an object recursively, preserving key path.
 * v4.3.1: Uses hardened isNonSpecified filter.
 */
function collectTextValuesWithPath(
  obj: unknown,
  maxDepth = 10,
  currentPath = ""
): TextWithPath[] {
  if (maxDepth <= 0) return [];
  
  const results: TextWithPath[] = [];
  
  if (typeof obj === "string") {
    const trimmed = obj.trim();
    // v4.3.1: Skip non-specified values with hardened check
    if (trimmed.length > 0 && !isNonSpecified(trimmed)) {
      results.push({ text: trimmed, path: currentPath });
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((item, idx) => {
      const childPath = currentPath ? `${currentPath}[${idx}]` : `[${idx}]`;
      results.push(...collectTextValuesWithPath(item, maxDepth - 1, childPath));
    });
  } else if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      results.push(...collectTextValuesWithPath(value, maxDepth - 1, childPath));
    }
  }
  
  return results;
}

/**
 * Legacy helper: collect text values without path (for backward compat)
 * v4.3.1: Uses hardened isNonSpecified filter.
 */
function collectTextValues(obj: unknown, maxDepth = 10): string[] {
  return collectTextValuesWithPath(obj, maxDepth).map((t) => t.text);
}

/**
 * Parse French decimal (3,5 -> 3.5) and return number or null
 */
function parseFrenchDecimal(str: string): number | null {
  const normalized = str.replace(",", ".").trim();
  const val = parseFloat(normalized);
  return isNaN(val) ? null : val;
}

/**
 * Extract meter values from text for retraits.
 * v4.2 FIX: excludes m² (surfaces) with hardened negative lookahead including optional spaces.
 * Pattern: (?!\s*(?:²|2)) to catch "m²", "m ²", "m2", "m 2"
 * Returns matches with priority (2 for min/minimum patterns, 1 for generic).
 */
function extractMeterValues(text: string): MeterMatch[] {
  const matches: MeterMatch[] = [];
  
  // v4.2: Hardened negative lookahead to exclude m² / m2 with optional space
  // (?!\s*(?:²|2)) catches: m², m ², m2, m 2
  const meterUnit = `(?:m(?:è|e)?tre?s?|m)(?!\\s*(?:²|2))`;
  
  // Pattern 1: "minimum X m" / "au moins X m" / "min. X m" / "min X m" (priority 2)
  const minPatterns = [
    new RegExp(`(?:minimum|min\\.?|au\\s+moins)\\s+(?:de\\s+)?(\\d+(?:[,\\.]\\d+)?)\\s*${meterUnit}`, "gi"),
    new RegExp(`(\\d+(?:[,\\.]\\d+)?)\\s*${meterUnit}\\s+(?:minimum|min\\.?|au\\s+moins)`, "gi"),
  ];
  
  for (const pattern of minPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const val = parseFrenchDecimal(match[1]);
      if (val !== null && val > 0 && val < 100) {
        matches.push({ value: val, priority: 2, context: match[0] });
      }
    }
  }
  
  // Pattern 2: H/2 avec minimum X m (priority 2)
  const hDivMinPattern = new RegExp(`H\\s*/\\s*\\d+\\s+(?:avec\\s+)?(?:minimum|min\\.?)\\s+(\\d+(?:[,\\.]\\d+)?)\\s*${meterUnit}`, "gi");
  let hMatch;
  while ((hMatch = hDivMinPattern.exec(text)) !== null) {
    const val = parseFrenchDecimal(hMatch[1]);
    if (val !== null && val > 0 && val < 100) {
      matches.push({ value: val, priority: 2, context: hMatch[0] });
    }
  }
  
  // Pattern 3: Generic "X m" or "X mètres" (priority 1)
  const genericPattern = new RegExp(`(\\d+(?:[,\\.]\\d+)?)\\s*${meterUnit}`, "gi");
  let gMatch;
  while ((gMatch = genericPattern.exec(text)) !== null) {
    const val = parseFrenchDecimal(gMatch[1]);
    // Sanity check: reasonable retrait values (0.5 to 50m)
    if (val !== null && val >= 0.5 && val <= 50) {
      // Check if this match is already captured by min patterns
      const alreadyCaptured = matches.some(
        (m) => Math.abs(m.value - val) < 0.01 && m.priority === 2
      );
      if (!alreadyCaptured) {
        matches.push({ value: val, priority: 1, context: gMatch[0] });
      }
    }
  }
  
  return matches;
}

/**
 * Classify a retrait field based on context (text + path).
 * v4.2: uses combined context from path and text for better classification.
 * Returns: 'voirie' | 'limites' | 'fond' | null (null = generic retrait)
 */
function classifyRetraitField(context: string): "voirie" | "limites" | "fond" | null {
  const lower = context.toLowerCase();
  
  // Voirie patterns (highest priority - public road alignment)
  const voiriePatterns = [
    /voirie/,
    /alignement/,
    /domaine\s+public/,
    /emprise\s+publique/,
    /rue/,
    /route/,
    /chemin\s+public/,
    /facade.*(?:rue|voie)/,
    /(?:rue|voie).*facade/,
  ];
  
  for (const p of voiriePatterns) {
    if (p.test(lower)) return "voirie";
  }
  
  // Fond de parcelle patterns
  const fondPatterns = [
    /fond\s+(?:de\s+)?parcelle/,
    /fond\s+(?:de\s+)?terrain/,
    /limite\s+(?:de\s+)?fond/,
    /arrière/,
    /\.fond\b/,  // path contains .fond
    /\bfond\./,  // path contains fond.
  ];
  
  for (const p of fondPatterns) {
    if (p.test(lower)) return "fond";
  }
  
  // Limites séparatives / latérales patterns
  const limitesPatterns = [
    /limite[s]?\s+s[eé]parative/,
    /lat[eé]ral/,
    /limite[s]?\s+(?:de\s+)?propri[eé]t[eé]/,
    /voisin/,
    /mitoyen/,
    /s[eé]parative/,
    /\.limites?\b/,
    /\.lateral/,
  ];
  
  for (const p of limitesPatterns) {
    if (p.test(lower)) return "limites";
  }
  
  return null;
}

/**
 * Extract parking values from text.
 * v4.2.1 FIX: reset regex lastIndex + iterate ALL matches to find first valid value.
 * surface_par_place_m2 REQUIRES explicit "place" mention (strict).
 */
function extractParkingValues(text: string): {
  places_par_logement: number | null;
  surface_par_place_m2: number | null;
} {
  let places_par_logement: number | null = null;
  let surface_par_place_m2: number | null = null;
  
  // Pattern: "X place(s) par logement" or "X places / logement"
  const placesPatterns = [
    /(\d+(?:[,\.]\d+)?)\s*place[s]?\s*(?:par|\/|pour)\s*logement/gi,
    /(\d+(?:[,\.]\d+)?)\s*place[s]?\s*(?:de\s+)?stationnement\s*(?:par|\/|pour)\s*logement/gi,
  ];
  
  // v4.2.1: reset lastIndex + iterate all matches, pick first valid value
  outerPlaces:
  for (const pattern of placesPatterns) {
    pattern.lastIndex = 0; // Reset regex state for robustness
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const val = parseFrenchDecimal(match[1]);
      // Sanity: 0.5 to 10 places per unit
      if (val !== null && val >= 0.5 && val <= 10) {
        places_par_logement = val;
        break outerPlaces; // Take first valid match across all patterns
      }
    }
  }
  
  // v4.2.1 FIX: surface_par_place_m2 - STRICT: "place" must be explicitly mentioned
  // Patterns that REQUIRE "place" context:
  // - "X m² par place"
  // - "X m² / place"
  // - "X m² pour chaque place"
  // - "X m² par place de stationnement"
  // - "surface de X m² par place"
  const surfacePatterns = [
    // "X m² par/pour place" or "X m²/place"
    /(\d+(?:[,\.]\d+)?)\s*m[²2]\s*(?:par|pour|\/)\s*(?:chaque\s+)?place/gi,
    // "surface de X m² par place"
    /surface\s+(?:de\s+)?(\d+(?:[,\.]\d+)?)\s*m[²2]\s*(?:par|pour|\/)\s*place/gi,
    // "place de X m²" - place mentioned first
    /place\s+(?:de\s+stationnement\s+)?(?:de\s+)?(\d+(?:[,\.]\d+)?)\s*m[²2]/gi,
    // "X m² minimum par place"
    /(\d+(?:[,\.]\d+)?)\s*m[²2]\s*(?:minimum|min\.?)?\s*(?:par|pour|\/)\s*place/gi,
  ];
  
  // v4.2.1: reset lastIndex + iterate all matches, pick first valid value
  outerSurface:
  for (const pattern of surfacePatterns) {
    pattern.lastIndex = 0; // Reset regex state for robustness
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const val = parseFrenchDecimal(match[1]);
      // Sanity: 5 to 50 m² per parking space (reasonable range)
      if (val !== null && val >= 5 && val <= 50) {
        surface_par_place_m2 = val;
        break outerSurface; // Take first valid match across all patterns
      }
    }
  }
  
  return { places_par_logement, surface_par_place_m2 };
}

/**
 * v4.4: Helper to safely get a number from structured ruleset path
 */
function getStructuredNumber(obj: unknown, ...path: string[]): number | null {
  let current: any = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== "object") {
      return null;
    }
    current = current[key];
  }
  if (typeof current === "number" && !isNaN(current) && current > 0) {
    return current;
  }
  return null;
}

/**
 * v4.4: Helper to safely get a string (note) from structured ruleset path
 */
function getStructuredString(obj: unknown, ...path: string[]): string | null {
  let current: any = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== "object") {
      return null;
    }
    current = current[key];
  }
  if (typeof current === "string" && current.trim().length > 0 && !isNonSpecified(current)) {
    return current.trim();
  }
  return null;
}

/**
 * Extract numeric fields from a ruleset object.
 * v4.4: STRUCTURED MAPPING PRIORITY
 *   1) Read structured values from ruleset.reculs.*.min_m and ruleset.stationnement.*
 *   2) If structured value is null but note exists, fallback to regex extraction
 *   3) retrait_min_m = min(voirie, limites, fond) if at least one is present
 */
function extractNumericFieldsFromRuleset(ruleset: unknown): ExtractedNumericFieldsWithDiag {
  // v4.3: First run diagnostics
  const baseDiag = hasMeaningfulContent(ruleset);
  
  const diag: ExtractionDiagnostics = {
    ...baseDiag,
    extractionSource: {
      voirie: null,
      limites: null,
      fond: null,
      parking: null,
    },
  };
  
  const result: ExtractedNumericFieldsWithDiag = {
    retrait_min_m: null,
    retrait_voirie_min_m: null,
    retrait_limites_separatives_min_m: null,
    retrait_fond_parcelle_min_m: null,
    places_par_logement: null,
    surface_par_place_m2: null,
    _diag: diag,
  };
  
  if (!ruleset || typeof ruleset !== "object") {
    return result;
  }
  
  const rs = ruleset as Record<string, unknown>;
  
  // -------------------------------------------------------------------------
  // v4.4: STRUCTURED MAPPING (priority)
  // Parser returns: ruleset.reculs.voirie.min_m, ruleset.reculs.limites_separatives.min_m, etc.
  // -------------------------------------------------------------------------
  
  // 1) retrait_voirie_min_m
  const structuredVoirie = getStructuredNumber(rs, "reculs", "voirie", "min_m");
  if (structuredVoirie !== null) {
    result.retrait_voirie_min_m = structuredVoirie;
    diag.extractionSource.voirie = "structured";
  } else {
    // Fallback: try regex on note
    const voirieNote = getStructuredString(rs, "reculs", "voirie", "note");
    if (voirieNote) {
      const matches = extractMeterValues(voirieNote);
      if (matches.length > 0) {
        // Take highest priority match
        matches.sort((a, b) => b.priority - a.priority);
        result.retrait_voirie_min_m = matches[0].value;
        diag.extractionSource.voirie = "regex";
      }
    }
  }
  
  // 2) retrait_limites_separatives_min_m
  const structuredLimites = getStructuredNumber(rs, "reculs", "limites_separatives", "min_m");
  if (structuredLimites !== null) {
    result.retrait_limites_separatives_min_m = structuredLimites;
    diag.extractionSource.limites = "structured";
  } else {
    // Fallback: try regex on note
    const limitesNote = getStructuredString(rs, "reculs", "limites_separatives", "note");
    if (limitesNote) {
      const matches = extractMeterValues(limitesNote);
      if (matches.length > 0) {
        matches.sort((a, b) => b.priority - a.priority);
        result.retrait_limites_separatives_min_m = matches[0].value;
        diag.extractionSource.limites = "regex";
      }
    }
  }
  
  // 3) retrait_fond_parcelle_min_m
  const structuredFond = getStructuredNumber(rs, "reculs", "fond_parcelle", "min_m");
  if (structuredFond !== null) {
    result.retrait_fond_parcelle_min_m = structuredFond;
    diag.extractionSource.fond = "structured";
  } else {
    // Fallback: try regex on note
    const fondNote = getStructuredString(rs, "reculs", "fond_parcelle", "note");
    if (fondNote) {
      const matches = extractMeterValues(fondNote);
      if (matches.length > 0) {
        matches.sort((a, b) => b.priority - a.priority);
        result.retrait_fond_parcelle_min_m = matches[0].value;
        diag.extractionSource.fond = "regex";
      }
    }
  }
  
  // 4) places_par_logement
  const structuredPlaces = getStructuredNumber(rs, "stationnement", "places_par_logement");
  if (structuredPlaces !== null) {
    result.places_par_logement = structuredPlaces;
    diag.extractionSource.parking = "structured";
  } else {
    // Fallback: try regex on note
    const parkingNote = getStructuredString(rs, "stationnement", "note");
    if (parkingNote) {
      const parking = extractParkingValues(parkingNote);
      if (parking.places_par_logement !== null) {
        result.places_par_logement = parking.places_par_logement;
        diag.extractionSource.parking = "regex";
      }
    }
  }
  
  // 5) surface_par_place_m2
  const structuredSurface = getStructuredNumber(rs, "stationnement", "surface_par_place_m2");
  if (structuredSurface !== null) {
    result.surface_par_place_m2 = structuredSurface;
    // parking source already set above if places was found
    if (diag.extractionSource.parking === null) {
      diag.extractionSource.parking = "structured";
    }
  } else {
    // Fallback: try regex on note (if not already extracted)
    if (result.surface_par_place_m2 === null) {
      const parkingNote = getStructuredString(rs, "stationnement", "note");
      if (parkingNote) {
        const parking = extractParkingValues(parkingNote);
        if (parking.surface_par_place_m2 !== null) {
          result.surface_par_place_m2 = parking.surface_par_place_m2;
          if (diag.extractionSource.parking === null) {
            diag.extractionSource.parking = "regex";
          }
        }
      }
    }
  }
  
  // 6) retrait_min_m = min(voirie, limites, fond) if at least one is present
  const retraitValues = [
    result.retrait_voirie_min_m,
    result.retrait_limites_separatives_min_m,
    result.retrait_fond_parcelle_min_m,
  ].filter((v): v is number => v !== null);
  
  if (retraitValues.length > 0) {
    result.retrait_min_m = Math.min(...retraitValues);
  }
  
  // -------------------------------------------------------------------------
  // v4.4: LEGACY FALLBACK - only if structured mapping found nothing
  // Scan sections for regex extraction (backward compat with old parser output)
  // -------------------------------------------------------------------------
  const hasAnyStructuredData = 
    result.retrait_voirie_min_m !== null ||
    result.retrait_limites_separatives_min_m !== null ||
    result.retrait_fond_parcelle_min_m !== null ||
    result.places_par_logement !== null ||
    result.surface_par_place_m2 !== null;
  
  if (!hasAnyStructuredData) {
    // Track best priority for each retrait field (higher = better)
    const priorities = {
      generic: 0,
      voirie: 0,
      limites: 0,
      fond: 0,
    };
    
    // Sections likely to contain retrait/implantation rules
    const retraitSections = [
      "reculs_alignements",
      "implantation",
      "implantation_constructions",
      "retrait",
      "retraits",
      "article_6",
      "article_7",
      "article_8",
    ];
    
    // Sections likely to contain parking rules
    const parkingSections = [
      "stationnement",
      "parking",
      "article_12",
      "places_stationnement",
    ];
    
    // Helper to update retrait fields based on classification and priority
    const updateRetraitField = (
      classification: "voirie" | "limites" | "fond" | null,
      match: MeterMatch
    ) => {
      if (classification === "voirie") {
        if (match.priority > priorities.voirie || 
            (match.priority >= priorities.voirie && result.retrait_voirie_min_m === null)) {
          result.retrait_voirie_min_m = match.value;
          priorities.voirie = match.priority;
        }
      } else if (classification === "limites") {
        if (match.priority > priorities.limites || 
            (match.priority >= priorities.limites && result.retrait_limites_separatives_min_m === null)) {
          result.retrait_limites_separatives_min_m = match.value;
          priorities.limites = match.priority;
        }
      } else if (classification === "fond") {
        if (match.priority > priorities.fond || 
            (match.priority >= priorities.fond && result.retrait_fond_parcelle_min_m === null)) {
          result.retrait_fond_parcelle_min_m = match.value;
          priorities.fond = match.priority;
        }
      } else {
        // classification === null => generic retrait (retrait_min_m)
        if (match.priority > priorities.generic || 
            (match.priority >= priorities.generic && result.retrait_min_m === null)) {
          result.retrait_min_m = match.value;
          priorities.generic = match.priority;
        }
      }
    };
    
    // Process retrait sections with path context
    for (const section of retraitSections) {
      if (rs[section]) {
        const textsWithPath = collectTextValuesWithPath(rs[section], 5, section);
        
        for (const { text, path } of textsWithPath) {
          // Combine path and text for classification context
          const fullContext = `${path}: ${text}`;
          const classification = classifyRetraitField(fullContext);
          
          const meterMatches = extractMeterValues(text);
          
          for (const match of meterMatches) {
            updateRetraitField(classification, match);
          }
        }
      }
    }
    
    // Process parking sections
    for (const section of parkingSections) {
      if (rs[section]) {
        const texts = collectTextValues(rs[section], 5);
        
        for (const text of texts) {
          const parking = extractParkingValues(text);
          
          if (parking.places_par_logement !== null && result.places_par_logement === null) {
            result.places_par_logement = parking.places_par_logement;
          }
          if (parking.surface_par_place_m2 !== null && result.surface_par_place_m2 === null) {
            result.surface_par_place_m2 = parking.surface_par_place_m2;
          }
        }
      }
    }
    
    // Fallback: scan entire ruleset if nothing found
    if (
      result.retrait_min_m === null &&
      result.retrait_voirie_min_m === null &&
      result.retrait_limites_separatives_min_m === null &&
      result.retrait_fond_parcelle_min_m === null &&
      result.places_par_logement === null &&
      result.surface_par_place_m2 === null
    ) {
      const allTextsWithPath = collectTextValuesWithPath(ruleset, 8, "");
      
      for (const { text, path } of allTextsWithPath) {
        const fullContext = `${path}: ${text}`;
        
        // Retraits
        const classification = classifyRetraitField(fullContext);
        const meterMatches = extractMeterValues(text);
        for (const match of meterMatches) {
          updateRetraitField(classification, match);
        }
        
        // Parking
        const parking = extractParkingValues(text);
        if (parking.places_par_logement !== null && result.places_par_logement === null) {
          result.places_par_logement = parking.places_par_logement;
        }
        if (parking.surface_par_place_m2 !== null && result.surface_par_place_m2 === null) {
          result.surface_par_place_m2 = parking.surface_par_place_m2;
        }
      }
    }
  }
  
  return result;
}

// ----------------------------------------------------------------------------
// Main serve handler
// ----------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ success: false, error: "Method not allowed" }, 405);
    }

    // ✅ Parse body with error handling
    let body: IngestInput;
    try {
      body = (await req.json()) as IngestInput;
    } catch (_e) {
      console.log("[RULESETS] json parse failed");
      return jsonResponse({ success: false, error: "INVALID_JSON_BODY" }, 400);
    }

    const {
      commune_insee,
      commune_nom,
      storage_path,
      zones_rulesets: zones_rulesets_input,
      plu_version_label: plu_version_label_input,
      source_document: source_document_input,
      target_zone_code: target_zone_code_input,
    } = body;

    // ✅ v4.5: Normalize target_zone_code early
    const normalizedTargetZone = normalizeZoneCode(target_zone_code_input);

    // ✅ LOGS après parsing JSON body
    console.log("[RULESETS] start");

    // ✅ v4.6: Clear target zone log (sans valeur)
    if (normalizedTargetZone) {
      console.log("[RULESETS][TARGET] requested");
    }

    if (!commune_insee || !storage_path) {
      console.log("[RULESETS] validation failed");
      return jsonResponse(
        {
          success: false,
          error: "INVALID_INPUT",
        },
        400,
      );
    }

    // ✅ 0) Bypass parser si zones_rulesets fourni
    const hasZonesRulesets =
      Array.isArray(zones_rulesets_input) && zones_rulesets_input.length > 0;

    let parsed: ParserResponse;
    
    // ✅ v4.6: Track if client-side filtering was applied
    let target_zone_applied_client_side = false;
    
    // ✅ v4.7: Track if target zone was filtered from input (bypass mode)
    let target_zone_filtered_from_input = false;

    // pdf_url = URL la plus utile côté doc (si fourni)
    let pdf_url: string = source_document_input ?? storage_path;

    if (hasZonesRulesets) {
      console.log("[RULESETS] bypass parser");

      // ✅ v4.5: If target zone requested with bypass mode, filter zones_rulesets
      let filteredZonesRulesets = zones_rulesets_input!;
      if (normalizedTargetZone) {
        console.log("[RULESETS][TARGET] bypass filter");
        filteredZonesRulesets = zones_rulesets_input!.filter(
          (z) => normalizeZoneCode(z.zone_code) === normalizedTargetZone
        );

        if (filteredZonesRulesets.length === 0) {
          console.log("[RULESETS] target filter");
          return jsonResponse(
            {
              success: false,
              error: "TARGET_ZONE_NOT_FOUND_IN_INPUT",
            },
            400,
          );
        }
        
        // ✅ v4.7: Mark as filtered from input (bypass mode) - NOT client_side fallback
        target_zone_filtered_from_input = true;
        console.log("[RULESETS] target filter");
      }

      parsed = {
        success: true,
        commune_insee,
        commune_nom: commune_nom ?? "",
        plu_version_label: (plu_version_label_input ?? undefined) as any,
        source_document: source_document_input ?? undefined,
        zones_rulesets: filteredZonesRulesets,
        bypass_parser: true,
      } as any;
    } else {
      // 1) URL publique du PDF depuis Supabase Storage
      const { data: publicUrlData, error: publicUrlError } = supabase.storage
        .from(PLU_STORAGE_BUCKET)
        .getPublicUrl(storage_path);

      if (publicUrlError) {
        console.log("[RULESETS][STORAGE] getPublicUrl error");
      }

      pdf_url = publicUrlData?.publicUrl ?? storage_path;

      // 2) Appel du parser avec Authorization Bearer
      // ✅ v4.6: include target_zone_code + target_zone + targetZone for max compat
      const parserBody: Record<string, unknown> = {
        commune_insee,
        commune_nom,
        source_pdf_url: pdf_url,
      };
      
      // v4.6: Add all target zone variants if provided (for max compat with parser)
      if (normalizedTargetZone) {
        parserBody.target_zone_code = normalizedTargetZone;
        parserBody.target_zone = normalizedTargetZone;      // compat legacy
        parserBody.targetZone = normalizedTargetZone;       // compat camelCase
        console.log("[RULESETS][TARGET] sending to parser");
      }

      const parserHeaders: HeadersInit = { "Content-Type": "application/json" };
      if (PLU_PARSER_API_KEY) {
        (parserHeaders as any)["Authorization"] = `Bearer ${PLU_PARSER_API_KEY}`;
      }

      console.log("[RULESETS] parser call");

      let parserRes: Response;
      try {
        parserRes = await fetch(PLU_PARSER_URL, {
          method: "POST",
          headers: parserHeaders,
          body: JSON.stringify(parserBody),
        });
      } catch (_e) {
        console.log("[RULESETS] parser failed");
        return jsonResponse(
          {
            success: false,
            error: "PLU_PARSER_FETCH_ERROR",
          },
          502,
        );
      }

      if (!parserRes.ok) {
        console.log("[RULESETS] parser failed");
        return jsonResponse(
          {
            success: false,
            error: "Erreur lors de l'appel au PLU Parser",
          },
          502,
        );
      }

      parsed = (await parserRes.json()) as ParserResponse;

      if (!parsed.success) {
        console.log("[RULESETS] parser failed");
        return jsonResponse(
          {
            success: false,
            error: "PLU Parser a répondu success=false",
          },
          502,
        );
      }

      console.log("[RULESETS] parser success");

      // ✅ v4.6: Log parser meta for target zone validation
      const parserMeta = parsed.meta ?? {};
      const parserTargetZoneMode = parserMeta.target_zone_mode;
      const parserTargetZoneCode = parserMeta.target_zone_code;
      const zonesReturnedCount = parsed.zones_rulesets?.length ?? 0;

      // ✅ v4.6: Strict target zone validation
      if (normalizedTargetZone) {
        // Check if parser actually applied target zone mode
        const parserAppliedTargetZone = 
          parserTargetZoneMode === true && 
          normalizeZoneCode(parserTargetZoneCode as string | null | undefined) !== null;
        
        if (!parserAppliedTargetZone) {
          console.log("[RULESETS] parser validation");

          // ✅ v4.6: Attempt client-side filtering as fallback
          const originalZones = parsed.zones_rulesets ?? [];
          console.log("[RULESETS][TARGET] client-side filtering");

          const filteredZones = originalZones.filter(
            (z) => normalizeZoneCode(z.zone_code) === normalizedTargetZone
          );

          if (filteredZones.length === 0) {
            // ✅ v4.7: No matching zone found - return error 502 TARGET_ZONE_NOT_APPLIED_BY_PARSER, NO DB operations
            console.log("[RULESETS][TARGET] abort TARGET_ZONE_NOT_APPLIED_BY_PARSER - no DB operations");
            return jsonResponse(
              {
                success: false,
                error: "TARGET_ZONE_NOT_APPLIED_BY_PARSER",
              },
              502,
            );
          }

          // ✅ v4.7: Client-side filtering found zone(s) - check if ruleset is empty before proceeding
          if (filteredZones.length >= 1) {
            const firstZone = filteredZones[0];
            const rulesetDiag = hasMeaningfulContent(firstZone.ruleset);

            const isRulesetEmpty = !rulesetDiag.hasNumbers && !rulesetDiag.hasMeterText && !rulesetDiag.hasParkingText;

            if (isRulesetEmpty) {
              // ✅ v4.7: Ruleset is empty - return error 502 TARGET_ZONE_RULESET_EMPTY, NO DB operations
              console.log("[RULESETS][TARGET] abort TARGET_ZONE_RULESET_EMPTY - no DB operations");
              return jsonResponse(
                {
                  success: false,
                  error: "TARGET_ZONE_RULESET_EMPTY",
                },
                502,
              );
            }
          }

          // ✅ v4.7: Client-side filtering succeeded with non-empty ruleset - continue with flag
          console.log("[RULESETS] target filter");
          target_zone_applied_client_side = true;
          parsed.zones_rulesets = filteredZones;

        } else {
          // Parser applied target zone mode - verify zone code matches
          const parserReturnedZone = normalizeZoneCode(parserTargetZoneCode as string | null | undefined);

          if (parserReturnedZone !== normalizedTargetZone) {
            console.log("[RULESETS] parser validation");
            // Still proceed but log the mismatch - parser might have normalized differently
          }
          
          // ✅ v4.6: Additional safety - filter zones even if parser says it applied mode
          // This handles edge cases where parser returns multiple zones despite target mode
          if (zonesReturnedCount > 1) {
            console.log("[RULESETS] parser validation");
            const filteredZones = (parsed.zones_rulesets ?? []).filter(
              (z) => normalizeZoneCode(z.zone_code) === normalizedTargetZone
            );
            
            if (filteredZones.length === 0) {
              // ✅ v4.7: Safety filter found no match - error 502 TARGET_ZONE_NOT_APPLIED_BY_PARSER, NO DB operations
              console.log("[RULESETS][TARGET] abort TARGET_ZONE_NOT_APPLIED_BY_PARSER after safety filter - no DB operations");
              return jsonResponse(
                {
                  success: false,
                  error: "TARGET_ZONE_NOT_APPLIED_BY_PARSER",
                },
                502,
              );
            }
            
            // ✅ v4.7: Safety filter found zone(s) - check if ruleset is empty
            if (filteredZones.length >= 1) {
              const firstZone = filteredZones[0];
              const rulesetDiag = hasMeaningfulContent(firstZone.ruleset);
              
              const isRulesetEmpty = !rulesetDiag.hasNumbers && !rulesetDiag.hasMeterText && !rulesetDiag.hasParkingText;
              
              if (isRulesetEmpty) {
                // ✅ v4.7: Ruleset is empty after safety filter - return error 502, NO DB operations
                console.log("[RULESETS][TARGET] abort TARGET_ZONE_RULESET_EMPTY (safety filter) - no DB operations");
                return jsonResponse(
                  {
                    success: false,
                    error: "TARGET_ZONE_RULESET_EMPTY",
                  },
                  502,
                );
              }
            }
            
            // ✅ v4.7: Safety filter applied successfully with non-empty ruleset
            target_zone_applied_client_side = true;
            parsed.zones_rulesets = filteredZones;
            console.log("[RULESETS] target filter");
          } else {
            // Parser returned exactly 1 zone and target_zone_mode=true - trust it
            console.log("[RULESETS] target filter");
          }
        }
      }
    }

    const final_commune_insee = parsed.commune_insee || commune_insee;
    const final_commune_nom = parsed.commune_nom || commune_nom || "";

    // ✅ v4.8: Déterminer la clé unique pour l'overwrite
    // Si plu_version_label est null ou vide, forcer à "DEFAULT" pour éviter 
    // l'erreur unique constraint uq_plu_documents_commune_version
    let unique_version_label = parsed.plu_version_label ?? plu_version_label_input ?? null;
    
    // ✅ v4.8 FIX: Force "DEFAULT" si null ou vide pour éviter duplicate key sur (commune_insee, '')
    const isVersionLabelEmpty = unique_version_label === null || 
      (typeof unique_version_label === "string" && unique_version_label.trim() === "");
    
    if (isVersionLabelEmpty) {
      unique_version_label = "DEFAULT";
      console.log("[RULESETS] version normalized");
    }
    
    // ✅ v4.8: hasVersionLabel est maintenant toujours true car on force "DEFAULT" si vide
    const hasVersionLabel = true;

    // ------------------------------------------------------------------------
    // 3) OVERWRITE LOGIC (v4.8)
    // - v4.8: plu_version_label est toujours non-null (forcé à "DEFAULT" si vide)
    // - Rechercher par (commune_insee + plu_version_label)
    // - Si trouvé => delete zones + update doc
    // - Sinon => insert doc
    // ------------------------------------------------------------------------
    let overwrite = false;
    let deleted_zones = 0;
    let deleted_extra_docs = 0;

    let existingDocs: any[] | null = null;
    let existingErr: any = null;

    // ✅ v4.8: Toujours rechercher par commune_insee + plu_version_label (contrainte unique)
    const result = await supabase
      .from("plu_documents")
      .select("id, created_at")
      .eq("commune_insee", final_commune_insee)
      .eq("plu_version_label", unique_version_label)
      .order("created_at", { ascending: false })
      .limit(10);

    existingDocs = result.data;
    existingErr = result.error;

    if (existingErr) {
      console.log("[RULESETS] db error");
      throw new Error("SELECT_EXISTING_PLU_DOCUMENT_FAILED");
    }

    const canonicalId =
      existingDocs && existingDocs.length > 0 ? (existingDocs[0] as any).id : null;

    // If multiple, remove extras to keep DB clean
    if (existingDocs && existingDocs.length > 1) {
      const extraIds = existingDocs.slice(1).map((d: any) => d.id);

      const { error: delDocsErr } = await supabase
        .from("plu_documents")
        .delete()
        .in("id", extraIds);

      if (delDocsErr) {
        console.log("[RULESETS] db error");
        throw new Error("DELETE_EXTRA_PLU_DOCUMENTS_FAILED");
      }

      deleted_extra_docs = extraIds.length;
    }

    let doc: any = null;

    if (canonicalId) {
      overwrite = true;

      // Delete existing zones for this doc
      const { error: delZonesErr, count } = await supabase
        .from("plu_zones_rulesets")
        .delete({ count: "exact" })
        .eq("document_id", canonicalId);

      if (delZonesErr) {
        console.log("[RULESETS] db error");
        throw new Error("DELETE_EXISTING_ZONES_FAILED");
      }
      deleted_zones = typeof count === "number" ? count : 0;

      // ✅ v4.6: Update doc with latest metadata + raw_json (using potentially filtered parsed)
      console.log("[RULESETS] db update");

      const { data: updated, error: updErr } = await supabase
        .from("plu_documents")
        .update({
          commune_insee: final_commune_insee,
          commune_nom: final_commune_nom,
          plu_version_label: unique_version_label,
          source_document: parsed.source_document ?? pdf_url,
          storage_path,
          raw_json: parsed,  // ✅ v4.6: Store filtered parsed object
        })
        .eq("id", canonicalId)
        .select()
        .single();

      if (updErr || !updated) {
        throw new Error("UPDATE_PLU_DOCUMENTS_FAILED");
      }

      doc = updated;
    } else {
      // Insert new doc
      console.log("[RULESETS] db insert");

      const { data: inserted, error: docError } = await supabase
        .from("plu_documents")
        .insert({
          commune_insee: final_commune_insee,
          commune_nom: final_commune_nom,
          plu_version_label: unique_version_label,
          source_document: parsed.source_document ?? pdf_url,
          storage_path,
          raw_json: parsed,  // ✅ v4.6: Store filtered parsed object
        })
        .select()
        .single();

      if (docError || !inserted) {
        throw new Error("INSERT_PLU_DOCUMENTS_FAILED");
      }

      doc = inserted;
    }

    // 4) Insert zones (fresh) with extracted numeric fields
    // v4.4: Track diagnostics for summary
    const zones = parsed.zones_rulesets ?? [];
    
    // v4.4: Diagnostic counters
    let zones_no_data = 0;
    let zones_with_meter_text = 0;
    let zones_with_parking_text = 0;
    let zones_with_numbers = 0;
    let zones_structured_extraction = 0;
    let zones_regex_extraction = 0;
    
    // v4.4: First 2 zones diagnostics for response
    const extraction_diag_by_zone_code: Record<string, ExtractionDiagnostics> = {};
    
    const rows = zones.map((z, idx) => {
      const extracted = extractNumericFieldsFromRuleset(z.ruleset);
      const diag = extracted._diag;
      
      // v4.4: Update counters
      if (diag.hasNumbers) zones_with_numbers++;
      if (diag.hasMeterText) zones_with_meter_text++;
      if (diag.hasParkingText) zones_with_parking_text++;
      if (!diag.hasNumbers && !diag.hasMeterText && !diag.hasParkingText) {
        zones_no_data++;
      }
      
      // v4.4: Track extraction source
      const hasStructured = 
        diag.extractionSource.voirie === "structured" ||
        diag.extractionSource.limites === "structured" ||
        diag.extractionSource.fond === "structured" ||
        diag.extractionSource.parking === "structured";
      const hasRegex = 
        diag.extractionSource.voirie === "regex" ||
        diag.extractionSource.limites === "regex" ||
        diag.extractionSource.fond === "regex" ||
        diag.extractionSource.parking === "regex";
      
      if (hasStructured) zones_structured_extraction++;
      if (hasRegex) zones_regex_extraction++;
      
      // v4.4: store first 2 zones diagnostics (server-side only)
      if (idx < 2) {
        // Store for response
        extraction_diag_by_zone_code[z.zone_code] = diag;
      }
      
      // Return row for DB (without _diag)
      return {
        document_id: doc.id,
        commune_insee: final_commune_insee,
        zone_code: z.zone_code,
        zone_libelle: z.zone_libelle,
        ruleset: z.ruleset,
        // v4.4: extracted numeric fields aligned to DB columns
        retrait_min_m: extracted.retrait_min_m,
        retrait_voirie_min_m: extracted.retrait_voirie_min_m,
        retrait_limites_separatives_min_m: extracted.retrait_limites_separatives_min_m,
        retrait_fond_parcelle_min_m: extracted.retrait_fond_parcelle_min_m,
        places_par_logement: extracted.places_par_logement,
        surface_par_place_m2: extracted.surface_par_place_m2,
      };
    });

    if (rows.length > 0) {
      const { error: zonesError } = await supabase
        .from("plu_zones_rulesets")
        .insert(rows);

      if (zonesError) {
        console.log("[RULESETS] db error");
        throw new Error("INSERT_PLU_ZONES_RULESETS_FAILED");
      }

      console.log("[RULESETS] db insert");
    }

    console.log("[RULESETS] ingestion ok");

    // ✅ v4.9: Production-safe response — no input echo, no IDs, no parser/diag leaks
    const responseBody: Record<string, unknown> = {
      success: true,
      version: "plu-ingest-rulesets-v4.9",
      overwrite,
      deleted_zones,
      zones_inserted: rows.length,
    };

    return jsonResponse(responseBody, 200);
  } catch (_e) {
    // ✅ v4.9: Production-safe — never log or expose error internals
    console.log("[RULESETS] fatal");

    return jsonResponse(
      {
        success: false,
        error: "PLU_INGEST_RULESETS_INTERNAL_ERROR",
      },
      500,
    );
  }
});