// supabase/functions/cadastre-lite/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

console.log("✅ cadastre-lite – function loaded");

// -----------------------------
// Types
// -----------------------------
type CadastreLiteRequest = {
  mode: "point";
  lat: number;
  lon: number;
  include_plu?: boolean;
};

type EtalabCommune = {
  // code INSEE normalisé (ex : 75056 pour Paris)
  code: string;
  codeDepartement: string;
  nom: string;
  // code utilisé par le cadastre Etalab (ex : 75107 pour Paris 7e)
  codeCadastre?: string;
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

// -----------------------------
// HTTP server
// -----------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as CadastreLiteRequest;

    if (body.mode === "point") {
      return await handlePoint(body);
    }

    return jsonResponse({ success: false, error: "INVALID_MODE" }, 400);
  } catch (err) {
    console.error("❌ cadastre-lite global error:", err);
    return jsonResponse(
      { success: false, error: "INTERNAL_ERROR", details: String(err) },
      500,
    );
  }
});

// =================================================
// Handler : MODE POINT
// =================================================
async function handlePoint(body: CadastreLiteRequest): Promise<Response> {
  const { lat, lon, include_plu = false } = body;

  console.log("📍 handlePoint:", { lat, lon, include_plu });

  // 1) Commune via geo.api.gouv.fr (avec normalisation Paris)
  const commune = await getCommuneFromLatLon(lat, lon);
  if (!commune) {
    return jsonResponse(
      { success: false, error: "NO_COMMUNE_FOUND" },
      404,
    );
  }

  console.log("🌍 handlePoint – commune:", commune);

  // 2) Parcelles via Etalab (GeoJSON.gz)
  //    👉 On utilise le code cadastre (arrondissement pour Paris), sinon le code normalisé
  const codeForCadastre = commune.codeCadastre ?? commune.code;

  const download = await downloadParcellesGeoJSONWithFallback(
    codeForCadastre,
    commune.codeDepartement,
  );

  if (!download.success) {
    console.error("❌ NO_GEOJSON details:", download);
    return jsonResponse(
      {
        success: false,
        error: "NO_GEOJSON",
        commune,
        debug: download,
      },
      500,
    );
  }

  const geojson = download.geojson;
  console.log(
    `✅ GeoJSON chargé (${download.level}) depuis ${download.url} avec ${
      geojson.features.length
    } features`,
  );

  // 3) Choisir la parcelle la plus proche du point
  const parcel = pickNearestParcel(geojson, lat, lon, commune);
  if (!parcel) {
    return jsonResponse(
      { success: false, error: "NO_PARCEL_FOUND", commune },
      404,
    );
  }

  // 4) Upsert dans le cache
  const cached = await upsertParcelIntoCache(parcel);

  // 5) PLU (optionnel)
  let plu: any = null;
  if (include_plu && cached && cached.id) {
    plu = await fetchPluForParcel(cached.id as string);
  }

  return jsonResponse({
    success: true,
    source: "etalab",
    commune,
    parcel: cached,
    plu,
  });
}

// =================================================
// JSON helper
// =================================================
function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

// =================================================
// Etalab helpers – commune via geo.api.gouv.fr
// =================================================

/**
 * Recherche la commune correspondante à un point (lat, lon)
 * via l'API publique geo.api.gouv.fr
 *
 * - code         → INSEE normalisé (ex: 75056 pour Paris)
 * - codeCadastre → INSEE brut Etalab (ex: 75107 pour Paris 7e)
 */
