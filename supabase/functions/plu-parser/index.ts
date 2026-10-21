// supabase/functions/plu-parser/index.ts — v3.2.3 (lot L2 + révisions R2 à R4 : provenance par valeur)
// Fonction AUTONOME (copier-coller Dashboard) : aucun import _shared.
// L2, contrat ADDITIF et optionnel :
//   requête  + pdf_page_offsets?: number[] (débuts de pages dans pdf_text),
//              parcel_lon?/parcel_lat? (point de la parcelle, lecture GPU zone-urba),
//              document_intitule?: string
//   réponse  + provenance_version: "plu_provenance_v1"
//              + document: { id, intitule, commune_insee, commune_nom, idurba, datvalid,
//                            date_approbation, nomfic, correspondance_gpu, empreinte_sha256, pages }
//              + zones_rulesets[i].provenance: { "<champ>": ProvenanceValeur }
//              + reculs.*.regle (FIXED | H_OVER_2 | H_OVER_2_MIN | ALIGNEMENT_OU_RETRAIT)
// Les anciens appelants ignorent ces champs ; les anciennes requêtes restent valides.
// Clé serveur : SUPABASE_SECRET_KEYS (JWT Signing Keys), jamais la clé service_role legacy.

// @ts-ignore: npm import supported by Supabase Edge Functions
import pdfParse from "npm:pdf-parse@1.1.1";
// @ts-ignore: npm import supported by Supabase Edge Functions
import { createClient } from "npm:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// GARDE D'ACCÈS (audit du 21/10/2026) — bloc autonome, recopié tel quel dans
// chaque fonction appelant un modèle d'IA (déploiement par copier-coller).
//
//  · Authentification : JWT d'un utilisateur Supabase vérifié auprès de GoTrue
//    (/auth/v1/user, l'équivalent de supabase.auth.getUser(token)), OU clé de
//    service (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS) pour les appels
//    serveur-à-serveur. La clé anon seule ne suffit plus : sans cela,
//    n'importe qui pouvait consommer le crédit OpenAI avec la clé publique.
//  · CORS : origine renvoyée seulement si elle figure dans
//    MIMMOZA_ALLOWED_ORIGINS (séparées par des virgules), à défaut dans la
//    liste ci-dessous. Une origine inconnue reçoit un 403.
// ─────────────────────────────────────────────────────────────────────────────
const GARDE_ORIGINES_PAR_DEFAUT = [
  "https://mimmoza.vercel.app",
  "https://mimmoza.fr",
  "https://www.mimmoza.fr",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function gardeOrigines(): string[] {
  const env = Deno.env.get("MIMMOZA_ALLOWED_ORIGINS");
  const liste = env ? env.split(/[\s,]+/).map((o) => o.trim().replace(/\/$/, "")).filter(Boolean) : [];
  return liste.length ? liste : GARDE_ORIGINES_PAR_DEFAUT;
}

function gardeClesJson(brut: string | undefined): string[] {
  if (!brut) return [];
  try {
    const v = JSON.parse(brut);
    if (typeof v === "string") return [v];
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
    if (v && typeof v === "object") return Object.values(v).filter((x): x is string => typeof x === "string");
  } catch {
    return [brut];
  }
  return [];
}

function gardeEnTetesCors(origine: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-requested-with",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
  };
  if (origine && gardeOrigines().includes(origine)) h["Access-Control-Allow-Origin"] = origine;
  return h;
}

