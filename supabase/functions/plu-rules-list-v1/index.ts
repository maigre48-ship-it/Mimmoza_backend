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
  rules: PluRules; // ✅ format front
  created_at: string;
};

type AiRow = {
  document_id: string;
  commune_insee: string;
  zone_code: string;
  engine: string;
  model: string | null;
  prompt_version: string | null;
  source_pdf_storage_path: string | null;
  ruleset: any; // jsonb
  completeness_ok: boolean;
  missing: string[];
  confidence_score: number | null;
  citations: any | null;
  diagnostics: any | null;
  error: string | null;
  created_at: string;
};

/**
 * Rows from view: public.plu_zone_rules_resolved_reculs_v3
 * We keep it permissive (numbers may come as strings from PostgREST).
 */
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

// ---------------------------
// Helpers mapping
// ---------------------------

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

// Map ruleset from plu_zones_rulesets table -> front rules
function mapRulesetToRules(ruleset: any, row: any): PluRules {
  const notes: string[] = [];

  // Pull useful comments from the parsed ruleset
  pushNote(notes, "Reculs/alignements", ruleset?.reculs_alignements?.commentaire);
  pushNote(notes, "Stationnement", ruleset?.stationnement?.commentaire);
  pushNote(notes, "Emprise au sol", ruleset?.emprise_sol?.commentaire);
  pushNote(notes, "Hauteur", ruleset?.hauteur?.commentaire);
  pushNote(notes, "Densité", ruleset?.densite?.commentaire);
  pushNote(notes, "Autres règles", ruleset?.autres_regles?.commentaire);

  // Articles source -> notes
  const articles = Array.isArray(ruleset?.articles_source) ? ruleset.articles_source : [];
  for (const a of articles) {
    if (typeof a === "string" && a.trim()) notes.push(`Source: ${a.trim()}`);
  }

  // Prefer explicit numeric columns if present
  const reculVoirie = asNumber(row?.retrait_voirie_min_m);
  const reculLimSep = asNumber(row?.retrait_limites_separatives_min_m);
  const reculFond = asNumber(row?.retrait_fond_parcelle_min_m);

  // Emprise (CES) — keep null if not numeric
  const cesCandidate = asNumber(ruleset?.emprise_sol?.emprise_sol_max);
  const cesMaxPercent = cesCandidate;

  // Hauteur max (m)
  const hauteurMax = asNumber(ruleset?.hauteur?.hauteur_max_m);

  // Stationnement
  const placesParLogement = asNumber(row?.places_par_logement);
  const placesPar100m2 = null; // not available in current table extract

  // Facades: not present structurally yet -> keep note if available
  const facadeNote = asString(ruleset?.reculs_alignements?.commentaire) ?? null;

  const rules: PluRules = {
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
    stationnement: { places_par_logement: placesParLogement, places_par_100m2: placesPar100m2 },
    meta: { notes, engine_version: "plu-rules-list-v1.mapped_from_plu_zones_rulesets.v2" },
  };

  return rules;
}

