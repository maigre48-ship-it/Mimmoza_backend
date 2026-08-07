import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type MarketSegment =
  | "metropole_premium"
  | "metropole_standard"
  | "ville_intermediaire_dynamique"
  | "rural_periurbain";

type FeaturesRow = {
  month: string; // 'YYYY-MM-01'
  commune_code: string;
  prix_m2_median_12m: number | null;
  volume_tx_12m: number | null;
  momentum_3m_pct: number | null;
  dispersion_iqr: number | null;
  revenu_median: number | null;
  taux_pauvrete_pct: number | null;
  croissance_menages_pct: number | null;
  sensibilite_taux_proxy: number | null;
  data_quality: Record<string, unknown>;
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json; charset=utf-8",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function firstOfMonth(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  return x.toISOString().slice(0, 10); // YYYY-MM-01
}

function prevMonth(monthISO: string) {
  const [y, m] = monthISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  dt.setUTCMonth(dt.getUTCMonth() - 1);
  return dt.toISOString().slice(0, 10);
}

function winsorize(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function mean(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
}

function std(arr: number[]) {
  const m = mean(arr);
  const v = mean(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

/**
 * Standardisation simple z-score par feature
 * + winsorisation pour limiter l’influence des extrêmes.
 */
function standardizeMatrix(X: number[][]) {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const cols = Array.from({ length: d }, (_, j) => X.map((r) => r[j]));
  const mus = cols.map((c) => mean(c));
  const sigs = cols.map((c) => Math.max(1e-9, std(c)));

  const Z = X.map((row) =>
    row.map((v, j) => {
      const z = (v - mus[j]) / sigs[j];
      // winsorisation z-score (explicable): clamp à [-4, +4]
      return winsorize(z, -4, 4);
    })
  );

  return { Z, mus, sigs };
}

/**
 * KMeans minimal (explicable). Suffisant pour un v1.
 * - init simple : premiers k points (tu peux remplacer par kmeans++ plus tard)
 * - itérations fixes
 */
function kmeans(Z: number[][], k = 4, iters = 20) {
  const n = Z.length;
  const d = Z[0].length;

  let centroids = Z.slice(0, k).map((r) => r.slice());
  let assign = new Array<number>(n).fill(0);

  function dist2(a: number[], b: number[]) {
    let s = 0;
    for (let j = 0; j < d; j++) {
      const t = a[j] - b[j];
      s += t * t;
    }
    return s;
  }

  for (let it = 0; it < iters; it++) {
    // assign
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = dist2(Z[i], centroids[c]);
        if (dd < bestd) {
          bestd = dd;
          best = c;
        }
      }
      assign[i] = best;
    }

    // recompute centroids
    const sums = Array.from({ length: k }, () => new Array(d).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      for (let j = 0; j < d; j++) sums[c][j] += Z[i][j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let j = 0; j < d; j++) centroids[c][j] = sums[c][j] / counts[c];
    }
  }

  // distance + confidence (0..1) via exp(-dist)
  const dists = assign.map((c, i) => {
    const dd = Math.sqrt(
      Z[i].reduce((s, v, j) => {
        const t = v - centroids[c][j];
        return s + t * t;
      }, 0)
    );
    return dd;
  });
  const maxD = Math.max(...dists, 1e-9);
  const conf = dists.map((d) => Math.max(0, Math.min(1, 1 - d / maxD)));

  return { assign, centroids, dists, conf };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get(
      "SUPABASE_SERVICE_ROLE_KEY"
    )!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const body = await req.json().catch(() => ({}));
    const month: string = body.month ?? firstOfMonth(new Date()); // YYYY-MM-01
    const k: number = body.k ?? 4;

    // -----------------------------------------------------------------------
    // 0) Charger features mensuelles (suppose qu’elles sont déjà calculées)
    //    OU: ici tu peux appeler une RPC qui les calcule à partir DVF+INSEE.
    // -----------------------------------------------------------------------
    const { data: features, error: fErr } = await supabase
      .from("market_commune_features_monthly")
      .select("*")
      .eq("month", month);

    if (fErr) return json({ ok: false, step: "load_features", error: fErr }, 500);
    if (!features?.length) return json({ ok: false, step: "load_features", error: "no rows" }, 400);

    // Filtrer communes data OK (ex: volume>=50)
    const usable = (features as FeaturesRow[]).filter((r) => {
      const v = r.volume_tx_12m ?? 0;
      return v >= 50 && r.prix_m2_median_12m != null;
    });

    if (usable.length < k * 10) {
      return json({
        ok: false,
        step: "filter",
        error: "not enough usable communes",
        usable: usable.length,
      }, 400);
    }

    // -----------------------------------------------------------------------
    // 1) Construire X (features numériques) - petit set explicable
    // -----------------------------------------------------------------------
    const X: number[][] = [];
    const codes: string[] = [];

    for (const r of usable) {
      // Remplacer null par 0 sur certaines variables (ou médiane) => simple v1
      const row = [
        r.prix_m2_median_12m ?? 0,
        r.volume_tx_12m ?? 0,
        r.momentum_3m_pct ?? 0,
        r.dispersion_iqr ?? 0,
        r.revenu_median ?? 0,
        r.taux_pauvrete_pct ?? 0,
        r.croissance_menages_pct ?? 0,
        r.sensibilite_taux_proxy ?? 0,
      ];
      X.push(row);
      codes.push(r.commune_code);
    }

    const { Z } = standardizeMatrix(X);
    const { assign, dists, conf } = kmeans(Z, k, 25);

    // -----------------------------------------------------------------------
    // 2) Charger mapping cluster->segment pour le mois
    // -----------------------------------------------------------------------
    const { data: cmap, error: cmapErr } = await supabase
      .from("market_segment_cluster_map")
      .select("*")
      .eq("month", month)
      .eq("k", k);

    if (cmapErr) return json({ ok: false, step: "cluster_map", error: cmapErr }, 500);

    const mapByCluster = new Map<number, MarketSegment>();
    for (const row of (cmap ?? []) as any[]) {
      mapByCluster.set(row.cluster_id, row.mapped_segment);
    }

    // si mapping pas complet : refuse (ou fallback simple)
    if (mapByCluster.size < k) {
      return json({
        ok: false,
        step: "cluster_map",
        error: "cluster map incomplete for month",
        mapped: mapByCluster.size,
        k,
      }, 400);
    }

    // -----------------------------------------------------------------------
    // 3) Charger overrides admin
    // -----------------------------------------------------------------------
    const { data: overrides, error: oErr } = await supabase
      .from("market_segment_override")
      .select("*");

    if (oErr) return json({ ok: false, step: "overrides", error: oErr }, 500);

    const forcedByCommune = new Map<string, MarketSegment>();
    for (const o of (overrides ?? []) as any[]) {
      forcedByCommune.set(o.commune_code, o.forced_segment);
    }

    // -----------------------------------------------------------------------
    // 4) Charger segmentation mois précédent pour stabilité (2 mois)
    // -----------------------------------------------------------------------
    const prev = prevMonth(month);
    const { data: prevSeg, error: pErr } = await supabase
      .from("market_commune_segmentation_monthly")
      .select("commune_code, final_segment")
      .eq("month", prev);

    if (pErr) return json({ ok: false, step: "load_prev", error: pErr }, 500);

    const prevFinalByCommune = new Map<string, MarketSegment>();
    for (const r of (prevSeg ?? []) as any[]) {
      if (r.final_segment) prevFinalByCommune.set(r.commune_code, r.final_segment);
    }

    // -----------------------------------------------------------------------
    // 5) Construire rows upsert segmentation
    //    Règle stabilité : changement final uniquement si confirmé 2 mois consécutifs
    //    (v1: on marque is_transition si model != prevFinal)
    // -----------------------------------------------------------------------
    const upserts: any[] = [];

    for (let i = 0; i < codes.length; i++) {
      const commune_code = codes[i];
      const cluster_id = assign[i];
      const model_segment = mapByCluster.get(cluster_id)!;

      const prevFinal = prevFinalByCommune.get(commune_code) ?? null;

      // stabilité v1 (simple):
      // - si prevFinal existe et diffère du model => on garde prevFinal et is_transition=true
      // - sinon final=model
      // (v2: confirmation 2 mois consécutifs via table "transition tracker")
      let final_segment: MarketSegment = model_segment;
      let final_source = "model";
      let is_transition = false;

      if (prevFinal && prevFinal !== model_segment) {
        final_segment = prevFinal;
        final_source = "stabilized";
        is_transition = true;
      }

      // override admin (prioritaire)
      const forced = forcedByCommune.get(commune_code);
      if (forced) {
        final_segment = forced;
        final_source = "override";
        is_transition = false;
      }

      upserts.push({
        month,
        commune_code,
        k,
        cluster_id,
        distance_to_centroid: dists[i],
        confidence: conf[i],
        model_segment,
        model_segment_reason: "cluster_map",
        final_segment,
        final_source,
        is_transition,
        previous_final_segment: prevFinal,
      });
    }

    // -----------------------------------------------------------------------
    // 6) Upsert DB
    // -----------------------------------------------------------------------
    const { error: uErr } = await supabase
      .from("market_commune_segmentation_monthly")
      .upsert(upserts, { onConflict: "month,commune_code" });

    if (uErr) return json({ ok: false, step: "upsert_seg", error: uErr }, 500);

    // -----------------------------------------------------------------------
    // 7) Snapshot agrégé
    // -----------------------------------------------------------------------
    const counts: Record<string, number> = {};
    for (const r of upserts) {
      counts[r.final_segment] = (counts[r.final_segment] ?? 0) + 1;
    }

    const summary = {
      month,
      k,
      total: upserts.length,
      counts_by_segment: counts,
      transitions: upserts.filter((r) => r.is_transition).length,
      overrides: upserts.filter((r) => r.final_source === "override").length,
      avg_confidence: upserts.reduce((s, r) => s + (r.confidence ?? 0), 0) / upserts.length,
    };

    const { error: sErr } = await supabase
      .from("market_segmentation_snapshot_monthly")
      .upsert([{ month, k, summary }], { onConflict: "month" });

    if (sErr) return json({ ok: false, step: "upsert_snapshot", error: sErr }, 500);

    return json({ ok: true, month, k, summary });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});