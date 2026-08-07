import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function json(res: unknown, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);

  try {
    const body = await req.json().catch(() => ({}));
    const commune_insee = String(body?.commune_insee || "").trim();
    const zone_code = String(body?.zone_code || "").trim().toUpperCase();

    if (!commune_insee || !/^\d{5}$/.test(commune_insee)) {
      return json({ success: false, error: "INVALID_COMMUNE_INSEE" }, 400);
    }
    if (!zone_code) {
      return json({ success: false, error: "MISSING_ZONE_CODE" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "https://fwvrqngbafqdaekbdfnm.supabase.co";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const key = serviceRole || anon;

    if (!key) {
      return json(
        {
          success: false,
          error: "MISSING_SUPABASE_KEY",
          message: "Ajoute SUPABASE_SERVICE_ROLE_KEY (recommandé) ou SUPABASE_ANON_KEY dans Edge Functions > Secrets.",
        },
        500
      );
    }

    const supabase = createClient(supabaseUrl, key);

    // 1) récupérer le ruleset
    const { data, error } = await supabase
      .from("plu_zones_rulesets")
      .select(
        [
          "commune_insee",
          "zone_code",
          "zone_libelle",
          "ruleset",
          "retrait_min_m",
          "retrait_voirie_min_m",
          "retrait_limites_separatives_min_m",
          "retrait_fond_parcelle_min_m",
          "places_par_logement",
          "surface_par_place_m2",
        ].join(",")
      )
      .eq("commune_insee", commune_insee)
      .eq("zone_code", zone_code)
      .limit(1)
      .maybeSingle();

    if (error) {
      return json({ success: false, error: "DB_ERROR", details: error.message }, 500);
    }
    if (!data) {
      // fallback utile: renvoyer la liste des zones disponibles pour aider le debug front
      const { data: zones } = await supabase
        .from("plu_zones_rulesets")
        .select("zone_code, zone_libelle")
        .eq("commune_insee", commune_insee)
        .order("zone_code", { ascending: true })
        .limit(50);

      return json(
        {
          success: false,
          error: "RULESET_NOT_FOUND",
          commune_insee,
          zone_code,
          available_zones: zones ?? [],
        },
        404
      );
    }

    // 2) payload stable pour le front
    return json({
      success: true,
      commune_insee: data.commune_insee,
      zone_code: data.zone_code,
      zone_libelle: data.zone_libelle,
      ruleset: data.ruleset,
      normalized: {
        retrait_min_m: data.retrait_min_m,
        retrait_voirie_min_m: data.retrait_voirie_min_m,
        retrait_limites_separatives_min_m: data.retrait_limites_separatives_min_m,
        retrait_fond_parcelle_min_m: data.retrait_fond_parcelle_min_m,
        places_par_logement: data.places_par_logement,
        surface_par_place_m2: data.surface_par_place_m2,
      },
    });
  } catch (e) {
    return json({ success: false, error: "UNHANDLED", details: String(e) }, 500);
  }
});
