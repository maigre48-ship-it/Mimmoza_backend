// supabase/functions/dvf-comparables-v1/index.ts
// VERSION 2.0.1
//   - Fix communeFromLatLon : repli BAN (reverse) si geo.api ne rattache aucune
//     commune (points limites / bord de cours d'eau). Filet de secours utilisé
//     uniquement quand le contexte n'a pas de code INSEE.
// VERSION 2.0.0
//   - DVF en lecture LIVE depuis geo-dvf (files.data.gouv.fr/geo-dvf/latest/csv),
//     exactement comme smartscore-enriched-v3 (fonction dvfMarketKpis).
//   - AUCUN stockage de transactions en base (coût ~0) : seul le résultat compact
//     est mis en cache dans la table api_cache.
//   - Le CSV geo-dvf est déjà géolocalisé (lat/lon par ligne) et nettoyé : pas de
//     géocodage, pas d'import, données officielles toujours à jour.
//   - Remplace la v1 (qui appelait get_dvf_market_stats_radius sur dvf_geo, vide).
//   - Contrat de sortie INCHANGÉ : { status, summary, stats, comps, params }
//     → copilot-chat (LOT 4.1) ne bouge pas.
//
//   POST body : { lat?, lon?, commune_insee?, parcel_id?, radius_km?, horizon_months?, type_local? }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── CORS inline ─────────────────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DVF_CSV_BASE = "https://files.data.gouv.fr/geo-dvf/latest/csv";
const GEO_API_BASE = "https://geo.api.gouv.fr";
const CACHE_TTL_SECONDS = 7 * 24 * 3600; // 7 jours (le DVF bouge rarement)

// ── Client Supabase (uniquement pour le cache ; optionnel) ───────────────────────
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("REST_URL") ?? "";
const serviceKey =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase =
  supabaseUrl && serviceKey
    ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
    : null;

// ── Types ─────────────────────────────────────────────────────────────────────
type DvfTypeLocal = "Appartement" | "Maison" | "Local" | null;
type DvfStatus = "ok" | "no_data" | "no_localization" | "error";

interface DvfComp {
  adresse: string | null;
  price_m2: number | null;
  surface_m2: number | null;
  date: string | null;
  type_local: string | null;
  distance_m: number | null;
  commune: string | null;
}

interface DvfStats {
  transactions_count: number;
  price_median_eur_m2: number | null;
  price_mean_eur_m2: number | null;
  price_q1_eur_m2: number | null;
  price_q3_eur_m2: number | null;
  evolution_pct: number | null;
  surface_mean_m2: number | null;
}

// ── Helpers généraux ─────────────────────────────────────────────────────────────
function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safeStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function formatEur(n: number | null): string {
  return n == null ? "n.c." : Math.round(n).toLocaleString("fr-FR") + " €/m²";
}
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// Parser CSV minimal (porté de smartscore-enriched-v3 : geo-dvf est sans guillemets).
function parseCSV(csvText: string): Array<Record<string, string>> {
  const lines = csvText.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",");
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (values[j] ?? "").trim();
    rows.push(row);
  }
  return rows;
}

// ── Résolution commune / arrondissement (Paris / Lyon / Marseille) ──────────────
const ARR_CITIES = new Set(["75056", "69123", "13055"]);
const CP_TO_ARR: Record<string, string> = {};
for (let i = 1; i <= 20; i++) CP_TO_ARR["750" + String(i).padStart(2, "0")] = "751" + String(i).padStart(2, "0");
for (let i = 1; i <= 9; i++) CP_TO_ARR["6900" + i] = "6938" + i;
for (let i = 1; i <= 16; i++) CP_TO_ARR["130" + String(i).padStart(2, "0")] = "132" + String(i).padStart(2, "0");

async function communeFromLatLon(lat: number, lon: number): Promise<string | null> {
  // 1) geo.api (rattachement officiel à la commune)
  try {
    const r = await fetch(`${GEO_API_BASE}/communes?lat=${lat}&lon=${lon}&fields=code&limit=1`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && d[0]?.code) return d[0].code;
    }
  } catch { /* */ }
  // 2) repli BAN (renvoie un citycode même près d'une limite / d'un cours d'eau)
  try {
    const r = await fetch(`https://api-adresse.data.gouv.fr/reverse/?lat=${lat}&lon=${lon}&limit=1`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const d = await r.json();
      const cc = d?.features?.[0]?.properties?.citycode;
      if (cc) return cc;
    }
  } catch { /* */ }
  return null;
}

async function geocodeCommuneCenter(insee: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const r = await fetch(`${GEO_API_BASE}/communes/${insee}?fields=centre`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const d = await r.json();
      const c = d?.centre?.coordinates;
      if (Array.isArray(c) && c.length >= 2) return { lat: c[1], lon: c[0] };
    }
  } catch { /* */ }
  return null;
}

