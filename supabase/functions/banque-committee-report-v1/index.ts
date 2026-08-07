/// <reference lib="deno.ns" />

// FILE: supabase/functions/banque-committee-report-v1/index.ts
// ============================================================================
// ✅ FIX: userId is now received via body payload from the orchestrator.
//    - No more auth.getUser() / SUPABASE_ANON_KEY dependency.
//    - userId required only when persist=true.
//    - Explicit 500 if banque_dossier_patch_v1 returns empty row.
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import type { RiskItem } from "../_shared/smartscore/smartscore-risk.ts";
import { computeSmartScoreWithRisk } from "../_shared/smartscore/smartscore-risk.ts";
import { computeDecision } from "../_shared/decision/decision-engine.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Input — userId comes from body ──
type Input = {
  dossierId: string;
  userId?: string;    // forwarded by orchestrator (extracted from JWT at entry)
  persist?: boolean;  // default true
  debug?: boolean;
};

type SmartScoreBase = {
  totalScore: number; // 0–100
  breakdown: {
    market: number;
    faisabilite: number;
    localisation: number;
    finance: number;
  };
};

type RiskLevel = "faible" | "moyen" | "fort" | "inconnu" | "non_concerne";

const RISK_KEYS_16 = [
  "flood",
  "pollution",
  "coastal_erosion",
  "mining",
  "seismic",
  "landslide",
  "industrial",
  "clay_shrinkage",
  "wildfire",
  "avalanche",
  "radon",
  "noise",
  "storm",
  "technological",
  "dam_failure",
  "volcanic",
] as const;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function err(msg: string, status = 400, extra?: Record<string, unknown>) {
  return jsonResponse({ error: msg, ...(extra ?? {}) }, status);
}

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function coerceSmartScoreBase(payload: any): SmartScoreBase {
  const total =
    (isNum(payload?.totalScore) ? payload.totalScore : undefined) ??
    (isNum(payload?.globalScore) ? payload.globalScore : undefined) ??
    (isNum(payload?.score) ? payload.score : undefined) ??
    (isNum(payload?.global) ? payload.global : undefined);

  const b =
    payload?.breakdown ??
    payload?.pillars ??
    payload?.components ??
    payload?.scores ??
    {};

  const market =
    (isNum(b?.market) ? b.market : undefined) ??
    (isNum(b?.marche) ? b.marche : undefined) ??
    (isNum(payload?.market) ? payload.market : undefined) ??
    0;

  const faisabilite =
    (isNum(b?.faisabilite) ? b.faisabilite : undefined) ??
    (isNum(b?.feasibility) ? b.feasibility : undefined) ??
    (isNum(payload?.faisabilite) ? payload.faisabilite : undefined) ??
    0;

  const localisation =
    (isNum(b?.localisation) ? b.localisation : undefined) ??
    (isNum(b?.location) ? b.location : undefined) ??
    (isNum(payload?.localisation) ? payload.localisation : undefined) ??
    0;

  const finance =
    (isNum(b?.finance) ? b.finance : undefined) ??
    (isNum(b?.financial) ? b.financial : undefined) ??
    (isNum(payload?.finance) ? payload.finance : undefined) ??
    0;

  if (!isNum(total)) {
    const inferred = (market + faisabilite + localisation + finance) / 4;
    return {
      totalScore: clamp(Math.round(inferred), 0, 100),
      breakdown: {
        market: clamp(Math.round(market), 0, 100),
        faisabilite: clamp(Math.round(faisabilite), 0, 100),
        localisation: clamp(Math.round(localisation), 0, 100),
        finance: clamp(Math.round(finance), 0, 100),
      },
    };
  }

  return {
    totalScore: clamp(Math.round(total), 0, 100),
    breakdown: {
      market: clamp(Math.round(market), 0, 100),
      faisabilite: clamp(Math.round(faisabilite), 0, 100),
      localisation: clamp(Math.round(localisation), 0, 100),
      finance: clamp(Math.round(finance), 0, 100),
    },
  };
}

