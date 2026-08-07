// supabase/functions/api-gateway/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// API Gateway Mimmoza
// ─────────────────────────────────────────────────────────────────────────────

import {
  validateApiKey,
  incrementUsage,
  corsHeaders,
} from "../_shared/apiKeyAuth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type RouteHandler = (params: {
  req: Request;
  pathParams: Record<string, string>;
  supabaseUrl: string;
  serviceKey: string;
  userId: string;
}) => Promise<Response>;

type Route = {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  endpoint: string;
  handler: RouteHandler;
};

function route(
  method: string,
  path: string,
  endpoint: string,
  handler: RouteHandler,
): Route {
  const paramNames: string[] = [];

  const regexStr = path.replace(/\{(\w+)\}/g, (_: string, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });

  return {
    method,
    pattern: new RegExp(`^${regexStr}$`),
    paramNames,
    endpoint,
    handler,
  };
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...(extraHeaders ?? {}),
    },
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text) return {};

    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function invokeInternal(
  functionName: string,
  body: unknown,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse(
      {
        error: "Internal configuration error",
      },
      500,
    );
  }

  const url = `${supabaseUrl}/functions/v1/${functionName}`;

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(body),
  });
}

function copySafeResponseHeaders(
  source: Response,
  latency: number,
  requestsLimit: number,
  requestsRemaining: number,
): Headers {
  const headers = new Headers();

  headers.set("Content-Type", source.headers.get("Content-Type") ?? "application/json");
  headers.set("X-Response-Time", `${latency}ms`);
  headers.set("X-RateLimit-Limit", String(requestsLimit));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, requestsRemaining)));

  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }

  // Inliné (indépendant de _shared/cors.ts) : autorise le navigateur à lire ces headers
  headers.set(
    "Access-Control-Expose-Headers",
    "X-RateLimit-Limit, X-RateLimit-Remaining, X-Response-Time",
  );

  return headers;
}
const ROUTES: Route[] = [
  route("GET", "/health", "/health", async () => {
    return jsonResponse({
      ok: true,
      service: "api-gateway",
      status: "healthy",
    });
  }),

  route(
    "POST",
    "/v1/scoring/smart",
    "/v1/scoring/smart",
    async ({ req, supabaseUrl, serviceKey }) => {
      const body = await readBody(req);

      return invokeInternal(
        "smartscore-enriched-v3",
        body,
        supabaseUrl,
        serviceKey,
      );
    },
  ),

  route(
    "POST",
    "/v1/market/dvf",
    "/v1/market/dvf",
    async ({ req, supabaseUrl, serviceKey }) => {
      const body = await readBody(req);
      // Endpoint dédié DVF : on force include=["dvf"], le client ne peut pas l'élargir
      const scopedBody = { ...body, include: ["dvf"] };

      return invokeInternal(
        "smartscore-enriched-v3",
        scopedBody,
        supabaseUrl,
        serviceKey,
      );
    },
  ),

  route(
    "POST",
    "/v1/risks",
    "/v1/risks",
    async ({ req, supabaseUrl, serviceKey }) => {
      const body = await readBody(req);
      // Endpoint dédié risques : include=["risques"] (environnement + DPE, bruit estimé sans transport)
      const scopedBody = { ...body, include: ["risques"] };

      return invokeInternal(
        "smartscore-enriched-v3",
        scopedBody,
        supabaseUrl,
        serviceKey,
      );
    },
  ),
];

// Coût en crédits par endpoint (quota/facturation). Défaut 1 si non listé.
const ENDPOINT_COST: Record<string, number> = {
  "/v1/scoring/smart": 10,
  "/v1/market/dvf": 2,
  "/v1/risks": 2,
  "/health": 0,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const started = Date.now();
  const url = new URL(req.url);
  const rawPath = url.pathname.replace(/^\/api-gateway/, "") || "/";

  const xApiKey = req.headers.get("x-api-key");
  const authHeader = req.headers.get("Authorization");

  const auth = await validateApiKey(authHeader, xApiKey);

  if (!auth.ok) {
    return jsonResponse(
      {
        error: "Unauthorized",
      },
      auth.status,
    );
  }

  const { key } = auth;

  const matchedRoute = ROUTES.find(
    (r) => r.method === req.method && r.pattern.test(rawPath),
  );

  if (!matchedRoute) {
    return jsonResponse({ error: "Route not found" }, 404);
  }

  const match = rawPath.match(matchedRoute.pattern);
  const pathParams: Record<string, string> = {};

  if (match) {
    matchedRoute.paramNames.forEach((name, i) => {
      pathParams[name] = match[i + 1];
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey =
    Deno.env.get("SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "";

  let internalResponse: Response;

  try {
    internalResponse = await matchedRoute.handler({
      req,
      pathParams,
      supabaseUrl,
      serviceKey,
      userId: key.user_id,
    });
  } catch {
    console.error("[api-gateway] Handler error");

    return jsonResponse({ error: "Internal error" }, 500);
  }

  const latency = Date.now() - started;

  const cost = ENDPOINT_COST[matchedRoute.endpoint] ?? 1;

  // Décompte inliné (appel RPC direct) — indépendant de la version de _shared/apiKeyAuth.ts
  try {
    const usageClient = createClient(
      supabaseUrl,
      serviceKey,
      { auth: { persistSession: false } },
    );
    await usageClient.rpc("increment_api_usage", {
      p_key_id: key.id,
      p_endpoint: matchedRoute.endpoint,
      p_is_error: false,
      p_latency: latency,
      p_cost: cost,
    });
  } catch {
    console.error("[api-gateway] Usage increment error");
  }

  const responseText = await internalResponse.text();

  if (internalResponse.status >= 500) {
    return jsonResponse(
      {
        error: "INTERNAL_UPSTREAM_ERROR",
      },
      502,
      {
        "X-Response-Time": `${latency}ms`,
        "X-RateLimit-Limit": String(key.requests_limit),
        "X-RateLimit-Remaining": String(
          Math.max(0, key.requests_limit - key.requests_count - cost),
        ),
      },
    );
  }

  return new Response(responseText, {
    status: internalResponse.status,
    headers: copySafeResponseHeaders(
      internalResponse,
      latency,
      key.requests_limit,
      key.requests_limit - key.requests_count - cost,
    ),
  });
});