// Le CSV geo-dvf de Paris/Lyon/Marseille est rangé par code d'arrondissement
// (75101-75120, etc.), pas par le code "ville" (75056). On le résout via la BAN.
async function resolveDvfCode(communeCode: string, lat: number | null, lon: number | null): Promise<string> {
  if (!ARR_CITIES.has(communeCode) || lat == null || lon == null) return communeCode;
  try {
    const r = await fetch(`https://api-adresse.data.gouv.fr/reverse/?lat=${lat}&lon=${lon}&limit=1`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const d = await r.json();
      const pc = d?.features?.[0]?.properties?.postcode;
      if (pc && CP_TO_ARR[pc]) return CP_TO_ARR[pc];
    }
  } catch { /* */ }
  return communeCode;
}

// ── Cache (table api_cache, comme smartscore-enriched-v3) ───────────────────────
async function getFromCache(key: string): Promise<any | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("api_cache")
      .select("data")
      .eq("cache_key", key)
      .gt("expires_at", new Date().toISOString())
      .single();
    if (!error && data?.data) return data.data;
  } catch { /* */ }
  return null;
}
async function saveToCache(key: string, data: any): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("api_cache").upsert(
      {
        cache_key: key,
        provider: "dvf-live",
        data,
        expires_at: new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString(),
        hit_count: 0,
      },
      { onConflict: "cache_key" },
    );
  } catch { /* */ }
}

// ── Lecture DVF live (CSV geo-dvf par commune) ──────────────────────────────────
async function fetchDvfLive(params: {
  communeCode: string;
  refLat: number;
  refLon: number;
  radiusM: number;
  horizonMonths: number;
  typeLocal: DvfTypeLocal;
}): Promise<{ stats: DvfStats; comps: DvfComp[] }> {
  const { communeCode, refLat, refLon, radiusM, horizonMonths, typeLocal } = params;

  const dvfCode = await resolveDvfCode(communeCode, refLat, refLon);
  const dep = dvfCode.slice(0, 2);

  const dateLimit = new Date();
  dateLimit.setMonth(dateLimit.getMonth() - Math.max(horizonMonths, 1));
  const dateLimitStr = dateLimit.toISOString().split("T")[0];

  const currentYear = new Date().getFullYear();
  const startYear = Math.max(2014, dateLimit.getFullYear());
  const years: number[] = [];
  for (let y = currentYear; y >= startYear; y--) years.push(y);

  let allRows: Array<Record<string, string>> = [];
  for (const year of years) {
    const url = `${DVF_CSV_BASE}/${year}/communes/${dep}/${dvfCode}.csv`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (resp.ok) {
        const txt = await resp.text();
        allRows = allRows.concat(parseCSV(txt));
      }
    } catch { /* année manquante → on ignore */ }
  }

  const seen = new Set<string>();
  const txns: Array<{ price_m2: number; surface: number; rec: any }> = [];

  for (const row of allRows) {
    if ((row.nature_mutation || "") !== "Vente") continue;
    const date = row.date_mutation || "";
    if (date < dateLimitStr) continue;
    const valeur = parseFloat(row.valeur_fonciere || "0");
    const surface = parseFloat(row.surface_reelle_bati || "0");
    if (valeur <= 0 || surface <= 0) continue;

    const t = row.type_local || "";
    if (typeLocal) {
      if (typeLocal === "Appartement" && t !== "Appartement") continue;
      if (typeLocal === "Maison" && t !== "Maison") continue;
      if (typeLocal === "Local" && !t.toLowerCase().includes("local")) continue;
    }

    const tLat = parseFloat(row.latitude || "0");
    const tLon = parseFloat(row.longitude || "0");
    let dist: number | undefined;
    if (tLat && tLon) {
      dist = Math.round(haversine(refLat, refLon, tLat, tLon));
      if (dist > radiusM) continue;
    }

    // Dédup mutation : une vente multi-lots ne compte qu'une fois pour les stats prix.
    const mutKey = (row.id_mutation || "") + ":" + surface + ":" + valeur;
    if (seen.has(mutKey)) continue;
    seen.add(mutKey);

    txns.push({
      price_m2: Math.round(valeur / surface),
      surface,
      rec: {
        date,
        type_local: t || null,
        distance_m: dist ?? null,
        commune: row.nom_commune || null,
        adresse: [row.adresse_numero, row.adresse_suffixe, row.adresse_nom_voie].filter(Boolean).join(" ") || null,
      },
    });
  }

  const prices = txns.map((t) => t.price_m2).sort((a, b) => a - b);
  const n = prices.length;
  const stats: DvfStats = {
    transactions_count: n,
    price_median_eur_m2: n > 0 ? prices[Math.floor(n / 2)] : null,
    price_mean_eur_m2: n > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / n) : null,
    price_q1_eur_m2: n > 0 ? prices[Math.floor(n * 0.25)] : null,
    price_q3_eur_m2: n > 0 ? prices[Math.floor(n * 0.75)] : null,
    evolution_pct: null,
    surface_mean_m2: n > 0 ? Math.round(txns.reduce((a, t) => a + t.surface, 0) / n) : null,
  };

  // Comparables : les plus proches (ou les plus récents si pas de distance), top 8.
  txns.sort((a, b) => {
    const da = a.rec.distance_m, db = b.rec.distance_m;
    if (da != null && db != null) return da - db;
    return (b.rec.date || "").localeCompare(a.rec.date || "");
  });
  const comps: DvfComp[] = txns.slice(0, 8).map((t) => ({
    adresse: t.rec.adresse,
    price_m2: t.price_m2,
    surface_m2: t.surface,
    date: t.rec.date,
    type_local: t.rec.type_local,
    distance_m: t.rec.distance_m,
    commune: t.rec.commune,
  }));

  return { stats, comps };
}

