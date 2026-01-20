// supabase/functions/promoteur-from-parcelle-v3/index.ts
// Version : promoteur-from-parcelle-v3 (Robust national: IDF + Etalab)
//
// Corrections cles :
// - Ne jamais appeler .trim() sur une valeur non-string (commune_insee peut etre number)
// - Deduction best-effort de commune_insee (body, parcel, parcel_id)
// - Normalisation GeoJSON: accepte Feature/Geometry, rejette FeatureCollection
// - Logs d'erreur utiles + debug stable
// - Ne pas bloquer le front si PLU absent: success=true + plu_status explicite
// - FIX MAJEUR: si la strategie "parcel" echoue (ZONE_NOT_FOUND), on RETENTE via get_plu_rules_for_geom_v1
//   en reutilisant la geometry renvoyee par le moteur parcelle (plu-from-parcelle-v2 / get_plu_rules_for_parcelle_v2)
//
// PATCH v3.1 (stabilite prod):
// - Normalisation INSEE stricte (5 digits) partout
// - Retry geom: detection ZONE_NOT_FOUND elargie (plu.reason + wrapper raw)
// - Extraction geometry du parcel-engine plus robuste
// - assumptions_override: ignore si non-object
// - plu_engine_source final coherent
//
// PATCH v3.2 (boot & bilan fix):
// - Lecture env SB_* en priorite (SB_URL, SB_SERVICE_ROLE_KEY) avec fallback SUPABASE_*
// - Si env manquants: reponse JSON 500 propre (pas de throw)
// - Correction appel computeBilanPromoteur: sdp_m2 (pas sdp_totale_m2), null si absent
//
// PATCH v3.3 (normalisation reponse):
// - Structure unifiee: { version, success, data?, error? }
// - success=true => data present, error absent
// - success=false => error present, data absent

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

import {
  computeBilanPromoteur,
  getDefaultAssumptions,
  mergeAssumptions,
} from "./bilan.ts";

// -----------------------------------------------------------------------------
// Environment variables (SB_* prioritaire, fallback SUPABASE_*)
// -----------------------------------------------------------------------------
function getEnvVar(sbKey: string, supabaseKey: string): string {
  return (Deno.env.get(sbKey) ?? Deno.env.get(supabaseKey) ?? "").trim();
}

