import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

type RequestBody = {
  zip_code?: string;
  city?: string;
  transaction_mode?: "all" | "sale" | "rent";
  window_hours?: number;
  min_score?: number;
  dry_run?: boolean;
  include_samples?: boolean;
  sample_limit?: number;
};

type StepResult = {
  ok: boolean;
  status: number;
  body: unknown;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseBody(raw: unknown): Required<RequestBody> {
  const body = (raw ?? {}) as RequestBody;

  const transactionMode =
    body.transaction_mode === "sale" ||
    body.transaction_mode === "rent" ||
    body.transaction_mode === "all"
      ? body.transaction_mode
      : "all";

  return {
    zip_code: normalizeText(body.zip_code) ?? "",
    city: normalizeText(body.city) ?? "",
    transaction_mode: transactionMode,
    window_hours:
      typeof body.window_hours === "number" && Number.isFinite(body.window_hours)
        ? Math.max(1, Math.min(24 * 90, Math.round(body.window_hours)))
        : 24 * 30,
    min_score:
      typeof body.min_score === "number" && Number.isFinite(body.min_score)
        ? Math.max(0, Math.min(100, Math.round(body.min_score)))
        : 0,
    dry_run: Boolean(body.dry_run),
    include_samples: Boolean(body.include_samples),
    sample_limit:
      typeof body.sample_limit === "number" && Number.isFinite(body.sample_limit)
        ? Math.max(1, Math.min(50, Math.round(body.sample_limit)))
        : 5,
  };
}

async function callFunction(
  fnName: string,
  payload: Record<string, unknown>
): Promise<StepResult> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();

  let body: unknown = rawText;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = rawText;
  }

  const ok =
    response.ok &&
    typeof body === "object" &&
    body !== null &&
    "ok" in body &&
    (body as { ok?: boolean }).ok === true;

  return {
    ok,
    status: response.status,
    body,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Method not allowed",
      }),
      {
        status: 405,
        headers: corsHeaders,
      }
    );
  }

  try {
    let rawBody: unknown = {};
    try {
      rawBody = await req.json();
    } catch {
      rawBody = {};
    }

    const params = parseBody(rawBody);
    const startedAt = new Date().toISOString();

    const dedupePayload = {
      zip_code: params.zip_code || undefined,
      city: params.city || undefined,
      window_hours: params.window_hours,
      dry_run: params.dry_run,
      include_groups: false,
      delete_stale_canonical: false,
    };

    const metricsPayload = {
      zip_code: params.zip_code || undefined,
      city: params.city || undefined,
      transaction_mode: params.transaction_mode,
      dry_run: params.dry_run,
      include_samples: params.include_samples,
      sample_limit: params.sample_limit,
    };

    const opportunitiesPayload = {
      zip_code: params.zip_code || undefined,
      city: params.city || undefined,
      transaction_mode: params.transaction_mode,
      dry_run: params.dry_run,
      include_samples: params.include_samples,
      sample_limit: params.sample_limit,
      min_score: params.min_score,
    };

    const dedupe = await callFunction("market-dedupe-v1", dedupePayload);
    if (!dedupe.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          stage: "dedupe",
          error: "market-dedupe-v1 failed",
          details: dedupe.body,
          dedupe,
        }),
        {
          status: 400,
          headers: corsHeaders,
        }
      );
    }

    const metrics = await callFunction("market-metrics-zone-v1", metricsPayload);
    if (!metrics.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          stage: "metrics",
          error: "market-metrics-zone-v1 failed",
          details: metrics.body,
          dedupe,
          metrics,
        }),
        {
          status: 400,
          headers: corsHeaders,
        }
      );
    }

    const opportunities = await callFunction(
      "market-opportunity-refresh-v1",
      opportunitiesPayload
    );
    if (!opportunities.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          stage: "opportunities",
          error: "market-opportunity-refresh-v1 failed",
          details: opportunities.body,
          dedupe,
          metrics,
          opportunities,
        }),
        {
          status: 400,
          headers: corsHeaders,
        }
      );
    }

    const finishedAt = new Date().toISOString();

    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: params.dry_run,
        zone: {
          zip_code: params.zip_code || null,
          city: params.city || null,
          transaction_mode: params.transaction_mode,
        },
        started_at: startedAt,
        finished_at: finishedAt,
        steps: {
          dedupe,
          metrics,
          opportunities,
        },
        summary: {
          dedupe_groups:
            typeof dedupe.body === "object" &&
            dedupe.body !== null &&
            "canonical_groups" in dedupe.body
              ? (dedupe.body as Record<string, unknown>).canonical_groups
              : null,
          metrics_zone_key:
            typeof metrics.body === "object" &&
            metrics.body !== null &&
            "zone_key" in metrics.body
              ? (metrics.body as Record<string, unknown>).zone_key
              : null,
          opportunities_computed:
            typeof opportunities.body === "object" &&
            opportunities.body !== null &&
            "opportunities_computed" in opportunities.body
              ? (opportunities.body as Record<string, unknown>)
                  .opportunities_computed
              : null,
        },
      }),
      {
        status: 200,
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error("market-refresh-zone-v1 error:", error);

    return new Response(
      JSON.stringify({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : typeof error === "object"
              ? JSON.stringify(error)
              : String(error),
      }),
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
});