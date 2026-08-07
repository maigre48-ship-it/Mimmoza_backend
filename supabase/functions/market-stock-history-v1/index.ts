import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type RequestBody = {
  zip_code?: string;
  city?: string;
  dry_run?: boolean;
  limit?: number;
};

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  return v.length ? v : null;
}

function parseBody(raw: unknown): Required<RequestBody> {
  const body = (raw ?? {}) as RequestBody;

  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(10000, Math.round(body.limit)))
      : 5000;

  return {
    zip_code: normalizeText(body.zip_code) ?? "",
    city: normalizeText(body.city) ?? "",
    dry_run: Boolean(body.dry_run),
    limit,
  };
}

serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    let rawBody: unknown = {};
    try {
      rawBody = await req.json();
    } catch {
      rawBody = {};
    }

    const params = parseBody(rawBody);
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let query = supabase
      .from("market_summary_v2")
      .select("*")
      .limit(params.limit);

    if (params.zip_code) {
      query = query.eq("zip_code", params.zip_code);
    }

    if (params.city) {
      query = query.ilike("city", params.city);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = data ?? [];
    if (!rows.length) {
      return new Response(
        JSON.stringify({
          ok: true,
          dry_run: params.dry_run,
          processed: 0,
          upserted: 0,
          message: "No market summary rows found",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const snapshotDate = new Date().toISOString().slice(0, 10);

    const payload = rows.map((row) => ({
      snapshot_date: snapshotDate,
      zip_code: row.zip_code,
      city: row.city,
      unique_listings: Number(row.unique_listings ?? 0),
      new_7d: Number(row.new_7d ?? 0),
      new_30d: Number(row.new_30d ?? 0),
      multi_portal_pct: row.multi_portal_pct == null ? null : Number(row.multi_portal_pct),
      avg_price: row.avg_price == null ? null : Number(row.avg_price),
      avg_price_m2: row.avg_price_m2 == null ? null : Number(row.avg_price_m2),
      avg_days_on_market:
        row.avg_days_on_market == null ? null : Number(row.avg_days_on_market),
      price_drops_7d: Number(row.price_drops_7d ?? 0),
      price_drops_30d: Number(row.price_drops_30d ?? 0),
    }));

    if (params.dry_run) {
      return new Response(
        JSON.stringify({
          ok: true,
          dry_run: true,
          processed: rows.length,
          upserted: 0,
          candidates: payload.length,
          snapshot_date: snapshotDate,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const { data: upsertedRows, error: upsertError } = await supabase
      .from("market_stock_history")
      .upsert(payload, {
        onConflict: "snapshot_date,zip_code,city",
      })
      .select("zip_code, city");

    if (upsertError) throw upsertError;

    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: false,
        processed: rows.length,
        upserted: Array.isArray(upsertedRows) ? upsertedRows.length : 0,
        snapshot_date: snapshotDate,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("market-stock-history-v1 error:", error);

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
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
});