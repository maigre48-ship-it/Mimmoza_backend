/// <reference lib="deno.ns" />
/// <reference lib="dom" />

// supabase/functions/terrain-analysis-v1/index.ts
//
// ✅ terrain-analysis-v1 (v1.10) — PRODUCTION LEVEL 3
//
// EVOLUTION from v1.9:
// - NaN-proof numeric parsing: new helpers parseFiniteNumber/parseFiniteInt
// - Fixed bug where Number(undefined) ?? DEFAULT still returned NaN
// - All numeric input fields now use robust parsing with explicit fallbacks
// - Added defensive check in fetchWithRetry to handle NaN maxRetries
//
// EVOLUTION from v1.8:
// - Typed ENV resolution: strict separation of sb_* keys vs JWT tokens
// - New helpers: getJwtEnvVar, getSbKeyEnvVar, getPlainEnvVar
// - getApiKeyOrNull() now strictly prefers sb_* keys over JWTs
// - Health check shows envKinds diagnostic for each env var type
// - Fixes issue where apiKeyKind="jwt" when hasSupabaseAnonKey=true
//
// EVOLUTION from v1.7:
// - Strict JWT validation for Bearer tokens (looksLikeJwt helper)
// - Separate apikey (sb_* keys) vs Authorization (JWT) header logic
// - Proper 401/403 status mapping (no blind 500 on auth errors)
// - Debug logging before cadastre-from-commune (non-sensitive)
//
// EVOLUTION from v1.6:
// - Robust ENV resolution for Edge runtime (MIMMOZA_EDGE_* priority)
// - Graceful handling of missing JWT tokens (no blind 500)
// - Early validation before cadastre-from-commune calls
// - Clearer error messages for misconfiguration
//
// EVOLUTION from v1.5:
// - LRU cache with size limits and TTL
// - Circuit breaker pattern for external services
// - Parallel elevation fetching (render + stats grids)
// - Structured logging with request IDs
// - Better input validation and error categorization
// - ETag support for HTTP caching
// - Health check endpoint
// - Graceful degradation strategies
// - More efficient algorithms
//
// CONTRAT RÉPONSE INCHANGÉ (front figé):
// {
//   success: boolean;
//   version: string;
//   terrainData: {
//     altitudeMin: number;
//     altitudeMax: number;
//     penteMoyenne: number;
//     provider: string;
//     parcelBounds: [minLon, minLat, maxLon, maxLat];
//     grid?: { z: number[][], n: number };
//     reliefPoints?: any[];
//     parcelGeojson?: GeoJSON;
//   };
// }

import { corsHeaders } from "../_shared/cors.ts";

// =============================================================================
// VERSIONING & BUILD INFO
// =============================================================================
const PUBLIC_VERSION = "v1.5" as const;      // Version exposée au front (JSON + header public)
const INTERNAL_VERSION = "v1.10" as const;   // Version interne pour logs/debug
const BUILD_STAMP = new Date().toISOString();
const INSTANCE_ID = crypto.randomUUID().slice(0, 8);

// =============================================================================
// TYPES
// =============================================================================
type BBox = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
type LonLat = [number, number];

interface TerrainInput {
  parcel_id?: string | null;
  commune_insee?: string | null;
  parcel_geojson?: unknown | null;
  grid_size?: number | null;
  padding_meters?: number | null;
  request_timeout_ms?: number | null;
  opentopo_chunk_delay_ms?: number | null;
  opentopo_max_retries?: number | null;
  ign_max_retries?: number | null;
  cache_ttl_ms?: number | null;
  stats_grid_max_n?: number | null;
}

interface TerrainData {
  altitudeMin: number;
  altitudeMax: number;
  penteMoyenne: number;
  provider: string;
  parcelBounds: BBox;
  renderBounds: BBox;
  grid: { z: number[][]; n: number };
  parcel_id: string | null;
  commune_insee: string | null;
  parcelGeojson: unknown;
  reliefPoints?: unknown[];
}

interface GridResult {
  n: number;
  lonList: number[];
  latList: number[];
  points: Array<{ lon: number; lat: number }>;
}

interface RequestContext {
  requestId: string;
  startTime: number;
  parcelId: string | null;
  communeInsee: string | null;
}

// =============================================================================
// CONFIGURATION
// =============================================================================
const CONFIG = {
  // Cache
  CACHE_MAX_SIZE: 500,
  CACHE_DEFAULT_TTL_MS: 120_000,

  // Circuit breaker
  CB_FAILURE_THRESHOLD: 5,
  CB_RESET_TIMEOUT_MS: 30_000,

  // Network
  DEFAULT_TIMEOUT_MS: 12_000,
  MAX_TIMEOUT_MS: 60_000,
  MIN_TIMEOUT_MS: 1_000,

  // Grid
  MIN_GRID_SIZE: 10,
  MAX_GRID_SIZE: 80,
  DEFAULT_GRID_SIZE: 17,
  MAX_STATS_GRID_SIZE: 200,
  DEFAULT_STATS_GRID_MAX_N: 120,

  // Padding
  DEFAULT_PADDING_METERS: 80,
  MAX_PADDING_METERS: 500,

  // OpenTopo
  OPENTOPO_CHUNK_SIZE: 80,
  OPENTOPO_DEFAULT_DELAY_MS: 450,
  OPENTOPO_MAX_RETRIES: 4,

  // IGN
  IGN_CHUNK_SIZE: 100,
  IGN_MAX_RETRIES: 2,

  // Stats
  MIN_INSIDE_POINTS_FOR_SLOPE: 6,
  MIN_INSIDE_RATIO: 0.15,
} as const;

// =============================================================================
// VALIDATION UTILITIES (moved up for use in ENV resolution)
// =============================================================================

/**
 * v1.10: NaN-proof numeric parsing.
 * Parses a value to a finite number, returning fallback if not finite.
 * Handles: undefined, null, NaN, Infinity, non-numeric strings.
 */