function normalizeRisks16(input: unknown): RiskItem[] {
  const arr = Array.isArray(input) ? input : [];
  const byKey = new Map<string, any>();
  for (const r of arr) {
    const key = typeof (r as any)?.key === "string" ? (r as any).key : null;
    if (key) byKey.set(key, r);
  }

  const out: RiskItem[] = [];
  for (const key of RISK_KEYS_16) {
    const raw = byKey.get(key) as any;
    const level: RiskLevel =
      raw?.level === "faible" ||
      raw?.level === "moyen" ||
      raw?.level === "fort" ||
      raw?.level === "inconnu" ||
      raw?.level === "non_concerne"
        ? raw.level
        : "inconnu";

    out.push({
      key,
      label: typeof raw?.label === "string" ? raw.label : key,
      level,
      scoreImpact: isNum(raw?.scoreImpact) ? raw.scoreImpact : undefined,
      source: typeof raw?.source === "string" ? raw.source : undefined,
    });
  }
  return out;
}

function extractRisksArray(risks_data: unknown): unknown[] | null {
  if (!risks_data) return null;

  if (typeof risks_data === "string") {
    try {
      const parsed = JSON.parse(risks_data);
      return extractRisksArray(parsed);
    } catch {
      return null;
    }
  }

  if (Array.isArray(risks_data)) return risks_data;

  if (typeof risks_data === "object") {
    const o: any = risks_data;
    const candidates = [o.risks, o.items, o.riskItems, o.normalizedRisks];
    for (const c of candidates) {
      if (Array.isArray(c)) return c;
      if (c && typeof c === "object" && Array.isArray((c as any).data)) return (c as any).data;
    }
  }
  return null;
}

function formatDecisionLabel(decision: string) {
  if (decision === "GO") return "GO";
  if (decision === "GO_AVEC_RESERVES") return "GO AVEC RESERVES";
  return "NO GO";
}

