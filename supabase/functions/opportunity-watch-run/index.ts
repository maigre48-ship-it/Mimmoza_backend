// =============================================================
// Mimmoza · Veille active — opportunity-watch-run
// Déclenchée par pg_cron (service_role). Pour chaque veille "due" :
//   1) ingestion de la zone (dédupliquée par code postal),
//   2) lecture portal_snapshots filtrée par les critères,
//   3) diff vs opportunity_watch_listings -> événements :
//        - new_listing  (annonce jamais vue)
//        - price_drop   (baisse >= seuil sur une annonce déjà suivie)
//   4) maj last_run_at.
//
// Le scoring "opportunité forte" est traité dans un incrément ultérieur
// (le moteur de scoring vit côté front). Ici : nouveau + baisse de prix.
//
// Premier run d'une veille = baseline : on ENREGISTRE l'état sans émettre
// d'événements (sinon toutes les annonces existantes seraient "nouvelles").
// =============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HANDLER_VERSION = "opportunity-watch-run-v1";
const PRICE_DROP_THRESHOLD = 0.03; // >= 3 %
const INGEST_MAX_PAGES = 5;
const ZONE_READ_CAP = 500; // lecture max par zone avant filtrage critères

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type Strategy = "investisseur" | "rehabilitateur" | "promoteur";

type Criteria = {
  assetType?: "appartement" | "maison" | "terrain" | "immeuble" | "local" | "all";
  priceMin?: number | null;
  priceMax?: number | null;
  surfaceMin?: number | null;
  surfaceMax?: number | null;
};

type Watch = {
  id: string;
  user_id: string;
  label: string;
  city: string | null;
  zip_code: string | null;
  strategy: Strategy;
  criteria: Criteria | null;
  min_score: number;
  frequency: "daily" | "weekly";
  notify_inapp: boolean;
  notify_email: boolean;
  active: boolean;
  last_run_at: string | null;
  max_listings: number;
};

type Snapshot = {
  portal: string | null;
  listing_portal_id: string | null;
  url: string | null;
  title: string | null;
  price: number | null;
  surface: number | null;
  surface_m2: number | null;
  property_type: number | null;
  city: string | null;
  zip_code: string | null;
  seen_at: string | null;
};

type WatchListingState = {
  listing_key: string;
  last_price: number | null;
};