function parseFiniteNumber(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * v1.10: NaN-proof integer parsing.
 * Parses a value to a finite integer, returning fallback if not finite.
 * Handles: undefined, null, NaN, Infinity, non-numeric strings.
 */
function parseFiniteInt(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/**
 * Check if a token looks like a JWT (3 base64url segments separated by dots, starts with eyJ).
 * This is a heuristic check, not full validation.
 */
function looksLikeJwt(token: string): boolean {
  if (!token || typeof token !== "string") return false;
  const trimmed = token.trim();
  
  // JWT must have exactly 3 parts separated by dots
  const parts = trimmed.split(".");
  if (parts.length !== 3) return false;
  
  // First part (header) typically starts with eyJ (base64 for '{"')
  if (!parts[0].startsWith("eyJ")) return false;
  
  // Each part should be non-empty and look like base64url
  const base64urlRegex = /^[A-Za-z0-9_-]+$/;
  for (const part of parts) {
    if (part.length === 0) return false;
    if (!base64urlRegex.test(part)) return false;
  }
  
  return true;
}

/**
 * Check if a string looks like a Supabase API key (sb_publishable_* or sb_secret_*).
 */
function looksLikeSupabaseKey(key: string): boolean {
  if (!key || typeof key !== "string") return false;
  const trimmed = key.trim();
  return trimmed.startsWith("sb_publishable_") || trimmed.startsWith("sb_secret_");
}

// =============================================================================
// ENVIRONMENT (v1.9: typed resolution with strict sb_* vs JWT separation)
// =============================================================================

/**
 * Returns the first non-empty env var value from the list of keys.
 * No type validation - used for URLs and other plain strings.
 */
function getPlainEnvVar(...keys: string[]): string {
  for (const key of keys) {
    const val = Deno.env.get(key);
    if (val && val.trim() !== "") {
      return val.trim();
    }
  }
  return "";
}

/**
 * Returns the first non-empty env var value that looks like a JWT.
 * Ignores values that are sb_* keys or don't look like JWTs.
 */
function getJwtEnvVar(...keys: string[]): string {
  for (const key of keys) {
    const val = Deno.env.get(key);
    if (val && val.trim() !== "") {
      const trimmed = val.trim();
      // Only return if it actually looks like a JWT (not an sb_* key)
      if (looksLikeJwt(trimmed) && !looksLikeSupabaseKey(trimmed)) {
        return trimmed;
      }
    }
  }
  return "";
}

/**
 * Returns the first non-empty env var value that looks like a Supabase key (sb_*).
 * Ignores values that are JWTs or don't look like sb_* keys.
 */
function getSbKeyEnvVar(...keys: string[]): string {
  for (const key of keys) {
    const val = Deno.env.get(key);
    if (val && val.trim() !== "") {
      const trimmed = val.trim();
      // Only return if it actually looks like an sb_* key (not a JWT)
      if (looksLikeSupabaseKey(trimmed)) {
        return trimmed;
      }
    }
  }
  return "";
}

/**
 * Legacy helper for backward compatibility - returns first non-empty value.
 * @deprecated Use getPlainEnvVar, getJwtEnvVar, or getSbKeyEnvVar instead.
 */
function getEnvVar(...keys: string[]): string {
  return getPlainEnvVar(...keys);
}

const ENV = {
  // IGN API key (unchanged)
  IGN_ALTI_KEY: getPlainEnvVar("IGN_ALTI_KEY", "VITE_IGN_ALTI_KEY"),

  // Edge internal URL: priorité MIMMOZA_EDGE_INTERNAL_URL > SUPABASE_URL > MIMMOZA_SUPABASE_URL
  EDGE_INTERNAL_URL: getPlainEnvVar(
    "MIMMOZA_EDGE_INTERNAL_URL",
    "SUPABASE_URL",
    "MIMMOZA_SUPABASE_URL"
  ),

  // v1.9: Strictly typed - EDGE_SERVICE_ROLE_JWT must be a JWT only
  EDGE_SERVICE_ROLE_JWT: getJwtEnvVar(
    "MIMMOZA_EDGE_SERVICE_ROLE_JWT",
    "SUPABASE_SERVICE_ROLE_KEY" // Will only match if it's a JWT (unlikely but possible)
  ),

  // v1.9: Strictly typed - EDGE_ANON_JWT must be a JWT only
  EDGE_ANON_JWT: getJwtEnvVar(
    "MIMMOZA_EDGE_ANON_JWT",
    "INTERNAL_ANON_JWT"
    // Note: SUPABASE_ANON_KEY is NOT included here as it's typically an sb_* key
  ),

  // v1.9: Strictly typed - SUPABASE_URL is a plain URL
  SUPABASE_URL: getPlainEnvVar("SUPABASE_URL", "MIMMOZA_SUPABASE_URL"),

  // v1.9: Strictly typed - SUPABASE_SERVICE_ROLE_KEY must be an sb_* key only
  SUPABASE_SERVICE_ROLE_KEY: getSbKeyEnvVar(
    "SUPABASE_SERVICE_ROLE_KEY",
    "MIMMOZA_SERVICE_ROLE_KEY"
  ),

  // v1.9: Strictly typed - SUPABASE_ANON_KEY must be an sb_* key only
  SUPABASE_ANON_KEY: getSbKeyEnvVar(
    "SUPABASE_ANON_KEY",
    "MIMMOZA_ANON_KEY"
  ),

  // v1.9: Strictly typed - INTERNAL_ANON_JWT must be a JWT only
  INTERNAL_ANON_JWT: getJwtEnvVar(
    "INTERNAL_ANON_JWT",
    "MIMMOZA_EDGE_ANON_JWT"
  ),
};

// =============================================================================
// LOGGING
// =============================================================================
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_LEVEL = LogLevel.INFO;

class Logger {
  constructor(private ctx: RequestContext | null = null) {}

  private format(level: string, msg: string, data?: Record<string, unknown>): string {
    const base = {
      ts: new Date().toISOString(),
      level,
      version: INTERNAL_VERSION,
      instance: INSTANCE_ID,
      requestId: this.ctx?.requestId ?? "N/A",
      msg,
      ...data,
    };
    return JSON.stringify(base);
  }

  debug(msg: string, data?: Record<string, unknown>) {
    if (LOG_LEVEL <= LogLevel.DEBUG) console.log(this.format("DEBUG", msg, data));
  }

  info(msg: string, data?: Record<string, unknown>) {
    if (LOG_LEVEL <= LogLevel.INFO) console.log(this.format("INFO", msg, data));
  }

  warn(msg: string, data?: Record<string, unknown>) {
    if (LOG_LEVEL <= LogLevel.WARN) console.warn(this.format("WARN", msg, data));
  }

  error(msg: string, data?: Record<string, unknown>) {
    if (LOG_LEVEL <= LogLevel.ERROR) console.error(this.format("ERROR", msg, data));
  }

  withContext(ctx: RequestContext): Logger {
    return new Logger(ctx);
  }
}

const logger = new Logger();

// =============================================================================
// LRU CACHE
// =============================================================================
interface CacheEntry<T> {
  value: T;
  createdAt: number;
  lastAccess: number;
  hits: number;
}

class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;

  constructor(maxSize: number, defaultTtlMs: number) {
    this.maxSize = Math.max(1, maxSize);
    this.defaultTtlMs = Math.max(0, defaultTtlMs);
  }

  get(key: string, ttlMs?: number): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const ttl = ttlMs ?? this.defaultTtlMs;
    const now = Date.now();

    if (ttl > 0 && now - entry.createdAt > ttl) {
      this.cache.delete(key);
      return null;
    }

    entry.lastAccess = now;
    entry.hits++;

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key: string, value: T): void {
    const now = Date.now();

    // Evict LRU entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    this.cache.set(key, {
      value,
      createdAt: now,
      lastAccess: now,
      hits: 0,
    });
  }

  stats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.maxSize };
  }

  clear(): void {
    this.cache.clear();
  }
}

const terrainCache = new LRUCache<{ terrainData: TerrainData; debug: Record<string, unknown> }>(
  CONFIG.CACHE_MAX_SIZE,
  CONFIG.CACHE_DEFAULT_TTL_MS
);

// =============================================================================
// CIRCUIT BREAKER
// =============================================================================
interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
}

class CircuitBreaker {
  private circuits = new Map<string, CircuitBreakerState>();
  private readonly threshold: number;
  private readonly resetTimeout: number;

  constructor(threshold: number, resetTimeoutMs: number) {
    this.threshold = threshold;
    this.resetTimeout = resetTimeoutMs;
  }

  private getState(service: string): CircuitBreakerState {
    let state = this.circuits.get(service);
    if (!state) {
      state = { failures: 0, lastFailure: 0, state: "CLOSED" };
      this.circuits.set(service, state);
    }
    return state;
  }

  isOpen(service: string): boolean {
    const state = this.getState(service);
    const now = Date.now();

    if (state.state === "OPEN") {
      if (now - state.lastFailure > this.resetTimeout) {
        state.state = "HALF_OPEN";
        return false;
      }
      return true;
    }

    return false;
  }

  recordSuccess(service: string): void {
    const state = this.getState(service);
    state.failures = 0;
    state.state = "CLOSED";
  }

