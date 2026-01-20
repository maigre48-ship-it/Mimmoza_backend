import { corsHeaders } from "../_shared/cors.ts";
import type { Terrain3DRequest, Terrain3DResponse } from "./types.ts";
import { computeCutFillPlaceholder } from "./terrainVolumes.ts";

const VERSION = "v1.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Terrain3DRequest;

    // V1: réponse mock; V2: récupérer parcel geom + appeler IGN altimétrie + calcul cut/fill
    const volumes = computeCutFillPlaceholder();

    const out: Terrain3DResponse = {
      success: true,
      version: VERSION,
      input: body,
      stats: {
        altitude_min: 42.3,
        altitude_max: 48.9,
        pente_moyenne: 6.4,
      },
      volumes,
      costs: {
        total_eur: 57000,
      },
      coverage: {
        mode: "placeholder",
      },
    };

    return new Response(JSON.stringify(out), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (e: any) {
    const out: Terrain3DResponse = {
      success: false,
      version: VERSION,
      input: {},
      stats: {},
      error: e?.message ?? "Unknown error",
    };

    return new Response(JSON.stringify(out), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
