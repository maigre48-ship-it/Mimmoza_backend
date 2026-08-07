import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HANDLER_VERSION = "stream-estate-ingest-v1-geo-smart-v8";

const EARLY_BAIL_AFTER_PAGES = 2;
const EARLY_BAIL_MIN_ADVERTS_SEEN = 10;

type RequestBody = {
  limit?: number;
  dry_run?: boolean;
  zip_code?: string;
  city?: string;
  transaction_mode?: "all" | "sale" | "rent";
  max_pages?: number;
  start_page?: number;
  debug_geo?: boolean;
};

type StreamEstateResponse = {
  "@context"?: string;
  "@id"?: string;
  "@type"?: string;
  "hydra:member"?: unknown[];
  "hydra:totalItems"?: number;
  "hydra:view"?: {
    "@id"?: string;
    "@type"?: string;
    "hydra:first"?: string;
    "hydra:last"?: string;
    "hydra:next"?: string;
    "hydra:previous"?: string;
  };
};

type PortalSnapshotInsert = {
  portal: string;
  listing_portal_id: string;
  url: string;
  city: string | null;
  zip_code: string | null;
  price: number | null;
  surface: number | null;
  surface_m2: number | null;
  price_m2: number | null;
  rooms: number | null;
  // ── V8 : titre + description (titres réels + détection réhab) ──────────
  title: string | null;
  description: string | null;
  // ── V7 : champs type de bien ──────────────────────────────────────────
  // 0 = appartement, 1 = maison, 2 = terrain  (mapping Stream Estate natif)
  property_type: number | null;
  land_surface_m2: number | null;
  // ─────────────────────────────────────────────────────────────────────
  first_seen_at: string;
  seen_at: string;
  updated_at: string;
};

type GeoResult = {
  city: string | null;
  zipCode: string | null;
  cityCandidates: string[];
  zipCandidates: string[];
  propertyCity: string | null;
  propertyZip: string | null;
  advertCity: string | null;
  advertZip: string | null;
  title: string | null;
  description: string | null;
};

type SnapshotWithGeo = {
  row: PortalSnapshotInsert;
  geo: GeoResult;
};

type FetchPageResult = {
  parsed: StreamEstateResponse;
  rawText: string;
  nextUrl: string | null;
  currentUrl: string;
};

type GeoDebugRow = {
  portal: string;
  listing_portal_id: string;
  url: string;
  derived_city: string | null;
  derived_zip_code: string | null;
  city_candidates: string[];
  zip_candidates: string[];
  property_city: string | null;
  property_zip: string | null;
  advert_city: string | null;
  advert_zip: string | null;
  title: string | null;
  description_preview: string | null;
};

type GeoMatchResult =
  | {
      match: true;
      detectedZip: string | null;
      confidence: "high" | "medium" | "low";
      acceptReason: string;
    }
  | {
      match: false;
      reason: "zip_mismatch" | "zip_missing" | "city_mismatch";
      detectedZip: string | null;
      rejectDetail: string;
    };

const STREAM_ESTATE_BASE_URL = "https://api.stream.estate";
const STREAM_ESTATE_PROPERTIES_PATH = "/documents/properties";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length ? v : null;
}

function normalizeForCompare(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(",", ".").trim();
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseBody(raw: unknown): Required<RequestBody> {
  const body = (raw ?? {}) as RequestBody;

  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(5000, Math.round(body.limit)))
      : 500;

  const maxPages =
    typeof body.max_pages === "number" && Number.isFinite(body.max_pages)
      ? Math.max(1, Math.min(100, Math.round(body.max_pages)))
      : 25;

  const startPage =
    typeof body.start_page === "number" && Number.isFinite(body.start_page)
      ? Math.max(1, Math.min(10000, Math.round(body.start_page)))
      : 1;

  const transactionMode =
    body.transaction_mode === "sale" ||
    body.transaction_mode === "rent" ||
    body.transaction_mode === "all"
      ? body.transaction_mode
      : "all";

  return {
    limit,
    dry_run: Boolean(body.dry_run),
    zip_code: normalizeText(body.zip_code) ?? "",
    city: normalizeText(body.city) ?? "",
    transaction_mode: transactionMode,
    max_pages: maxPages,
    start_page: startPage,
    debug_geo: Boolean(body.debug_geo),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    const rec = asRecord(current);
    if (!rec || !(part in rec)) return undefined;
    current = rec[part];
  }
  return current;
}

function firstString(obj: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const value = getByPath(obj, path);
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return null;
}

