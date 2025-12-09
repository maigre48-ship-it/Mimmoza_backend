// supabase/functions/promoteur-from-parcelle/index.ts
// Version : promoteur-from-parcelle-v1
//
// Objectif :
//  - Entrée : parcel_id (+ commune_insee et surface_terrain_m2 optionnels)
//  - Étapes :
//      1) Lire la parcelle dans le cache / BD
//      2) Lire les règles PLU pour la parcelle (zone + règles)
//      3) Appeler la fonction SQL promoteur_v1(input jsonb)
//  - Sortie : { success, inputs, parcel, plu, promoteur, error }
//
// Dépendances :
//  - @supabase/supabase-js v2
//  - ../_shared/cors.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// -------------------------------------------------
// Types
// -------------------------------------------------

type PromoteurFromParcelRequest = {
  parcel_id: string;
  commune_insee?: string | null;
  surface_terrain_m2?: number | null;
};

type ParcelRecord = {
  parcel_id: string;
  commune_insee: string | null;
  surface_terrain_m2: number | null;
  [key: string]: unknown;
};

type PluZoneInfo = {
  zone_code: string;
  zone_libelle: string | null;
};

type PluRuleset = {
  [key: string]: unknown;
};

type PluForParcelResult = {
  zone: PluZoneInfo | null;
  found: boolean;
  rules?: PluRuleset | null;
  source?: Record<string, unknown> | null;
};

type PromoteurBilan = {
  success: boolean;
  version?: string;
  appreciation?: string;
  bilan?: unknown;
  error?: string;
  [key: string]: unknown;
};

type PromoteurFromParcelResponse = {
  success: boolean;
  version: "promoteur-from-parcelle-v1";
  inputs: {
    parcel_id: string;
    commune_insee?: string | null;
    surface_terrain_m2?: number | null;
  };
  parcel?: ParcelRecord | null;
  plu?: PluForParcelResult | null;
  promoteur?: PromoteurBilan | null;
  error?: string;
  details?: unknown;
};

// -------------------------------------------------
// Supabase client
// -------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -------------------------------------------------
// Helpers Response
// -------------------------------------------------

function jsonResponse(body: PromoteurFromParcelResponse): Response {
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
  extra: Partial<PromoteurFromParcelResponse> = {},
) {
  return jsonResponse({
    success: false,
    version: "promoteur-from-parcelle-v1",
    inputs: extra.inputs ?? {
      parcel_id: "",
      commune_insee: null,
      surface_terrain_m2: null,
    },
    ...extra,
    error: message,
  } as PromoteurFromParcelResponse);
}

// -------------------------------------------------
// 1) Lire parcelle depuis cache
// -------------------------------------------------

async function getParcelFromDb(
  parcelId: string,
  communeInsee?: string | null,
): Promise<ParcelRecord | null> {
  try {
    const q = supabase
      .from("cadastre_parcelles_cache")
      .select("*")
      .eq("parcel_id", parcelId)
      .limit(1);

    if (communeInsee) q.eq("commune_insee", communeInsee);

    const { data, error } = await q.maybeSingle();

    if (error) {
      console.error("❌ getParcelFromDb error:", error);
      return null;
    }

    if (!data) {
      console.warn("⚠️ getParcelFromDb: aucun enregistrement");
      return null;
    }

    return {
      parcel_id: data.parcel_id ?? parcelId,
      commune_insee: data.commune_insee ?? communeInsee ?? null,
      surface_terrain_m2:
        typeof data.surface_terrain_m2 === "number"
          ? data.surface_terrain_m2
          : typeof data.surface_m2 === "number"
          ? data.surface_m2
          : null,
      ...data,
    };
  } catch (e) {
    console.error("❌ Exception getParcelFromDb:", e);
    return null;
  }
}

// -------------------------------------------------
// 2) PLU pour une parcelle (RPC existante)
// -------------------------------------------------

