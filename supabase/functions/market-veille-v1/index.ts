import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DAILY_REFRESH_LIMIT = 3;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type PropertyTypeFilter = "all" | "apartment" | "house" | "land";

type RequestBody = {
  zip_code?: string;
  city?: string | null;
  mode?: "reload" | "refresh";
  property_type_filter?: PropertyTypeFilter;
};

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeSearchText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function normalizePropertyTypeFilter(value: unknown): PropertyTypeFilter {
  if (
    value === "apartment" ||
    value === "house" ||
    value === "land" ||
    value === "all"
  ) {
    return value;
  }

  return "all";
}

function isLandRow(row: Record<string, unknown>): boolean {
  const propertyType = safeNumber(row.property_type, -1);

  const text = normalizeSearchText(
    [
      row.title,
      row.description,
      row.category,
      row.project_type,
      row.property_type_label,
      row.asset_type,
      row.listing_type,
    ]
      .filter(Boolean)
      .join(" ")
  );

  return (
    propertyType === 2 ||
    text.includes("terrain") ||
    text.includes("parcelle") ||
    text.includes("constructible") ||
    text.includes("terrain à bâtir") ||
    text.includes("terrain a batir") ||
    text.includes("lot à bâtir") ||
    text.includes("lot a batir")
  );
}

function matchesPropertyTypeFilter(
  row: Record<string, unknown>,
  filter: PropertyTypeFilter
): boolean {
  if (filter === "all") return true;

  const propertyType = safeNumber(row.property_type, -1);

  if (filter === "apartment") return propertyType === 0;
  if (filter === "house") return propertyType === 1 && !isLandRow(row);
  if (filter === "land") return isLandRow(row);

  return true;
}

