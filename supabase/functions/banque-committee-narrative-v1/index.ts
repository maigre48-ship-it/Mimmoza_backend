// supabase/functions/banque-committee-narrative-v1/index.ts
// Deno / Supabase Edge Function
// Génère une NOTE DE PRESENTATION COMITE (banque) via Anthropic, sans hallucination,
// avec hashing + traçabilité + parsing JSON robuste.
//
// ✅ CORS origin "*" for dev (TODO: restrict in production).
// ✅ Robust Claude JSON parsing (tolerates code fences / leading text, extracts first JSON object).
// ✅ Report compaction to avoid oversized payloads.
// ✅ Prompt v2: presentation committee plan (not a summary) + strict separation borrower vs project address.
// ✅ Returns narrativeStructured + narrative (compat string).
// ✅ FIX v2.0.1: INSEE data safety (normalize income median €/UC + year, guard rails + dataQuality flag).
// ✅ FIX v2.0.1: Remove duplicate PROMPT_VERSION declaration.
// ✅ FIX v2.0.2: Robust model resolution + invalid env alias fallback.

const PROMPT_VERSION = "banque_presentation_comite_v2.0.2";

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type AnyObj = Record<string, any>;

// ✅ CORS — wildcard for dev. En prod, remplace par une whitelist stricte.
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function requireEnv(name: string) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Canonical JSON: stable keys order (important for hashing / caching)
function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: AnyObj = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ────────────────────────────────────────────────────────────────
// DATA SAFETY HELPERS (INSEE)
// ────────────────────────────────────────────────────────────────

function coerceNumber(v: any): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isPlausibleIncomeEurUc(v: number): boolean {
  // garde-fou: évite mensualisation ou valeurs aberrantes imprimées
  return v >= 5_000 && v <= 200_000;
}

/**
 * Normalise l'INSEE vers une forme stable:
 * - incomeMedianUcEur (€/UC)
 * - incomeMedianUcYear
 *
 * Si une valeur est suspecte, on met à null et on remonte un warning.
 */
function normalizeInsee(insee: AnyObj | null | undefined) {
  if (!insee || typeof insee !== "object") {
    return { inseeNormalized: insee ?? null, warnings: [] as string[] };
  }

  const src = { ...insee };

  const rawIncome =
    src.incomeMedianUcEur ??
    src.income_median_uc_eur ??
    src.niveauVieMedian ??
    src.niveau_vie_median ??
    src.niveau_vie_median_uc ??
    src.revenu_disponible_median_uc ??
    src.revenuMedian ??
    src.revenu_median ??
    src.medianIncome ??
    null;

  const rawYear =
    src.incomeMedianUcYear ??
    src.incomeYear ??
    src.year ??
    src.annee ??
    src.millesime ??
    null;

  const warnings: string[] = [];
  const n = coerceNumber(rawIncome);

  if (n != null && isPlausibleIncomeEurUc(n)) {
    src.incomeMedianUcEur = n;
    if (rawYear != null) src.incomeMedianUcYear = rawYear;
  } else {
    if (rawIncome != null) {
      warnings.push(
        `INSEE revenu médian suspect (${String(rawIncome)}). Masqué (incomeMedianUcEur=null) en attente de correction source.`
      );
    } else {
      warnings.push("INSEE revenu médian absent (incomeMedianUcEur=null).");
    }
    src.incomeMedianUcEur = null;
    if (rawYear != null) src.incomeMedianUcYear = rawYear;
  }

  return { inseeNormalized: src, warnings };
}

// ────────────────────────────────────────────────────────────────
// REPORT COMPACTION
// ────────────────────────────────────────────────────────────────

