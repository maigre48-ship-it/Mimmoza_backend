// supabase/functions/cadastre-parcelles-bbox-v1/index.ts
// VERSION 2.0.0
// Proxy IGN apicarto côté serveur (IP datacenter, pas de rate-limit navigateur)
// Fetch toutes les parcelles de la commune via pagination séquentielle
// Interface identique à v1.0.0 — aucun changement côté front nécessaire

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// cadastre.data.gouv.fr — fichier GeoJSON unique par commune, pas de pagination
// Beaucoup plus fiable qu'IGN apicarto (pas de rate-limit, réponse en 1-3s)
const CADASTRE_URL = (insee: string) =>
  `https://cadastre.data.gouv.fr/bundler/cadastre-etalab/communes/${insee}/geojson/parcelles`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const commune_insee = (body.commune_insee ?? body.code_commune ?? "").trim();

    if (!commune_insee || commune_insee.length < 5) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing/invalid commune_insee" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[cadastre-v2] Fetching commune ${commune_insee} via cadastre.data.gouv.fr...`);

    let features: unknown[] = [];

    // ── Source 1 : cadastre.data.gouv.fr (fichier unique, rapide, fiable) ──
    try {
      const url = CADASTRE_URL(commune_insee);
      console.log(`[cadastre-v2] GET ${url}`);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        headers: { "Accept": "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        features = data?.features ?? [];
        console.log(`[cadastre-v2] ✅ cadastre.data.gouv.fr: ${features.length} features`);
      } else {
        console.warn(`[cadastre-v2] cadastre.data.gouv.fr HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn(`[cadastre-v2] cadastre.data.gouv.fr failed:`, e);
    }

    // ── Source 2 : IGN apicarto (fallback, paginé, lent) ──────────────────
    if (features.length === 0) {
      console.log(`[cadastre-v2] Fallback IGN apicarto...`);
      let page = 0;
      let keepFetching = true;
      while (keepFetching && page < 20) {
        try {
          const url = `https://apicarto.ign.fr/api/cadastre/parcelle?code_insee=${commune_insee}&_limit=500&_start=${page * 500}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
          if (!res.ok) { keepFetching = false; break; }
          const data = await res.json();
          const batch: unknown[] = data?.features ?? [];
          features = [...features, ...batch];
          console.log(`[cadastre-v2] IGN page ${page}: ${batch.length} features`);
          if (batch.length < 500) { keepFetching = false; } else { page++; }
        } catch (e) {
          console.warn(`[cadastre-v2] IGN page ${page} failed:`, e);
          keepFetching = false;
        }
      }
      console.log(`[cadastre-v2] IGN total: ${features.length} features`);
    }

    console.log(`[cadastre-v2] ✅ Final: ${features.length} features for ${commune_insee}`);

    return new Response(
      JSON.stringify({
        success: true,
        commune_insee,
        code_commune: commune_insee,
        count: features.length,
        featureCollection: { type: "FeatureCollection", features },
        // compat v1: aussi exposé à la racine
        features,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});