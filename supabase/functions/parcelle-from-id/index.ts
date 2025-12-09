// supabase/functions/parcelle-from-id/index.ts
// Version adaptée à TON schéma cadastre_parcelles

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get(
  "SUPABASE_SERVICE_ROLE_KEY"
)!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Petit utilitaire JSON + CORS
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  // Preflight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ success: false, error: "Method not allowed" }, 405);
    }

    const body = await req.json().catch(() => null);
    if (!body || !body.parcel_id) {
      return jsonResponse(
        { success: false, error: "Missing field: parcel_id" },
        400
      );
    }

    const parcel_id = body.parcel_id;

    // 1️⃣ Rechercher la parcelle dans ta table cadastre_parcelles
    // On vérifie que id == parcel_id
    const { data, error } = await supabase
      .from("cadastre_parcelles")
      .select("id, props, geom")
      .eq("id", parcel_id)
      .maybeSingle();

    if (error) {
      console.error("Erreur DB:", error);
      return jsonResponse(
        { success: false, error: "Database error", details: error.message },
        500
      );
    }

    if (!data) {
      return jsonResponse(
        { success: false, error: "Parcel not found" },
        404
      );
    }

    // 2️⃣ Extraire surface depuis props.contenance
    const surface =
      data.props?.contenance !== undefined
        ? Number(data.props.contenance)
        : null;

    const parcel = {
      parcel_id: data.id,
      surface_terrain_m2: surface,
      geometry: data.geom ?? null,
    };

    return jsonResponse(
      {
        success: true,
        parcel,
      },
      200
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse(
      {
        success: false,
        error: "Unexpected error",
        details: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
});