  recordFailure(service: string): void {
    const state = this.getState(service);
    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= this.threshold) {
      state.state = "OPEN";
    }
  }

  getStatus(service: string): CircuitBreakerState {
    return { ...this.getState(service) };
  }
}

const circuitBreaker = new CircuitBreaker(CONFIG.CB_FAILURE_THRESHOLD, CONFIG.CB_RESET_TIMEOUT_MS);

// =============================================================================
// HTTP UTILITIES
// =============================================================================
function jsonResponse(
  body: unknown,
  status = 200,
  extra?: { etag?: string; requestId?: string }
): Response {
  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": "application/json",
    "X-Terrain-Version": PUBLIC_VERSION,
    "X-Terrain-Internal-Version": INTERNAL_VERSION,
    "X-Terrain-Build": BUILD_STAMP,
    "X-Terrain-Instance": INSTANCE_ID,
  };

  if (extra?.etag) {
    headers["ETag"] = extra.etag;
    headers["Cache-Control"] = "private, max-age=60";
  }

  if (extra?.requestId) {
    headers["X-Request-Id"] = extra.requestId;
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(
  error: string,
  status: number,
  ctx?: RequestContext,
  details?: Record<string, unknown>
): Response {
  return jsonResponse(
    {
      success: false,
      version: PUBLIC_VERSION,
      buildStamp: BUILD_STAMP,
      error,
      ...(details && { details }),
    },
    status,
    { requestId: ctx?.requestId }
  );
}

// =============================================================================
// ADDITIONAL VALIDATION UTILITIES
// =============================================================================
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sanitizeString(s: unknown, maxLen = 100): string {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, maxLen).replace(/[<>]/g, "");
}

function validateInput(payload: TerrainInput): {
  valid: boolean;
  errors: string[];
  sanitized: TerrainInput;
} {
  const errors: string[] = [];

  const parcel_id = sanitizeString(payload.parcel_id, 50) || null;
  const commune_insee = sanitizeString(payload.commune_insee, 10) || null;

  // Validate commune_insee format if provided
  if (commune_insee && !/^[0-9A-Za-z]{2,5}$/.test(commune_insee)) {
    errors.push(`Invalid commune_insee format: ${commune_insee}`);
  }

  // v1.10: NaN-proof numeric parsing using parseFiniteInt/parseFiniteNumber
  const grid_size = clampInt(
    parseFiniteInt(payload.grid_size, CONFIG.DEFAULT_GRID_SIZE),
    CONFIG.MIN_GRID_SIZE,
    CONFIG.MAX_GRID_SIZE
  );

  const padding_meters = clamp(
    parseFiniteNumber(payload.padding_meters, CONFIG.DEFAULT_PADDING_METERS),
    0,
    CONFIG.MAX_PADDING_METERS
  );

  const request_timeout_ms = clampInt(
    parseFiniteInt(payload.request_timeout_ms, CONFIG.DEFAULT_TIMEOUT_MS),
    CONFIG.MIN_TIMEOUT_MS,
    CONFIG.MAX_TIMEOUT_MS
  );

  const opentopo_chunk_delay_ms = clampInt(
    parseFiniteInt(payload.opentopo_chunk_delay_ms, CONFIG.OPENTOPO_DEFAULT_DELAY_MS),
    100,
    2000
  );

  // v1.10: Critical fix - these were causing "NaN retries" errors
  const opentopo_max_retries = clampInt(
    parseFiniteInt(payload.opentopo_max_retries, CONFIG.OPENTOPO_MAX_RETRIES),
    0,
    10
  );

  const ign_max_retries = clampInt(
    parseFiniteInt(payload.ign_max_retries, CONFIG.IGN_MAX_RETRIES),
    0,
    10
  );

  const cache_ttl_ms = clampInt(
    parseFiniteInt(payload.cache_ttl_ms, CONFIG.CACHE_DEFAULT_TTL_MS),
    0,
    600_000
  );

  const stats_grid_max_n = clampInt(
    parseFiniteInt(payload.stats_grid_max_n, CONFIG.DEFAULT_STATS_GRID_MAX_N),
    20,
    CONFIG.MAX_STATS_GRID_SIZE
  );

  // Check that we have either parcel_geojson or (parcel_id + commune_insee)
  if (!payload.parcel_geojson && (!parcel_id || !commune_insee)) {
    errors.push("Missing parcel_geojson and (parcel_id + commune_insee)");
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized: {
      parcel_id,
      commune_insee,
      parcel_geojson: payload.parcel_geojson,
      grid_size,
      padding_meters,
      request_timeout_ms,
      opentopo_chunk_delay_ms,
      opentopo_max_retries,
      ign_max_retries,
      cache_ttl_ms,
      stats_grid_max_n,
    },
  };
}

// =============================================================================
// NETWORK UTILITIES
// =============================================================================
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

interface RetryOptions {
  timeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  jitterMs: number;
  retryOnStatuses: (s: number) => boolean;
  tag: string;
  log?: Logger;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions
): Promise<Response> {
  // v1.10: Defensive check - ensure maxRetries is finite, fallback to 0 if NaN
  const maxRetries = clampInt(
    Number.isFinite(opts.maxRetries) ? opts.maxRetries : 0,
    0,
    10
  );
  const timeoutMs = clampInt(
    Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : CONFIG.DEFAULT_TIMEOUT_MS,
    1000,
    60_000
  );
  const baseBackoffMs = clampInt(
    Number.isFinite(opts.baseBackoffMs) ? opts.baseBackoffMs : 250,
    50,
    5_000
  );
  const jitterMs = clampInt(
    Number.isFinite(opts.jitterMs) ? opts.jitterMs : 200,
    0,
    2_000
  );

  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);

      if (!opts.retryOnStatuses(res.status) || attempt === maxRetries) {
        return res;
      }

      const wait = Math.floor(baseBackoffMs * Math.pow(2, attempt) + Math.random() * jitterMs);
      opts.log?.warn(`Retryable status`, {
        tag: opts.tag,
        status: res.status,
        attempt: attempt + 1,
        maxRetries,
        waitMs: wait,
      });

      // Drain response body
      await res.text().catch(() => "");
      await delay(wait);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));

      if (attempt === maxRetries) break;

      const wait = Math.floor(baseBackoffMs * Math.pow(2, attempt) + Math.random() * jitterMs);
      opts.log?.warn(`Fetch error`, {
        tag: opts.tag,
        error: lastErr.message,
        attempt: attempt + 1,
        maxRetries,
        waitMs: wait,
      });

      await delay(wait);
    }
  }

  throw lastErr ?? new Error(`[${opts.tag}] fetch failed after ${maxRetries} retries`);
}

// =============================================================================
// GEOJSON UTILITIES
// =============================================================================
function collectCoordsFromGeometry(geom: unknown, out: number[][]): void {
  if (!geom || typeof geom !== "object") return;

  const g = geom as Record<string, unknown>;
  const type = g.type as string | undefined;
  const coords = g.coordinates as unknown;

  if (!type || !coords) return;

  if (type === "Point" && Array.isArray(coords) && coords.length >= 2) {
    out.push([Number(coords[0]), Number(coords[1])]);
    return;
  }

  if (type === "LineString" && Array.isArray(coords)) {
    for (const p of coords) {
      if (Array.isArray(p) && p.length >= 2) {
        out.push([Number(p[0]), Number(p[1])]);
      }
    }
    return;
  }

  if (type === "Polygon" && Array.isArray(coords)) {
    for (const ring of coords) {
      if (!Array.isArray(ring)) continue;
      for (const p of ring) {
        if (Array.isArray(p) && p.length >= 2) {
          out.push([Number(p[0]), Number(p[1])]);
        }
      }
    }
    return;
  }

  if (type === "MultiPolygon" && Array.isArray(coords)) {
    for (const poly of coords) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) {
        if (!Array.isArray(ring)) continue;
        for (const p of ring) {
          if (Array.isArray(p) && p.length >= 2) {
            out.push([Number(p[0]), Number(p[1])]);
          }
        }
      }
    }
    return;
  }

  if (type === "MultiLineString" && Array.isArray(coords)) {
    for (const line of coords) {
      if (!Array.isArray(line)) continue;
      for (const p of line) {
        if (Array.isArray(p) && p.length >= 2) {
          out.push([Number(p[0]), Number(p[1])]);
        }
      }
    }
    return;
  }
}

