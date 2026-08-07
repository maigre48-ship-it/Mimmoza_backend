import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type SnapshotRow = {
  portal: string;
  listing_portal_id: string;
  canonical_key: string | null;
  city: string | null;
  zip_code: string | null;
  price: number | null;
  surface: number | null;
  price_m2: number | null;
  seen_at: string | null;
};

serve(async () => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const today = new Date();
    const dayEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
    const dayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const prevStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);

    const { data: todayRows, error: todayError } = await supabase
      .from("portal_snapshots")
      .select("portal, listing_portal_id, canonical_key, city, zip_code, price, surface, price_m2, seen_at")
      .gte("seen_at", dayStart.toISOString())
      .lt("seen_at", dayEnd.toISOString());

    if (todayError) throw todayError;

    const { data: prevRows, error: prevError } = await supabase
      .from("portal_snapshots")
      .select("portal, listing_portal_id, canonical_key, city, zip_code, price, surface, price_m2, seen_at")
      .gte("seen_at", prevStart.toISOString())
      .lt("seen_at", dayStart.toISOString());

    if (prevError) throw prevError;

    const todayData = (todayRows ?? []) as SnapshotRow[];
    const prevData = (prevRows ?? []) as SnapshotRow[];

    const todayByZone = groupByZip(todayData);
    const prevByZone = groupByZip(prevData);

    let upserted = 0;

    for (const [zipCode, zoneRows] of todayByZone.entries()) {
      const previousZoneRows = prevByZone.get(zipCode) ?? [];

      const todayKeys = new Set(zoneRows.map(keyOf));
      const prevMap = new Map(previousZoneRows.map((row) => [keyOf(row), row]));

      const stockCount = todayKeys.size;
      const newCount = [...todayKeys].filter((k) => !prevMap.has(k)).length;

      let priceDropCount = 0;
      for (const row of zoneRows) {
        const prev = prevMap.get(keyOf(row));
        if (
          prev &&
          typeof row.price === "number" &&
          typeof prev.price === "number" &&
          row.price < prev.price
        ) {
          priceDropCount += 1;
        }
      }

      const prices = zoneRows.map((x) => x.price ?? 0).filter((x) => x > 0);
      const pricesM2 = zoneRows.map((x) => x.price_m2 ?? 0).filter((x) => x > 0);

      const payload = {
        day: dayStart.toISOString().slice(0, 10),
        city: zoneRows.find((x) => x.city)?.city ?? null,
        zip_code: zipCode,
        stock_count: stockCount,
        new_count: newCount,
        price_drop_count: priceDropCount,
        median_price: median(prices),
        median_price_m2: median(pricesM2),
      };

      const { error } = await supabase.from("market_zone_daily").upsert(payload, {
        onConflict: "zip_code,day",
      });

      if (error) throw error;
      upserted += 1;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        zones_upserted: upserted,
        day: dayStart.toISOString().slice(0, 10),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});

function keyOf(row: SnapshotRow): string {
  return row.canonical_key || `${row.portal}:${row.listing_portal_id}`;
}

function groupByZip(rows: SnapshotRow[]): Map<string, SnapshotRow[]> {
  const map = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const zip = row.zip_code ?? "unknown";
    const bucket = map.get(zip) ?? [];
    bucket.push(row);
    map.set(zip, bucket);
  }
  return map;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return round((sorted[mid - 1] + sorted[mid]) / 2, 2);
  }
  return round(sorted[mid], 2);
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}