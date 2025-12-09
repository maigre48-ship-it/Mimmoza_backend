// supabase/functions/transport-nearby-v1/index.ts
import { serve } from "std/http/server";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";

console.log("✅ transport-nearby-v1 – function loaded");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // API secret key

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        {
          status: 405,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const body = await req.json().catch(() => null) as any;
    console.log("📥 transport-nearby-v1 – body:", body);

    if (!body || typeof body.lat !== "number" || typeof body.lon !== "number") {
      return new Response(
        JSON.stringify({
          error:
            "Invalid payload. Expected { lat: number, lon: number, maxDistanceKm?: number, limit?: number }",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const lat = body.lat;
    const lon = body.lon;
    const maxDistanceKm =
      typeof body.maxDistanceKm === "number" ? body.maxDistanceKm : 1.0;
    const limit = typeof body.limit === "number" ? body.limit : 20;

    // Appel de la fonction SQL get_nearby_gtfs_stops
    const { data, error } = await supabase.rpc("get_nearby_gtfs_stops", {
      p_lat: lat,
      p_lon: lon,
      p_max_distance_km: maxDistanceKm,
      p_limit: limit,
    });

    if (error) {
      console.error("❌ Error calling get_nearby_gtfs_stops:", error);
      return new Response(
        JSON.stringify({
          error: "Error calling get_nearby_gtfs_stops",
          details: error,
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const stops = (data || []) as Array<{
      stop_id: string;
      stop_name: string;
      stop_lat: number;
      stop_lon: number;
      distance_m: number;
    }>;

    // Si pas d'arrêt trouvé dans le rayon demandé
    if (stops.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          lat,
          lon,
          maxDistanceKm,
          limit,
          summary: {
            minDistanceM: null,
            countWithin300: 0,
            countWithin800: 0,
            transportScore: 0,
            level: "aucun_transport",
            label: "Aucun arrêt à proximité dans le rayon défini",
          },
          stops: [],
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Calculs dérivés pour le résumé
    const distances = stops.map((s) => s.distance_m);
    const minDistanceM = Math.min(...distances);

    const countWithin300 = stops.filter((s) => s.distance_m <= 300).length;
    const countWithin800 = stops.filter((s) => s.distance_m <= 800).length;

    // Scoring simple v1 pour l'accessibilité transports
    let transportScore = 0;
    let level = "faible";
    let label = "Accessibilité transport faible";

    // Proximité du 1er arrêt
    if (minDistanceM <= 200) {
      transportScore += 40;
    } else if (minDistanceM <= 400) {
      transportScore += 30;
    } else if (minDistanceM <= 800) {
      transportScore += 20;
    } else if (minDistanceM <= 1200) {
      transportScore += 10;
    }

    // Nombre d'arrêts à moins de 300 m
    if (countWithin300 >= 3) {
      transportScore += 30;
    } else if (countWithin300 >= 1) {
      transportScore += 20;
    }

    // Nombre d'arrêts à moins de 800 m
    if (countWithin800 >= 5) {
      transportScore += 30;
    } else if (countWithin800 >= 2) {
      transportScore += 20;
    }

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

    transportScore = Math.min(100, transportScore);

    return new Response(
      JSON.stringify({
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
        },
        stops,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (e) {
    console.error("❌ Unexpected error in transport-nearby-v1:", e);
    return new Response(
      JSON.stringify({ error: "Unexpected error", details: String(e) }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
