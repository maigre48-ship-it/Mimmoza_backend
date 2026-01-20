/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "Access-Control-Max-Age": "86400",
};

type BBox = { minLon: number; minLat: number; maxLon: number; maxLat: number };
type Input = { commune_insee: string; bbox: BBox };

function isFiniteNumber(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function validateBBox(b: any): { ok: true; bbox: BBox } | { ok: false; message: string } {
  if (!b || typeof b !== "object") return { ok: false, message: "bbox manquant ou invalide" };

  const { minLon, minLat, maxLon, maxLat } = b;

  if (![minLon, minLat, maxLon, maxLat].every(isFiniteNumber)) {
    return { ok: false, message: "bbox doit contenir minLon,minLat,maxLon,maxLat (nombres)" };
  }
  if (minLon >= maxLon || minLat >= maxLat) {
    return { ok: false, message: "bbox invalide (min >= max)" };
  }

  // garde-fou: évite des bbox trop larges
  const spanLon = Math.abs(maxLon - minLon);
  const spanLat = Math.abs(maxLat - minLat);
  if (spanLon > 0.25 || spanLat > 0.25) {
    return { ok: false, message: "bbox trop large (réduis le zoom / la zone)" };
  }

  return { ok: true, bbox: { minLon, minLat, maxLon, maxLat } };
}

async function fetchIgnParcelles(commune_insee: string, bbox: BBox) {
  const base = "https://apicarto.ign.fr/api/cadastre/parcelle";
  const bboxStr = `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`;

  const params = new URLSearchParams({
    code_insee: commune_insee,
    bbox: bboxStr,
    source_ign: "PCI",
    _limit: "2000",
  });

  const url = `${base}?${params.toString()}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false as const,
        url,
        status: resp.status,
        body: text.slice(0, 800),
      };
    }

    const json = await resp.json();
    // attendu: FeatureCollection
    if (json?.type !== "FeatureCollection" || !Array.isArray(json?.features)) {
      return {
        ok: false as const,
        url,
        status: 502,
        body: "IGN did not return a FeatureCollection",
      };
    }

    return { ok: true as const, url, fc: json };
  } finally {
    clearTimeout(t);
  }
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => null)) as Input | null;

    const commune_insee = body?.commune_insee;
    const bboxRaw = body?.bbox;

    if (!commune_insee || typeof commune_insee !== "string") {
      return new Response(
        JSON.stringify({ success: false, error: "MISSING_PARAMS", message: "commune_insee est obligatoire" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const bboxCheck = validateBBox(bboxRaw);
    if (!bboxCheck.ok) {
      return new Response(
        JSON.stringify({ success: false, error: "BAD_BBOX", message: bboxCheck.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const bbox = bboxCheck.bbox;

    const ign = await fetchIgnParcelles(commune_insee, bbox);

    if (!ign.ok) {
      // On renvoie success=true mais features=[] pour ne pas bloquer l’UI
      return new Response(
        JSON.stringify({
          success: true,
          version: "cadastre-parcelles-bbox-v1.1",
          commune_insee,
          bbox,
          featureCollection: { type: "FeatureCollection", features: [] },
          ign_error: { status: ign.status, url: ign.url, body: ign.body },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        version: "cadastre-parcelles-bbox-v1.1",
        commune_insee,
        bbox,
        featureCollection: ign.fc,
        ign_url: ign.url,
        count: ign.fc.features.length,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ success: false, error: "UNHANDLED", message: msg.slice(0, 800) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