function compactReport(report: AnyObj): AnyObj {
  const smart = report?.smartscore ?? null;
  const ms = report?.marketStudy ?? null;
  const dvf = ms?.dvf ?? null;

  const { inseeNormalized, warnings: inseeWarnings } = normalizeInsee(ms?.insee);

  const topTx = Array.isArray(dvf?.topTransactions)
    ? dvf.topTransactions.slice(0, 5)
    : [];

  const insights = Array.isArray(ms?.insights) ? ms.insights.slice(0, 8) : [];
  const bpeTop = Array.isArray(ms?.bpe?.topProches)
    ? ms.bpe.topProches.slice(0, 5)
    : [];

  const riskItems = Array.isArray(report?.risques?.items)
    ? report.risques.items.slice(0, 12)
    : report?.risques?.items ?? [];

  const missing = Array.isArray(report?.missing)
    ? report.missing.slice(0, 25)
    : [];

  return {
    meta: report?.meta ?? null,
    generatedAt: report?.generatedAt ?? null,
    profile: report?.profile ?? null,

    emprunteur: report?.emprunteur ?? null,
    projet: report?.projet ?? null,
    budget: report?.budget ?? null,
    financement: report?.financement ?? null,
    revenus: report?.revenus ?? null,
    kpis: report?.kpis ?? null,

    smartscore: smart
      ? {
          score: smart.score ?? null,
          grade: smart.grade ?? null,
          verdict: smart.verdict ?? null,
          totalMissingPenalty: smart.totalMissingPenalty ?? null,
          recommendations: Array.isArray(smart.recommendations)
            ? smart.recommendations.slice(0, 12)
            : [],
          pillars: Array.isArray(smart.pillars)
            ? smart.pillars.map((p: any) => ({
                key: p.key,
                label: p.label,
                points: p.points,
                maxPoints: p.maxPoints,
                rawScore: p.rawScore,
                hasData: p.hasData,
                reasons: Array.isArray(p.reasons) ? p.reasons.slice(0, 3) : [],
              }))
            : [],
        }
      : null,

    marketStudy: ms
      ? {
          scoreGlobal: ms.scoreGlobal ?? null,
          scoreLabel: ms.scoreLabel ?? null,
          dvf: dvf
            ? {
                medianPriceM2: dvf.medianPriceM2 ?? null,
                avgPriceM2: dvf.avgPriceM2 ?? null,
                transactionCount: dvf.transactionCount ?? null,
                evolutionPct: dvf.evolutionPct ?? null,
                periodStart: dvf.periodStart ?? null,
                periodEnd: dvf.periodEnd ?? null,
                topTransactions: topTx,
              }
            : null,
          insee: inseeNormalized ?? null,
          inseeWarnings: inseeWarnings.length ? inseeWarnings : [],
          bpe: ms.bpe
            ? {
                score: ms.bpe.score ?? null,
                totalEquipements: ms.bpe.totalEquipements ?? null,
                commerce: ms.bpe.commerce ?? null,
                sante: ms.bpe.sante ?? null,
                education: ms.bpe.education ?? null,
                services: ms.bpe.services ?? null,
                topProches: bpeTop,
              }
            : null,
          transport: ms.transport ?? null,
          insights,
        }
      : null,

    risques: report?.risques
      ? {
          score: report.risques.score ?? null,
          globalLevel: report.risques.globalLevel ?? null,
          items: riskItems,
        }
      : null,

    missing,
    verdictExplanation: report?.verdictExplanation ?? null,
  };
}

// ────────────────────────────────────────────────────────────────
// PROMPT
// ────────────────────────────────────────────────────────────────