function bboxFromFeature(feature: unknown): BBox {
  const f = feature as Record<string, unknown> | null;
  const geom = f?.type === "Feature" ? f.geometry : f?.geometry ?? f;

  const coords: number[][] = [];
  collectCoordsFromGeometry(geom, coords);

  if (coords.length === 0) {
    throw new Error("bboxFromFeature: geometry has no coordinates");
  }

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (const [lng, lat] of coords) {
    if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) continue;
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }

  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) {
    throw new Error("bboxFromFeature: bbox not computable (non-finite values)");
  }

  return [minLng, minLat, maxLng, maxLat];
}

function normalizeToFeature(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;

  const r = raw as Record<string, unknown>;

  if (r.type === "Feature" && r.geometry) {
    return r;
  }

  if (r.type === "FeatureCollection" && Array.isArray(r.features)) {
    const features = r.features as Array<Record<string, unknown>>;
    const f = features.find(
      (x) =>
        x?.type === "Feature" &&
        ((x.geometry as Record<string, unknown>)?.type === "Polygon" ||
          (x.geometry as Record<string, unknown>)?.type === "MultiPolygon")
    );
    return f ?? null;
  }

  const geom = r.geometry as Record<string, unknown> | undefined;
  if (geom && (geom.type === "Polygon" || geom.type === "MultiPolygon")) {
    return { type: "Feature", geometry: geom, properties: r.properties ?? {} };
  }

  if (r.type === "Polygon" || r.type === "MultiPolygon") {
    return { type: "Feature", geometry: r, properties: {} };
  }

  return null;
}

function extractFeatureCollectionFromAnyResponse(
  data: unknown,
  depth = 0
): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;

  const d = data as Record<string, unknown>;

  if (d.type === "FeatureCollection" && Array.isArray(d.features)) {
    return d;
  }

  if (depth > 5) return null;

  const preferredKeys = ["geojson", "data", "cadastre", "parcelles", "features"];

  for (const key of preferredKeys) {
    const v = d[key];
    if (v && typeof v === "object") {
      const fc = extractFeatureCollectionFromAnyResponse(v, depth + 1);
      if (fc) return fc;
    }
  }

  for (const v of Object.values(d)) {
    if (v && typeof v === "object") {
      const fc = extractFeatureCollectionFromAnyResponse(v, depth + 1);
      if (fc) return fc;
    }
  }

  return null;
}

function findFeatureForParcelRobust(
  fc: Record<string, unknown>,
  parcelId: string
): Record<string, unknown> | null {
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return null;

  const target = String(parcelId).trim();
  if (!target) return null;

  const features = fc.features as Array<Record<string, unknown>>;

  for (const f of features) {
    const props = (f?.properties || {}) as Record<string, unknown>;

    const candidates = [
      f?.id,
      props?.id,
      props?.ID,
      props?.idu,
      props?.IDU,
      props?.parcel_id,
      props?.parcelle_id,
      props?.id_parcelle,
      props?.parcelle,
      props?.cleabs,
      props?.cleabs_id,
    ]
      .filter((v) => v !== undefined && v !== null)
      .map((v) => String(v).trim());

    if (candidates.includes(target)) return f;
  }

  return null;
}

// =============================================================================
// POINT-IN-POLYGON
// =============================================================================
function pointInRing(pt: LonLat, ring: LonLat[]): boolean {
  const [x, y] = pt;
  const n = ring.length;

  if (n < 3) return false;

  let inside = false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

function pointInPolygonCoords(pt: LonLat, poly: LonLat[][]): boolean {
  if (!Array.isArray(poly) || poly.length === 0) return false;

  // Check outer ring
  if (!pointInRing(pt, poly[0])) return false;

  // Check holes
  for (let k = 1; k < poly.length; k++) {
    if (pointInRing(pt, poly[k])) return false;
  }

  return true;
}

function pointInGeometry(pt: LonLat, geom: unknown): boolean {
  if (!geom || typeof geom !== "object") return false;

  const g = geom as Record<string, unknown>;

  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    return pointInPolygonCoords(pt, g.coordinates as LonLat[][]);
  }

  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    const mp = g.coordinates as LonLat[][][];
    for (const poly of mp) {
      if (pointInPolygonCoords(pt, poly)) return true;
    }
    return false;
  }

  return false;
}

function pointInFeature(pt: LonLat, feature: unknown): boolean {
  const f = feature as Record<string, unknown> | null;
  const geom = f?.type === "Feature" ? f.geometry : f?.geometry ?? f;
  return pointInGeometry(pt, geom);
}

// =============================================================================
// COORDINATE TRANSFORMATIONS
// =============================================================================
function metersToDegreesLat(m: number): number {
  return m / 111_320;
}

function metersToDegreesLng(m: number, atLatDeg: number): number {
  const cos = Math.cos((atLatDeg * Math.PI) / 180) || 1e-6;
  return m / (111_320 * cos);
}

function padBbox(bbox: BBox, paddingMeters: number): BBox {
  if (paddingMeters <= 0) return bbox;

  const [minLng, minLat, maxLng, maxLat] = bbox;
  const midLat = (minLat + maxLat) / 2;

  const dLat = metersToDegreesLat(paddingMeters);
  const dLng = metersToDegreesLng(paddingMeters, midLat);

  return [minLng - dLng, minLat - dLat, maxLng + dLng, maxLat + dLat];
}

// =============================================================================
// GRID UTILITIES
// =============================================================================
function buildGrid(bbox: BBox, gridSize: number): GridResult {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const n = clampInt(gridSize, CONFIG.MIN_GRID_SIZE, CONFIG.MAX_STATS_GRID_SIZE);

  const lonList = new Array<number>(n);
  const latList = new Array<number>(n);

  for (let ix = 0; ix < n; ix++) {
    const tx = n === 1 ? 0.5 : ix / (n - 1);
    lonList[ix] = minLng + tx * (maxLng - minLng);
  }

  for (let iy = 0; iy < n; iy++) {
    const ty = n === 1 ? 0.5 : iy / (n - 1);
    latList[iy] = minLat + ty * (maxLat - minLat);
  }

  const points: Array<{ lon: number; lat: number }> = [];
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      points.push({ lon: lonList[ix], lat: latList[iy] });
    }
  }

  return { n, lonList, latList, points };
}

interface FilterResult {
  inside: Array<{ lon: number; lat: number }>;
  mask: boolean[];
  count: number;
}

function filterInsidePoints(
  feature: unknown,
  points: Array<{ lon: number; lat: number }>
): FilterResult {
  const mask = new Array<boolean>(points.length);
  const inside: Array<{ lon: number; lat: number }> = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const isInside = pointInFeature([p.lon, p.lat], feature);
    mask[i] = isInside;
    if (isInside) inside.push(p);
  }

  return { inside, mask, count: inside.length };
}