function buildFallbackNarrative(
  city: string | null,
  zipCode: string,
  listingCount: number,
  mode: "reload" | "refresh"
) {
  return {
    stock_message:
      listingCount > 0
        ? `${listingCount} biens actifs détectés sur ${
            city ?? "la zone"
          } (${zipCode}).`
        : `Aucun bien actif détecté sur ${city ?? "la zone"} (${zipCode}).`,
    new_listings_message:
      mode === "refresh"
        ? "Actualisation complète de la veille demandée."
        : "Chargement de la veille demandé.",
    multi_portal_message:
      "Lecture multi-portail disponible à partir des annonces consolidées.",
    price_level_message:
      "Le niveau de prix est calculé à partir des annonces actives de la zone.",
    price_drop_message:
      "Les baisses de prix seront enrichies à mesure de l'historique.",
    market_duration_message:
      "La durée de diffusion sera consolidée avec les prochains snapshots.",
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !serviceRoleKey || !anonKey) {
      return new Response(
        JSON.stringify({
          ok: false,
          error:
            "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY",
        }),
        {
          status: 500,
          headers: corsHeaders,
        }
      );
    }

    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

    let rawBody: unknown = {};
    try {
      rawBody = await req.json();
    } catch {
      rawBody = {};
    }

    const body = (rawBody ?? {}) as RequestBody;

    const zipCode = normalizeText(body.zip_code);
    const city = normalizeText(body.city) || null;
    const mode: "reload" | "refresh" =
      body.mode === "refresh" ? "refresh" : "reload";

    const propertyTypeFilter = normalizePropertyTypeFilter(
      body.property_type_filter
    );

    if (!zipCode) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "zip_code manquant",
        }),
        {
          status: 400,
          headers: corsHeaders,
        }
      );
    }

    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Authorization header missing",
        }),
        {
          status: 401,
          headers: corsHeaders,
        }
      );
    }

    const userSupabase = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const {
      data: { user },
      error: userError,
    } = await userSupabase.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Utilisateur introuvable ou non authentifié",
        }),
        {
          status: 401,
          headers: corsHeaders,
        }
      );
    }

    const today = new Date().toISOString().slice(0, 10);

    const { count: refreshCount, error: refreshCountError } = await adminSupabase
      .from("market_refresh_usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("refresh_date", today);

    if (refreshCountError) throw refreshCountError;

    const usedRefreshes = refreshCount ?? 0;
    let remainingRefreshes = Math.max(0, DAILY_REFRESH_LIMIT - usedRefreshes);

    let refreshMeta: Record<string, unknown> | null = null;
    let refreshBlocked = false;

    if (mode === "refresh") {
      if (remainingRefreshes <= 0) {
        refreshBlocked = true;

        return new Response(
          JSON.stringify({
            ok: false,
            error: "Limite quotidienne atteinte",
            code: "DAILY_REFRESH_LIMIT_REACHED",
            daily_refresh_limit: DAILY_REFRESH_LIMIT,
            remaining_refreshes: 0,
            refresh_blocked: true,
          }),
          {
            status: 429,
            headers: corsHeaders,
          }
        );
      }

      const { error: usageInsertError } = await adminSupabase
        .from("market_refresh_usage")
        .insert({
          user_id: user.id,
          zip_code: zipCode,
          refresh_date: today,
        });

      if (usageInsertError) throw usageInsertError;

      remainingRefreshes = Math.max(0, remainingRefreshes - 1);

      try {
        const { data: dedupeData, error: dedupeError } =
          await adminSupabase.functions.invoke("market-dedupe-v1", {
            body: {
              zip_code: zipCode,
              city,
              window_hours: 72,
              limit: 5000,
              dry_run: false,
              include_groups: false,
              delete_stale_canonical: false,
            },
          });

        refreshMeta = {
          dedupe_ok: !dedupeError,
          dedupe_error: dedupeError?.message ?? null,
          dedupe_data: dedupeData ?? null,
        };
      } catch (err) {
        refreshMeta = {
          dedupe_ok: false,
          dedupe_error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const { data: listingsRows, error: listingsError } = await adminSupabase
      .from("v_market_active_listings")
      .select("*")
      .eq("zip_code", zipCode)
      .order("last_seen_at", { ascending: false })
      .limit(100);

    if (listingsError) throw listingsError;

    const allListings = Array.isArray(listingsRows)
      ? (listingsRows as Array<Record<string, unknown>>)
      : [];

    const listings = allListings.filter((row) =>
      matchesPropertyTypeFilter(row, propertyTypeFilter)
    );

    let narrative: Record<string, unknown> | null = null;

    try {
      const { data } = await adminSupabase
        .from("market_narrative_summary")
        .select("*")
        .eq("zip_code", zipCode)
        .maybeSingle();

      if (data) {
        narrative = {
          stock_message: data.stock_message ?? null,
          new_listings_message: data.new_listings_message ?? null,
          multi_portal_message: data.multi_portal_message ?? null,
          price_level_message: data.price_level_message ?? null,
          price_drop_message: data.price_drop_message ?? null,
          market_duration_message: data.market_duration_message ?? null,
        };
      }
    } catch {
      narrative = null;
    }

    if (!narrative) {
      narrative = buildFallbackNarrative(city, zipCode, listings.length, mode);
    }

    let summary = {
      unique_listings: listings.length,
      new_7d: 0,
      price_drops_7d: 0,
      multi_portal_pct: 0,
    };

    let tension = {
      tension_signal: "insuffisant",
      tension_message:
        "Historique insuffisant pour qualifier la tension du marché.",
    };

    try {
      const { data } = await adminSupabase
        .from("market_cp_latest")
        .select("*")
        .eq("zip_code", zipCode)
        .maybeSingle();

      if (data) {
        summary = {
          unique_listings:
            propertyTypeFilter === "all"
              ? safeNumber(data.unique_listings ?? data.stock_count, listings.length)
              : listings.length,
          new_7d: safeNumber(data.new_7d ?? data.new_count, 0),
          price_drops_7d: safeNumber(
            data.price_drops_7d ?? data.price_drop_count,
            0
          ),
          multi_portal_pct: safeNumber(data.multi_portal_pct, 0),
        };

        tension = {
          tension_signal: data.tension_signal ?? "insuffisant",
          tension_message:
            data.tension_message ??
            "Historique insuffisant pour qualifier la tension du marché.",
        };
      }
    } catch {
      // fallback déjà prêt
    }

    let opportunities: Array<Record<string, unknown>> = [];

    try {
      const { data } = await adminSupabase
        .from("market_opportunities_top")
        .select("*")
        .eq("zip_code", zipCode)
        .limit(50);

      const rawOpportunities = Array.isArray(data)
        ? (data as Array<Record<string, unknown>>)
        : [];

      const filteredOpportunities = rawOpportunities
        .filter((row) => matchesPropertyTypeFilter(row, propertyTypeFilter))
        .slice(0, 12);

      opportunities = filteredOpportunities.map((row) => ({
        canonical_key:
          row.canonical_key ?? row.external_id ?? crypto.randomUUID(),
        city: row.city ?? city,
        zip_code: row.zip_code ?? zipCode,
        intro:
          row.intro ??
          [
            row.title ?? "Bien détecté",
            row.surface_m2 ? `${row.surface_m2} m²` : null,
            row.price ? `${row.price} €` : null,
          ]
            .filter(Boolean)
            .join(" - "),
        price_position: row.price_position ?? "",
        price_drop_info: row.price_drop_info ?? "",
        diffusion_info: row.diffusion_info ?? "",
        opportunity_score: safeNumber(row.opportunity_score, 60),
        opportunity_bucket:
          row.opportunity_bucket === "forte" ||
          row.opportunity_bucket === "moyenne" ||
          row.opportunity_bucket === "faible"
            ? row.opportunity_bucket
            : "moyenne",
        price: row.price ?? null,
        surface: row.surface_m2 ?? row.surface ?? null,
        price_m2: row.price_m2 ?? row.price_per_m2 ?? null,
        representative_url: row.representative_url ?? row.source_url ?? null,
        property_type: row.property_type ?? null,
      }));
    } catch {
      opportunities = [];
    }

    return new Response(
      JSON.stringify({
        ok: true,
        mode,
        property_type_filter: propertyTypeFilter,
        zone: {
          zip_code: zipCode,
          city,
        },
        narrative,
        summary,
        tension,
        opportunities,
        refresh_meta: refreshMeta,
        daily_refresh_limit: DAILY_REFRESH_LIMIT,
        remaining_refreshes: remainingRefreshes,
        refresh_blocked: refreshBlocked,
      }),
      {
        status: 200,
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error("[market-veille-v1] error:", error);

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