const SUPABASE_URL = getEnvVar("SB_URL", "SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = getEnvVar("SB_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY");

// -----------------------------------------------------------------------------
// Supabase client (lazy init to allow graceful error response)
// -----------------------------------------------------------------------------
let supabase: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
  if (supabase) return supabase;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return supabase;
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
type MassingBlock = {
  id: string;
  label: string;
  height_m: number;
  floors: number;
  footprint_m2: number;
};

type MassingSpec = {
  enabled: boolean;
  reason?: string | null;
  ground_footprint_m2: number | null;
  max_emprise_m2: number | null;
  max_height_m: number | null;
  blocks: MassingBlock[];
};

type PromoteurFromParcelleInputs = {
  parcel_id?: unknown;
  commune_insee?: unknown;
  surface_terrain_m2?: unknown;
  parcel_geojson?: unknown;
  parcel?: unknown;

  massing?: { sdp_m2?: unknown } | null;
  implantation?: { sdp_m2?: unknown } | null;

  assumptions_override?: Record<string, unknown> | null;

  address?: unknown;
  postal_code?: unknown;
};

// -----------------------------------------------------------------------------
// Response helpers (format unifie)
// -----------------------------------------------------------------------------
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function successResponse(data: Record<string, unknown>, status = 200) {
  return jsonResponse(
    {
      version: "promoteur-from-parcelle-v3",
      success: true,
      data,
    },
    status
  );
}

function errorResponse(
  code: string,
  message: string,
  status = 500,
  details?: unknown
) {
  const errorPayload: { code: string; message: string; details?: unknown } = {
    code,
    message,
  };
  if (details !== undefined && details !== null) {
    errorPayload.details = details;
  }
  return jsonResponse(
    {
      version: "promoteur-from-parcelle-v3",
      success: false,
      error: errorPayload,
    },
    status
  );
}

// -----------------------------------------------------------------------------
// Helpers robustes
// -----------------------------------------------------------------------------
function asTrimmedString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function normalizeInsee(v: unknown): string | null {
  const s = asTrimmedString(v);
  if (!s) return null;
  const m = s.match(/(\d{5})/);
  return m?.[1] ?? null;
}

function toNumberLoose(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(",", ".");
    const m = s.match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }
  if (v !== null && v !== undefined) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractInseeFromParcelId(parcelId: string | null): string | null {
  const s = asTrimmedString(parcelId);
  if (!s) return null;
  const m = s.match(/^(\d{5})/);
  return m?.[1] ?? null;
}

function normalizeGeojsonGeometry(
  input: unknown
): { geom: Record<string, unknown> | null; reason?: string } {
  if (!input || typeof input !== "object") {
    return { geom: null, reason: "GEOJSON_EMPTY" };
  }

  const obj = input as Record<string, unknown>;
  const t = obj.type;

  if (t === "FeatureCollection") {
    return { geom: null, reason: "GEOJSON_FEATURECOLLECTION_NOT_ALLOWED" };
  }

  if (t === "Feature") {
    const geom = obj.geometry;
    if (
      geom &&
      typeof geom === "object" &&
      typeof (geom as Record<string, unknown>).type === "string"
    ) {
      return { geom: geom as Record<string, unknown> };
    }
    return { geom: null, reason: "GEOJSON_FEATURE_NO_GEOMETRY" };
  }

  if (typeof t === "string" && (obj.coordinates || t === "GeometryCollection")) {
    return { geom: obj };
  }

  return { geom: null, reason: "GEOJSON_UNSUPPORTED_SHAPE" };
}

function normalizePluRules(rules: unknown): {
  rules: Record<string, unknown> | null;
  normalized: boolean;
  derived: {
    implantation_from_reculs_alignements: boolean;
    hauteur_max_derived: boolean;
    stationnement_derived: boolean;
  };
} {
  if (!rules || typeof rules !== "object") {
    return {
      rules: rules ? (rules as Record<string, unknown>) : null,
      normalized: false,
      derived: {
        implantation_from_reculs_alignements: false,
        hauteur_max_derived: false,
        stationnement_derived: false,
      },
    };
  }

  const src = rules as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };

  let implantationDerived = false;
  const imp = (out.implantation as Record<string, unknown> | null) ?? null;
  const rec =
    ((out.reculs_alignements ??
      out.alignement ??
      out.reculs ??
      null) as Record<string, unknown> | null);

  if (!imp && rec) {
    const a =
      toNumberLoose(
        rec?.recul_avant_m ??
          rec?.recul_voie_m ??
          rec?.recul_alignement_m ??
          rec?.recul_alignement ??
          null
      ) ?? null;

    const l =
      toNumberLoose(
        rec?.recul_lateral_m ??
          rec?.recul_limites_m ??
          rec?.recul_lateral ??
          null
      ) ?? null;

    const f =
      toNumberLoose(
        rec?.recul_fond_m ??
          rec?.recul_arriere_m ??
          rec?.recul_fond ??
          rec?.recul_arriere ??
          null
      ) ?? null;

    out.implantation = {
      recul_voie: a,
      recul_lateral: l,
      recul_fond: f,
      _source: "derived_from_reculs_alignements",
    };
    implantationDerived = true;
  } else if (imp) {
    out.implantation = {
      ...imp,
      recul_voie:
        imp?.recul_voie ??
        imp?.retrait_voie ??
        imp?.avant ??
        imp?.recul_avant_m ??
        null,
      recul_lateral:
        imp?.recul_lateral ??
        imp?.retrait_lateral ??
        imp?.lateral ??
        imp?.recul_lateral_m ??
        null,
      recul_fond:
        imp?.recul_fond ?? imp?.retrait_fond ?? imp?.fond ?? imp?.recul_fond_m ?? null,
      _source: imp?._source ?? "rpc",
    };
  }

  let hauteurDerived = false;
  if (out.hauteur && typeof out.hauteur === "object") {
    const h = out.hauteur as Record<string, unknown>;
    const max = toNumberLoose(
      h?.max_hauteur_m ?? h?.hauteur_max_m ?? h?.hauteur_max ?? h?.h_max ?? null
    );
    if (max != null && (h?.max_hauteur_m == null || h?.max_hauteur_m === "")) {
      out.hauteur = { ...h, max_hauteur_m: max };
      hauteurDerived = true;
    }
  }

  let stationnementDerived = false;
  if (out.stationnement && typeof out.stationnement === "object") {
    const p = out.stationnement as Record<string, unknown>;
    out.stationnement = {
      ...p,
      places_par_logement:
        p?.places_par_logement ?? p?.ratio_logement ?? p?.par_logement ?? null,
      places_par_100m2:
        p?.places_par_100m2 ?? p?.ratio_100m2 ?? p?.par_100m2 ?? null,
      surface_par_place_m2: p?.surface_par_place_m2 ?? 25,
    };
  } else {
    const alt = (out.parking_rules ?? out.parkings ?? null) as
  | Record<string, unknown>
  | null;
    if (alt && typeof alt === "object") {
      out.stationnement = {
        places_par_logement:
          alt?.places_par_logement ?? alt?.ratio_logement ?? alt?.par_logement ?? null,
        places_par_100m2:
          alt?.places_par_100m2 ?? alt?.ratio_100m2 ?? alt?.par_100m2 ?? null,
        surface_par_place_m2: alt?.surface_par_place_m2 ?? 25,
        _source: "derived_from_alt_parking_rules",
      };
      stationnementDerived = true;
    }
  }

  return {
    rules: out,
    normalized: true,
    derived: {
      implantation_from_reculs_alignements: implantationDerived,
      hauteur_max_derived: hauteurDerived,
      stationnement_derived: stationnementDerived,
    },
  };
}

