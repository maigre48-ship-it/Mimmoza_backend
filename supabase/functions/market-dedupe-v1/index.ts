import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type SnapshotRow = {
  id: string;
  portal: string;
  listing_portal_id: string;
  canonical_key: string | null;
  url: string;
  city: string | null;
  zip_code: string | null;
  price: number | null;
  surface: number | null;
  price_m2: number | null;
  first_seen_at: string | null;
  seen_at: string | null;
};

type RequestBody = {
  window_hours?: number;
  zip_code?: string;
  city?: string;
  limit?: number;
  dry_run?: boolean;
  include_groups?: boolean;
  delete_stale_canonical?: boolean;
};

type CanonicalPayload = {
  canonical_key: string;
  portals: string[];
  portal_listing_ids: string[];
  urls: string[];
  representative_url: string | null;
  city: string | null;
  zip_code: string | null;
  price: number | null;
  surface: number | null;
  price_m2: number | null;
  listing_count: number;
  portal_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  updated_at: string;
  dedupe_method: string;
  dedupe_confidence: number;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function roundSafe(value: number | null | undefined, digits = 0): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeForCompare(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['']/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return roundSafe((sorted[mid - 1] + sorted[mid]) / 2, 2);
  }

  return roundSafe(sorted[mid], 2);
}

function minDate(values: Array<string | null>): string | null {
  const filtered = values.filter(Boolean) as string[];
  if (!filtered.length) return null;
  return filtered.sort()[0];
}

function maxDate(values: Array<string | null>): string | null {
  const filtered = values.filter(Boolean) as string[];
  if (!filtered.length) return null;
  return filtered.sort()[filtered.length - 1];
}

function chooseRepresentativeUrl(bucket: SnapshotRow[]): string | null {
  const urls = bucket.map((x) => x.url).filter(Boolean);
  if (!urls.length) return null;

  const portalPriority = [
    "bienici",
    "seloger",
    "logic-immo",
    "bellesdemeures",
    "gensdeconfiance",
    "leboncoin",
  ];

  for (const portal of portalPriority) {
    const match = bucket.find((x) => x.portal === portal && x.url);
    if (match?.url) return match.url;
  }

  return urls[0] ?? null;
}

function parseBody(raw: unknown): Required<RequestBody> {
  const body = (raw ?? {}) as RequestBody;

  const windowHours =
    typeof body.window_hours === "number" && Number.isFinite(body.window_hours)
      ? Math.max(1, Math.min(24 * 90, Math.round(body.window_hours)))
      : 24 * 30;

  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(50000, Math.round(body.limit)))
      : 20000;

  return {
    window_hours: windowHours,
    zip_code: normalizeText(body.zip_code) ?? "",
    city: normalizeText(body.city) ?? "",
    limit,
    dry_run: Boolean(body.dry_run),
    include_groups: Boolean(body.include_groups),
    delete_stale_canonical: Boolean(body.delete_stale_canonical),
  };
}

function buildPrimaryBucketKey(row: SnapshotRow): string {
  const zip = normalizeText(row.zip_code) ?? "unknown";
  const surfaceBand = roundSafe((row.surface ?? 0) / 2, 0) * 2;
  const priceM2Band = roundSafe((row.price_m2 ?? 0) / 300, 0) * 300;

  return `${zip}_${surfaceBand}_${priceM2Band}`;
}

function areRowsCompatible(a: SnapshotRow, b: SnapshotRow): boolean {
  const aPrice = a.price ?? 0;
  const bPrice = b.price ?? 0;
  const aSurface = a.surface ?? 0;
  const bSurface = b.surface ?? 0;
  const aPriceM2 = a.price_m2 ?? 0;
  const bPriceM2 = b.price_m2 ?? 0;

  const priceDeltaPct =
    aPrice > 0 && bPrice > 0 ? Math.abs(aPrice - bPrice) / aPrice : 0;

  const surfaceDelta = Math.abs(aSurface - bSurface);

  const priceM2DeltaPct =
    aPriceM2 > 0 && bPriceM2 > 0 ? Math.abs(aPriceM2 - bPriceM2) / aPriceM2 : 0;

  const zipSame =
    normalizeText(a.zip_code) !== null &&
    normalizeText(a.zip_code) === normalizeText(b.zip_code);

  if (!zipSame) return false;

  if (aPrice > 0 && bPrice > 0 && priceDeltaPct > 0.08) return false;
  if (aSurface > 0 && bSurface > 0 && surfaceDelta > 5) return false;
  if (aPriceM2 > 0 && bPriceM2 > 0 && priceM2DeltaPct > 0.1) return false;

  return true;
}

