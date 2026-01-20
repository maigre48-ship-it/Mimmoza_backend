// supabase/functions/plu-from-address/index.ts
// Version : plu-from-address-v1
// Objectif :
// - Entrée : adresse + éventuellement commune (INSEE / nom)
// - Étapes : geocoding → commune (geo.api) → parcelles Etalab → cache Supabase → règles PLU
// - Sortie : { success, version, inputs, parcel, plu, error }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// -------------------------------------------------
// Types métier
// -------------------------------------------------

type PluFromAddressRequest = {
  mode?: "address";
  address: string;
  commune_insee?: string;
  commune_nom?: string;
};

type ParcelInfo = {
  parcel_id: string;
  surface_terrain_m2: number | null;
  commune_insee: string | null;
};

type PluZoneInfo = {
  zone_code: string;
  zone_libelle: string | null;
};

type PluRuleset = {
  [key: string]: unknown;
};

type PluSourceInfo = {
  commune_insee?: string;
  commune_nom?: string;
  zone_code?: string;
  [key: string]: unknown;
};

type PluForParcelResult = {
  zone: PluZoneInfo | null;
  found: boolean;
  rules?: PluRuleset | null;
  source?: PluSourceInfo | null;
};

type PluFromAddressResponse = {
  success: boolean;
  version: "plu-from-address-v1";
  mode: "address";
  inputs: {
    address: string;
    commune_insee?: string;
    commune_nom?: string;
  };
  geocoding?: {
    lon: number;
    lat: number;
    raw?: unknown;
  };
  parcel?: ParcelInfo | null;
  plu?: PluForParcelResult | null;
  error?: string;
};

// -------------------------------------------------
// Types Etalab / Cadastre
// -------------------------------------------------

type EtalabCommune = {
  code: string; // code INSEE normalisé (ex : 75056)
  codeDepartement: string; // ex : "64"
  nom: string;
  codeCadastre?: string; // code utilisé par le cadastre (ex : 64065, 75107…)
};

type EtalabParcel = {
  id: string | null;
  code_commune: string;
  nom_commune: string;
  section: string | null;
  numero: string | null;
  surface_m2: number | null;
  geometry: any; // GeoJSON geometry
};

type DownloadResult =
  | {
      success: true;
      level: "commune" | "departement";
      geojson: any;
      url: string;
      statusCommune?: number;
      statusDepartement?: number;
    }
  | {
      success: false;
      error: "NO_GEOJSON";
      urlCommune: string;
      urlDepartement: string;
      statusCommune?: number;
      statusDepartement?: number;
    };

// -------------------------------------------------
// Supabase client
// -------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

console.log("✅ plu-from-address – function loaded");

// -------------------------------------------------
// Helpers – toujours HTTP 200
// -------------------------------------------------

function jsonResponse(body: PluFromAddressResponse): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function badRequest(
  message: string,
  extra: Partial<PluFromAddressResponse> = {},
) {
  return jsonResponse({
    success: false,
    version: "plu-from-address-v1",
    mode: "address",
    inputs: {
      address: extra.inputs?.address ?? "",
      commune_insee: extra.inputs?.commune_insee,
      commune_nom: extra.inputs?.commune_nom,
    },
    ...extra,
    error: message,
  } as PluFromAddressResponse);
}

// -------------------------------------------------
// 1) Géocodage de l'adresse via api-adresse.data.gouv.fr
// -------------------------------------------------