// ── Cœur ─────────────────────────────────────────────────────────────────────
async function getDvfComparables(input: {
  lat?: number | null;
  lon?: number | null;
  commune_insee?: string | null;
  parcel_id?: string | null;
  radius_km?: number;
  horizon_months?: number;
  type_local?: DvfTypeLocal;
  debug?: boolean;
}) {
  const radius_km = input.radius_km ?? 2;
  const horizon_months = input.horizon_months ?? 24;
  const type_local = input.type_local ?? null;

  // 1. Résolution : code commune (pour récupérer le bon CSV) + point de référence.
  let lat = numOrNull(input.lat);
  let lon = numOrNull(input.lon);
  let communeCode = safeStr(input.commune_insee);
  let pointSource: "payload" | "commune" | "none" = lat != null && lon != null ? "payload" : "none";

  if (!communeCode && lat != null && lon != null) {
    communeCode = await communeFromLatLon(lat, lon);
  }
  if (communeCode && (lat == null || lon == null)) {
    const c = await geocodeCommuneCenter(communeCode);
    if (c) { lat = c.lat; lon = c.lon; pointSource = "commune"; }
  }

  const params = {
    lat, lon, commune_insee: communeCode, radius_km, horizon_months, type_local, point_source: pointSource,
  };

  if (!communeCode || lat == null || lon == null) {
    return {
      status: "no_localization" as DvfStatus,
      summary:
        "Impossible de localiser la parcelle (ni commune INSEE ni coordonnées exploitables). " +
        "Sélectionne un terrain ou une adresse dans Foncier & PLU avant l'analyse de marché.",
      stats: null, comps: [] as DvfComp[], params,
    };
  }

  // 2. Cache (résultat compact uniquement).
  const cacheKey = `dvfc:${communeCode}:${horizon_months}:${radius_km}:${type_local ?? "all"}`;
  const cached = await getFromCache(cacheKey);

  // 3. Lecture live (ou cache).
  let stats: DvfStats;
  let comps: DvfComp[];
  try {
    if (cached?.stats) {
      stats = cached.stats;
      comps = cached.comps ?? [];
    } else {
      const r = await fetchDvfLive({
        communeCode, refLat: lat, refLon: lon,
        radiusM: Math.round(radius_km * 1000), horizonMonths: horizon_months, typeLocal: type_local,
      });
      stats = r.stats;
      comps = r.comps;
      await saveToCache(cacheKey, { stats, comps });
    }
  } catch (e) {
    return {
      status: "error" as DvfStatus,
      summary: "Erreur lors de la lecture des données DVF (geo-dvf).",
      stats: null, comps: [] as DvfComp[], params, error: String(e),
    };
  }

  // 4. Aucune transaction → statut explicite.
  if (stats.transactions_count === 0) {
    return {
      status: "no_data" as DvfStatus,
      summary:
        `Aucune transaction DVF dans un rayon de ${radius_km} km sur les ${horizon_months} ` +
        `derniers mois${type_local ? ` (type : ${type_local})` : ""}. ` +
        "Élargir le rayon ou l'horizon, ou retirer le filtre de type, peut révéler des comparables.",
      stats, comps: [], params,
    };
  }

  // 5. Résumé compact pré-LLM.
  const summary =
    `${stats.transactions_count} transaction(s) DVF dans ${radius_km} km sur ${horizon_months} mois` +
    `${type_local ? ` (type : ${type_local})` : ""}. ` +
    `Prix médian ${formatEur(stats.price_median_eur_m2)} ` +
    `(Q1 ${formatEur(stats.price_q1_eur_m2)} – Q3 ${formatEur(stats.price_q3_eur_m2)}).`;

  return { status: "ok" as DvfStatus, summary, stats, comps, params };
}

// ── Handler ─────────────────────────────────────────────────────────────────────
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ status: "error", error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const result = await getDvfComparables({
      lat: body.lat ?? null,
      lon: body.lon ?? null,
      commune_insee: body.commune_insee ?? null,
      parcel_id: body.parcel_id ?? null,
      radius_km: body.radius_km ?? 2,
      horizon_months: body.horizon_months ?? 24,
      type_local: body.type_local ?? null,
      debug: body.debug ?? false,
    });
    return json(result, 200);
  } catch (err) {
    return json({ status: "error", error: "Internal error", details: String(err) }, 500);
  }
});