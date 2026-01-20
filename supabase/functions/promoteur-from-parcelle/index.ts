// supabase/functions/promoteur-from-parcelle/index.ts
// Version logique : v3 étendue (géométrie + règles riches)
//
// Objectif :
//  - Entrée : JSON du type
//      {
//        parcel_id?: string;
//        commune_insee?: string;
//        surface_terrain_m2?: number;
//        parcel_geojson?: object;
//        parcel?: object;
//      }
//
//  - Stratégie PLU :
//      1) Si commune_insee + parcel_geojson -> RPC get_plu_rules_for_geom_v1
//      2) Sinon si parcel_id                -> RPC get_plu_rules_for_parcelle_v2
//         ✅ + RETRY geom si PLU_ZONE_NOT_FOUND et geometry disponible dans la réponse
//
//  - Sortie :
//      {
//        success: boolean;
//        version: "promoteur-from-parcelle-v3";
//        inputs: {...};
//        parcel: {...} | null;
//        plu: {...} | null;
//        promoteur: {...} | null;
//        massing: {...};
//        error?: { code: string; message?: string; details?: any };
//      }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Json = Record<string, unknown>;

/**
 * Enrichit les règles PLU de manière sûre :
 *  - on ne touche PAS aux reculs (le PLU est source de vérité),
 *  - on ajoute seulement des valeurs par défaut pour le stationnement si absent.
 */
function enrichPluRules(plu: any): any {
  if (!plu) return plu;

  const originalRules: any = plu.rules ?? {};

  const stationnement =
    originalRules.stationnement ?? {
      places_par_logement: 1.5,
      surface_par_place_m2: 25,
    };

  return {
    ...plu,
    rules: {
      ...originalRules,
      stationnement,
    },
  };
}

