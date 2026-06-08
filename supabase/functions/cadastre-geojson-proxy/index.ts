// ------------------------------------------------------------
// cadastre-geojson-proxy
// Proxy sécurisé pour servir les GeoJSON Cadastre Etalab
// ------------------------------------------------------------
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const CADASTRE_BASE =
  "https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/communes";

const ALLOWED_TYPES = new Set(["parcelles", "batiments", "sections"]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function isValidInsee(value: string): boolean {
  return /^(\d{5}|2A\d{3}|2B\d{3})$/.test(value);
}

function getDepartmentFromInsee(insee: string): string {
  if (insee.startsWith("2A")) return "2A";
  if (insee.startsWith("2B")) return "2B";
  return insee.slice(0, 2);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return jsonResponse(
      {
        success: false,
        error: "Method not allowed",
      },
      405,
    );
  }

  try {
    const url = new URL(req.url);
    const insee = (url.searchParams.get("insee") ?? "").trim().toUpperCase();
    const type = (url.searchParams.get("type") ?? "").trim().toLowerCase();

    if (!insee || !type) {
      return jsonResponse(
        {
          success: false,
          error:
            "Missing parameters: ?insee=XXXXX&type=parcelles|batiments|sections",
        },
        400,
      );
    }

    if (!isValidInsee(insee)) {
      return jsonResponse(
        {
          success: false,
          error: "Invalid INSEE code",
        },
        400,
      );
    }

    if (!ALLOWED_TYPES.has(type)) {
      return jsonResponse(
        {
          success: false,
          error: "Invalid cadastre type",
        },
        400,
      );
    }

    const dep = getDepartmentFromInsee(insee);

    const cadastreUrl =
      `${CADASTRE_BASE}/${dep}/${insee}/cadastre-${insee}-${type}.json.gz`;

    const response = await fetch(cadastreUrl, {
      method: "GET",
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
      return jsonResponse(
        {
          success: false,
          error: `Cadastre source returned ${response.status}`,
        },
        502,
      );
    }

    const compressedBuffer = await response.arrayBuffer();

    const compressedStream = new Response(
      new Blob([compressedBuffer]),
    ).body;

    if (!compressedStream) {
      throw new Error("No body stream from cadastre response");
    }

    const decompressedStream = compressedStream.pipeThrough(
      new DecompressionStream("gzip"),
    );

    const decompressedResponse = new Response(decompressedStream);
    const text = await decompressedResponse.text();

    let geojson: unknown;

    try {
      geojson = JSON.parse(text);
    } catch {
      return jsonResponse(
        {
          success: false,
          error: "Invalid GeoJSON response from cadastre source",
        },
        502,
      );
    }

    return jsonResponse(geojson, 200);
  } catch (err: any) {
    console.error("cadastre-geojson-proxy error", err);

    return jsonResponse(
      {
        success: false,
        error: "Internal proxy error",
      },
      500,
    );
  }
});