async function geocodeAddress(
  address: string,
): Promise<{ lon: number; lat: number; raw: unknown } | null> {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(
    address,
  )}&limit=1`;

  console.log("geocodeAddress URL:", url);

  const res = await fetch(url);

  if (!res.ok) {
    console.error("Geocoding HTTP error:", res.status, await res.text());
    return null;
  }

  const data = (await res.json()) as any;

  if (!data?.features?.length) {
    console.warn("geocodeAddress: aucune feature trouvée");
    return null;
  }

  const feature = data.features[0];
  const [lon, lat] = feature.geometry?.coordinates ?? [];

  if (typeof lon !== "number" || typeof lat !== "number") {
    console.warn("geocodeAddress: coordonnées invalides", feature.geometry);
    return null;
  }

  console.log("geocodeAddress OK:", { lon, lat });
  return { lon, lat, raw: feature };
}

// -------------------------------------------------
// 2) Commune via geo.api.gouv.fr
// -------------------------------------------------

async function getCommuneFromLatLon(
  lat: number,
  lon: number,
): Promise<EtalabCommune | null> {
  const url =
    `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&format=json`;

  console.log("getCommuneFromLatLon URL:", url);

  try {
    const res = await fetch(url);
    console.log("getCommuneFromLatLon status:", res.status);

    if (!res.ok) {
      console.error("getCommuneFromLatLon HTTP error:", res.status);
      return null;
    }

    const json = await res.json();
    console.log("getCommuneFromLatLon raw json:", json);

    if (!Array.isArray(json) || json.length === 0) {
      console.warn("getCommuneFromLatLon: aucune commune trouvée");
      return null;
    }

    const c = json[0];
    if (!c.code || !c.codeDepartement) {
      console.warn("getCommuneFromLatLon: réponse incomplète", c);
      return null;
    }

    const rawCode = c.code as string;
    const depCode = c.codeDepartement as string;

    // Normalisation spéciale Paris : arrondissements 75101–75120 → 75056
    let normalizedCode = rawCode;
    if (depCode === "75" && rawCode.startsWith("751")) {
      console.log(
        "Normalisation Paris : arrondissement",
        rawCode,
        "→ 75056",
      );
      normalizedCode = "75056";
    }

    const commune: EtalabCommune = {
      code: normalizedCode,
      codeDepartement: depCode,
      nom: c.nom ?? "",
      codeCadastre: rawCode,
    };

    console.log("Commune trouvée:", commune);
    return commune;
  } catch (e) {
    console.error("Exception getCommuneFromLatLon:", e);
    return null;
  }
}

// -------------------------------------------------
// 3) Etalab – parcelles GeoJSON (commune + fallback département)
// -------------------------------------------------

async function downloadParcellesGeoJSONWithFallback(
  codeCommune: string,
  codeDepartement: string,
): Promise<DownloadResult> {
  const baseUrl =
    "https://cadastre.data.gouv.fr/data/etalab-cadastre/2025-09-01/geojson";

  const urlCommune =
    `${baseUrl}/communes/${codeDepartement}/${codeCommune}/cadastre-${codeCommune}-parcelles.json.gz`;

  const urlDepartement =
    `${baseUrl}/departements/${codeDepartement}/cadastre-${codeDepartement}-parcelles.json.gz`;

  let statusCommune: number | undefined;
  let statusDepartement: number | undefined;

  try {
    console.log("Tentative commune Etalab:", urlCommune);
    const resCommune = await fetch(urlCommune);
    statusCommune = resCommune.status;
    console.log("Commune status:", statusCommune);

    if (resCommune.ok && resCommune.body) {
      const ds = new DecompressionStream("gzip");
      const decompressedStream = resCommune.body.pipeThrough(ds);
      const text = await new Response(decompressedStream).text();

      const geojson = JSON.parse(text);
      if (
        geojson &&
        geojson.type === "FeatureCollection" &&
        Array.isArray(geojson.features)
      ) {
        console.log(
          `GeoJSON commune chargé avec ${geojson.features.length} features`,
        );
        return {
          success: true,
          level: "commune",
          geojson,
          url: urlCommune,
          statusCommune,
        };
      }
    }
  } catch (e) {
    console.error("Erreur commune Etalab:", e);
  }

  // Fallback département
  try {
    console.log("Tentative département Etalab:", urlDepartement);
    const resDep = await fetch(urlDepartement);
    statusDepartement = resDep.status;
    console.log("Département status:", statusDepartement);

    if (resDep.ok && resDep.body) {
      const ds = new DecompressionStream("gzip");
      const decompressedStream = resDep.body.pipeThrough(ds);
      const text = await new Response(decompressedStream).text();

      const geojson = JSON.parse(text);
      if (
        geojson &&
        geojson.type === "FeatureCollection" &&
        Array.isArray(geojson.features)
      ) {
        console.log(
          `GeoJSON département chargé avec ${geojson.features.length} features`,
        );
        return {
          success: true,
          level: "departement",
          geojson,
          url: urlDepartement,
          statusCommune,
          statusDepartement,
        };
      }
    }
  } catch (e) {
    console.error("Erreur département Etalab:", e);
  }

  console.error("NO_GEOJSON pour", { urlCommune, urlDepartement });
  return {
    success: false,
    error: "NO_GEOJSON",
    urlCommune,
    urlDepartement,
    statusCommune,
    statusDepartement,
  };
}

function approxCentroid(geometry: any): [number, number] | null {
  if (!geometry) return null;

  const type = geometry.type;
  const coords = geometry.coordinates;
  if (!coords) return null;

  let sumX = 0;
  let sumY = 0;
  let count = 0;

  if (type === "Polygon") {
    for (const ring of coords) {
      for (const pt of ring) {
        sumX += pt[0];
        sumY += pt[1];
        count++;
      }
    }
  } else if (type === "MultiPolygon") {
    for (const poly of coords) {
      for (const ring of poly) {
        for (const pt of ring) {
          sumX += pt[0];
          sumY += pt[1];
          count++;
        }
      }
    }
  } else {
    return null;
  }

  if (count === 0) return null;
  return [sumX / count, sumY / count];
}

function pickNearestParcel(
  geojson: any,
  lat: number,
  lon: number,
  commune: EtalabCommune,
): EtalabParcel | null {
  let bestFeature: any = null;
  let bestDist2 = Number.POSITIVE_INFINITY;

  for (const f of geojson.features) {
    if (!f || !f.geometry) continue;
    const centroid = approxCentroid(f.geometry);
    if (!centroid) continue;

    const cx = centroid[0];
    const cy = centroid[1];
    const dx = lon - cx;
    const dy = lat - cy;
    const dist2 = dx * dx + dy * dy;

    if (dist2 < bestDist2) {
      bestDist2 = dist2;
      bestFeature = f;
    }
  }

  if (!bestFeature) {
    console.warn(
      "pickNearestParcel: aucune parcelle trouvée proche du point",
    );
    return null;
  }

  const props = bestFeature.properties ?? {};

  const id =
    props.id ??
    props.id_parcelle ??
    props.numero_parcelle ??
    null;

  const section =
    props.section ??
    props.prefixe_section ??
    null;

  const numero =
    props.numero ??
    props.numero_parcelle ??
    null;

  const surface =
    (typeof props.contenance === "number"
      ? props.contenance
      : Number(props.contenance)) ||
    (typeof props.surface === "number"
      ? props.surface
      : Number(props.surface)) ||
    null;

  const parcel: EtalabParcel = {
    id,
    code_commune: commune.code,
    nom_commune: commune.nom,
    section,
    numero,
    surface_m2: surface,
    geometry: bestFeature.geometry ?? null,
  };

  console.log("Parcelle choisie (Etalab):", parcel.id);
  return parcel;
}

// -------------------------------------------------
// 4) Cache : upsert dans cadastre_parcelles_cache
// -------------------------------------------------

async function upsertParcelIntoCache(
  parcel: EtalabParcel,
): Promise<any> {
  if (!parcel.id) {
    console.warn("parcel sans id → pas d'upsert cache");
    return parcel;
  }

  const { data, error } = await supabase.rpc(
    "cadastre_upsert_parcelle_from_etalab",
    {
      p_id: parcel.id,
      p_code_commune: parcel.code_commune,
      p_nom_commune: parcel.nom_commune,
      p_section: parcel.section,
      p_numero: parcel.numero,
      p_surface_m2: parcel.surface_m2,
      p_geometry: parcel.geometry,
    },
  );

  if (error) {
    console.error("cadastre_upsert_parcelle_from_etalab error:", error);
    return parcel;
  }

  console.log("Parcelle upsert dans cache:", data);
  return data;
}

// -------------------------------------------------
// 5) findParcelForPoint : assemble tout ça
// -------------------------------------------------

async function findParcelForPoint(
  lon: number,
  lat: number,
): Promise<ParcelInfo | null> {
  try {
    console.log("findParcelForPoint input:", { lon, lat });

    // 1) Commune
    const commune = await getCommuneFromLatLon(lat, lon);
    if (!commune) {
      console.error("Aucune commune trouvée pour ce point");
      return null;
    }

    // 2) GeoJSON parcelles Etalab
    const codeForCadastre = commune.codeCadastre ?? commune.code;
    const download = await downloadParcellesGeoJSONWithFallback(
      codeForCadastre,
      commune.codeDepartement,
    );

    if (!download.success) {
      console.error("NO_GEOJSON:", download);
      return null;
    }

    const geojson = download.geojson;

    // 3) Parcelle la plus proche
    const parcelEt = pickNearestParcel(geojson, lat, lon, commune);
    if (!parcelEt) {
      console.error("NO_PARCEL_FOUND dans GeoJSON");
      return null;
    }

    // 4) Upsert cache
    const cached = await upsertParcelIntoCache(parcelEt);

    // cached peut être une ligne, un tableau, ou fallback : parcelEt
    const p = Array.isArray(cached)
      ? (cached[0] ?? parcelEt)
      : (cached ?? parcelEt);

    const parcelId: string | undefined =
      p.parcel_id ??
      p.id ??
      parcelEt.id ??
      null;

    if (!parcelId) {
      console.error("Parcelle upsert sans id:", p);
      return null;
    }

    const surface: number | null =
      (typeof p.surface_terrain_m2 === "number"
        ? p.surface_terrain_m2
        : null) ??
      (typeof p.surface_m2 === "number"
        ? p.surface_m2
        : null) ??
      parcelEt.surface_m2 ??
      null;

    const communeInsee: string | null =
      p.commune_insee ??
      p.code_commune ??
      commune.code ??
      null;

    const parcel: ParcelInfo = {
      parcel_id: parcelId,
      surface_terrain_m2: surface,
      commune_insee: communeInsee,
    };

    console.log("findParcelForPoint – ParcelInfo:", parcel);
    return parcel;
  } catch (e) {
    console.error("Error in findParcelForPoint:", e);
    return null;
  }
}

// -------------------------------------------------
// 6) Lecture des règles PLU par commune + zone (plu_rulesets)
// (actuellement non utilisé directement, mais conservé au cas où)
// -------------------------------------------------

async function getPluRulesForZoneFromDb(
  communeInsee: string,
  zoneCode: string,
): Promise<PluRuleset | null> {
  try {
    const { data, error } = await supabase
      .from("plu_zones_rulesets") // adapté à ton schéma
      .select("rules")
      .eq("commune_insee", communeInsee)
      .eq("zone_code", zoneCode)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("getPluRulesForZoneFromDb error:", error);
      return null;
    }

    if (!data || !data.rules) {
      console.warn(
        "getPluRulesForZoneFromDb: aucun ruleset pour",
        communeInsee,
        zoneCode,
      );
      return null;
    }

    console.log(
      "getPluRulesForZoneFromDb: rules trouvées pour",
      communeInsee,
      zoneCode,
    );
    return data.rules as PluRuleset;
  } catch (e) {
    console.error("Exception getPluRulesForZoneFromDb:", e);
    return null;
  }
}

// -------------------------------------------------
// 7) Récupération des règles PLU pour une parcelle
//    via la fonction SQL get_plu_rules_for_parcelle(p_parcel_id)
// -------------------------------------------------

async function getPluForParcel(
  parcel: ParcelInfo,
): Promise<PluForParcelResult | null> {
  try {
    console.log("getPluForParcel: call RPC get_plu_rules_for_parcelle", {
      parcel_id: parcel.parcel_id,
    });

    const { data, error } = await supabase.rpc(
      "get_plu_rules_for_parcelle",
      { p_parcel_id: parcel.parcel_id },
    );

    if (error) {
      console.error("get_plu_rules_for_parcelle RPC error:", error);
      return null;
    }

    if (!data) {
      console.warn("get_plu_rules_for_parcelle: data null");
      return {
        found: false,
        zone: null,
        rules: null,
        source: {
          commune_insee: parcel.commune_insee ?? undefined,
        },
      };
    }

    const result = data as any;

    if (!result.found) {
      console.warn("get_plu_rules_for_parcelle: PLU non trouvé:", result);
      return {
        found: false,
        zone: null,
        rules: null,
        source: {
          commune_insee: parcel.commune_insee ?? undefined,
          zone_code: result.zone?.zone_code,
          reason: result.reason,
        },
      } as PluForParcelResult;
    }

    const zoneData = result.zone ?? null;
    const zone: PluZoneInfo | null = zoneData
      ? {
          zone_code: String(zoneData.zone_code),
          zone_libelle:
            zoneData.zone_libelle != null
              ? String(zoneData.zone_libelle)
              : null,
        }
      : null;

    const rules: PluRuleset | null = result.rules ?? null;

    const source: PluSourceInfo = {
      commune_insee: parcel.commune_insee ?? undefined,
      zone_code: zone?.zone_code,
      ...((result.source ?? {}) as Record<string, unknown>),
    };

    const final: PluForParcelResult = {
      found: true,
      zone,
      rules,
      source,
    };

    console.log("getPluForParcel OK:", final);
    return final;
  } catch (e) {
    console.error("Exception getPluForParcel:", e);
    return null;
  }
}

// -------------------------------------------------
// 8) Handler HTTP principal
// -------------------------------------------------

serve(async (req: Request): Promise<Response> => {
  // Preflight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return badRequest("Method not allowed");
  }

  let body: PluFromAddressRequest | null = null;

  try {
    body = (await req.json()) as PluFromAddressRequest;
  } catch (_e) {
    return badRequest("Invalid JSON body");
  }

  if (!body || !body.address || typeof body.address !== "string") {
    return badRequest("Missing field: address");
  }

  const inputs = {
    address: body.address,
    commune_insee: body.commune_insee,
    commune_nom: body.commune_nom,
  };

  try {
    // 1) Géocodage
    const geo = await geocodeAddress(body.address);
    if (!geo) {
      return jsonResponse({
        success: false,
        version: "plu-from-address-v1",
        mode: "address",
        inputs,
        error: "GEOCODING_FAILED",
      });
    }

    // 2) Parcelle via cadastre-lite (Etalab)
    const parcel = await findParcelForPoint(geo.lon, geo.lat);
    if (!parcel) {
      return jsonResponse({
        success: false,
        version: "plu-from-address-v1",
        mode: "address",
        inputs,
        geocoding: geo,
        error: "PARCEL_NOT_FOUND",
      });
    }

    // 3) Règles PLU pour cette parcelle
    const plu = await getPluForParcel(parcel);
    if (!plu || !plu.found) {
      return jsonResponse({
        success: false,
        version: "plu-from-address-v1",
        mode: "address",
        inputs,
        geocoding: geo,
        parcel,
        plu: plu ?? undefined,
        error: "PLU_NOT_FOUND",
      } as PluFromAddressResponse);
    }

    // 4) Tout est OK
    const response: PluFromAddressResponse = {
      success: true,
      version: "plu-from-address-v1",
      mode: "address",
      inputs,
      geocoding: geo,
      parcel,
      plu,
    };

    return jsonResponse(response);
  } catch (e) {
    console.error("Unhandled error in plu-from-address:", e);
    return jsonResponse({
      success: false,
      version: "plu-from-address-v1",
      mode: "address",
      inputs,
      error: "INTERNAL_ERROR",
    });
  }
});
