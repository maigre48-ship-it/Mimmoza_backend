// supabase/functions/_shared/providers/cache.ts
// Best-effort in-memory cache for edge functions (per isolate).
// Provides a supabase-aware signature used by providers (dvf/finess/etc.).
// NOTE: This cache is NOT shared across isolates/regions and may be evicted anytime.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

type CacheRecord = {
  fetched_at: string; // ISO date
  status: number; // HTTP-like status
  request?: unknown;
  response?: unknown;
  expires_at: number; // epoch ms
};

const memoryCache = new Map<string, CacheRecord>();

function nowIso(): string {
  return new Date().toISOString();
}

function makeKey(provider: string, key: string): string {
  return `${provider}:${key}`;
}

// --------------------------------------------------
// Supabase-aware API (expected by providers)
// --------------------------------------------------

/**
 * Get a cached record.
 * Signature expected: cacheGet(supabase, provider, key)
 */
export async function cacheGet(
  _supabase: SupabaseClient | null,
  provider: string,
  key: string,
): Promise<CacheRecord | null> {
  const k = makeKey(provider, key);
  const entry = memoryCache.get(k);
  if (!entry) return null;

  if (Date.now() > entry.expires_at) {
    memoryCache.delete(k);
    return null;
  }

  return entry;
}

/**
 * Put a cached record.
 * Signature expected: cachePut(supabase, provider, key, request, response, status, ttl_seconds)
 */
export async function cachePut(
  _supabase: SupabaseClient | null,
  provider: string,
  key: string,
  request: unknown,
  response: unknown,
  status: number,
  ttl_seconds: number,
): Promise<void> {
  const ttlSec = Number.isFinite(Number(ttl_seconds)) ? Number(ttl_seconds) : 60;
  const ttlMs = Math.max(0, Math.round(ttlSec * 1000));

  const k = makeKey(provider, key);
  memoryCache.set(k, {
    fetched_at: nowIso(),
    status: Number.isFinite(Number(status)) ? Number(status) : 0,
    request,
    response,
    expires_at: Date.now() + ttlMs,
  });
}

// --------------------------------------------------
// Optional local helpers (simple key/value)
// Useful if you still want the "old" API somewhere.
// --------------------------------------------------

export function cacheGetLocal<T = unknown>(key: string): T | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expires_at) {
    memoryCache.delete(key);
    return null;
  }

  return entry.response as T;
}

export function cachePutLocal<T = unknown>(key: string, value: T, ttlMs = 60_000): void {
  memoryCache.set(key, {
    fetched_at: nowIso(),
    status: 200,
    request: undefined,
    response: value,
    expires_at: Date.now() + Math.max(0, ttlMs),
  });
}

export function cacheDelete(providerOrKey: string, maybeKey?: string): void {
  if (maybeKey) {
    // provider-aware delete
    memoryCache.delete(makeKey(providerOrKey, maybeKey));
  } else {
    // raw delete
    memoryCache.delete(providerOrKey);
  }
}

export function cacheClear(): void {
  memoryCache.clear();
}