type WatchEventInsert = {
  watch_id: string;
  user_id: string;
  event_type: "new_listing" | "price_drop" | "strong_opportunity";
  listing_key: string;
  url: string | null;
  title: string | null;
  price: number | null;
  previous_price: number | null;
  price_delta_pct: number | null;
  score: number | null;
  payload: Record<string, unknown> | null;
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(",", ".").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function zoneKeyOf(w: Watch): string {
  return (w.zip_code?.trim() || w.city?.trim() || "").toLowerCase();
}

function isDue(w: Watch): boolean {
  if (!w.active) return false;
  if (!w.last_run_at) return true;
  const last = new Date(w.last_run_at).getTime();
  if (!Number.isFinite(last)) return true;
  const interval = (w.frequency === "weekly" ? 7 : 1) * 24 * 3600 * 1000;
  // 1h de marge pour qu'un cron à heure fixe qualifie une veille quotidienne.
  return Date.now() - last >= interval - 3600 * 1000;
}

function assetWanted(at: Criteria["assetType"]): number | null {
  if (at === "appartement") return 0;
  if (at === "maison") return 1;
  if (at === "terrain") return 2;
  return null;
}

function matchesCriteria(s: Snapshot, c: Criteria | null): boolean {
  if (!c) return true;
  const want = assetWanted(c.assetType);
  if (c.assetType && c.assetType !== "all" && want !== null) {
    if (s.property_type !== want) return false;
  }
  const price = num(s.price);
  if (c.priceMin != null && (price == null || price < c.priceMin)) return false;
  if (c.priceMax != null && (price == null || price > c.priceMax)) return false;
  const surf = num(s.surface_m2) ?? num(s.surface);
  if (c.surfaceMin != null && (surf == null || surf < c.surfaceMin)) return false;
  if (c.surfaceMax != null && (surf == null || surf > c.surfaceMax)) return false;
  return true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "Missing SUPABASE env", handler_version: HANDLER_VERSION }),
      { status: 500, headers: corsHeaders },
    );
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    let body: { watch_id?: string; force?: boolean } = {};
    try { body = await req.json(); } catch { body = {}; }

    // 1) Sélection des veilles à traiter.
    let query = supabase
      .from("opportunity_watches")
      .select(
        "id, user_id, label, city, zip_code, strategy, criteria, min_score, frequency, notify_inapp, notify_email, active, last_run_at, max_listings",
      )
      .eq("active", true);

    if (body.watch_id) query = query.eq("id", body.watch_id);

    const { data: watchesData, error: watchesErr } = await query;
    if (watchesErr) throw watchesErr;

    const allWatches = (watchesData ?? []) as Watch[];
    const dueWatches = body.watch_id || body.force
      ? allWatches
      : allWatches.filter(isDue);

    if (dueWatches.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, handler_version: HANDLER_VERSION, due_watches: 0, message: "Aucune veille due." }),
        { status: 200, headers: corsHeaders },
      );
    }

    // 2) Regroupement par zone + volume d'ingestion = max des veilles de la zone.
    const zones = new Map<string, { zip?: string; city?: string; maxListings: number; watches: Watch[] }>();
    for (const w of dueWatches) {
      const key = zoneKeyOf(w);
      if (!key) continue;
      const existing = zones.get(key);
      if (existing) {
        existing.maxListings = Math.max(existing.maxListings, w.max_listings);
        existing.watches.push(w);
      } else {
        zones.set(key, {
          zip: w.zip_code?.trim() || undefined,
          city: w.city?.trim() || undefined,
          maxListings: w.max_listings,
          watches: [w],
        });
      }
    }

    let totalNew = 0;
    let totalDrops = 0;
    let zonesIngested = 0;
    const perWatch: Array<Record<string, unknown>> = [];

    // 3) Traitement zone par zone.
    for (const [, zone] of zones) {
      // 3a) Ingestion (une fois par zone).
      try {
        await supabase.functions.invoke("stream-estate-ingest-v1", {
          body: {
            zip_code: zone.zip,
            city: zone.city,
            limit: zone.maxListings,
            max_pages: INGEST_MAX_PAGES,
            transaction_mode: "sale",
          },
        });
        zonesIngested += 1;
      } catch (e) {
        console.error("[watch-run] ingest failed", zoneKeyFromZone(zone), e);
        // On continue : on diffe sur les données déjà en base.
      }

      // 3b) Lecture des snapshots de la zone (une fois).
      let snapQuery = supabase
        .from("portal_snapshots")
        .select(
          "portal, listing_portal_id, url, title, price, surface, surface_m2, property_type, city, zip_code, seen_at",
        )
        .order("seen_at", { ascending: false })
        .limit(ZONE_READ_CAP);
      if (zone.zip) snapQuery = snapQuery.eq("zip_code", zone.zip);
      else if (zone.city) snapQuery = snapQuery.ilike("city", `%${zone.city}%`);

      const { data: snapData, error: snapErr } = await snapQuery;
      if (snapErr) {
        console.error("[watch-run] snapshots read failed", snapErr);
        continue;
      }
      const snapshots = (snapData ?? []) as Snapshot[];

      // 3c) Pour chaque veille de la zone : filtrage + diff + événements.
      for (const w of zone.watches) {
        const matching = snapshots
          .filter((s) => s.listing_portal_id && matchesCriteria(s, w.criteria))
          .slice(0, w.max_listings);

        // État existant de la veille.
        const { data: stateData, error: stateErr } = await supabase
          .from("opportunity_watch_listings")
          .select("listing_key, last_price")
          .eq("watch_id", w.id);
        if (stateErr) {
          console.error("[watch-run] state read failed", stateErr);
          continue;
        }
        const stateRows = (stateData ?? []) as WatchListingState[];
        const stateByKey = new Map(stateRows.map((r) => [r.listing_key, r]));
        const firstRun = stateRows.length === 0;

        const events: WatchEventInsert[] = [];
        const stateUpserts: Array<Record<string, unknown>> = [];
        let watchNew = 0;
        let watchDrops = 0;

        for (const s of matching) {
          const key = `${s.portal ?? "na"}:${s.listing_portal_id}`;
          const price = num(s.price);
          const prev = stateByKey.get(key);

          if (!prev) {
            // Nouvelle annonce.
            stateUpserts.push({
              watch_id: w.id,
              listing_key: key,
              url: s.url,
              title: s.title,
              last_price: price,
              last_seen_at: new Date().toISOString(),
            });
            if (!firstRun) {
              watchNew += 1;
              events.push({
                watch_id: w.id,
                user_id: w.user_id,
                event_type: "new_listing",
                listing_key: key,
                url: s.url,
                title: s.title,
                price,
                previous_price: null,
                price_delta_pct: null,
                score: null,
                payload: { city: s.city, zip_code: s.zip_code, property_type: s.property_type },
              });
            }
          } else {
            // Annonce déjà suivie : test baisse de prix.
            const prevPrice = prev.last_price;
            const isDrop =
              price != null && prevPrice != null && prevPrice > 0 &&
              price < prevPrice * (1 - PRICE_DROP_THRESHOLD);

            if (isDrop) {
              const deltaPct = Math.round(((price! - prevPrice!) / prevPrice!) * 1000) / 10; // négatif
              watchDrops += 1;
              events.push({
                watch_id: w.id,
                user_id: w.user_id,
                event_type: "price_drop",
                listing_key: key,
                url: s.url,
                title: s.title,
                price,
                previous_price: prevPrice,
                price_delta_pct: deltaPct,
                score: null,
                payload: { city: s.city, zip_code: s.zip_code },
              });
            }

            // Maj état (prix courant + last_seen).
            stateUpserts.push({
              watch_id: w.id,
              listing_key: key,
              url: s.url,
              title: s.title,
              last_price: price ?? prevPrice,
              last_seen_at: new Date().toISOString(),
            });
          }
        }

        // Écritures.
        if (stateUpserts.length > 0) {
          const { error: upErr } = await supabase
            .from("opportunity_watch_listings")
            .upsert(stateUpserts, { onConflict: "watch_id,listing_key" });
          if (upErr) console.error("[watch-run] state upsert failed", upErr);
        }
        if (events.length > 0) {
          const { error: evErr } = await supabase.from("opportunity_watch_events").insert(events);
          if (evErr) console.error("[watch-run] events insert failed", evErr);
        }

        await supabase
          .from("opportunity_watches")
          .update({ last_run_at: new Date().toISOString() })
          .eq("id", w.id);

        totalNew += watchNew;
        totalDrops += watchDrops;
        perWatch.push({
          watch_id: w.id,
          label: w.label,
          first_run: firstRun,
          matched: matching.length,
          new_listings: watchNew,
          price_drops: watchDrops,
        });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        handler_version: HANDLER_VERSION,
        due_watches: dueWatches.length,
        zones_ingested: zonesIngested,
        total_new_listings: totalNew,
        total_price_drops: totalDrops,
        per_watch: perWatch,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (error) {
    console.error("opportunity-watch-run error:", error);
    return new Response(
      JSON.stringify({
        ok: false,
        handler_version: HANDLER_VERSION,
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: corsHeaders },
    );
  }
});

// Helper de log (zone n'a pas de clé propre stockée).
function zoneKeyFromZone(zone: { zip?: string; city?: string }): string {
  return zone.zip || zone.city || "?";
}