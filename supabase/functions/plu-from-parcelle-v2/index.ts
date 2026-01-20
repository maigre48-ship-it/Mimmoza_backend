// supabase/functions/plu-from-parcelle-v2/index.ts
//
// v2.6 — ADD: geometry enrichment (geojson, centroid, surface_terrain_m2)
// - Fetch IGN cadastre geometry when missing from RPC results
// - Compute centroid and area using @turf/turf
// - Never break existing responses; add fields only
//

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as turf from "https://esm.sh/@turf/turf@6";
import { corsHeaders } from "../_shared/cors.ts";

// ----------------------------------------------------------------------------
// Env helpers
// ----------------------------------------------------------------------------

function isLikelyJwt(key: string): boolean {
  const k = (key || "").trim();
  return k.startsWith("eyJ") && k.split(".").length === 3;
}

function normalizeSupabaseUrl(raw: string): { url: string; normalizedFrom?: string; note?: string } {
  const u = (raw || "").trim();
  if (!u) return { url: "" };

  const badHosts = ["127.0.0.1", "localhost", "host.docker.internal"];
  if (badHosts.some((h) => u.includes(h))) {
    return {
      url: "http://kong:8000",
      normalizedFrom: u,
      note:
        "Normalized URL for local Edge container (localhost/127.0.0.1/host.docker.internal are not reachable from container).",
    };
  }
  return { url: u };
}

