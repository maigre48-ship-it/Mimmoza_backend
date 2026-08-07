// supabase/functions/_shared/copilot/supabaseAdmin.ts

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

let _admin: SupabaseClient | null = null;

/**
 * Client Supabase avec service_role.
 * Singleton par instance Edge Function (cache entre requêtes).
 * À utiliser UNIQUEMENT pour les opérations qui doivent bypasser RLS
 * (écriture sur copilot_credit_ledger, copilot_messages, etc.).
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables',
    );
  }

  _admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });

  return _admin;
}

/**
 * Client Supabase basé sur le JWT utilisateur (RLS appliqué).
 * À utiliser pour les opérations qui DOIVENT respecter RLS
 * (lecture des conversations, par exemple).
 */
export function getSupabaseUser(authHeader: string): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!url || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  }

  return createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}