// supabase/functions/plu-universal-parser/index.ts
// Version : plu-universal-parser-v2.1 — security hardening

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

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
      // Sans plafond explicite, la sortie n'était bornée que par le modèle. Le
      // résultat attendu est un objet JSON de règles d'urbanisme : 4 000 tokens
      // sont très larges, et l'API échoue proprement plutôt que de facturer une
      // génération partie en boucle.
      max_tokens: 4000,
      // Le prompt exige déjà du JSON ; on le fait garantir par l'API plutôt que
      // d'espérer, ce qui évite un JSON.parse en échec après un appel payé.
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    // Le statut et le corps étaient jetés : toute panne API remontait en
    // « INTERNAL_ERROR » opaque. Or `response_format: json_object` échoue en 400
    // si le mot « json » disparaît des prompts — un diagnostic impossible à
    // poser sans cette trace.
    const detail = await response.text().catch(() => "");
    console.error(
      `[plu-universal-parser] OpenAI ${response.status} : ${detail.slice(0, 400)}`,
    );
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

serve(avecGarde(async (req) => {
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

      // Le règlement entier partait au modèle sans aucune borne : un PLU de
      // plusieurs centaines de pages produisait un prompt d'entrée illimité,
      // facturé au caractère près et sans plafond possible. On tronque.
      //
      // 120 000 caractères ≈ 30 000 tokens : très large pour les articles d'une
      // zone, et les chunks sont déjà filtrés sur `zone_code`. La coupure est
      // ANNONCÉE au modèle pour qu'il ne complète pas de mémoire — une règle
      // d'urbanisme inventée vaut moins que l'absence de règle.
      const MAX_REGLEMENT_CHARS = 120_000;
      const texteComplet = chunks
        .map(
          (c: any) =>
            `[PAGE ${c.page_number} - ${c.section_label ?? ""}]\n${c.raw_text}`,
        )
        .join("\n\n");

      const tronque = texteComplet.length > MAX_REGLEMENT_CHARS;
      if (tronque) {
        console.warn(
          `[plu-universal-parser] règlement tronqué : ${texteComplet.length} → ${MAX_REGLEMENT_CHARS} caractères`,
        );
      }
      const texteReglement = tronque
        ? texteComplet.slice(0, MAX_REGLEMENT_CHARS) +
          "\n\n[TEXTE TRONQUÉ — la suite du règlement n'a pas été transmise. " +
          "Ne complète AUCUNE règle absente de ce qui précède : laisse le champ null.]"
        : texteComplet;

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
}));