// supabase/functions/agent-commercial-oauth-callback/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Module « Agent commercial » — Phase 6A · OAuth Google (callback).
// Appelée par GOOGLE (pas par le front). AUCUN JWT → PAS de requireAdmin : la
// sécurité repose ENTIÈREMENT sur la vérification stricte du paramètre `state`
// (HMAC signé par oauth-start, TTL court). C'est la SEULE fonction du module sans
// requireAdmin.
//
// Échange le code contre les jetons, upsert dans commercial_integrations, puis
// REDIRIGE vers la page Paramètres. Ne renvoie JAMAIS de jeton (ni corps, ni URL).
// verify_jwt = OFF.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

// ── Clés Supabase (service-role) ─────────────────────────────────────────────

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

function getSupabaseServiceRoleKey(): string {
  return (
    readFirstJsonKey(Deno.env.get('SUPABASE_SECRET_KEYS')) ??
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
    Deno.env.get('SERVICE_ROLE_KEY') ??
    ''
  );
}

function getAdmin(): SupabaseClient {
  const url = getSupabaseUrl();
  const key = getSupabaseServiceRoleKey();
  if (!url || !key) throw new Error('Configuration Supabase serveur manquante.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ── base64url + HMAC + vérification du state ─────────────────────────────────

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function verifyState(secret: string, state: string): Promise<boolean> {
  const parts = state.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = b64urlFromBytes(await hmacSha256(secret, payload));
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const obj = JSON.parse(b64urlToString(payload)) as { t?: number };
    if (typeof obj.t !== 'number') return false;
    const age = Math.floor(Date.now() / 1000) - obj.t;
    return age >= 0 && age <= 600;
  } catch {
    return false;
  }
}

function decodeIdTokenEmail(idToken: string): string | null {
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(b64urlToString(parts[1])) as { email?: string };
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

// ── Redirection vers la page Paramètres (jamais de jeton dans l'URL) ──────────

function redirectToApp(result: 'connected' | 'error', reason?: string): Response {
  const base = Deno.env.get('APP_BASE_URL');
  if (!base) {
    return new Response('APP_BASE_URL manquant.', { status: 500 });
  }
  const url = new URL('/admin/agent-commercial/parametres', base);
  url.searchParams.set('gmail', result);
  if (reason) url.searchParams.set('reason', reason);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    if (req.method !== 'GET') {
      return redirectToApp('error', 'method');
    }

    const reqUrl = new URL(req.url);
    const googleError = reqUrl.searchParams.get('error');
    if (googleError) return redirectToApp('error', 'denied');

    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state');
    if (!code || !state) return redirectToApp('error', 'missing_params');

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    const redirectUri = Deno.env.get('GOOGLE_OAUTH_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri) return redirectToApp('error', 'config');

    // Anti-CSRF : le state DOIT être valide.
    if (!(await verifyState(clientSecret, state))) return redirectToApp('error', 'invalid_state');

    // Échange du code contre les jetons.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
      id_token?: string;
      error?: string;
    };

    if (!tokenRes.ok || !tokenJson.access_token) {
      return redirectToApp('error', 'token_exchange');
    }
    if (!tokenJson.refresh_token) {
      // Sans refresh_token, impossible d'envoyer plus tard : on refuse la connexion.
      return redirectToApp('error', 'no_refresh_token');
    }

    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + (tokenJson.expires_in ?? 3600) * 1000).toISOString();
    const scopes = tokenJson.scope ? tokenJson.scope.split(' ') : null;
    const accountEmail = tokenJson.id_token ? decodeIdTokenEmail(tokenJson.id_token) : null;

    const admin = getAdmin();
    const { error: upErr } = await admin.from('commercial_integrations').upsert(
      {
        provider: 'google',
        account_email: accountEmail,
        send_as_email: 'commercial@mimmoza.fr',
        refresh_token: tokenJson.refresh_token,
        access_token: tokenJson.access_token,
        token_expires_at: expiresAt,
        scopes,
        status: 'connected',
        last_sync_at: new Date(nowMs).toISOString(),
        last_error: null,
      },
      { onConflict: 'provider' },
    );
    if (upErr) return redirectToApp('error', 'persist');

    try {
      await admin.from('commercial_activity_log').insert({
        event_type: 'gmail_connected',
        entity: 'integration',
        metadata: { account_email: accountEmail },
      });
    } catch {
      // non bloquant
    }

    return redirectToApp('connected');
  } catch (err) {
    console.error('[agent-commercial-oauth-callback] erreur:', err);
    return redirectToApp('error', 'server_error');
  }
});