// Map AI ruleset (public.plu_rulesets_ai.ruleset) -> front rules
function mapAiRulesetToRules(aiRuleset: any): PluRules {
  const notes: string[] = [];

  // AI ruleset can be either:
  // - directly in the "front rules" shape (reculs/hauteur/stationnement/emprise_sol)
  // - nested under .rules
  const src = aiRuleset?.rules ?? aiRuleset ?? {};

  const zoneLibelle = asString(src?.zone_libelle ?? src?.zoneLibelle) ?? null;

  // Extract reculs (legacy AI mapping; kept for backward compatibility)
  const reculs = src?.reculs ?? {};
  const voirieMin = asNumber(reculs?.voirie?.min_m ?? reculs?.voirie?.minM);
  const limSepMin = asNumber(reculs?.limites_separatives?.min_m ?? reculs?.limites_separatives?.minM);
  const fondMin = asNumber(reculs?.fond_parcelle?.min_m ?? reculs?.fond_parcelle?.minM);

  const implLim = boolOrNull(
    reculs?.implantation_en_limite?.autorisee ??
      reculs?.implantation_en_limite?.autorise ??
      reculs?.implantation_en_limite_autorisee
  );

  // Emprise
  const emprise = src?.emprise_sol ?? src?.empriseSol ?? {};
  const cesMax = asNumber(emprise?.emprise_sol_max ?? emprise?.ces_max_ratio ?? emprise?.ces_max_percent);

  // Hauteur
  const hauteur = src?.hauteur ?? {};
  const hauteurMax = asNumber(hauteur?.hauteur_max_m ?? hauteur?.hauteurMaxM);

  // Stationnement
  const stationnement = src?.stationnement ?? {};
  const placesLog = asNumber(stationnement?.places_par_logement ?? stationnement?.placesParLogement);
  const places100 = asNumber(stationnement?.places_par_100m2 ?? stationnement?.placesPar100m2);

  // Notes and sources
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

  // zoneLibelle currently unused; keep note if present
  if (zoneLibelle) notes.push(`Zone: ${zoneLibelle}`);

  return {
    implantation: {
      recul_voirie_min_m: voirieMin,
      recul_limite_separative_min_m: limSepMin,
      recul_fond_parcelle_min_m: fondMin,
      implantation_en_limite_autorisee: implLim,
      facades: {
        // Les facades AI peuvent exister dans d'autres schémas; on ne les force pas ici.
      },
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

// Map resolved reculs row (view) -> front rules (reculs-first, everything else optional)
function mapResolvedReculsRowToRules(r: ResolvedReculRow): PluRules {
  const notes: string[] = [];

  // Transparence (sans bloquer)
  if (r.ai_error) notes.push(`AI error: ${r.ai_error}`);
  if (typeof r.ai_confidence_score === "number") notes.push(`AI confidence: ${r.ai_confidence_score}`);
  if (r.user_updated_at) notes.push(`User override updated_at: ${r.user_updated_at}`);
  if (r.ai_updated_at) notes.push(`AI updated_at: ${r.ai_updated_at}`);

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

// Extract zone_libelle from AI ruleset in a tolerant way
function aiRulesetZoneLibelle(aiRuleset: any): string | null {
  const src = aiRuleset?.rules ?? aiRuleset ?? {};
  return asString(src?.zone_libelle ?? src?.zoneLibelle) ?? null;
}

// ---------------------------
// Handler
// ---------------------------

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ success: false, error: "MISSING_ENV" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
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
      return new Response(
        JSON.stringify({ success: false, error: "MISSING_FILTER", message: "document_id ou commune_insee requis" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ============================================================
    // PRIORITY PATH: resolved reculs view (deterministic per document)
    // ============================================================
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
        return new Response(JSON.stringify({ success: false, error: "DB_ERROR", details: vErr.message }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      const vRows = (vData ?? []) as ResolvedReculRow[];

      // If view returns rows, use them (best effort, reculs-first)
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

        return new Response(
          JSON.stringify({
            success: true,
            version: "plu-rules-list-v1.resolved_reculs_v3.v1",
            count: zones.length,
            zones,
          }),
          {
            status: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          }
        );
      }

      // If view returns 0 rows, we continue to legacy flow below (plu_zones_rulesets + AI overlay)
      // This keeps backward compatibility in case the view is not available or not yet populated.
    }

    // ============================================================
    // LEGACY FLOW (kept): base source plu_zones_rulesets + optional AI overlay
    // ============================================================

    // 1) Base source: plu_zones_rulesets
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
      return new Response(JSON.stringify({ success: false, error: "DB_ERROR", details: error.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const rows = (data ?? []) as Array<any>;

    // 2) Optional AI overlay from public.plu_rulesets_ai
    // We only fetch AI rows when document_id is specified (overlay needs document_id to be deterministic).
    // If only commune_insee is provided, we can still overlay, but it may mix docs; keep conservative.
    let aiByZone = new Map<string, AiRow>();
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
            "source_pdf_storage_path",
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
        // Keep best candidate per zone:
        // - prefer completeness_ok=true and error=null
        // - otherwise keep most recent
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

          // Prefer OK over non-OK
          if (candOk && !prevOk) {
            aiByZone.set(zc, candidate);
            continue;
          }

          // If both OK or both not OK, keep the most recent (created_at desc already, so keep first)
          // Since we're iterating in desc order, the first encountered is the newest. Do nothing.
        }
      }
    }

    // 3) Map rows to zones + apply AI overlay
    const zones: ZoneRowOut[] = rows.map((r) => {
      const baseRules = mapRulesetToRules(r.ruleset ?? {}, r);

      const out: ZoneRowOut = {
        document_id: r.document_id,
        commune_insee: r.commune_insee,
        zone_code: r.zone_code,
        zone_libelle: r.zone_libelle ?? null,
        confidence_score: null,
        source: "plu_zones_rulesets", // ✅ visible in UI
        rules: baseRules,
        created_at: r.created_at,
      };

      const ai = aiByZone.get(out.zone_code);
      if (ai && ai.ruleset && !ai.error) {
        const aiRules = mapAiRulesetToRules(ai.ruleset);

        // If AI has something more informative, override base
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

        // zone_libelle fallback from AI ruleset if missing
        const aiZoneLib = asString(aiRulesetZoneLibelle(ai.ruleset));
        if (!out.zone_libelle && aiZoneLib) out.zone_libelle = aiZoneLib;

        // Prefer AI created_at for freshness indicator if desired
        out.created_at = ai.created_at ?? out.created_at;
      }

      return out;
    });

    return new Response(
      JSON.stringify({
        success: true,
        version: "plu-rules-list-v1.resolved_reculs_v3.v1+legacy_overlay.v1",
        count: zones.length,
        zones,
      }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ success: false, error: "INTERNAL_ERROR", message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