function buildStatsSamplePointsAdaptive(
  parcelFeature: unknown,
  baseBbox: BBox,
  requestedN: number,
  maxN: number
): {
  nUsed: number;
  gridAll: GridResult;
  inside: Array<{ lon: number; lat: number }>;
  inCount: number;
  minNeeded: number;
} {
  const baseRequested = clampInt(requestedN, CONFIG.MIN_GRID_SIZE, CONFIG.MAX_GRID_SIZE);
  const maxAllowed = clampInt(maxN, 20, CONFIG.MAX_STATS_GRID_SIZE);

  const computeMinNeeded = (nn: number) =>
    Math.max(20, Math.floor(nn * nn * CONFIG.MIN_INSIDE_RATIO));

  let n = baseRequested;
  let grid = buildGrid(baseBbox, n);
  let insidePack = filterInsidePoints(parcelFeature, grid.points);
  let minNeeded = computeMinNeeded(n);

  // Increase density adaptively until we have enough inside points
  while (insidePack.count < minNeeded && n < maxAllowed) {
    n = Math.min(maxAllowed, n + 10);
    grid = buildGrid(baseBbox, n);
    insidePack = filterInsidePoints(parcelFeature, grid.points);
    minNeeded = computeMinNeeded(n);
  }

  return {
    nUsed: n,
    gridAll: grid,
    inside: insidePack.inside,
    inCount: insidePack.count,
    minNeeded,
  };
}

// =============================================================================
// ELEVATION PROVIDERS
// =============================================================================
interface ElevationOptions {
  timeoutMs: number;
  maxRetries: number;
  chunkDelayMs?: number;
  log?: Logger;
}

