// ============================================================================
// TRANSPORT SCORE V1 - VERSION 1.1.0
// ============================================================================
// Scoring transport via Overpass API (OSM) — gratuit, France entière, mondial.
// Isochrone 10min à pied simulé = stops accessibles dans un rayon de 800m
// (vitesse moyenne piétonne : 80m/min).
//
// Pas de clé API requise.
//
// INPUT (POST body):
//   { lat: number, lng: number, radius_m?: number }
//
// OUTPUT:
//   {
//     success: true,
//     scoring: { scoreTransport, label, summary },  ← compatible smartscore-enriched-v3
//     isochrone_10min: { nb_stops_total, has_metro, has_rer_train, has_tram,
//                        nb_lines, nearest_stop_m, nearest_stop_name, nearest_stop_mode },
//     stops: Array<{ name, mode, distance_m, line_ref }>,
//     source: "overpass",
//   }
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const VERSION = "1.1.0";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_RADIUS_M = 800;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============================================================================
// TYPES
// ============================================================================

type TransportMode = "metro" | "rer_train" | "tram" | "bus" | "other";

interface StopResult {
  name: string;
  mode: string;
  distance_m: number;
  line_ref: string | null;
}

interface Isochrone10min {
  nb_stops_total: number;
  has_metro: boolean;
  has_rer_train: boolean;
  has_tram: boolean;
  nb_lines: number;
  nearest_stop_m: number | null;
  nearest_stop_name: string | null;
  nearest_stop_mode: string | null;
}

interface TransportScoreResult {
  scoreTransport: number;
  label: string;
  summary: string;
}

interface FetchResult {
  stops: StopResult[];
  iso: Isochrone10min;
}

// ============================================================================
// HELPERS
// ============================================================================

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildEmpty(): FetchResult {
  return {
    stops: [],
    iso: {
      nb_stops_total: 0, has_metro: false, has_rer_train: false, has_tram: false,
      nb_lines: 0, nearest_stop_m: null, nearest_stop_name: null, nearest_stop_mode: null,
    },
  };
}

// ============================================================================
// MODE DETECTION
// ============================================================================

function detectMode(tags: Record<string, string>): { mode: TransportMode; label: string } {
  if (
    tags.subway === "yes" || tags.station === "subway" ||
    (tags.network && tags.network.toLowerCase().includes("métro"))
  ) return { mode: "metro", label: "Métro" };

  if (
    tags.railway === "station" || tags.railway === "halt" ||
    tags.train === "yes" || tags.station === "rail" ||
    (tags.network && /\brer\b/i.test(tags.network))
  ) return { mode: "rer_train", label: "RER / Train" };

  if (
    tags.tram === "yes" || tags.railway === "tram_stop" || tags.station === "tram" ||
    (tags.network && tags.network.toLowerCase().includes("tramway"))
  ) return { mode: "tram", label: "Tramway" };

  if (
    tags.highway === "bus_stop" || tags.bus === "yes" ||
    tags.public_transport === "stop_position" || tags.public_transport === "platform"
  ) return { mode: "bus", label: "Bus" };

  return { mode: "other", label: "Transport" };
}

// ============================================================================
// OVERPASS FETCH
// ============================================================================