function splitIntoCompatibleGroups(bucket: SnapshotRow[]): SnapshotRow[][] {
  const groups: SnapshotRow[][] = [];

  const sorted = [...bucket].sort((a, b) => {
    const aPriceM2 = a.price_m2 ?? 0;
    const bPriceM2 = b.price_m2 ?? 0;
    return aPriceM2 - bPriceM2;
  });

  for (const row of sorted) {
    let placed = false;

    for (const group of groups) {
      const compatibleWithAll = group.every((g) => areRowsCompatible(g, row));
      if (compatibleWithAll) {
        group.push(row);
        placed = true;
        break;
      }
    }

    if (!placed) {
      groups.push([row]);
    }
  }

  return groups;
}

function buildCanonicalKeyFromGroup(group: SnapshotRow[]): string {
  const first = group[0];
  const zip = normalizeText(first?.zip_code) ?? "unknown";

  const surfaces = group.map((x) => x.surface ?? 0).filter((x) => x > 0);
  const priceM2s = group.map((x) => x.price_m2 ?? 0).filter((x) => x > 0);
  const prices = group.map((x) => x.price ?? 0).filter((x) => x > 0);

  const surfaceBand = roundSafe((median(surfaces) ?? 0) / 2, 0) * 2;
  const priceM2Band = roundSafe((median(priceM2s) ?? 0) / 300, 0) * 300;
  const priceBandK = roundSafe((median(prices) ?? 0) / 10000, 0) * 10;

  return `${zip}_${surfaceBand}_${priceM2Band}_${priceBandK}_${group.length}`;
}

function computeDedupeConfidence(bucket: SnapshotRow[]): number {
  if (bucket.length <= 1) return 1;

  const prices = bucket.map((x) => x.price ?? 0).filter((x) => x > 0);
  const surfaces = bucket.map((x) => x.surface ?? 0).filter((x) => x > 0);
  const priceM2s = bucket.map((x) => x.price_m2 ?? 0).filter((x) => x > 0);

  const priceMin = prices.length ? Math.min(...prices) : 0;
  const priceMax = prices.length ? Math.max(...prices) : 0;
  const surfaceMin = surfaces.length ? Math.min(...surfaces) : 0;
  const surfaceMax = surfaces.length ? Math.max(...surfaces) : 0;
  const priceM2Min = priceM2s.length ? Math.min(...priceM2s) : 0;
  const priceM2Max = priceM2s.length ? Math.max(...priceM2s) : 0;

  const priceSpreadPct =
    priceMin > 0 && priceMax > 0 ? ((priceMax - priceMin) / priceMin) * 100 : 0;

  const surfaceSpread = surfaceMax - surfaceMin;

  const priceM2SpreadPct =
    priceM2Min > 0 && priceM2Max > 0
      ? ((priceM2Max - priceM2Min) / priceM2Min) * 100
      : 0;

  let score = 0.95;

  if (priceSpreadPct > 1) score -= 0.03;
  if (priceSpreadPct > 2) score -= 0.04;
  if (priceSpreadPct > 5) score -= 0.08;
  if (priceSpreadPct > 10) score -= 0.08;

  if (surfaceSpread > 0.5) score -= 0.03;
  if (surfaceSpread > 2) score -= 0.05;
  if (surfaceSpread > 5) score -= 0.1;

  if (priceM2SpreadPct > 2) score -= 0.03;
  if (priceM2SpreadPct > 5) score -= 0.05;
  if (priceM2SpreadPct > 10) score -= 0.08;

  if (bucket.length >= 3) score += 0.01;

  return Math.max(0.45, Math.min(1, roundSafe(score, 2)));
}

