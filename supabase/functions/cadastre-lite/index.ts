// supabase/functions/cadastre-lite/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

type CadastreLiteRequest = {
  mode: "point";
  lat: number;
  lon: number;
  include_plu?: boolean;
};

type EtalabCommune = {
  code: string;
  codeDepartement: string;
  nom: string;
  codeCadastre?: string;
};

type EtalabParcel = {
  id: string | null;
  code_commune: string;
  nom_commune: string;
  section: string | null;
  numero: string | null;
  surface_m2: number | null;
  geometry: any;
};

type DownloadResult =
  | {
      success: true;
      level: "commune" | "departement";
      geojson: any;
      statusCommune?: number;
      statusDepartement?: number;
    }
  | {
      success: false;
      error: "NO_GEOJSON";
      statusCommune?: number;
      statusDepartement?: number;
    };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => null)) as CadastreLiteRequest | null;

    if (!body) {
      return jsonResponse({ success: false, error: "INVALID_JSON" }, 400);
    }

    if (body.mode === "point") {
      return await handlePoint(body);
    }

    return jsonResponse({ success: false, error: "INVALID_MODE" }, 400);
  } catch {
    console.error("[cadastre-lite] Internal error");
    return jsonResponse({ success: false, error: "INTERNAL_ERROR" }, 500);
  }
});

async function handlePoint(body: CadastreLiteRequest): Promise<Response> {
  const { lat, lon, include_plu = false } = body;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResponse({ success: false, error: "INVALID_COORDINATES" }, 400);
  }

  const commune = await getCommuneFromLatLon(lat, lon);

  if (!commune) {
    return jsonResponse({ success: false, error: "NO_COMMUNE_FOUND" }, 404);
  }

  const codeForCadastre = commune.codeCadastre ?? commune.code;

  const download = await downloadParcellesGeoJSONWithFallback(
    codeForCadastre,
    commune.codeDepartement,
  );

  if (!download.success) {
    console.error("[cadastre-lite] GeoJSON unavailable");

    return jsonResponse(
      {
        success: false,
        error: "NO_GEOJSON",
      },
      500,
    );
  }

  const geojson = download.geojson;

  const parcel = pickNearestParcel(geojson, lat, lon, commune);

  if (!parcel) {
    return jsonResponse(
      {
        success: false,
        error: "NO_PARCEL_FOUND",
        commune: {
          code: commune.code,
          codeDepartement: commune.codeDepartement,
          nom: commune.nom,
          codeCadastre: commune.codeCadastre,
        },
      },
      404,
    );
  }

  const cached = await upsertParcelIntoCache(parcel);

  let plu: any = null;

  if (include_plu && cached && cached.id) {
    plu = await fetchPluForParcel(cached.id as string);
  }

  return jsonResponse({
    success: true,
    source: "etalab",
    commune: {
      code: commune.code,
      codeDepartement: commune.codeDepartement,
      nom: commune.nom,
      codeCadastre: commune.codeCadastre,
    },
    parcel: cached,
    plu,
  });
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

async function getCommuneFromLatLon(
  lat: number,
  lon: number,
): Promise<EtalabCommune | null> {
  const url =
    `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&format=json`;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      console.error("[cadastre-lite] Commune lookup HTTP error");
      return null;
    }

    const json = await res.json().catch(() => null);

    if (!Array.isArray(json) || json.length === 0) {
      return null;
    }

    const c = json[0];

    if (!c.code || !c.codeDepartement) {
      return null;
    }

    const rawCode = c.code as string;
    const depCode = c.codeDepartement as string;

    let normalizedCode = rawCode;

    if (depCode === "75" && rawCode.startsWith("751")) {
      normalizedCode = "75056";
    }

    return {
      code: normalizedCode,
      codeDepartement: depCode,
      nom: c.nom ?? "",
      codeCadastre: rawCode,
    };
  } catch {
    console.error("[cadastre-lite] Commune lookup error");
    return null;
  }
}

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
    const resCommune = await fetch(urlCommune);
    statusCommune = resCommune.status;

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
        return {
          success: true,
          level: "commune",
          geojson,
          statusCommune,
        };
      }
    }
  } catch {
    console.error("[cadastre-lite] Commune GeoJSON loading error");
  }

  try {
    const resDep = await fetch(urlDepartement);
    statusDepartement = resDep.status;

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
        return {
          success: true,
          level: "departement",
          geojson,
          statusCommune,
          statusDepartement,
        };
      }
    }
  } catch {
    console.error("[cadastre-lite] Departement GeoJSON loading error");
  }

  return {
    success: false,
    error: "NO_GEOJSON",
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

  return {
    id,
    code_commune: commune.code,
    nom_commune: commune.nom,
    section,
    numero,
    surface_m2: surface,
    geometry: bestFeature.geometry,
  };
}

async function upsertParcelIntoCache(parcel: EtalabParcel): Promise<any> {
  if (!parcel.id) {
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
    console.error("[cadastre-lite] Cache upsert error");
    return parcel;
  }

  return data;
}

async function fetchPluForParcel(
  parcelId: string,
): Promise<any | null> {
  try {
    const { data, error } = await supabase.rpc(
      "plu_get_for_parcelle",
      { p_parcelle_id: parcelId },
    );

    if (error) {
      console.error("[cadastre-lite] PLU lookup error");
      return null;
    }

    return data;
  } catch {
    console.error("[cadastre-lite] PLU lookup exception");
    return null;
  }
}