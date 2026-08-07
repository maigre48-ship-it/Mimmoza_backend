// supabase/functions/bpe-score-v1/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json; charset=utf-8",
};

// ─────────────────────────────────────────────────────────────────────────────
// ✅ À ADAPTER : NOMS DES TABLES / VUES
// ─────────────────────────────────────────────────────────────────────────────
const TABLE_BPE_CP = "bpe_cp_aggregates";
const TABLE_CP_POP = "cp_population";
const TABLE_CP_SURFACE = "cp_surface";

// ─────────────────────────────────────────────────────────────────────────────
// Pondérations (B) – Mimmoza Investisseur / Marchand (base saine)
// ─────────────────────────────────────────────────────────────────────────────
const WEIGHTS = {
  sante: 0.22,
  supermarches: 0.18,
  commerces: 0.18,
  services: 0.14,
  education: 0.12,
  ecoles: 0.10,
  universites: 0.06,
} as const;

type WeightKey = keyof typeof WEIGHTS;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[sorted.length - 1];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = sorted[base];
  const b = sorted[Math.min(base + 1, sorted.length - 1)];
  return a + rest * (b - a);
}

function safeNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function ln1p(x: number) {
  return Math.log1p ? Math.log1p(x) : Math.log(1 + x);
}

function densityFactor(
  population: number,
  surfaceKm2: number | null,
  densityRef: number
): number {
  if (!surfaceKm2 || surfaceKm2 <= 0) return 1;
  const dens = population / surfaceKm2;
  const raw = Math.sqrt(dens / densityRef);
  return clamp(raw, 0.7, 1.2);
}

type BpeRow = {
  cp: string;
  nb_commerces: number | null;
  nb_sante: number | null;
  nb_services: number | null;
  nb_education: number | null;
  nb_supermarches: number | null;
  nb_universites: number | null;
  nb_ecoles: number | null;
  total_equipements?: number | null;
  computed_at?: string | null;
};

type RequestBody = {
  cps: string[];
  useSurface?: boolean;
  densityRef?: number;
};

