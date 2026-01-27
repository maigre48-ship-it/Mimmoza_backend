// supabase/functions/transport-nearby-v1/index.ts
// ✅ VERSION v1.3 — Dédup stops + scoring sur stops dédupliqués + payload stable (market-study compatible)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

console.log("✅ transport-nearby-v1 – function loaded");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "⚠️ transport-nearby-v1 missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type StopRow = {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  distance_m: number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function toNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Dédup sur stop_id en gardant l'entrée la plus proche.
 * (Évite les doublons vus dans ta sortie: mêmes stop_id répétés)
 */
function dedupStopsById(stops: StopRow[]): StopRow[] {
  const best = new Map<string, StopRow>();

  for (const s of stops) {
    const id = String(s.stop_id ?? "").trim();
    if (!id) continue;

    const dist = Number(s.distance_m);
    if (!Number.isFinite(dist)) continue;

    const prev = best.get(id);
    if (!prev || dist < Number(prev.distance_m)) {
      best.set(id, s);
    }
  }

  return Array.from(best.values()).sort((a, b) => a.distance_m - b.distance_m);
}

serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders, status: 200 });
  }

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = (await req.json().catch(() => null)) as any;

    const lat = toNum(body?.lat);
    const lon = toNum(body?.lon);

    if (lat == null || lon == null) {
      return json(
        {
          success: false,
          error:
            "Invalid payload. Expected { lat: number, lon: number, radius_km?: number | maxDistanceKm?: number, limit?: number }",
        },
        400,
      );
    }

    // Compat: market-study envoie radius_km
    const maxDistanceKm =
      toNum(body?.maxDistanceKm) ??
      toNum(body?.radius_km) ??
      1.0;

    const limit = Math.max(1, Math.min(200, toNum(body?.limit) ?? 20));

    // RPC: get_nearby_gtfs_stops(p_lat, p_lon, p_max_distance_km, p_limit)
    const { data, error } = await supabase.rpc("get_nearby_gtfs_stops", {
      p_lat: lat,
      p_lon: lon,
      p_max_distance_km: maxDistanceKm,
      p_limit: limit,
    });

    if (error) {
      console.error("❌ Error calling get_nearby_gtfs_stops:", error);
      return json(
        {
          success: false,
          error: "Error calling get_nearby_gtfs_stops",
          details: error,
          source: { provider: "supabase-rpc", dataset: "get_nearby_gtfs_stops" },
        },
        500,
      );
    }

    const stopsRaw = (data || []) as StopRow[];

    // Dédup + tri
    const stops = dedupStopsById(stopsRaw);

    // Aucun arrêt trouvé
    if (stops.length === 0) {
      const payload = {
        success: true,
        lat,
        lon,
        maxDistanceKm,
        limit,
        summary: {
          minDistanceM: null as number | null,
          countWithin300: 0,
          countWithin800: 0,
          transportScore: 0,
          level: "aucun_transport",
          label: "Aucun arrêt à proximité dans le rayon défini",
          // debug utile
          rawCount: stopsRaw.length,
          dedupCount: 0,
        },
        transport: {
          score: 0,
          level: "aucun_transport",
          label: "Aucun arrêt à proximité dans le rayon défini",
          minDistanceM: null as number | null,
          countWithin300: 0,
          countWithin800: 0,
          maxDistanceKm,
          limit,
          rawCount: stopsRaw.length,
          dedupCount: 0,
        },
        stops: [],
        source: { provider: "supabase-rpc", dataset: "get_nearby_gtfs_stops" },
      };
      return json(payload, 200);
    }

    // Résumé & scoring (sur stops dédupliqués)
    const distances = stops.map((s) => Number(s.distance_m)).filter(Number.isFinite);
    const minDistanceM = distances.length ? Math.min(...distances) : null;

    const countWithin300 = stops.filter((s) => Number(s.distance_m) <= 300).length;
    const countWithin800 = stops.filter((s) => Number(s.distance_m) <= 800).length;

    let transportScore = 0;
    let level = "faible";
    let label = "Accessibilité transport faible";

    // Proximité du 1er arrêt
    if (minDistanceM != null) {
      if (minDistanceM <= 200) transportScore += 40;
      else if (minDistanceM <= 400) transportScore += 30;
      else if (minDistanceM <= 800) transportScore += 20;
      else if (minDistanceM <= 1200) transportScore += 10;
    }

    // Arrêts <= 300m
    if (countWithin300 >= 3) transportScore += 30;
    else if (countWithin300 >= 1) transportScore += 20;

    // Arrêts <= 800m
    if (countWithin800 >= 5) transportScore += 30;
    else if (countWithin800 >= 2) transportScore += 20;

    transportScore = Math.min(100, transportScore);

    if (transportScore >= 80) {
      level = "excellent";
      label = "Accessibilité transports excellente";
    } else if (transportScore >= 60) {
      level = "bon";
      label = "Bonne accessibilité aux transports";
    } else if (transportScore >= 40) {
      level = "moyen";
      label = "Accessibilité transport correcte";
    }

    const payload = {
      success: true,
      lat,
      lon,
      maxDistanceKm,
      limit,
      summary: {
        minDistanceM,
        countWithin300,
        countWithin800,
        transportScore,
        level,
        label,
        rawCount: stopsRaw.length,
        dedupCount: stops.length,
      },
      transport: {
        score: transportScore,
        level,
        label,
        minDistanceM,
        countWithin300,
        countWithin800,
        maxDistanceKm,
        limit,
        rawCount: stopsRaw.length,
        dedupCount: stops.length,
      },
      stops,
      source: { provider: "supabase-rpc", dataset: "get_nearby_gtfs_stops" },
    };

    return json(payload, 200);
  } catch (e) {
    console.error("❌ Unexpected error in transport-nearby-v1:", e);
    return json(
      { success: false, error: "Unexpected error", details: String(e) },
      500,
    );
  }
});
