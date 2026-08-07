// supabase/functions/agent-commercial-integration-status/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Module « Agent commercial » — Phase 6A · État d'intégration Google.
// requireAdmin. Renvoie l'état de connexion SANS AUCUN JETON. Deux actions :
//   - 'status' (défaut) : renvoie status/account_email/send_as_email/scopes/
//     last_sync_at/last_error ; si connecté, valide/rafraîchit le jeton (helper
//     réutilisé en 6B) pour détecter une révocation (→ status='error').
//   - 'disconnect' : révoque le jeton chez Google, efface refresh/access token,
//     status='disconnected', journalise gmail_disconnected.
// Fichier AUTONOME, verify_jwt = OFF, format d'erreur { error: { code, message } }.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

// ── Clés Supabase ────────────────────────────────────────────────────────────

function readFirstJsonKey(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const v of Object.values(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
  } catch {
    // fallbacks
  }
  return null;
}

function getSupabaseUrl(): string {
  return Deno.env.get('SUPABASE_URL') ?? '';
}

function getSupabasePublishableKey(): string {
  return (
    readFirstJsonKey(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')) ??
    Deno.env.get('SUPABASE_ANON_KEY') ??
    Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ??
    Deno.env.get('VITE_SUPABASE_ANON_KEY') ??
    ''
  );
}

function getSupabaseServiceRoleKey(): string {
  return (
    readFirstJsonKey(Deno.env.get('SUPABASE_SECRET_KEYS')) ??
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
    Deno.env.get('SERVICE_ROLE_KEY') ??
    ''
  );
}

// ── Erreurs / CORS ───────────────────────────────────────────────────────────

class CommercialError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'CommercialError';
    this.code = code;
    this.statusCode = statusCode;
  }
  toJSON(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// ── Clients + requireAdmin ───────────────────────────────────────────────────

let _admin: SupabaseClient | null = null;

function getAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const url = getSupabaseUrl();
  const key = getSupabaseServiceRoleKey();
  if (!url || !key) throw new CommercialError('CONFIG', 'Configuration Supabase serveur manquante.', 500);
  _admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _admin;
}

function getUserClient(authHeader: string): SupabaseClient {
  const url = getSupabaseUrl();
  const key = getSupabasePublishableKey();
  if (!url || !key) throw new CommercialError('CONFIG', 'Configuration Supabase serveur manquante.', 500);
  return createClient(url, key, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requireAdmin(req: Request): Promise<string> {
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    throw new CommercialError('UNAUTHENTICATED', "Jeton d'accès manquant.", 401);
  }
  const userClient = getUserClient(authHeader);
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    throw new CommercialError('UNAUTHENTICATED', 'Session invalide ou expirée.', 401);
  }
  const { data: isAdmin, error: rpcErr } = await userClient.rpc('is_current_user_admin');
  if (rpcErr) {
    throw new CommercialError('ADMIN_CHECK_FAILED', 'Vérification administrateur impossible.', 500);
  }
  if (isAdmin !== true) {
    throw new CommercialError('FORBIDDEN', 'Accès réservé aux administrateurs.', 403);
  }
  return userData.user.id;
}

// ── Intégration ──────────────────────────────────────────────────────────────

interface IntegrationRow {
  status: string;
  account_email: string | null;
  send_as_email: string | null;
  scopes: string[] | null;
  last_sync_at: string | null;
  last_error: string | null;
  refresh_token: string | null;
  access_token: string | null;
  token_expires_at: string | null;
}

const SELECT_FULL =
  'status, account_email, send_as_email, scopes, last_sync_at, last_error, refresh_token, access_token, token_expires_at';
const SELECT_SAFE = 'status, account_email, send_as_email, scopes, last_sync_at, last_error';

async function readRow(admin: SupabaseClient): Promise<IntegrationRow | null> {
  const { data, error } = await admin
    .from('commercial_integrations')
    .select(SELECT_FULL)
    .eq('provider', 'google')
    .maybeSingle();
  if (error) throw new CommercialError('DB_ERROR', error.message, 500);
  return (data as IntegrationRow | null) ?? null;
}

