import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function cacheGet(
  supabase: SupabaseClient,
  provider: string,
  cache_key: string,
) {
  const { data, error } = await supabase.rpc("api_cache_get", {
    p_provider: provider,
    p_cache_key: cache_key,
  });
  if (error) throw error;
  return (data && data[0]) ? data[0] : null;
}

export async function cachePut(
  supabase: SupabaseClient,
  provider: string,
  cache_key: string,
  request: any,
  response: any,
  status: number,
  ttl_seconds: number,
) {
  const { error } = await supabase.rpc("api_cache_put", {
    p_provider: provider,
    p_cache_key: cache_key,
    p_request: request ?? {},
    p_response: response ?? null,
    p_status: status ?? null,
    p_ttl_seconds: ttl_seconds ?? 86400,
  });
  if (error) throw error;
}
