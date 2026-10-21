import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

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

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

type OapType = "sectorielle" | "thematique";

type OapExtractResult = {
  has_oap: boolean;
  oap_name?: string | null;
  oap_type?: OapType | null;
  summary?: string | null;
  constraints?: {
    access?: string[];
    roads?: string[];
    green_spaces?: string[];
    pedestrian_links?: string[];
    social_housing?: string[];
    density?: string[];
    built_form?: string[];
    heights?: string[];
    parking?: string[];
    phasing?: string[];
    landscape?: string[];
    public_facilities?: string[];
  };
  promoter_impacts?: string[];
  permit_risks?: string[];
  source_url?: string | null;
  source_document?: string | null;
};

type OapParserPayload = {
  commune_insee?: string | null;
  commune_nom?: string | null;
  target_zone_code?: string | null;
  parcel_id?: string | null;
  address?: string | null;
  source_pdf_url?: string | null;
  plu_ruleset?: unknown;
  plu_raw?: unknown;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });
}

function normalizeString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function safeStringify(value: unknown, maxChars = 18_000): string {
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  } catch {
    return "";
  }
}

function emptyOapResult(sourceDocument?: string | null): OapExtractResult {
  return {
    has_oap: false,
    oap_name: null,
    oap_type: null,
    summary: null,
    constraints: {
      access: [],
      roads: [],
      green_spaces: [],
      pedestrian_links: [],
      social_housing: [],
      density: [],
      built_form: [],
      heights: [],
      parking: [],
      phasing: [],
      landscape: [],
      public_facilities: [],
    },
    promoter_impacts: [],
    permit_risks: [],
    source_url: null,
    source_document: sourceDocument ?? null,
  };
}

function extractJsonObject(text: string): unknown {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1));
    }
    throw new Error("Réponse IA non JSON.");
  }
}

function sanitizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeOapResult(raw: unknown): OapExtractResult {
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};

  const constraintsRaw =
    r.constraints && typeof r.constraints === "object"
      ? r.constraints as Record<string, unknown>
      : {};

  const hasOap = r.has_oap === true;

  return {
    has_oap: hasOap,
    oap_name: normalizeString(r.oap_name),
    oap_type: r.oap_type === "sectorielle" || r.oap_type === "thematique"
      ? r.oap_type
      : null,
    summary: normalizeString(r.summary),
    constraints: {
      access: sanitizeStringArray(constraintsRaw.access),
      roads: sanitizeStringArray(constraintsRaw.roads),
      green_spaces: sanitizeStringArray(constraintsRaw.green_spaces),
      pedestrian_links: sanitizeStringArray(constraintsRaw.pedestrian_links),
      social_housing: sanitizeStringArray(constraintsRaw.social_housing),
      density: sanitizeStringArray(constraintsRaw.density),
      built_form: sanitizeStringArray(constraintsRaw.built_form),
      heights: sanitizeStringArray(constraintsRaw.heights),
      parking: sanitizeStringArray(constraintsRaw.parking),
      phasing: sanitizeStringArray(constraintsRaw.phasing),
      landscape: sanitizeStringArray(constraintsRaw.landscape),
      public_facilities: sanitizeStringArray(constraintsRaw.public_facilities),
    },
    promoter_impacts: sanitizeStringArray(r.promoter_impacts),
    permit_risks: sanitizeStringArray(r.permit_risks),
    source_url: normalizeString(r.source_url),
    source_document: normalizeString(r.source_document),
  };
}

async function callOpenAI(payload: OapParserPayload): Promise<OapExtractResult> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return emptyOapResult("OPENAI_API_KEY manquante");
  }

  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4.1-mini";

  const context = {
    commune_insee: payload.commune_insee ?? null,
    commune_nom: payload.commune_nom ?? null,
    target_zone_code: payload.target_zone_code ?? null,
    parcel_id: payload.parcel_id ?? null,
    address: payload.address ?? null,
    source_pdf_url: payload.source_pdf_url ?? null,
    plu_ruleset: payload.plu_ruleset ?? null,
    plu_raw: payload.plu_raw ?? null,
  };

  const prompt = `
Tu es un moteur d'analyse urbanistique pour Mimmoza.

Objectif :
Déterminer si le contenu fourni mentionne une OAP — Orientation d'Aménagement et de Programmation — applicable à la zone ou parcelle analysée.

Tu dois répondre uniquement en JSON valide, sans markdown.

Schéma exact :
{
  "has_oap": boolean,
  "oap_name": string | null,
  "oap_type": "sectorielle" | "thematique" | null,
  "summary": string | null,
  "constraints": {
    "access": string[],
    "roads": string[],
    "green_spaces": string[],
    "pedestrian_links": string[],
    "social_housing": string[],
    "density": string[],
    "built_form": string[],
    "heights": string[],
    "parking": string[],
    "phasing": string[],
    "landscape": string[],
    "public_facilities": string[]
  },
  "promoter_impacts": string[],
  "permit_risks": string[],
  "source_url": string | null,
  "source_document": string | null
}

Règles :
- N'invente aucune OAP.
- Si aucune OAP n'est explicitement identifiable, retourne has_oap=false.
- Ne crée aucun score.
- Ne mélange pas les règles PLU dures avec l'OAP.
- Extrait seulement les contraintes qualitatives utiles à un promoteur.
- Si une OAP semble citée mais sans contenu suffisant, indique has_oap=true avec un résumé prudent.
- Réponds en français.

Données disponibles :
${safeStringify(context, 22_000)}
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Tu réponds uniquement en JSON valide conforme au schéma demandé.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const txt = await res.text();

  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${txt.slice(0, 500)}`);
  }

  const data = JSON.parse(txt);
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    throw new Error("Réponse OpenAI vide.");
  }

  return normalizeOapResult(extractJsonObject(content));
}

serve(avecGarde(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return json({
      success: true,
      status: "ok",
      function: "oap-parser",
      message: "OAP parser ready",
    });
  }

  if (req.method !== "POST") {
    return json({
      success: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Méthode non autorisée.",
    }, 405);
  }

  try {
    const payload = await req.json() as OapParserPayload;

    const communeInsee = normalizeString(payload.commune_insee);
    const zoneCode = normalizeString(payload.target_zone_code);

    if (!communeInsee) {
      return json({
        success: false,
        error: "MISSING_COMMUNE_INSEE",
        message: "commune_insee est requis.",
      }, 400);
    }

    if (!zoneCode) {
      return json({
        success: false,
        error: "MISSING_TARGET_ZONE_CODE",
        message: "target_zone_code est requis.",
      }, 400);
    }

    const result = await callOpenAI({
      ...payload,
      commune_insee: communeInsee,
      target_zone_code: zoneCode,
    });

    return json({
      success: true,
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue.";

    return json({
      success: false,
      error: "OAP_PARSE_ERROR",
      message,
    }, 500);
  }
}));