async function getCommuneFromLatLon(
  lat: number,
  lon: number,
): Promise<EtalabCommune | null> {
  const url =
    `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&format=json`;

  console.log("🌍 getCommuneFromLatLon URL:", url);

  try {
    const res = await fetch(url);
    console.log("🌍 getCommuneFromLatLon status:", res.status);

    if (!res.ok) {
      console.error("❌ getCommuneFromLatLon HTTP error:", res.status);
      return null;
    }

    const json = await res.json();
    console.log("🌍 getCommuneFromLatLon raw json:", json);

    if (!Array.isArray(json) || json.length === 0) {
      console.warn("⚠️ getCommuneFromLatLon: aucune commune trouvée (array vide)");
      return null;
    }

    const c = json[0];
    console.log("🌍 getCommuneFromLatLon first item:", c);

    if (!c.code || !c.codeDepartement) {
      console.warn(
        "⚠️ getCommuneFromLatLon: réponse incomplète (pas de code ou codeDepartement)",
        c,
      );
      return null;
    }

    const rawCode = c.code as string;
    const depCode = c.codeDepartement as string;

    // 🔧 Normalisation spéciale Paris : arrondissements 75101–75120 → 75056
    let normalizedCode = rawCode;
    if (depCode === "75" && rawCode.startsWith("751")) {
      console.log(
        "ℹ️ Normalisation Paris : arrondissement",
        rawCode,
        "→ 75056",
      );
      normalizedCode = "75056";
    }

    const commune: EtalabCommune = {
      code: normalizedCode, // code INSEE normalisé pour Mimmoza / PLU / DVF
      codeDepartement: depCode,
      nom: c.nom ?? "",
      codeCadastre: rawCode, // code utilisé par le cadastre (arrondissement)
    };

    console.log("✅ Commune trouvée (normalisée + cadastre):", commune);
    return commune;
  } catch (e) {
    console.error("❌ Exception getCommuneFromLatLon:", e);
    return null;
  }
}

// =================================================
// Etalab helpers – parcelles GeoJSON (commune + fallback département)
// =================================================

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
    console.log("🌍 Tentative commune Etalab:", urlCommune);
    const resCommune = await fetch(urlCommune);
    statusCommune = resCommune.status;
    console.log(
      "🌍 downloadParcellesGeoJSON commune status:",
      statusCommune,
    );

    if (resCommune.ok && resCommune.body) {
      const ds = new DecompressionStream("gzip");
      const decompressedStream = resCommune.body.pipeThrough(ds);
      const text = await new Response(decompressedStream).text();

      const geojson = JSON.parse(text);
      if (
        geojson && geojson.type === "FeatureCollection" &&
        Array.isArray(geojson.features)
      ) {
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
    console.error("❌ Erreur commune Etalab:", e);
  }

  // Fallback département
  try {
    console.log("🌍 Tentative département Etalab:", urlDepartement);
    const resDep = await fetch(urlDepartement);
    statusDepartement = resDep.status;
    console.log(
      "🌍 downloadParcellesGeoJSON département status:",
      statusDepartement,
    );

    if (resDep.ok && resDep.body) {
      const ds = new DecompressionStream("gzip");
      const decompressedStream = resDep.body.pipeThrough(ds);
      const text = await new Response(decompressedStream).text();

      const geojson = JSON.parse(text);
      if (
        geojson && geojson.type === "FeatureCollection" &&
        Array.isArray(geojson.features)
      ) {
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
    console.error("❌ Erreur département Etalab:", e);
  }

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
      "⚠️ pickNearestParcel: aucune parcelle trouvée proche du point",
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
    code_commune: commune.code, // on garde le code normalisé pour Mimmoza
    nom_commune: commune.nom,
    section,
    numero,
    surface_m2: surface,
    geometry: bestFeature.geometry,
  };

  console.log("✅ Parcelle choisie (Etalab):", parcel.id);
  return parcel;
}

// =================================================
// Cache : upsert dans cadastre_parcelles_cache
// =================================================
async function upsertParcelIntoCache(parcel: EtalabParcel): Promise<any> {
  if (!parcel.id) {
    console.warn("⚠️ parcel sans id → pas d'upsert cache");
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
    console.error("❌ upsertParcelIntoCache error:", error);
    return parcel; // fallback
  }

  return data;
}

// =================================================
// PLU : appel du RPC plu_get_for_parcelle
// =================================================
async function fetchPluForParcel(
  parcelId: string,
): Promise<any | null> {
  try {
    const { data, error } = await supabase.rpc(
      "plu_get_for_parcelle",
      { p_parcelle_id: parcelId },
    );

    if (error) {
      console.error("❌ fetchPluForParcel error:", error);
      return null;
    }

    return data;
  } catch (err) {
    console.error("❌ fetchPluForParcel exception:", err);
    return null;
  }
}