function resolveSupabaseEnv(): {
  supabaseUrl: string;
  serviceRoleKey: string;
  debug: Record<string, any>;
} {
  const rawUrlCandidates = [
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("MIMMOZA_EDGE_INTERNAL_URL") ?? "",
    Deno.env.get("MIMMOZA_SUPABASE_URL") ?? "",
  ].map((v) => (v || "").trim()).filter(Boolean);

  const rawPickedUrl = rawUrlCandidates[0] ?? "";
  const normalized = normalizeSupabaseUrl(rawPickedUrl);

  const rawKeyCandidates = [
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    Deno.env.get("MIMMOZA_EDGE_SERVICE_ROLE_JWT") ?? "",
    Deno.env.get("MIMMOZA_SERVICE_ROLE_KEY") ?? "",
  ].map((v) => (v || "").trim()).filter(Boolean);

  const rawPickedKey = rawKeyCandidates[0] ?? "";

  const debug = {
    url: {
      candidates: rawUrlCandidates.map((c) => ({
        value: c,
        looksLocalHost:
          c.includes("127.0.0.1") || c.includes("localhost") || c.includes("host.docker.internal"),
      })),
      picked: rawPickedUrl,
      normalizedTo: normalized.url,
      normalizedFrom: normalized.normalizedFrom ?? null,
      note: normalized.note ?? null,
    },
    serviceRole: {
      candidates: rawKeyCandidates.map((k) => ({
        prefix: k.slice(0, 12),
        looksJwt: isLikelyJwt(k),
        looksSbSecret: k.startsWith("sb_secret_"),
      })),
      pickedPrefix: rawPickedKey.slice(0, 12),
      pickedLooksJwt: isLikelyJwt(rawPickedKey),
      warning:
        !rawPickedKey
          ? "missing"
          : isLikelyJwt(rawPickedKey)
            ? null
            : "Service role key does not look like a JWT (expected eyJ...). If you used sb_secret_*, replace with the JWT service_role shown in `supabase status`.",
    },
  };

  return {
    supabaseUrl: normalized.url,
    serviceRoleKey: rawPickedKey,
    debug,
  };
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

type PluFromParcelleInput = {
  parcel_id: string;
  commune_insee: string;
  address?: string;
  lat?: number;
  lon?: number;
};

type ParcelEnriched = {
  parcel_id: string;
  commune_insee: string;
  source: string;
  props?: Record<string, any>;
  geometry?: any;
  geojson?: any;
  centroid?: { lat: number | null; lon: number | null };
  surface_terrain_m2?: number | null;
  geometry_error?: string;
};

type IgnFetchResult = {
  feature: any | null;
  ignUrl: string;
  error?: string;
};

// ----------------------------------------------------------------------------
// Parcel ID parsing
// ----------------------------------------------------------------------------

function parseParcelId(parcelId: string) {
  if (!parcelId || parcelId.length < 14) {
    throw new Error(`parcel_id invalide (attendu 14+ caractères) : ${parcelId}`);
  }

  const code_dep = parcelId.slice(0, 2);
  const code_com = parcelId.slice(2, 5);
  const prefixe = parcelId.slice(5, 8);
  const section = parcelId.slice(8, 10);
  const numero = parcelId.slice(10, 14);
  const code_insee = code_dep + code_com;

  return { code_insee, prefixe, section, numero };
}

// ----------------------------------------------------------------------------
// Geometry utilities (using @turf/turf)
// ----------------------------------------------------------------------------

function computeCentroid(geometry: any): { lat: number | null; lon: number | null } {
  try {
    if (!geometry) return { lat: null, lon: null };

    const feature = geometry.type === "Feature" ? geometry : { type: "Feature", geometry, properties: {} };
    const centroidPoint = turf.centroid(feature);

    if (centroidPoint?.geometry?.coordinates) {
      const [lon, lat] = centroidPoint.geometry.coordinates;
      return { lat, lon };
    }
    return { lat: null, lon: null };
  } catch (e) {
    console.warn("[plu-from-parcelle-v2] computeCentroid error:", e);
    return { lat: null, lon: null };
  }
}

function computeArea(geometry: any): number | null {
  try {
    if (!geometry) return null;

    const feature = geometry.type === "Feature" ? geometry : { type: "Feature", geometry, properties: {} };
    const areaM2 = turf.area(feature);

    return areaM2 != null ? Math.round(areaM2) : null;
  } catch (e) {
    console.warn("[plu-from-parcelle-v2] computeArea error:", e);
    return null;
  }
}

function enrichParcelFromGeometry(
  parcel: Partial<ParcelEnriched>,
  geometry: any,
  properties?: Record<string, any>
): ParcelEnriched {
  const enriched: ParcelEnriched = {
    parcel_id: parcel.parcel_id ?? "",
    commune_insee: parcel.commune_insee ?? "",
    source: parcel.source ?? "unknown",
    ...parcel,
  };

  if (geometry) {
    enriched.geometry = geometry;
    enriched.geojson = {
      type: "Feature",
      geometry,
      properties: properties ?? {},
    };
    enriched.centroid = computeCentroid(geometry);
    enriched.surface_terrain_m2 = computeArea(geometry);
  } else {
    enriched.centroid = { lat: null, lon: null };
    enriched.surface_terrain_m2 = null;
  }

  if (properties && Object.keys(properties).length > 0) {
    enriched.props = properties;
  }

  return enriched;
}

// ----------------------------------------------------------------------------
// IGN Cadastre fetch with timeout
// ----------------------------------------------------------------------------

const IGN_FETCH_TIMEOUT_MS = 7000;

async function fetchIgnParcelFeature(
  parcelId: string,
  communeInsee: string
): Promise<IgnFetchResult> {
  let parsed;
  try {
    parsed = parseParcelId(parcelId);
  } catch (e) {
    return {
      feature: null,
      ignUrl: "",
      error: `BAD_PARCEL_ID_FORMAT: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const { section, numero } = parsed;

  const ignBaseUrl = "https://apicarto.ign.fr/api/cadastre/parcelle";
  const params = new URLSearchParams({
    code_insee: communeInsee,
    section,
    numero,
    source_ign: "PCI",
    _limit: "5",
  });

  const ignUrl = `${ignBaseUrl}?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IGN_FETCH_TIMEOUT_MS);

  try {
    const ignResp = await fetch(ignUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!ignResp.ok) {
      const text = await ignResp.text().catch(() => "");
      return {
        feature: null,
        ignUrl,
        error: `IGN_CADASTRE_API_ERROR: HTTP ${ignResp.status} - ${text.slice(0, 200)}`,
      };
    }

    const ignJson = await ignResp.json();

    if (
      ignJson.type !== "FeatureCollection" ||
      !Array.isArray(ignJson.features) ||
      ignJson.features.length === 0
    ) {
      return {
        feature: null,
        ignUrl,
        error: "IGN_NO_PARCEL_FOUND",
      };
    }

    // Priorité : feature avec identifiant parcellaire correspondant, sinon features[0]
    let bestFeature = ignJson.features[0];
    for (const f of ignJson.features) {
      const props = f.properties ?? {};
      // IGN renvoie souvent "id" ou "numero" + "section"
      const fSection = props.section ?? "";
      const fNumero = props.numero ?? "";
      if (fSection === section && fNumero === numero) {
        bestFeature = f;
        break;
      }
      // Ou identifiant complet
      if (props.id === parcelId || props.idu === parcelId) {
        bestFeature = f;
        break;
      }
    }

    return {
      feature: bestFeature,
      ignUrl,
    };
  } catch (e: any) {
    clearTimeout(timeoutId);

    if (e.name === "AbortError") {
      return {
        feature: null,
        ignUrl,
        error: `IGN_FETCH_TIMEOUT: Request exceeded ${IGN_FETCH_TIMEOUT_MS}ms`,
      };
    }

    return {
      feature: null,
      ignUrl,
      error: `IGN_FETCH_ERROR: ${e.message ?? String(e)}`,
    };
  }
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { supabaseUrl, serviceRoleKey, debug: envDebug } = resolveSupabaseEnv();

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[plu-from-parcelle-v2] Missing env", {
        hasUrl: !!supabaseUrl,
        hasServiceRole: !!serviceRoleKey,
        envDebug,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: "MISSING_ENV",
          debug: {
            hasSupabaseUrl: !!supabaseUrl,
            hasServiceRoleKey: !!serviceRoleKey,
            env: envDebug,
            hint:
              "In local Edge runtime, use MIMMOZA_EDGE_INTERNAL_URL=http://kong:8000 and MIMMOZA_EDGE_SERVICE_ROLE_JWT=eyJ... (from `supabase status`).",
          },
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!isLikelyJwt(serviceRoleKey)) {
      console.error("[plu-from-parcelle-v2] BAD_SERVICE_ROLE_KEY_FORMAT", {
        pickedPrefix: serviceRoleKey.slice(0, 16),
        envDebug,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: "BAD_SERVICE_ROLE_KEY_FORMAT",
          message:
            "La clé service role fournie ne ressemble pas à un JWT (attendu eyJ...). Ne pas utiliser sb_secret_* avec supabase-js dans Edge. Copie le JWT service_role depuis `supabase status`.",
          debug: envDebug,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const body = (await req.json()) as PluFromParcelleInput;
    const { parcel_id, commune_insee, address, lat, lon } = body ?? ({} as any);

    if (!parcel_id || !commune_insee) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "MISSING_PARAMS",
          message: "parcel_id et commune_insee sont obligatoires",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log("[plu-from-parcelle-v2] input", { parcel_id, commune_insee });

    // ------------------------------------------------------------------
    // Helper: resolve geometry if missing (from IGN)
    // ------------------------------------------------------------------
    async function resolveParcelGeometry(
      baseParcel: Partial<ParcelEnriched>
    ): Promise<ParcelEnriched> {
      // Si on a déjà une geometry, enrichir directement
      if (baseParcel.geometry) {
        return enrichParcelFromGeometry(baseParcel, baseParcel.geometry, baseParcel.props);
      }

      // Sinon, tenter IGN
      const ignResult = await fetchIgnParcelFeature(parcel_id, commune_insee);

      if (ignResult.feature && ignResult.feature.geometry) {
        const enriched = enrichParcelFromGeometry(
          { ...baseParcel, source: `${baseParcel.source}+ign` },
          ignResult.feature.geometry,
          ignResult.feature.properties
        );
        return enriched;
      }

      // IGN a échoué : retourner parcel avec geometry_error
      return {
        parcel_id: baseParcel.parcel_id ?? parcel_id,
        commune_insee: baseParcel.commune_insee ?? commune_insee,
        source: baseParcel.source ?? "unknown",
        centroid: { lat: null, lon: null },
        surface_terrain_m2: null,
        geometry_error: ignResult.error ?? "IGN_FETCH_FAILED",
        ...baseParcel,
      };
    }

    // ------------------------------------------------------------------
    // 1) RPC prioritaire : get_plu_rules_for_parcelle_v2(p_parcel_id)
    // ------------------------------------------------------------------
    {
      const { data, error } = await supabase.rpc("get_plu_rules_for_parcelle_v2", {
        p_parcel_id: parcel_id,
      });

      if (error) {
        console.warn("[plu-from-parcelle-v2] get_plu_rules_for_parcelle_v2 error", {
          message: String(error.message ?? error),
        });
      } else if (data != null) {
        const found = data?.found === true;
        const reason = data?.reason ?? null;

        if (found) {
          const parcel = await resolveParcelGeometry({
            parcel_id,
            commune_insee,
            source: "rpc_get_plu_rules_for_parcelle_v2",
          });

          return new Response(
            JSON.stringify({
              version: "plu-from-parcelle-v2.6",
              success: true,
              inputs: { parcel_id, commune_insee, address, lat, lon },
              parcel,
              plu: data,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        if (reason && (reason === "PARCEL_NOT_FOUND" || reason === "ZONE_NOT_FOUND")) {
          console.warn("[plu-from-parcelle-v2] parcelle rpc not found, fallback commune-level", {
            reason,
          });
        } else {
          const parcel = await resolveParcelGeometry({
            parcel_id,
            commune_insee,
            source: "rpc_get_plu_rules_for_parcelle_v2",
          });

          return new Response(
            JSON.stringify({
              version: "plu-from-parcelle-v2.6",
              success: false,
              inputs: { parcel_id, commune_insee, address, lat, lon },
              parcel,
              plu: data,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
    }

    // ------------------------------------------------------------------
    // 2) Fallback : plu_get_for_parcelle_any(parcel_id, commune_insee)
    // ------------------------------------------------------------------
    {
      const { data, error } = await supabase.rpc("plu_get_for_parcelle_any", {
        parcel_id,
        commune_insee,
      });

      if (error) {
        console.warn("[plu-from-parcelle-v2] plu_get_for_parcelle_any error", {
          message: String(error.message ?? error),
        });
      } else if (data != null) {
        const found = data?.found === true;

        const parcel = await resolveParcelGeometry({
          parcel_id,
          commune_insee,
          source: "rpc_plu_get_for_parcelle_any",
        });

        return new Response(
          JSON.stringify({
            version: "plu-from-parcelle-v2.6",
            success: found,
            inputs: { parcel_id, commune_insee, address, lat, lon },
            parcel,
            plu: data,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // ------------------------------------------------------------------
    // 3) Dernier recours : IGN + get_plu_rules_for_geom_v1
    // ------------------------------------------------------------------
    const ignResult = await fetchIgnParcelFeature(parcel_id, commune_insee);

    if (ignResult.error && !ignResult.feature) {
      // Vérifier si c'est une erreur de format parcel_id
      if (ignResult.error.startsWith("BAD_PARCEL_ID_FORMAT")) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "BAD_PARCEL_ID_FORMAT",
            message: ignResult.error,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: ignResult.error.includes("IGN_NO_PARCEL_FOUND")
            ? "IGN_NO_PARCEL_FOUND"
            : "IGN_CADASTRE_API_ERROR",
          parcel_id,
          commune_insee,
          ignUrl: ignResult.ignUrl,
          details: ignResult.error,
        }),
        {
          status: ignResult.error.includes("IGN_NO_PARCEL_FOUND") ? 404 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const feature = ignResult.feature;
    const geometry = feature?.geometry;
    const properties = feature?.properties ?? {};

    if (!geometry) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "IGN_NO_GEOMETRY",
          parcel_id,
          commune_insee,
          ignUrl: ignResult.ignUrl,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: pluData, error: pluError } = await supabase.rpc("get_plu_rules_for_geom_v1", {
      p_commune_insee: commune_insee,
      p_parcel_geojson: geometry,
    });

    if (pluError) {
      // Même en cas d'erreur PLU, on peut renvoyer la géométrie
      const parcel = enrichParcelFromGeometry(
        {
          parcel_id,
          commune_insee,
          source: "ign+rpc_get_plu_rules_for_geom_v1_error",
        },
        geometry,
        properties
      );

      return new Response(
        JSON.stringify({
          version: "plu-from-parcelle-v2.6",
          success: false,
          error: "PLU_RPC_ERROR",
          details: String(pluError.message ?? pluError),
          inputs: { parcel_id, commune_insee, address, lat, lon },
          parcel,
          plu: null,
          debug: {
            env: envDebug,
            tried: [
              "get_plu_rules_for_parcelle_v2(p_parcel_id)",
              "plu_get_for_parcelle_any(parcel_id, commune_insee)",
              "get_plu_rules_for_geom_v1(p_commune_insee, p_parcel_geojson)",
            ],
          },
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const parcel = enrichParcelFromGeometry(
      {
        parcel_id,
        commune_insee,
        source: "ign+rpc_get_plu_rules_for_geom_v1",
      },
      geometry,
      properties
    );

    return new Response(
      JSON.stringify({
        version: "plu-from-parcelle-v2.6",
        success: pluData?.found === true,
        inputs: { parcel_id, commune_insee, address, lat, lon },
        parcel,
        plu: pluData,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[plu-from-parcelle-v2] Unhandled error:", e);
    return new Response(
      JSON.stringify({ success: false, error: "UNHANDLED", message: msg.slice(0, 500) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});