function mkCommitteeMarkdown(params: {
  dossierId: string;
  lat: number;
  lng: number;
  smartscore: any;
  decision: any;
  risksMissingNote?: string | null;
}) {
  const { dossierId, lat, lng, smartscore, decision, risksMissingNote } = params;

  const topRisks = (smartscore?.riskDetails ?? [])
    .slice()
    .sort((a: any, b: any) => Math.abs(b?.impact ?? 0) - Math.abs(a?.impact ?? 0))
    .slice(0, 5);

  const lines: string[] = [];

  lines.push(`# Comite credit : Rapport SmartScore (Banque)`);
  lines.push(`- Dossier: **${dossierId}**`);
  lines.push(`- Coordonnees: **${lat.toFixed(6)}, ${lng.toFixed(6)}**`);
  if (risksMissingNote) lines.push(`- Risques: **${risksMissingNote}**`);
  lines.push("");

  lines.push(`## Decision`);
  lines.push(`- Statut: **${formatDecisionLabel(decision?.decision)}**`);
  lines.push(`- Confiance: **${decision?.confidence ?? "-"} / 100**`);
  lines.push(`- SmartScore global: **${smartscore?.totalScore ?? "-"} / 100**`);
  lines.push(`- RiskScore: **${smartscore?.riskScore ?? "-"} / 100**`);
  lines.push("");

  lines.push(`## Motifs (justification comite)`);
  const reasons = decision?.reasons ?? [];
  if (!reasons.length) lines.push(`- (Aucun motif bloquant)`);
  else {
    for (const r of reasons) {
      const sev = r?.severity ? String(r.severity).toUpperCase() : "INFO";
      const label = r?.label ?? r?.code ?? "-";
      const details = r?.details ? ` : ${r.details}` : "";
      lines.push(`- **[${sev}]** ${label}${details}`);
    }
  }
  lines.push("");

  lines.push(`## Conditions / Reserves`);
  const conditions: string[] = decision?.conditions ?? [];
  if (!conditions.length) lines.push(`- (Aucune condition)`);
  else for (const c of conditions) lines.push(`- ${c}`);
  lines.push("");

  lines.push(`## Red flags`);
  const redFlags: string[] = decision?.redFlags ?? [];
  if (!redFlags.length) lines.push(`- (Aucun)`);
  else for (const f of redFlags) lines.push(`- ${f}`);
  lines.push("");

  lines.push(`## Synthese scores (piliers)`);
  const b = smartscore?.breakdown ?? {};
  lines.push(`- Marche: **${b.market ?? "-"}**`);
  lines.push(`- Faisabilite: **${b.faisabilite ?? "-"}**`);
  lines.push(`- Localisation: **${b.localisation ?? "-"}**`);
  lines.push(`- Finance: **${b.finance ?? "-"}**`);
  lines.push(`- Risques: **${b.risques ?? "-"}**`);
  lines.push("");

  lines.push(`## Top risques (par impact)`);
  if (!topRisks.length) lines.push(`- (Aucun detail risques)`);
  else {
    for (const r of topRisks) {
      lines.push(`- **${r.key}** : niveau *${r.level}*, poids ${r.weight}, impact ${r.impact}`);
    }
  }

  return lines.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return err("Method not allowed", 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return err("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", 500);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const input = (await req.json()) as Input;
    const dossierId = (input?.dossierId ?? "").trim();
    if (!dossierId) return err("Missing dossierId");

    const persist = input.persist !== false;
    const debug = input.debug === true;

    const userIdRaw = typeof input.userId === "string" ? input.userId : "";
    const userId = userIdRaw.trim().length > 0 ? userIdRaw.trim() : null;

    if (persist && !userId) {
      return err("Missing userId (required when persist=true)", 400, { dossierId });
    }

    const { data: row, error: readErr } = await supabase
      .from("banque_dossiers")
      .select("lat,lng,risks_data")
      .eq("id", dossierId)
      .maybeSingle();

    if (readErr) return err("Failed to read banque_dossiers", 500, { details: readErr.message });

    const lat = typeof row?.lat === "number" ? row.lat : null;
    const lng = typeof row?.lng === "number" ? row.lng : null;
    const risks_data = row?.risks_data ?? null;

    if (lat == null || lng == null) {
      return err("Missing lat/lng in banque_dossiers (run risks-refresh-v1 first)", 400, { dossierId });
    }

    const { data: smartscoreRaw, error: rpcErr } = await supabase.rpc("compute_smartscore_v1", { lat, lng });
    if (rpcErr) return err("compute_smartscore_v1 failed", 500, { details: rpcErr.message });

    const base = coerceSmartScoreBase(smartscoreRaw);

    let risksMissingNote: string | null = null;
    let risksSource: "db.risks" | "fallback.empty" = "fallback.empty";
    let extractedCount = 0;

    const extracted = extractRisksArray(risks_data);
    let risks: RiskItem[];

    if (!extracted) {
      risksMissingNote = "Risques non renseignes (rafraichir dans Analyse)";
      risks = normalizeRisks16([]);
    } else {
      extractedCount = extracted.length;
      risksSource = "db.risks";
      risks = normalizeRisks16(extracted);
    }

    const smartscore = computeSmartScoreWithRisk(base, risks);
    const decision = computeDecision({ smartScore: smartscore });

    const committeeMarkdown = mkCommitteeMarkdown({
      dossierId,
      lat,
      lng,
      smartscore,
      decision,
      risksMissingNote,
    });

    const smartscoreWithReport = {
      ...smartscore,
      committee: {
        generatedAt: new Date().toISOString(),
        decision,
        markdown: committeeMarkdown,
        risksMissingNote,
      },
    };

    if (persist) {
      const { data: patched, error: patchErr } = await supabase.rpc("banque_dossier_patch_v1", {
        p_id: dossierId,
        p_user_id: userId, // non-null here
        p_market_data: null,
        p_risks_data: null,
        p_smartscore_data: smartscoreWithReport,
      });

      if (patchErr) {
        return err("banque_dossier_patch_v1 failed", 500, {
          details: patchErr.message,
          dossierId,
          userId,
        });
      }

      if (!patched?.id) {
        return err("banque_dossier_patch_v1 returned empty row (no update)", 500, {
          dossierId,
          userId,
        });
      }

      return jsonResponse({
        ok: true,
        dossierId,
        lat,
        lng,
        smartscore: smartscoreWithReport,
        decision,
        committeeMarkdown,
        persisted: true,
        ...(debug
          ? {
              debug: {
                persist,
                userIdPresent: !!userId,
                userId,
                risksSource,
                extractedCount,
                hasRisksData: !!risks_data,
              },
            }
          : {}),
        row: patched,
      });
    }

    return jsonResponse({
      ok: true,
      dossierId,
      lat,
      lng,
      smartscore: smartscoreWithReport,
      decision,
      committeeMarkdown,
      persisted: false,
      ...(debug
        ? {
            debug: {
              persist,
              userIdPresent: !!userId,
              userId: userId ?? null,
              risksSource,
              extractedCount,
              hasRisksData: !!risks_data,
            },
          }
        : {}),
    });
  } catch (e) {
    return err("Unexpected error", 500, { details: String(e) });
  }
});
