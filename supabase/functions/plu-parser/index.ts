// @ts-ignore: npm import supported by Supabase Edge Functions
import pdfParse from "npm:pdf-parse@1.1.1";
// @ts-ignore: npm import supported by Supabase Edge Functions
import { createClient } from "npm:@supabase/supabase-js@2";

export interface Ruleset {
  reculs: {
    voirie: { min_m: number | null; note: string | null };
    limites_separatives: { min_m: number | null; note: string | null };
  };
  hauteur: {
    hauteur_max_m: number | null;
    hauteur_egout_m: number | null;
    hauteur_faitage_m: number | null;
    note: string | null;
  };
  emprise_sol: { emprise_sol_max: number | null; note: string | null };
  stationnement: { places_par_logement: number | null; note: string | null };
  pleine_terre: { min_pct: number | null; note: string | null };
  densite: { cos_max: number | null; note: string | null };
}

export interface ZoneRuleset {
  zone_code: string;
  zone_libelle: string;
  ruleset: Ruleset;
}

export interface PluParseRequest {
  commune_insee?: string;
  commune_nom?: string;
  target_zone_code?: string;
  /** Texte déjà extrait côté client (chemin prioritaire, recommandé). */
  pdf_text?: string;
  pdf_base64?: string;
  source_pdf_url?: string;
  pdf_filename?: string;
  force_reparse?: boolean;
}

export interface PluParseResponse {
  success: boolean;
  commune_insee?: string;
  commune_nom?: string;
  confidence_score?: number;
  parser_mode?: "regex" | "ai_fallback" | "cache";
  detected_zone_code?: string | null;
  zones_rulesets?: ZoneRuleset[];
  error?: string;
  message?: string;
  warnings?: string[];
}

type PdfParseResult = {
  text: string;
  numpages: number;
};

type CacheRow = {
  commune_insee: string;
  zone_code: string;
  zone_libelle: string | null;
  ruleset: Ruleset;
  parsed_at?: string | null;
  source_file?: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

// Cap de pages pour le fallback pdf-parse côté serveur.
// Au-delà, le risque de 546 (CPU exceeded) devient élevé.
const MAX_PDF_PAGES_FALLBACK = 45;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ??
  "";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        success: true,
        status: "ok",
        function: "plu-parser",
        version: "3.1.0",
        cache_enabled: Boolean(supabase),
        ai_fallback_enabled: Boolean(OPENAI_API_KEY),
        prefers_pdf_text: true,
      }),
      { status: 200, headers: corsHeaders },
    );
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        success: false,
        error: "METHOD_NOT_ALLOWED",
      }),
      { status: 405, headers: corsHeaders },
    );
  }

  try {
    const body = (await req.json()) as PluParseRequest;
    const result = await parsePlu(body);

    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 400,
      headers: corsHeaders,
    });
  } catch (_error) {
    console.error("[plu-parser] unhandled error");

    return new Response(
      JSON.stringify({
        success: false,
        error: "PLU_PARSER_ERROR",
      }),
      { status: 500, headers: corsHeaders },
    );
  }
});