function buildCanonicalPayload(
  canonicalKey: string,
  bucket: SnapshotRow[]
): CanonicalPayload {
  const portals = uniq(bucket.map((x) => x.portal));
  const portalListingIds = uniq(
    bucket.map((x) => `${x.portal}:${x.listing_portal_id}`)
  );
  const urls = uniq(bucket.map((x) => x.url));

  const prices = bucket.map((x) => x.price ?? 0).filter((x) => x > 0);
  const surfaces = bucket.map((x) => x.surface ?? 0).filter((x) => x > 0);
  const priceM2s = bucket.map((x) => x.price_m2 ?? 0).filter((x) => x > 0);

  return {
    canonical_key: canonicalKey,
    portals,
    portal_listing_ids: portalListingIds,
    urls,
    representative_url: chooseRepresentativeUrl(bucket),
    city: bucket.find((x) => x.city)?.city ?? null,
    zip_code: bucket.find((x) => x.zip_code)?.zip_code ?? null,
    price: median(prices),
    surface: median(surfaces),
    price_m2: median(priceM2s),
    listing_count: bucket.length,
    portal_count: portals.length,
    first_seen_at: minDate(bucket.map((x) => x.first_seen_at)),
    last_seen_at: maxDate(bucket.map((x) => x.seen_at)),
    updated_at: new Date().toISOString(),
    dedupe_method: "bucket_zip_surface2_priceM2_compat_v1",
    dedupe_confidence: computeDedupeConfidence(bucket),
  };
}

async function fetchSnapshotsPagewise(
  params: Required<RequestBody>,
  sinceIso: string
) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const pageSize = 1000;
  const rows: SnapshotRow[] = [];
  let from = 0;

  while (rows.length < params.limit) {
    const to = Math.min(from + pageSize - 1, params.limit - 1);

    let query = supabase
      .from("portal_snapshots")
      .select(
        "id, portal, listing_portal_id, canonical_key, url, city, zip_code, price, surface, price_m2, first_seen_at, seen_at"
      )
      .gte("seen_at", sinceIso)
      .order("seen_at", { ascending: false })
      .range(from, to);

    if (params.zip_code) {
      query = query.eq("zip_code", params.zip_code);
    }

    if (params.city) {
      query = query.ilike("city", `%${params.city}%`);
    }

    const { data, error } = await query;

    if (error) throw error;

    const batch = (data ?? []) as SnapshotRow[];
    rows.push(...batch);

    if (batch.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  return { supabase, rows };
}

async function updateSnapshotCanonicalKeysInChunks(
  supabase: ReturnType<typeof createClient>,
  updates: Array<{ id: string; canonical_key: string }>
) {
  const chunkSize = 200;

  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);

    for (const row of chunk) {
      const { error } = await supabase
        .from("portal_snapshots")
        .update({ canonical_key: row.canonical_key })
        .eq("id", row.id);

      if (error) throw error;
    }
  }
}