async function getPluForParcel(
  parcelId: string,
  communeInsee?: string | null,
): Promise<PluForParcelResult | null> {
  const params: Record<string, any> = { parcel_id: parcelId };
  if (communeInsee) params.commune_insee = communeInsee;

  const { data, error } = await supabase.rpc(
    "plu_get_for_parcelle_any",
    params,
  );

  if (error) {
    console.error("❌ RPC plu_get_for_parcelle_any error:", error);
    return null;
  }

  if (!data) {
    console.warn("⚠️ plu_get_for_parcelle_any a renvoyé null");
    return null;
  }

  const root = (data as any).plu_get_for_parcelle_any ?? data;

  return {
    zone: root.zone ?? null,
    found: !!root.found,
    rules:
      (root.rules as PluRuleset | null) ??
      (root.ruleset as PluRuleset | null) ??
      null,
    source: root.source ?? null,
  };
}

// -------------------------------------------------
// 3) Appel Promoteur_v1(input jsonb)
// -------------------------------------------------

async function callPromoteurBilan(args: {
  parcel: ParcelRecord;
  plu: PluForParcelResult | null;
}): Promise<PromoteurBilan | null> {
  const { parcel, plu } = args;

  const surface =
    parcel.surface_terrain_m2 ??
    (typeof parcel["surface_m2"] === "number"
      ? (parcel["surface_m2"] as number)
      : null);

  const promoteurInput = {
    parcel_id: parcel.parcel_id,
    commune_insee: parcel.commune_insee,
    zone_code: plu?.zone?.zone_code ?? null,
    surface_terrain_m2: surface,
    rules: plu?.rules ?? null,
  };

  console.log("ℹ️ callPromoteurBilan input:", promoteurInput);

  const { data, error } = await supabase.rpc("promoteur_v1", {
    input: promoteurInput,
  });

  if (error) {
    console.error("❌ RPC promoteur_v1 error:", error);
    return {
      success: false,
      version: "promoteur_v1",
      appreciation: "erreur",
      bilan: null,
      error: error.message,
    };
  }

  if (!data) {
    console.warn("⚠️ promoteur_v1 a renvoyé null");
    return {
      success: false,
      version: "promoteur_v1",
      appreciation: "indisponible",
      bilan: null,
    };
  }

  const root = (data as any).promoteur_v1 ?? data;

  return {
    success: root.success ?? true,
    version: root.version ?? "promoteur_v1",
    appreciation: root.appreciation ?? null,
    bilan: root.bilan ?? root,
  };
}

// -------------------------------------------------
// 4) Handler principal
// -------------------------------------------------

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({
      success: false,
      version: "promoteur-from-parcelle-v1",
      inputs: { parcel_id: "" },
      error: "Méthode non autorisée",
    });
  }

  let body: PromoteurFromParcelRequest;

  try {
    body = (await req.json()) as PromoteurFromParcelRequest;
  } catch (e) {
    return badRequest("JSON invalide");
  }

  const parcelId = body.parcel_id?.trim();
  const communeInsee = body.commune_insee ?? null;
  const surfaceOverride =
    typeof body.surface_terrain_m2 === "number"
      ? body.surface_terrain_m2
      : null;

  const baseResponse: Omit<PromoteurFromParcelResponse, "success"> = {
    version: "promoteur-from-parcelle-v1",
    inputs: {
      parcel_id: parcelId ?? "",
      commune_insee: communeInsee,
      surface_terrain_m2: surfaceOverride,
    },
  };

  if (!parcelId) {
    return badRequest("Le champ parcel_id est obligatoire", baseResponse);
  }

  try {
    // 1) Lire la parcelle
    let parcel = await getParcelFromDb(parcelId, communeInsee);
    if (!parcel) {
      parcel = {
        parcel_id: parcelId,
        commune_insee: communeInsee,
        surface_terrain_m2: surfaceOverride ?? null,
      };
    }

    // override surface
    if (surfaceOverride !== null) {
      parcel.surface_terrain_m2 = surfaceOverride;
    }

    // 2) Lire les règles PLU
    const plu = await getPluForParcel(parcel.parcel_id, parcel.commune_insee);

    // 3) Bilan Promoteur
    const promoteur = await callPromoteurBilan({
      parcel,
      plu: plu ?? null,
    });

    return jsonResponse({
      ...baseResponse,
      success: true,
      parcel,
      plu: plu ?? null,
      promoteur: promoteur ?? null,
    });
  } catch (e: unknown) {
    return jsonResponse({
      ...baseResponse,
      success: false,
      error:
        e instanceof Error ? e.message : "Erreur inconnue promoteur-from-parcelle",
      details: String(e),
    });
  }
});
