/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Body = {
  document_id?: string;
  commune_insee?: string;
  limit?: number;
};

type RegleType = "FIXED" | "H_OVER_2" | "H_OVER_2_MIN" | null;

type FacadeRule = {
  regle: RegleType;
  recul_min_m: number | null;
  min_m?: number | null;
  note?: string | null;
};

type PluRules = {
  implantation?: {
    recul_voirie_min_m?: number | null;
    recul_limite_separative_min_m?: number | null;
    recul_fond_parcelle_min_m?: number | null;
    implantation_en_limite_autorisee?: boolean | null;
    facades?: {
      avant?: FacadeRule;
      laterales?: FacadeRule;
      fond?: FacadeRule;
    };
  };
  emprise?: { ces_max_percent?: number | null };
  hauteur?: { hauteur_max_m?: number | null; hauteur_max_niveaux?: number | null };
  stationnement?: { places_par_logement?: number | null; places_par_100m2?: number | null };
  meta?: { notes?: string[]; engine_version?: string; ai_overlay?: boolean; ai_engine?: string | null };
};

type ZoneRowOut = {
  document_id: string;
  commune_insee: string;
  zone_code: string;
  zone_libelle: string | null;
  confidence_score: number | null;
  source: string | null;
  rules: PluRules;
  created_at: string;
};

type AiRow = {
  document_id: string;
  commune_insee: string;
  zone_code: string;
  engine: string;
  model: string | null;
  prompt_version: string | null;
  ruleset: any;
  completeness_ok: boolean;
  missing: string[];
  confidence_score: number | null;
  citations: any | null;
  diagnostics: any | null;
  error: string | null;
  created_at: string;
};

type ResolvedReculRow = {
  document_id: string;
  commune_insee: string | null;
  zone_code: string;
  zone_libelle: string | null;
  recul_voirie_min_m: number | string | null;
  recul_limites_separatives_min_m: number | string | null;
  recul_fond_parcelle_min_m: number | string | null;
  implantation_en_limite_autorisee: boolean | null;
  reculs_complets_ok: boolean | null;
  ai_confidence_score: number | null;
  ai_error: string | null;
  user_updated_at: string | null;
  ai_updated_at: string | null;
};

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim().replace(",", ".");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function pushNote(notes: string[], label: string, v: unknown) {
  const s = asString(v);
  if (s) notes.push(`${label}: ${s}`);
}

function boolOrNull(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "oui" || s === "1") return true;
    if (s === "false" || s === "non" || s === "0") return false;
  }
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
  }
  return null;
}