/**
 * HELPER DE RAFRAÎCHISSEMENT (réutilisé en 6B) : renvoie un access_token valide.
 * Rafraîchit via le refresh_token si le jeton est expiré/proche, met à jour la
 * table. En cas d'échec (refresh_token révoqué), passe status='error' et lève.
 * N'est exposé sur AUCUNE route.
 */
async function getValidAccessToken(admin: SupabaseClient, row: IntegrationRow): Promise<string> {
  const now = Date.now();
  const exp = row.token_expires_at ? Date.parse(row.token_expires_at) : 0;
  if (row.access_token && exp - now > 120000) return row.access_token;

  if (!row.refresh_token) {
    await admin
      .from('commercial_integrations')
      .update({ status: 'error', last_error: 'Refresh token manquant.' })
      .eq('provider', 'google');
    throw new CommercialError('GMAIL_NO_REFRESH', 'Refresh token manquant.', 409);
  }

  const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new CommercialError('CONFIG', 'Secrets OAuth manquants.', 500);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !json.access_token) {
    await admin
      .from('commercial_integrations')
      .update({ status: 'error', last_error: json.error_description ?? json.error ?? `refresh ${res.status}` })
      .eq('provider', 'google');
    throw new CommercialError('GMAIL_REFRESH_FAILED', 'Rafraîchissement du jeton Google échoué.', 502);
  }

  const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString();
  await admin
    .from('commercial_integrations')
    .update({
      access_token: json.access_token,
      token_expires_at: expiresAt,
      status: 'connected',
      last_error: null,
      last_sync_at: new Date().toISOString(),
    })
    .eq('provider', 'google');

  return json.access_token;
}

function safeStatus(row: IntegrationRow | { status: string; account_email: string | null; send_as_email: string | null; scopes: string[] | null; last_sync_at: string | null; last_error: string | null } | null) {
  return {
    status: row?.status ?? 'disconnected',
    account_email: row?.account_email ?? null,
    send_as_email: row?.send_as_email ?? null,
    scopes: row?.scopes ?? null,
    last_sync_at: row?.last_sync_at ?? null,
    last_error: row?.last_error ?? null,
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    if (req.method !== 'POST') {
      throw new CommercialError('METHOD_NOT_ALLOWED', 'Méthode non autorisée.', 405);
    }
    const userId = await requireAdmin(req);

    let action = 'status';
    try {
      const body = (await req.json()) as { action?: unknown };
      if (typeof body.action === 'string') action = body.action;
    } catch {
      // corps vide → action par défaut 'status'
    }

    const admin = getAdmin();
    const row = await readRow(admin);

    if (action === 'disconnect') {
      const token = row?.refresh_token ?? row?.access_token ?? null;
      if (token) {
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          });
        } catch {
          // révocation best-effort
        }
      }
      if (row) {
        await admin
          .from('commercial_integrations')
          .update({
            status: 'disconnected',
            refresh_token: null,
            access_token: null,
            token_expires_at: null,
            last_error: null,
            last_sync_at: new Date().toISOString(),
          })
          .eq('provider', 'google');
        try {
          await admin.from('commercial_activity_log').insert({
            event_type: 'gmail_disconnected',
            entity: 'integration',
            actor_id: userId,
            metadata: {},
          });
        } catch {
          // non bloquant
        }
      }
      const fresh = await admin
        .from('commercial_integrations')
        .select(SELECT_SAFE)
        .eq('provider', 'google')
        .maybeSingle();
      return new Response(JSON.stringify({ ok: true, ...safeStatus(fresh.data as IntegrationRow | null) }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // action 'status' : si connecté, on valide/rafraîchit pour détecter une révocation.
    if (row && row.status === 'connected') {
      try {
        await getValidAccessToken(admin, row);
      } catch {
        // getValidAccessToken a déjà positionné status='error' + last_error.
      }
    }

    const fresh = await admin
      .from('commercial_integrations')
      .select(SELECT_SAFE)
      .eq('provider', 'google')
      .maybeSingle();

    return new Response(JSON.stringify({ ok: true, ...safeStatus(fresh.data as IntegrationRow | null) }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof CommercialError) {
      return new Response(JSON.stringify(err.toJSON()), {
        status: err.statusCode,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    console.error('[agent-commercial-integration-status] erreur:', err);
    return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Erreur interne.' } }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
