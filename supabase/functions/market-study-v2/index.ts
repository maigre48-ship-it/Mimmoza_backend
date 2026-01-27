import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  lat: number;
  lng: number;
  commune_insee?: string;
  max_age_days?: number;
  // optionnel: réglages des rayons
  radius_km_urban?: number; // défaut 5
  radius_km_rural?: number; // défaut 20
  is_urban?: boolean; // si le front veut forcer
};

type InseePayload = {
  commune_name?: string;
  department_code?: string;
  region_code?: string;
  source_year?: number;
  population?: number;
  age_pyramid?: Record<string, number>;
  unemployment_rate_pct?: number;
  poverty_rate_pct?: number;
  owners_pct?: number;
  renters_pct?: number;
  median_income_eur?: number;
  raw_json?: any;
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

async function safeJson(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

// --- utilitaire: clamp ---
function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

// --- tags utiles uniquement (évite payload gigantesque) ---
function pickUsefulTags(tags: Record<string, string>) {
  const keep = [
    "amenity",
    "shop",
    "healthcare",
    "opening_hours",
    "wheelchair",
    "phone",
    "contact:phone:FR",
    "website",
    "ref:FR:FINESS",
    "ref:FR:SIRET",
    "addr:housenumber",
    "addr:street",
    "addr:postcode",
    "addr:city",
  ];
  const out: Record<string, string> = {};
  for (const k of keep) if (tags[k]) out[k] = tags[k];
  return out;
}

/**
 * Résolution INSEE + nom commune depuis lat/lng via geo.api.gouv.fr
 */
async function resolveCommuneFromLatLng(lat: number, lng: number) {
  const url =
    `https://geo.api.gouv.fr/communes?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&fields=nom,code,departement,region&format=json&geometry=centre`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    return {
      insee: null as string | null,
      commune: null as string | null,
      dep: null as string | null,
      region: null as string | null,
    };
  }

  const arr = (await res.json()) as any[];
  const c = Array.isArray(arr) && arr.length ? arr[0] : null;
  return {
    insee: c?.code ?? null,
    commune: c?.nom ?? null,
    dep: c?.departement?.code ?? null,
    region: c?.region?.code ?? null,
  };
}

/**
 * Overpass: récupère des POI par catégories autour d'un point
 */
type AmenityPoi = {
  category: string;
  osm_type: "node" | "way" | "relation";
  osm_id: number;
  name?: string;
  lat: number;
  lng: number;
  tags?: Record<string, string>;
};

function buildOverpassQuery(lat: number, lng: number, radiusMeters: number) {
  return `
[out:json][timeout:25];
(
  // Santé
  node(around:${radiusMeters},${lat},${lng})[amenity=pharmacy];
  way(around:${radiusMeters},${lat},${lng})[amenity=pharmacy];
  node(around:${radiusMeters},${lat},${lng})[amenity=hospital];
  way(around:${radiusMeters},${lat},${lng})[amenity=hospital];
  node(around:${radiusMeters},${lat},${lng})[amenity=clinic];
  way(around:${radiusMeters},${lat},${lng})[amenity=clinic];
  node(around:${radiusMeters},${lat},${lng})[healthcare];
  way(around:${radiusMeters},${lat},${lng})[healthcare];

  // Éducation / petite enfance
  node(around:${radiusMeters},${lat},${lng})[amenity=school];
  way(around:${radiusMeters},${lat},${lng})[amenity=school];
  node(around:${radiusMeters},${lat},${lng})[amenity=kindergarten];
  way(around:${radiusMeters},${lat},${lng})[amenity=kindergarten];
  node(around:${radiusMeters},${lat},${lng})[amenity=childcare];
  way(around:${radiusMeters},${lat},${lng})[amenity=childcare];

  // Sécurité / services
  node(around:${radiusMeters},${lat},${lng})[amenity=police];
  way(around:${radiusMeters},${lat},${lng})[amenity=police];
  node(around:${radiusMeters},${lat},${lng})[amenity=post_office];
  way(around:${radiusMeters},${lat},${lng})[amenity=post_office];

  // Banque
  node(around:${radiusMeters},${lat},${lng})[amenity=bank];
  way(around:${radiusMeters},${lat},${lng})[amenity=bank];
  node(around:${radiusMeters},${lat},${lng})[amenity=atm];
  way(around:${radiusMeters},${lat},${lng})[amenity=atm];

  // Carburant
  node(around:${radiusMeters},${lat},${lng})[amenity=fuel];
  way(around:${radiusMeters},${lat},${lng})[amenity=fuel];

  // Commerce (exemples)
  node(around:${radiusMeters},${lat},${lng})[shop=supermarket];
  way(around:${radiusMeters},${lat},${lng})[shop=supermarket];
  node(around:${radiusMeters},${lat},${lng})[shop=convenience];
  way(around:${radiusMeters},${lat},${lng})[shop=convenience];
);
out center tags;
`;
}

function categorize(tags: Record<string, string>) {
  const amenity = tags["amenity"];
  const shop = tags["shop"];
  const healthcare = tags["healthcare"];

  if (amenity === "pharmacy") return "pharmacy";
  if (amenity === "hospital") return "hospital";
  if (amenity === "clinic") return "clinic";
  if (healthcare) return `healthcare:${healthcare}`;

  if (amenity === "school") return "school";
  if (amenity === "kindergarten") return "kindergarten";
  if (amenity === "childcare") return "childcare";

  if (amenity === "police") return "police";
  if (amenity === "post_office") return "post_office";

  if (amenity === "bank") return "bank";
  if (amenity === "atm") return "atm";

  if (amenity === "fuel") return "fuel";

  if (shop === "supermarket") return "supermarket";
  if (shop === "convenience") return "convenience";

  if (amenity) return `amenity:${amenity}`;
  if (shop) return `shop:${shop}`;
  return "other";
}

async function fetchAmenitiesOverpass(
  lat: number,
  lng: number,
  radiusMeters: number,
) {
  const endpoint =
    Deno.env.get("OVERPASS_ENDPOINT") ?? "https://overpass-api.de/api/interpreter";

  const query = buildOverpassQuery(lat, lng, radiusMeters);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      accept: "application/json",
    },
    body: new URLSearchParams({ data: query }),
  });

  if (!res.ok) {
    const err = await res.text();
    return {
      ok: false,
      error: `overpass ${res.status}`,
      details: err,
      radius_m: radiusMeters,
      pois: [] as AmenityPoi[],
      counts: {} as Record<string, number>,
    };
  }

  const data = (await res.json()) as any;
  const elements = Array.isArray(data?.elements) ? data.elements : [];

  const pois: AmenityPoi[] = [];
  const counts: Record<string, number> = {};

  for (const el of elements) {
    const tags = (el?.tags ?? {}) as Record<string, string>;
    const category = categorize(tags);

    const pLat = typeof el?.lat === "number" ? el.lat : el?.center?.lat;
    const pLng = typeof el?.lon === "number" ? el.lon : el?.center?.lon;
    if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) continue;

    const poi: AmenityPoi = {
      category,
      osm_type: el.type,
      osm_id: el.id,
      name: tags["name"],
      lat: pLat,
      lng: pLng,
      tags: pickUsefulTags(tags), // <-- filtrage tags
    };

    pois.push(poi);
    counts[category] = (counts[category] ?? 0) + 1;
  }

  // Limiter le volume renvoyé (configurable par secret/env)
  const MAX_POIS = Number(Deno.env.get("MARKET_MAX_POIS") ?? 200);
  const trimmed = pois.slice(0, MAX_POIS);

  return { ok: true, radius_m: radiusMeters, pois: trimmed, counts };
}

