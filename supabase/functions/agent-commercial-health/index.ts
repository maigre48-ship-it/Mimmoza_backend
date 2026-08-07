// supabase/functions/agent-commercial-health/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Module « Agent commercial » — Phase 5A · SOCLE SERVEUR.
// Contrôle de santé du socle : valide l'accès administrateur (requireAdmin) et
// vérifie que le client service-role (JWT Signing Keys) atteint bien la base.
//
// Fichier AUTONOME, collable tel quel dans le dashboard Supabase (Edge Functions).
// Anatomie alignée sur copilot-chat. Les helpers ci-dessous (readFirstJsonKey,
// getSupabase*Key, getAdmin, getUserClient, requireAdmin, corsHeaders, classe
// d'erreur) sont VOLONTAIREMENT destinés à être dupliqués dans chaque fonction
// du module (le dossier _shared n'est pas utilisé : déploiement par copier-coller).
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

// ── Clés Supabase (JWT Signing Keys) ─────────────────────────────────────────
// La legacy SUPABASE_SERVICE_ROLE_KEY seule est dépréciée/désactivée (401).
// On lit d'abord les dictionnaires JSON de clés, puis on retombe sur les
// variables historiques.

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
    // Pas un JSON : on ignore et on utilisera les fallbacks.
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

// ── Erreurs typées ───────────────────────────────────────────────────────────

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

// ── CORS (inliné) ────────────────────────────────────────────────────────────

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// ── Clients Supabase ─────────────────────────────────────────────────────────

let _admin: SupabaseClient | null = null;

/** Client service-role mémoïsé (accès total, sans RLS). */
function getAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const url = getSupabaseUrl();
  const key = getSupabaseServiceRoleKey();
  if (!url || !key) {
    throw new CommercialError('CONFIG', 'Configuration Supabase serveur manquante.', 500);
  }
  _admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

/** Client « publishable » portant le header Authorization de l'appelant. */
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

// ── requireAdmin ─────────────────────────────────────────────────────────────
// Vérifie l'admin CÔTÉ SERVEUR. Ne fait JAMAIS confiance à un rôle du body.
// La RPC is_current_user_admin() doit être appelée AVEC LE CLIENT UTILISATEUR
// (sinon auth.uid() est null et la RPC renvoie toujours false).

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

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders();

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    if (req.method !== 'POST') {
      throw new CommercialError('METHOD_NOT_ALLOWED', 'Méthode non autorisée.', 405);
    }

    // 1. Sécurité : admin obligatoire.
    const userId = await requireAdmin(req);

    // 2. Vérifie que la service-role key (JWT Signing Keys) atteint bien la base.
    //    C'est le point qui casse avec la legacy SUPABASE_SERVICE_ROLE_KEY (401).
    const { error: dbErr } = await getAdmin()
      .from('commercial_knowledge_base')
      .select('id', { count: 'exact', head: true });
    if (dbErr) {
      throw new CommercialError('DB_UNREACHABLE', `Client service-role KO : ${dbErr.message}`, 500);
    }

    return new Response(
      JSON.stringify({ ok: true, userId, serviceRole: 'ok' }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    if (err instanceof CommercialError) {
      return new Response(JSON.stringify(err.toJSON()), {
        status: err.statusCode,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    console.error('[agent-commercial-health] erreur inattendue:', err);
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL', message: 'Erreur interne.' } }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }
});