function firstNumber(obj: unknown, paths: string[]): number | null {
  for (const path of paths) {
    const value = getByPath(obj, path);
    const n = toNumber(value);
    if (n !== null) return n;
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalizeForCompare(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizePortalName(value: string | null): string {
  const raw = (value ?? "stream_estate").trim().toLowerCase();
  if (raw === "l-immo" || raw === "logic-immo") return "logic-immo";
  if (raw === "sl" || raw === "seloger") return "seloger";
  if (raw === "lbc" || raw === "leboncoin") return "leboncoin";
  if (raw === "bic" || raw === "bienici") return "bienici";
  if (raw === "gdc" || raw === "gens de confiance") return "gensdeconfiance";
  if (raw === "belles demeures") return "bellesdemeures";
  return raw;
}

function guessTransactionMode(
  advert: unknown,
  property: unknown
): "sale" | "rent" | "unknown" {
  const transactionType =
    firstString(advert, ["transactionType"]) ??
    firstString(property, ["transactionType"]);

  const txNorm = normalizeForCompare(transactionType);
  if (txNorm === "0" || txNorm.includes("vente") || txNorm.includes("sale") || txNorm.includes("achat")) return "sale";
  if (txNorm === "1" || txNorm.includes("location") || txNorm.includes("rent") || txNorm.includes("louer")) return "rent";

  const url = (firstString(advert, ["url"]) ?? firstString(property, ["url"]) ?? "").toLowerCase();
  const description = (firstString(advert, ["description"]) ?? firstString(property, ["description"]) ?? "").toLowerCase();
  const text = `${url} ${description}`;

  if (/detail-location|\/location| a louer| à louer|location|loyer|bail/.test(text)) return "rent";
  if (/detail-vente|\/vente|\/achat| a vendre| à vendre|vente|achat/.test(text)) return "sale";

  return "unknown";
}

/**
 * Extrait le property_type Stream Estate depuis advert ou property.
 *
 * Stream Estate encode : 0 = appartement, 1 = maison, 2 = terrain.
 * On cherche aussi les variantes string ("2", "terrain", "land") pour
 * être robuste aux portails qui sérialisent différemment.
 */
function extractPropertyType(advert: unknown, property: unknown): number | null {
  // Lecture numérique directe
  const numeric =
    firstNumber(advert, ["propertyType", "property_type", "type"]) ??
    firstNumber(property, ["propertyType", "property_type", "type"]);

  if (numeric !== null) {
    const rounded = Math.round(numeric);
    if (rounded >= 0 && rounded <= 10) return rounded;
  }

  // Lecture via string label pour les portails qui envoient le libellé
  const label =
    firstString(advert, ["propertyTypeLabel", "property_type_label", "assetType", "asset_type"]) ??
    firstString(property, ["propertyTypeLabel", "property_type_label", "assetType", "asset_type"]);

  if (label) {
    const norm = normalizeForCompare(label);
    if (norm === "terrain" || norm === "land" || norm.includes("terrain") || norm.includes("constructib")) return 2;
    if (norm === "maison" || norm === "house" || norm === "villa" || norm === "pavillon") return 1;
    if (norm === "appartement" || norm === "apartment" || norm === "studio" || norm === "duplex") return 0;
  }

  return null;
}

/**
 * Extrait la surface de terrain (land_surface_m2).
 * Distinct de la surface habitable (surface_m2).
 */
function extractLandSurface(advert: unknown, property: unknown): number | null {
  return (
    firstNumber(advert, [
      "landSurface", "land_surface", "terrainSurface", "terrain_surface",
      "landArea", "land_area", "surfaceTerrain", "surface_terrain",
    ]) ??
    firstNumber(property, [
      "landSurface", "land_surface", "terrainSurface", "terrain_surface",
      "landArea", "land_area", "surfaceTerrain", "surface_terrain",
    ])
  );
}

function extractListingIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const clean = url.split("?")[0];
  const exactPatterns: RegExp[] = [
    /\/(\d{6,})\/detail\.htm$/i,
    /\/(\d{6,})\.htm$/i,
    /detail-(?:vente|location)-(\d{6,})\.htm$/i,
    /\/ad\/[^/]+\/(\d{6,})$/i,
    /\/ref-([a-z0-9-]+)$/i,
    /\/annonce\/([a-z0-9-_]+)$/i,
  ];
  for (const pattern of exactPatterns) {
    const match = clean.match(pattern);
    if (match?.[1]) return match[1];
  }
  const numericGroups = clean.match(/\d{6,}/g);
  if (numericGroups?.length) return numericGroups[numericGroups.length - 1] ?? null;
  return clean.split("/").filter(Boolean).pop() ?? null;
}

function extractZipCodes(value: string | null): string[] {
  if (!value) return [];
  const matches = value.match(/\b\d{5}\b/g) ?? [];
  return [...new Set(matches)];
}

function extractCityFromUrl(url: string | null): string | null {
  if (!url) return null;
  const lower = url.toLowerCase();
  const patterns: RegExp[] = [
    /\/(?:achat|vente|location)\/(?:appartement|maison|terrain|parking|bureau|immeuble|local-commercial)\/([^/]+)-\d{2,5}\//i,
    /\/annonces-immobilieres\/(?:appartement|maison|terrain|parking|bureau|immeuble|local-commercial)\/(?:vente|location)\/([^/]+)-\d{5}\//i,
  ];
  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match?.[1]) {
      return titleCase(match[1].replace(/-/g, " ").replace(/\s+/g, " ").trim());
    }
  }
  return null;
}

