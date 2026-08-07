// supabase/functions/agent-commercial-oauth-start/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Module « Agent commercial » — Phase 6A · OAuth Google (démarrage).
// requireAdmin → construit l'URL de consentement Google et la RENVOIE (ne redirige
// pas). Le paramètre state est un jeton signé (HMAC) anti-CSRF, vérifié au callback.
//
// Fichier AUTONOME, verify_jwt = OFF, format d'erreur { error: { code, message } }.
// AUCUN jeton, AUCUN client_secret n'est renvoyé.
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

// ── Client utilisateur + requireAdmin ────────────────────────────────────────

function getUserClient(authHeader: string): SupabaseClient {
  const url = getSupabaseUrl();
  const key = getSupabasePublishableKey();
  if (!url || !key) {
    throw new CommercialError('CONFIG', 'Configuration Supabase serveur manquante.', 500);
  }
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

// ── State signé (HMAC-SHA256, clé = GOOGLE_OAUTH_CLIENT_SECRET) ───────────────

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(str: string): string {
  return b64urlFromBytes(new TextEncoder().encode(str));
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

async function signState(secret: string): Promise<string> {
  const nonce = b64urlFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  const payload = b64urlFromString(JSON.stringify({ n: nonce, t: Math.floor(Date.now() / 1000) }));
  const sig = b64urlFromBytes(await hmacSha256(secret, payload));
  return `${payload}.${sig}`;
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    if (req.method !== 'POST') {
      throw new CommercialError('METHOD_NOT_ALLOWED', 'Méthode non autorisée.', 405);
    }
    await requireAdmin(req);

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const redirectUri = Deno.env.get('GOOGLE_OAUTH_REDIRECT_URI');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!clientId || !redirectUri || !clientSecret) {
      throw new CommercialError('CONFIG', 'Secrets OAuth Google manquants.', 500);
    }

    const state = await signState(clientSecret);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email https://www.googleapis.com/auth/gmail.send',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return new Response(JSON.stringify({ ok: true, url }), {
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
    console.error('[agent-commercial-oauth-start] erreur:', err);
    return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'Erreur interne.' } }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