async function fetchIgnAlti(
  points: Array<{ lon: number; lat: number }>,
  opts: ElevationOptions
): Promise<number[]> {
  if (!ENV.IGN_ALTI_KEY) {
    throw new Error("IGN_ALTI_KEY not configured");
  }

  const service = "IGN_ALTI";

  if (circuitBreaker.isOpen(service)) {
    throw new Error(`Circuit breaker OPEN for ${service}`);
  }

  const out: number[] = [];

  try {
    for (let i = 0; i < points.length; i += CONFIG.IGN_CHUNK_SIZE) {
      const chunk = points.slice(i, i + CONFIG.IGN_CHUNK_SIZE);

      const lons = chunk.map((p) => p.lon.toFixed(7)).join(",");
      const lats = chunk.map((p) => p.lat.toFixed(7)).join(",");

      const url = `https://wxs.ign.fr/${encodeURIComponent(ENV.IGN_ALTI_KEY)}/alti/rest/elevation.json?lon=${lons}&lat=${lats}`;

      const res = await fetchWithRetry(
        url,
        { method: "GET" },
        {
          timeoutMs: opts.timeoutMs,
          maxRetries: opts.maxRetries,
          baseBackoffMs: 250,
          jitterMs: 200,
          retryOnStatuses: isRetryableStatus,
          tag: service,
          log: opts.log,
        }
      );

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`${service} HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }

      const json = (await res.json()) as Record<string, unknown>;
      const elevations = (json?.elevations ?? json?.elevation ?? json?.results) as
        | Array<Record<string, unknown>>
        | undefined;

      if (!Array.isArray(elevations) || elevations.length === 0) {
        throw new Error(`${service}: invalid response (no elevations array)`);
      }

      for (const e of elevations) {
        const z = e?.z ?? e?.altitude ?? e?.elevation ?? e?.h ?? null;
        out.push(typeof z === "number" && Number.isFinite(z) ? z : NaN);
      }
    }

    circuitBreaker.recordSuccess(service);
    return out;
  } catch (e) {
    circuitBreaker.recordFailure(service);
    throw e;
  }
}

async function fetchOpenTopoSrtm(
  points: Array<{ lon: number; lat: number }>,
  opts: ElevationOptions
): Promise<number[]> {
  const service = "OPENTOPODATA";

  if (circuitBreaker.isOpen(service)) {
    throw new Error(`Circuit breaker OPEN for ${service}`);
  }

  const out: number[] = [];
  const chunkDelay = opts.chunkDelayMs ?? CONFIG.OPENTOPO_DEFAULT_DELAY_MS;

  try {
    for (let i = 0; i < points.length; i += CONFIG.OPENTOPO_CHUNK_SIZE) {
      const chunk = points.slice(i, i + CONFIG.OPENTOPO_CHUNK_SIZE);

      const locations = chunk.map((p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`).join("|");
      const url = `https://api.opentopodata.org/v1/srtm90m?locations=${encodeURIComponent(locations)}`;

      // Rate limiting delay between chunks
      if (i > 0) {
        await delay(chunkDelay);
      }

      const res = await fetchWithRetry(
        url,
        { method: "GET" },
        {
          timeoutMs: opts.timeoutMs,
          maxRetries: opts.maxRetries,
          baseBackoffMs: 400,
          jitterMs: 250,
          retryOnStatuses: isRetryableStatus,
          tag: service,
          log: opts.log,
        }
      );

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`${service} HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }

      const json = (await res.json()) as Record<string, unknown>;
      const results = json?.results as Array<Record<string, unknown>> | undefined;

      if (!Array.isArray(results) || results.length === 0) {
        throw new Error(`${service}: invalid response (no results array)`);
      }

      for (const r of results) {
        const z = r?.elevation;
        out.push(typeof z === "number" && Number.isFinite(z) ? z : NaN);
      }
    }

    circuitBreaker.recordSuccess(service);
    return out;
  } catch (e) {
    circuitBreaker.recordFailure(service);
    throw e;
  }
}

// Parallel fetch for both render and stats grids
async function fetchElevationsParallel(
  renderPoints: Array<{ lon: number; lat: number }>,
  statsPoints: Array<{ lon: number; lat: number }>,
  opts: ElevationOptions
): Promise<{
  render: number[];
  stats: number[];
  provider: string;
}> {
  const useIgn = Boolean(ENV.IGN_ALTI_KEY) && !circuitBreaker.isOpen("IGN_ALTI");

  if (useIgn) {
    try {
      const [render, stats] = await Promise.all([
        fetchIgnAlti(renderPoints, opts),
        fetchIgnAlti(statsPoints, opts),
      ]);

      return { render, stats, provider: "IGN_ALTI" };
    } catch (e) {
      opts.log?.warn("IGN_ALTI failed, falling back to OpenTopo", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Fallback to OpenTopoData (sequential due to rate limits)
  const render = await fetchOpenTopoSrtm(renderPoints, opts);
  const stats = await fetchOpenTopoSrtm(statsPoints, {
    ...opts,
    // No additional delay needed, fetchOpenTopoSrtm handles its own delays
  });

  return { render, stats, provider: "OPENTOPODATA_SRTM90" };
}

// =============================================================================
// STATISTICS UTILITIES
// =============================================================================
function medianFinite(values: number[]): number | null {
  const arr = values.filter(Number.isFinite).sort((a, b) => a - b);

  if (arr.length === 0) return null;

  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function fillMissingValues(values: number[]): { filled: number[]; fillValue: number } {
  const med = medianFinite(values);
  const fillValue = med !== null && Number.isFinite(med) ? med : 0;

  return {
    filled: values.map((v) => (Number.isFinite(v) ? v : fillValue)),
    fillValue,
  };
}

// Plane-fit slope estimation using least squares
// z = a*x + b*y + c (x,y in meters)
// slope% = sqrt(a² + b²) * 100
function estimateSlopePlaneFitPercent(
  ptsLonLat: Array<{ lon: number; lat: number }>,
  zVals: number[]
): number {
  const n = Math.min(ptsLonLat.length, zVals.length);

  if (n < CONFIG.MIN_INSIDE_POINTS_FOR_SLOPE) return 0;

  // Compute centroid
  let lon0 = 0;
  let lat0 = 0;

  for (let i = 0; i < n; i++) {
    lon0 += ptsLonLat[i].lon;
    lat0 += ptsLonLat[i].lat;
  }

  lon0 /= n;
  lat0 /= n;

  // Conversion factors
  const cosLat = Math.cos((lat0 * Math.PI) / 180) || 1e-6;
  const mPerDegLon = 111_320 * cosLat;
  const mPerDegLat = 111_320;

  // Build normal equations for [a, b, c]
  let Sxx = 0,
    Sxy = 0,
    Syy = 0,
    Sx = 0,
    Sy = 0;
  let Sxz = 0,
    Syz = 0,
    Sz = 0;
  let used = 0;

  for (let i = 0; i < n; i++) {
    const z = zVals[i];
    if (!Number.isFinite(z)) continue;

    const dx = (ptsLonLat[i].lon - lon0) * mPerDegLon;
    const dy = (ptsLonLat[i].lat - lat0) * mPerDegLat;

    Sxx += dx * dx;
    Sxy += dx * dy;
    Syy += dy * dy;
    Sx += dx;
    Sy += dy;
    Sxz += dx * z;
    Syz += dy * z;
    Sz += z;

    used++;
  }

  if (used < CONFIG.MIN_INSIDE_POINTS_FOR_SLOPE) return 0;

  // Solve 3x3 linear system with Cramer's rule
  const A11 = Sxx,
    A12 = Sxy,
    A13 = Sx;
  const A21 = Sxy,
    A22 = Syy,
    A23 = Sy;
  const A31 = Sx,
    A32 = Sy,
    A33 = used;

  const det =
    A11 * (A22 * A33 - A23 * A32) -
    A12 * (A21 * A33 - A23 * A31) +
    A13 * (A21 * A32 - A22 * A31);

  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return 0;

  const B1 = Sxz,
    B2 = Syz,
    B3 = Sz;

  const detA =
    B1 * (A22 * A33 - A23 * A32) - A12 * (B2 * A33 - A23 * B3) + A13 * (B2 * A32 - A22 * B3);

  const detB =
    A11 * (B2 * A33 - A23 * B3) - B1 * (A21 * A33 - A23 * A31) + A13 * (A21 * B3 - B2 * A31);

  const a = detA / det;
  const b = detB / det;

  const slopePercent = Math.sqrt(a * a + b * b) * 100;

  if (!Number.isFinite(slopePercent)) return 0;

  return clamp(slopePercent, 0, 100);
}

// =============================================================================
// PARCEL RESOLVER (v1.9: strict sb_* vs JWT separation)
// =============================================================================

/**
 * Returns the best available API key for internal Edge calls.
 * v1.9: Strictly prefer sb_* keys over JWTs for the apikey header.
 * Priority:
 *   1. SUPABASE_ANON_KEY (sb_publishable_*) - MUST be an sb_* key
 *   2. SUPABASE_SERVICE_ROLE_KEY (sb_secret_*) - MUST be an sb_* key
 *   3. EDGE_ANON_JWT (JWT, only if no sb_* key available)
 *   4. EDGE_SERVICE_ROLE_JWT (JWT, only if no sb_* key available)
 * Returns null if none available (caller must handle).
 */
function getApiKeyOrNull(): { key: string; kind: "sb_key" | "jwt" } | null {
  // v1.9: Strictly prefer Supabase keys (sb_publishable_* or sb_secret_*)
  // ENV.SUPABASE_ANON_KEY is now guaranteed to be an sb_* key or empty (thanks to getSbKeyEnvVar)
  if (ENV.SUPABASE_ANON_KEY) {
    return { key: ENV.SUPABASE_ANON_KEY, kind: "sb_key" };
  }
  
  // ENV.SUPABASE_SERVICE_ROLE_KEY is now guaranteed to be an sb_* key or empty
  if (ENV.SUPABASE_SERVICE_ROLE_KEY) {
    return { key: ENV.SUPABASE_SERVICE_ROLE_KEY, kind: "sb_key" };
  }

  // Fallback to JWTs only if no sb_* keys available
  // ENV.EDGE_ANON_JWT is now guaranteed to be a JWT or empty (thanks to getJwtEnvVar)
  if (ENV.EDGE_ANON_JWT) {
    return { key: ENV.EDGE_ANON_JWT, kind: "jwt" };
  }
  
  // ENV.EDGE_SERVICE_ROLE_JWT is now guaranteed to be a JWT or empty
  if (ENV.EDGE_SERVICE_ROLE_JWT) {
    return { key: ENV.EDGE_SERVICE_ROLE_JWT, kind: "jwt" };
  }

  return null;
}

/**
 * Returns the best available Authorization token (must be a JWT).
 * v1.9: Strict validation - only accept actual JWTs.
 * If incoming request has a valid Bearer JWT token, use it.
 * Otherwise fallback to EDGE_SERVICE_ROLE_JWT or EDGE_ANON_JWT.
 * Returns null if no valid JWT available (caller must handle).
 */
function getAuthorizationOrNull(req: Request): { token: string; kind: "jwt" } | null {
  const incoming = (req.headers.get("Authorization") || "").trim();

  if (incoming.startsWith("Bearer ")) {
    const token = incoming.slice("Bearer ".length).trim();
    // Only accept if it looks like a JWT (not an sb_* key)
    if (looksLikeJwt(token) && !looksLikeSupabaseKey(token)) {
      return { token: `Bearer ${token}`, kind: "jwt" };
    }
    // Incoming token is not a JWT (e.g., sb_publishable_*), don't forward it
  }

  // Fallback to edge JWTs (prefer service role for internal calls)
  // ENV.EDGE_SERVICE_ROLE_JWT is now guaranteed to be a JWT or empty
  if (ENV.EDGE_SERVICE_ROLE_JWT) {
    return { token: `Bearer ${ENV.EDGE_SERVICE_ROLE_JWT}`, kind: "jwt" };
  }
  
  // ENV.EDGE_ANON_JWT is now guaranteed to be a JWT or empty
  if (ENV.EDGE_ANON_JWT) {
    return { token: `Bearer ${ENV.EDGE_ANON_JWT}`, kind: "jwt" };
  }

  // Legacy fallback - ENV.INTERNAL_ANON_JWT is now guaranteed to be a JWT or empty
  if (ENV.INTERNAL_ANON_JWT) {
    return { token: `Bearer ${ENV.INTERNAL_ANON_JWT}`, kind: "jwt" };
  }

  return null;
}

/**
 * Validates that we have the required configuration to call cadastre-from-commune.
 * Returns { valid: true } or { valid: false, missing: string[] }.
 */
function validateCadastreConfig(req: Request): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!ENV.EDGE_INTERNAL_URL) {
    missing.push("EDGE_INTERNAL_URL (or MIMMOZA_EDGE_INTERNAL_URL / SUPABASE_URL)");
  }

  const apiKey = getApiKeyOrNull();
  if (!apiKey) {
    missing.push("API key (SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / MIMMOZA_EDGE_ANON_JWT)");
  }

  const auth = getAuthorizationOrNull(req);
  if (!auth) {
    missing.push("Authorization JWT (MIMMOZA_EDGE_SERVICE_ROLE_JWT / MIMMOZA_EDGE_ANON_JWT or valid Bearer JWT in request)");
  }

  return { valid: missing.length === 0, missing };
}

async function resolveParcelGeojson(
  req: Request,
  communeInsee: string,
  parcelId: string,
  log?: Logger
): Promise<Record<string, unknown>> {
  // Use EDGE_INTERNAL_URL instead of SUPABASE_URL
  if (!ENV.EDGE_INTERNAL_URL) {
    throw new Error("Missing EDGE_INTERNAL_URL (configure MIMMOZA_EDGE_INTERNAL_URL or SUPABASE_URL)");
  }

  const baseUrl = ENV.EDGE_INTERNAL_URL.replace(/\/$/, "");
  const url = `${baseUrl}/functions/v1/cadastre-from-commune`;

  const apiKeyResult = getApiKeyOrNull();
  if (!apiKeyResult) {
    throw new Error("Missing API key for cadastre-from-commune call (no sb_* key or JWT available)");
  }

  const authResult = getAuthorizationOrNull(req);
  if (!authResult) {
    throw new Error("Missing Authorization JWT for cadastre-from-commune call (no valid JWT available)");
  }

  // v1.9: Debug logging (non-sensitive) before the call
  log?.warn("Calling cadastre-from-commune", {
    communeInsee,
    parcelId,
    baseUrl: baseUrl.slice(0, 30) + "...",
    hasApiKey: true,
    apiKeyKind: apiKeyResult.kind,
    hasAuth: true,
    authKind: authResult.kind,
  });

  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKeyResult.key,
        Authorization: authResult.token,
      },
      body: JSON.stringify({ commune_insee: communeInsee }),
    },
    {
      timeoutMs: 15_000,
      maxRetries: 2,
      baseBackoffMs: 250,
      jitterMs: 200,
      retryOnStatuses: isRetryableStatus,
      tag: "CADASTRE_FROM_COMMUNE",
      log,
    }
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`cadastre-from-commune HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }

  const json = await res.json();
  const fc = extractFeatureCollectionFromAnyResponse(json);

  if (!fc) {
    throw new Error("cadastre-from-commune: FeatureCollection not found in response");
  }

  const feature = findFeatureForParcelRobust(fc, parcelId);

  if (!feature) {
    throw new Error(`Parcel not found: parcelId=${parcelId}`);
  }

  const normalized = normalizeToFeature(feature);

  if (!normalized) {
    throw new Error("Invalid parcel feature geometry");
  }

  return normalized;
}

