import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type SnapshotRow = {
  id: string;
  canonical_key: string | null;
  portal: string;
  listing_portal_id: string;
  zip_code: string | null;
  city: string | null;
  price: number | null;
  surface: number | null;
  price_m2: number | null;
  seen_at: string | null;
};

type RequestBody = {
  window_hours?: number;
  zip_code?: string;
  city?: string;
  limit?: number;
  dry_run?: boolean;
};

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  return v.length ? v : null;
}

function parseBody(raw: unknown): Required<RequestBody> {
  const body = (raw ?? {}) as RequestBody;

  const windowHours =
    typeof body.window_hours === "number" && Number.isFinite(body.window_hours)
      ? Math.max(1, Math.min(24 * 90, Math.round(body.window_hours)))
      : 72;

  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(20000, Math.round(body.limit)))
      : 5000;

  return {
    window_hours: windowHours,
    zip_code: normalizeText(body.zip_code) ?? "",
    city: normalizeText(body.city) ?? "",
    limit,
    dry_run: Boolean(body.dry_run),
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
    const sinceIso = new Date(
      Date.now() - params.window_hours * 60 * 60 * 1000
    ).toISOString();

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    let query = supabase
      .from("portal_snapshots")
      .select(
        "id, canonical_key, portal, listing_portal_id, zip_code, city, price, surface, price_m2, seen_at"
      )
      .not("canonical_key", "is", null)
      .not("price", "is", null)
      .not("seen_at", "is", null)
      .gte("seen_at", sinceIso)
      .order("seen_at", { ascending: false })
      .limit(params.limit);

    if (params.zip_code) {
      query = query.eq("zip_code", params.zip_code);
    }

    if (params.city) {
      query = query.ilike("city", params.city);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data ?? []) as SnapshotRow[];

    if (!rows.length) {
      return new Response(
        JSON.stringify({
          ok: true,
          dry_run: params.dry_run,
          processed: 0,
          inserted: 0,
          message: "No eligible snapshots found",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const payload = rows
      .filter((row) => row.canonical_key && row.price && row.seen_at)
      .map((row) => ({
        snapshot_id: row.id,
        canonical_key: row.canonical_key as string,
        portal: row.portal,
        listing_portal_id: row.listing_portal_id,
        zip_code: row.zip_code,
        city: row.city,
        observed_at: row.seen_at as string,
        price: row.price as number,
        surface: row.surface,
        price_m2: row.price_m2,
      }));

    if (params.dry_run) {
      return new Response(
        JSON.stringify({
          ok: true,
          dry_run: true,
          processed: rows.length,
          inserted: 0,
          candidates: payload.length,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const { data: insertedRows, error: upsertError } = await supabase
      .from("listing_price_history")
      .upsert(payload, { onConflict: "snapshot_id" })
      .select("snapshot_id");

    if (upsertError) throw upsertError;

    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: false,
        processed: rows.length,
        inserted: Array.isArray(insertedRows) ? insertedRows.length : 0,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("market-price-history-v1 error:", error);

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