// -----------------------------------------------------------------------------
// Helpers robustes (retry geom)
// -----------------------------------------------------------------------------
function asTrimmedString(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function normalizeGeojsonGeometry(input: any): { geom: any | null; reason?: string } {
  if (!input || typeof input !== "object") return { geom: null, reason: "GEOJSON_EMPTY" };

  const t = input.type;

  if (t === "FeatureCollection") {
    return { geom: null, reason: "GEOJSON_FEATURECOLLECTION_NOT_ALLOWED" };
  }

  if (t === "Feature") {
    if (input.geometry && typeof input.geometry === "object" && typeof input.geometry.type === "string") {
      return { geom: input.geometry };
    }
    return { geom: null, reason: "GEOJSON_FEATURE_NO_GEOMETRY" };
  }

  // Geometry
  if (typeof t === "string" && (input.coordinates || t === "GeometryCollection")) {
    return { geom: input };
  }

  return { geom: null, reason: "GEOJSON_UNSUPPORTED_SHAPE" };
}

function upperReason(v: any): string {
  const s = asTrimmedString(v);
  return (s ?? "").toUpperCase();
}

function isZoneNotFoundReason(reasonUpper: string): boolean {
  if (!reasonUpper) return false;
  return reasonUpper.includes("ZONE_NOT_FOUND") || reasonUpper.includes("PLU_ZONE_NOT_FOUND");
}

/**
 * Essaie d'extraire une geometry GeoJSON depuis les retours possibles de get_plu_rules_for_parcelle_v2.
 * Supporte: { parcel:{geometry} }, { debug:{parcel:{geometry}} }, wrappers, etc.
 */
function extractGeomFromParcelEngine(data: any): any | null {
  if (!data || typeof data !== "object") return null;

  return (
    data?.parcel?.geometry ??
    data?.parcel?.geom ??
    data?.parcel_geojson ??
    data?.geom ??
    data?.geometry ??
    data?.debug?.parcel?.geometry ??
    data?.debug?.parcel?.geom ??
    data?.debug?.parcel_geojson ??
    data?.debug?.geom ??
    data?.debug?.geometry ??
    data?.raw_plu_engine?.parcel?.geometry ??
    data?.raw_plu_engine?.parcel?.geom ??
    data?.debug?.raw_plu_engine?.parcel?.geometry ??
    data?.debug?.raw_plu_engine?.parcel?.geom ??
    null
  );
}

serve(async (req: Request): Promise<Response> => {
  // CORS préflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as {
      parcel_id?: string;
      commune_insee?: string;
      surface_terrain_m2?: number;
      parcel_geojson?: Json;
      parcel?: Json;
    };

    const parcelId = asTrimmedString(body.parcel_id);
    const communeInsee = asTrimmedString(body.commune_insee);
    const surfaceTerrainInput = body.surface_terrain_m2;
    const parcelGeojson = body.parcel_geojson;
    let parcel: Json | null = body.parcel ?? null;

    const inputs = {
      parcel_id: parcelId ?? null,
      commune_insee: communeInsee ?? null,
      surface_terrain_m2: surfaceTerrainInput ?? null,
      has_geojson: parcelGeojson ? true : false,
    };

    if (!parcelId && !communeInsee) {
      return new Response(
        JSON.stringify({
          success: false,
          version: "promoteur-from-parcelle-v3",
          inputs,
          error: {
            code: "MISSING_PARCEL_INPUT",
            message: "Au moins parcel_id ou commune_insee doit être fourni.",
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    //----------------------------------------------------------------------
    // 1) Récupération de la parcelle (quand on a le cadastre en base, ex IDF)
    //----------------------------------------------------------------------
    if (!parcel && parcelId) {
      const { data, error } = await supabase
        .from("cadastre_parcelles")
        .select(
          [
            "id",
            "code_departement",
            "code_commune",
            "commune",
            "section",
            "numero",
            "props",
          ].join(","),
        )
        .eq("id", parcelId)
        .maybeSingle();

      if (error) {
        console.warn("Error reading cadastre_parcelles:", error.message);
      }

      if (data) {
        const row = data as any;
        const codeDepartement = asTrimmedString(row.code_departement) ?? "";
        const codeCommune = asTrimmedString(row.code_commune) ?? "";
        const communeCode =
          codeDepartement && codeCommune ? `${codeDepartement}${codeCommune}` : communeInsee ?? null;

        parcel = {
          parcel_id: row.id,
          commune_insee: communeCode,
          commune: row.commune,
          section: row.section,
          numero: row.numero,
          surface_terrain_m2:
            surfaceTerrainInput ??
            (row.props && row.props.contenance ? Number(row.props.contenance) : null),
          props: row.props ?? {},
        };
      }
    }

    //----------------------------------------------------------------------
    // 2) Récupération des règles PLU
    //----------------------------------------------------------------------
    let plu: any = null;
    let plu_engine_source: "geom" | "parcel" | null = null;
    let retry_debug: any = null;

    if (communeInsee && parcelGeojson) {
      // Mode "par géométrie" (ex: Ascain, API Etalab)
      const geoNorm = normalizeGeojsonGeometry(parcelGeojson);
      const geo = geoNorm.geom;

      if (!geo) {
        return new Response(
          JSON.stringify({
            success: false,
            version: "promoteur-from-parcelle-v3",
            inputs,
            parcel,
            error: { code: "GEOJSON_INVALID", message: geoNorm.reason ?? "Invalid GeoJSON" },
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { data, error } = await supabase.rpc("get_plu_rules_for_geom_v1", {
        p_commune_insee: communeInsee,
        p_parcel_geojson: geo, // ✅ toujours geometry (pas feature collection)
      });

      if (error) {
        console.error("get_plu_rules_for_geom_v1 error:", error.message);
        return new Response(
          JSON.stringify({
            success: false,
            version: "promoteur-from-parcelle-v3",
            inputs,
            parcel,
            error: { code: "PLU_GEOM_ERROR", message: error.message },
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      plu = data;
      plu_engine_source = "geom";
    } else if (parcelId) {
      // Mode "par parcelle" (IDF avec cadastre importé)
      const { data, error } = await supabase.rpc("get_plu_rules_for_parcelle_v2", {
        p_parcel_id: parcelId,
      });

      if (error) {
        console.error("get_plu_rules_for_parcelle_v2 error:", error.message);
        return new Response(
          JSON.stringify({
            success: false,
            version: "promoteur-from-parcelle-v3",
            inputs,
            parcel,
            error: { code: "PLU_PARCEL_ERROR", message: error.message },
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Support wrapper ou direct
      const rawParcelEngine = data;
      const maybePlu = (data as any)?.plu ?? data;

      plu = maybePlu;
      plu_engine_source = "parcel";

      // ✅ RETRY GEOM si ZONE_NOT_FOUND et geometry disponible depuis parcel-engine
      const reasonUpper =
        upperReason((maybePlu as any)?.reason) ||
        upperReason((rawParcelEngine as any)?.reason) ||
        upperReason((rawParcelEngine as any)?.plu?.reason);

      const zoneNotFound = !maybePlu?.found && isZoneNotFoundReason(reasonUpper);

      const geomFromEngine = extractGeomFromParcelEngine(rawParcelEngine);
      const geomNorm = normalizeGeojsonGeometry(geomFromEngine);
      const geomForRetry = geomNorm.geom;

      if (zoneNotFound && communeInsee && geomForRetry) {
        const { data: retryData, error: retryErr } = await supabase.rpc("get_plu_rules_for_geom_v1", {
          p_commune_insee: communeInsee,
          p_parcel_geojson: geomForRetry,
        });

        retry_debug = {
          attempted: true,
          reason: reasonUpper,
          geom_type: geomForRetry?.type ?? null,
          geom_invalid_reason: geomForRetry ? null : geomNorm.reason ?? null,
          error: retryErr?.message ?? null,
          found: retryData?.found ?? false,
        };

        if (!retryErr && retryData?.found) {
          plu = retryData;
          plu_engine_source = "geom";
        }
      } else {
        retry_debug = {
          attempted: false,
          zone_not_found: zoneNotFound,
          reason: reasonUpper || null,
          has_commune_insee: !!communeInsee,
          has_geom_from_engine: !!geomFromEngine,
          geom_invalid_reason: geomFromEngine ? (geomNorm.reason ?? null) : "NO_GEOM_FROM_ENGINE",
        };
      }
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          version: "promoteur-from-parcelle-v3",
          inputs,
          parcel,
          error: {
            code: "NO_PLU_STRATEGY_AVAILABLE",
            message:
              "Impossible de déterminer la stratégie PLU (ni géométrie + INSEE, ni parcel_id).",
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!plu?.found) {
      return new Response(
        JSON.stringify({
          success: false,
          version: "promoteur-from-parcelle-v3",
          inputs,
          parcel,
          plu,
          debug: {
            plu_engine_source,
            retry_geom: retry_debug,
          },
          error: { code: "PLU_NOT_FOUND", details: plu },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    //----------------------------------------------------------------------
    // 2bis) Enrichissement léger des règles PLU (stationnement par défaut)
    //----------------------------------------------------------------------
    const enrichedPlu = enrichPluRules(plu);

    //----------------------------------------------------------------------
    // 3) Calcul du massing v0 à partir des règles PLU
    //----------------------------------------------------------------------
    const surfaceTerrain =
      surfaceTerrainInput ??
      (parcel && (parcel as any).surface_terrain_m2 ? Number((parcel as any).surface_terrain_m2) : null);

    const rules = enrichedPlu && enrichedPlu.rules ? enrichedPlu.rules : {};

    // Emprise (ratio)
    const empriseRatioRaw =
      rules && rules.emprise && typeof (rules as any).emprise.emprise_max_ratio !== "undefined"
        ? (rules as any).emprise.emprise_max_ratio
        : null;

    const empriseRatio =
      typeof empriseRatioRaw === "number" ? empriseRatioRaw : empriseRatioRaw !== null ? Number(empriseRatioRaw) : null;

    const groundFootprintM2 = surfaceTerrain && empriseRatio ? surfaceTerrain * empriseRatio : null;

    // Hauteur max
    const maxHeightRaw =
      rules && rules.hauteur && typeof (rules as any).hauteur.max_hauteur_m !== "undefined"
        ? (rules as any).hauteur.max_hauteur_m
        : null;

    const maxHeightM =
      typeof maxHeightRaw === "number" ? maxHeightRaw : maxHeightRaw !== null ? Number(maxHeightRaw) : null;

    const estimatedFloors = maxHeightM ? Math.max(1, Math.round(maxHeightM / 3)) : null;

    const massing = {
      enabled: !!groundFootprintM2 && !!maxHeightM,
      reason: !groundFootprintM2 || !maxHeightM ? "Règles PLU incomplètes (emprise ou hauteur manquantes)" : null,
      ground_footprint_m2: groundFootprintM2,
      max_emprise_m2: groundFootprintM2,
      max_height_m: maxHeightM,
      blocks:
        groundFootprintM2 && maxHeightM
          ? [
              {
                id: "B1",
                label: "Bâtiment principal",
                height_m: maxHeightM,
                floors: estimatedFloors ?? 1,
                footprint_m2: groundFootprintM2,
              },
            ]
          : [],
      implantation: rules && (rules as any).implantation ? (rules as any).implantation : null,
      stationnement: rules && (rules as any).stationnement ? (rules as any).stationnement : null,
    };

    //----------------------------------------------------------------------
    // 4) (Optionnel) promoteur_v1 plus tard
    //----------------------------------------------------------------------
    let promoteur: any = null;

    //----------------------------------------------------------------------
    // 5) Réponse
    //----------------------------------------------------------------------
    const responseBody = {
      success: true,
      version: "promoteur-from-parcelle-v3",
      inputs,
      parcel,
      plu: enrichedPlu,
      promoteur,
      massing,
      debug: {
        plu_engine_source,
        retry_geom: retry_debug,
      },
    };

    return new Response(JSON.stringify(responseBody), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("promoteur-from-parcelle-v3 fatal error:", err);

    return new Response(
      JSON.stringify({
        success: false,
        version: "promoteur-from-parcelle-v3",
        error: {
          code: "UNEXPECTED_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