/**
 * Fallback INSEE sans clés.
 */
async function fetchInseeStatsExternalFallback(
  insee: string,
  communeNom?: string | null,
  dep?: string | null,
  region?: string | null,
): Promise<InseePayload> {
  return {
    commune_name: communeNom ?? undefined,
    department_code: dep ?? insee.slice(0, 2),
    region_code: region ?? undefined,
    raw_json: { note: "fallback-no-insee-keys", insee },
  };
}

/**
 * BDM (SDMX) - dernière observation pour une liste d'idbanks
 * NOTE: BDM n'utilise pas OAuth ici, endpoint public SDMX.
 */
type BdmLastPoint = {
  idbank: string;
  time_period: string | null;
  value: number | null;
};

async function fetchBdmLastObservations(
  idbanks: string[],
): Promise<BdmLastPoint[]> {
  const safe = idbanks.filter(Boolean);
  if (!safe.length) return [];

  // IMPORTANT: lastObservations n'est pas accepté -> utiliser firstNObservations
  const url =
    `https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/${safe.join("+")}?firstNObservations=1`;

  const res = await fetch(url, {
    headers: {
      "accept": "application/vnd.sdmx.structurespecificdata+xml;version=2.1",
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`BDM error ${res.status}: ${txt.slice(0, 500)}`);
  }

  const xml = await res.text();

  // Parsing plus robuste : on cherche le <Series ... IDBANK="xxx" ...> puis le premier <Obs ...>
  const out: BdmLastPoint[] = [];
  for (const idbank of safe) {
    const reSeries = new RegExp(
      `<Series\\b[^>]*(?:SERIES_IDBANK|IDBANK)="${idbank}"[\\s\\S]*?<Obs\\b[^>]*>`,
      "i",
    );
    const m = xml.match(reSeries);

    if (m) {
      const obsTag = m[0].match(/<Obs\\b[^>]*>/i)?.[0] ?? null;
      if (!obsTag) {
        out.push({ idbank, time_period: null, value: null });
        continue;
      }
      const t = obsTag.match(/\bTIME_PERIOD="([^"]+)"/i)?.[1] ?? null;
      const vRaw = obsTag.match(/\bOBS_VALUE="([^"]+)"/i)?.[1] ?? null;
      const v = vRaw != null && vRaw !== "" &&
          Number.isFinite(Number(vRaw))
        ? Number(vRaw)
        : null;
      out.push({ idbank, time_period: t, value: v });
      continue;
    }

    // Fallback tolérant (structure variable)
    const idx = xml.indexOf(idbank);
    if (idx < 0) {
      out.push({ idbank, time_period: null, value: null });
      continue;
    }
    const obsMatch = xml.slice(idx).match(/<Obs\b[^>]*>/i);
    if (!obsMatch) {
      out.push({ idbank, time_period: null, value: null });
      continue;
    }

    const obsTag = obsMatch[0];
    const t = obsTag.match(/\bTIME_PERIOD="([^"]+)"/i)?.[1] ?? null;
    const vRaw = obsTag.match(/\bOBS_VALUE="([^"]+)"/i)?.[1] ?? null;
    const v = vRaw != null && vRaw !== "" &&
        Number.isFinite(Number(vRaw))
      ? Number(vRaw)
      : null;

    out.push({ idbank, time_period: t, value: v });
  }

  return out;
}