async function upsertCanonicalInChunks(
  supabase: ReturnType<typeof createClient>,
  payloads: CanonicalPayload[]
): Promise<number> {
  const chunkSize = 500;
  let upserted = 0;

  for (let i = 0; i < payloads.length; i += chunkSize) {
    const chunk = payloads.slice(i, i + chunkSize);

    const { error } = await supabase
      .from("listings_canonical")
      .upsert(chunk, { onConflict: "canonical_key" });

    if (error) throw error;
    upserted += chunk.length;
  }

  return upserted;
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
    const sinceIso = new Date(
      Date.now() - params.window_hours * 60 * 60 * 1000
    ).toISOString();

    const { supabase, rows } = await fetchSnapshotsPagewise(params, sinceIso);

    if (!rows.length) {
      return new Response(
        JSON.stringify({
          ok: true,
          dry_run: params.dry_run,
          filters: {
            window_hours: params.window_hours,
            zip_code: params.zip_code || null,
            city: params.city || null,
            limit: params.limit,
            delete_stale_canonical: params.delete_stale_canonical,
          },
          processed: 0,
          snapshot_updates: 0,
          snapshot_updates_detected: 0,
          canonical_groups: 0,
          canonical_upserted: 0,
          stale_canonical_deleted: 0,
          stats: {
            singletons: 0,
            merged_groups: 0,
            merged_snapshots: 0,
          },
          message: "No snapshots found",
        }),
        {
          status: 200,
          headers: corsHeaders,
        }
      );
    }

    const primaryBuckets = new Map<string, SnapshotRow[]>();

    for (const row of rows) {
      const bucketKey = buildPrimaryBucketKey(row);
      const bucket = primaryBuckets.get(bucketKey) ?? [];
      bucket.push(row);
      primaryBuckets.set(bucketKey, bucket);
    }

    const updatesForSnapshots: Array<{ id: string; canonical_key: string }> = [];
    const canonicalPayloads: CanonicalPayload[] = [];
    const groupSummaries: Array<Record<string, unknown>> = [];

    let singletons = 0;
    let mergedGroups = 0;
    let mergedSnapshots = 0;

    for (const [, bucket] of primaryBuckets.entries()) {
      const refinedGroups = splitIntoCompatibleGroups(bucket);

      for (const refinedGroup of refinedGroups) {
        const canonicalKey = buildCanonicalKeyFromGroup(refinedGroup);

        for (const row of refinedGroup) {
          if (row.canonical_key !== canonicalKey) {
            updatesForSnapshots.push({
              id: row.id,
              canonical_key: canonicalKey,
            });
          }
        }

        if (refinedGroup.length <= 1) {
          singletons += 1;
        } else {
          mergedGroups += 1;
          mergedSnapshots += refinedGroup.length;
        }

        const payload = buildCanonicalPayload(canonicalKey, refinedGroup);
        canonicalPayloads.push(payload);

        if (params.include_groups) {
          groupSummaries.push({
            canonical_key: payload.canonical_key,
            city: payload.city,
            zip_code: payload.zip_code,
            price: payload.price,
            surface: payload.surface,
            price_m2: payload.price_m2,
            listing_count: payload.listing_count,
            portal_count: payload.portal_count,
            portals: payload.portals,
            portal_listing_ids: payload.portal_listing_ids,
            representative_url: payload.representative_url,
            first_seen_at: payload.first_seen_at,
            last_seen_at: payload.last_seen_at,
            dedupe_method: payload.dedupe_method,
            dedupe_confidence: payload.dedupe_confidence,
          });
        }
      }
    }

    if (!params.dry_run && updatesForSnapshots.length) {
      await updateSnapshotCanonicalKeysInChunks(supabase, updatesForSnapshots);
    }

    // ── Déduplique par canonical_key avant upsert ─────────────────────────
    // Plusieurs buckets peuvent produire la même canonical_key (même zip +
    // surface + priceM2 arrondis). Postgres refuse un ON CONFLICT DO UPDATE
    // qui touche la même ligne deux fois dans le même batch (code 21000).
    const dedupedPayloads = [
      ...new Map(
        canonicalPayloads.map((p) => [p.canonical_key, p])
      ).values(),
    ];
    // ─────────────────────────────────────────────────────────────────────

    let upserted = 0;
    let staleDeleted = 0;

    if (!params.dry_run && dedupedPayloads.length) {
      upserted = await upsertCanonicalInChunks(supabase, dedupedPayloads);
    }

    // Sécurité: on conserve le paramètre pour compatibilité API,
    // mais on neutralise volontairement la suppression destructive.
    if (!params.dry_run && params.delete_stale_canonical) {
      staleDeleted = 0;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: params.dry_run,
        filters: {
          window_hours: params.window_hours,
          zip_code: params.zip_code || null,
          city: params.city || null,
          city_normalized: params.city
            ? normalizeForCompare(params.city)
            : null,
          limit: params.limit,
          delete_stale_canonical: params.delete_stale_canonical,
        },
        processed: rows.length,
        primary_buckets: primaryBuckets.size,
        snapshot_updates: params.dry_run ? 0 : updatesForSnapshots.length,
        snapshot_updates_detected: updatesForSnapshots.length,
        canonical_groups: dedupedPayloads.length,
        canonical_upserted: params.dry_run ? 0 : upserted,
        stale_canonical_deleted: params.dry_run ? 0 : staleDeleted,
        stats: {
          singletons,
          merged_groups: mergedGroups,
          merged_snapshots: mergedSnapshots,
        },
        warnings: params.delete_stale_canonical
          ? [
              "delete_stale_canonical ignored intentionally to avoid unsafe deletions based on partial window runs",
            ]
          : [],
        groups: params.include_groups ? groupSummaries : undefined,
      }),
      {
        status: 200,
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error("market-dedupe-v1 error:", error);

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
        status: 400,
        headers: corsHeaders,
      }
    );
  }
});