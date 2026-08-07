// supabase/functions/cadastre-from-commune/index.ts
// Version : cadastre-from-commune-v2 (Option A : cache Storage + fallback Etalab)
// -----------------------------------------------------------------------------
// Objectif :
//  - Entrée : { commune_insee }
//  - Sortie : { featureCollection } (GeoJSON parcelles Etalab)
//  - Stratégie :
//      1) Tente de lire un cache dans Supabase Storage (bucket "cadastre")
//      2) Si absent : fetch Etalab (.json.gz), parse, renvoie, et upload en cache
//
// Cache recommandé : cadastre/communes/{INSEE}.geojson.gz
// -----------------------------------------------------------------------------

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CADASTRE_BUCKET = "cadastre";
const CADASTRE_PREFIX = "communes"; // path prefix in bucket
const VERSION = "cadastre-from-commune-v2";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidInsee(v: unknown): v is string {
  if (typeof v !== "string" && typeof v !== "number") return false;
  const s = String(v).trim();
  return /^\d{5}$/.test(s);
}

async function gunzipToText(gzBytes: Uint8Array): Promise<string> {
  const stream = new Response(gzBytes).body;
  if (!stream) throw new Error("NO_BODY_STREAM");
  const decompressedStream = stream.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(decompressedStream).text();
}

async function blobToUint8Array(b: Blob): Promise<Uint8Array> {
  const ab = await b.arrayBuffer();
  return new Uint8Array(ab);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResp(
      { success: false, version: VERSION, error: "METHOD_NOT_ALLOWED" },
      405,
    );
  }

  try {
    const { commune_insee } = await req.json();

    if (!isValidInsee(commune_insee)) {
      return jsonResp(
        {
          success: false,
          version: VERSION,
          error: "INVALID_COMMUNE_INSEE",
          details: "INVALID_INPUT",
          received: commune_insee ?? null,
        },
        400,
      );
    }

    const insee = String(commune_insee).trim();
    const dep = insee.substring(0, 2);

    // Cache path (gzip, to limit size)
    const cachePath = `${CADASTRE_PREFIX}/${insee}.geojson.gz`;

    // ---------------------------------------------------------------------
    // 1) Tentative cache Storage
    // ---------------------------------------------------------------------
    let cacheStatus: "HIT" | "MISS" | "ERROR" = "MISS";
    try {
      const { data: cachedBlob, error: dlErr } = await supabase.storage
        .from(CADASTRE_BUCKET)
        .download(cachePath);

      if (!dlErr && cachedBlob) {
        const gz = await blobToUint8Array(cachedBlob);
        const text = await gunzipToText(gz);

        let geojson;
        try {
          geojson = JSON.parse(text);
        } catch (_e) {
          // Cache corrompu -> on force un re-fetch Etalab
          console.error("[cadastre-from-commune] Cache JSON parse error");
          cacheStatus = "ERROR";
          geojson = null;
        }

        if (geojson) {
          cacheStatus = "HIT";
          return jsonResp({
            success: true,
            version: VERSION,
            commune_insee: insee,
            cache: {
              status: cacheStatus,
              bucket: CADASTRE_BUCKET,
              path: cachePath,
            },
            featureCollection: geojson,
          });
        }
      } else {
        // Si l'objet n'existe pas, Supabase renvoie souvent une erreur.
        // On considère que c'est un MISS (pas bloquant).
        cacheStatus = "MISS";
      }
    } catch (_e) {
      console.error("[cadastre-from-commune] Storage download error");
      cacheStatus = "ERROR";
      // On continue : fallback Etalab
    }

    // -----------------------------------------------------------------------
    // 2) Fallback Etalab (.json.gz), décompression + parsing JSON
    // -----------------------------------------------------------------------
    const etalabUrl =
      `https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes/${dep}/${insee}/cadastre-${insee}-parcelles.json.gz`;

    const r = await fetch(etalabUrl);
    if (!r.ok) {
      return jsonResp(
        {
          success: false,
          version: VERSION,
          error: "ETALAB_HTTP_ERROR",
          status: r.status,
        },
        502,
      );
    }

    // Récup bytes gzip (Etalab renvoie .json.gz)
    const gzBytes = new Uint8Array(await r.arrayBuffer());

    // Décompression + parsing pour la réponse (front)
    let text: string;
    try {
      text = await gunzipToText(gzBytes);
    } catch (_decompressErr) {
      console.error("[cadastre-from-commune] GZIP decompress error");
      return jsonResp(
        {
          success: false,
          version: VERSION,
          error: "GZIP_DECOMPRESS_ERROR",
          details: "DECOMPRESS_ERROR",
        },
        500,
      );
    }

    let geojson: unknown;
    try {
      geojson = JSON.parse(text);
    } catch (_e) {
      return jsonResp(
        {
          success: false,
          version: VERSION,
          error: "JSON_PARSE_ERROR",
          details: "PARSE_ERROR",
        },
        500,
      );
    }

    // ---------------------------------------------------------------------
    // 3) Upload cache Storage (best-effort, non bloquant)
    // ---------------------------------------------------------------------
    try {
      const blob = new Blob([gzBytes], { type: "application/gzip" });

      const { error: upErr } = await supabase.storage
        .from(CADASTRE_BUCKET)
        .upload(cachePath, blob, {
          upsert: true,
          contentType: "application/gzip",
          cacheControl: "86400", // 24h
        });

      if (upErr) {
        console.error("[cadastre-from-commune] Storage upload error");
      }
    } catch (_e) {
      console.error("[cadastre-from-commune] Storage upload exception");
    }

    return jsonResp({
      success: true,
      version: VERSION,
      commune_insee: insee,
      cache: {
        status: cacheStatus === "MISS" ? "MISS_SAVED" : "ERROR_SAVED",
        bucket: CADASTRE_BUCKET,
        path: cachePath,
        source_url: null,
      },
      featureCollection: geojson,
    });
  } catch (_e) {
    return jsonResp(
      {
        success: false,
        version: VERSION,
        error: "UNEXPECTED_ERROR",
        details: "UNEXPECTED_ERROR",
      },
      500,
    );
  }
});