function buildMassingV0(
  pluRules: Record<string, unknown> | null,
  surfaceTerrainM2: number | null
): MassingSpec {
  if (!surfaceTerrainM2 || surfaceTerrainM2 <= 0) {
    return {
      enabled: false,
      reason: "SURFACE_TERRAIN_INVALIDE",
      ground_footprint_m2: null,
      max_emprise_m2: null,
      max_height_m: null,
      blocks: [],
    };
  }

  if (!pluRules) {
    return {
      enabled: false,
      reason: "PLU_RULES_ABSENTS",
      ground_footprint_m2: null,
      max_emprise_m2: null,
      max_height_m: null,
      blocks: [],
    };
  }

  let empriseRatio: number | null = null;
  const emprise = pluRules?.emprise as Record<string, unknown> | undefined;
  const rawEmprise = emprise?.emprise_max_ratio;

  if (typeof rawEmprise === "number") empriseRatio = rawEmprise;
  else if (typeof rawEmprise === "string" && rawEmprise.trim() !== "") {
    const n = Number(rawEmprise.replace(",", "."));
    if (!Number.isNaN(n)) empriseRatio = n;
  }

  if (empriseRatio !== null && empriseRatio > 1) empriseRatio = empriseRatio / 100;
  if (!empriseRatio || empriseRatio <= 0 || empriseRatio > 1) empriseRatio = 0.35;

  const footprint = surfaceTerrainM2 * empriseRatio;

  let hauteurMaxM: number | null = null;
  const hauteur = pluRules?.hauteur as Record<string, unknown> | undefined;
  const rawHauteur = hauteur?.max_hauteur_m;

  if (typeof rawHauteur === "number" && rawHauteur > 0) hauteurMaxM = rawHauteur;
  else if (typeof rawHauteur === "string" && rawHauteur.trim() !== "") {
    const n = Number(rawHauteur.replace(",", "."));
    if (!Number.isNaN(n) && n > 0) hauteurMaxM = n;
  } else hauteurMaxM = 9;

  const effectiveHeight = hauteurMaxM ?? 9;
  const floors = Math.max(1, Math.round(effectiveHeight / 3));

  const block: MassingBlock = {
    id: "B1",
    label: "Volume principal",
    height_m: effectiveHeight,
    floors,
    footprint_m2: footprint,
  };

  return {
    enabled: true,
    reason: null,
    ground_footprint_m2: footprint,
    max_emprise_m2: footprint,
    max_height_m: effectiveHeight,
    blocks: [block],
  };
}