// =============================================================================
// ETAG GENERATION
// =============================================================================
function generateEtag(data: unknown): string {
  const str = JSON.stringify(data);
  let hash = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  return `"${PUBLIC_VERSION}-${Math.abs(hash).toString(36)}"`;
}

// =============================================================================
// HEALTH CHECK (v1.9: enhanced envKinds diagnostic)
// =============================================================================

/**
 * Helper to determine the kind of an env var value.
 */
function getEnvKind(value: string): "sb_key" | "jwt" | "none" {
  if (!value) return "none";
  if (looksLikeSupabaseKey(value)) return "sb_key";
  if (looksLikeJwt(value)) return "jwt";
  return "none";
}

function handleHealthCheck(): Response {
  const apiKeyResult = getApiKeyOrNull();
  
  // v1.9: Compute envKinds for each relevant env var
  const envKinds = {
    supabaseAnonKey: getEnvKind(ENV.SUPABASE_ANON_KEY),
    supabaseServiceRoleKey: getEnvKind(ENV.SUPABASE_SERVICE_ROLE_KEY),
    edgeAnonJwt: getEnvKind(ENV.EDGE_ANON_JWT),
    edgeServiceRoleJwt: getEnvKind(ENV.EDGE_SERVICE_ROLE_JWT),
    internalAnonJwt: getEnvKind(ENV.INTERNAL_ANON_JWT),
  };
  
  const health = {
    status: "healthy",
    version: PUBLIC_VERSION,
    buildStamp: BUILD_STAMP,
    instanceId: INSTANCE_ID,
    cache: terrainCache.stats(),
    circuitBreakers: {
      IGN_ALTI: circuitBreaker.getStatus("IGN_ALTI"),
      OPENTOPODATA: circuitBreaker.getStatus("OPENTOPODATA"),
    },
    environment: {
      hasIgnKey: Boolean(ENV.IGN_ALTI_KEY),
      hasEdgeInternalUrl: Boolean(ENV.EDGE_INTERNAL_URL),
      // v1.9: These now reflect the typed resolution (only true if correct type)
      hasEdgeServiceRoleJwt: Boolean(ENV.EDGE_SERVICE_ROLE_JWT),
      hasEdgeAnonJwt: Boolean(ENV.EDGE_ANON_JWT),
      // Legacy compatibility checks
      hasSupabaseUrl: Boolean(ENV.SUPABASE_URL),
      hasSupabaseServiceRoleKey: Boolean(ENV.SUPABASE_SERVICE_ROLE_KEY),
      hasSupabaseAnonKey: Boolean(ENV.SUPABASE_ANON_KEY),
      hasInternalAnonJwt: Boolean(ENV.INTERNAL_ANON_JWT),
      // v1.9: Show what kind of apikey would be used
      apiKeyKind: apiKeyResult?.kind ?? "none",
      // v1.9: New diagnostic showing the resolved type of each env var
      envKinds,
    },
  };

  return jsonResponse(health);
}