async function parsePlu(input: PluParseRequest): Promise<PluParseResponse> {
  const {
    commune_insee,
    commune_nom,
    target_zone_code,
    pdf_text,
    pdf_base64,
    source_pdf_url,
    pdf_filename,
    force_reparse,
  } = input;

  const warnings: string[] = [];

  console.log("[plu-parser] parse request");

  const requestedZoneCode = normalizeZoneCode(target_zone_code || "");

  if (!force_reparse && commune_insee && requestedZoneCode) {
    const cached = await fetchExistingPlu(commune_insee, requestedZoneCode);
    if (cached) {
      console.log("[plu-parser] cache hit");

      return {
        success: true,
        commune_insee,
        commune_nom,
        confidence_score: computeConfidenceScore(cached.ruleset),
        parser_mode: "cache",
        detected_zone_code: requestedZoneCode,
        warnings,
        zones_rulesets: [
          {
            zone_code: cached.zone_code,
            zone_libelle: cached.zone_libelle || getZoneLibelle(cached.zone_code),
            ruleset: cached.ruleset,
          },
        ],
      };
    }
  }

  // --- Acquisition du texte -------------------------------------------------
  // Chemin prioritaire : texte déjà extrait côté client (pas de CPU pdf-parse).
  let text: string;

  if (pdf_text && typeof pdf_text === "string" && pdf_text.trim().length > 0) {
    text = normalizePdfText(pdf_text);
    console.log("[plu-parser] text provided by client");
  } else {
    // Fallback serveur : parsing PDF borné en pages pour limiter le CPU.
    const pdfBytes = await resolvePdfBytes({ pdf_base64, source_pdf_url });
    console.log("[plu-parser] pdf loaded");

    const pdfData = (await pdfParse(pdfBytes, {
      max: MAX_PDF_PAGES_FALLBACK,
    })) as PdfParseResult;

    if (typeof pdfData.numpages === "number" && pdfData.numpages > MAX_PDF_PAGES_FALLBACK) {
      warnings.push(
        `PDF tronqué à ${MAX_PDF_PAGES_FALLBACK} pages pour rester sous la limite CPU. Préférez l'extraction texte côté client.`,
      );
    }

    text = normalizePdfText(pdfData.text);
  }

  console.log("[plu-parser] extraction complete");

  if (!text || text.length < 500) {
    return {
      success: false,
      commune_insee,
      commune_nom,
      error: "PDF_TEXT_EXTRACTION_TOO_LOW",
      message:
        "PDF non lisible ou trop pauvre en texte extractible. Le document semble scanné ou dans un format incompatible.",
      warnings: ["Extraction texte insuffisante."],
    };
  }

  const detectedZoneCode = requestedZoneCode || detectLikelyZoneCode(text) || "UB";

  if (
    !force_reparse &&
    commune_insee &&
    detectedZoneCode &&
    detectedZoneCode !== requestedZoneCode
  ) {
    const cached = await fetchExistingPlu(commune_insee, detectedZoneCode);
    if (cached) {
      console.log("[plu-parser] cache hit");

      return {
        success: true,
        commune_insee,
        commune_nom,
        confidence_score: computeConfidenceScore(cached.ruleset),
        parser_mode: "cache",
        detected_zone_code: detectedZoneCode,
        warnings,
        zones_rulesets: [
          {
            zone_code: cached.zone_code,
            zone_libelle: cached.zone_libelle || getZoneLibelle(cached.zone_code),
            ruleset: cached.ruleset,
          },
        ],
      };
    }
  }

  const articles = findArticleOffsets(text, detectedZoneCode);
  const ruleset = buildEmptyRuleset();

  parseArticle6(text, articles, ruleset);
  parseArticle7(text, articles, ruleset);
  parseArticle9(text, articles, ruleset);
  parseArticle10(text, articles, ruleset);
  parseArticle12(text, articles, ruleset);
  parseArticle13(text, articles, ruleset);
  parseArticle14(text, articles, ruleset);

  let parserMode: "regex" | "ai_fallback" = "regex";
  let finalRuleset = ruleset;
  let confidenceScore = computeConfidenceScore(finalRuleset);

  console.log("[plu-parser] regex extraction");

  if (confidenceScore < 3) {
    warnings.push(
      "Score regex faible : tentative de consolidation via fallback IA.",
    );

    const aiRuleset = await tryAiFallback({
      text,
      zoneCode: detectedZoneCode,
    });

    if (aiRuleset) {
      finalRuleset = mergeRulesetsPreferRegex(ruleset, aiRuleset);
      parserMode = "ai_fallback";
      confidenceScore = computeConfidenceScore(finalRuleset);
      console.log("[plu-parser] ai fallback applied");
    } else {
      warnings.push("Fallback IA indisponible ou sans résultat exploitable.");
    }
  }

  const response: PluParseResponse = {
    success: true,
    commune_insee,
    commune_nom,
    confidence_score: confidenceScore,
    parser_mode: parserMode,
    detected_zone_code: detectedZoneCode,
    warnings,
    zones_rulesets: [
      {
        zone_code: detectedZoneCode,
        zone_libelle: getZoneLibelle(detectedZoneCode),
        ruleset: finalRuleset,
      },
    ],
  };

  if (commune_insee) {
    await persistParsedPlu({
      commune_insee,
      zone_code: detectedZoneCode,
      zone_libelle: getZoneLibelle(detectedZoneCode),
      ruleset: finalRuleset,
      source_file: pdf_filename ?? null,
    });
  }

  return response;
}

