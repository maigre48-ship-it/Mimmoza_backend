// supabase/functions/agent-commercial-generate/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Module « Agent commercial » — Phase 5B · GÉNÉRATION IA.
// Génère un email de prospection (Anthropic) et l'écrit dans commercial_emails
// au statut 'pending_review' (validation humaine obligatoire ensuite).
//
// Fichier AUTONOME, collable tel quel (Edge Functions). verify_jwt = OFF :
// requireAdmin est le SEUL rempart. Format d'erreur : { error: { code, message } }.
//
// Vérification d'exclusion RÉIMPLÉMENTÉE EN SQL ici (la fonction Deno ne peut pas
// importer src/exclusionCheck.ts) : opt_out, status='exclu', email et domaine dans
// commercial_exclusions → 403, AUCUN appel LLM. Règle volontairement dédoublée
// (front pour l'ergonomie, serveur pour la garantie).
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

// ── Clés Supabase (JWT Signing Keys) — dupliqué depuis agent-commercial-health ──

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
    // Pas un JSON : fallbacks.
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

function getAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const url = getSupabaseUrl();
  const key = getSupabaseServiceRoleKey();
  if (!url || !key) {
    throw new CommercialError('CONFIG', 'Configuration Supabase serveur manquante.', 500);
  }
  _admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _admin;
}

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

// ── requireAdmin (dupliqué tel quel) ─────────────────────────────────────────

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

// ── Domaine métier ───────────────────────────────────────────────────────────

const EMAIL_KINDS = [
  'premier_contact',
  'relance_1',
  'relance_2',
  'reponse_question',
  'proposition_demo',
  'proposition_essai',
  'suivi_demo',
] as const;
type EmailKind = (typeof EMAIL_KINDS)[number];

const KIND_INSTRUCTIONS: Record<EmailKind, string> = {
  premier_contact: 'Premier email de prise de contact, sans historique préalable.',
  relance_1: 'Première relance après un premier contact resté sans réponse. Ton courtois, apporte un angle nouveau.',
  relance_2: 'Seconde relance, plus brève, dernière tentative avant mise en pause.',
  reponse_question: 'Réponse à une question posée par le prospect.',
  proposition_demo: 'Proposition concrète de démonstration, avec appel à choisir un créneau.',
  proposition_essai: "Proposition d'un essai/période de test.",
  suivi_demo: "Suivi après une démonstration réalisée.",
};

const PROSPECT_STATUS_LIST =
  'a_qualifier, a_contacter, message_a_valider, contacte, relance_prevue, a_repondu, ' +
  'interesse, demonstration, essai, negociation, client, non_interesse, exclu';

function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const t = email.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

function domainOfEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1);
}

interface ProspectRow {
  id: string;
  company_name: string;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  email: string | null;
  city: string | null;
  department: string | null;
  zone: string | null;
  company_type: string | null;
  company_size: string | null;
  status: string;
  opt_out: boolean;
  notes: string | null;
}

// ── Garde d'exclusion (SQL côté serveur) ─────────────────────────────────────
// Renvoie un motif si le prospect ne doit PAS être contacté, sinon null.

async function exclusionReason(
  admin: SupabaseClient,
  prospect: ProspectRow,
): Promise<string | null> {
  if (prospect.opt_out) return 'Prospect en opposition à la prospection (opt-out).';
  if (prospect.status === 'exclu') return 'Prospect au statut « exclu ».';

  const email = normalizeEmail(prospect.email);
  if (email) {
    const { data: byEmail, error: e1 } = await admin
      .from('commercial_exclusions')
      .select('id')
      .eq('email', email)
      .limit(1);
    if (e1) throw new CommercialError('DB_ERROR', e1.message, 500);
    if (byEmail && byEmail.length > 0) return 'Adresse email présente dans la liste d’exclusion.';

    const domain = domainOfEmail(email);
    if (domain) {
      const { data: byDomain, error: e2 } = await admin
        .from('commercial_exclusions')
        .select('id')
        .eq('domain', domain)
        .limit(1);
      if (e2) throw new CommercialError('DB_ERROR', e2.message, 500);
      if (byDomain && byDomain.length > 0) return 'Domaine présent dans la liste d’exclusion.';
    }
  }

  return null;
}

// ── Base de connaissances (entrées validées uniquement) ──────────────────────