// =============================================================================
// MAIN HANDLER
// =============================================================================
async function handleTerrainAnalysis(req: Request): Promise<Response> {
  const ctx: RequestContext = {
    requestId: crypto.randomUUID().slice(0, 12),
    startTime: Date.now(),
    parcelId: null,
    communeInsee: null,
  };

  const log = logger.withContext(ctx);

  try {
    // Parse and validate input
    const rawPayload = await req.json().catch(() => ({}));
    const validation = validateInput(rawPayload as TerrainInput);

    if (!validation.valid) {
      log.warn("Invalid input", { errors: validation.errors });
      return errorResponse(validation.errors.join("; "), 400, ctx);
    }

    const payload = validation.sanitized;
    ctx.parcelId = payload.parcel_id;
    ctx.communeInsee = payload.commune_insee;

    log.info("Processing terrain analysis request", {
      parcelId: payload.parcel_id,
      communeInsee: payload.commune_insee,
      gridSize: payload.grid_size,
    });

    // Check ETag for conditional requests
    const ifNoneMatch = req.headers.get("If-None-Match");

    // 1) Resolve parcel GeoJSON
    let parcelFeature: Record<string, unknown> | null = null;

    if (payload.parcel_geojson) {
      parcelFeature = normalizeToFeature(payload.parcel_geojson);
    }

    if (!parcelFeature) {
      if (!payload.parcel_id || !payload.commune_insee) {
        return errorResponse("Missing parcel_geojson and (parcel_id + commune_insee)", 400, ctx);
      }

      // EARLY VALIDATION: Check that we have the required config before calling cadastre-from-commune
      const configCheck = validateCadastreConfig(req);
      if (!configCheck.valid) {
        log.error("Missing configuration for cadastre-from-commune", { missing: configCheck.missing });
        return errorResponse(
          `Configuration manquante pour résoudre la parcelle: ${configCheck.missing.join(", ")}`,
          400,
          ctx,
          { missingConfig: configCheck.missing }
        );
      }

      parcelFeature = await resolveParcelGeojson(req, payload.commune_insee, payload.parcel_id, log);
    }

    // 2) Compute bounding boxes
    const baseBbox = bboxFromFeature(parcelFeature);
    const renderBbox = padBbox(baseBbox, payload.padding_meters!);

    // 3) Build cache key
    const cacheKey = [
      INTERNAL_VERSION,
      payload.parcel_id ?? "no-id",
      payload.commune_insee ?? "no-ci",
      `base=${baseBbox.map((x) => x.toFixed(6)).join(",")}`,
      `render=${renderBbox.map((x) => x.toFixed(6)).join(",")}`,
      `n=${payload.grid_size}`,
      `ign=${ENV.IGN_ALTI_KEY ? "1" : "0"}`,
    ].join("|");

    // Check cache
    const cached = terrainCache.get(cacheKey, payload.cache_ttl_ms ?? undefined);

    if (cached) {
      const etag = generateEtag(cached.terrainData);

      if (ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ...corsHeaders,
            ETag: etag,
            "X-Request-Id": ctx.requestId,
          },
        });
      }

      log.info("Cache hit", { cacheKey: cacheKey.slice(0, 50), ms: Date.now() - ctx.startTime });

      return jsonResponse(
        {
          success: true,
          version: PUBLIC_VERSION,
          buildStamp: BUILD_STAMP,
          terrainData: cached.terrainData,
          debug: {
            ...cached.debug,
            ms: Date.now() - ctx.startTime,
            cache: "HIT",
            requestId: ctx.requestId,
          },
        },
        200,
        { etag, requestId: ctx.requestId }
      );
    }

    // 4) Build grids
    const gridRender = buildGrid(renderBbox, payload.grid_size!);
    const renderMaskPack = filterInsidePoints(parcelFeature, gridRender.points);

    const statsPack = buildStatsSamplePointsAdaptive(
      parcelFeature,
      baseBbox,
      payload.grid_size!,
      payload.stats_grid_max_n!
    );

    if (statsPack.inside.length < CONFIG.MIN_INSIDE_POINTS_FOR_SLOPE) {
      return errorResponse(
        `Stats sampling too sparse: inside=${statsPack.inside.length}. Check parcel geometry.`,
        422,
        ctx
      );
    }

    // 5) Fetch elevations (parallel when using IGN)
    log.debug("Fetching elevations", {
      renderPoints: gridRender.points.length,
      statsPoints: statsPack.inside.length,
    });

    const elevationResult = await fetchElevationsParallel(gridRender.points, statsPack.inside, {
      timeoutMs: payload.request_timeout_ms!,
      maxRetries:
        ENV.IGN_ALTI_KEY && !circuitBreaker.isOpen("IGN_ALTI")
          ? payload.ign_max_retries!
          : payload.opentopo_max_retries!,
      chunkDelayMs: payload.opentopo_chunk_delay_ms,
      log,
    });

    // Validate elevation results
    if (elevationResult.render.length !== gridRender.points.length) {
      throw new Error(
        `Elevation(render) size mismatch: got ${elevationResult.render.length}, expected ${gridRender.points.length}`
      );
    }

    if (elevationResult.stats.length !== statsPack.inside.length) {
      throw new Error(
        `Elevation(stats) size mismatch: got ${elevationResult.stats.length}, expected ${statsPack.inside.length}`
      );
    }

    // 6) Fill missing values
    const filledRender = fillMissingValues(elevationResult.render);
    const filledStats = fillMissingValues(elevationResult.stats);

    // 7) Build render grid z-values
    const nR = gridRender.n;
    const gridZRender: number[][] = new Array(nR);

    let idx = 0;
    for (let y = 0; y < nR; y++) {
      const row = new Array<number>(nR);
      for (let x = 0; x < nR; x++) {
        const z = filledRender.filled[idx++];
        row[x] = Number.isFinite(z) ? z : filledRender.fillValue;
      }
      gridZRender[y] = row;
    }

    // 8) Compute stats from inside-parcel points only
    let altitudeMin = Infinity;
    let altitudeMax = -Infinity;

    for (const z of filledStats.filled) {
      const val = Number.isFinite(z) ? z : filledStats.fillValue;
      if (val < altitudeMin) altitudeMin = val;
      if (val > altitudeMax) altitudeMax = val;
    }

    // Fallback if still invalid
    if (!Number.isFinite(altitudeMin) || !Number.isFinite(altitudeMax)) {
      const med = medianFinite(filledStats.filled);
      if (med === null || !Number.isFinite(med)) {
        throw new Error("Cannot compute altitude stats");
      }
      altitudeMin = med;
      altitudeMax = med;
    }

    // 9) Compute slope via plane-fit
    const penteMoyenne = estimateSlopePlaneFitPercent(statsPack.inside, filledStats.filled);

    // 10) Build response
    const terrainData: TerrainData = {
      altitudeMin,
      altitudeMax,
      penteMoyenne,
      provider: elevationResult.provider,
      parcelBounds: baseBbox,
      renderBounds: renderBbox,
      grid: { z: gridZRender, n: nR },
      parcel_id: payload.parcel_id,
      commune_insee: payload.commune_insee,
      parcelGeojson: parcelFeature,
    };

    const ms = Date.now() - ctx.startTime;

    const debug = {
      ms,
      cache: "MISS",
      requestId: ctx.requestId,
      provider: elevationResult.provider,
      baseBbox,
      renderBbox,
      nRender: nR,
      pointsCountRender: gridRender.points.length,
      inParcelCountRender: renderMaskPack.count,
      nStatsUsed: statsPack.nUsed,
      pointsCountStatsGridAll: statsPack.gridAll.points.length,
      inParcelCountStats: statsPack.inCount,
      statsMinNeeded: statsPack.minNeeded,
      filledNaNWithRender: filledRender.fillValue,
      filledNaNWithStats: filledStats.fillValue,
      circuitBreakers: {
        IGN_ALTI: circuitBreaker.getStatus("IGN_ALTI").state,
        OPENTOPODATA: circuitBreaker.getStatus("OPENTOPODATA").state,
      },
      cacheStats: terrainCache.stats(),
    };

    // Store in cache
    terrainCache.set(cacheKey, { terrainData, debug });

    const etag = generateEtag(terrainData);

    log.info("Request completed", { ms, provider: elevationResult.provider, cache: "MISS" });

    return jsonResponse(
      {
        success: true,
        version: PUBLIC_VERSION,
        buildStamp: BUILD_STAMP,
        terrainData,
        debug,
      },
      200,
      { etag, requestId: ctx.requestId }
    );
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const ms = Date.now() - ctx.startTime;

    log.error("Request failed", {
      error: error.message,
      ms,
      parcelId: ctx.parcelId,
      communeInsee: ctx.communeInsee,
    });

    // v1.9: Improved status code mapping (including 401/403)
    let status = 500;
    const msg = error.message.toLowerCase();

    if (msg.includes("missing") || msg.includes("invalid") || msg.includes("configuration manquante")) {
      status = 400;
    } else if (msg.includes("not found")) {
      status = 404;
    } else if (msg.includes("http 401") || msg.includes(" 401:") || msg.includes(" 401 ")) {
      status = 401;
    } else if (msg.includes("http 403") || msg.includes(" 403:") || msg.includes(" 403 ")) {
      status = 403;
    } else if (msg.includes("circuit breaker")) {
      status = 503;
    } else if (msg.includes("timeout") || msg.includes("abort")) {
      status = 504;
    }

    return jsonResponse(
      {
        success: false,
        version: PUBLIC_VERSION,
        buildStamp: BUILD_STAMP,
        error: error.message,
        debug: {
          ms,
          requestId: ctx.requestId,
          circuitBreakers: {
            IGN_ALTI: circuitBreaker.getStatus("IGN_ALTI").state,
            OPENTOPODATA: circuitBreaker.getStatus("OPENTOPODATA").state,
          },
        },
      },
      status,
      { requestId: ctx.requestId }
    );
  }
}

// =============================================================================
// SERVER ENTRY POINT
// =============================================================================
Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // Health check endpoint
  if (url.pathname.endsWith("/health") || url.searchParams.has("health")) {
    return handleHealthCheck();
  }

  // Main terrain analysis
  return handleTerrainAnalysis(req);
});