async function resolvePdfBytes(input: {
  pdf_base64?: string;
  source_pdf_url?: string;
}): Promise<Uint8Array> {
  const { pdf_base64, source_pdf_url } = input;

  if (pdf_base64 && typeof pdf_base64 === "string") {
    return base64ToBytes(pdf_base64);
  }

  if (source_pdf_url && typeof source_pdf_url === "string") {
    const response = await fetch(source_pdf_url);

    if (!response.ok) {
      throw new Error("PDF_DOWNLOAD_FAILED");
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  throw new Error("PDF_SOURCE_REQUIRED");
}

function base64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.includes(",")
    ? base64.substring(base64.indexOf(",") + 1)
    : base64;

  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

// Passe unique : collapse tout le whitespace (\r, \n, espaces) en un seul espace.
function normalizePdfText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeZoneCode(code: string): string {
  return String(code || "").trim().toUpperCase();
}

function detectLikelyZoneCode(text: string): string | null {
  const matches = [
    ...text.matchAll(/\bARTICLE\s+([A-Z]{1,3})\s+1\b/gi),
    ...text.matchAll(/\bART\.?\s*([A-Z]{1,3})\s+1\b/gi),
  ];

  const counts = new Map<string, number>();

  for (const m of matches) {
    const z = normalizeZoneCode(m[1]);
    if (!z) continue;
    counts.set(z, (counts.get(z) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;

  for (const [zone, count] of counts.entries()) {
    if (count > bestCount) {
      best = zone;
      bestCount = count;
    }
  }

  return best;
}

function findArticleOffsets(text: string, zoneCode: string): Record<number, number> {
  const articles: Record<number, number> = {};

  for (let i = 1; i <= 14; i++) {
    const patterns = [
      new RegExp(`ARTICLE\\s+${escapeRegex(zoneCode)}\\s+${i}\\b`, "i"),
      new RegExp(`ART\\.?\\s*${escapeRegex(zoneCode)}\\s+${i}\\b`, "i"),
      new RegExp(`${escapeRegex(zoneCode)}\\s+ARTICLE\\s+${i}\\b`, "i"),
      new RegExp(`ARTICLE\\s+${i}\\b`, "i"),
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match && typeof match.index === "number") {
        articles[i] = match.index;
        console.log("[plu-parser] article found");
        break;
      }
    }
  }

  return articles;
}

function getArticleText(
  text: string,
  articles: Record<number, number>,
  articleNum: number,
): string | null {
  const start = articles[articleNum];
  if (typeof start !== "number") return null;

  let end = text.length;

  for (let i = articleNum + 1; i <= 14; i++) {
    if (typeof articles[i] === "number") {
      end = articles[i];
      break;
    }
  }

  return text.substring(start, Math.min(end, start + 6000));
}

function buildEmptyRuleset(): Ruleset {
  return {
    reculs: {
      voirie: { min_m: null, note: null },
      limites_separatives: { min_m: null, note: null },
    },
    hauteur: {
      hauteur_max_m: null,
      hauteur_egout_m: null,
      hauteur_faitage_m: null,
      note: null,
    },
    emprise_sol: { emprise_sol_max: null, note: null },
    stationnement: { places_par_logement: null, note: null },
    pleine_terre: { min_pct: null, note: null },
    densite: { cos_max: null, note: null },
  };
}

function parseArticle6(
  text: string,
  articles: Record<number, number>,
  ruleset: Ruleset,
): void {
  const art6 = getArticleText(text, articles, 6);
  if (!art6) return;

  const match =
    art6.match(/distance\s+minimale\s+de\s+(\d+(?:[.,]\d+)?)/i) ||
    art6.match(/(\d+(?:[.,]\d+)?)\s*m\s+de\s+l['’]alignement/i) ||
    art6.match(/minimum\s+de\s+(\d+(?:[.,]\d+)?)\s*m/i) ||
    art6.match(/recul\s+minimum\s+de\s+(\d+(?:[.,]\d+)?)/i);

  if (match) {
    ruleset.reculs.voirie.min_m = parseFrenchNumber(match[1]);
  }

  if (/à\s+l['’]alignement/i.test(art6)) {
    ruleset.reculs.voirie.note = "Alignement ou recul";
  }
}

function parseArticle7(
  text: string,
  articles: Record<number, number>,
  ruleset: Ruleset,
): void {
  const art7 = getArticleText(text, articles, 7);
  if (!art7) return;

  const match =
    art7.match(/au\s+moins\s+(\d+(?:[.,]\d+)?)\s*m/i) ||
    art7.match(/(\d+(?:[.,]\d+)?)\s*m\s+de\s+celle-ci/i) ||
    art7.match(/minimum\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*m/i) ||
    art7.match(/distance\s+minimale\s+de\s+(\d+(?:[.,]\d+)?)\s*m/i);

  if (match) {
    ruleset.reculs.limites_separatives.min_m = parseFrenchNumber(match[1]);
  }

  if (/sur\s+les?\s+limites?/i.test(art7) || /en\s+limite/i.test(art7)) {
    ruleset.reculs.limites_separatives.note =
      "Implantation en limite autorisée";
  }
}

function parseArticle9(
  text: string,
  articles: Record<number, number>,
  ruleset: Ruleset,
): void {
  const art9 = getArticleText(text, articles, 9);
  if (!art9) return;

  if (
    /pas\s+fix/i.test(art9) ||
    /sans\s+objet/i.test(art9) ||
    /il\s+n['’]est\s+pas/i.test(art9)
  ) {
    ruleset.emprise_sol.note = "Pas de règle";
    return;
  }

  const match = art9.match(/(\d+(?:[.,]\d+)?)\s*%/i);
  if (match) {
    const pct = parseFrenchNumber(match[1]);
    if (pct != null) {
      ruleset.emprise_sol.emprise_sol_max = pct / 100;
    }
  }
}

function parseArticle10(
  text: string,
  articles: Record<number, number>,
  ruleset: Ruleset,
): void {
  const art10 = getArticleText(text, articles, 10);
  if (!art10) return;

  const egoutMatch =
    art10.match(
      /(\d+(?:[,\.]\d+)?)\s*m[èe]?t?r?e?s?\.?\s*à\s+l['’]égout/i,
    ) ||
    art10.match(/excéder\s+(\d+(?:[,\.]\d+)?)\s*m[èe]?t?r?e?s?/i) ||
    art10.match(/hauteur\s+max(?:imale)?\s+de\s+(\d+(?:[,\.]\d+)?)\s*m/i);

  if (egoutMatch) {
    ruleset.hauteur.hauteur_egout_m = parseFrenchNumber(egoutMatch[1]);
    ruleset.hauteur.hauteur_max_m = ruleset.hauteur.hauteur_egout_m;
  }

  const faitageMatch =
    art10.match(/(\d+(?:[,\.]\d+)?)\s*m\.?\s*(?:au\s+)?fa[îi]tage/i) ||
    art10.match(/fa[îi]tage\s+.*?(\d+(?:[,\.]\d+)?)\s*m/i);

  if (faitageMatch) {
    ruleset.hauteur.hauteur_faitage_m = parseFrenchNumber(faitageMatch[1]);
  }

  if (
    ruleset.hauteur.hauteur_egout_m != null &&
    ruleset.hauteur.hauteur_faitage_m != null
  ) {
    ruleset.hauteur.note =
      `${ruleset.hauteur.hauteur_egout_m}m égout, ${ruleset.hauteur.hauteur_faitage_m}m faîtage`;
  }
}

function parseArticle12(
  text: string,
  articles: Record<number, number>,
  ruleset: Ruleset,
): void {
  const art12 = getArticleText(text, articles, 12);
  if (!art12) return;

  const match =
    art12.match(
      /minimum\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s+places?\s+par\s+logement/i,
    ) ||
    art12.match(/(\d+(?:[.,]\d+)?)\s+places?\s+par\s+logement/i) ||
    art12.match(/(\d+(?:[.,]\d+)?)\s+place[s]?\/logt/i) ||
    art12.match(/(\d+(?:[.,]\d+)?)\s+place[s]?\s+par\s+logt/i);

  if (match) {
    ruleset.stationnement.places_par_logement = parseFrenchNumber(match[1]);
  }
}

function parseArticle13(
  text: string,
  articles: Record<number, number>,
  ruleset: Ruleset,
): void {
  const art13 = getArticleText(text, articles, 13);
  if (!art13) return;

  const allPcts = [...art13.matchAll(/(\d+(?:[.,]\d+)?)\s*%/gi)];
  const validPct = allPcts
    .map((m) => parseFrenchNumber(m[1]))
    .find((v) => typeof v === "number" && v >= 10);

  if (validPct != null) {
    ruleset.pleine_terre.min_pct = validPct;
  }
}

function parseArticle14(
  text: string,
  articles: Record<number, number>,
  ruleset: Ruleset,
): void {
  const art14 = getArticleText(text, articles, 14);
  if (!art14) return;

  if (/sans\s+objet/i.test(art14) || /pas\s+fix/i.test(art14)) {
    ruleset.densite.note = "Pas de COS";
    return;
  }

  const match = art14.match(/(\d+(?:[,\.]\d+)?)/);
  if (match) {
    const value = parseFrenchNumber(match[1]);
    if (value != null && value <= 5) {
      ruleset.densite.cos_max = value;
    }
  }
}

function parseFrenchNumber(value: string | undefined | null): number | null {
  if (!value) return null;
  const normalized = String(value).replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getZoneLibelle(code: string): string {
  const labels: Record<string, string> = {
    UA: "Zone urbaine centre",
    UB: "Zone urbaine dense",
    UC: "Zone urbaine résidentielle",
    UD: "Zone urbaine pavillonnaire",
    UE: "Zone d'activités",
    UF: "Zone urbaine spécifique",
    A: "Zone agricole",
    AU: "Zone à urbaniser",
    N: "Zone naturelle",
  };

  return labels[code] || `Zone ${code}`;
}

function computeConfidenceScore(ruleset: Ruleset): number {
  let score = 0;
  if (ruleset.hauteur.hauteur_max_m != null || ruleset.hauteur.hauteur_egout_m != null) score++;
  if (ruleset.reculs.voirie.min_m != null || ruleset.reculs.voirie.note) score++;
  if (ruleset.reculs.limites_separatives.min_m != null || ruleset.reculs.limites_separatives.note) score++;
  if (ruleset.emprise_sol.emprise_sol_max != null || ruleset.emprise_sol.note) score++;
  if (ruleset.stationnement.places_par_logement != null) score++;
  if (ruleset.pleine_terre.min_pct != null) score++;
  return score;
}

async function fetchExistingPlu(
  communeInsee: string,
  zoneCode: string,
): Promise<CacheRow | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from("plu_parsed")
      .select("commune_insee, zone_code, zone_libelle, ruleset, parsed_at, source_file")
      .eq("commune_insee", communeInsee)
      .eq("zone_code", zoneCode)
      .order("parsed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn("[plu-parser] cache read failed");
      return null;
    }

    if (!data?.ruleset) return null;
    return data as CacheRow;
  } catch (_err) {
    console.warn("[plu-parser] cache read exception");
    return null;
  }
}

async function persistParsedPlu(input: {
  commune_insee: string;
  zone_code: string;
  zone_libelle: string;
  ruleset: Ruleset;
  source_file: string | null;
}): Promise<void> {
  if (!supabase) return;

  try {
    const { error } = await supabase.from("plu_parsed").upsert(
      {
        commune_insee: input.commune_insee,
        zone_code: input.zone_code,
        zone_libelle: input.zone_libelle,
        ruleset: input.ruleset,
        source_file: input.source_file,
        parsed_at: new Date().toISOString(),
      },
      { onConflict: "commune_insee,zone_code" },
    );

    if (error) {
      console.warn("[plu-parser] cache write failed");
    }
  } catch (_err) {
    console.warn("[plu-parser] cache write exception");
  }
}

async function tryAiFallback(input: {
  text: string;
  zoneCode: string;
}): Promise<Ruleset | null> {
  if (!OPENAI_API_KEY) {
    return null;
  }

  const excerpt = input.text.slice(0, 18000);

  try {
    const schema = {
      name: "plu_ruleset_extraction",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reculs: {
            type: "object",
            additionalProperties: false,
            properties: {
              voirie: {
                type: "object",
                additionalProperties: false,
                properties: {
                  min_m: { type: ["number", "null"] },
                  note: { type: ["string", "null"] },
                },
                required: ["min_m", "note"],
              },
              limites_separatives: {
                type: "object",
                additionalProperties: false,
                properties: {
                  min_m: { type: ["number", "null"] },
                  note: { type: ["string", "null"] },
                },
                required: ["min_m", "note"],
              },
            },
            required: ["voirie", "limites_separatives"],
          },
          hauteur: {
            type: "object",
            additionalProperties: false,
            properties: {
              hauteur_max_m: { type: ["number", "null"] },
              hauteur_egout_m: { type: ["number", "null"] },
              hauteur_faitage_m: { type: ["number", "null"] },
              note: { type: ["string", "null"] },
            },
            required: [
              "hauteur_max_m",
              "hauteur_egout_m",
              "hauteur_faitage_m",
              "note",
            ],
          },
          emprise_sol: {
            type: "object",
            additionalProperties: false,
            properties: {
              emprise_sol_max: { type: ["number", "null"] },
              note: { type: ["string", "null"] },
            },
            required: ["emprise_sol_max", "note"],
          },
          stationnement: {
            type: "object",
            additionalProperties: false,
            properties: {
              places_par_logement: { type: ["number", "null"] },
              note: { type: ["string", "null"] },
            },
            required: ["places_par_logement", "note"],
          },
          pleine_terre: {
            type: "object",
            additionalProperties: false,
            properties: {
              min_pct: { type: ["number", "null"] },
              note: { type: ["string", "null"] },
            },
            required: ["min_pct", "note"],
          },
          densite: {
            type: "object",
            additionalProperties: false,
            properties: {
              cos_max: { type: ["number", "null"] },
              note: { type: ["string", "null"] },
            },
            required: ["cos_max", "note"],
          },
        },
        required: [
          "reculs",
          "hauteur",
          "emprise_sol",
          "stationnement",
          "pleine_terre",
          "densite",
        ],
      },
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: schema,
        },
        messages: [
          {
            role: "developer",
            content:
              "Tu extrais strictement des règles PLU françaises depuis un texte. Tu n'inventes jamais. Si une valeur n'est pas trouvée, tu renvoies null. emprise_sol_max doit être un ratio entre 0 et 1. pleine_terre.min_pct est un pourcentage entier ou décimal, par exemple 30 pour 30%.",
          },
          {
            role: "user",
            content:
              `Zone cible: ${input.zoneCode}\n\n` +
              `Texte extrait du PDF:\n${excerpt}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.warn("[plu-parser] AI fallback HTTP error");
      return null;
    }

    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;

    if (!content || typeof content !== "string") {
      console.warn("[plu-parser] AI fallback empty content");
      return null;
    }

    const parsed = JSON.parse(content) as Ruleset;
    return sanitizeAiRuleset(parsed);
  } catch (_err) {
    console.warn("[plu-parser] AI fallback exception");
    return null;
  }
}

function sanitizeAiRuleset(input: Ruleset): Ruleset {
  const safe = buildEmptyRuleset();

  safe.reculs.voirie.min_m = sanitizeNullableNumber(input?.reculs?.voirie?.min_m);
  safe.reculs.voirie.note = sanitizeNullableString(input?.reculs?.voirie?.note);

  safe.reculs.limites_separatives.min_m = sanitizeNullableNumber(
    input?.reculs?.limites_separatives?.min_m,
  );
  safe.reculs.limites_separatives.note = sanitizeNullableString(
    input?.reculs?.limites_separatives?.note,
  );

  safe.hauteur.hauteur_max_m = sanitizeNullableNumber(input?.hauteur?.hauteur_max_m);
  safe.hauteur.hauteur_egout_m = sanitizeNullableNumber(input?.hauteur?.hauteur_egout_m);
  safe.hauteur.hauteur_faitage_m = sanitizeNullableNumber(input?.hauteur?.hauteur_faitage_m);
  safe.hauteur.note = sanitizeNullableString(input?.hauteur?.note);

  const emprise = sanitizeNullableNumber(input?.emprise_sol?.emprise_sol_max);
  safe.emprise_sol.emprise_sol_max =
    emprise != null && emprise > 1 ? emprise / 100 : emprise;
  safe.emprise_sol.note = sanitizeNullableString(input?.emprise_sol?.note);

  safe.stationnement.places_par_logement = sanitizeNullableNumber(
    input?.stationnement?.places_par_logement,
  );
  safe.stationnement.note = sanitizeNullableString(input?.stationnement?.note);

  safe.pleine_terre.min_pct = sanitizeNullableNumber(input?.pleine_terre?.min_pct);
  safe.pleine_terre.note = sanitizeNullableString(input?.pleine_terre?.note);

  safe.densite.cos_max = sanitizeNullableNumber(input?.densite?.cos_max);
  safe.densite.note = sanitizeNullableString(input?.densite?.note);

  return safe;
}

function sanitizeNullableNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function sanitizeNullableString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function mergeRulesetsPreferRegex(
  regexRuleset: Ruleset,
  aiRuleset: Ruleset,
): Ruleset {
  return {
    reculs: {
      voirie: {
        min_m: regexRuleset.reculs.voirie.min_m ?? aiRuleset.reculs.voirie.min_m,
        note: regexRuleset.reculs.voirie.note ?? aiRuleset.reculs.voirie.note,
      },
      limites_separatives: {
        min_m:
          regexRuleset.reculs.limites_separatives.min_m ??
          aiRuleset.reculs.limites_separatives.min_m,
        note:
          regexRuleset.reculs.limites_separatives.note ??
          aiRuleset.reculs.limites_separatives.note,
      },
    },
    hauteur: {
      hauteur_max_m:
        regexRuleset.hauteur.hauteur_max_m ?? aiRuleset.hauteur.hauteur_max_m,
      hauteur_egout_m:
        regexRuleset.hauteur.hauteur_egout_m ?? aiRuleset.hauteur.hauteur_egout_m,
      hauteur_faitage_m:
        regexRuleset.hauteur.hauteur_faitage_m ??
        aiRuleset.hauteur.hauteur_faitage_m,
      note: regexRuleset.hauteur.note ?? aiRuleset.hauteur.note,
    },
    emprise_sol: {
      emprise_sol_max:
        regexRuleset.emprise_sol.emprise_sol_max ??
        aiRuleset.emprise_sol.emprise_sol_max,
      note: regexRuleset.emprise_sol.note ?? aiRuleset.emprise_sol.note,
    },
    stationnement: {
      places_par_logement:
        regexRuleset.stationnement.places_par_logement ??
        aiRuleset.stationnement.places_par_logement,
      note: regexRuleset.stationnement.note ?? aiRuleset.stationnement.note,
    },
    pleine_terre: {
      min_pct:
        regexRuleset.pleine_terre.min_pct ?? aiRuleset.pleine_terre.min_pct,
      note: regexRuleset.pleine_terre.note ?? aiRuleset.pleine_terre.note,
    },
    densite: {
      cos_max: regexRuleset.densite.cos_max ?? aiRuleset.densite.cos_max,
      note: regexRuleset.densite.note ?? aiRuleset.densite.note,
    },
  };
}