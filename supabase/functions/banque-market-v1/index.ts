import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type Input = {
  dossierId: string;
  months?: number; // default 24
  type_local?: string; // default "Appartement"
  commune_insee?: string; // optional if already stored in banque_dossiers
  persist?: boolean; // default true
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const input = (await req.json()) as Input;
    const dossierId = (input?.dossierId ?? "").trim();
    if (!dossierId) return json({ error: "Missing dossierId" }, 400);

    const persist = input.persist !== false;
    const months = typeof input.months === "number" ? input.months : 24;
    const type_local = (input.type_local ?? "Appartement").trim();

    // Load dossier (to get commune_insee if missing)
    const { data: dossier, error: dossierErr } = await supabase
      .from("banque_dossiers")
      .select("id, commune_insee, code_postal")
      .eq("id", dossierId)
      .single();

    if (dossierErr || !dossier) {
      return json({ error: "Dossier not found", details: dossierErr }, 404);
    }

    const commune_insee = (input.commune_insee ?? dossier.commune_insee ?? "").trim();
    if (!commune_insee) {
      return json(
        { error: "Missing commune_insee (provide it or store it in banque_dossiers)" },
        400
      );
    }

    // 1) Main market stats (jsonb)
    const { data: stats, error: statsErr } = await supabase.rpc(
      "get_dvf_market_stats_commune",
      { p_code_commune: commune_insee, p_months: months, p_type_local: type_local }
    );

    if (statsErr) {
      return json({ error: "get_dvf_market_stats_commune failed", details: statsErr }, 500);
    }

    // 2) Trend (table) — optional but useful
    const { data: trend, error: trendErr } = await supabase.rpc(
      "dvf_market_trend_commune_v1",
      { p_code_commune: commune_insee, p_horizon_months: months, p_type_local: type_local, p_code_postal: null }
    );

    // trendErr can happen if RPC signature differs; don’t fail whole request.
    const market = {
      success: true,
      source: "dvf",
      params: { months, type_local, commune_insee },
      stats,
      trend: trendErr ? null : trend,
      warnings: trendErr ? [{ key: "trend_unavailable", details: trendErr.message }] : [],
      computed_at: new Date().toISOString(),
    };

    if (persist) {
      const { error: upErr } = await supabase
        .from("banque_dossiers")
        .update({
          market_data: market,
          updated_at: new Date().toISOString(),
        })
        .eq("id", dossierId);

      if (upErr) return json({ error: "Persist failed", details: upErr }, 500);
    }

    return json({ dossierId, market, persisted: persist });
  } catch (e) {
    return json({ error: "Unhandled error", details: String(e) }, 500);
  }
});