async function buildKnowledgeContext(admin: SupabaseClient): Promise<string> {
  const { data, error } = await admin
    .from('commercial_knowledge_base')
    .select('section, title, content, position')
    .eq('status', 'valide')
    .order('section', { ascending: true })
    .order('position', { ascending: true });

  if (error) throw new CommercialError('DB_ERROR', error.message, 500);

  const rows = (data ?? []) as Array<{ section: string; title: string; content: string }>;
  if (rows.length === 0) {
    return "(Base de connaissances vide : reste générique, n'invente aucune information, aucun tarif.)";
  }

  return rows
    .map((r) => `## ${r.section} — ${r.title}\n${r.content}`)
    .join('\n\n');
}

// ── Appel Anthropic ──────────────────────────────────────────────────────────

interface GeneratedEmail {
  subject: string;
  body: string;
  internal_rationale: string;
  recommended_status: string | null;
  recommended_next_action: string | null;
}

function envInt(name: string): number | null {
  const v = Deno.env.get(name);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stripJsonFences(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return t.trim();
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

interface AnthropicResult {
  parsed: GeneratedEmail;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

async function callAnthropic(
  prospect: ProspectRow,
  kind: EmailKind,
  knowledge: string,
): Promise<AnthropicResult> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new CommercialError('CONFIG', 'ANTHROPIC_API_KEY manquante.', 500);
  }

  const model = Deno.env.get('SALES_AI_MODEL') ?? Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';
  const maxTokens = envInt('SALES_AI_MAX_TOKENS') ?? 1500;
  const timeoutMs = envInt('SALES_AI_TIMEOUT_MS') ?? envInt('ANTHROPIC_TIMEOUT_MS') ?? 60000;

  const contactName = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ') || '(inconnu)';

  const system =
    "Tu es l'assistant commercial de Mimmoza. Tu rédiges des emails de prospection B2B, " +
    "en français, à destination de marchands de biens, pour le compte de commercial@mimmoza.fr. " +
    "Style professionnel, direct, sans exagération ni superlatifs creux. " +
    "Utilise UNIQUEMENT les informations de la base de connaissances fournie. " +
    "N'invente JAMAIS de tarif : si aucun tarif n'est fourni, propose un échange plutôt que d'annoncer un prix. " +
    'Réponds STRICTEMENT en JSON, sans préambule, sans backticks, avec exactement ces clés : ' +
    'subject (string), body (string), internal_rationale (string, note pour le relecteur humain), ' +
    `recommended_status (string ou null, parmi : ${PROSPECT_STATUS_LIST}), ` +
    'recommended_next_action (string ou null). Aucune autre clé.';

  const user =
    `Type d'email à rédiger : ${kind} — ${KIND_INSTRUCTIONS[kind]}\n\n` +
    `Prospect :\n` +
    `- Société : ${prospect.company_name}\n` +
    `- Contact : ${contactName}${prospect.job_title ? ` (${prospect.job_title})` : ''}\n` +
    `- Localisation : ${[prospect.city, prospect.department, prospect.zone].filter(Boolean).join(', ') || '(non renseignée)'}\n` +
    `- Type d'entreprise : ${prospect.company_type ?? '(non renseigné)'} — Taille : ${prospect.company_size ?? '(non renseignée)'}\n` +
    `- Notes internes : ${prospect.notes ?? '(aucune)'}\n\n` +
    `Base de connaissances (validée) :\n${knowledge}\n\n` +
    'Rédige l’email et renvoie le JSON demandé.';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new CommercialError('AI_TIMEOUT', 'Délai dépassé lors de la génération IA.', 504);
    }
    throw new CommercialError('AI_ERROR', 'Appel IA impossible.', 502);
  } finally {
    clearTimeout(timer);
  }

  const payload = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new CommercialError('AI_ERROR', payload.error?.message ?? `Anthropic ${res.status}`, 502);
  }

  const rawText = (payload.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(stripJsonFences(rawText));
  } catch {
    throw new CommercialError('AI_INVALID_OUTPUT', "La sortie IA n'est pas un JSON valide.", 502);
  }

  if (!parsedUnknown || typeof parsedUnknown !== 'object') {
    throw new CommercialError('AI_INVALID_OUTPUT', 'Sortie IA inattendue.', 502);
  }

  const obj = parsedUnknown as Record<string, unknown>;
  const subject = asStringOrNull(obj.subject);
  const body = asStringOrNull(obj.body);
  if (!subject || !body) {
    throw new CommercialError('AI_INVALID_OUTPUT', 'Sortie IA incomplète (subject/body manquant).', 502);
  }

  return {
    parsed: {
      subject,
      body,
      internal_rationale: asStringOrNull(obj.internal_rationale) ?? '',
      recommended_status: asStringOrNull(obj.recommended_status),
      recommended_next_action: asStringOrNull(obj.recommended_next_action),
    },
    model,
    tokensIn: payload.usage?.input_tokens ?? null,
    tokensOut: payload.usage?.output_tokens ?? null,
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders();

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    if (req.method !== 'POST') {
      throw new CommercialError('METHOD_NOT_ALLOWED', 'Méthode non autorisée.', 405);
    }

    // 1. Sécurité : admin obligatoire (seul rempart, verify_jwt = OFF).
    const userId = await requireAdmin(req);

    // 2. Entrée.
    let input: { prospect_id?: unknown; kind?: unknown };
    try {
      input = (await req.json()) as { prospect_id?: unknown; kind?: unknown };
    } catch {
      throw new CommercialError('BAD_REQUEST', 'Corps JSON invalide.', 400);
    }
    const prospectId = typeof input.prospect_id === 'string' ? input.prospect_id : '';
    const kind = input.kind;
    if (!UUID_RE.test(prospectId)) {
      throw new CommercialError('BAD_REQUEST', 'prospect_id invalide.', 400);
    }
    if (typeof kind !== 'string' || !EMAIL_KINDS.includes(kind as EmailKind)) {
      throw new CommercialError('BAD_REQUEST', 'kind invalide.', 400);
    }

    const admin = getAdmin();

    // 3. Prospect.
    const { data: prospect, error: pErr } = await admin
      .from('commercial_prospects')
      .select(
        'id, company_name, first_name, last_name, job_title, email, city, department, zone, company_type, company_size, status, opt_out, notes',
      )
      .eq('id', prospectId)
      .maybeSingle();
    if (pErr) throw new CommercialError('DB_ERROR', pErr.message, 500);
    if (!prospect) throw new CommercialError('NOT_FOUND', 'Prospect introuvable.', 404);

    // 4. Garde d'exclusion (SQL) AVANT tout appel LLM.
    const reason = await exclusionReason(admin, prospect as ProspectRow);
    if (reason) {
      throw new CommercialError('PROSPECT_EXCLUDED', reason, 403);
    }

    // 5. Contexte + génération.
    const knowledge = await buildKnowledgeContext(admin);
    const result = await callAnthropic(prospect as ProspectRow, kind as EmailKind, knowledge);

    // 6. Écriture en 'pending_review' (jamais draft/approved/sent).
    const { data: inserted, error: iErr } = await admin
      .from('commercial_emails')
      .insert({
        prospect_id: prospectId,
        kind,
        subject: result.parsed.subject,
        body: result.parsed.body,
        internal_rationale: result.parsed.internal_rationale,
        recommended_status: result.parsed.recommended_status,
        recommended_next_action: result.parsed.recommended_next_action,
        status: 'pending_review',
        ai_model: result.model,
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
        generated_by: userId,
      })
      .select('id, status')
      .single();
    if (iErr) throw new CommercialError('DB_ERROR', iErr.message, 500);

    // 7. Journalisation (non bloquante).
    try {
      await admin.from('commercial_activity_log').insert({
        event_type: 'email_generated',
        entity: 'email',
        entity_id: inserted.id,
        actor_id: userId,
        metadata: { prospect_id: prospectId, kind, model: result.model },
      });
    } catch {
      // non bloquant
    }

    return new Response(
      JSON.stringify({
        ok: true,
        email: {
          id: inserted.id,
          status: inserted.status,
          subject: result.parsed.subject,
          body: result.parsed.body,
          internal_rationale: result.parsed.internal_rationale,
          recommended_status: result.parsed.recommended_status,
          recommended_next_action: result.parsed.recommended_next_action,
          ai_model: result.model,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
        },
      }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    if (err instanceof CommercialError) {
      return new Response(JSON.stringify(err.toJSON()), {
        status: err.statusCode,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    console.error('[agent-commercial-generate] erreur inattendue:', err);
    return new Response(
      JSON.stringify({ error: { code: 'INTERNAL', message: 'Erreur interne.' } }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }
});