function isoNow(): string {
  return new Date().toISOString();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function mapRulesetToRules(ruleset: any, row: any): PluRules {
  const notes: string[] = [];

  pushNote(notes, "Reculs/alignements", ruleset?.reculs_alignements?.commentaire);
  pushNote(notes, "Stationnement", ruleset?.stationnement?.commentaire);
  pushNote(notes, "Emprise au sol", ruleset?.emprise_sol?.commentaire);
  pushNote(notes, "Hauteur", ruleset?.hauteur?.commentaire);
  pushNote(notes, "Densité", ruleset?.densite?.commentaire);
  pushNote(notes, "Autres règles", ruleset?.autres_regles?.commentaire);

  const articles = Array.isArray(ruleset?.articles_source) ? ruleset.articles_source : [];
  for (const a of articles) {
    if (typeof a === "string" && a.trim()) notes.push(`Source: ${a.trim()}`);
  }

  const reculVoirie = asNumber(row?.retrait_voirie_min_m);
  const reculLimSep = asNumber(row?.retrait_limites_separatives_min_m);
  const reculFond = asNumber(row?.retrait_fond_parcelle_min_m);

  const cesMaxPercent = asNumber(ruleset?.emprise_sol?.emprise_sol_max);
  const hauteurMax = asNumber(ruleset?.hauteur?.hauteur_max_m);
  const placesParLogement = asNumber(row?.places_par_logement);
  const facadeNote = asString(ruleset?.reculs_alignements?.commentaire) ?? null;

  return {
    implantation: {
      recul_voirie_min_m: reculVoirie,
      recul_limite_separative_min_m: reculLimSep,
      recul_fond_parcelle_min_m: reculFond,
      implantation_en_limite_autorisee: null,
      facades: {
        avant: facadeNote ? { regle: null, recul_min_m: null, note: facadeNote } : undefined,
        laterales: facadeNote ? { regle: null, recul_min_m: null, note: facadeNote } : undefined,
        fond: facadeNote ? { regle: null, recul_min_m: null, note: facadeNote } : undefined,
      },
    },
    emprise: { ces_max_percent: cesMaxPercent },
    hauteur: { hauteur_max_m: hauteurMax, hauteur_max_niveaux: null },
    stationnement: { places_par_logement: placesParLogement, places_par_100m2: null },
    meta: { notes, engine_version: "plu-rules-list-v1.mapped_from_plu_zones_rulesets.v2" },
  };
}

function mapAiRulesetToRules(aiRuleset: any): PluRules {
  const notes: string[] = [];
  const src = aiRuleset?.rules ?? aiRuleset ?? {};
  const zoneLibelle = asString(src?.zone_libelle ?? src?.zoneLibelle) ?? null;

  const reculs = src?.reculs ?? {};
  const voirieMin = asNumber(reculs?.voirie?.min_m ?? reculs?.voirie?.minM);
  const limSepMin = asNumber(reculs?.limites_separatives?.min_m ?? reculs?.limites_separatives?.minM);
  const fondMin = asNumber(reculs?.fond_parcelle?.min_m ?? reculs?.fond_parcelle?.minM);

  const implLim = boolOrNull(
    reculs?.implantation_en_limite?.autorisee ??
      reculs?.implantation_en_limite?.autorise ??
      reculs?.implantation_en_limite_autorisee
  );

  const emprise = src?.emprise_sol ?? src?.empriseSol ?? {};
  const cesMax = asNumber(emprise?.emprise_sol_max ?? emprise?.ces_max_ratio ?? emprise?.ces_max_percent);

  const hauteur = src?.hauteur ?? {};
  const hauteurMax = asNumber(hauteur?.hauteur_max_m ?? hauteur?.hauteurMaxM);

  const stationnement = src?.stationnement ?? {};
  const placesLog = asNumber(stationnement?.places_par_logement ?? stationnement?.placesParLogement);
  const places100 = asNumber(stationnement?.places_par_100m2 ?? stationnement?.placesPar100m2);

  if (asString(reculs?.voirie?.note)) notes.push(`Voirie: ${asString(reculs?.voirie?.note)}`);
  if (asString(reculs?.limites_separatives?.note))
    notes.push(`Limites séparatives: ${asString(reculs?.limites_separatives?.note)}`);
  if (asString(reculs?.fond_parcelle?.note)) notes.push(`Fond: ${asString(reculs?.fond_parcelle?.note)}`);
  if (asString(reculs?.implantation_en_limite?.note))
    notes.push(`Implantation en limite: ${asString(reculs?.implantation_en_limite?.note)}`);

  if (asString(hauteur?.note)) notes.push(`Hauteur: ${asString(hauteur?.note)}`);
  if (asString(emprise?.note)) notes.push(`Emprise: ${asString(emprise?.note)}`);
  if (asString(stationnement?.note)) notes.push(`Stationnement: ${asString(stationnement?.note)}`);

  const articles = Array.isArray(src?.articles_source) ? src.articles_source : [];
  for (const a of articles) {
    if (typeof a === "string" && a.trim()) notes.push(`Source: ${a.trim()}`);
  }

  if (zoneLibelle) notes.push(`Zone: ${zoneLibelle}`);

  return {
    implantation: {
      recul_voirie_min_m: voirieMin,
      recul_limite_separative_min_m: limSepMin,
      recul_fond_parcelle_min_m: fondMin,
      implantation_en_limite_autorisee: implLim,
      facades: {},
    },
    emprise: { ces_max_percent: cesMax },
    hauteur: { hauteur_max_m: hauteurMax, hauteur_max_niveaux: null },
    stationnement: { places_par_logement: placesLog, places_par_100m2: places100 },
    meta: {
      notes,
      engine_version: "plu-rules-list-v1.ai_overlay.v1",
    },
  };
}

function mapResolvedReculsRowToRules(r: ResolvedReculRow): PluRules {
  const notes: string[] = [];

  if (r.ai_error) notes.push("AI error");
  if (typeof r.ai_confidence_score === "number") notes.push(`AI confidence: ${r.ai_confidence_score}`);
  if (r.user_updated_at) notes.push("User override available");
  if (r.ai_updated_at) notes.push("AI overlay available");

  return {
    implantation: {
      recul_voirie_min_m: asNumber(r.recul_voirie_min_m),
      recul_limite_separative_min_m: asNumber(r.recul_limites_separatives_min_m),
      recul_fond_parcelle_min_m: asNumber(r.recul_fond_parcelle_min_m),
      implantation_en_limite_autorisee: r.implantation_en_limite_autorisee ?? null,
      facades: {},
    },
    emprise: { ces_max_percent: null },
    hauteur: { hauteur_max_m: null, hauteur_max_niveaux: null },
    stationnement: { places_par_logement: null, places_par_100m2: null },
    meta: {
      notes,
      engine_version: "plu-rules-list-v1.from_view_resolved_reculs_v3.v1",
    },
  };
}

function aiRulesetZoneLibelle(aiRuleset: any): string | null {
  const src = aiRuleset?.rules ?? aiRuleset ?? {};
  return asString(src?.zone_libelle ?? src?.zoneLibelle) ?? null;
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return json({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: "MISSING_ENV" }, 500);
  }

  try {
    let document_id: string | null = null;
    let commune_insee: string | null = null;
    let limit = 20;

    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Body;
      document_id = typeof body.document_id === "string" ? body.document_id : null;
      commune_insee = typeof body.commune_insee === "string" ? body.commune_insee : null;
      limit = typeof body.limit === "number" ? Math.max(1, Math.min(200, body.limit)) : 20;
    } else {
      const url = new URL(req.url);
      document_id = url.searchParams.get("document_id");
      commune_insee = url.searchParams.get("commune_insee");
      const l = url.searchParams.get("limit");

      if (l) {
        const n = Number(l);
        if (!Number.isNaN(n)) limit = Math.max(1, Math.min(200, n));
      }
    }

    if (!document_id && !commune_insee) {
      return json({ success: false, error: "MISSING_FILTER" }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (document_id) {
      const { data: vData, error: vErr } = await supabase
        .from("plu_zone_rules_resolved_reculs_v3")
        .select(
          [
            "document_id",
            "commune_insee",
            "zone_code",
            "zone_libelle",
            "recul_voirie_min_m",
            "recul_limites_separatives_min_m",
            "recul_fond_parcelle_min_m",
            "implantation_en_limite_autorisee",
            "reculs_complets_ok",
            "ai_confidence_score",
            "ai_error",
            "user_updated_at",
            "ai_updated_at",
          ].join(",")
        )
        .eq("document_id", document_id)
        .order("zone_code", { ascending: true })
        .limit(limit);

      if (vErr) {
        return json({ success: false, error: "DB_ERROR" }, 500);
      }

      const vRows = (vData ?? []) as ResolvedReculRow[];

      if (vRows.length > 0) {
        const zones: ZoneRowOut[] = vRows.map((r) => ({
          document_id: r.document_id,
          commune_insee: r.commune_insee ?? "",
          zone_code: r.zone_code,
          zone_libelle: r.zone_libelle ?? null,
          confidence_score: typeof r.ai_confidence_score === "number" ? r.ai_confidence_score : null,
          source: "resolved_reculs_v3",
          rules: mapResolvedReculsRowToRules(r),
          created_at: r.user_updated_at ?? r.ai_updated_at ?? isoNow(),
        }));

        return json(
          {
            success: true,
            version: "plu-rules-list-v1.resolved_reculs_v3.v1",
            count: zones.length,
            zones,
          },
          200
        );
      }
    }

    let q = supabase
      .from("plu_zones_rulesets")
      .select(
        [
          "document_id",
          "commune_insee",
          "zone_code",
          "zone_libelle",
          "ruleset",
          "created_at",
          "retrait_voirie_min_m",
          "retrait_limites_separatives_min_m",
          "retrait_fond_parcelle_min_m",
          "places_par_logement",
        ].join(",")
      )
      .order("created_at", { ascending: false })
      .limit(limit);

    if (document_id) q = q.eq("document_id", document_id);
    if (commune_insee) q = q.eq("commune_insee", commune_insee);

    const { data, error } = await q;

    if (error) {
      return json({ success: false, error: "DB_ERROR" }, 500);
    }

    const rows = (data ?? []) as Array<any>;

    const aiByZone = new Map<string, AiRow>();

    if (document_id) {
      const { data: aiData, error: aiErr } = await supabase
        .from("plu_rulesets_ai")
        .select(
          [
            "document_id",
            "commune_insee",
            "zone_code",
            "engine",
            "model",
            "prompt_version",
            "ruleset",
            "completeness_ok",
            "missing",
            "confidence_score",
            "citations",
            "diagnostics",
            "error",
            "created_at",
          ].join(",")
        )
        .eq("document_id", document_id)
        .order("created_at", { ascending: false })
        .limit(200);

      if (!aiErr && Array.isArray(aiData)) {
        for (const r of aiData as any[]) {
          const zc = typeof r?.zone_code === "string" ? r.zone_code : null;
          if (!zc) continue;

          const candidate = r as AiRow;
          const prev = aiByZone.get(zc);

          const candOk = candidate.completeness_ok === true && !candidate.error;
          const prevOk = prev ? prev.completeness_ok === true && !prev.error : false;

          if (!prev) {
            aiByZone.set(zc, candidate);
            continue;
          }

          if (candOk && !prevOk) {
            aiByZone.set(zc, candidate);
          }
        }
      }
    }

    const zones: ZoneRowOut[] = rows.map((r) => {
      const baseRules = mapRulesetToRules(r.ruleset ?? {}, r);

      const out: ZoneRowOut = {
        document_id: r.document_id,
        commune_insee: r.commune_insee,
        zone_code: r.zone_code,
        zone_libelle: r.zone_libelle ?? null,
        confidence_score: null,
        source: "plu_zones_rulesets",
        rules: baseRules,
        created_at: r.created_at,
      };

      const ai = aiByZone.get(out.zone_code);

      if (ai && ai.ruleset && !ai.error) {
        const aiRules = mapAiRulesetToRules(ai.ruleset);

        out.rules = {
          ...aiRules,
          meta: {
            ...(aiRules.meta ?? {}),
            ai_overlay: true,
            ai_engine: ai.engine ?? null,
            engine_version: "plu-rules-list-v1.ai_overlay.v1",
          },
        };

        out.source = ai.engine ?? "plu_rulesets_ai";
        out.confidence_score =
          typeof ai.confidence_score === "number" ? ai.confidence_score : ai.completeness_ok ? 80 : 40;

        const aiZoneLib = asString(aiRulesetZoneLibelle(ai.ruleset));
        if (!out.zone_libelle && aiZoneLib) out.zone_libelle = aiZoneLib;

        out.created_at = ai.created_at ?? out.created_at;
      }

      return out;
    });

    return json(
      {
        success: true,
        version: "plu-rules-list-v1.resolved_reculs_v3.v1+legacy_overlay.v1",
        count: zones.length,
        zones,
      },
      200
    );
  } catch (_e: unknown) {
    return json({ success: false, error: "INTERNAL_ERROR" }, 500);
  }
});