function extractCityCandidatesFromText(value: string | null): string[] {
  if (!value) return [];
  const candidates = new Set<string>();

  const parisArr = value.match(/\bparis[\s-]*(\d{1,2})(?:e|er|eme|ème)?\b/i);
  if (parisArr?.[1]) candidates.add("Paris");

  const genericPatterns: RegExp[] = [
    /\b(?:à|a|sur|de|en|dans)\s+([A-ZÀ-ÿ][A-Za-zÀ-ÿ' -]{2,40})/g,
    /\b([A-ZÀ-ÿ][A-Za-zÀ-ÿ' -]{2,40})\s+\(\d{5}\)/g,
  ];
  for (const pattern of genericPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const city = normalizeText(match[1]);
      if (!city || city.length < 3) continue;
      candidates.add(titleCase(city.toLowerCase()));
      if (candidates.size >= 8) break;
    }
  }
  return [...candidates];
}

/**
 * Normalise un nom de ville composé vers sa base.
 * "Paris 18e" → "Paris", "Lyon 3" → "Lyon", "Marseille 13" → "Marseille"
 */
function extractBaseCityName(value: string): string {
  const normalized = value.trim();
  if (/^Paris\s*[\d(]/i.test(normalized)) return "Paris";
  if (/^Lyon\s*\d/i.test(normalized)) return "Lyon";
  if (/^Marseille\s*\d/i.test(normalized)) return "Marseille";
  return normalized;
}

function buildListingPortalId(advert: unknown, property: unknown, index: number): string {
  const portal = normalizePortalName(
    firstString(advert, ["publisher.name", "publisher.label", "portal"]) ??
      firstString(property, ["publisher.name", "publisher.label", "portal"])
  );
  const explicitId =
    firstString(advert, ["uuid", "id", "@id", "externalId", "listingId"]) ??
    firstString(property, ["uuid", "id", "@id", "externalId"]);
  if (explicitId && !explicitId.includes("/documents/properties")) return explicitId;

  const url =
    firstString(advert, ["url"]) ??
    firstString(property, ["url"]) ??
    firstString(advert, ["link"]) ??
    firstString(property, ["link"]);

  const extractedFromUrl = extractListingIdFromUrl(url);
  if (extractedFromUrl) {
    if (portal === "seloger" && extractedFromUrl === "message-sharing") {
      return `${portal}-${index}-${Date.now()}`;
    }
    return extractedFromUrl;
  }
  return `${firstString(property, ["@id"]) ?? "property"}-${index}`;
}

function deriveGeo(advert: unknown, property: unknown, url: string): GeoResult {
  const propertyLocation = asRecord(getByPath(property, "location"));
  const advertLocation = asRecord(getByPath(advert, "location"));

  const title = firstString(advert, ["title"]) ?? firstString(property, ["title"]);
  const description = firstString(advert, ["description"]) ?? firstString(property, ["description"]);

  const stationNames = asArray(getByPath(property, "stations"))
    .map((station) => firstString(station, ["city", "name", "label", "station.name"]))
    .filter((v): v is string => Boolean(v));

  // ── Lecture de l'objet city structuré Stream Estate ────────────────────
  // La vraie structure est property.city.zipcode / property.city.name
  const propertyCityObj = asRecord(getByPath(property, "city"));
  const propertyCityZip = normalizeText(propertyCityObj?.["zipcode"]);
  const propertyCityName =
    normalizeText(propertyCityObj?.["name"]) ??
    normalizeText(propertyCityObj?.["originalName"]);
  // ───────────────────────────────────────────────────────────────────────

  const propertyCity =
    propertyCityName ??
    firstString(property, [
      "property.city", "location.city", "location.label",
      "property.location.city", "property.location.label",
    ]) ?? firstString(propertyLocation, ["city", "label"]);

  const advertCity =
    firstString(advert, [
      "city", "address.city", "location.city", "address.locality",
    ]) ?? firstString(advertLocation, ["city", "label"]);

  const propertyZip =
    propertyCityZip ??
    firstString(property, [
      "zipCode", "zip_code", "postalCode", "postcode",
      "location.zipCode", "location.postalCode",
      "property.zipCode", "property.postalCode",
    ]) ?? firstString(propertyLocation, ["zipCode", "postalCode"]);

  const advertZip =
    firstString(advert, [
      "zipCode", "zip_code", "postalCode", "postcode",
      "address.zipCode", "address.postalCode",
      "location.zipCode", "location.postalCode",
    ]) ?? firstString(advertLocation, ["zipCode", "postalCode"]);

  // Expansion des noms de ville composés ("Paris 18e" → aussi "Paris")
  const rawCityCandidates = [
    advertCity,
    propertyCity,
    extractCityFromUrl(url),
    ...extractCityCandidatesFromText(title),
    ...extractCityCandidatesFromText(description),
    ...stationNames,
  ].filter((v): v is string => Boolean(v));

  const expandedCityCandidates: Array<string | null> = [];
  for (const c of rawCityCandidates) {
    expandedCityCandidates.push(c);
    const base = extractBaseCityName(c);
    if (base !== c) expandedCityCandidates.push(base);
  }

  const cityCandidates = uniqueStrings(expandedCityCandidates);

  const zipCandidates = uniqueStrings([
    advertZip,
    propertyZip,
    ...extractZipCodes(url),
    ...extractZipCodes(title),
    ...extractZipCodes(description),
  ]);

  return {
    city: cityCandidates[0] ?? null,
    zipCode: zipCandidates[0] ?? null,
    cityCandidates,
    zipCandidates,
    propertyCity,
    propertyZip,
    advertCity,
    advertZip,
    title,
    description,
  };
}

function matchesGeo(
  row: PortalSnapshotInsert,
  geo: GeoResult,
  params: Required<RequestBody>
): GeoMatchResult {
  const filterZip = normalizeText(params.zip_code);
  const filterCity = normalizeText(params.city);
  const filterCityNorm = normalizeForCompare(filterCity);

  if (!filterZip && !filterCityNorm) {
    return { match: true, detectedZip: geo.zipCandidates[0] ?? null, confidence: "high", acceptReason: "no_filter" };
  }

  if (filterZip) {
    const structuredZip = normalizeText(geo.advertZip) ?? normalizeText(geo.propertyZip);
    if (structuredZip !== null) {
      if (structuredZip === filterZip) {
        return { match: true, detectedZip: structuredZip, confidence: "high", acceptReason: "structured_zip_exact" };
      }
      return {
        match: false, reason: "zip_mismatch", detectedZip: structuredZip,
        rejectDetail: `structured_zip=${structuredZip} vs filter=${filterZip}`,
      };
    }

    if (geo.zipCandidates.includes(filterZip)) {
      return { match: true, detectedZip: filterZip, confidence: "medium", acceptReason: "zip_in_text_candidates" };
    }

    const allText = [geo.title ?? "", (geo.description ?? "").slice(0, 600), row.url].join(" ");

    if (/^75\d{3}$/.test(filterZip)) {
      const arrNum = parseInt(filterZip.slice(3), 10);
      const hasParis = geo.cityCandidates.some((c) => normalizeForCompare(c) === "paris");
      if (hasParis) {
        const arrPattern = new RegExp(
          `\\b${arrNum}(?:e|er|eme|ème)?(?:\\s*arr(?:ondissement)?)?\\b|paris[\\s-]*${arrNum}`,
          "i"
        );
        if (arrPattern.test(allText)) {
          return { match: true, detectedZip: null, confidence: "medium", acceptReason: `paris_arr_${arrNum}_in_text` };
        }
        if (filterCityNorm === "paris") {
          return { match: true, detectedZip: null, confidence: "low", acceptReason: "paris_city_confirmed_no_arr" };
        }
      }
    }

    if (/^6900[1-9]$/.test(filterZip)) {
      const hasLyon = geo.cityCandidates.some((c) => normalizeForCompare(c) === "lyon");
      if (hasLyon) {
        return { match: true, detectedZip: null, confidence: "low", acceptReason: "lyon_city_confirmed" };
      }
    }

    if (/^130(?:0[1-9]|1[0-6])$/.test(filterZip)) {
      const hasMarseille = geo.cityCandidates.some((c) => normalizeForCompare(c) === "marseille");
      if (hasMarseille) {
        return { match: true, detectedZip: null, confidence: "low", acceptReason: "marseille_city_confirmed" };
      }
    }

    if (filterCityNorm) {
      const cityMatch = geo.cityCandidates.some((c) => normalizeForCompare(c) === filterCityNorm);
      if (cityMatch) {
        return { match: true, detectedZip: null, confidence: "low", acceptReason: "filter_city_matches_candidate" };
      }
    }

    return {
      match: false, reason: "zip_missing", detectedZip: null,
      rejectDetail: `no_zip_signal for filter=${filterZip} city_candidates=[${geo.cityCandidates.join(",")}]`,
    };
  }

  if (filterCityNorm) {
    const detectedZip = geo.zipCandidates[0] ?? null;
    if (normalizeForCompare(row.city) === filterCityNorm) {
      return { match: true, detectedZip, confidence: "high", acceptReason: "row_city_exact" };
    }
    if (geo.cityCandidates.some((c) => normalizeForCompare(c) === filterCityNorm)) {
      return { match: true, detectedZip, confidence: "medium", acceptReason: "city_candidate_match" };
    }
    return {
      match: false, reason: "city_mismatch", detectedZip,
      rejectDetail: `filter_city=${filterCityNorm} not in candidates=[${geo.cityCandidates.map(normalizeForCompare).join(",")}]`,
    };
  }

  return { match: true, detectedZip: geo.zipCandidates[0] ?? null, confidence: "high", acceptReason: "no_filter_fallback" };
}

function buildSnapshotRow(advert: unknown, property: unknown, index: number): SnapshotWithGeo | null {
  const portal = normalizePortalName(
    firstString(advert, ["publisher.name", "publisher.label", "portal"]) ??
      firstString(property, ["publisher.name", "publisher.label", "portal"])
  );

  const url =
    firstString(advert, ["url"]) ??
    firstString(property, ["url"]) ??
    firstString(advert, ["link"]) ??
    firstString(property, ["link"]);

  if (!url) return null;

  const listingPortalId = buildListingPortalId(advert, property, index);
  const geo = deriveGeo(advert, property, url);

  const price =
    firstNumber(advert, ["price", "priceAmount"]) ??
    firstNumber(property, ["price", "priceAmount"]);

  const surface =
    firstNumber(advert, ["surface", "surfaceM2", "surface_m2", "area"]) ??
    firstNumber(property, ["surface", "surfaceM2", "surface_m2", "area"]);

  const priceM2 =
    firstNumber(advert, ["pricePerMeter", "pricePerSquareMeter", "price_m2"]) ??
    firstNumber(property, ["pricePerMeter", "pricePerSquareMeter", "price_m2"]) ??
    (price !== null && surface !== null && surface > 0 ? Number((price / surface).toFixed(2)) : null);

  const rooms =
    firstNumber(advert, ["room", "rooms"]) ??
    firstNumber(property, ["room", "rooms"]);

  // ── V7 : property_type + land_surface_m2 ──────────────────────────────
  const propertyType = extractPropertyType(advert, property);
  const landSurface = extractLandSurface(advert, property);
  // ─────────────────────────────────────────────────────────────────────

  const firstSeenAt =
    firstString(advert, ["createdAt", "publishedAt"]) ??
    firstString(property, ["createdAt", "publishedAt"]) ??
    new Date().toISOString();

  const seenAt =
    firstString(advert, ["lastCrawledAt", "updatedAt", "createdAt"]) ??
    firstString(property, ["lastCrawledAt", "updatedAt", "createdAt"]) ??
    new Date().toISOString();

  const row: PortalSnapshotInsert = {
    portal,
    listing_portal_id: listingPortalId,
    url,
    city: geo.city,
    zip_code: geo.zipCode,
    price,
    surface,
    surface_m2: surface,
    price_m2: priceM2,
    rooms,
    // ── V8 : titre + description (déjà extraits par deriveGeo) ───────────
    title: geo.title ?? null,
    description: geo.description ?? null,
    // ────────────────────────────────────────────────────────────────────
    property_type: propertyType,
    land_surface_m2: landSurface ?? null,
    first_seen_at: firstSeenAt,
    seen_at: seenAt,
    updated_at: new Date().toISOString(),
  };

  return { row, geo };
}

function buildGeoDebugRow(advert: unknown, property: unknown, row: PortalSnapshotInsert): GeoDebugRow {
  const geo = deriveGeo(advert, property, row.url);
  return {
    portal: row.portal,
    listing_portal_id: row.listing_portal_id,
    url: row.url,
    derived_city: geo.city,
    derived_zip_code: geo.zipCode,
    city_candidates: geo.cityCandidates,
    zip_candidates: geo.zipCandidates,
    property_city: geo.propertyCity,
    property_zip: geo.propertyZip,
    advert_city: geo.advertCity,
    advert_zip: geo.advertZip,
    title: geo.title,
    description_preview: geo.description?.slice(0, 240) ?? null,
  };
}

function buildAbsoluteUrl(nextPath: string | null): string | null {
  if (!nextPath) return null;
  if (nextPath.startsWith("http://") || nextPath.startsWith("https://")) return nextPath;
  return `${STREAM_ESTATE_BASE_URL}${nextPath}`;
}

async function fetchStreamEstatePage(apiKey: string, url: string): Promise<FetchPageResult> {
  const response = await fetch(url, {
    method: "GET",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Stream Estate API error ${response.status}: ${rawText.slice(0, 500)}`);
  }

  let parsed: StreamEstateResponse;
  try {
    parsed = JSON.parse(rawText) as StreamEstateResponse;
  } catch {
    throw new Error("Réponse Stream Estate non JSON");
  }

  const nextUrl = buildAbsoluteUrl(parsed["hydra:view"]?.["hydra:next"] ?? null);
  return { parsed, rawText, nextUrl, currentUrl: url };
}

/**
 * Construit l'URL de départ avec les filtres géographiques natifs Stream Estate.
 *
 * V6 : on passe `includedZipcodes[]` directement dans l'URL.
 * Cela réduit drastiquement le volume retourné par l'API et élimine
 * le gaspillage de crédit sur des annonces hors zone.
 */
function buildStartUrl(startPage: number, params: Required<RequestBody>): string {
  const url = new URL(`${STREAM_ESTATE_BASE_URL}${STREAM_ESTATE_PROPERTIES_PATH}`);

  if (startPage > 1) url.searchParams.set("page", String(startPage));

  // Filtre géographique natif — clé du fix V6
  if (params.zip_code) {
    url.searchParams.append("includedZipcodes[]", params.zip_code);
  }

  // Filtre transaction natif
  if (params.transaction_mode === "sale") url.searchParams.set("transactionType", "0");
  if (params.transaction_mode === "rent") url.searchParams.set("transactionType", "1");

  return url.toString();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "Method not allowed", handler_version: HANDLER_VERSION }),
      { status: 405, headers: corsHeaders }
    );
  }

  try {
    let rawBody: unknown = {};
    try { rawBody = await req.json(); } catch { rawBody = {}; }

    const params = parseBody(rawBody);

    console.log(`[stream-estate-ingest-v1] version=${HANDLER_VERSION}`);
    console.log("[stream-estate-ingest-v1] params:", JSON.stringify({
      requested_zip: params.zip_code || null,
      city: params.city || null,
      limit: params.limit,
      max_pages: params.max_pages,
      start_page: params.start_page,
      transaction_mode: params.transaction_mode,
      dry_run: params.dry_run,
    }));

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = Deno.env.get("STREAM_ESTATE_API_KEY");

    if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    if (!apiKey) throw new Error("STREAM_ESTATE_API_KEY manquant dans les secrets");

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const preparedRows: PortalSnapshotInsert[] = [];
    const sampleRows: Array<Record<string, unknown>> = [];
    const geoDebugRows: GeoDebugRow[] = [];
    const seenKeys = new Set<string>();

    let advertsSeen = 0;
    let skippedNoUrl = 0;
    let rejectedZipMismatch = 0;
    let rejectedMissingZip = 0;
    let rejectedCityMismatch = 0;
    let skippedByMode = 0;
    let retainedCount = 0;
    let acceptedHighConfidence = 0;
    let acceptedMediumConfidence = 0;
    let acceptedLowConfidence = 0;
    let totalItems: number | null = null;
    let pagesFetched = 0;
    let earlyBail = false;
    // V6 : buildStartUrl prend params en argument pour injecter les filtres natifs
    let nextUrl: string | null = buildStartUrl(params.start_page, params);
    let firstMemberKeys: string[] = [];
    let firstAdvertKeys: string[] = [];
    let lastPageUrl: string | null = null;

    const filterZip = normalizeText(params.zip_code);

    console.log("[stream-estate-ingest-v1] first_url:", nextUrl);

    while (
      nextUrl &&
      pagesFetched < params.max_pages &&
      preparedRows.length < params.limit
    ) {
      const page = await fetchStreamEstatePage(apiKey, nextUrl);
      pagesFetched += 1;
      lastPageUrl = page.currentUrl;
      nextUrl = page.nextUrl;

      const properties = asArray(page.parsed["hydra:member"]);
      if (totalItems === null) totalItems = toNumber(page.parsed["hydra:totalItems"]);

      if (pagesFetched === 1 && properties[0]) {
        firstMemberKeys = Object.keys(asRecord(properties[0]) ?? {}).slice(0, 50);
        const firstAdverts = asArray(getByPath(properties[0], "adverts"));
        if (firstAdverts[0]) {
          firstAdvertKeys = Object.keys(asRecord(firstAdverts[0]) ?? {}).slice(0, 80);
        }
        console.log(
          "[stream-estate-ingest-v1] page 1 — hydra:totalItems:", totalItems,
          "| properties on page:", properties.length,
          "| firstMemberKeys:", firstMemberKeys.join(", ")
        );
      }

      for (const property of properties) {
        const adverts = asArray(getByPath(property, "adverts"));

        for (let i = 0; i < adverts.length; i += 1) {
          const advert = adverts[i];
          advertsSeen += 1;

          const mode = guessTransactionMode(advert, property);
          if (params.transaction_mode !== "all" && mode !== "unknown" && mode !== params.transaction_mode) {
            skippedByMode += 1;
            continue;
          }

          const built = buildSnapshotRow(advert, property, i);
          if (!built) { skippedNoUrl += 1; continue; }

          const { row, geo } = built;

          if (params.debug_geo && geoDebugRows.length < 10) {
            geoDebugRows.push(buildGeoDebugRow(advert, property, row));
          }

          const geoMatch = matchesGeo(row, geo, params);

          if (!geoMatch.match) {
            if (geoMatch.reason === "zip_missing") rejectedMissingZip += 1;
            else if (geoMatch.reason === "zip_mismatch") rejectedZipMismatch += 1;
            else rejectedCityMismatch += 1;

            const totalRejected = rejectedZipMismatch + rejectedMissingZip + rejectedCityMismatch;
            if (totalRejected <= 5) {
              console.log(
                `[stream-estate-ingest-v1] REJECT reason=${geoMatch.reason}`,
                JSON.stringify({
                  detail: geoMatch.rejectDetail,
                  requested_zip: params.zip_code || null,
                  detected_zip: geoMatch.detectedZip,
                  zip_candidates: geo.zipCandidates,
                  city_candidates: geo.cityCandidates,
                  url: row.url,
                })
              );
            }
            continue;
          }

          if (geoMatch.confidence === "high") acceptedHighConfidence += 1;
          else if (geoMatch.confidence === "medium") acceptedMediumConfidence += 1;
          else acceptedLowConfidence += 1;

          // Force zip_code et city si absents (annonces acceptées par heuristique)
          if (row.zip_code === null && filterZip !== null) row.zip_code = filterZip;
          if (row.city === null && params.city) row.city = params.city;

          const dedupeKey = `${row.portal}::${row.listing_portal_id}`;
          if (seenKeys.has(dedupeKey)) continue;
          seenKeys.add(dedupeKey);

          preparedRows.push(row);
          retainedCount += 1;

          if (retainedCount <= 10) {
            console.log(
              `[stream-estate-ingest-v1] ACCEPT #${retainedCount} confidence=${geoMatch.confidence}`,
              JSON.stringify({
                accept_reason: geoMatch.acceptReason,
                requested_zip: params.zip_code || null,
                detected_zip: geoMatch.detectedZip,
                row_zip: row.zip_code,
                row_city: row.city,
                property_type: row.property_type,
                land_surface_m2: row.land_surface_m2,
                has_title: row.title !== null,
                has_description: row.description !== null,
                url: row.url,
              })
            );
          }

          if (sampleRows.length < 5) {
            sampleRows.push({
              portal: row.portal,
              listing_portal_id: row.listing_portal_id,
              city: row.city,
              zip_code: row.zip_code,
              price: row.price,
              surface: row.surface,
              price_m2: row.price_m2,
              property_type: row.property_type,
              land_surface_m2: row.land_surface_m2,
              title: row.title,
              description_preview: row.description?.slice(0, 160) ?? null,
              url: row.url,
              transaction_guess: mode,
              zip_candidates: geo.zipCandidates,
              city_candidates: geo.cityCandidates,
              detected_zip: geoMatch.detectedZip,
              confidence: geoMatch.confidence,
              accept_reason: geoMatch.acceptReason,
            });
          }

          if (preparedRows.length >= params.limit) break;
        }

        if (preparedRows.length >= params.limit) break;
      }

      console.log(
        `[stream-estate-ingest-v1] page ${pagesFetched} done —`,
        `advertsSeen=${advertsSeen} retained=${retainedCount}`,
        `rej_mismatch=${rejectedZipMismatch} rej_missing=${rejectedMissingZip} rej_city=${rejectedCityMismatch}`
      );

      // Early bail uniquement si toujours 0 après N pages (avec filtre natif c'est rare)
      if (
        pagesFetched === EARLY_BAIL_AFTER_PAGES &&
        retainedCount <= 0 &&
        advertsSeen >= EARLY_BAIL_MIN_ADVERTS_SEEN
      ) {
        console.warn(
          `[stream-estate-ingest-v1] EARLY_BAIL après ${pagesFetched} pages`,
          JSON.stringify({
            retained: retainedCount,
            adverts_seen: advertsSeen,
            requested_zip: params.zip_code || null,
            city: params.city || null,
          })
        );
        earlyBail = true;
        nextUrl = null;
      }
    }

    const totalRejected = rejectedZipMismatch + rejectedMissingZip + rejectedCityMismatch;
    const retentionRate = advertsSeen > 0 ? Math.round((retainedCount / advertsSeen) * 1000) / 10 : null;
    const rejectRate = advertsSeen > 0 ? Math.round((totalRejected / advertsSeen) * 1000) / 10 : null;
    const costEfficiencySignal =
      retainedCount === 0 ? "zero" : retentionRate !== null && retentionRate < 5 ? "poor" : "good";

    console.log("[stream-estate-ingest-v1] loop done —", JSON.stringify({
      handler_version: HANDLER_VERSION,
      requested_zip: params.zip_code || null,
      city: params.city || null,
      hydra_total_items: totalItems,
      pages_fetched: pagesFetched,
      fetched_adverts: advertsSeen,
      retained_count: retainedCount,
      retention_rate_pct: retentionRate,
      reject_rate_pct: rejectRate,
      rejected_zip_mismatch_count: rejectedZipMismatch,
      rejected_missing_zip_count: rejectedMissingZip,
      rejected_city_mismatch_count: rejectedCityMismatch,
      accepted_high: acceptedHighConfidence,
      accepted_medium: acceptedMediumConfidence,
      accepted_low: acceptedLowConfidence,
      early_bail: earlyBail,
      cost_efficiency_signal: costEfficiencySignal,
      dry_run: params.dry_run,
    }));

    const summary = {
      handler_version: HANDLER_VERSION,
      hydra_total_items: totalItems,
      pages_fetched: pagesFetched,
      fetched_adverts: advertsSeen,
      retained_count: retainedCount,
      prepared_rows: preparedRows.length,
      retention_rate_pct: retentionRate,
      reject_rate_pct: rejectRate,
      rejected_zip_mismatch_count: rejectedZipMismatch,
      rejected_missing_zip_count: rejectedMissingZip,
      rejected_city_mismatch_count: rejectedCityMismatch,
      accepted_high_confidence: acceptedHighConfidence,
      accepted_medium_confidence: acceptedMediumConfidence,
      accepted_low_confidence: acceptedLowConfidence,
      skipped_no_url: skippedNoUrl,
      skipped_by_mode: skippedByMode,
      early_bail: earlyBail,
      cost_efficiency_signal: costEfficiencySignal,
      next_page_preview: nextUrl,
      last_page_url: lastPageUrl,
      first_member_keys: firstMemberKeys,
      first_advert_keys: firstAdvertKeys,
      filters: {
        requested_zip: params.zip_code || null,
        city: params.city || null,
        limit: params.limit,
        max_pages: params.max_pages,
        start_page: params.start_page,
        transaction_mode: params.transaction_mode,
      },
      sample: sampleRows,
      geo_debug: params.debug_geo ? geoDebugRows : undefined,
    };

    if (params.dry_run) {
      return new Response(
        JSON.stringify({ ok: true, dry_run: true, ...summary }),
        { status: 200, headers: corsHeaders }
      );
    }

    let upserted = 0;

    for (const row of preparedRows) {
      const { error } = await supabase
        .from("portal_snapshots")
        .upsert(row, { onConflict: "portal,listing_portal_id" });

      if (error) {
        console.error("[stream-estate-ingest-v1] portal_snapshots upsert error:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
          row,
        });

        return new Response(
          JSON.stringify({
            ok: false,
            handler_version: HANDLER_VERSION,
            step: "portal_snapshots_upsert",
            error: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
            row,
          }),
          { status: 500, headers: corsHeaders }
        );
      }

      upserted += 1;
    }

    console.log(`[stream-estate-ingest-v1] upserted=${upserted}/${preparedRows.length}`);

    return new Response(
      JSON.stringify({ ok: true, dry_run: false, upserted, ...summary }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("stream-estate-ingest-v1 error:", error);
    return new Response(
      JSON.stringify({
        ok: false,
        handler_version: HANDLER_VERSION,
        error: error instanceof Error ? error.message : typeof error === "object" ? JSON.stringify(error) : String(error),
      }),
      { status: 500, headers: corsHeaders }
    );
  }
});