serve(async (req) => {
  try {
    if (req.method === "OPTIONS")
      return new Response("ok", { headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

    const body = (await req.json().catch(() => null)) as RequestBody | null;
    const cps =
      body?.cps?.filter((x) => typeof x === "string" && x.trim().length > 0) ??
      [];
    const useSurface = body?.useSurface === true;
    const densityRefOverride = safeNumber(body?.densityRef);

    if (!cps.length) {
      return jsonResponse({ error: "Missing cps[] in body" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1) Fetch BPE by CP
    // ─────────────────────────────────────────────────────────────────────────
    const { data: bpeData, error: bpeErr } = await supabase
      .from(TABLE_BPE_CP)
      .select(
        "cp, nb_commerces, nb_sante, nb_services, nb_education, nb_supermarches, nb_universites, nb_ecoles, total_equipements, computed_at"
      )
      .in("cp", cps);

    if (bpeErr)
      return jsonResponse({ error: `BPE query failed: ${bpeErr.message}` }, 500);

    const bpeRows: BpeRow[] = (bpeData ?? []).map((r: any) => ({
      cp: String(r.cp),
      nb_commerces: safeNumber(r.nb_commerces),
      nb_sante: safeNumber(r.nb_sante),
      nb_services: safeNumber(r.nb_services),
      nb_education: safeNumber(r.nb_education),
      nb_supermarches: safeNumber(r.nb_supermarches),
      nb_universites: safeNumber(r.nb_universites),
      nb_ecoles: safeNumber(r.nb_ecoles),
      total_equipements: safeNumber(r.total_equipements),
      computed_at: r.computed_at ? String(r.computed_at) : null,
    }));

    // ─────────────────────────────────────────────────────────────────────────
    // 2) Fetch population by CP
    // ─────────────────────────────────────────────────────────────────────────
    const { data: popData, error: popErr } = await supabase
      .from(TABLE_CP_POP)
      .select("cp, population")
      .in("cp", cps);

    if (popErr)
      return jsonResponse(
        { error: `Population query failed: ${popErr.message}` },
        500
      );

    const popMap = new Map<string, number | null>();
    (popData ?? []).forEach((r: any) => {
      popMap.set(String(r.cp), safeNumber(r.population));
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3) (Optionnel) Fetch surface by CP
    // ─────────────────────────────────────────────────────────────────────────
    const surfaceMap = new Map<string, number | null>();
    let surfaceFetchOk = false;

    if (useSurface) {
      const { data: surfData, error: surfErr } = await supabase
        .from(TABLE_CP_SURFACE)
        .select("cp, surface_km2")
        .in("cp", cps);

      if (!surfErr) {
        surfaceFetchOk = true;
        (surfData ?? []).forEach((r: any) => {
          surfaceMap.set(String(r.cp), safeNumber(r.surface_km2));
        });
      }
    }

    // Index CP -> BPE row (seulement si ligne BPE existe)
    const bpeMap = new Map<string, BpeRow>();
    bpeRows.forEach((r) => bpeMap.set(r.cp, r));

    // ─────────────────────────────────────────────────────────────────────────
    // 4) Construire rates + log-rates par catégorie (C)
    //    ✅ FIX: nb=0 est valide (pas missing)
    // ─────────────────────────────────────────────────────────────────────────
    type PerCp = {
      cp: string;
      population: number | null;
      surface_km2: number | null;
      counts: Record<WeightKey, number | null>;
      rates: Record<WeightKey, number | null>;
      logs: Record<WeightKey, number | null>;
      computed_at: string | null;
      has_bpe_row: boolean;
    };

    const perCp: PerCp[] = cps.map((cp) => {
      const bpe = bpeMap.get(cp);
      const pop = popMap.get(cp) ?? null;
      const surf = useSurface ? surfaceMap.get(cp) ?? null : null;

      const counts: Record<WeightKey, number | null> = {
        commerces: bpe?.nb_commerces ?? null,
        sante: bpe?.nb_sante ?? null,
        services: bpe?.nb_services ?? null,
        education: bpe?.nb_education ?? null,
        supermarches: bpe?.nb_supermarches ?? null,
        universites: bpe?.nb_universites ?? null,
        ecoles: bpe?.nb_ecoles ?? null,
      };

      const rates = {} as Record<WeightKey, number | null>;
      const logs = {} as Record<WeightKey, number | null>;

      (Object.keys(WEIGHTS) as WeightKey[]).forEach((k) => {
        const nb = counts[k];

        // ✅ nb === 0 est accepté
        if (nb == null || nb < 0 || pop == null || pop <= 0) {
          rates[k] = null;
          logs[k] = null;
          return;
        }

        const rate = (nb / pop) * 10_000;
        rates[k] = rate;
        logs[k] = ln1p(rate);
      });

      return {
        cp,
        population: pop,
        surface_km2: surf,
        counts,
        rates,
        logs,
        computed_at: bpe?.computed_at ?? null,
        has_bpe_row: !!bpe,
      };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5) Percentiles p10/p90 par catégorie (robuste)
    // ─────────────────────────────────────────────────────────────────────────
    const p10 = {} as Record<WeightKey, number | null>;
    const p90 = {} as Record<WeightKey, number | null>;

    (Object.keys(WEIGHTS) as WeightKey[]).forEach((k) => {
      const arr = perCp
        .map((x) => x.logs[k])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .sort((a, b) => a - b);

      p10[k] = quantile(arr, 0.1);
      p90[k] = quantile(arr, 0.9);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6) densityRef : si non fourni, médiane densité sur l’échantillon
    // ─────────────────────────────────────────────────────────────────────────
    let densityRef = densityRefOverride ?? 0;

    if (!densityRefOverride && useSurface && surfaceFetchOk) {
      const densArr = perCp
        .map((x) => {
          const pop = x.population;
          const s = x.surface_km2;
          if (pop == null || pop <= 0 || s == null || s <= 0) return null;
          return pop / s;
        })
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .sort((a, b) => a - b);

      densityRef = quantile(densArr, 0.5) ?? 1000;
    }

    if (!useSurface) densityRef = 0;

    // ─────────────────────────────────────────────────────────────────────────
    // 7) Score final (B + C) + data_quality
    //    ✅ missing_categories = uniquement "vraiment missing" (null/pop absente/percentiles invalides)
    // ─────────────────────────────────────────────────────────────────────────
    const results = perCp.map((x) => {
      const norms = {} as Record<WeightKey, number | null>;
      const missingCats: string[] = [];

      (Object.keys(WEIGHTS) as WeightKey[]).forEach((k) => {
        const v = x.logs[k];
        const a = p10[k];
        const b = p90[k];

        if (v == null || a == null || b == null || b <= a) {
          norms[k] = null;
          missingCats.push(k);
          return;
        }

        norms[k] = clamp((v - a) / (b - a), 0, 1);
      });

      const totalCats = (Object.keys(WEIGHTS) as WeightKey[]).length;
      const okCats = totalCats - missingCats.length;
      const coverageRatio = totalCats ? okCats / totalCats : 0;

      let weighted = 0;
      let wsum = 0;

      (Object.keys(WEIGHTS) as WeightKey[]).forEach((k) => {
        const n = norms[k];
        if (typeof n === "number") {
          weighted += WEIGHTS[k] * n;
          wsum += WEIGHTS[k];
        }
      });

      const scoreRaw01 = wsum > 0 ? weighted / wsum : null;

      const df =
        useSurface && x.population != null && x.population > 0 && densityRef > 0
          ? densityFactor(x.population, x.surface_km2 ?? null, densityRef)
          : 1;

      const score =
        typeof scoreRaw01 === "number"
          ? Math.round(clamp(scoreRaw01 * df, 0, 1) * 100)
          : null;

      const smallPopFlag = x.population != null && x.population > 0 && x.population < 2000;

      return {
        cp: x.cp,
        score,
        breakdown: {
          weights: WEIGHTS,
          population: x.population,
          surface_km2: x.surface_km2,
          density_ref: useSurface ? densityRef : null,
          density_factor: df,
          counts: x.counts,
          rates_per_10k: x.rates,
          log_rates: x.logs,
          percentiles: { p10, p90 },
          norms_0_1: norms,
          score_raw_0_1: scoreRaw01,
        },
        data_quality: {
          has_bpe: x.has_bpe_row,
          has_population: x.population != null && x.population > 0,
          use_surface: useSurface && surfaceFetchOk,
          has_surface:
            useSurface && surfaceFetchOk
              ? x.surface_km2 != null && x.surface_km2 > 0
              : null,
          coverage_ratio: Number(coverageRatio.toFixed(3)),
          missing_categories: missingCats,
          small_pop_flag: smallPopFlag,
          computed_at: x.computed_at,
          sources: {
            bpe: TABLE_BPE_CP,
            population: TABLE_CP_POP,
            surface: useSurface ? TABLE_CP_SURFACE : null,
          },
          method: "per_10k + log1p + p10/p90 + weighted + density_factor(clamped)",
        },
      };
    });

    return jsonResponse({
      ok: true,
      meta: {
        cps_requested: cps.length,
        cps_returned: results.length,
        use_surface: useSurface && surfaceFetchOk,
        density_ref: useSurface && surfaceFetchOk ? densityRef : null,
        computed_at: new Date().toISOString(),
      },
      results,
    });
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : "Unknown error" },
      500
    );
  }
});