import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
type InputPayload = {
  dossierId: string;
  persist?: boolean; // default true
};

type BanqueDossier = {
  id: string;
  lat?: number | null;
  lng?: number | null;
  smartscore_data?: unknown;
  market_data?: unknown;
  risks_data?: unknown;
};

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------
serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "POST only" }, 405);
    }

    const payload = (await req.json()) as InputPayload;

    if (!payload?.dossierId) {
      return jsonResponse({ error: "Missing dossierId" }, 400);
    }

    const persist = payload.persist !== false;

    // -------------------------------------------------------------------------
    // 1. Charger le dossier
    // -------------------------------------------------------------------------
    const { data: dossier, error: dossierError } = await supabase
      .from("banque_dossiers")
      .select("*")
      .eq("id", payload.dossierId)
      .single<BanqueDossier>();

    if (dossierError || !dossier) {
      return jsonResponse(
        { error: "Dossier not found", details: dossierError },
        404
      );
    }

    const lat = dossier.lat;
    const lng = dossier.lng;

    if (lat == null || lng == null) {
      return jsonResponse(
        { error: "Dossier missing lat/lng" },
        400
      );
    }

    // -------------------------------------------------------------------------
    // 2. SMARTSCORE
    // -------------------------------------------------------------------------
    const { data: smartscoreData, error: smartscoreError } =
      await supabase.rpc("compute_smartscore_v1", {
        lat,
        lng,
      });

    if (smartscoreError) {
      return jsonResponse(
        { error: "SmartScore failed", details: smartscoreError },
        500
      );
    }

    // -------------------------------------------------------------------------
    // 3. MARKET (placeholder propre, non destructif)
    // -------------------------------------------------------------------------
    // 👉 Tu brancheras DVF / market engine ici plus tard
    const marketData = {
      status: "pending",
      source: "dvf",
      computed_at: new Date().toISOString(),
    };

    // -------------------------------------------------------------------------
    // 4. RISK (placeholder – outil rouge reste indépendant)
    // -------------------------------------------------------------------------
    const riskData = {
      status: "pending",
      source: "georisques",
      computed_at: new Date().toISOString(),
    };

    // -------------------------------------------------------------------------
    // 5. Persist (SAFE upsert partiel)
    // -------------------------------------------------------------------------
    if (persist) {
      const { error: updateError } = await supabase
        .from("banque_dossiers")
        .update({
          smartscore_data: smartscoreData,
          market_data: marketData,
          risks_data: riskData,
          updated_at: new Date().toISOString(),
        })
        .eq("id", dossier.id);

      if (updateError) {
        return jsonResponse(
          { error: "Persist failed", details: updateError },
          500
        );
      }
    }

    // -------------------------------------------------------------------------
    // 6. Response
    // -------------------------------------------------------------------------
    return jsonResponse({
      dossierId: dossier.id,
      smartscore: smartscoreData,
      market: marketData,
      risk: riskData,
      persisted: persist,
    });

  } catch (e) {
    return jsonResponse(
      { error: "Unhandled error", details: String(e) },
      500
    );
  }
});