function mapBdmToInseePayload(
  communeNom: string | null,
  dep: string | null,
  region: string | null,
  bdm: Record<string, BdmLastPoint | undefined>,
): InseePayload {
  const population = bdm.population?.value ?? null;
  const unemployment = bdm.unemployment_rate_pct?.value ?? null;
  const income = bdm.median_income_eur?.value ?? null;

  return {
    commune_name: communeNom ?? undefined,
    department_code: dep ?? undefined,
    region_code: region ?? undefined,
    population: population != null ? Math.round(population) : undefined,
    unemployment_rate_pct: unemployment != null ? Number(unemployment) : undefined,
    median_income_eur: income != null ? Math.round(income) : undefined,
    raw_json: {
      source: "bdm_sdmx_lastObservations",
      bdm,
    },
  };
}

async function safeRpc<T>(
  supabase: any,
  fn: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) return null;
    return (data ?? null) as T | null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResponse({ ok: true });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse(
        {
          error: "missing env",
          details:
            "SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY not set in secrets",
        },
        500,
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const body = (await req.json()) as ReqBody;
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const maxAgeDays = Number(body.max_age_days ?? 30);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return jsonResponse({ error: "lat/lng invalid" }, 400);
    }

    // Resolve commune
    let communeInsee = body.commune_insee ?? null;
    let communeNom: string | null = null;
    let dep: string | null = null;
    let region: string | null = null;

    const r = await resolveCommuneFromLatLng(lat, lng);
    if (!communeInsee) communeInsee = r.insee;
    communeNom = r.commune;
    dep = r.dep;
    region = r.region;

    if (!communeInsee) {
      return jsonResponse({ error: "commune_insee not resolved" }, 422);
    }

    const inseeCached = await safeRpc<any>(supabase, "get_insee_commune_stats", {
      p_insee_code: communeInsee,
      p_max_age_days: maxAgeDays,
    });

    let inseeStats = inseeCached;

    // max_age_days = 0 force le refresh (utile pour debug)
    const shouldRefresh =
      maxAgeDays <= 0 ||
      !inseeCached ||
      (typeof inseeCached === "object" &&
        ((inseeCached as any).found === false ||
          (inseeCached as any).stale === true));

    // --- BDM V1 (à compléter avec les bons idbanks) ---
    const BDM_IDBANKS: Record<string, string> = {
      // TODO: remplacer par les bons idbanks BDM
      population: "010536463",
      unemployment_rate_pct: "",
      median_income_eur: "",
    };

    if (shouldRefresh) {
      let fresh: InseePayload | null = null;

      // 1) Tentative BDM si au moins 1 idbank présent
      try {
        const wanted = Object.values(BDM_IDBANKS).filter(Boolean);
        if (wanted.length) {
          const points = await fetchBdmLastObservations(wanted);

          const byField: Record<string, BdmLastPoint | undefined> = {
            population: points.find((p) => p.idbank === BDM_IDBANKS.population),
            unemployment_rate_pct: points.find((p) => p.idbank === BDM_IDBANKS.unemployment_rate_pct),
            median_income_eur: points.find((p) => p.idbank === BDM_IDBANKS.median_income_eur),
          };

          fresh = mapBdmToInseePayload(communeNom, dep, region, byField);
        }
      } catch (e) {
        // Debug: expose l'erreur BDM dans raw_json (remote-only)
        fresh = {
          commune_name: communeNom ?? undefined,
          department_code: dep ?? undefined,
          region_code: region ?? undefined,
          raw_json: {
            source: "bdm_error",
            message: String(e),
            idbanks: Object.values(BDM_IDBANKS).filter(Boolean),
          },
        };
      }

      // 2) Fallback minimal si BDM pas prêt / aucun idbank
      if (!fresh) {
        fresh = await fetchInseeStatsExternalFallback(
          communeInsee,
          communeNom,
          dep,
          region,
        );
      }

      await safeRpc<any>(supabase, "upsert_insee_commune_stats", {
        p_insee_code: communeInsee,
        p_payload: {
          ...fresh,
          raw_json: fresh.raw_json ?? fresh,
        },
      });

      const reread = await safeRpc<any>(supabase, "get_insee_commune_stats", {
        p_insee_code: communeInsee,
        p_max_age_days: maxAgeDays,
      });

      if (reread) inseeStats = reread;
      else inseeStats = fresh;
    }

    const transport = await safeRpc<any>(
      supabase,
      "get_transport_score_aggregated_light",
      { lat, lng },
    );

    const smartscore = await safeRpc<any>(
      supabase,
      "compute_smartscore_v1_light",
      { lat, lng },
    );

    // Rayon amenities (par défaut: urbain 5km / rural 20km)
    const radiusUrbanKm = clamp(Number(body.radius_km_urban ?? 5), 0.5, 5);
    const radiusRuralKm = clamp(Number(body.radius_km_rural ?? 20), 1, 20);

    const isUrban = typeof body.is_urban === "boolean" ? body.is_urban : true;
    const radiusMeters = Math.round(
      (isUrban ? radiusUrbanKm : radiusRuralKm) * 1000,
    );

    const amenities = await fetchAmenitiesOverpass(lat, lng, radiusMeters);

    return jsonResponse({
      meta: {
        lat,
        lng,
        commune_insee: communeInsee,
        commune_nom: (inseeStats as any)?.commune_name ?? communeNom,
        cache: { max_age_days: maxAgeDays },
        radius_m: radiusMeters,
      },
      transport,
      smartscore,
      commune_insee_stats: inseeStats,
      amenities,
    });
  } catch (e) {
    return jsonResponse({ error: "unexpected", details: String(e) }, 500);
  }
});