function buildPrompt(reportCompact: AnyObj) {
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `SYSTEM OVERRIDE — FORMAT STRICT

Tu dois répondre UNIQUEMENT par un objet JSON strict valide.
Aucun texte avant ou après.
Aucun commentaire.
Aucun bloc de code.
Si le format JSON n’est pas strict, la réponse sera rejetée.

CONTEXTE

Tu es analyste crédit senior dans une banque universelle.
Tu prépares une NOTE DE PRÉSENTATION COMITÉ (et non une synthèse).

L’objectif est de produire un document structuré, normé, exploitable en comité,
fondé exclusivement sur l’objet JSON nommé report_compact.

RÈGLES ABSOLUES

1) Tu utilises UNIQUEMENT les données présentes dans report_compact.
2) Aucune invention.
3) Si une donnée manque, écrire exactement :
   "Information non fournie dans les données analysées."
4) Ne jamais confondre :
   - l'adresse personnelle de l'emprunteur (report_compact.emprunteur.details.Adresse)
   - l'adresse du projet financé (report_compact.projet.Adresse)
5) Toute analyse géographique du bien doit provenir exclusivement de report_compact.projet.
6) La décision recommandée DOIT être strictement égale à :
   report_compact.smartscore.verdict
7) Ton : professionnel, prudentiel, analytique, sans emphase.

FORMAT DE SORTIE — JSON STRICT

{
  "ficheDossier": {
    "emprunteur": "...",
    "profilEmprunteur": "...",
    "projet": "...",
    "localisationProjet": "...",
    "montantOperation": "...",
    "structureFinancement": "...",
    "garanties": "..."
  },

  "analyseCredit": {
    "capaciteRemboursement": {
      "analyse": "...",
      "ratiosCites": ["..."],
      "niveauRisque": "Faible|Modéré|Elevé"
    },
    "structureFinanciere": {
      "analyse": "...",
      "pointsVigilance": ["..."]
    },
    "qualiteActif": {
      "analyse": "...",
      "liquidite": "...",
      "positionnementPrix": "..."
    },
    "analyseMarche": {
      "dynamiquePrix": "...",
      "environnementSocioDemo": "...",
      "equipements": "...",
      "transport": "..."
    },
    "risquesIdentifies": [
      {
        "intitule": "...",
        "impactCredit": "...",
        "mitigationProposee": "...",
        "sourceKeys": ["report_compact...."]
      }
    ]
  },

  "conformitePolitiqueBanque": {
    "ratiosVsSeuils": "...",
    "ecartsSignificatifs": ["..."],
    "elementsManquants": ["..."]
  },

  "conditions": {
    "conditionsPrecedentes": [
      "conditions suspensives avant accord"
    ],
    "conditionsSuivi": [
      "conditions post-accord / monitoring"
    ]
  },

  "decision": {
    "recommandation": "DOIT être identique à report_compact.smartscore.verdict",
    "motivation": "...",
    "niveauConfiance": "Haute|Moyenne|Faible"
  },

  "sourcesUsed": [
    "report_compact.kpis.LTV",
    "report_compact.marketStudy.dvf.medianPriceM2"
  ],

  "dataQuality": [
    {
      "incoherence": "...",
      "impact": "...",
      "action": "..."
    }
  ]
}

INSTRUCTIONS D’ANALYSE

- Chaque risque doit être lié à un impact crédit concret.
- Chaque risque doit proposer une mitigation réelle (garantie, condition, ajustement).
- Les ratios doivent être interprétés (pas seulement cités).
- Si un ratio est élevé, expliquer pourquoi c’est problématique.
- Si des données manquent, les mentionner explicitement dans "elementsManquants".
- Ne jamais produire de texte hors JSON.

RAPPEL FINAL :
Répondre uniquement par l’objet JSON strict.`,
        },
        {
          type: "text",
          text: `\n\n=== report_compact (JSON) ===\n${JSON.stringify(reportCompact)}`,
        },
      ],
    },
  ] as const;
}

// ────────────────────────────────────────────────────────────────
// MODEL RESOLUTION
// ────────────────────────────────────────────────────────────────

function normalizeAnthropicModel(rawModel?: string | null): string {
  const fallback = "claude-sonnet-4-6";
  if (!rawModel || !rawModel.trim()) return fallback;

  const model = rawModel.trim();

  // Compat / legacy aliases that may still exist in env by mistake
  const legacyMap: Record<string, string> = {
    "claude-3-5-sonnet-latest": "claude-sonnet-4-6",
    "claude-3.5-sonnet-latest": "claude-sonnet-4-6",
    "claude-3-5-sonnet": "claude-3-5-sonnet-20241022",
    "claude-3.5-sonnet": "claude-3-5-sonnet-20241022",
    latest: "claude-sonnet-4-6",
    sonnet: "claude-sonnet-4-6",
  };

  return legacyMap[model] ?? model;
}

// ────────────────────────────────────────────────────────────────
// Anthropic call
// ────────────────────────────────────────────────────────────────

async function callAnthropic(messages: any) {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");

  const configuredModel = Deno.env.get("ANTHROPIC_MODEL");
  const model = normalizeAnthropicModel(configuredModel);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1800,
      temperature: 0.2,
      messages,
    }),
  });

  const raw = await res.text();

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      raw,
      model,
      configuredModel: configuredModel ?? null,
    };
  }

  return {
    ok: true,
    status: 200,
    raw,
    model,
    configuredModel: configuredModel ?? null,
  };
}

