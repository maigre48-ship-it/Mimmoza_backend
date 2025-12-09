import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ⚙️ Config Supabase depuis les variables d'env de la fonction
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
  },
});

// 🔢 Scoring distance : 100/100 si <= 200 m, 0/100 à partir de 1500 m
function computeDistanceScore(distanceMeters: number | null | undefined): number {
  if (distanceMeters == null) return 0;
  const d = distanceMeters;
  const min = 200;
  const max = 1500;

  if (d <= min) return 100;
  if (d >= max) return 0;

  const ratio = (d - min) / (max - min);
  return Math.max(0, Math.min(100, Math.round(100 * (1 - ratio))));
}

// 🔢 Scoring densité : on sature à 150 arrêts dans les 500 m
function computeDensityScore(totalStops500m: number | null | undefined): number {
  if (totalStops500m == null) return 0;
  const n = Math.min(totalStops500m, 150); // cap
  const score = (n / 150) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// 🏷️ Label qualitatif
function computeLabel(globalScore: number): string {
  if (globalScore >= 85) return "Exceptionnel";
  if (globalScore >= 70) return "Excellent";
  if (globalScore >= 55) return "Très bon";
  if (globalScore >= 40) return "Correct";
  if (globalScore >= 25) return "Moyen";
  return "Faible";
}

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Méthode non autorisée. Utiliser POST." }),
        {
          status: 405,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const body = await req.json().catch(() => null);
    console.log("📥 transport-score – body reçu:", body);

    if (
      !body ||
      typeof body.lat !== "number" ||
      typeof body.lng !== "number"
    ) {
      return new Response(
        JSON.stringify({
          error: "Paramètres manquants ou invalides. Attendu: { lat: number, lng: number, radius_m?: number }",
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

    const lat = body.lat as number;
    const lng = body.lng as number;
    const radius_m =
      typeof body.radius_m === "number" ? body.radius_m : 800;

    // 🔁 Appel de la RPC get_transport_stats
    const { data, error } = await supabase.rpc("get_transport_stats", {
      lat,
      lng,
      radius_m,
    });

    if (error) {
      console.error("❌ Erreur RPC get_transport_stats:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Erreur lors de l'appel à get_transport_stats",
          details: (error as any).message ?? error,
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

    // data = JSONB retourné par la fonction SQL
    const raw = data as any;

    const stats = raw?.stats ?? {};
    const nearestDistance = stats.nearest_stop_distance_m ?? null;
    const totalStops500m = stats.total_stops_500m ?? null;

    const distanceScore = computeDistanceScore(nearestDistance);
    const densityScore = computeDensityScore(totalStops500m);

    // pondération : 60% distance, 40% densité
    const globalScore = Math.round(
      0.6 * distanceScore + 0.4 * densityScore,
    );

    const label = computeLabel(globalScore);

    const nearestStopName = stats.nearest_stop_name ?? null;

    const summary = nearestStopName
      ? `Accès transports ${label.toLowerCase()} : arrêt "${nearestStopName}" à ${nearestDistance} m, ${totalStops500m ?? 0} arrêts dans un rayon de 500 m.`
      : `Accès transports ${label.toLowerCase()} : ${totalStops500m ?? 0} arrêts dans un rayon de 500 m.`;

    const responseJson = {
      success: true,
      version: "v1",
      module: "transport-score",
      input: {
        lat,
        lng,
        radius_m,
      },
      scoring: {
        scoreTransport: globalScore,
        distanceScore,
        densityScore,
        label,
        summary,
      },
      rawTransport: raw,
    };

    return new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error("❌ Erreur inattendue transport-score:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Erreur interne dans transport-score",
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
});