async function fetchOverpass(lat: number, lon: number, radiusM: number): Promise<FetchResult | null> {
  const query = `
[out:json][timeout:12];
(
  node["public_transport"="stop_position"](around:${radiusM},${lat},${lon});
  node["public_transport"="platform"](around:${radiusM},${lat},${lon});
  node["highway"="bus_stop"](around:${radiusM},${lat},${lon});
  node["railway"="station"](around:${radiusM},${lat},${lon});
  node["railway"="halt"](around:${radiusM},${lat},${lon});
  node["railway"="tram_stop"](around:${radiusM},${lat},${lon});
  node["railway"="subway_entrance"](around:${radiusM},${lat},${lon});
  node["station"="subway"](around:${radiusM},${lat},${lon});
  node["station"="rail"](around:${radiusM},${lat},${lon});
);
out tags center 80;
`.trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let res: Response;
  try {
    res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
  } catch (e) {
    console.warn("[Overpass] Fetch error:", String(e).slice(0, 100));
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) { console.warn(`[Overpass] HTTP ${res.status}`); return null; }

  let json: Record<string, unknown>;
  try { json = await res.json(); }
  catch { console.warn("[Overpass] JSON parse error"); return null; }

  const elements = (json.elements as Array<Record<string, unknown>>) ?? [];
  console.log(`[Overpass] ${elements.length} éléments bruts`);
  if (elements.length === 0) return buildEmpty();

  const seen = new Set<string>();
  const stops: StopResult[] = [];
  const lines = new Set<string>();
  let hasMetro = false, hasRerTrain = false, hasTram = false;
  let nearestM: number | null = null;
  let nearestName: string | null = null;
  let nearestMode: string | null = null;

  for (const el of elements) {
    const eLat = safeNum(el.lat ?? (el.center as Record<string, number> | undefined)?.lat);
    const eLon = safeNum(el.lon ?? (el.center as Record<string, number> | undefined)?.lon);
    if (eLat == null || eLon == null) continue;

    const distance_m = Math.round(haversine(lat, lon, eLat, eLon));
    if (distance_m > radiusM) continue;

    const tags = (el.tags as Record<string, string>) ?? {};
    const name = tags.name || tags["name:fr"] || tags.ref || "Arrêt";
    const { mode, label: modeLabel } = detectMode(tags);
    if (mode === "other") continue;

    // Déduplication par (nom normalisé + mode)
    const key = `${name.toLowerCase().trim()}|${mode}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const ref = tags.ref || tags["route_ref"] || tags["local_ref"] || null;
    if (ref) ref.split(";").map(r => r.trim()).filter(Boolean).forEach(l => lines.add(l));

    if (mode === "metro")     hasMetro    = true;
    if (mode === "rer_train") hasRerTrain = true;
    if (mode === "tram")      hasTram     = true;

    if (nearestM === null || distance_m < nearestM) {
      nearestM = distance_m; nearestName = name; nearestMode = modeLabel;
    }

    stops.push({ name, mode: modeLabel, distance_m, line_ref: ref });
  }

  stops.sort((a, b) => a.distance_m - b.distance_m);

  return {
    stops: stops.slice(0, 25),
    iso: {
      nb_stops_total:    stops.length,
      has_metro:         hasMetro,
      has_rer_train:     hasRerTrain,
      has_tram:          hasTram,
      nb_lines:          lines.size,
      nearest_stop_m:    nearestM,
      nearest_stop_name: nearestName,
      nearest_stop_mode: nearestMode,
    },
  };
}

// ============================================================================
// SCORING ENGINE
// ============================================================================

function computeScore(iso: Isochrone10min): TransportScoreResult {
  let score = 0;

  // Base selon mode le plus élevé
  if (iso.has_metro) {
    score = 88;
    if (iso.nearest_stop_m != null && iso.nearest_stop_m < 250) score = 96;
    else if (iso.nearest_stop_m != null && iso.nearest_stop_m < 500) score = 91;
  } else if (iso.has_rer_train) {
    score = 80;
    if (iso.nearest_stop_m != null && iso.nearest_stop_m < 300) score = 87;
  } else if (iso.has_tram) {
    score = 68;
    if (iso.nearest_stop_m != null && iso.nearest_stop_m < 350) score = 75;
  } else {
    if (iso.nb_stops_total === 0)      score = 5;
    else if (iso.nb_lines >= 8)        score = 60;
    else if (iso.nb_lines >= 5)        score = 52;
    else if (iso.nb_lines >= 3)        score = 44;
    else if (iso.nb_lines >= 1)        score = 36;
    else if (iso.nb_stops_total >= 3)  score = 30;
    else                               score = 20;
  }

  // Bonus densité
  if (iso.nb_stops_total >= 15)      score = Math.min(100, score + 5);
  else if (iso.nb_stops_total >= 8)  score = Math.min(100, score + 3);

  // Bonus multimodal
  const modesCount = [iso.has_metro, iso.has_rer_train, iso.has_tram].filter(Boolean).length;
  if (modesCount >= 2) score = Math.min(100, score + 4);

  // Malus distance
  if (iso.nearest_stop_m != null) {
    if (iso.nearest_stop_m > 650)      score = Math.max(score - 12, 0);
    else if (iso.nearest_stop_m > 450) score = Math.max(score - 6, 0);
  }

  score = Math.round(Math.max(0, Math.min(100, score)));

  // Label
  const label =
    score >= 90 ? "Excellente desserte" :
    score >= 75 ? "Très bonne desserte" :
    score >= 60 ? "Bonne desserte" :
    score >= 45 ? "Desserte correcte" :
    score >= 25 ? "Desserte limitée" :
    score >= 5  ? "Très peu desservi" :
                  "Aucun transport identifié";

  // Summary
  const parts: string[] = [];
  if (iso.has_metro)     parts.push("Métro");
  if (iso.has_rer_train) parts.push("RER / Train");
  if (iso.has_tram)      parts.push("Tramway");
  if (iso.nb_lines > 0 && !iso.has_metro && !iso.has_rer_train && !iso.has_tram) {
    parts.push(`${iso.nb_lines} ligne${iso.nb_lines > 1 ? "s" : ""} de bus`);
  } else if (iso.nb_lines > 0) {
    parts.push(`+ ${iso.nb_lines} ligne${iso.nb_lines > 1 ? "s" : ""} de bus`);
  }

  const nearestPart = iso.nearest_stop_m != null && iso.nearest_stop_name
    ? ` — ${iso.nearest_stop_name} (${iso.nearest_stop_mode}) à ${iso.nearest_stop_m}m`
    : "";

  const summary = parts.length > 0
    ? `${parts.join(", ")}${nearestPart}`
    : "Aucun transport en commun dans le périmètre de 10min à pied";

  return { scoreTransport: score, label, summary };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST")   return jsonResponse({ success: false, error: "Method not allowed" }, 405);

  let payload: Record<string, unknown>;
  try { payload = await req.json(); }
  catch { return jsonResponse({ success: false, error: "Invalid JSON body" }, 400); }

  const lat     = safeNum(payload.lat);
  const lon     = safeNum(payload.lng ?? payload.lon);
  const radiusM = safeNum(payload.radius_m) ?? DEFAULT_RADIUS_M;

  if (lat == null || lon == null) {
    return jsonResponse({ success: false, error: "lat et lng requis" }, 400);
  }

  console.log(`[transport-score v${VERSION}] lat=${lat} lon=${lon} radius=${radiusM}m`);

  const result  = await fetchOverpass(lat, lon, radiusM) ?? buildEmpty();
  const scoring = computeScore(result.iso);

  console.log(
    `[transport-score] score=${scoring.scoreTransport} "${scoring.label}"` +
    ` metro=${result.iso.has_metro} rer=${result.iso.has_rer_train} tram=${result.iso.has_tram}` +
    ` lines=${result.iso.nb_lines} stops=${result.iso.nb_stops_total} nearest=${result.iso.nearest_stop_m}m`
  );

  return jsonResponse({
    success: true,
    version: VERSION,
    source: "overpass",
    scoring,                  // ← interface compatible smartscore-enriched-v3
    isochrone_10min: result.iso,
    stops: result.stops,
    meta: { lat, lon, radius_m: radiusM },
  });
});