function stripCodeFences(s: string): string {
  return s.replace(/```json/gi, "```").replace(/```/g, "").trim();
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function validateV2Schema(out: any) {
  if (!out || typeof out !== "object") throw new Error("Claude output JSON is not an object.");
  if (typeof out.ficheDossier !== "object") throw new Error("Claude output missing ficheDossier.");
  if (typeof out.analyseCredit !== "object") throw new Error("Claude output missing analyseCredit.");
  if (typeof out.conditions !== "object") throw new Error("Claude output missing conditions.");
  if (typeof out.decision !== "object") throw new Error("Claude output missing decision.");
  if (typeof out.decision?.recommandation !== "string") throw new Error("Claude output missing decision.recommandation.");
  if (!Array.isArray(out.sourcesUsed)) throw new Error("Claude output missing sourcesUsed array.");
  if (!Array.isArray(out.dataQuality)) throw new Error("Claude output missing dataQuality array.");
}

function safeParseClaudeJson(rawText: string) {
  let payload: any;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Error("Anthropic response is not valid JSON (transport).");
  }

  const blocks = payload?.content;
  let text = Array.isArray(blocks)
    ? blocks.map((b: any) => b?.text).filter(Boolean).join("\n")
    : "";

  if (!text) throw new Error("Empty Claude content.");

  text = stripCodeFences(text);

  try {
    const out = JSON.parse(text);
    validateV2Schema(out);
    return out;
  } catch {
    // fallback
  }

  const extracted = extractFirstJsonObject(text);
  if (!extracted) {
    const excerpt = text.slice(0, 500);
    throw new Error(`Claude output is not strict JSON. No JSON object found. Excerpt: ${excerpt}`);
  }

  let out: any;
  try {
    out = JSON.parse(extracted);
  } catch {
    const excerpt = extracted.slice(0, 500);
    throw new Error(`Claude output is not strict JSON. JSON extraction parse failed. Excerpt: ${excerpt}`);
  }

  validateV2Schema(out);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    const body = await req.json().catch(() => null);
    const report = body?.report;

    if (!report || typeof report !== "object") {
      return jsonResponse({ ok: false, error: "Missing 'report' object" }, 400);
    }

    const canonicalReport = canonicalize(report);
    const sourceHash = await sha256Hex(JSON.stringify(canonicalReport));
    const promptVersion = PROMPT_VERSION;

    const reportCompact = compactReport(canonicalReport);
    const messages = buildPrompt(reportCompact);

    const anthropic = await callAnthropic(messages);

    if (!anthropic.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "Anthropic API error",
          status: anthropic.status,
          detail: anthropic.raw.slice(0, 2000),
          promptVersion,
          sourceHash,
          model: anthropic.model,
          configuredModel: anthropic.configuredModel,
        },
        502
      );
    }

    const parsed = safeParseClaudeJson(anthropic.raw);
    const generatedAt = new Date().toISOString();

    const warnings: string[] = [];
    if (!parsed.sourcesUsed?.length) {
      warnings.push("sourcesUsed vide: traçabilité insuffisante.");
    }

    const inseeWarnings = reportCompact?.marketStudy?.inseeWarnings ?? [];
    if (Array.isArray(inseeWarnings) && inseeWarnings.length) {
      warnings.push(...inseeWarnings);
    }

    const shortNarrative = [
      parsed?.decision?.recommandation
        ? `Décision recommandée : ${String(parsed.decision.recommandation)}.`
        : "Décision recommandée : Information non fournie dans les données analysées.",
      parsed?.decision?.motivation
        ? String(parsed.decision.motivation)
        : "Information non fournie dans les données analysées.",
    ].join(" ");

    return jsonResponse({
      ok: true,
      narrative: shortNarrative,
      narrativeStructured: parsed,
      sourcesUsed: parsed.sourcesUsed ?? [],
      warnings,
      model: anthropic.model,
      promptVersion,
      sourceHash,
      generatedAt,
    });
  } catch (e) {
    return jsonResponse(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      500
    );
  }
});