function upperReason(v: unknown): string {
  const s = asTrimmedString(v);
  return (s ?? "").toUpperCase();
}

function isZoneNotFoundReason(reasonUpper: string): boolean {
  if (!reasonUpper) return false;
  return (
    reasonUpper.includes("ZONE_NOT_FOUND") ||
    reasonUpper.includes("PLU_ZONE_NOT_FOUND") ||
    reasonUpper.includes("NO_ZONE") ||
    reasonUpper.includes("ZONE_UNMATCHED")
  );
}

function extractGeomFromParcelEngine(data: unknown): unknown | null {
  if (!data || typeof data !== "object") return null;

  const d = data as Record<string, unknown>;
  const parcel = d?.parcel as Record<string, unknown> | undefined;
  const debug = d?.debug as Record<string, unknown> | undefined;
  const rawPluEngine = d?.raw_plu_engine as Record<string, unknown> | undefined;
  const debugRawPluEngine = debug?.raw_plu_engine as Record<string, unknown> | undefined;
  const debugParcel = debug?.parcel as Record<string, unknown> | undefined;

  return (
    parcel?.geometry ??
    parcel?.geom ??
    d?.parcel_geojson ??
    d?.geom ??
    d?.geometry ??
    debugParcel?.geometry ??
    debugParcel?.geom ??
    debug?.parcel_geojson ??
    debug?.geom ??
    debug?.geometry ??
    (debugRawPluEngine?.parcel as Record<string, unknown> | undefined)?.geometry ??
    (debugRawPluEngine?.parcel as Record<string, unknown> | undefined)?.geom ??
    (rawPluEngine?.parcel as Record<string, unknown> | undefined)?.geometry ??
    (rawPluEngine?.parcel as Record<string, unknown> | undefined)?.geom ??
    null
  );
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "Utiliser POST avec un JSON { parcel_id?, commune_insee?, surface_terrain_m2?, parcel_geojson? }",
      405
    );
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[promoteur-from-parcelle-v3] BOOT_ERROR: Missing env vars", {
      hasUrl: !!SUPABASE_URL,
      hasKey: !!SUPABASE_SERVICE_ROLE_KEY,
    });
    return errorResponse(
      "ENV_MISSING",
      "Configuration serveur incomplete: variables d'environnement SB_URL et/ou SB_SERVICE_ROLE_KEY manquantes.",
      500,
      {
        hint: "Verifier que SB_URL et SB_SERVICE_ROLE_KEY sont definis dans l'environnement.",
      }
    );
  }

  const client = getSupabaseClient();
  if (!client) {
    return errorResponse(
      "CLIENT_INIT_FAILED",
      "Impossible d'initialiser le client Supabase.",
      500
    );
  }

  try {
    const body = (await req.json()) as PromoteurFromParcelleInputs;

    const parcelId = asTrimmedString(body.parcel_id);

    const parcelObj = body?.parcel as Record<string, unknown> | undefined;
    let communeInsee =
      normalizeInsee(body.commune_insee) ||
      normalizeInsee(parcelObj?.commune_insee) ||
      normalizeInsee(parcelObj?.code_commune) ||
      extractInseeFromParcelId(parcelId) ||
      null;

    const geoNorm = normalizeGeojsonGeometry(body.parcel_geojson);
    const geo = geoNorm.geom;

    let surfaceTerrainM2 =
      toNumberLoose(body.surface_terrain_m2) ??
      toNumberLoose(parcelObj?.surface_terrain_m2) ??
      null;

    let parcel: Record<string, unknown> | null =
      body.parcel && typeof body.parcel === "object"
        ? (body.parcel as Record<string, unknown>)
        : null;

    const usesGeomStrategy = !!geo && !!communeInsee;

    console.log("[promoteur-from-parcelle-v3] HIT", {
      parcelId,
      communeInsee,
      hasGeojson: !!geo,
      geoType: geo?.type,
      geoNormalizeReason: geo ? null : geoNorm.reason,
      usesGeomStrategy,
      surfaceTerrainM2,
      hasParcelObject: !!parcel,
      bodyKeys: body ? Object.keys(body) : [],
    });

    if (!parcelId && !usesGeomStrategy) {
      return errorResponse(
        "MISSING_INPUT",
        "Il faut au minimum un parcel_id (cadastre) ou bien (commune_insee + parcel_geojson).",
        400,
        {
          parcel_id: parcelId,
          commune_insee: communeInsee,
          has_geojson: !!geo,
          geo_reason: geoNorm.reason ?? null,
        }
      );
    }

    // ---------------------------------------------------------------------
    // 1) Enrichir la parcelle si possible (IDF)
    // ---------------------------------------------------------------------
    let cadastreRowFound = false;

    if (!parcel && parcelId) {
      const { data, error } = await client
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
          ].join(",")
        )
        .eq("id", parcelId)
        .maybeSingle();

      if (error) console.warn("Error reading cadastre_parcelles:", error.message);

      if (data) {
        cadastreRowFound = true;
        const row = data as Record<string, unknown>;

        const codeDepartement = asTrimmedString(row.code_departement) ?? "";
        const codeCommune = asTrimmedString(row.code_commune) ?? "";

        if (!communeInsee && codeDepartement && codeCommune) {
          communeInsee = normalizeInsee(`${codeDepartement}${codeCommune}`);
        }

        if (!surfaceTerrainM2) {
          const props = row.props as Record<string, unknown> | undefined;
          const contenance = toNumberLoose(props?.contenance);
          if (contenance && contenance > 0) surfaceTerrainM2 = contenance;
        }

        parcel = {
          parcel_id: row.id,
          commune_insee: communeInsee,
          commune: row.commune,
          section: row.section,
          numero: row.numero,
          surface_terrain_m2: surfaceTerrainM2,
          props: row.props ?? {},
          source: "cadastre_parcelles",
          address: asTrimmedString(body.address),
          postal_code: asTrimmedString(body.postal_code),
        };
      }
    }

    if (!parcel) {
      parcel = {
        parcel_id: parcelId,
        commune_insee: communeInsee,
        surface_terrain_m2: surfaceTerrainM2,
        source: cadastreRowFound ? "cadastre_parcelles" : "etalab_or_front",
        address: asTrimmedString(body.address),
        postal_code: asTrimmedString(body.postal_code),
      };
    }

    // ---------------------------------------------------------------------
    // 2) PLU rules
    // ---------------------------------------------------------------------
    let plu: Record<string, unknown> | null = null;
    let pluEngineSource: "geom" | "parcel" | null = null;

    let plu_status:
      | "OK"
      | "PLU_NOT_FOUND"
      | "PLU_GEOM_ERROR"
      | "PLU_PARCEL_ERROR"
      | "PLU_INPUT_MISSING"
      | "PLU_UNKNOWN" = "PLU_UNKNOWN";

    let rawPluEngine: unknown = null;

    if (usesGeomStrategy) {
      const { data, error } = await client.rpc("get_plu_rules_for_geom_v1", {
        p_commune_insee: communeInsee,
        p_parcel_geojson: geo,
      });

      if (error) {
        console.error("get_plu_rules_for_geom_v1 error:", error.message);
        plu_status = "PLU_GEOM_ERROR";
        plu = { found: false, error: error.message, source: "geom_rpc" };
      } else {
        plu = data as Record<string, unknown> | null;
        pluEngineSource = "geom";
        plu_status = plu?.found ? "OK" : "PLU_NOT_FOUND";
      }
    } else if (parcelId) {
      const { data, error } = await client.rpc("get_plu_rules_for_parcelle_v2", {
        p_parcel_id: parcelId,
      });

      if (error) {
        console.error("get_plu_rules_for_parcelle_v2 error:", error.message);
        plu_status = "PLU_PARCEL_ERROR";
        plu = { found: false, error: error.message, source: "parcel_rpc" };
      } else {
        rawPluEngine = data;
        const dataObj = data as Record<string, unknown> | null;

        const maybePlu = (dataObj?.plu ?? dataObj) as Record<string, unknown> | null;

        plu = maybePlu;
        pluEngineSource = "parcel";
        plu_status = plu?.found ? "OK" : "PLU_NOT_FOUND";

        const debugObj = dataObj?.debug as Record<string, unknown> | undefined;
        const pluObj = dataObj?.plu as Record<string, unknown> | undefined;
        const debugPluObj = debugObj?.plu as Record<string, unknown> | undefined;

        const reasonUpper =
          upperReason(plu?.reason) ||
          upperReason(dataObj?.reason) ||
          upperReason(pluObj?.reason) ||
          upperReason(debugObj?.reason) ||
          upperReason(debugPluObj?.reason);

        const isZoneNotFound = isZoneNotFoundReason(reasonUpper);

        const parcelGeomFromEngine = extractGeomFromParcelEngine(data);

        const geomNormRetry = normalizeGeojsonGeometry(parcelGeomFromEngine);
        const geomForRetry = geomNormRetry.geom;

        if (communeInsee && !plu?.found && isZoneNotFound && geomForRetry) {
          console.log(
            "[promoteur-from-parcelle-v3] RETRY geom after parcel ZONE_NOT_FOUND",
            {
              communeInsee,
              reasonUpper,
              geomType: geomForRetry?.type,
            }
          );

          const { data: retryData, error: retryErr } = await client.rpc(
            "get_plu_rules_for_geom_v1",
            {
              p_commune_insee: communeInsee,
              p_parcel_geojson: geomForRetry,
            }
          );

          if (retryErr) {
            console.error(
              "[promoteur-from-parcelle-v3] RETRY geom failed:",
              retryErr.message
            );
          } else {
            const retryObj = retryData as Record<string, unknown> | null;
            if (retryObj?.found) {
              plu = retryObj;
              pluEngineSource = "geom";
              plu_status = "OK";
            }
          }
        } else if (!geomForRetry && isZoneNotFound) {
          console.warn(
            "[promoteur-from-parcelle-v3] RETRY skipped (missing geometry from parcel engine)",
            {
              communeInsee,
              reasonUpper,
              geomReason: geomNormRetry.reason ?? null,
            }
          );
        }
      }
    } else {
      plu_status = "PLU_INPUT_MISSING";
      plu = { found: false, error: "Missing parcel_id and (commune_insee+geojson)" };
    }

    const pluFound = !!plu?.found;

    let normalized = normalizePluRules(null);
    let pluForOutput: Record<string, unknown> = {
      found: pluFound,
      zone: plu?.zone ?? null,
      rules: null,
      raw_ruleset: plu?.raw_ruleset ?? null,
      source: plu?.source ?? null,
      has_ruleset: plu?.has_ruleset ?? null,
      reason: plu?.reason ?? null,
      raw: rawPluEngine ?? plu ?? null,
    };

    if (pluFound) {
      normalized = normalizePluRules(plu?.rules ?? null);
      pluForOutput = {
        found: true,
        zone: plu?.zone ?? null,
        rules: normalized.rules ?? null,
        raw_ruleset: plu?.raw_ruleset ?? null,
        source: plu?.source ?? null,
        has_ruleset: plu?.has_ruleset ?? true,
        reason: plu?.reason ?? null,
        raw: rawPluEngine ?? plu ?? null,
      };
    }

    // ---------------------------------------------------------------------
    // 3) promoteur_v1
    // ---------------------------------------------------------------------
    const promoteurInput = {
      parcel,
      plu: {
        zone: pluForOutput.zone,
        rules: pluForOutput.rules,
      },
    };

    let promoteurForOutput: unknown = null;
    const { data: promoteurData, error: promoteurError } = await client.rpc(
      "promoteur_v1",
      { input: promoteurInput }
    );

    if (promoteurError) {
      console.error("Error calling promoteur_v1:", promoteurError.message);
    } else {
      promoteurForOutput = promoteurData ?? null;
    }

    // ---------------------------------------------------------------------
    // 4) Massing v0
    // ---------------------------------------------------------------------
    const massing = buildMassingV0(
      normalized.rules as Record<string, unknown> | null,
      surfaceTerrainM2
    );

    // ---------------------------------------------------------------------
    // 4bis) Bilan Promoteur (Edge)
    // -----------------------------------------------------------------------------
    const massingInput = body?.massing as { sdp_m2?: unknown } | undefined;
    const implantationInput = body?.implantation as { sdp_m2?: unknown } | undefined;

    const sdp_m2: number | null =
      toNumberLoose(massingInput?.sdp_m2) ??
      toNumberLoose(implantationInput?.sdp_m2) ??
      null;

    const defaults = getDefaultAssumptions();

    const overrideSafe =
      body?.assumptions_override &&
      typeof body.assumptions_override === "object" &&
      !Array.isArray(body.assumptions_override)
        ? (body.assumptions_override as Record<string, unknown>)
        : null;

    const assumptions = mergeAssumptions(defaults, overrideSafe);

    const bilan_promoteur = computeBilanPromoteur({
      sdp_m2,
      assumptions,
    });

    // ---------------------------------------------------------------------
    // 5) Response
    // ---------------------------------------------------------------------
    const zoneObj = pluForOutput?.zone as Record<string, unknown> | undefined;

    console.log("[promoteur-from-parcelle-v3] OUT", {
      parcelId,
      communeInsee,
      usesGeomStrategy,
      plu_status,
      pluFound,
      cadastreRowFound,
      zone: zoneObj?.zone_code ?? null,
      has_rules: !!pluForOutput?.rules,
      engine: pluEngineSource,
    });

    return successResponse({
      plu_status,
      inputs: {
        parcel_id: parcelId,
        commune_insee: communeInsee,
        surface_terrain_m2: surfaceTerrainM2,
        has_geojson: !!geo,
        uses_geom_strategy: usesGeomStrategy,
      },
      parcel,
      plu: pluForOutput,
      promoteur: promoteurForOutput,
      massing,
      bilan_promoteur,
      debug: {
        cadastre_row_found: cadastreRowFound,
        plu_engine_source: pluEngineSource ?? null,
        plu_found: pluFound,
        has_plu_rules: !!pluForOutput.rules,
        has_promoteur: !!promoteurForOutput,
        plu_rpc_error: plu?.error ?? null,
        plu_reason: plu?.reason ?? null,
        plu_rules_normalized: normalized.normalized,
        derived_implantation_from_reculs_alignements:
          normalized.derived.implantation_from_reculs_alignements,
        derived_hauteur_max: normalized.derived.hauteur_max_derived,
        derived_stationnement: normalized.derived.stationnement_derived,
        geo_type: geo?.type ?? null,
        geo_invalid_reason: geo ? null : geoNorm.reason ?? null,
        raw_plu_engine: rawPluEngine ?? null,
      },
    });
  } catch (err: unknown) {
    const errObj = err as { message?: string; stack?: string } | null;
    console.error("Unexpected error in promoteur-from-parcelle-v3:", {
      message: errObj?.message ?? String(err),
      stack: errObj?.stack ?? null,
    });

    return errorResponse(
      "UNEXPECTED_ERROR",
      "Erreur inattendue dans la fonction Edge.",
      500,
      { details: errObj?.message ?? String(err) }
    );
  }
});