async function gardeAppelantAutorise(req: Request): Promise<boolean> {
  const jeton = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jeton) return false;

  // Appel serveur-à-serveur avec la clé de service.
  const clesService = [
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    ...gardeClesJson(Deno.env.get("SUPABASE_SECRET_KEYS")),
  ].filter(Boolean);
  if (clesService.includes(jeton)) return true;

  // JWT utilisateur : validé par GoTrue (refuse la clé anon, sans « sub »).
  const url = Deno.env.get("SUPABASE_URL");
  const clePublique =
    gardeClesJson(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"))[0] ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!url || !clePublique) return false;
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${jeton}`, apikey: clePublique },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return false;
    const u = await r.json().catch(() => null);
    return Boolean(u && typeof u.id === "string");
  } catch {
    return false;
  }
}

/** Enveloppe le gestionnaire : CORS restreint + authentification obligatoire. */
function avecGarde(gestionnaire: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const origine = req.headers.get("Origin");
    const cors = gardeEnTetesCors(origine);
    const json = (corps: unknown, statut: number) =>
      new Response(JSON.stringify(corps), { status: statut, headers: { ...cors, "Content-Type": "application/json" } });

    if (origine && !cors["Access-Control-Allow-Origin"]) {
      return json({ success: false, error: "ORIGIN_NOT_ALLOWED" }, 403);
    }
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (!(await gardeAppelantAutorise(req))) {
      return json({ success: false, error: "UNAUTHORIZED", message: "Authentification requise." }, 401);
    }

    const reponse = await gestionnaire(req);
    // Remplace le « * » historique du gestionnaire par l'origine vérifiée.
    const entetes = new Headers(reponse.headers);
    entetes.delete("Access-Control-Allow-Origin");
    for (const [k, v] of Object.entries(cors)) entetes.set(k, v);
    return new Response(reponse.body, { status: reponse.status, statusText: reponse.statusText, headers: entetes });
  };
}
// ── fin de la garde d'accès ─────────────────────────────────────────────────

export interface Ruleset {
  reculs: {
    voirie: { min_m: number | null; note: string | null; regle?: string | null; reference?: "axe" | "berges" | "autre"; statut?: "conditionnel" };
    limites_separatives: { min_m: number | null; note: string | null; regle?: string | null };
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
  /** L2 — provenance conservée avec le ruleset mis en cache (champ JSON additif). */
  _provenance_v1?: { document: DocumentPlu; valeurs: Record<string, ProvenanceValeur> };
}

export interface ZoneRuleset {
  zone_code: string;
  zone_libelle: string;
  ruleset: Ruleset;
  /** L2 — provenance par valeur (clé = chemin du champ dans `ruleset`). */
  provenance?: Record<string, ProvenanceValeur>;
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
  /** L2 — débuts de pages (offsets dans pdf_text), dans l'ordre des pages. */
  pdf_page_offsets?: number[];
  /** L2 — point de la parcelle (WGS84) pour lire le document opposable au GPU. */
  parcel_lon?: number;
  parcel_lat?: number;
  /** L2 — intitulé lisible du document (sinon le nom du fichier). */
  document_intitule?: string;
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
  /** L2 */
  provenance_version?: string;
  document?: DocumentPlu;
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

// L2 — JWT Signing Keys : SUPABASE_SECRET_KEYS (dictionnaire JSON des clés
// secrètes). La clé service_role legacy n'est plus lue. Sans clé, le cache
// plu_parsed est simplement désactivé (l'analyse fonctionne).
function readFirstJsonKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const first = Object.values(parsed).find((v) => typeof v === "string");
      if (typeof first === "string") return first;
    }
  } catch {
    return raw;
  }
  return null;
}
const SUPABASE_SERVER_KEY = readFirstJsonKey(Deno.env.get("SUPABASE_SECRET_KEYS")) ?? "";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const supabase =
  SUPABASE_URL && SUPABASE_SERVER_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVER_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

Deno.serve(avecGarde(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        success: true,
        status: "ok",
        function: "plu-parser",
        version: "3.2.3",
        cache_enabled: Boolean(supabase),
        ai_fallback_enabled: Boolean(OPENAI_API_KEY),
        prefers_pdf_text: true,
        provenance_version: PROVENANCE_VERSION,
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
}));

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
    pdf_page_offsets,
    parcel_lon,
    parcel_lat,
    document_intitule,
  } = input;

  const warnings: string[] = [];

  console.log("[plu-parser] parse request");

  const requestedZoneCode = normalizeZoneCode(target_zone_code || "");

  // R2 (A16) : plus de lecture du cache AVANT l'analyse du texte importé — le cache
  // est désormais indexé sur l'empreinte du texte (voir plus bas).

  // --- Acquisition du texte -------------------------------------------------
  // Chemin prioritaire : texte déjà extrait côté client (pas de CPU pdf-parse).
  let text: string;
  // L2 — débuts de pages dans le texte normalisé (null = page inconnue).
  let debutsPages: number[] | null = null;
  let nbPages: number | null = null;

  if (pdf_text && typeof pdf_text === "string" && pdf_text.trim().length > 0) {
    const n = normaliserAvecPages(pdf_text, Array.isArray(pdf_page_offsets) ? pdf_page_offsets : null);
    text = n.text;
    debutsPages = n.debutsPages;
    nbPages = debutsPages ? debutsPages.length : null;
    console.log("[plu-parser] text provided by client");
  } else {
    // Fallback serveur : parsing PDF borné en pages pour limiter le CPU.
    const pdfBytes = await resolvePdfBytes({ pdf_base64, source_pdf_url });
    console.log("[plu-parser] pdf loaded");

    // L2 — rendu page par page identique au rendu par défaut de pdf-parse 1.1.1,
    // pour connaître le début de chaque page.
    const pagesTexte: string[] = [];
    const pdfData = (await pdfParse(pdfBytes, {
      max: MAX_PDF_PAGES_FALLBACK,
      pagerender: (pageData: any) =>
        pageData
          .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
          .then((tc: any) => {
            let lastY: number | undefined;
            let t = "";
            for (const item of tc.items) {
              if (lastY === item.transform[5] || !lastY) t += item.str;
              else t += "\n" + item.str;
              lastY = item.transform[5];
            }
            pagesTexte.push(t);
            return t;
          }),
    })) as PdfParseResult;

    if (typeof pdfData.numpages === "number" && pdfData.numpages > MAX_PDF_PAGES_FALLBACK) {
      warnings.push(
        `PDF tronqué à ${MAX_PDF_PAGES_FALLBACK} pages pour rester sous la limite CPU. Préférez l'extraction texte côté client.`,
      );
    }

    const debutsBruts = debutsPagesPdfParse(pagesTexte);
    const attendu = pagesTexte.map((p) => `\n\n${p}`).join("");
    const n = normaliserAvecPages(pdfData.text, attendu === pdfData.text ? debutsBruts : null);
    text = n.text;
    debutsPages = n.debutsPages;
    nbPages = typeof pdfData.numpages === "number" ? pdfData.numpages : null;
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

  // R2 (A16) : cache indexé sur commune + zone + EMPREINTE du texte analysé :
  // un autre PDF (ou un autre utilisateur) ne peut plus fournir la provenance.
  const empreinteTexte = await empreinteSha256(text);
  if (!force_reparse && commune_insee && detectedZoneCode && empreinteTexte) {
    const cached = await fetchExistingPlu(commune_insee, detectedZoneCode, empreinteTexte);
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
        provenance_version: cached.ruleset._provenance_v1 ? PROVENANCE_VERSION : undefined,
        document: cached.ruleset._provenance_v1?.document,
        zones_rulesets: [
          {
            zone_code: cached.zone_code,
            zone_libelle: cached.zone_libelle || getZoneLibelle(cached.zone_code),
            ruleset: cached.ruleset,
            provenance: provenanceDepuisCache(cached.ruleset),
          },
        ],
      };
    }
  }

  // L2 — extraction des articles 6 à 14 avec provenance par valeur
  // (remplace parseArticle6…14 ; mêmes valeurs, sauf corrections documentées).
  const extraction = extraireAvecProvenance(text, detectedZoneCode, debutsPages);
  const ruleset = extraction.ruleset as Ruleset;
  const provenance: Record<string, ProvenanceValeur> = extraction.provenance;

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
      completerProvenanceIA(provenance, ruleset, finalRuleset, text, extraction.reperes, debutsPages);
      parserMode = "ai_fallback";
      confidenceScore = computeConfidenceScore(finalRuleset);
      console.log("[plu-parser] ai fallback applied");
    } else {
      warnings.push("Fallback IA indisponible ou sans résultat exploitable.");
    }
  }

  // L2 — document source : empreinte du texte analysé + document opposable au GPU.
  const gpu = await lireZoneUrbaGpu(parcel_lon, parcel_lat);
  const document = construireDocument({
    empreinteSha256: empreinteTexte,
    intitule: document_intitule ?? null,
    communeInsee: commune_insee ?? null,
    communeNom: commune_nom ?? null,
    pdfFilename: pdf_filename ?? null,
    zoneUrba: zoneUrbaRetenue(gpu.features, detectedZoneCode),
    gpu: gpu.etat,
    pages: nbPages,
  });
  if (gpu.etat === "indisponible") {
    warnings.push("Géoportail de l'urbanisme injoignable : date et identifiant du document opposable inconnus.");
  } else if (document.correspondance_gpu === "gpu-aucun-document") {
    warnings.push("Aucun document d'urbanisme publié au Géoportail de l'urbanisme au point de la parcelle : date et identifiant inconnus.");
  }
  finalRuleset._provenance_v1 = { document, valeurs: provenance };

  const response: PluParseResponse = {
    success: true,
    commune_insee,
    commune_nom,
    confidence_score: confidenceScore,
    parser_mode: parserMode,
    detected_zone_code: detectedZoneCode,
    warnings,
    provenance_version: PROVENANCE_VERSION,
    document,
    zones_rulesets: [
      {
        zone_code: detectedZoneCode,
        zone_libelle: getZoneLibelle(detectedZoneCode),
        ruleset: finalRuleset,
        provenance,
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
      empreinte_sha256: empreinteTexte,
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

// L2 — findArticleOffsets, getArticleText, buildEmptyRuleset et parseArticle6…14
// sont remplacés par le bloc pur `extraireAvecProvenance` (voir L2-PROVENANCE-PURE).
function buildEmptyRuleset(): Ruleset {
  return rulesetVide() as Ruleset;
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
  empreinte: string,
): Promise<CacheRow | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from("plu_parsed")
      .select("commune_insee, zone_code, zone_libelle, ruleset, parsed_at, source_file")
      .eq("commune_insee", communeInsee)
      .eq("zone_code", zoneCode)
      .eq("empreinte_sha256", empreinte)
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
  empreinte_sha256: string | null;
}): Promise<void> {
  if (!input.empreinte_sha256) return;
  if (!supabase) return;

  try {
    const { error } = await supabase.from("plu_parsed").upsert(
      {
        commune_insee: input.commune_insee,
        zone_code: input.zone_code,
        zone_libelle: input.zone_libelle,
        ruleset: input.ruleset,
        source_file: input.source_file,
        empreinte_sha256: input.empreinte_sha256,
        parsed_at: new Date().toISOString(),
      },
      { onConflict: "commune_insee,zone_code,empreinte_sha256" },
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
        // R2 (A13) : même traitement pour voirie et séparatives
        regle: regleApresFusion(regexRuleset.reculs.voirie.min_m, regexRuleset.reculs.voirie.regle, regexRuleset.reculs.voirie.min_m ?? aiRuleset.reculs.voirie.min_m),
        // R4 (A1-ter) : objet de la distance conservé quand la valeur vient de la regex
        ...(regexRuleset.reculs.voirie.min_m != null && regexRuleset.reculs.voirie.statut ? { reference: regexRuleset.reculs.voirie.reference, statut: regexRuleset.reculs.voirie.statut } : {}),
      },
      limites_separatives: {
        min_m:
          regexRuleset.reculs.limites_separatives.min_m ??
          aiRuleset.reculs.limites_separatives.min_m,
        note:
          regexRuleset.reculs.limites_separatives.note ??
          aiRuleset.reculs.limites_separatives.note,
        regle: regleApresFusion(
          regexRuleset.reculs.limites_separatives.min_m,
          regexRuleset.reculs.limites_separatives.regle,
          regexRuleset.reculs.limites_separatives.min_m ?? aiRuleset.reculs.limites_separatives.min_m,
        ),
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

// ─────────────────────────────────────────────────────────────────────────────
// L2 — fonctions à effets (réseau, crypto) autour du bloc pur.
// ─────────────────────────────────────────────────────────────────────────────

const CHAMPS_PROVENANCE: ReadonlyArray<[string, (r: Ruleset) => number | null]> = [
  ["reculs.voirie.min_m", (r) => r.reculs.voirie.min_m],
  ["reculs.limites_separatives.min_m", (r) => r.reculs.limites_separatives.min_m],
  ["hauteur.hauteur_max_m", (r) => r.hauteur.hauteur_max_m],
  ["hauteur.hauteur_egout_m", (r) => r.hauteur.hauteur_egout_m],
  ["hauteur.hauteur_faitage_m", (r) => r.hauteur.hauteur_faitage_m],
  ["emprise_sol.emprise_sol_max", (r) => r.emprise_sol.emprise_sol_max],
  ["stationnement.places_par_logement", (r) => r.stationnement.places_par_logement],
  ["pleine_terre.min_pct", (r) => r.pleine_terre.min_pct],
  ["densite.cos_max", (r) => r.densite.cos_max],
];

/** Valeurs apportées par le repli IA (absentes de l'extraction regex) : provenance « llm ». */
function completerProvenanceIA(
  provenance: Record<string, ProvenanceValeur>,
  regex: Ruleset,
  fusion: Ruleset,
  text: string,
  reperes: Record<number, RepereArticle>,
  debutsPages: number[] | null,
): void {
  for (const [champ, lire] of CHAMPS_PROVENANCE) {
    const vRegex = lire(regex);
    const vFinal = lire(fusion);
    if (vRegex == null && typeof vFinal === "number") {
      provenance[champ] = provenanceValeurIA(text, reperes, debutsPages, champ, vFinal);
    }
  }
}

/** Provenance d'une ligne de cache : celle enregistrée avec le ruleset, sinon aucune (le front affichera « à vérifier »). */
function provenanceDepuisCache(ruleset: Ruleset): Record<string, ProvenanceValeur> | undefined {
  const v = ruleset?._provenance_v1?.valeurs;
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, ProvenanceValeur> = {};
  for (const [k, p] of Object.entries(v)) out[k] = { ...p, methode: "cache", confiance: Math.min(p.confiance ?? 0, 0.5) };
  return out;
}

async function empreinteSha256(text: string): Promise<string | null> {
  try {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Document d'urbanisme opposable au point (API Carto GPU, sans jeton). 5 s au plus, jamais bloquant. */
async function lireZoneUrbaGpu(lon: unknown, lat: unknown): Promise<{ etat: "interroge" | "indisponible" | "non-interroge"; features: unknown[] | null }> {
  if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { etat: "non-interroge", features: null };
  }
  try {
    const geom = encodeURIComponent(JSON.stringify({ type: "Point", coordinates: [lon, lat] }));
    const r = await fetch(`https://apicarto.ign.fr/api/gpu/zone-urba?geom=${geom}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { etat: "indisponible", features: null };
    const j = await r.json().catch(() => null);
    return { etat: "interroge", features: Array.isArray(j?.features) ? j.features : [] };
  } catch {
    console.warn("[plu-parser] GPU zone-urba unreachable");
    return { etat: "indisponible", features: null };
  }
}

// >>> L2-PROVENANCE-PURE (début)
// ─────────────────────────────────────────────────────────────────────────────
// LOT L2 — PROVENANCE PAR VALEUR (bloc PUR, sans Deno ni réseau).
// Ce bloc est DUPLIQUÉ À L'IDENTIQUE entre :
//   - supabase/functions/plu-parser/index.ts (Edge Function autonome) ;
//   - _mimmoza-agents/l2/tests-edge/pluParserProvenance.pure.ts (tests node:test).
// Le test `pluParserProvenance.test.ts` vérifie que les deux copies sont
// identiques octet pour octet (hors fins de ligne).
// ─────────────────────────────────────────────────────────────────────────────

export type MethodeExtraction = "regex" | "llm" | "saisie" | "cache";

export interface ProvenanceValeur {
  champ: string;
  valeur: number | null;
  /** FIXED, H_OVER_2, H_OVER_2_MIN, ALIGNEMENT_OU_RETRAIT ou null. */
  regle: string | null;
  /** Numéro d'article (« 6 », « 7 »…) ; null si inconnu. */
  article: string | null;
  /** Intitulé lu dans le texte (« ARTICLE UB 7 »). */
  article_intitule: string | null;
  /** true si l'appartenance de l'article à la zone est établie (intitulé ou en-tête de section). */
  article_zone_qualifie: boolean;
  /** R2 — zone à laquelle appartient l'article (intitulé « ARTICLE UB 7 » / « UB1-7 », ou en-tête « ZONE UB » qui le précède) ; null si inconnue. */
  article_zone: string | null;
  /** Extrait LITTÉRAL du texte normalisé, borné à EXTRAIT_MAX caractères autour de la valeur. */
  extrait: string | null;
  page: number | null;
  methode: MethodeExtraction;
  /** Confiance heuristique 0..1 (indicative, jamais un verdict). */
  confiance: number;
  /** R4 (A1-ter) — « conditionnel » si le recul ne se mesure pas depuis l'alignement (axe, berges…). */
  statut?: "conditionnel";
  /** R4 (A1-ter) — objet de la distance quand ce n'est pas l'alignement. */
  reference?: "axe" | "berges" | "autre";
  /** article-introuvable | valeur-non-trouvee | regle-non-chiffree | valeur-ia-non-retrouvee | bornes-incoherentes | null */
  motif: string | null;
}

export interface DocumentPlu {
  /** Identifiant stable du texte analysé : « plu-txt-<16 hex SHA-256> ». */
  id: string | null;
  intitule: string | null;
  commune_insee: string | null;
  commune_nom: string | null;
  /** Identifiant GPU du document d'urbanisme (zone-urba.idurba) au point de la parcelle. */
  idurba: string | null;
  /** Date de validité GPU (zone-urba.datvalid), ISO AAAA-MM-JJ. */
  datvalid: string | null;
  /** Date d'approbation lue dans idurba (…_AAAAMMJJ), ISO ; null si absente. */
  date_approbation: string | null;
  /** Nom du fichier de règlement publié au GPU (zone-urba.nomfic). */
  nomfic: string | null;
  /** Le PDF importé est-il le règlement publié au GPU ? */
  correspondance_gpu: "nom-fichier-identique" | "non-verifiee" | "gpu-indisponible" | "gpu-non-interroge" | "gpu-aucun-document";
  empreinte_sha256: string | null;
  pages: number | null;
}

export const EXTRAIT_MAX = 400;
export const PROVENANCE_VERSION = "plu_provenance_v1";

function estEspaceCode(c: number): boolean {
  return (c >= 9 && c <= 13) || c === 32 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
    c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/**
 * Normalise le texte EXACTEMENT comme `normalizePdfText` (blancs réduits à un
 * espace, bords retirés) et convertit les débuts de pages (offsets dans le
 * texte brut) en offsets dans le texte normalisé. Débuts absents, non entiers
 * ou non croissants → `debutsPages: null` (page inconnue).
 */
export function normaliserAvecPages(raw: string, debuts: readonly number[] | null | undefined): { text: string; debutsPages: number[] | null } {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!Array.isArray(debuts) || debuts.length === 0) return { text, debutsPages: null };
  for (let k = 0; k < debuts.length; k++) {
    const v = debuts[k];
    if (!Number.isInteger(v) || v < 0 || v > raw.length) return { text, debutsPages: null };
    if (k > 0 && v <= debuts[k - 1]) return { text, debutsPages: null };
  }
  const res: number[] = [];
  let outLen = 0;
  let pending = false;
  let j = 0;
  for (let i = 0; i <= raw.length && j < debuts.length; i++) {
    while (j < debuts.length && debuts[j] === i) {
      res.push(Math.min(text.length, outLen + (pending ? 1 : 0)));
      j++;
    }
    if (i === raw.length) break;
    if (estEspaceCode(raw.charCodeAt(i))) {
      if (outLen > 0) pending = true;
    } else {
      if (pending) {
        outLen++;
        pending = false;
      }
      outLen++;
    }
  }
  return { text, debutsPages: res };
}

/** Page (1 = première) contenant l'offset ; null si les pages sont inconnues. */
export function pageAOffset(debutsPages: readonly number[] | null, offset: number): number | null {
  if (!debutsPages || debutsPages.length === 0 || !Number.isFinite(offset) || offset < 0) return null;
  let lo = 0;
  let hi = debutsPages.length - 1;
  let rep = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (debutsPages[mid] <= offset) {
      rep = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return rep < 0 ? null : rep + 1;
}

/** Extrait littéral borné (≤ max caractères) centré sur [debut, fin[. */
export function extraitBorne(text: string, debut: number, fin: number, max: number = EXTRAIT_MAX): string {
  const d = Math.max(0, Math.min(debut, text.length));
  const f = Math.max(d, Math.min(fin, text.length));
  if (f - d >= max) return text.slice(d, d + max).trim();
  const marge = Math.floor((max - (f - d)) / 2);
  let a = Math.max(0, d - marge);
  let b = Math.min(text.length, f + marge);
  // ce qui n'a pas servi d'un côté est rendu à l'autre
  if (a === 0) b = Math.min(text.length, a + max);
  if (b === text.length) a = Math.max(0, b - max);
  // R2 (A10) : jamais de mot coupé aux bords (on rogne jusqu'au blanc, sans entamer [d, f[)
  if (a > 0 && !/\s/.test(text[a - 1])) {
    const k = text.slice(a, d).search(/\s/);
    if (k >= 0) a = a + k + 1;
  }
  if (b < text.length && !/\s/.test(text[b])) {
    const zone = text.slice(f, b);
    const k = zone.search(/\s\S*$/);
    if (k >= 0) b = f + k;
  }
  return text.slice(a, b).trim();
}

function echapperRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RepereArticle {
  offset: number;
  intitule: string;
  zoneQualifie: boolean;
  /** R2 — zone d'appartenance (intitulé qualifié ou en-tête de section) ; null si inconnue. */
  zone: string | null;
  /** R2 — d'où vient l'appartenance : intitulé qualifié, en-tête de section, ou aucune. */
  source: "intitule" | "section" | "aucune";
}

/** R2 (A4) — un « article N » précédé de « l' », « à l' », « de l' », « cf. »… est un RENVOI, pas un intitulé. */
export function estRenvoi(text: string, offset: number): boolean {
  const avant = text.slice(Math.max(0, offset - 14), offset);
  // R3 (A4-bis) : + « voir article 7 », « (article 7 : … », « cf article », « en application de l' »
  return /(?:\bl['’]\s*|\bdes?\s+|\baux?\s+|\bcf\.?\s*|\bselon\s+|\bpar\s+|\bdudit\s+|\bmême\s+|\bvoir\s+(?:l['’]\s*)?|\(\s*)$/i.test(avant);
}

/**
 * R3 (A3-bis) — EN-TÊTES de zone seulement : « ZONE UB » en majuscules, en début de
 * texte ou après une fin de phrase / un titre (« . », « : », tiret), ou précédé de
 * CHAPITRE / TITRE / SECTION / « DISPOSITIONS APPLICABLES À LA ». Une mention dans
 * le corps du texte (« en zone UB », « la zone N », « zones UA et UB ») ne compte jamais.
 */
export function sectionsDeZone(text: string): Array<{ offset: number; zone: string }> {
  const out: Array<{ offset: number; zone: string }> = [];
  const re = /\bZONE\s+([1-9]?(?:AU|U|A|N)[A-Z0-9]{0,4}[a-z]?)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const avant = text.slice(Math.max(0, m.index - 80), m.index);
    const titre = /\b(?:CHAPITRE|TITRE|SECTION|DISPOSITIONS\s+APPLICABLES\s+(?:À|A|AUX?)\s+LA)\b[^.]{0,40}$/i.test(avant);
    const debut = /(?:^|[.:;!?–—-])\s*$/.test(avant);
    const mention = /\b(?:en|la|de|des|les|aux?|du|cette|une|chaque|toute)\s*$/i.test(avant);
    if (titre || (debut && !mention)) out.push({ offset: m.index, zone: m[1].toUpperCase() });
  }
  return out;
}

function zoneAvant(sections: Array<{ offset: number; zone: string }>, offset: number): string | null {
  let z: string | null = null;
  for (const s of sections) {
    if (s.offset < offset) z = s.zone;
    else break;
  }
  return z;
}

function premierIntitule(text: string, re: RegExp, accepte: (index: number) => boolean): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (!estRenvoi(text, m.index) && accepte(m.index)) return m;
    if (m[0].length === 0) g.lastIndex++;
  }
  return null;
}

/**
 * Intitulés d'articles de la zone. Ordre : intitulé qualifié par la zone
 * (« ARTICLE UB 7 », « ART. UB 7 », « UB ARTICLE 7 », PLUi « Article UB1-7 » /
 * « UB1.7 », « Article 7 UB »), puis « ARTICLE 7 » non qualifié dont l'en-tête
 * de zone qui le précède est la zone (appartenance établie), puis — seulement si
 * le document ne porte AUCUN en-tête de zone — le premier « ARTICLE 7 »
 * (appartenance inconnue). Un « ARTICLE 7 » situé dans la section d'une AUTRE
 * zone n'est jamais retenu. Les renvois (« à l'article 8 ») sont ignorés.
 */
export function reperesArticles(text: string, zoneCode: string): Record<number, RepereArticle> {
  const out: Record<number, RepereArticle> = {};
  const zc = zoneCode.trim().toUpperCase();
  const z = echapperRegex(zoneCode);
  const sections = sectionsDeZone(text);
  for (let i = 1; i <= 14; i++) {
    const qualifies: RegExp[] = z
      ? [
          new RegExp(`ARTICLE\\s+${z}(?:\\s+|\\s*[-.]\\s*)${i}\\b`, "i"),
          new RegExp(`ART\\.?\\s*${z}(?:\\s+|\\s*[-.]\\s*)${i}\\b`, "i"),
          new RegExp(`\\b${z}\\s+ARTICLE\\s+${i}\\b`, "i"),
          new RegExp(`ARTICLE\\s+${i}\\s+(?:[-–:]\\s*)?(?:de\\s+la\\s+zone\\s+|zone\\s+)?${z}\\b`, "i"),
        ]
      : [];
    let trouve: RepereArticle | null = null;
    for (const re of qualifies) {
      const m = premierIntitule(text, re, () => true);
      if (m) {
        trouve = { offset: m.index, intitule: m[0], zoneQualifie: true, zone: zc || null, source: "intitule" };
        break;
      }
    }
    if (!trouve) {
      const generique = new RegExp(`ARTICLE\\s+${i}\\b`, "i");
      const m = zc ? premierIntitule(text, generique, (idx) => zoneAvant(sections, idx) === zc) : null;
      if (m) trouve = { offset: m.index, intitule: m[0], zoneQualifie: true, zone: zc, source: "section" };
      else if (sections.length === 0) {
        const m2 = premierIntitule(text, generique, () => true);
        if (m2) trouve = { offset: m2.index, intitule: m2[0], zoneQualifie: false, zone: null, source: "aucune" };
      }
    }
    if (trouve) out[i] = trouve;
  }
  return out;
}

/**
 * Bornes du texte d'un article : jusqu'au PROCHAIN intitulé retenu (quel que soit
 * son numéro) ou au prochain en-tête de zone, 6000 caractères au plus.
 * Jamais de bornes inversées (R2, A4).
 */
export function bornesArticle(text: string, reperes: Record<number, RepereArticle>, n: number): { debut: number; fin: number } | null {
  const r = reperes[n];
  if (!r) return null;
  let fin = text.length;
  for (const k of Object.keys(reperes)) {
    const o = reperes[Number(k)].offset;
    if (o > r.offset && o < fin) fin = o;
  }
  // un article repéré par l'en-tête de section s'arrête à l'en-tête de la zone suivante
  for (const s of r.source === "section" ? sectionsDeZone(text) : []) {
    if (s.offset > r.offset + r.intitule.length && s.offset < fin && r.zone !== null && s.zone !== r.zone) {
      fin = s.offset;
      break;
    }
  }
  fin = Math.min(fin, r.offset + 6000);
  if (fin <= r.offset) return null;
  return { debut: r.offset, fin };
}

export function nombreFrancais(v: string | undefined | null): number | null {
  if (!v) return null;
  const n = Number.parseFloat(String(v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
}

interface Trouvaille {
  valeur: number | null;
  debut: number;
  fin: number;
  /** R2 — position du nombre lu (groupe capturé). */
  vDebut?: number;
  vFin?: number;
}

const NON_REGLEMENTE = /n['’]est\s+pas\s+r[ée]glement[ée]|non\s+r[ée]glement[ée]|pas\s+de\s+r[èe]gle|sans\s+objet/i;

/**
 * R4 (A1-ter) — objet de la distance, lu dans la proposition qui porte la valeur
 * (bornée par « . », « ; », « , ») : axe de la voie / chaussée, berges / cours d'eau /
 * rive, ou autre référence (voie ferrée, autoroute, route classée « loi Barnier »,
 * construction principale…). null = alignement, voie ou emprise publique (ou aucun objet).
 */
export function objetDistance(texte: string, debut: number, fin: number): "axe" | "berges" | "autre" | null {
  const bornes = [". ", "; ", ", "];
  const a = Math.max(...bornes.map((x) => texte.lastIndexOf(x, debut)));
  const bs = bornes.map((x) => texte.indexOf(x, fin)).filter((x) => x >= 0);
  const p = texte.slice(a < 0 ? 0 : a, bs.length ? Math.min(...bs) : texte.length);
  if (/\baxes?\b/i.test(p)) return "axe";
  if (/\bberges?\b|cours\s+d['’]eau|\brives?\b|\bru(?:isseau|isseaux)\b|\bfossés?\b/i.test(p)) return "berges";
  if (/voies?\s+ferr[ée]es?|\bautoroutes?\b|routes?\s+(?:class[ée]es?|express|nationales?|départementales?|à\s+grande\s+circulation)|\bL\.?\s*111-6\b|construction\s+principale|\blisières?\b|\bboisements?\b/i.test(p)) return "autre";
  return null;
}

/** R3 (A1-bis) — la phrase qui contient [debut, fin[ déclare-t-elle la règle « non réglementée » ? */
export function phraseNonReglementee(texte: string, debut: number, fin: number): boolean {
  const a = Math.max(texte.lastIndexOf(". ", debut), texte.lastIndexOf("; ", debut));
  const bs = [texte.indexOf(". ", fin), texte.indexOf("; ", fin)].filter((x) => x >= 0);
  const b = bs.length ? Math.min(...bs) : texte.length;
  return NON_REGLEMENTE.test(texte.slice(a < 0 ? 0 : a, b));
}

/** Premier motif qui correspond (ordre = priorité), positions relatives au texte de l'article. */
function premier(texteArticle: string, motifs: readonly RegExp[]): Trouvaille | null {
  for (const re of motifs) {
    const rd = new RegExp(re.source, re.flags.replace("g", "") + (re.flags.includes("d") ? "" : "d"));
    const m = rd.exec(texteArticle) as (RegExpExecArray & { indices?: Array<[number, number] | undefined> }) | null;
    if (m && typeof m.index === "number") {
      const g = m.indices?.[1];
      return { valeur: nombreFrancais(m[1]), debut: m.index, fin: m.index + m[0].length, vDebut: g ? g[0] : undefined, vFin: g ? g[1] : undefined };
    }
  }
  return null;
}

// R2 (A5) : « moitié de la différence d'altitude / de niveau / de hauteur », « L ≥ H/2 », « D = H/2 », « (H-3)/2 »…
const H_SUR_2 = /\bH\s*\/\s*2\b|\bH\s*÷\s*2\b|moiti[ée]\s+de\s+(?:la\s+)?(?:leur\s+|sa\s+)?hauteur|moiti[ée]\s+de\s+(?:la\s+)?diff[ée]rence\s+(?:d['’]altitude|de\s+niveau|de\s+hauteur|des\s+niveaux)|\b[LD]\s*(?:=|≥|>=|>)\s*\(?\s*H\b|\(\s*H\s*[-−–]\s*\d+(?:[.,]\d+)?\s*(?:m\s*)?\)\s*\/\s*2/i;
const ALIGNEMENT = /(?:à|a)\s+l['’]alignement/i;

/** Type de règle d'un retrait, lu dans une fenêtre de ±200 caractères autour de la valeur. */
export function typeRegleRetrait(texteArticle: string, t: Trouvaille | null): string | null {
  const fen = t ? texteArticle.slice(Math.max(0, t.debut - 200), Math.min(texteArticle.length, t.fin + 200)) : texteArticle;
  if (H_SUR_2.test(fen)) return t && t.valeur !== null ? "H_OVER_2_MIN" : "H_OVER_2";
  if (t && t.valeur !== null && ALIGNEMENT.test(fen) && /\bou\b/i.test(fen)) return "ALIGNEMENT_OU_RETRAIT";
  return t && t.valeur !== null ? "FIXED" : null;
}

export const MOTIFS: Readonly<Record<string, readonly RegExp[]>> = {
  // art. 6 — les 4 premiers motifs sont ceux de la version 3.1.0, dans le même ordre.
  voirie: [
    /distance\s+minimale\s+de\s+(\d+(?:[.,]\d+)?)/i,
    /(\d+(?:[.,]\d+)?)\s*m\s+de\s+l['’]alignement/i,
    /minimum\s+de\s+(\d+(?:[.,]\d+)?)\s*m/i,
    /recul\s+minimum\s+de\s+(\d+(?:[.,]\d+)?)/i,
    // L2 : « en retrait de 5 m minimum »
    /(?:retrait|recul)\s+(?:minimum\s+|minimal\s+)?(?:d['’]au\s+moins\s+|de\s+)(\d+(?:[.,]\d+)?)\s*m(?:[èe]tres?)?\b/i,
    // R3 (A1-bis) : le nombre doit qualifier le recul LUI-MÊME (« implantées en retrait de N m »,
    // « à une distance au moins égale à N m ») ; un mot de recul ailleurs dans la phrase ne suffit pas
    // (« l'implantation… largeur de 4 m minimum » → null).
    /(?:retrait|recul)\s+(?:minimum\s+|minimal\s+)?par\s+rapport\s+(?:aux?|à\s+l['’]|à\s+la)\s*[\wÀ-ÿ'’]+(?:\s+[\wÀ-ÿ'’]+){0,3}?\s+(?:de\s+|d['’]au\s+moins\s+)(\d+(?:[.,]\d+)?)\s*m(?:[èe]tres?)?\b/i,
    /(?:implant[ée]e?s?|édifi[ée]e?s?|construites?|situ[ée]e?s?)\s+(?:en\s+retrait|à\s+une\s+distance)\s+(?:minimale\s+)?(?:d['’]au\s+moins\s+|de\s+|au\s+moins\s+égale\s+à\s+|égale\s+au\s+moins\s+à\s+)?(\d+(?:[.,]\d+)?)\s*m(?:[èe]tres?)?\b/i,
  ],
  // art. 7 — motifs de la version 3.1.0.
  separatives: [
    /au\s+moins\s+(\d+(?:[.,]\d+)?)\s*m/i,
    /(\d+(?:[.,]\d+)?)\s*m\s+de\s+celle-ci/i,
    /minimum\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*m/i,
    /distance\s+minimale\s+de\s+(\d+(?:[.,]\d+)?)\s*m/i,
  ],
  emprise: [/(\d+(?:[.,]\d+)?)\s*%/i],
  egout: [
    /(\d+(?:[,\.]\d+)?)\s*m[èe]?t?r?e?s?\.?\s*à\s+l['’]égout/i,
    /excéder\s+(\d+(?:[,\.]\d+)?)\s*m[èe]?t?r?e?s?/i,
    /hauteur\s+max(?:imale)?\s+de\s+(\d+(?:[,\.]\d+)?)\s*m/i,
  ],
  // L2 : « 12 mètres au faîtage » (la 3.1.0 n'acceptait que « 12 m au faîtage »)
  faitage: [
    /(\d+(?:[,\.]\d+)?)\s*m(?:[èe]tres?)?\.?\s*(?:au\s+)?fa[îi]tage/i,
    // R2 (A4) : nombre dans la MÊME phrase que « faîtage », 80 caractères au plus
    // (la 3.1.0 prenait n'importe quel nombre suivant, ex. « clôtures de 2 m »).
    /fa[îi]tage[^.;]{0,80}?(\d+(?:[,\.]\d+)?)\s*m\b/i,
  ],
  stationnement: [
    /minimum\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s+places?\s+par\s+logement/i,
    /(\d+(?:[.,]\d+)?)\s+places?\s+par\s+logement/i,
    /(\d+(?:[.,]\d+)?)\s+place[s]?\/logt/i,
    /(\d+(?:[.,]\d+)?)\s+place[s]?\s+par\s+logt/i,
  ],
};

/** Ruleset produit (même forme que la 3.1.0, plus `regle` sur les retraits). */
export interface RulesetProv {
  reculs: {
    voirie: { min_m: number | null; note: string | null; regle?: string | null; reference?: "axe" | "berges" | "autre"; statut?: "conditionnel" };
    limites_separatives: { min_m: number | null; note: string | null; regle?: string | null };
  };
  hauteur: { hauteur_max_m: number | null; hauteur_egout_m: number | null; hauteur_faitage_m: number | null; note: string | null };
  emprise_sol: { emprise_sol_max: number | null; note: string | null };
  stationnement: { places_par_logement: number | null; note: string | null };
  pleine_terre: { min_pct: number | null; note: string | null };
  densite: { cos_max: number | null; note: string | null };
}

export function rulesetVide(): RulesetProv {
  return {
    reculs: {
      voirie: { min_m: null, note: null, regle: null },
      limites_separatives: { min_m: null, note: null, regle: null },
    },
    hauteur: { hauteur_max_m: null, hauteur_egout_m: null, hauteur_faitage_m: null, note: null },
    emprise_sol: { emprise_sol_max: null, note: null },
    stationnement: { places_par_logement: null, note: null },
    pleine_terre: { min_pct: null, note: null },
    densite: { cos_max: null, note: null },
  };
}

/** Confiance heuristique d'une valeur lue par expression régulière. */
export function confianceRegex(repere: RepereArticle | null, regle: string | null, champ: string): number {
  let c = repere ? (repere.zoneQualifie ? 0.7 : 0.4) : 0;
  if (regle && regle !== "FIXED") c -= 0.1;
  if (champ === "densite.cos_max") c -= 0.2;
  return Math.max(0, Math.round(c * 100) / 100);
}

interface CtxExtraction {
  text: string;
  reperes: Record<number, RepereArticle>;
  debutsPages: number[] | null;
}

function provenanceArticle(ctx: CtxExtraction, champ: string, n: number, t: Trouvaille | null, valeur: number | null, regle: string | null): ProvenanceValeur {
  const rep = ctx.reperes[n] ?? null;
  const b = bornesArticle(ctx.text, ctx.reperes, n);
  const base = {
    champ,
    valeur,
    regle,
    article: String(n),
    article_intitule: rep ? rep.intitule : null,
    article_zone_qualifie: rep ? rep.zoneQualifie : false,
    article_zone: rep ? rep.zone : null,
    methode: "regex" as MethodeExtraction,
  };
  if (!rep) return { ...base, extrait: null, page: null, confiance: 0, motif: "article-introuvable" };
  if (!b) return { ...base, extrait: null, page: null, confiance: 0, motif: "bornes-incoherentes" };
  if (!t) {
    // article trouvé mais valeur non lue : on donne le début de l'article pour relecture humaine
    const fin = Math.min(b.fin, b.debut + EXTRAIT_MAX);
    const motif = regle === "H_OVER_2" ? "regle-non-chiffree" : "valeur-non-trouvee";
    return { ...base, extrait: ctx.text.slice(b.debut, fin).trim(), page: pageAOffset(ctx.debutsPages, b.debut), confiance: 0, motif };
  }
  // R2 (A4) : extrait centré sur le nombre lu (toute la phrase si elle tient)
  const long = t.fin - t.debut > 300 && t.vDebut !== undefined && t.vFin !== undefined;
  const d = b.debut + (long ? (t.vDebut as number) : t.debut);
  const f = b.debut + (long ? (t.vFin as number) : t.fin);
  return {
    ...base,
    // R3 (A17) : extrait borné au texte de l'article courant
    extrait: extraitBorne(ctx.text.slice(b.debut, b.fin), d - b.debut, f - b.debut),
    page: pageAOffset(ctx.debutsPages, d),
    confiance: valeur === null ? 0 : confianceRegex(rep, regle, champ),
    motif: valeur === null && regle === "H_OVER_2" ? "regle-non-chiffree" : null,
  };
}

/**
 * Extraction des articles 6, 7, 9, 10, 12, 13 et 14 AVEC provenance par valeur.
 * Valeurs identiques à la 3.1.0, sauf trois corrections L2 : « en retrait de
 * 5 m minimum » (art. 6), H/2 détecté (type H_OVER_2_MIN au lieu d'un retrait
 * fixe) et « 12 mètres au faîtage ».
 */
export function extraireAvecProvenance(text: string, zoneCode: string, debutsPages: number[] | null): {
  ruleset: RulesetProv;
  provenance: Record<string, ProvenanceValeur>;
  reperes: Record<number, RepereArticle>;
} {
  const reperes = reperesArticles(text, zoneCode);
  const ctx: CtxExtraction = { text, reperes, debutsPages };
  const rs = rulesetVide();
  const prov: Record<string, ProvenanceValeur> = {};
  const art = (n: number): string | null => {
    const b = bornesArticle(text, reperes, n);
    return b ? text.substring(b.debut, b.fin) : null;
  };

  // Article 6 — voirie
  const a6 = art(6);
  {
    let t = a6 ? premier(a6, MOTIFS.voirie) : null;
    if (t && a6 && phraseNonReglementee(a6, t.debut, t.fin)) t = null; // R3 : « non réglementé » → null
    const v = t ? t.valeur : null;
    // R4 (A1-ter) : distance mesurée depuis l'axe, les berges, une voie ferrée… → recul CONDITIONNEL
    const objet = t && a6 && v !== null ? objetDistance(a6, t.debut, t.fin) : null;
    const regle = objet ? "CONDITIONNEL" : a6 ? typeRegleRetrait(a6, t) : null;
    if (v !== null) rs.reculs.voirie.min_m = v;
    rs.reculs.voirie.regle = regle;
    if (objet) {
      rs.reculs.voirie.reference = objet;
      rs.reculs.voirie.statut = "conditionnel";
    }
    if (a6 && /à\s+l['’]alignement/i.test(a6)) rs.reculs.voirie.note = "Alignement ou recul";
    const pv6 = provenanceArticle(ctx, "reculs.voirie.min_m", 6, t, v, regle);
    prov["reculs.voirie.min_m"] = objet ? { ...pv6, statut: "conditionnel", reference: objet } : pv6;
  }

  // Article 7 — limites séparatives
  const a7 = art(7);
  {
    let t = a7 ? premier(a7, MOTIFS.separatives) : null;
    if (t && a7 && phraseNonReglementee(a7, t.debut, t.fin)) t = null; // R3 : « non réglementé » → null
    const v = t ? t.valeur : null;
    if (!t && a7) {
      const h = H_SUR_2.exec(a7);
      if (h) t = { valeur: null, debut: h.index, fin: h.index + h[0].length };
    }
    const regle = a7 ? typeRegleRetrait(a7, t) : null;
    if (v !== null) rs.reculs.limites_separatives.min_m = v;
    rs.reculs.limites_separatives.regle = regle;
    if (a7 && (/sur\s+les?\s+limites?/i.test(a7) || /en\s+limite/i.test(a7))) {
      rs.reculs.limites_separatives.note = "Implantation en limite autorisée";
    }
    prov["reculs.limites_separatives.min_m"] = provenanceArticle(ctx, "reculs.limites_separatives.min_m", 7, t, v, regle);
  }

  // Article 9 — emprise au sol
  const a9 = art(9);
  {
    let t: Trouvaille | null = null;
    let ratio: number | null = null;
    if (a9 && (/pas\s+fix/i.test(a9) || /sans\s+objet/i.test(a9) || /il\s+n['’]est\s+pas/i.test(a9))) {
      rs.emprise_sol.note = "Pas de règle";
    } else if (a9) {
      t = premier(a9, MOTIFS.emprise);
      if (t && t.valeur !== null) ratio = t.valeur / 100;
      if (ratio !== null) rs.emprise_sol.emprise_sol_max = ratio;
    }
    prov["emprise_sol.emprise_sol_max"] = provenanceArticle(ctx, "emprise_sol.emprise_sol_max", 9, t, ratio, null);
  }

  // Article 10 — hauteur (égout / faîtage)
  const a10 = art(10);
  {
    const te = a10 ? premier(a10, MOTIFS.egout) : null;
    const tf = a10 ? premier(a10, MOTIFS.faitage) : null;
    const egout = te ? te.valeur : null;
    const faitage = tf ? tf.valeur : null;
    if (egout !== null) {
      rs.hauteur.hauteur_egout_m = egout;
      rs.hauteur.hauteur_max_m = egout;
    }
    if (faitage !== null) rs.hauteur.hauteur_faitage_m = faitage;
    if (egout !== null && faitage !== null) rs.hauteur.note = `${egout}m égout, ${faitage}m faîtage`;
    const pe = provenanceArticle(ctx, "hauteur.hauteur_egout_m", 10, te, egout, null);
    prov["hauteur.hauteur_egout_m"] = pe;
    prov["hauteur.hauteur_max_m"] = { ...pe, champ: "hauteur.hauteur_max_m" };
    prov["hauteur.hauteur_faitage_m"] = provenanceArticle(ctx, "hauteur.hauteur_faitage_m", 10, tf, faitage, null);
  }

  // Article 12 — stationnement
  const a12 = art(12);
  {
    const t = a12 ? premier(a12, MOTIFS.stationnement) : null;
    const v = t ? t.valeur : null;
    if (v !== null) rs.stationnement.places_par_logement = v;
    prov["stationnement.places_par_logement"] = provenanceArticle(ctx, "stationnement.places_par_logement", 12, t, v, null);
  }

  // Article 13 — pleine terre (premier pourcentage ≥ 10)
  const a13 = art(13);
  {
    let t: Trouvaille | null = null;
    if (a13) {
      const re = /(\d+(?:[.,]\d+)?)\s*%/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(a13)) !== null) {
        const v = nombreFrancais(m[1]);
        if (typeof v === "number" && v >= 10) {
          t = { valeur: v, debut: m.index, fin: m.index + m[0].length };
          break;
        }
      }
    }
    const v = t ? t.valeur : null;
    if (v !== null) rs.pleine_terre.min_pct = v;
    prov["pleine_terre.min_pct"] = provenanceArticle(ctx, "pleine_terre.min_pct", 13, t, v, null);
  }

  // Article 14 — COS
  const a14 = art(14);
  {
    let t: Trouvaille | null = null;
    let v: number | null = null;
    if (a14 && (/sans\s+objet/i.test(a14) || /pas\s+fix/i.test(a14))) {
      rs.densite.note = "Pas de COS";
    } else if (a14) {
      const m = /(\d+(?:[,\.]\d+)?)/.exec(a14);
      if (m) {
        const n = nombreFrancais(m[1]);
        if (n !== null && n <= 5) {
          v = n;
          t = { valeur: n, debut: m.index, fin: m.index + m[0].length };
        }
      }
    }
    if (v !== null) rs.densite.cos_max = v;
    prov["densite.cos_max"] = provenanceArticle(ctx, "densite.cos_max", 14, t, v, null);
  }

  return { ruleset: rs, provenance: prov, reperes };
}

/** Motif littéral d'un nombre (« 5 », « 5,0 », « 2,5 » / « 2.5 »). */
function motifNombre(v: number): string {
  if (Number.isInteger(v)) return `(?<![\\d.,])${v}(?:[.,]0+)?(?![\\d])`;
  const [e, d] = String(v).split(".");
  return `(?<![\\d.,])${e}[.,]${d}(?![\\d])`;
}

/** Où le texte contient-il littéralement la valeur (avec son unité) ? Champ → unité attendue. */
export function localiserValeur(texte: string, champ: string, valeur: number): { debut: number; fin: number } | null {
  let motif: string;
  if (champ === "emprise_sol.emprise_sol_max") motif = `${motifNombre(Math.round(valeur * 10000) / 100)}\\s*%`;
  else if (champ === "pleine_terre.min_pct") motif = `${motifNombre(valeur)}\\s*%`;
  else if (champ === "stationnement.places_par_logement") motif = `${motifNombre(valeur)}\\s*places?`;
  else if (champ === "densite.cos_max") motif = motifNombre(valeur);
  else motif = `${motifNombre(valeur)}\\s*m(?![²2])`;
  const m = new RegExp(motif, "i").exec(texte);
  return m ? { debut: m.index, fin: m.index + m[0].length } : null;
}

const ARTICLE_DU_CHAMP: Readonly<Record<string, number>> = {
  "reculs.voirie.min_m": 6,
  "reculs.limites_separatives.min_m": 7,
  "emprise_sol.emprise_sol_max": 9,
  "hauteur.hauteur_egout_m": 10,
  "hauteur.hauteur_max_m": 10,
  "hauteur.hauteur_faitage_m": 10,
  "stationnement.places_par_logement": 12,
  "pleine_terre.min_pct": 13,
  "densite.cos_max": 14,
};

/**
 * Provenance d'une valeur venue du repli IA (le modèle a lu les 18 000
 * premiers caractères) : on cherche la valeur littérale d'abord dans
 * l'article attendu, puis dans le texte lu par l'IA. Introuvable → extrait
 * null, confiance 0,1, motif « valeur-ia-non-retrouvee ».
 */
export function provenanceValeurIA(text: string, reperes: Record<number, RepereArticle>, debutsPages: number[] | null, champ: string, valeur: number, lu: number = 18000): ProvenanceValeur {
  const n = ARTICLE_DU_CHAMP[champ] ?? null;
  const rep = n !== null ? (reperes[n] ?? null) : null;
  const b = n !== null ? bornesArticle(text, reperes, n) : null;
  const base = { champ, valeur, regle: null, methode: "llm" as MethodeExtraction };
  if (b && rep) {
    const loc = localiserValeur(text.substring(b.debut, b.fin), champ, valeur);
    if (loc) {
      const d = b.debut + loc.debut;
      return { ...base, article: String(n), article_intitule: rep.intitule, article_zone_qualifie: rep.zoneQualifie, article_zone: rep.zone, extrait: extraitBorne(text.slice(b.debut, b.fin), loc.debut, loc.fin), page: pageAOffset(debutsPages, d), confiance: 0.35, motif: null };
    }
  }
  const loc = localiserValeur(text.slice(0, lu), champ, valeur);
  if (loc) {
    return { ...base, article: null, article_intitule: null, article_zone_qualifie: false, article_zone: null, extrait: extraitBorne(text, loc.debut, loc.fin), page: pageAOffset(debutsPages, loc.debut), confiance: 0.2, motif: null };
  }
  return { ...base, article: null, article_intitule: null, article_zone_qualifie: false, article_zone: null, extrait: null, page: null, confiance: 0.1, motif: "valeur-ia-non-retrouvee" };
}

/** Date ISO (AAAA-MM-JJ) depuis « AAAAMMJJ », « AAAA-MM-JJ » ou « JJ/MM/AAAA » ; null sinon. */
export function dateIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (!m) {
    const f = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
    if (f) m = [f[0], f[3], f[2], f[1]] as unknown as RegExpExecArray;
  }
  if (!m) return null;
  const a = Number(m[1]);
  const mo = Number(m[2]);
  const j = Number(m[3]);
  if (a < 1900 || a > 2100 || mo < 1 || mo > 12 || j < 1 || j > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Date d'approbation codée dans l'idurba GPU (« 64065_PLU_20230615 » → 2023-06-15). */
export function dateDepuisIdurba(idurba: string | null | undefined): string | null {
  if (typeof idurba !== "string") return null;
  const m = /_(\d{8})(?:_|$)/.exec(idurba.trim());
  return m ? dateIso(m[1]) : null;
}

function nomFichier(v: string | null | undefined): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const base = v.trim().split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.pdf$/i, "").replace(/[^a-z0-9]+/g, "") || null;
}

/** Zone GPU retenue : celle dont le libellé égale la zone analysée, sinon la première. */
export function zoneUrbaRetenue(features: unknown, zoneCode: string): Record<string, unknown> | null {
  if (!Array.isArray(features) || features.length === 0) return null;
  const props = features
    .map((f) => (f && typeof f === "object" ? ((f as Record<string, unknown>).properties as Record<string, unknown> | undefined) : undefined))
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object");
  if (props.length === 0) return null;
  const z = zoneCode.trim().toUpperCase();
  return props.find((p) => typeof p.libelle === "string" && p.libelle.trim().toUpperCase() === z) ?? props[0];
}

const chaine = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function construireDocument(input: {
  empreinteSha256: string | null;
  intitule: string | null;
  communeInsee: string | null;
  communeNom: string | null;
  pdfFilename: string | null;
  zoneUrba: Record<string, unknown> | null;
  gpu: "interroge" | "indisponible" | "non-interroge";
  pages: number | null;
}): DocumentPlu {
  const zu = input.zoneUrba;
  const idurba = zu ? chaine(zu.idurba) : null;
  const nomfic = zu ? chaine(zu.nomfic) : null;
  const a = nomFichier(input.pdfFilename);
  const b = nomFichier(nomfic);
  const correspondance: DocumentPlu["correspondance_gpu"] =
    input.gpu === "non-interroge" ? "gpu-non-interroge" : input.gpu === "indisponible" ? "gpu-indisponible" : !zu ? "gpu-aucun-document" : a && b && a === b ? "nom-fichier-identique" : "non-verifiee";
  return {
    id: input.empreinteSha256 ? `plu-txt-${input.empreinteSha256.slice(0, 16)}` : null,
    intitule: chaine(input.intitule) ?? chaine(input.pdfFilename),
    commune_insee: chaine(input.communeInsee),
    commune_nom: chaine(input.communeNom),
    idurba,
    datvalid: zu ? dateIso(zu.datvalid) : null,
    date_approbation: dateDepuisIdurba(idurba),
    nomfic,
    correspondance_gpu: correspondance,
    empreinte_sha256: input.empreinteSha256,
    pages: input.pages,
  };
}

/**
 * R2 (A13) — type de règle d'un retrait après fusion regex + IA, même traitement
 * pour voirie et séparatives : valeur regex → règle regex ; valeur venue de l'IA →
 * null, sauf si le texte a révélé une règle H/2 (gardée en H_OVER_2_MIN).
 */
export function regleApresFusion(minRegex: number | null | undefined, regleRegex: string | null | undefined, minFusion: number | null | undefined): string | null {
  if (minRegex != null) return regleRegex ?? null;
  if (minFusion == null) return regleRegex ?? null;
  return regleRegex && /^H_OVER_2/.test(regleRegex) ? "H_OVER_2_MIN" : null;
}

/** Débuts de pages dans `"\n\n" + p1 + "\n\n" + p2 …` (forme du texte rendu par pdf-parse 1.1.1). */
export function debutsPagesPdfParse(pages: readonly string[]): number[] {
  const out: number[] = [];
  let pos = 0;
  for (const p of pages) {
    pos += 2;
    out.push(pos);
    pos += p.length;
  }
  return out;
}
// <<< L2-PROVENANCE-PURE (fin)
