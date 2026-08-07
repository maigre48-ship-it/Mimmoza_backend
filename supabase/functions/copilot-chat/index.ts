// supabase/functions/copilot-chat/index.ts
// =============================================================
// Mimmoza Copilot — Orchestrateur principal + streaming SSE
// LOT 4 : SmartScore + DVF branchés sur smartscore-enriched-v3.
// LOT 4.1 : DVF basculé sur la fonction dédiée dvf-comparables-v1 (COPILOT_FN_DVF).
//           Contrat dédié { status, summary, stats, comps } ; repli mutualisé
//           sur smartscore-enriched-v3 (bloc market_like.dvf) conservé.
// PLU    : couche d'explication/synthèse lisant le contexte parser (ctx.plu).
// RISQUES : Géorisques branché sur risk-study via COPILOT_FN_RISKS.
//           ⚠️ Convention de score risk-study : 100 = zone sûre, 0 = risque max.
// LOT 5  : get_quick_market_insight — lecture directe de v_quick_questions_mvp
//           pour les questions rapides investisseur/marchand sur une annonce.
// LOT 6  : predictive_snapshot — bloc de données prédictives (17 sources) injecté
//           dans le system prompt, transmis par le front. Utilisé EN PRIORITÉ par
//           le LLM ; les tools ne sont appelés que pour les données absentes.
// LOT 8  : pageSnapshot — donnees visibles a l'ecran de la page courante (ex :
//           valorisation rehabilitation) injectees telles quelles dans le prompt.
//
// Secrets utilisés (existants) :
//   ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_MAX_TOKENS,
//   ANTHROPIC_TIMEOUT_MS, SUPABASE_URL, (publishable + service role)
// Optionnels (overrides modèle) :
//   COPILOT_MODEL_QUICK, COPILOT_MODEL_ADVANCED, COPILOT_MODEL_REPORT
// Optionnels (branchement tools métier) :
//   COPILOT_FN_PARCEL, COPILOT_FN_PLU, COPILOT_FN_DVF,
//   COPILOT_FN_RISKS, COPILOT_FN_SMARTSCORE, COPILOT_FN_TIMEOUT_MS
//   → DVF dédié : COPILOT_FN_DVF = dvf-comparables-v1
// =============================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

// =============================================================
// SECTION 1 — Configuration
// =============================================================

type CopilotMode = 'quick' | 'advanced' | 'report';

const CREDIT_COST: Record<CopilotMode, number> = {
  quick: 5,
  advanced: 15,
  report: 30,
};

// Modes ouverts en V1 (report arrive en V2)
const V1_MODES: CopilotMode[] = ['quick', 'advanced'];

// Modèle de base (ton secret existant) — fallback pour tous les modes.
const BASE_MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';

// Modèles par mode : override optionnel par mode, sinon BASE_MODEL.
const MODEL_BY_MODE: Record<CopilotMode, string> = {
  quick: Deno.env.get('COPILOT_MODEL_QUICK') ?? BASE_MODEL,
  advanced: Deno.env.get('COPILOT_MODEL_ADVANCED') ?? BASE_MODEL,
  report: Deno.env.get('COPILOT_MODEL_REPORT') ?? BASE_MODEL,
};

// Plafond global défini dans tes secrets (garde-fou absolu).
const GLOBAL_MAX_TOKENS = Number(Deno.env.get('ANTHROPIC_MAX_TOKENS')) || 8000;

// Budget de sortie par mode — PLAFOND de génération, pas une cible.
// Généreux volontairement : à 2500 le rapport d'étude (get_etude_parcelle) était
// coupé AVANT le verdict et les points de vigilance, soit sa partie la plus utile.
// Aucun impact économique : le débit est calculé sur l'usage effectif (debitJetons).
// ⚠️ Borné par GLOBAL_MAX_TOKENS → monter aussi le secret ANTHROPIC_MAX_TOKENS,
//    sinon ces valeurs sont écrasées par l'ancien plafond.
// ⚠️ 32000 en report était intenable : une Edge Function n'a pas le temps de
// streamer autant avant d'être coupée (« network error » côté client, et ni
// settle ni refund ne s'exécutent → réservation orpheline). 16000 reste très
// large pour un rapport complet.
const MAX_OUTPUT_TOKENS: Record<CopilotMode, number> = {
  quick: Math.min(16000, GLOBAL_MAX_TOKENS),
  advanced: Math.min(16000, GLOBAL_MAX_TOKENS),
  report: Math.min(16000, GLOBAL_MAX_TOKENS),
};

// Gate de réservation : une ATTENTE réaliste de sortie, PAS le plafond absolu.
// Sans cette séparation, relever MAX_OUTPUT_TOKENS gonfle mécaniquement la
// réservation (worstCaseJetons) : chaque message immobiliserait dix fois ce
// qu'il coûte réellement, et l'utilisateur serait bloqué en INSUFFICIENT_CREDITS
// bien avant d'avoir consommé son solde. Le débit final reste l'usage réel.
const GATE_OUTPUT_TOKENS: Record<CopilotMode, number> = {
  quick: 3000, advanced: 4000, report: 8000,
};

// Timeout par appel LLM (ton secret existant), fallback 60s.
const LLM_TIMEOUT_MS = Number(Deno.env.get('ANTHROPIC_TIMEOUT_MS')) || 60000;

// Nombre max d'allers-retours tool-calling par mode (garde-fou latence + coût).
// ⚠️ Chaque itération = 1 appel LLM + N appels d'outils (jusqu'à ~20 s pour les
// plus lents) : 12 itérations dépassent la durée d'exécution disponible.
const MAX_TOOL_ITERATIONS: Record<CopilotMode, number> = {
  quick: 5,
  advanced: 6,
  report: 8,
};

// Historique conversation injecté (nb de messages max)
const MAX_HISTORY_MESSAGES: Record<CopilotMode, number> = {
  quick: 6,
  advanced: 12,
  report: 20,
};

// ─── Edge Functions internes (tools LOT 4) ───────────────────
// Un tool n'est "branché" que si son secret de nom de fonction est défini.
// Sinon il renvoie proprement { status: 'not_configured' }.
//   ex: COPILOT_FN_SMARTSCORE = smartscore-enriched-v3
//   ex: COPILOT_FN_DVF        = dvf-comparables-v1   (fonction DVF dédiée)
//   ex: COPILOT_FN_RISKS      = risk-study           (nom de ta fonction risques)
const INTERNAL_FUNCTIONS = {
  parcel: Deno.env.get('COPILOT_FN_PARCEL') ?? null,
  plu: Deno.env.get('COPILOT_FN_PLU') ?? null,
  dvf: Deno.env.get('COPILOT_FN_DVF') ?? null,            // dédié ; sinon mutualisé sur smartscore
  risks: Deno.env.get('COPILOT_FN_RISKS') ?? null,
  smartscore: Deno.env.get('COPILOT_FN_SMARTSCORE') ?? null,
  dpe: Deno.env.get('COPILOT_FN_DPE') ?? null,           // dpe-ademe-v1
  merimee: Deno.env.get('COPILOT_FN_MERIMEE') ?? null,   // patrimoine-merimee-v1
  bdnb: Deno.env.get('COPILOT_FN_BDNB') ?? null,         // batiment-bdnb-v1
  loyers: Deno.env.get('COPILOT_FN_LOYERS') ?? null,     // loyers-reference-v1
  servitudes: Deno.env.get('COPILOT_FN_SERVITUDES') ?? null, // servitudes-gpu-v1
  solaire: Deno.env.get('COPILOT_FN_SOLAIRE') ?? null,       // potentiel-solaire-v1
  zonage: Deno.env.get('COPILOT_FN_ZONAGE') ?? null,         // zonage-abc-v1
  taxes: Deno.env.get('COPILOT_FN_TAXES') ?? null,           // taxes-locales-v1
  ppr: Deno.env.get('COPILOT_FN_PPR') ?? null,               // ppr-detail-v1
 assainissement: Deno.env.get('COPILOT_FN_ASSAINISSEMENT') ?? null, // assainissement-commune-v1
  altimetrie: Deno.env.get('COPILOT_FN_ALTIMETRIE') ?? null,       // altimetrie-v1
  bruit: Deno.env.get('COPILOT_FN_BRUIT') ?? null,                // bruit-classement-v1
  etude: Deno.env.get('COPILOT_FN_ETUDE') ?? null,                // etude-parcelle-v1
  market: Deno.env.get('COPILOT_FN_MARKET') ?? null,              // market-study-investisseur-v1
  couts: Deno.env.get('COPILOT_FN_COUTS') ?? null,                // couts-construction-v1
  couts_renovation: Deno.env.get('COPILOT_FN_COUTS_RENOVATION') ?? null, // couts-renovation-v1
  sitadel: Deno.env.get('COPILOT_FN_SITADEL') ?? null,            // promoteur-permis-construire (permis géolocalisés récents)
  sirene: Deno.env.get('COPILOT_FN_SIRENE') ?? null,              // etablissements-sirene-v1 (établissements proches, API DINUM)
  bpe: Deno.env.get('COPILOT_FN_BPE') ?? null,                    // bpe-proxy (équipements et services, BPE INSEE via ODS)
  sru: Deno.env.get('COPILOT_FN_SRU') ?? null,                    // besoin-logements-sociaux (SRU / LLS)
  contexte: Deno.env.get('COPILOT_FN_CONTEXTE') ?? null,          // contexte-commune-v1 (contexte éditorial Wikidata/Wikipédia)
  gpu: Deno.env.get('COPILOT_FN_GPU') ?? null,                    // gpu-parcelle-v1 (zonage PLU + prescriptions, API Carto GPU)
  appels_offres: Deno.env.get('COPILOT_FN_APPELS_OFFRES') ?? null, // appels-offres-v1 (avis BOAMP ouverts)
} as const;

// Timeout dédié aux appels de fonctions internes (séparé du LLM).
// smartscore-enriched-v3 et risk-study font plusieurs appels externes → 25s.
const INTERNAL_FN_TIMEOUT_MS = Number(Deno.env.get('COPILOT_FN_TIMEOUT_MS')) || 25000;

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// uuid canonique — pour tout champ mappé sur une colonne Postgres type uuid.
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── Constantes économiques (les SEULS nombres à ajuster) ────
const JETON_VALUE_EUR = 0.10;
const MARGIN = 3;
const USD_TO_EUR = 0.95;
const ASSUMED_MAX_INPUT_TOKENS = 60_000;

const TIER_RATES = {
  haiku:  { in: 1, out: 5  },
  sonnet: { in: 3, out: 15 },
  opus:   { in: 5, out: 25 },
} as const;

type ModelTier = keyof typeof TIER_RATES;

const TIER_MODEL_ID: Record<ModelTier, string> = {
  haiku:  Deno.env.get('COPILOT_MODEL_HAIKU')  ?? 'claude-haiku-4-5',
  sonnet: Deno.env.get('COPILOT_MODEL_SONNET') ?? (Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6'),
  opus:   Deno.env.get('COPILOT_MODEL_OPUS')   ?? 'claude-opus-4-8',
};

type Plan = 'basic' | 'advanced' | 'pro';

const PLAN_POLICY: Record<Plan, {
  tiers: ModelTier[];
  defaultTier: ModelTier;
  mode: CopilotMode;
  unlockAllTabs: boolean;
}> = {
  basic:    { tiers: ['haiku'],          defaultTier: 'haiku',  mode: 'quick',    unlockAllTabs: false },
  advanced: { tiers: ['sonnet'],         defaultTier: 'sonnet', mode: 'advanced', unlockAllTabs: false },
  pro:      { tiers: ['sonnet', 'opus'], defaultTier: 'sonnet', mode: 'report',   unlockAllTabs: true  },
};

// Vocabulaire des abonnements Mimmoza (PlanId front : basique | avance | pro |
// proplus) + valeurs héritées côté base. Tout ce qui n'est pas reconnu vaut
// 'basic' : un plan inconnu ne doit jamais ouvrir de droits par accident.
function normalizePlan(stored: string | null | undefined): Plan {
  switch ((stored ?? '').toLowerCase().trim()) {
    case 'proplus':
    case 'pro':      return 'pro';
    case 'avance':
    case 'advanced':
    case 'starter':  return 'advanced';
    default:         return 'basic';   // basique, free, freemium, null…
  }
}

// ⚠️ SOURCE DU PLAN — vérifié en base :
//   · 'profiles' n'existe pas ;
//   · users_profiles.plan est un vestige (une seule ligne, valeur 'freemium') ;
//   · billing_profiles (alimentée par stripe-webhook) porte plan_code +
//     subscription_status : c'est la seule source exploitable côté serveur.
// Le front, lui, lit encore localStorage via usePlanAccess : tant que ce TODO
// n'est pas levé, un utilisateur peut voir 'pro' à l'écran et être 'basic' ici.
// Un abonnement résilié ou impayé ne donne aucun droit, même avec plan_code 'pro'.
async function getUserPlan(userId: string): Promise<Plan> {
  try {
    const { data, error } = await getAdmin()
      .from('billing_profiles')
      .select('plan_code, subscription_status')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) console.error('[copilot] lecture du plan échouée', error.message);
    const actif = ['active', 'trialing'].includes(String(data?.subscription_status ?? ''));
    if (data && !actif) {
      console.warn('[copilot] abonnement non actif :', data.subscription_status);
    }
    return actif ? normalizePlan(data?.plan_code as string | undefined) : 'basic';
  } catch (e) {
    console.error('[copilot] getUserPlan exception', e);
    return 'basic';
  }
}

function resolveTier(plan: Plan, requested?: ModelTier): ModelTier {
  const policy = PLAN_POLICY[plan];
  if (requested && policy.tiers.includes(requested)) return requested;
  return policy.defaultTier;
}

function apiCostEur(tier: ModelTier, inputTokens: number, outputTokens: number): number {
  const r = TIER_RATES[tier];
  const usd = (inputTokens * r.in + outputTokens * r.out) / 1_000_000;
  return usd * USD_TO_EUR;
}

function debitJetons(tier: ModelTier, inputTokens: number, outputTokens: number): number {
  const cost = apiCostEur(tier, inputTokens, outputTokens);
  return Math.max(1, Math.ceil((cost * MARGIN) / JETON_VALUE_EUR));
}

function worstCaseJetons(tier: ModelTier, mode: CopilotMode): number {
  return debitJetons(tier, ASSUMED_MAX_INPUT_TOKENS, GATE_OUTPUT_TOKENS[mode]);
}

// =============================================================
// SECTION 2 — Erreurs typées
// =============================================================

type CopilotErrorCode =
  | 'INSUFFICIENT_CREDITS' | 'INVALID_MODE' | 'INVALID_AMOUNT'
  | 'CONTEXT_REQUIRED' | 'CONTEXT_TOO_LARGE' | 'TOOL_ERROR'
  | 'LLM_ERROR' | 'RATE_LIMITED' | 'INTERNAL_ERROR'
  | 'RESERVATION_NOT_FOUND' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'BAD_REQUEST';

const ERROR_STATUS: Record<CopilotErrorCode, number> = {
  INSUFFICIENT_CREDITS: 402, INVALID_MODE: 400, INVALID_AMOUNT: 400,
  CONTEXT_REQUIRED: 400, CONTEXT_TOO_LARGE: 413, TOOL_ERROR: 500,
  LLM_ERROR: 502, RATE_LIMITED: 429, INTERNAL_ERROR: 500,
  RESERVATION_NOT_FOUND: 404, UNAUTHORIZED: 401, NOT_FOUND: 404, BAD_REQUEST: 400,
};

class CopilotError extends Error {
  readonly code: CopilotErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  constructor(code: CopilotErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CopilotError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.details = details;
  }
  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}

// =============================================================
// SECTION 3 — Clients Supabase (helpers multi-clés conservés)
// =============================================================

let _admin: SupabaseClient | null = null;

function readFirstJsonKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const values = Object.values(parsed);
      const first = values.find((v) => typeof v === "string");
      if (typeof first === "string") return first;
    }
  } catch {
    return raw;
  }
  return null;
}

function getSupabaseUrl(): string {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new CopilotError("INTERNAL_ERROR", "Missing SUPABASE_URL env");
  return url;
}

function getSupabasePublishableKey(): string {
  const key =
    readFirstJsonKey(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")) ??
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("VITE_SUPABASE_ANON_KEY");
  if (!key) throw new CopilotError("INTERNAL_ERROR", "Missing Supabase publishable key env");
  return key;
}

function getSupabaseServiceRoleKey(): string {
  // ⚠️ Projet sur JWT Signing Keys : la legacy SUPABASE_SERVICE_ROLE_KEY est
  // dépréciée/désactivée et provoque un 401 « JWT invalide » lors des appels
  // internes. On lit donc SUPABASE_SECRET_KEYS (dictionnaire JSON des clés
  // secrètes actives) EN PRIORITÉ.
  const key =
    readFirstJsonKey(Deno.env.get("SUPABASE_SECRET_KEYS")) ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SERVICE_ROLE_KEY");
  if (!key) throw new CopilotError("INTERNAL_ERROR", "Missing Supabase service role key env");
  return key;
}

function getAdmin(): SupabaseClient {
  if (_admin) return _admin;
  _admin = createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  });
  return _admin;
}

function getUserClient(authHeader: string): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// =============================================================
// SECTION 4 — Helpers crédits (version compacte inlinée)
// =============================================================

async function reserveCredits(p: {
  userId: string; amount: number; reason: string; conversationId?: string;
}): Promise<{ reservationId: string; remainingBalance: number }> {
  const { data, error } = await getAdmin().rpc('copilot_reserve_credits', {
    p_user_id: p.userId, p_amount: p.amount,
    p_reason: p.reason, p_conversation_id: p.conversationId ?? null,
  });
  if (error) {
    if (error.message?.includes('INSUFFICIENT_CREDITS')) {
      throw new CopilotError('INSUFFICIENT_CREDITS', 'Solde insuffisant', { required: p.amount });
    }
    throw new CopilotError('INTERNAL_ERROR', `Réservation échouée : ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.reservation_id) throw new CopilotError('INTERNAL_ERROR', 'Réponse réservation invalide');
  return { reservationId: row.reservation_id, remainingBalance: row.remaining_balance ?? 0 };
}

async function settleCredits(p: {
  userId: string; reservationId: string; messageId: string;
  mode: CopilotMode; finalAmount?: number; metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await getAdmin().rpc('copilot_settle_credits', {
    p_user_id: p.userId, p_reservation_id: p.reservationId,
    p_message_id: p.messageId, p_metadata: p.metadata ?? null,
    p_final_amount: p.finalAmount ?? null,      // ⬅️ NULL = ancien comportement
  });
  if (error) console.error('[credits] settle failed', error.message);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: ex } = await getAdmin()
      .from('copilot_usage_daily').select('*')
      .eq('user_id', p.userId).eq('date', today).maybeSingle();
    await getAdmin().from('copilot_usage_daily').upsert({
      user_id: p.userId, date: today,
      quick_calls: (ex?.quick_calls ?? 0) + (p.mode === 'quick' ? 1 : 0),
      advanced_calls: (ex?.advanced_calls ?? 0) + (p.mode === 'advanced' ? 1 : 0),
      report_calls: (ex?.report_calls ?? 0) + (p.mode === 'report' ? 1 : 0),
      total_tokens_in: (ex?.total_tokens_in ?? 0) + (Number(p.metadata?.inputTokens) || 0),
      total_tokens_out: (ex?.total_tokens_out ?? 0) + (Number(p.metadata?.outputTokens) || 0),
      total_credits: (ex?.total_credits ?? 0) + (p.finalAmount ?? CREDIT_COST[p.mode]),
    }, { onConflict: 'user_id,date' });
  } catch (e) { console.error('[credits] usage_daily failed', e); }
}

async function refundCredits(p: {
  userId: string; reservationId: string; reason?: string;
}): Promise<number> {
  const { data, error } = await getAdmin().rpc('copilot_refund_credits', {
    p_user_id: p.userId, p_reservation_id: p.reservationId,
    p_reason: p.reason ?? 'refund',
  });
  if (error) { console.error('[credits] refund failed', error.message); return 0; }
  return typeof data === 'number' ? data : 0;
}

// =============================================================
// SECTION 5 — Types contexte & requête
// =============================================================

type Vertical = 'promoteur' | 'investisseur' | 'marchand' | 'apporteur' | 'particulier' | 'generique';

interface MimmozaContext {
  vertical: Vertical;
  route: string;
  // ── Annonce active (investisseur / marchand) ──────────────
  listing_id?: string;
  url?: string;
  city?: string;
  zip_code?: string;
  price?: number;
  surface?: number;
  property_type?: string;
  // ── Foncier ───────────────────────────────────────────────
  parcel?: {
    id: string; address?: string; commune?: string;
    code_postal?: string; surface_m2?: number; plu_zone?: string;
    cadastral_ref?: string; lat?: number; lng?: number; code_insee?: string;
  };
  study?: { id: string; type: string; title?: string };
  user?: { id: string; role?: string; plan?: string };
  // PLU déjà extrait par le parser Mimmoza (rempli par le front, page Foncier).
  // Le ruleset reste dans le contexte ; seul get_parcel_plu le résume au LLM.
  plu?: {
    zone_code?: string;
    zone_libelle?: string;
    source?: string;
    ruleset?: Record<string, unknown> | null;
    oap?: Record<string, unknown> | null;
  };
  // LOT 6 — snapshot prédictif (17 sources, transmis par le front)
  predictive_snapshot?: {
    dvf?: { prix_m2_median?: number | null; nb_transactions?: number | null; evolution_prix_pct?: number | null; prix_m2_min?: number | null; prix_m2_max?: number | null } | null;
    market_scores?: { global?: number | null; demande?: number | null; offre?: number | null; accessibilite?: number | null; environnement?: number | null; transport_exclu?: boolean } | null;
    insee?: { population?: number | null; densite?: number | null; revenu_median?: number | null; taux_chomage?: number | null; taux_pauvrete?: number | null; pct_75_plus?: number | null; pct_etudiants?: number | null; commune_nom?: string | null; departement?: string | null } | null;
    bpe?: { score?: number | null; total_equipements?: number | null; commerces_count?: number | null; sante_count?: number | null; education_count?: number | null; loisirs_count?: number | null } | null;
    transport?: { score?: number | null; has_metro_train?: boolean; has_tram?: boolean; nearest_stop_m?: number | null; is_urban?: boolean } | null;
    georisques?: { nb_risques?: number | null; inondation?: boolean | null; sismique?: number | null; retrait_gonflement?: boolean | null; radon?: number | null; cavites?: boolean | null } | null;
    rentabilite?: { rendement_brut?: number | null; rendement_net?: number | null; cashflow_mensuel?: number | null; marge_brute?: number | null; marge_brute_pct?: number | null; prix_revente_cible?: number | null } | null;
    dpe?: string | null;
    dpe_source?: string | null;
    plu_zone?: string | null;
    sitadel_score?: number | null;
    demographie_score?: number | null;
    loyer_median_zone?: number | null;
    travaux_budget?: number | null;
    fiscal_regime?: string | null;
    bce_rate?: number | null;
    bce_pressure_label?: string | null;
    horizon_mois?: number | null;
    deal_id?: string | null;
    deal_label?: string | null;
    generated_at?: string | null;
    sources_count?: number | null;
  } | null;
  // LOT 8 — snapshot libre de la page courante (donnees visibles a l'ecran)
  pageSnapshot?: Record<string, string | number | null> | null;
  // LOT 9 — étude de risques déjà calculée (page Risques/Réhabilitation),
  // transmise telle quelle par le front. Même contrat que la réponse risk-study :
  // { meta, scores, data, categories, insights }. Injectée dans le system prompt
  // → le Copilot répond aux questions de risques SANS appeler d'outil.
  risk_study?: Record<string, unknown> | null;
  // LOT 10 — implantation 2D dessinée (page Implantation2D), transmise telle
  // quelle par le front : parcelle, reculs, bâtiments, checks PLU, diagnostics,
  // scénario. Injectée dans le system prompt → le Copilot répond sur le plan
  // RÉELLEMENT dessiné, sans appeler d'outil et sans halluciner.
  implantation_2d?: Record<string, unknown> | null;
  // V1.1 — Deal actif et contexte de page (transmis par le front)
  activeDeal?: Record<string, unknown> | null;
  pageContext?: { pathname?: string; space?: string; mode?: string; tab?: string } | null;
}

// V1.7 — Pieces jointes du message courant (images + PDF).
// Encodees en base64 par le front. NON persistees : l'historique relu depuis
// copilot_messages est du texte, donc le modele ne "revoit" pas le fichier
// aux tours suivants.
interface CopilotAttachment {
  mediaType: string;   // image/png|jpeg|gif|webp ou application/pdf
  data: string;        // base64 SANS le prefixe data:
  name?: string;
}

interface ChatRequest {
  conversation_id?: string;
  message: string;
  mode: CopilotMode;
  context: MimmozaContext;
  attachments?: CopilotAttachment[];
}

const ALLOWED_MEDIA_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
]);
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_B64 = 6_000_000; // ~4,5 Mo de fichiers, cumules

// ─── LOT 5 : type d'input pour get_quick_market_insight ─────
interface QuickMarketInput {
  listing_id?: string;
  url?: string;
  city?: string;
  zip_code?: string;
  price?: number;
  surface?: number;
}

// =============================================================
// SECTION 6 — Tool Registry (LOT 4 + LOT 5)
// =============================================================

interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  available_in_modes: CopilotMode[];
}

// ─── Résultats normalisés renvoyés au LLM ────────────────────
type ToolStatus = 'ok' | 'not_configured' | 'not_found' | 'partial' | 'error';

interface ToolResult {
  status: ToolStatus;
  source: string;
  data?: Record<string, unknown>;
  message?: string;
}

// ─── Résolution de l'identifiant parcelle ────────────────────
interface ParcelRef {
  parcel_id?: string;
  cadastral_ref?: string;
  lat?: number;
  lng?: number;
  commune?: string;
  code_insee?: string;
  address?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Extrait la meilleure référence parcelle disponible depuis :
 *  - les inputs fournis par le LLM (prioritaire s'il a précisé)
 *  - le MimmozaContext (source de vérité par défaut)
 * Ne lève jamais : retourne un ParcelRef éventuellement partiel.
 */
function resolveParcelRef(input: Record<string, unknown>, ctx: MimmozaContext): ParcelRef {
  const p = ctx.parcel;
  const ref: ParcelRef = {
    parcel_id: str(input.parcel_id) ?? p?.id,
    cadastral_ref: str(input.cadastral_ref) ?? p?.cadastral_ref,
    lat: num(input.lat) ?? p?.lat,
    lng: num(input.lng) ?? p?.lng,
    commune: str(input.commune) ?? p?.commune,
    code_insee: str(input.code_insee) ?? p?.code_insee,
    address: str(input.address) ?? p?.address,
  };
  // Autonomie : dériver le code INSEE de l'identifiant parcellaire (IDU) si absent.
  // Tout identifiant cadastral français commence par le code INSEE sur 5 caractères :
  //   DDCCC OOO SS NNNN  →  ex "64065000AI0002" → INSEE "64065" (Corse : 2A/2B).
  if (!ref.code_insee) {
    const idu = (ref.cadastral_ref ?? ref.parcel_id ?? '').replace(/\s/g, '');
    const m = /^(2[ab]\d{3}|\d{5})/i.exec(idu);
    if (m) ref.code_insee = m[1].toUpperCase();
  }
  return ref;
}

function hasAnyIdentifier(ref: ParcelRef): boolean {
  return Boolean(ref.parcel_id || ref.cadastral_ref || (ref.lat != null && ref.lng != null));
}

// ─── Helper générique : appel d'une Edge Function interne ────
async function callInternalFunction(fnName: string, body: unknown): Promise<unknown> {
  const baseUrl = getSupabaseUrl();
  const serviceKey = getSupabaseServiceRoleKey();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INTERNAL_FN_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new CopilotError('TOOL_ERROR', `${fnName} → HTTP ${res.status} : ${txt.slice(0, 200)}`);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new CopilotError('TOOL_ERROR', `${fnName} → timeout (${INTERNAL_FN_TIMEOUT_MS}ms)`);
    }
    if (e instanceof CopilotError) throw e;
    throw new CopilotError('TOOL_ERROR', `${fnName} → ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Helpers de résumé ───────────────────────────────────────
function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// =============================================================
// SUMMARIZERS — réduisent le brut en résumé compact pour le LLM.
// ⚠️ La réponse de smartscore-enriched-v3 fait plusieurs Ko :
//    on n'envoie JAMAIS le brut. Aucune valeur inventée.
// =============================================================

/** SmartScore : aligné sur le contrat réel de smartscore-enriched-v3 (v4.1). */
function summarizeSmartScore(raw: unknown): Record<string, unknown> {
  const root = raw as Record<string, unknown>;
  if (!root || root.success === false) {
    return { note: 'Réponse SmartScore vide ou en erreur', error: root?.error ?? null };
  }

  const v4 = root.smartscore_v4 as Record<string, unknown> | undefined;
  const v3 = root.smartscore as Record<string, unknown> | undefined;

  const out: Record<string, unknown> = {
    version: root.version ?? null,
    zone_type: root.zone_type ?? null,
  };

  // smartscore v4.6 — Classification de densité INSEE et rayons réellement
  // appliqués. Sans ce relais, le modèle écrivait « commune rurale » en le
  // déduisant de la densité, et commentait des équipements sans savoir sur quel
  // périmètre ils avaient été cherchés (500 m ou 20 km selon le niveau).
  const zoneProfile = root.zone_profile as Record<string, unknown> | undefined;
  if (zoneProfile) {
    out.zone_profile = pick(zoneProfile, [
      'zone_type', 'niveau_3', 'niveau_7', 'libelle_niveau_7', 'source', 'rayons_m', 'avertissement',
    ]);
  }

  if (v4) {
    out.score = v4.score ?? null;
    out.verdict = v4.verdict ?? null;

    // smartscore v4.5 — Indicateur de confiance. Le score global est renormalisé
    // sur les seuls piliers disponibles, mais rien n'indiquait combien : un
    // SmartScore assis sur 2 piliers sur 10 se lisait comme un score complet.
    // `score: null` signifie « non calculable », JAMAIS « moyen ».
    const conf = v4.confidence as Record<string, unknown> | undefined;
    if (conf) {
      out.confiance = {
        ...pick(conf, ['piliers_mesures', 'piliers_total', 'piliers_ecartes']),
        avertissement:
          "Un pilier écarté n'a PAS été mesuré : ne le présente ni comme favorable ni comme défavorable, et ne l'omets pas silencieusement. "
          + "Si des piliers manquent, dis-le dans ta conclusion et pas seulement dans un tableau. "
          + "Un score null signifie « non calculable faute de sources » — ne l'interprète jamais comme un potentiel moyen.",
      };
    }

    // Piliers : on ne garde que le score de chaque pilier (pas les sous-détails).
    // Un pilier à null = non mesuré (écarté de la pondération), pas un zéro.
    const pillars = v4.pillar_scores as Record<string, unknown> | undefined;
    if (pillars) {
      out.piliers = pick(pillars, [
        'market', 'price_opportunity', 'services', 'transport',
        'ecoles', 'sante', 'environment', 'demographie', 'competition', 'dpe',
        'rural_accessibility',
      ]);
    }

    // smartscore v4.5 — Composants du pilier environnement. Géorisques, DPE de
    // quartier et qualité de l'air sont des stubs NON BRANCHÉS : le pilier
    // entier est donc à null aujourd'hui. Le score de bruit, lui, est une
    // ESTIMATION (déduite de la desserte, ou forcée en zone classée rurale) et
    // son libellé le dit — à ne pas citer comme une mesure.
    const env = v4.environment as Record<string, unknown> | undefined;
    if (env) {
      const noise = env.noise as Record<string, unknown> | undefined;
      const geo = env.georisques as Record<string, unknown> | undefined;
      out.environnement_detail = {
        score: env.score ?? null,
        // smartscore v4.7 : Géorisques est branché sur risk-study-v1. Sa
        // couverture voyage avec le score — un pilier bâti sur 4 critères de
        // risque sur 9 ne se commente pas comme un pilier complet.
        georisques: geo
          ? {
              score_securite: geo.score ?? null,
              nb_risques_averes: geo.risks_count ?? null,
              principaux_risques: geo.main_risks ?? [],
              coverage: geo.coverage ?? null,
              criteres_mesures: geo.criteres_mesures ?? null,
              criteres_total: geo.criteres_total ?? null,
            }
          : null,
        bruit_label: noise?.label ?? null,
        bruit_est_une_estimation: noise?.estimated ?? null,
        avertissement:
          "Le DPE de quartier et la qualité de l'air ne sont toujours PAS branchés : ne commente jamais ces deux aspects. "
          + "Le score de bruit est une ESTIMATION (déduite de la desserte, ou forcée en zone peu dense), pas une mesure — dis-le si tu le cites. "
          + "Si `georisques` est null, le volet risques n'a rien mesuré : n'en déduis aucune qualité environnementale. "
          + "Pour un avis détaillé sur les risques, appuie-toi sur l'étude de risques (risk-study), plus complète que ce pilier.",
      };
    }

    // DPE : label + contrainte réglementaire (sans le texte long)
    const dpe = v4.dpe as Record<string, unknown> | undefined;
    if (dpe) {
      const constraint = dpe.constraint as Record<string, unknown> | undefined;
      out.dpe = {
        label: dpe.label ?? null,
        score: dpe.score ?? null,
        is_blocking: constraint?.is_blocking ?? false,
        severity: constraint?.severity ?? 'none',
        title: constraint?.title ?? null,
      };
    }

    // Opportunité prix (décote vs marché) si présente
    const priceOpp = v4.price_opportunity as Record<string, unknown> | undefined;
    if (priceOpp) {
      out.price_opportunity = pick(priceOpp, [
        'prix_m2_bien', 'prix_m2_marche', 'decote_pct', 'score',
      ]);
    }

    // Impact business énergétique (résumé seulement)
    const energy = v4.energy_business_impact as Record<string, unknown> | undefined;
    if (energy && energy.summary) {
      out.energy_impact = pick(energy, ['exploitability_risk', 'summary']);
    }
  } else if (v3) {
    // Fallback V3 (mode standard sans V4)
    out.score = v3.score ?? null;
    out.verdict = v3.verdict ?? null;
    out.composants = v3.components ?? null;
  } else {
    out.note = 'Aucun bloc SmartScore reconnu dans la réponse';
    out.raw_keys = Object.keys(root);
  }

  return out;
}

/** DVF : extrait depuis market_like.dvf / market.dvf de la réponse smartscore. */
function summarizeDvfFromSmartScore(raw: unknown, limit = 10): Record<string, unknown> {
  const root = raw as Record<string, unknown>;
  const marketLike = root?.market_like as Record<string, unknown> | undefined;
  const market = root?.market as Record<string, unknown> | undefined;
  const dvf = (marketLike?.dvf ?? market?.dvf) as Record<string, unknown> | undefined;

  if (!dvf) {
    return { note: 'Pas de bloc DVF dans la réponse', status: 'no_data' };
  }

  const kpis = dvf.kpis as Record<string, unknown> | undefined;
  const comps = (dvf.comps ?? market?.comps) as unknown[] | undefined;

  const out: Record<string, unknown> = {
    coverage: dvf.coverage ?? null,
    source: dvf.source ?? null,
  };

  // Prix : selon le mode, soit dans kpis, soit dans market.prices
  if (kpis) {
    out.prix = pick(kpis, [
      'transactions_count', 'price_median_eur_m2',
      'price_mean_eur_m2', 'price_q1_eur_m2', 'price_q3_eur_m2',
    ]);
  } else if (market?.prices) {
    out.prix = market.prices;
    out.transactions = market.transactions;
  }

  // Comparables : top N, champs essentiels uniquement
  if (Array.isArray(comps) && comps.length > 0) {
    out.count_total = comps.length;
    out.comparables = comps.slice(0, limit).map((c) =>
      pick(c, ['date', 'price_m2', 'surface_m2', 'type_local', 'distance_m', 'commune', 'address'])
    );
  }

  return out;
}

/**
 * DVF (fonction dédiée dvf-comparables-v1) : la réponse est DÉJÀ un résumé compact
 * ({ status, summary, stats, comps }). On la transmet quasi telle quelle au LLM,
 * en mappant le statut métier vers le ToolStatus de l'orchestrateur. Aucune valeur
 * inventée : on distingue données présentes / rayon vide / localisation manquante.
 */
function summarizeDvfDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse DVF illisible.' };
  }

  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;
  const stats = root.stats ?? null;
  const comps = Array.isArray(root.comps) ? root.comps : [];

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        // empty = true : le rayon/horizon n'a renvoyé aucune transaction.
        empty: status === 'no_data' || comps.length === 0,
        stats: stats
          ? pick(stats, [
              'transactions_count', 'price_median_eur_m2', 'price_mean_eur_m2',
              'price_q1_eur_m2', 'price_q3_eur_m2', 'evolution_pct', 'surface_mean_m2',
            ])
          : null,
        comparables: comps.slice(0, 10).map((c) =>
          pick(c, ['date', 'price_m2', 'surface_m2', 'type_local', 'distance_m', 'commune', 'adresse']),
        ),
      },
    };
  }

  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Localisation insuffisante pour interroger le DVF (ni coordonnées ni commune INSEE).",
    };
  }

  // status === 'error' (ou inconnu)
  return { status: 'error', message: summary ?? root.error ?? 'Erreur DVF.' };
}

/** PLU (fonction dédiée, repli) : on ne renvoie JAMAIS le règlement complet. */
function summarizePlu(raw: unknown): Record<string, unknown> {
  // TODO[contrat-plu]: aligner ces clés sur la vraie réponse de COPILOT_FN_PLU.
  const summary = pick(raw, [
    'zone', 'zone_libelle', 'libelle',
    'hauteur_max', 'hauteur_max_m',
    'emprise_max', 'ces', 'coefficient_emprise_sol',
    'recul_voie', 'recul_limites_separatives',
    'stationnement', 'espaces_verts',
  ]);
  const servitudes = (raw as Record<string, unknown>)?.servitudes;
  if (Array.isArray(servitudes)) {
    summary.servitudes = servitudes.slice(0, 8).map((s) =>
      typeof s === 'string' ? s : pick(s, ['code', 'libelle', 'type'])
    );
    if (servitudes.length > 8) summary.servitudes_tronquees = servitudes.length - 8;
  }
  return summary;
}

/**
 * PLU (depuis le contexte parser, ctx.plu) : résumé compact pour le LLM.
 * Lit en priorité le format résolu (plu_ruleset_v1) avec repli générique.
 * N'invente jamais : distingue 3 états d'OAP (présente / absente / non analysée).
 */
function summarizePluContext(plu: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!plu) return { note: 'Aucune donnée PLU dans le contexte.' };

  const out: Record<string, unknown> = {
    zone_code: plu.zone_code ?? null,
    zone_libelle: plu.zone_libelle ?? null,
    source: plu.source ?? 'plu-parser',
  };

  // Règles : format résolu (plu_ruleset_v1) prioritaire, avec repli générique.
  const rs = plu.ruleset as Record<string, any> | undefined;
  if (rs) {
    const hauteur = rs.hauteur ?? {};
    const ces     = rs.ces ?? rs.emprise_sol ?? {};
    const reculs  = rs.reculs ?? {};
    const stat    = rs.stationnement ?? {};
    const pt      = rs.pleine_terre ?? {};
    const cos     = rs.cos ?? rs.densite ?? {};
    out.regles = {
      hauteur_max_m:              hauteur.max_m ?? hauteur.hauteur_max_m ?? hauteur.hauteur_egout_m ?? null,
      hauteur_faitage_m:          hauteur.faitage_m ?? hauteur.hauteur_faitage_m ?? null,
      emprise_sol_max_ratio:      ces.max_ratio ?? ces.emprise_sol_max ?? null,
      recul_voirie_m:             reculs.voirie?.min_m ?? null,
      recul_limites_m:            reculs.limites_separatives?.min_m ?? null,
      stationnement_par_logement: stat.par_logement ?? stat.places_par_logement ?? null,
      pleine_terre_ratio_min:     pt.ratio_min ?? (pt.min_pct != null ? pt.min_pct / 100 : null),
      cos_max:                    cos.max ?? cos.cos_max ?? null,
    };
    if (rs.completeness) out.regles_completeness = rs.completeness;
  } else if (plu.zone_code) {
    out.note_regles = 'Zone connue, mais règlement détaillé non extrait.';
  }

  // OAP : trois états distincts, jamais inventés.
  const oap = plu.oap as Record<string, any> | undefined;
  if (oap && oap.has_oap === true) {
    const constraints = oap.constraints
      ? Object.fromEntries(
          Object.entries(oap.constraints)
            .filter(([, v]) => Array.isArray(v) && (v as unknown[]).length > 0)
            .map(([k, v]) => [k, (v as string[]).slice(0, 6)]),
        )
      : undefined;
    out.oap = {
      has_oap: true,
      name: oap.oap_name ?? null,
      type: oap.oap_type ?? null,
      summary: oap.summary ?? null,
      constraints,
      promoter_impacts: Array.isArray(oap.promoter_impacts) ? oap.promoter_impacts.slice(0, 8) : undefined,
      permit_risks: Array.isArray(oap.permit_risks) ? oap.permit_risks.slice(0, 8) : undefined,
      source_document: oap.source_document ?? null,
    };
  } else if (oap) {
    out.oap = {
      has_oap: false,
      applicability_status: oap.oap_applicability_status ?? 'not_found_in_analyzed_documents',
      note: "Aucune OAP exploitable dans le règlement analysé (peut exister dans une pièce séparée du dossier PLU).",
    };
  } else {
    out.oap = { analysee: false, note: "L'OAP n'a pas encore été analysée pour cette parcelle." };
  }

  return out;
}

/**
 * Géorisques (risk-study v1.x) : résumé compact aligné sur le contrat réel.
 * ⚠️ CONVENTION DE SCORE : 100 = zone sûre, 0 = risque maximal (score de SÉCURITÉ).
 *    On l'annonce explicitement au LLM pour éviter toute inversion d'interprétation.
 *    Le champ "level"/"niveau_risque" reste un niveau de RISQUE (fort = mauvais).
 */
function summarizeRisks(raw: unknown): Record<string, unknown> {
  const root = raw as Record<string, any>;
  if (!root || root.success === false) {
    return { note: 'Réponse Géorisques vide ou en erreur', error: root?.error ?? null };
  }

  const meta = root.meta ?? {};
  const scores = root.scores ?? {};
  const data = root.data ?? {};
  const categories = Array.isArray(root.categories) ? root.categories : [];
  const insights = Array.isArray(root.insights) ? root.insights : [];

  const out: Record<string, unknown> = {
    // Rappel impératif de la convention, sinon le LLM inverse le sens.
    convention_score: "Score de SÉCURITÉ : 100 = zone très sûre, 0 = risque maximal. Un score élevé est BON.",
    commune_nom: meta.commune_nom ?? null,
    commune_insee: meta.commune_insee ?? null,
    departement: meta.departement ?? null,
    scores_securite: {
      global:         scores.global ?? null,
      naturels:       scores.naturels ?? null,
      technologiques: scores.technologiques ?? null,
      pollution:      scores.pollution ?? null,
      geotechniques:  scores.geotechniques ?? null,
    },
    // risk-study v1.1.0 — indicateur de confiance. Un score de sécurité null
    // signifie NON MESURÉ, jamais « sûr » ni « risqué ».
    confiance: {
      criteres_mesures: scores.criteres_mesures ?? null,
      criteres_total: scores.criteres_total ?? null,
      coverage: scores.coverage ?? null,
      categories_non_mesurees: Array.isArray(scores.categories_non_mesurees) ? scores.categories_non_mesurees : [],
      poids_effectifs: scores.poids_effectifs ?? null,
    },
  };

  // Niveau de RISQUE par catégorie (level = niveau de risque, pas de sécurité).
  if (categories.length > 0) {
    out.categories = categories.map((c: any) => ({
      nom: c.name ?? null,
      score_securite: c.score ?? null,
      niveau_risque: c.level ?? null,
      coverage: c.coverage ?? null,
      criteres_mesures: c.criteres_mesures ?? null,
      criteres_total: c.criteres_total ?? null,
    }));
  }

  // Faits saillants par risque (compteurs/booléens, pas les tableaux bruts).
  out.faits = {
    inondation: {
      zone_inondable: data.inondation?.zone_inondable ?? null,
      ppri: data.inondation?.ppri ?? null,
      niveau_risque: data.inondation?.risk_level ?? null,
    },
    seisme: {
      zone: data.seisme?.zone ?? null,
      libelle: data.seisme?.libelle ?? null,
      niveau_risque: data.seisme?.risk_level ?? null,
    },
    argiles: {
      niveau_alea: data.argiles?.niveau_alea ?? null,
      niveau_risque: data.argiles?.risk_level ?? null,
    },
    radon: {
      classe: data.radon?.classe_potentiel ?? null,
      libelle: data.radon?.libelle ?? null,
      niveau_risque: data.radon?.risk_level ?? null,
    },
    icpe_seveso: {
      total: data.icpe?.count ?? null,
      tronque: data.icpe?.truncated ?? false,
      coverage: data.icpe?.coverage ?? null,
      seveso_haut: data.icpe?.seveso_haut_count ?? null,
      seveso_bas: data.icpe?.seveso_bas_count ?? null,
      niveau_risque: data.icpe?.risk_level ?? null,
    },
    sites_pollues_sis: {
      count: data.sis?.count ?? null,
      tronque: data.sis?.truncated ?? false,
      coverage: data.sis?.coverage ?? null,
      niveau_risque: data.sis?.risk_level ?? null,
    },
    cavites: {
      count: data.cavites?.count ?? null,
      tronque: data.cavites?.truncated ?? false,
      coverage: data.cavites?.coverage ?? null,
      niveau_risque: data.cavites?.risk_level ?? null,
    },
    mouvements_terrain: {
      count: data.mouvements_terrain?.count ?? null,
      tronque: data.mouvements_terrain?.truncated ?? false,
      coverage: data.mouvements_terrain?.coverage ?? null,
      niveau_risque: data.mouvements_terrain?.risk_level ?? null,
    },
    feux_foret: {
      zone_risque: data.feux_foret?.zone_risque ?? null,
      obligation_debroussaillement: data.feux_foret?.obligation_debroussaillement ?? null,
      niveau_risque: data.feux_foret?.risk_level ?? null,
    },
    catnat_count: data.gaspar?.catnat_count ?? null,
    catnat_tronque: data.gaspar?.catnat_truncated ?? false,
    ppr_count: data.gaspar?.ppr_count ?? null,
    ppr_tronque: data.gaspar?.ppr_truncated ?? false,
    gaspar_coverage: data.gaspar?.coverage ?? null,
  };

  // Les insights sont déjà des phrases synthétiques rédigées : on les garde (limités).
  if (insights.length > 0) {
    out.insights = insights.slice(0, 12).map((i: any) => ({
      type: i.type ?? null,
      categorie: i.category ?? null,
      message: i.message ?? null,
    }));
  }

  return out;
}
/**
 * DPE ADEME (dpe-ademe-v1) : la réponse est DÉJÀ un résumé compact
 * ({ status, summary, stats, items }). On mappe le statut métier vers le
 * ToolStatus de l'orchestrateur. Aucune classe inventée : on distingue
 * données présentes / rien trouvé / localisation manquante.
 */
function summarizeDpeDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse DPE illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats
          ? pick(root.stats, [
              'total', 'distribution_dpe', 'distribution_ges',
              'pire_classe_dpe', 'nb_passoires_fg', 'plus_recent',
            ])
          : null,
        echantillon: Array.isArray(root.items) ? root.items.slice(0, 10) : [],
        avertissement: "Base ADEME non exhaustive : l'absence de DPE ne prouve pas l'absence de diagnostic.",
      },
    };
  }
  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Localisation insuffisante pour interroger la base DPE.",
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur DPE.' };
}

/**
 * Mérimée (patrimoine-merimee-v1) : réponse déjà compacte
 * ({ status, summary, stats, items }). On mappe le statut métier.
 * Le champ stats.dans_perimetre_abf_500m est l'info à impact : projet en
 * périmètre d'abords → avis ABF obligatoire.
 */
function summarizeMerimeeDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Mérimée illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats
          ? pick(root.stats, [
              'total', 'nb_classes', 'nb_inscrits',
              'distance_plus_proche_m', 'dans_perimetre_abf_500m',
            ])
          : null,
        monuments: Array.isArray(root.items) ? root.items.slice(0, 8) : [],
      },
    };
  }
  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Localisation insuffisante pour interroger Mérimée.",
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Mérimée.' };
}

/**
 * BDNB (batiment-bdnb-v1) : réponse déjà compacte { status, summary, stats, items }.
 * Beaucoup de champs BDNB sont null (non renseignés) : on transmet tel quel,
 * le LLM sait dire "non renseigné" sans inventer.
 */
function summarizeBdnbDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse BDNB illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        batiment_principal: Array.isArray(root.items) && root.items[0] ? root.items[0] : null,
        autres_batiments: Array.isArray(root.items) ? root.items.slice(1, 5) : [],
        source: 'BDNB - CSTB',
      },
    };
  }
  if (status === 'no_localization') {
    return { status: 'not_found', message: summary ?? "Localisation insuffisante pour la BDNB." };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur BDNB.' };
}

/**
 * Loyers de référence (loyers-reference-v1) : réponse déjà compacte
 * ({ status, summary, stats, items }). On mappe le statut métier vers le
 * ToolStatus. PLM : stats.is_plm=true → fourchette min/médiane/max entre
 * arrondissements. Aucune valeur inventée.
 */
function summarizeLoyersDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Loyers illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats ?? null,
        // Détail par arrondissement uniquement en cas PLM (Paris/Lyon/Marseille).
        arrondissements: root.stats?.is_plm && Array.isArray(root.items)
          ? root.items.slice(0, 20)
          : undefined,
        source: 'Carte des loyers ANIL/DHUP',
      },
    };
  }
  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Localisation insuffisante pour interroger les loyers de référence.",
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Loyers de référence.' };
}

/**
 * Servitudes d'utilité publique (servitudes-gpu-v1) : réponse déjà compacte
 * ({ status, summary, stats, items }). On mappe le statut métier vers le
 * ToolStatus et on transmet l'avertissement de non-exhaustivité du GPU
 * (une absence de résultat ne prouve pas l'absence de servitude).
 */
function summarizeServitudesDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Servitudes illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats ?? null,
        servitudes: Array.isArray(root.items) ? root.items.slice(0, 30) : [],
        source: "Géoportail de l'Urbanisme via API Carto IGN",
      },
    };
  }
  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Coordonnées précises requises pour interroger les servitudes.",
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Servitudes.' };
}

/**
 * Potentiel solaire (potentiel-solaire-v1, PVGIS) : réponse déjà compacte
 * ({ status, summary, stats, items }). Production SPÉCIFIQUE (par kWc) : le LLM
 * ne doit pas la présenter comme une production absolue sans puissance installée.
 */
function summarizePotentielSolaireDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Potentiel solaire illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats ?? null,
        production_mensuelle: Array.isArray(root.items) ? root.items : [],
        source: 'PVGIS (JRC, Commission européenne)',
      },
    };
  }
  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Coordonnées requises pour estimer le potentiel solaire.",
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Potentiel solaire.' };
}

/**
 * Zonage ABC (zonage-abc-v1) : réponse déjà compacte { status, summary, stats, items }.
 * On mappe le statut métier et on transmet la mise au point Pinel (dispositif clos
 * depuis le 31/12/2024) : le LLM ne doit pas présenter la zone comme ouvrant droit au Pinel.
 */
function summarizeZonageDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Zonage ABC illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats ?? null,
        source: 'Zonage ABC (DHUP / data.gouv)',
      },
    };
  }
  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Localisation insuffisante pour déterminer le zonage ABC.",
    };
  }
  // APRÈS
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Zonage ABC.' };
}

/**
 * Taxes locales (taxes-locales-v1) : réponse déjà compacte { status, summary, stats, items }.
 * On mappe le statut et on transmet les notes métier : TH résidence principale supprimée
 * (le taux TH ne vaut que pour résidences secondaires / logements vacants), majoration THRS
 * possible en zone tendue. Le LLM ne doit pas présenter la TH comme due sur une résidence principale.
 */
function summarizeTaxesDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Taxes locales illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats ?? null,
        source: 'DGFiP — Fiscalité locale des particuliers',
      },
    };
  }
  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Localisation insuffisante pour interroger les taxes locales.",
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Taxes locales.' };
}

/**
 * PPR détaillés (ppr-detail-v1) : réponse déjà compacte { status, summary, stats, items }.
 * Détail par PPR (nom, risque, statut approuvé/prescrit, dates) + test parcelle-dans-périmètre
 * si coordonnées. ⚠️ Ne fournit PAS le zonage rouge/bleue : le LLM ne doit jamais l'inventer,
 * et renvoie au règlement du PPR pour la zone précise.
 */
function summarizePprDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse PPR illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats ?? null,
        ppr: Array.isArray(root.items) ? root.items.slice(0, 20) : [],
        source: 'Géorisques — BD GASPAR',
      },
    };
  }
  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Code INSEE (ou commune) requis pour lister les PPR.",
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur PPR.' };
}

/**
 * Assainissement (assainissement-commune-v1) : réponse compacte { status, summary, stats, items }.
 * Donnée au niveau COMMUNE (collectif/ANC + opérateur). Le LLM ne doit JAMAIS affirmer le régime
 * d'une parcelle précise depuis cette seule donnée : renvoyer au zonage d'assainissement communal.
 */
function summarizeAssainissementDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Assainissement illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats ?? null,
        source: 'SISPEA (services.eaufrance.fr)',
      },
    };
  }
  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Localisation insuffisante pour l'assainissement.",
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Assainissement.' };
}

/**
 * Altimétrie & pente (altimetrie-v1) : réponse compacte { status, summary, stats, items }.
 * Pente ESTIMÉE (échantillonnage RGE Alti), à confirmer par relevé topo pour un projet.
 * Si stats.precision = 'centre_commune', valeurs indicatives : le LLM doit le signaler.
 */
function summarizeAltimetrieDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Altimétrie illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats ?? null,
        source: 'IGN — RGE Alti (Géoplateforme)',
      },
    };
  }
  if (status === 'no_localization') {
    return {
      status: 'not_found',
      message: summary ?? "Coordonnées ou commune requises pour l'altimétrie.",
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Altimétrie.' };
}

/**
 * Classement sonore des voies (bruit-classement-v1) : réponse compacte
 * { status, summary, stats, items }. Classement RÉGLEMENTAIRE (pas des dB
 * mesurés) et GPU non-exhaustif → avertissement transmis au LLM.
 */
function summarizeBruitDedicated(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Classement sonore illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: status === 'no_data',
        stats: root.stats ?? null,
        secteurs: Array.isArray(root.items) ? root.items.slice(0, 15) : [],
        avertissement:
          "Classement RÉGLEMENTAIRE (pas des dB mesurés). Le GPU n'est pas exhaustif : une absence ne prouve pas l'absence de secteur bruit.",
        source: "Classement sonore des voies — Géoportail de l'Urbanisme via API Carto IGN",
      },
    };
  }
  if (status === 'no_localization') {
    return { status: 'not_found', message: summary ?? "Coordonnées ou identifiant cadastral requis pour le classement sonore." };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Classement sonore.' };
}

/**
 * Étude complète de parcelle (etude-parcelle-v1) : bundle multi-sources collecté
 * en parallèle. Le LLM reçoit le résumé de chaque source ET la liste explicite
 * des sources indisponibles → il doit signaler les trous, jamais les combler.
 */
function summarizeEtudeParcelle(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Étude de parcelle illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok' || status === 'no_data') {
    const items = Array.isArray(root.items) ? root.items : [];
    return {
      status: 'ok',
      data: {
        summary,
        precision: root.stats?.precision ?? null,
        parcelle: root.stats?.parcelle ?? null,
        avertissements: root.stats?.avertissements ?? [],
        sources_indisponibles: root.stats?.sources_indisponibles ?? [],
        donnees: items.map((i: any) => ({
          domaine: i.label ?? i.cle,
          statut: i.status,
          resume: i.summary ?? null,
          chiffres: i.stats ?? null,
          motif_indisponibilite: i.motif ?? undefined,
        })),
      },
    };
  }
  if (status === 'no_localization') {
    return { status: 'not_found', message: summary ?? "Identifiant cadastral, coordonnées ou commune requis pour lancer l'étude." };
  }
  return { status: 'error', message: summary ?? 'Erreur Étude de parcelle.' };
}

/**
 * Étude de marché (market-study-investisseur-v1) : contrat { success, meta,
 * core:{dvf,insee,transport,bpe}, scores, scoring_details, insights }.
 * On ne transmet JAMAIS core.dvf.transactions ni les details[] des rubriques
 * BPE : plusieurs Ko inutiles. Scores 0-100, un score élevé est POSITIF.
 */
function summarizeMarketStudy(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const r = raw as Record<string, any>;
  if (!r || typeof r !== 'object') return { status: 'error', message: 'Réponse Étude de marché illisible.' };
  if (r.success !== true) return { status: 'error', message: r.error ?? 'Étude de marché en erreur.' };

  const c = r.core ?? {};
  const dvf = c.dvf ?? null;
  const insee = c.insee ?? null;
  const tr = c.transport ?? null;
  const bpe = c.bpe ?? null;

  return {
    status: 'ok',
    data: {
      convention_scores: 'Scores sur 100 : un score élevé est POSITIF.',
      commune: pick(r.meta ?? {}, ['commune_nom', 'commune_insee', 'departement', 'project_type_label', 'radius_km', 'generated_at']),
      // market-study v1.4.4 — Périmètre réel de CHAQUE source. `radius_km` seul
      // se lisait comme le rayon de toute l'étude, d'où des phrases telles que
      // « scores calculés sur un rayon de 5 km » alors que demande, offre et
      // environnement sont tous communaux.
      perimetres: (r.meta as Record<string, unknown> | undefined)?.perimetres ?? null,
      scores: r.scores ?? null,
      // market-study v1.4.3 — Le pilier nommé « environnement » mesure en
      // réalité les ÉQUIPEMENTS (score BPE + bonus d'équipement). Sans cette
      // précision, un 80/100 se lisait comme « cadre de vie favorable », ce qui
      // n'est pas ce qui a été mesuré.
      lexique_scores: {
        environnement: "ÉQUIPEMENTS ET SERVICES (score BPE + bonus). Ne dit RIEN du cadre de vie, du paysage, du bruit ni des risques — ne l'interprète jamais ainsi. Pour les risques, utilise l'étude de risques ; pour le cadre, aucune donnée n'est disponible ici.",
        demande: "Pression démographique et socio-économique locale.",
        offre: "Liquidité et niveau de prix du marché local (DVF).",
        accessibilite: "Desserte en transports en commun. Écarté du score quand il n'a pas été mesuré.",
      },
      explication_scores: r.scoring_details?.explanation ?? null,
      // market-study v1.4.0 : le DVF est désormais filtré sur la COMMUNE, plus
      // sur un rayon. `meta.radius_km` ne s'applique donc PLUS à ce bloc — il ne
      // concerne que BPE et transport. Sans ce garde-fou, le modèle réutilisait
      // « rayon 5 km » pour un chiffre communal.
      marche_dvf: dvf ? {
        ...pick(dvf, ['nb_transactions', 'prix_m2_median', 'prix_m2_moyen', 'prix_m2_min', 'prix_m2_max', 'evolution_prix_pct', 'coverage']),
        perimetre: dvf.perimetre ?? null,
        perimetre_label: dvf.perimetre_label ?? null,
        nb_transactions_plafonne: dvf.nb_transactions_plafonne ?? false,
        avertissement_perimetre:
          "Ce bloc DVF est filtré sur le PÉRIMÈTRE indiqué ci-dessus (commune, ou département en repli) — PAS sur meta.radius_km. "
          + "N'écris jamais « rayon X km » pour ces chiffres : cite le périmètre réel. "
          + "Si perimetre = 'departement', dis explicitement qu'aucune médiane communale n'était calculable et que le chiffre est départemental. "
          + "Si nb_transactions_plafonne est vrai, écris « au moins N », jamais « N ». "
          + "Les bornes min/max sont écrêtées à 500 et 25 000 €/m² par le filtrage : ne présente pas la fourchette comme l'amplitude réelle du marché.",
      } : null,
      demographie_insee: insee ? pick(insee, [
        'population', 'densite', 'revenu_median', 'taux_chomage', 'taux_pauvrete',
        'pct_logements_vacants', 'pct_locataires', 'pct_75_plus', 'pct_etudiants',
        'revenu_source', 'coverage',
      ]) : null,
      transport: tr ? {
        ...pick(tr, ['score', 'nearest_stop_m', 'has_metro_train', 'has_tram', 'is_urban', 'coverage']),
        // v1.4.0 : l'urbanité vient de la grille de densité INSEE quand
        // is_urban_source = 'insee'. Interdiction d'écrire « commune rurale »
        // sur la seule base de la densité ou de la population.
        is_urban_source: tr.is_urban_source ?? null,
        is_urban_label: tr.is_urban_label ?? null,
        avertissement_urbanite:
          "N'écris « commune rurale » QUE si is_urban est false. Si is_urban_source = 'insee', is_urban_label est la catégorie officielle "
          + "de la grille de densité INSEE (ex. « Ceintures urbaines ») : cite-la telle quelle. Une faible densité ou une faible population "
          + "ne suffisent PAS à qualifier une commune de rurale. Un score de transport absent signale une desserte non mesurée, pas une absence de desserte.",
        arrets_proches: Array.isArray(tr.stops) ? tr.stops.slice(0, 5) : [],
      } : null,
      // market-study v1.4.2 : `bpe_quality` porte le périmètre réel (la COMMUNE,
      // filtre depcom — jamais un rayon) et la fiabilité des zéros. Sans ce
      // relais, le modèle écrivait « 0 pharmacie dans le rayon de 5 km » là où
      // l'extrait BPE ne compte que 18 lignes et ne contient simplement aucun
      // code D301 : une lacune de source présentée comme un constat de terrain.
      equipements_bpe: bpe ? {
        ...pick(bpe, ['total_equipements', 'score', 'nb_ecoles', 'nb_pharmacies', 'nb_supermarches', 'nb_universites', 'coverage']),
        qualite: bpe.bpe_quality ?? null,
      } : null,
      constats: Array.isArray(r.insights) ? r.insights.slice(0, 10).map((i: any) => ({ type: i.type, categorie: i.category, message: i.message })) : [],
      avertissements: r.warnings ?? [],
      source: 'market-study Mimmoza (DVF, INSEE, BPE, Overpass)',
    },
  };
}

/**
 * Coûts de construction (couts-construction-v1) : { status, summary, stats }.
 * On relaie la décomposition du calcul telle quelle — c'est elle qui permet au
 * LLM d'EXPLIQUER le montant sans le recalculer. Le statut 'no_data' n'est PAS
 * une erreur : il signale une typologie hors barème (EHPAD, clinique…), et
 * cette information doit remonter à l'utilisateur telle quelle.
 */
function summarizeCoutsConstruction(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Coûts de construction illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok') {
    return {
      status: 'ok',
      data: {
        summary,
        stats: root.stats ?? null,
        source: 'barème Mimmoza (hypothèse) indexé sur BT01 INSEE',
      },
    };
  }
  if (status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: true,
        stats: root.stats ?? null,
        consigne:
          "Le barème ne couvre pas cette demande. Dis-le explicitement, n'approxime avec " +
          "aucune autre typologie, et renvoie vers un économiste de la construction.",
      },
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Coûts de construction.' };
}

/**
 * Coûts de rénovation (couts-renovation-v1) : { status, summary, stats, source }.
 * Calcul DÉTERMINISTE côté fonction — on relaie la décomposition telle quelle,
 * le LLM restitue sans recalculer. 'no_data' n'est PAS une erreur : rien de
 * chiffrable (aucun poste reconnu ni niveau_global+surface) — info à remonter.
 */
function summarizeCoutsRenovation(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Coûts de rénovation illisible.' };
  }
  const status = String(root.status ?? '');
  const summary = typeof root.summary === 'string' ? root.summary : null;

  if (status === 'ok') {
    return {
      status: 'ok',
      data: {
        summary,
        stats: root.stats ?? null,
        source: root.source ?? 'barème rénovation Mimmoza',
      },
    };
  }
  if (status === 'no_data') {
    return {
      status: 'ok',
      data: {
        summary,
        empty: true,
        stats: root.stats ?? null,
        consigne:
          "Aucun poste chiffrable au barème. Déduis les postes à reprendre (avec " +
          "quantités) depuis les photos, ou fournis un niveau_global + surface_habitable_m2, " +
          "puis rappelle l'outil. N'invente aucun montant.",
      },
    };
  }
  return { status: 'error', message: summary ?? root.error ?? 'Erreur Coûts de rénovation.' };
}

/**
 * Sitadel (sitadel-commune-v1) : dynamique de construction à la maille COMMUNE
 * { status, summary, stats }. no_data = commune peu couverte / pas de permis sur
 * la période (PAS une erreur). Maille commune uniquement : pas de projet voisin
 * géolocalisé à la parcelle — le LLM ne doit pas le laisser croire.
 */
function summarizeSitadel(
  raw: unknown,
  meta?: { rayonKm?: number; periodMonths?: number; precision?: 'parcelle' | 'centre_commune' },
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse Sitadel illisible.' };
  }

  const items = Array.isArray(root.items) ? (root.items as Record<string, any>[]) : null;
  if (!items) {
    return { status: 'error', message: "Format Sitadel inattendu (champ 'items' manquant)." };
  }

  const total = typeof root.total === 'number' ? root.total : items.length;

  // Agrégats par type + logements.
  const parType: Record<string, number> = { PC: 0, PA: 0, PD: 0, DP: 0 };
  let logementsTotal = 0;
  let plusGros = 0;
  for (const it of items) {
    const t = String(it.typeAutorisation ?? '').toUpperCase();
    if (t in parType) parType[t]++;
    const n = typeof it.nombreLogements === 'number' ? it.nombreLogements : 0;
    logementsTotal += n;
    if (n > plusGros) plusGros = n;
  }

  const compact = (it: Record<string, any>) => ({
    date: it.dateDepot ? String(it.dateDepot).slice(0, 10) : null,
    distance_km: typeof it.distanceKm === 'number' ? Math.round(it.distanceKm * 100) / 100 : null,
    type: it.typeAutorisation ?? null,
    nature: it.natureProjet ?? null,
    logements: it.nombreLogements ?? null,
    surface_m2: it.surface ?? null,
    commune: it.commune ?? null,
    adresse: it.adresse ?? null,
  });

  const parDate = [...items].sort((a, b) =>
    String(b.dateDepot ?? '').localeCompare(String(a.dateDepot ?? '')));
  const parDistance = [...items].sort((a, b) =>
    (typeof a.distanceKm === 'number' ? a.distanceKm : 1e9) -
    (typeof b.distanceKm === 'number' ? b.distanceKm : 1e9));

  const notices = Array.isArray(root.notices) ? root.notices.slice(0, 4) : [];

  const analyses = items.length;
  const tronque = total > analyses;

  return {
    status: 'ok',
    data: {
      empty: analyses === 0,
      // total_dans_rayon = tous les permis du rayon ; analyses = ceux réellement
      // agrégés ci-dessous (plafonné par limit). Les deux DIFFÈRENT si tronqué.
      total_dans_rayon: total,
      analyses,
      affichage_tronque: tronque,
      rayon_km: meta?.rayonKm ?? null,
      periode_mois: meta?.periodMonths ?? null,
      precision: meta?.precision ?? null,
      // ⚠️ ces agrégats portent sur les {analyses} permis analysés, PAS sur total_dans_rayon.
      par_type_sur_analyses: parType,
      logements_crees_sur_analyses: logementsTotal,
      plus_gros_projet_logements: plusGros,
      plus_recents: parDate.slice(0, 5).map(compact),
      plus_proches: parDistance.slice(0, 5).map(compact),
      notices,
      source: 'Sit@del2 / data.gouv (via Koumoul Data Fair)',
      note_comptage: tronque
        ? `${total} permis dans le rayon, dont seuls les ${analyses} plus récents sont agrégés ici (répartition par type, logements, top listes). NE présente PAS cette répartition comme couvrant les ${total}.`
        : `${analyses} permis dans le rayon, tous agrégés.`,
      avertissement:
        "Permis géolocalisés à la date de dépôt en mairie ; les tout derniers mois peuvent être incomplets. " +
        (meta?.precision === 'centre_commune'
          ? "Recherche centrée sur le centre de la commune (aucune parcelle localisée) : le rayon peut couvrir plusieurs communes."
          : "Recherche centrée sur la parcelle : les permis listés sont ceux du voisinage réel dans le rayon."),
    },
  };
}

/**
 * SIRENE / RNE (etablissements-sirene-v1) : la réponse est DÉJÀ un résumé
 * compact ({ status, summary, stats, items }). On mappe le statut métier vers
 * le ToolStatus de l'orchestrateur, sans rien recalculer ni inventer.
 */
function summarizeSirene(
  raw: unknown,
  meta?: { rayonKm?: number; precision?: 'parcelle' | 'centre_commune' },
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse SIRENE illisible.' };
  }

  const st = String(root.status ?? '');
  if (st === 'error') {
    return { status: 'error', message: str(root.summary) ?? 'Erreur SIRENE.' };
  }
  if (st === 'no_localization') {
    return {
      status: 'not_found',
      message: str(root.summary) ?? "Aucune localisation exploitable pour interroger SIRENE.",
    };
  }

  const stats = (root.stats ?? {}) as Record<string, any>;
  const items = Array.isArray(root.items) ? (root.items as Record<string, any>[]) : [];

  return {
    status: 'ok',
    data: {
      empty: st === 'no_data' || items.length === 0,
      summary: str(root.summary) ?? null,
      total_dans_rayon: stats.total_dans_rayon ?? null,
      analyses: stats.analyses ?? items.length,
      affichage_tronque: stats.affichage_tronque ?? null,
      rayon_km: stats.rayon_km ?? meta?.rayonKm ?? null,
      precision: meta?.precision ?? null,
      par_section_naf: stats.par_section ?? null,
      creations_recentes_12m: stats.creations_recentes_12m ?? null,
      etablissements_proches: items.slice(0, 15),
      source: str(root.source) ?? 'API Recherche d\'entreprises (DINUM) — Sirene + RNE',
      avertissement:
        (str(root.avertissement) ?? '') +
        " SIRENE recense des établissements IMMATRICULÉS : ce n'est ni un permis, ni un projet futur, " +
        "et le code NAF ne préjuge pas de l'usage réel du local. " +
        (meta?.precision === 'centre_commune'
          ? "Recherche centrée sur le centre de la commune (aucune parcelle localisée) : les distances sont relatives à ce centre."
          : "Recherche centrée sur la parcelle : les distances sont celles du voisinage réel."),
    },
  };
}


/**
 * BPE (bpe-proxy) : contrat legacy { success, items[], count }. On agrège par
 * catégorie et on isole l'équipement le PLUS PROCHE de chaque catégorie —
 * c'est ce qui répond à « y a-t-il une école / un médecin / une supérette ? ».
 */
function summarizeBpe(
  raw: unknown,
  meta?: { rayonM?: number; precision?: 'parcelle' | 'centre_commune' },
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse BPE illisible.' };
  }
  if (root.success === false) {
    // bpe-proxy dépend d'une API externe (OpenDataSoft) qui tombe par
    // intermittence (échec DNS constaté le 04/08). On remonte l'échec tel quel :
    // surtout ne pas laisser croire qu'il n'y a aucun équipement.
    return {
      status: 'error',
      message: "Le service Équipements (BPE) n'a pas répondu : " +
        (str(root.details) ?? str(root.error) ?? 'erreur inconnue') +
        ". Ne conclus PAS à une absence d'équipement, dis que la donnée est momentanément indisponible.",
    };
  }

  const items = Array.isArray(root.items) ? (root.items as Record<string, any>[]) : [];
  if (items.length === 0) {
    return {
      status: 'ok',
      data: {
        empty: true,
        rayon_m: meta?.rayonM ?? null,
        precision: meta?.precision ?? null,
        source: 'Base Permanente des Équipements (INSEE) via OpenDataSoft',
      },
    };
  }

  const parCategorie: Record<string, number> = {};
  const plusProcheParCategorie: Record<string, unknown> = {};
  for (const it of items) {
    const cat = str(it.category) ?? 'Non catégorisé';
    parCategorie[cat] = (parCategorie[cat] ?? 0) + 1;
    const d = typeof it.distance_m === 'number' ? it.distance_m : null;
    const prev = plusProcheParCategorie[cat] as Record<string, any> | undefined;
    if (d !== null && (!prev || d < (prev.distance_m ?? 1e12))) {
      plusProcheParCategorie[cat] = {
        nom: str(it.nom),
        type_code: str(it.type_code),
        commune: str(it.commune),
        distance_m: d,
      };
    }
  }

  const proches = [...items]
    .filter((it) => typeof it.distance_m === 'number')
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, 15)
    .map((it) => ({
      nom: str(it.nom),
      categorie: str(it.category),
      type_code: str(it.type_code),
      commune: str(it.commune),
      distance_m: it.distance_m,
    }));

  return {
    status: 'ok',
    data: {
      empty: false,
      total_dans_rayon: typeof root.count === 'number' ? root.count : items.length,
      rayon_m: meta?.rayonM ?? null,
      precision: meta?.precision ?? null,
      par_categorie: parCategorie,
      plus_proche_par_categorie: plusProcheParCategorie,
      equipements_les_plus_proches: proches,
      source: 'Base Permanente des Équipements (INSEE) via OpenDataSoft',
      avertissement:
        "La BPE est un inventaire annuel : une ouverture ou une fermeture récente peut ne pas y figurer. " +
        "Les distances sont à vol d'oiseau depuis le point de recherche, pas des temps de trajet." +
        (meta?.precision === 'centre_commune'
          ? " Recherche centrée sur le centre de la commune (aucune parcelle localisée) : les distances sont relatives à ce centre."
          : ''),
    },
  };
}

/**
 * SRU / logement social (besoin-logements-sociaux) : objet PLAT métier, pas de
 * contrat compact. On mappe vers un objet lisible et on baken le sens métier
 * (commune carencée = obligation renforcée + majoration de prélèvement).
 */
function summarizeSru(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse logement social illisible.' };
  }
  if (root.success === false || root.error) {
    return { status: 'error', message: str(root.error) ?? 'Erreur du service logement social.' };
  }
  if (!str(root.codeInsee) && !str(root.commune)) {
    return { status: 'not_found', message: "Commune non résolue pour l'inventaire SRU." };
  }

  const statut = str(root.statutSRU);
  const carencee = !!statut && /caren/i.test(statut);
  const soumise = !!statut && !/non soumise/i.test(statut);

  return {
    status: 'ok',
    data: {
      commune: str(root.commune),
      code_insee: str(root.codeInsee),
      code_postal: str(root.codePostal),
      statut_sru: statut,
      commune_carencee: carencee,
      taux_lls_pct: root.tauxLLS ?? null,
      objectif_sru_pct: root.objectifSRU ?? null,
      deficit_logements_estime: root.deficitEstime ?? null,
      mode_calcul_deficit: str(root.deficitMode),
      logements_sociaux: root.logementsSociaux ?? null,
      demandes_en_attente: root.demandesEnAttente ?? null,
      attributions_annuelles: root.attributionsAnnuelles ?? null,
      tension_theorique: root.tensionTheorique ?? null,
      qualite_donnee: str(root.dataStatus),
      donnee_partielle: root.scorePartiel === true,
      sources: Array.isArray(root.sources) ? root.sources : [],
      avertissements: Array.isArray(root.warnings) ? root.warnings : [],
      lecture_metier: soumise
        ? (carencee
          ? "Commune CARENCÉE au titre de la loi SRU : le préfet peut préempter, majorer le prélèvement et imposer une part de logements sociaux dans les opérations. Sur un projet de logements, une servitude de mixité sociale ou une part LLS imposée est HAUTEMENT probable — à confirmer au règlement du PLU et en mairie."
          : "Commune soumise à l'obligation SRU : une part de logements sociaux peut être imposée dans les opérations, selon le PLU et les orientations locales. À confirmer en mairie.")
        : "Statut SRU à confirmer : ne présume ni obligation ni exonération de logements sociaux.",
      avertissement:
        "Inventaire SRU annuel + RPLS/SNE : les chiffres sont communaux, jamais parcellaires. " +
        "La part de LLS réellement imposée à une opération dépend du règlement du PLU (servitude de mixité sociale) — vérifier en mairie.",
    },
  };
}

/**
 * Contexte commune (contexte-commune-v1) : déjà au contrat compact. Source
 * Wikidata/Wikipédia = ÉDITORIAL, jamais réglementaire.
 * ⚠️ stats.commune peut sortir null (constaté sur 64065) alors que stats.article
 * porte le nom : on expose les deux et on interdit toute déduction de mémoire.
 */
function summarizeContexteCommune(
  raw: unknown,
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse contexte commune illisible.' };
  }
  const st = String(root.status ?? '');
  if (st === 'error') return { status: 'error', message: str(root.summary) ?? 'Erreur contexte commune.' };
  if (st === 'no_localization') {
    return { status: 'not_found', message: str(root.summary) ?? 'Commune non résolue.' };
  }

  const stats = (root.stats ?? {}) as Record<string, any>;
  return {
    status: 'ok',
    data: {
      empty: st === 'no_data',
      summary: str(root.summary) ?? null,
      code_insee: str(stats.code_insee),
      // stats.commune sort parfois null : le nom fiable est celui de l'article.
      nom_commune: str(stats.commune) ?? str(stats.article),
      description: str(stats.description),
      intro: str(stats.intro),
      rubriques: stats.rubriques ?? null,
      url: str(stats.url),
      source: 'Wikidata / Wikipédia (fr)',
      avertissement:
        "Contexte ÉDITORIAL (encyclopédique), pas une source réglementaire ni statistique : " +
        "n'en tire aucune règle d'urbanisme, aucun chiffre de marché et aucune donnée de risque. " +
        "N'utilise que le nom de commune renvoyé ici : ne traduis JAMAIS un code INSEE en nom de commune de mémoire.",
    },
  };
}

/**
 * GPU (gpu-parcelle-v1) : déjà au contrat compact. On sépare la vue « zonage »
 * de la vue « prescriptions » pour que chaque outil renvoie un payload court.
 */
function summarizeGpu(
  raw: unknown,
  vue: 'zonage' | 'prescriptions',
): { status: ToolStatus; data?: Record<string, unknown>; message?: string } {
  const root = raw as Record<string, any>;
  if (!root || typeof root !== 'object') {
    return { status: 'error', message: 'Réponse GPU illisible.' };
  }
  const st = String(root.status ?? '');
  if (st === 'error') {
    return {
      status: 'error',
      message: (str(root.summary) ?? 'Erreur GPU.') +
        " Ne conclus RIEN sur la constructibilité tant que la couche n'a pas répondu.",
    };
  }
  if (st === 'no_localization') {
    return {
      status: 'not_found',
      message: str(root.summary) ??
        "Localisation précise requise : le zonage d'urbanisme se lit au point, pas à la commune.",
    };
  }

  const stats = (root.stats ?? {}) as Record<string, any>;
  const items = (root.items ?? {}) as Record<string, any>;
  const commun = {
    summary: str(root.summary) ?? null,
    commune: stats.commune ?? null,
    couches_en_echec: stats.couches_en_echec ?? [],
    source: str(root.source) ?? "Géoportail de l'urbanisme via API Carto (IGN)",
    avertissement: str(root.avertissement) ?? null,
  };

  if (vue === 'zonage') {
    return {
      status: 'ok',
      data: {
        ...commun,
        empty: (stats.nb_zones ?? 0) === 0,
        zone_principale: stats.zone_principale ?? null,
        zones: Array.isArray(items.zones) ? items.zones : [],
      },
    };
  }

  return {
    status: 'ok',
    data: {
      ...commun,
      empty: (stats.nb_prescriptions ?? 0) === 0 && (stats.nb_informations ?? 0) === 0,
      nb_prescriptions: stats.nb_prescriptions ?? 0,
      nb_prescriptions_impactantes: stats.nb_prescriptions_impactantes ?? 0,
      prescriptions: Array.isArray(items.prescriptions) ? items.prescriptions : [],
      informations: Array.isArray(items.informations) ? items.informations : [],
    },
  };
}

// =============================================================
// TOOL DEFINITIONS (exposées au LLM) — LOT 4 + LOT 5
// =============================================================

const TOOLS: ToolDef[] = [
  {
    name: 'get_etude_parcelle',
    description:
      "ÉTUDE COMPLÈTE d'une parcelle en un seul appel : interroge simultanément toutes les " +
      "sources Mimmoza (loyers de référence, zonage ABC, fiscalité locale, assainissement, " +
      "altitude/pente, servitudes d'utilité publique, potentiel solaire, RISQUES naturels et " +
      "technologiques, transactions comparables DVF, classement sonore des voies, contexte " +
      "territorial) et renvoie un bundle structuré. ⚠️ CET OUTIL SE SUFFIT À LUI-MÊME : " +
      "n'appelle JAMAIS get_risks_georisques, get_dvf_comparables ni get_classement_sonore " +
      "après lui, leurs données sont déjà dans le bundle et un appel supplémentaire consomme " +
      "le tour de synthèse (l'utilisateur ne reçoit alors aucun rapport). " +
      "À APPELER EN PRIORITÉ dès que l'utilisateur demande une étude, un rapport, " +
      "une synthèse, un bilan, une analyse complète, une faisabilité ou « tout ce que tu sais » " +
      "sur une parcelle ou un terrain — plutôt que d'enchaîner les outils un par un. " +
      "Chaque source est indépendante : certaines peuvent être indisponibles, elles sont alors " +
      "listées dans sources_indisponibles. Signale systématiquement ces trous et n'extrapole " +
      "JAMAIS une donnée manquante. Si precision = 'centre_commune', les données géométriques " +
      "(pente, servitudes, solaire) sont indicatives et non parcellaires : dis-le.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id: { type: 'string' },
        cadastral_ref: { type: 'string', description: "Identifiant cadastral IDU (14 caractères) — le plus précis." },
        lat: { type: 'number' },
        lng: { type: 'number' },
        code_insee: { type: 'string', description: 'Repli commune si pas de parcelle.' },
        commune: { type: 'string', description: 'Repli commune.' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_etude_marche',
    description:
      "ÉTUDE DE MARCHÉ LOCAL autour d'une adresse, d'une commune ou d'un point : " +
      "prix DVF (médiane, fourchette, évolution), démographie et revenus INSEE (population, " +
      "densité, revenu médian, chômage, pauvreté, vacance des logements, part de locataires), " +
      "desserte en transports (arrêts proches, métro/tram) et équipements BPE (écoles, santé, " +
      "commerces), plus des scores de demande, d'offre, d'accessibilité et d'environnement. " +
      "À appeler pour toute question sur l'ATTRACTIVITÉ, la DEMANDE, la LIQUIDITÉ ou le " +
      "PROFIL SOCIO-ÉCONOMIQUE d'un secteur, et pour situer un bien dans son marché. " +
      "Complémentaire de compute_smartscore, qui note la qualité d'un emplacement selon la " +
      "méthode propre à Mimmoza : ces deux outils mesurent des choses différentes, ne les " +
      "présente jamais comme contradictoires. N'invente aucun chiffre absent de la réponse. " +
      "Si l'utilisateur donne un IDENTIFIANT DE PARCELLE (ex. 64065000AI0002), transmets-le " +
      "dans parcel_id : c'est la localisation la plus précise, elle centre l'analyse sur le " +
      "terrain et évite un géocodage par nom de commune qui viserait le centre-bourg. " +
      "Tu n'as alors besoin d'aucune autre information de localisation.",
    input_schema: {
      type: 'object',
      properties: {
        // v1.9 — parcel_id et commune_insee n'étaient PAS déclarés : le modèle
        // ne pouvait pas les transmettre même en les connaissant, et l'outil
        // répondait « Indisponible » sur une question ne fournissant qu'un IDU.
        parcel_id: {
          type: 'string',
          description: "Identifiant cadastral (IDU) à 14 caractères, ex. « 64065000AI0002 ». Localisation la PLUS PRÉCISE : à privilégier dès qu'il est connu.",
        },
        commune_insee: {
          type: 'string',
          description: "Code INSEE à 5 chiffres de la commune, ex. « 64065 ». Utile si la parcelle est inconnue.",
        },
        address: { type: 'string', description: 'Adresse complète (prioritaire si pas de parcelle ni de coordonnées).' },
        city: { type: 'string' },
        zip_code: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        project_type: { type: 'string', description: "Type de projet étudié (défaut « logement »)." },
        rayon_km: { type: 'number', description: "Rayon d'analyse en km (défaut 5). Ne s'applique PAS au bloc DVF, filtré sur la commune." },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_parcel_summary',
    description:
      "Résumé synthétique d'une parcelle Mimmoza (adresse, commune, surface, zone PLU). " +
      "À appeler dès qu'une question porte sur une parcelle précise.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id: { type: 'string', description: 'Identifiant de la parcelle (optionnel si déjà dans le contexte)' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_parcel_plu',
    description:
      "RÈGLES D'URBANISME CHIFFRÉES de la parcelle (zone, hauteur max, emprise au sol, reculs, " +
      "stationnement, pleine terre, COS) ainsi que l'OAP si elle a été analysée. Source primaire : " +
      "le parser PLU de Mimmoza, le règlement étant importé manuellement sur la page Foncier. " +
      "C'est l'outil à utiliser pour expliquer, synthétiser ou contrôler la constructibilité DÉTAILLÉE. " +
      "⚠️ REPLI AUTOMATIQUE : si aucun règlement n'a été importé, cet outil bascule seul sur le " +
      "Géoportail de l'urbanisme et renvoie alors le ZONAGE SEUL, avec niveau_de_detail='zonage_seul' " +
      "et regle_ecrite_disponible=false. Dans ce cas tu disposes du code de zone et de son type " +
      "(U/AU/A/N) mais d'AUCUNE règle chiffrée : ne déduis ni hauteur, ni emprise, ni recul, ni " +
      "stationnement du seul code de zone, et dis à l'utilisateur qu'il doit importer le PDF du " +
      "règlement sur la page Foncier pour les obtenir. " +
      "N'invente jamais : si une donnée manque, signale-le explicitement.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id: { type: 'string' },
        cadastral_ref: { type: 'string' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_dvf_comparables',
    description:
      "Récupère les transactions comparables (DVF) autour de la parcelle : prix médian au m², " +
      "fourchette Q1-Q3, et transactions récentes. Utile pour estimer une valeur ou un prix de sortie.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id: { type: 'string' },
        commune: { type: 'string' },
        rayon_m: { type: 'number', description: 'Rayon de recherche en mètres (défaut 2000)' },
        horizon_months: { type: 'number', description: 'Profondeur historique en mois (défaut 24)' },
        type_local: { type: 'string', description: 'Filtre type de bien (Appartement, Maison, Local)' },
      },
    },
    available_in_modes: ['advanced', 'report'],
  },
  {
    name: 'get_risks_georisques',
    description:
      "Récupère les risques naturels et technologiques (Géorisques) de la parcelle : inondation, " +
      "séisme, retrait-gonflement des argiles, radon, sites pollués (SIS), ICPE/SEVESO, cavités, " +
      "mouvements de terrain, feux de forêt. Renvoie des scores de SÉCURITÉ (100 = zone sûre, " +
      "0 = risque maximal) + un niveau de risque par catégorie + des constats rédigés (insights). " +
      "À utiliser pour évaluer l'exposition aux risques d'un terrain.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        code_insee: { type: 'string' },
        rayon_m: { type: 'number', description: 'Rayon de recherche ICPE/cavités/MVT en mètres (défaut 5000)' },
      },
    },
    available_in_modes: ['advanced', 'report'],
  },
  {
    name: 'get_dpe_ademe',
    description:
      "Récupère les diagnostics de performance énergétique (DPE, classes A à G) enregistrés " +
      "à l'ADEME autour d'une adresse : distribution des classes énergie et climat, DPE le plus " +
      "récent, nombre de passoires (F/G). Utile pour évaluer l'état énergétique du bâti et le " +
      "gisement de rénovation (Réhabilitation, Promotion). ⚠️ La base ADEME ne couvre pas tout le " +
      "parc : l'absence de DPE ne signifie pas absence de diagnostic. N'invente jamais de classe.",
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "Adresse complète (optionnel si présente dans le contexte)" },
        lat: { type: 'number' },
        lng: { type: 'number' },
        code_postal: { type: 'string' },
        radius_m: { type: 'number', description: 'Rayon de recherche en mètres (défaut 150)' },
      },
    },
    available_in_modes: ['advanced', 'report'],
  },
  {
    name: 'get_monuments_historiques',
    description:
      "Recherche les monuments historiques (base Mérimée) autour d'une parcelle : édifices " +
      "classés ou inscrits, distance, nature et date de protection. CRITIQUE pour la promotion : " +
      "un monument à moins de 500 m place le terrain dans le périmètre des abords, soumettant tout " +
      "projet à l'avis de l'Architecte des Bâtiments de France (ABF). À appeler pour toute question " +
      "sur le patrimoine, les contraintes ABF, les abords ou la faisabilité réglementaire d'un " +
      "terrain. Nécessite des coordonnées (lat/lng). N'invente jamais un monument ni un périmètre. " +
      "⚠️ RÉGIME DE L'AVIS ABF — ne l'improvise JAMAIS, et n'écris JAMAIS que l'avis serait simple " +
      "pour un monument inscrit et conforme pour un monument classé : c'est FAUX. Dans les abords " +
      "d'un monument historique, l'avis de l'ABF est CONFORME (contraignant) que le monument soit " +
      "classé OU inscrit — la distinction classé/inscrit qualifie la protection du MONUMENT, pas la " +
      "nature de l'avis sur les travaux alentour. Les rares cas où la loi ELAN (2018) ramène cet " +
      "avis à un avis simple sont limitativement énumérés (antennes-relais de radiotéléphonie, " +
      "travaux de traitement de l'insalubrité ou du péril) : ne les élargis pas. Le périmètre peut " +
      "aussi avoir été remplacé par un périmètre délimité des abords (PDA), différent du rayon de " +
      "500 m — signale cette possibilité et renvoie à l'UDAP du département. Au-delà de ces " +
      "éléments, tu n'énonces AUCUNE règle de procédure d'urbanisme que les données ne portent pas.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        code_insee: { type: 'string' },
        radius_m: { type: 'number', description: 'Rayon de recherche en mètres (défaut 500, périmètre abords)' },
      },
    },
    available_in_modes: ['advanced', 'report'],
  },
  {
    name: 'get_batiment_bdnb',
    description:
      "Récupère la carte d'identité d'un bâtiment via la BDNB (Base de Données Nationale des " +
      "Bâtiments, CSTB) : année de construction, usage, matériaux (murs, toit), nombre de niveaux " +
      "et de logements, hauteur, emprise au sol, classe DPE représentative, aléa argile, potentiel " +
      "solaire. Essentiel pour la Réhabilitation (connaître le bâti avant de rénover) et la " +
      "Promotion. Recherche par adresse. ⚠️ Beaucoup de champs peuvent être non renseignés : un " +
      "champ vide ne signifie pas absence de la caractéristique. Cite la source « BDNB - CSTB ».",
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "Adresse complète du bâtiment" },
        code_insee: { type: 'string', description: 'Code INSEE commune (repli si pas d\'adresse)' },
      },
    },
    available_in_modes: ['advanced', 'report'],
  },
  {
    name: 'compute_smartscore',
    description:
      "Calcule le SmartScore Mimmoza de la parcelle (score global /100 + piliers : marché, " +
      "transport, écoles, santé, environnement, démographie, DPE…). À utiliser pour évaluer " +
      "la qualité globale d'un emplacement et son potentiel.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        commune: { type: 'string' },
        type_local: { type: 'string', description: 'Type de bien (Appartement, Maison, Local)' },
      },
    },
    available_in_modes: ['advanced', 'report'],
  },
  // ─── LOT 5 : analyse rapide marché annonce (investisseur / marchand) ──────
  {
    name: 'get_quick_market_insight',
    description:
      "Récupère l'analyse rapide marché d'une annonce immobilière : prix/m² du bien, prix/m² " +
      "marché de référence, écart marché (décote ou surcote en %), position de marché, profondeur " +
      "du marché (nombre d'annonces comparables), niveau de confiance de l'analyse et verdict rapide. " +
      "À appeler pour toute question d'un investisseur ou marchand sur le prix, la décote, " +
      "l'opportunité ou la liquidité d'une annonce.",
    input_schema: {
      type: 'object',
      properties: {
        listing_id: {
          type: 'string',
          description: "Identifiant interne de l'annonce dans Mimmoza (prioritaire).",
        },
        url: {
          type: 'string',
          description: "URL publique de l'annonce (priorité 2 si listing_id absent).",
        },
        city: {
          type: 'string',
          description: "Ville de l'annonce (utilisée en combinaison avec zip_code, price, surface).",
        },
        zip_code: {
          type: 'string',
          description: "Code postal de l'annonce.",
        },
        price: {
          type: 'number',
          description: "Prix de l'annonce en euros.",
        },
        surface: {
          type: 'number',
          description: "Surface en m².",
        },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  // ─── recherche_biens : recherche multi-critères dans la base d'annonces ──
  {
    name: 'recherche_biens',
    description:
      "Recherche des biens immobiliers dans la base d'annonces Mimmoza selon des critères " +
      "(ville, code postal, budget min/max, surface min/max, uniquement les biens en décote). " +
      "Renvoie une liste d'annonces correspondantes triées par écart marché (meilleures décotes " +
      "d'abord), avec prix, surface, prix/m² et position marché. À appeler quand l'utilisateur " +
      "CHERCHE des biens (« trouve-moi… », « quels biens à X sous Y € », « des appartements décotés »). " +
      "Ne renvoie que ce que la base contient ; n'invente aucune annonce.",
    input_schema: {
      type: 'object',
      properties: {
        city:          { type: 'string', description: "Ville (recherche partielle)." },
        zip_code:      { type: 'string', description: 'Code postal (exact).' },
        price_min:     { type: 'number', description: 'Budget minimum en euros.' },
        price_max:     { type: 'number', description: 'Budget maximum en euros.' },
        surface_min:   { type: 'number', description: 'Surface minimale en m².' },
        surface_max:   { type: 'number', description: 'Surface maximale en m².' },
       only_discounts:{ type: 'boolean', description: 'Ne retourner que les biens en décote marché.' },
        limit:         { type: 'number', description: 'Nombre max de résultats (défaut 10, max 25).' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_loyers_reference',
    description:
      "Récupère le loyer de référence médian (€/m²/mois) d'une commune à partir de la Carte des " +
      "loyers ANIL/DHUP : médiane globale + ventilation appartement / maison, nombre d'observations " +
      "et millésime. Pour Paris, Lyon et Marseille (pas de valeur commune globale), renvoie une " +
      "fourchette min–médiane–max entre arrondissements (et accepte un arrondissement précis via " +
      "son code INSEE ou son code postal). Utile pour estimer un loyer de marché, une rentabilité " +
      "locative ou un potentiel locatif. N'invente jamais : si la commune n'est pas couverte, signale-le.",
    input_schema: {
      type: 'object',
      properties: {
        code_insee: { type: 'string', description: "Code INSEE de la commune ou de l'arrondissement (prioritaire)." },
        commune:    { type: 'string', description: 'Nom de la commune (repli si code_insee absent).' },
        zip_code:   { type: 'string', description: "Code postal (repli ; un CP d'arrondissement cible cet arrondissement)." },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_servitudes',
    description:
      "Récupère les servitudes d'utilité publique (SUP) qui grèvent une parcelle via le Géoportail " +
      "de l'Urbanisme (API Carto IGN) : monuments historiques (abords), sites, PPRn/PPRt, captages " +
      "d'eau, canalisations gaz/électricité/hydrocarbures, télécom, alignement de voirie, aéronautique… " +
      "Renvoie la liste des servitudes intersectant l'emprise de la parcelle, regroupées par catégorie. " +
      "CRITIQUE pour la constructibilité et la faisabilité d'un projet. Nécessite des coordonnées " +
      "précises (lat/lng) : ne fonctionne pas au niveau commune. ⚠️ Le GPU n'est PAS exhaustif : une " +
      "absence de résultat ne prouve JAMAIS l'absence de servitude — signale-le systématiquement et " +
      "n'invente aucune servitude.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        cadastral_ref: { type: 'string', description: 'Référence cadastrale (optionnelle, améliore la précision).' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },

  {
    name: 'get_potentiel_solaire',
    description:
      "Estime le potentiel photovoltaïque d'une parcelle via PVGIS (Commission européenne) : " +
      "production spécifique (kWh par kWc installé et par an), irradiation annuelle dans le plan " +
      "(kWh/m²/an), inclinaison et azimut optimaux, répartition mensuelle. Utile pour évaluer " +
      "l'autoconsommation, un projet PV en toiture ou l'attrait énergétique d'un bien. " +
      "⚠️ Production SPÉCIFIQUE (par kWc) : pour une production absolue, la multiplier par la " +
      "puissance installée. PVGIS ne modélise pas l'ombrage propre à la toiture (estimation de " +
      "référence, pas un relevé par pan de toit). Nécessite une localisation (lat/lng, sinon centre commune).",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        commune: { type: 'string' },
        code_insee: { type: 'string' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_zonage_abc',
    description:
      "Donne la zone de tension d'une commune dans le zonage ABC (Abis, A, B1, B2, C), " +
      "source DHUP/data.gouv à jour de l'arrêté du 23/06/2026. ⚠️ Le dispositif Pinel a pris fin " +
      "le 31/12/2024 : ce zonage n'ouvre PLUS droit au Pinel pour un nouvel investissement. Il reste " +
      "la référence pour Loc'Avantages, PTZ, LLI, Denormandie, PSLA/PLS/BRS et les plafonds de " +
      "loyers/ressources. À utiliser pour situer la tension du marché local et l'éligibilité aux " +
      "dispositifs actuels. N'invente jamais une zone : si la commune n'est pas trouvée, signale-le.",
    input_schema: {
      type: 'object',
      properties: {
        code_insee: { type: 'string', description: 'Code INSEE de la commune (prioritaire).' },
        commune:    { type: 'string', description: 'Nom de la commune (repli).' },
        zip_code:   { type: 'string', description: 'Code postal (repli).' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_taxes_locales',
    description:
      "Donne les taux de fiscalité directe locale VOTÉS d'une commune (source DGFiP, data.economie.gouv) : " +
      "taxe foncière sur les propriétés bâties (TFB) — la plus utile en immobilier —, taxe foncière " +
      "non bâtie (TFNB), taxe d'habitation (TH), majoration THRS et TEOM. ⚠️ La TH sur la résidence " +
      "principale est SUPPRIMÉE depuis 2023 : le taux TH ne concerne que les résidences secondaires " +
      "(THRS) et les logements vacants (THLV). Utile pour estimer les charges d'un investisseur, le " +
      "coût de portage d'un marchand, ou comparer la pression fiscale entre communes. N'invente jamais " +
      "un taux : si la commune n'est pas trouvée, signale-le.",
    input_schema: {
      type: 'object',
      properties: {
        code_insee: { type: 'string', description: 'Code INSEE de la commune (prioritaire).' },
        commune:    { type: 'string', description: 'Nom de la commune (repli).' },
        zip_code:   { type: 'string', description: 'Code postal (repli).' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_ppr_detail',
    description:
      "Détaille les Plans de Prévention des Risques (PPRN/PPRT/PPRM) d'une commune via l'API " +
      "Géorisques (BD GASPAR) : nom du PPR, type de risque, statut APPROUVÉ (opposable, vaut " +
      "servitude, annexé au PLU) ou PRESCRIT (sursis à statuer possible), dates. Si des coordonnées " +
      "(lat/lng) sont fournies, teste si la parcelle est réellement DANS le périmètre du PPR — plus " +
      "précis que « la commune est concernée » de get_risks_georisques. ⚠️ Ne fournit PAS le zonage " +
      "réglementaire interne (zone rouge/bleue) ni son règlement : ces données ne sont pas en API " +
      "nationale. N'invente JAMAIS une couleur de zone ; renvoie au règlement du PPR (Géorisques/DDT).",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id:  { type: 'string' },
        code_insee: { type: 'string', description: 'Code INSEE de la commune (prioritaire).' },
        commune:    { type: 'string', description: 'Nom de la commune (repli).' },
        zip_code:   { type: 'string', description: 'Code postal (repli).' },
        lat:        { type: 'number', description: 'Latitude parcelle (active le test dans-périmètre).' },
        lng:        { type: 'number', description: 'Longitude parcelle (active le test dans-périmètre).' },
      },
    },
    available_in_modes: ['advanced', 'report'],
  },
  {
    name: 'get_assainissement',
    description:
      "Indique, au niveau COMMUNE, la présence d'un service d'assainissement COLLECTIF (raccordement " +
      "au réseau possible) et/ou NON COLLECTIF (ANC/SPANC), avec l'opérateur (source SISPEA). Utile " +
      "pour anticiper le mode d'assainissement d'un projet et ses coûts. ⚠️ Donnée COMMUNALE : le " +
      "zonage à la parcelle (collectif vs non collectif) n'existe pas en national. Si le collectif " +
      "est présent, une parcelle donnée peut malgré tout être en zone non collective — ne l'affirme " +
      "JAMAIS à la parcelle depuis cette donnée, renvoie au zonage d'assainissement communal / mairie. " +
      "Si le collectif est absent, un ANC (fosse) est à prévoir.",
    input_schema: {
      type: 'object',
      properties: {
        code_insee: { type: 'string', description: 'Code INSEE de la commune (prioritaire).' },
        commune:    { type: 'string', description: 'Nom de la commune (repli).' },
        zip_code:   { type: 'string', description: 'Code postal (repli).' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_altimetrie',
    description:
      "Donne l'altitude et une estimation de la PENTE d'une parcelle via le RGE Alti de l'IGN " +
      "(échantillonnage local). Renvoie altitude (m), pente (% et degrés) et une classe qualitative " +
      "(plat / faible / modérée / forte / très forte). Indicateur clé de faisabilité : terrassement, " +
      "VRD, accès, surcoûts. Nécessite des coordonnées (lat/lng) pour une mesure à la parcelle ; sinon " +
      "mesure indicative au centre de la commune (le préciser). Pente ESTIMÉE, à confirmer par relevé " +
      "topographique pour un projet — ne pas la présenter comme une donnée topo officielle.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id:  { type: 'string' },
        lat:        { type: 'number' },
        lng:        { type: 'number' },
        code_insee: { type: 'string', description: 'Repli si pas de coordonnées (centre commune).' },
        commune:    { type: 'string', description: 'Repli si pas de coordonnées (centre commune).' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_classement_sonore',
    description:
      "Indique si une parcelle est dans un SECTEUR AFFECTÉ PAR LE BRUIT au titre du classement sonore " +
      "des infrastructures de transport terrestre (routes, voies ferrées), via le Géoportail de " +
      "l'Urbanisme (API Carto IGN). Renvoie la présence de secteur(s), la catégorie la plus sévère " +
      "(1 = la plus bruyante, secteur 300 m ; 5 = 10 m) et la largeur. Dans ces secteurs, tout bâtiment " +
      "sensible neuf (logement, école, santé, hôtel) doit présenter une isolation acoustique renforcée " +
      "— impact direct de coût et de faisabilité (promotion, réhabilitation). Nécessite une localisation " +
      "précise (lat/lng ou identifiant cadastral) : ne fonctionne pas au niveau commune. ⚠️ Classement " +
      "RÉGLEMENTAIRE, pas des décibels mesurés ; et le GPU n'est pas exhaustif : une absence ne prouve " +
      "PAS l'absence de classement — signale-le et n'invente jamais un secteur ni une catégorie. " +
      "Le classement sonore est le plus souvent porté par un ARRÊTÉ PRÉFECTORAL annexé au PLU (fréquemment " +
      "un PDF non géométrique, donc absent de cette API) : quand aucun secteur ne remonte (empty/no_data), " +
      "ne conclus PAS à l'absence de classement — renvoie vers les annexes du PLU et l'arrêté de classement " +
      "sonore en préfecture (ou en mairie) pour une réponse définitive.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id: { type: 'string' },
        cadastral_ref: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_couts_construction',
    description:
      "Donne le COÛT DE CONSTRUCTION NEUVE au m² de surface de plancher, issu du barème " +
      "interne Mimmoza, ajusté de la tension du marché local (zonage ABC) et réindexé sur " +
      "l'index BT01 de l'INSEE. À appeler dès qu'une question porte sur le coût, le budget " +
      "ou le prix de construction d'un projet neuf (« combien coûterait de construire… », " +
      "« quel budget pour X m² »). Renvoie le coût au m², une fourchette, le montant total si " +
      "une surface est fournie, et la DÉCOMPOSITION complète du calcul. " +
      "⚠️ CE BARÈME EST UNE HYPOTHÈSE MIMMOZA, pas une donnée de marché sourcée : présente " +
      "toujours le montant comme un ordre de grandeur à confirmer par devis, et cite " +
      "« [source : barème Mimmoza, indexé BT01 INSEE] ». Montants HT, hors foncier, honoraires, " +
      "VRD, taxes d'urbanisme et aléas — dis-le. " +
      "⚠️ TYPOLOGIES COUVERTES UNIQUEMENT : maison individuelle, petit collectif (R+2), " +
      "collectif (R+4), tertiaire. Un EHPAD, une clinique, un hôtel ou une école NE SONT PAS " +
      "couverts : si l'outil renvoie « empty », dis-le franchement et renvoie vers un " +
      "économiste de la construction — n'approxime JAMAIS avec 'tertiaire'.",
    input_schema: {
      type: 'object',
      properties: {
        typologie: { type: 'string', description: "maison_individuelle | collectif_r2 | collectif_r4 | tertiaire" },
        gamme: { type: 'string', description: "economique | standard | premium (défaut standard)" },
        surface_sdp: { type: 'number', description: "Surface de plancher en m² (pour obtenir un montant total)" },
        zone_abc: { type: 'string', description: "Abis | A | B1 | B2 | C (sinon résolue depuis la commune)" },
        code_insee: { type: 'string' },
        commune: { type: 'string' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_couts_renovation',
    description:
      "Donne le COÛT DES TRAVAUX DE RÉNOVATION d'un bien EXISTANT (distinct de la construction " +
      "neuve = get_couts_construction), barème interne Mimmoza, poste par poste. CALCUL " +
      "DÉTERMINISTE côté fonction : TU lis l'état sur les photos (ou la description), tu en " +
      "déduis les postes à reprendre et leurs quantités, tu les transmets ici, la fonction " +
      "applique les ratios et renvoie la décomposition chiffrée — que tu RESTITUES sans la " +
      "recalculer. Deux modes : (A) poste par poste via 'postes' [recommandé] ; (B) à défaut, " +
      "'niveau_global' + 'surface_habitable_m2' pour un forfait global. Clés de postes reconnues " +
      "(unité entre parenthèses) : cuisine, salle_de_bains, wc, chauffage_pac, cuve_fioul, " +
      "assainissement (forfait) ; electricite, plomberie (€/m² habitable) ; sols, peinture, " +
      "isolation_combles, isolation_murs_iti (€/m²) ; toiture (€/m² toiture) ; ravalement " +
      "(€/m² façade) ; menuiseries (par ouverture). niveau_global ∈ {rafraichissement, " +
      "partielle, moyenne, lourde, complete}. gamme ∈ {economique, standard, premium} " +
      "(défaut standard). restructuration=true pour provisionner la maîtrise d'œuvre (8-12 %). " +
      "Donnée manquante (surface d'une pièce, gamme) → pose une hypothèse explicite et " +
      "transmets-la quand même : ne bloque JAMAIS le chiffrage. ⚠️ Montants HT, ordres de " +
      "grandeur à confirmer par devis, hors désamiantage/plomb et aléas structurels non " +
      "visibles ; TVA rénovation (5,5/10/20 %) à ajouter. Cite « [source: barème rénovation Mimmoza] ».",
    input_schema: {
      type: 'object',
      properties: {
        surface_habitable_m2: { type: 'number', description: "Surface habitable en m² (repli mode global + postes au m² habitable)." },
        gamme: { type: 'string', description: "economique | standard | premium (défaut standard)." },
        alea_pct: { type: 'number', description: "Provision aléas en % (défaut 12, borné 0-30)." },
        restructuration: { type: 'boolean', description: "true = provisionner la maîtrise d'œuvre (8-12 %)." },
        niveau_global: { type: 'string', description: "rafraichissement | partielle | moyenne | lourde | complete — mode forfait global si pas de postes." },
        postes: {
          type: 'array',
          description: "Liste des postes à reprendre, lus sur les photos.",
          items: {
            type: 'object',
            properties: {
              poste: { type: 'string', description: "Clé du catalogue (ex: cuisine, electricite, toiture, menuiseries)." },
              quantite: { type: 'number', description: "Quantité dans l'unité du poste (m², nb d'ouvertures…). Forfait = 1 par défaut." },
              niveau: { type: 'string', description: "Niveau de reprise (libre, indicatif)." },
              hypothese: { type: 'string', description: "Hypothèse retenue si donnée déduite (ex: '[H] surface estimée')." },
            },
            required: ['poste'],
          },
        },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_sitadel',
    description:
      "Liste les PERMIS D'URBANISME RÉCENTS et GÉOLOCALISÉS autour d'un point (permis de construire PC, " +
      "d'aménager PA, de démolir PD, déclarations préalables DP), source Sit@del2 / data.gouv. Recherche " +
      "par RAYON autour de la parcelle ouverte (coordonnées du contexte) ou, à défaut, autour du centre de " +
      "la commune. Renvoie le nombre de permis sur la période, la répartition par type, le total de " +
      "logements créés, le plus gros projet, et les permis les plus RÉCENTS et les plus PROCHES (avec " +
      "distance, date de dépôt, nature, logements, surface, commune). Utile pour la veille concurrentielle " +
      "(promoteur), le dynamisme d'un secteur (investisseur/marchand) et surtout pour repérer un PROJET " +
      "VOISIN (ex. un permis de gros collectif ou une surface commerciale déposés à quelques centaines de " +
      "mètres = signal d'un projet type supermarché ou résidence). ⚠️ Si la parcelle n'est pas localisée " +
      "précisément, la recherche est centrée sur le centre de la commune (champ precision='centre_commune') : " +
      "dis-le, les distances sont alors relatives à ce centre et le rayon peut couvrir des communes voisines. " +
      "Les tout derniers mois peuvent être incomplets (remontée mensuelle). Cite [source: Sit@del2 / data.gouv]. " +
      "total_dans_rayon = nombre total de permis dans le rayon ; par_type_sur_analyses et logements_crees_sur_analyses ne portent QUE sur les permis analysés (les plus récents, plafonnés). Si affichage_tronque=true, dis-le et ne présente jamais la répartition comme couvrant le total. " +
      "⚠️ PÉRIMÈTRE : cet outil ne couvre QUE les permis à usage de LOGEMENT (+ permis d'aménager et de démolir). Il ne renvoie PAS les surfaces de locaux NON RÉSIDENTIELS (commerce, bureaux, industrie, entrepôts…) : tu ne peux donc ni confirmer ni écarter un projet de commerce à partir de ces données, et tu ne dois pas laisser entendre que tu as regardé les commerces. Pour un projet commercial (ex. supermarché), renvoie vers le service urbanisme de la mairie et la CDAC du département. " +
      "N'invente aucun chiffre : si aucun permis (empty), dis-le.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id:     { type: 'string' },
        cadastral_ref: { type: 'string', description: 'Identifiant cadastral IDU (repli localisation).' },
        lat:           { type: 'number', description: 'Latitude du point de recherche (prioritaire, précision parcelle).' },
        lng:           { type: 'number', description: 'Longitude du point de recherche.' },
        code_insee:    { type: 'string', description: 'Code INSEE (repli : centre commune).' },
        commune:       { type: 'string', description: 'Nom de la commune (repli : centre commune).' },
        zip_code:      { type: 'string', description: 'Code postal (repli).' },
        rayon_km:      { type: 'number', description: 'Rayon de recherche en km (défaut 3 à la parcelle, 5 à la commune ; max 25).' },
        periode_mois:  { type: 'number', description: 'Profondeur en mois (défaut 24, max 120).' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_etablissements_proches',
    description:
      "ÉTABLISSEMENTS ET ACTIVITÉS ÉCONOMIQUES autour d'un point (base Sirene + RNE via l'API " +
      "Recherche d'entreprises de la DINUM). Recherche par RAYON autour de la parcelle ouverte " +
      "(coordonnées du contexte) ou, à défaut, autour du centre de la commune. Renvoie le nombre " +
      "d'établissements dans le rayon, la répartition par SECTION NAF (commerce, santé, " +
      "enseignement, industrie, restauration…), le nombre de créations sur les 12 derniers mois, " +
      "et la liste des établissements les plus proches (nom/enseigne, activité, adresse, distance, " +
      "tranche d'effectif, date de création, état actif/fermé). Utile pour qualifier " +
      "l'ENVIRONNEMENT COMMERCIAL et de SERVICES d'un terrain (« y a-t-il un supermarché, une " +
      "école, un médecin à côté ? »), mesurer le dynamisme économique local (créations récentes) " +
      "et détecter l'implantation d'une grande enseigne. " +
      "⚠️ PÉRIMÈTRE : SIRENE recense des établissements DÉJÀ IMMATRICULÉS. Ce n'est ni un permis, " +
      "ni un projet futur : tu ne peux pas en déduire qu'un commerce va ouvrir. Pour un projet " +
      "commercial à venir, renvoie vers le service urbanisme de la mairie et la CDAC. Le code NAF " +
      "décrit l'activité déclarée, pas l'usage réel du local. Un établissement peut être fermé " +
      "(champ etat) : ne le compte pas comme actif. " +
      "⚠️ Si la parcelle n'est pas localisée précisément, la recherche est centrée sur le centre " +
      "de la commune (precision='centre_commune') : dis-le, les distances sont alors relatives à " +
      "ce centre. Cite [source: Sirene / RNE via API Recherche d'entreprises (DINUM)]. " +
      "N'invente aucun établissement : si aucun résultat (empty), dis-le.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id:     { type: 'string' },
        cadastral_ref: { type: 'string', description: 'Identifiant cadastral IDU (repli localisation).' },
        lat:           { type: 'number', description: 'Latitude du point de recherche (prioritaire, précision parcelle).' },
        lng:           { type: 'number', description: 'Longitude du point de recherche.' },
        code_insee:    { type: 'string', description: 'Code INSEE (repli : centre commune).' },
        commune:       { type: 'string', description: 'Nom de la commune (repli : centre commune).' },
        zip_code:      { type: 'string', description: 'Code postal (repli).' },
        rayon_km:      { type: 'number', description: "Rayon de recherche en km (défaut 1 à la parcelle, 2 à la commune ; max 10)." },
        section_naf:   { type: 'string', description: "Filtre optionnel sur une section NAF (lettre A à U ; ex. 'G' = commerce, 'Q' = santé, 'P' = enseignement)." },
        limite:        { type: 'number', description: "Nombre d'établissements détaillés à renvoyer (défaut 15, max 30)." },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_equipements_proches',
    description:
      "ÉQUIPEMENTS ET SERVICES autour d'un point (Base Permanente des Équipements de l'INSEE) : " +
      "écoles et collèges, médecins et pharmacies, commerces alimentaires (supérette, supermarché, " +
      "boulangerie), poste, banque, équipements sportifs, gares et arrêts, restaurants, services " +
      "publics. Recherche par RAYON autour de la parcelle ouverte ou, à défaut, autour du centre de " +
      "la commune. Renvoie le nombre total d'équipements, la répartition par catégorie, " +
      "l'équipement LE PLUS PROCHE de chaque catégorie (avec sa distance) et les 15 équipements les " +
      "plus proches. C'est l'outil à utiliser pour qualifier la COMMODITÉ d'un terrain " +
      "(« y a-t-il une école / un médecin / une supérette à proximité ? ») et l'attractivité " +
      "résidentielle d'un secteur. " +
      "⚠️ La BPE est un inventaire ANNUEL : une ouverture ou une fermeture récente peut manquer. " +
      "Les distances sont à VOL D'OISEAU, jamais des temps de trajet : ne les convertis pas en minutes. " +
      "⚠️ Si l'outil renvoie une erreur, la source externe est momentanément indisponible : dis-le, " +
      "et ne conclus SURTOUT PAS à une absence d'équipement. " +
      "Cite [source: BPE INSEE]. Si aucun équipement (empty), dis-le sans inventer.",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id:     { type: 'string' },
        cadastral_ref: { type: 'string', description: 'Identifiant cadastral IDU (repli localisation).' },
        lat:           { type: 'number', description: 'Latitude du point de recherche (prioritaire, précision parcelle).' },
        lng:           { type: 'number', description: 'Longitude du point de recherche.' },
        code_insee:    { type: 'string', description: 'Code INSEE (repli : centre commune).' },
        commune:       { type: 'string', description: 'Nom de la commune (repli : centre commune).' },
        zip_code:      { type: 'string', description: 'Code postal (repli).' },
        rayon_m:       { type: 'number', description: 'Rayon de recherche en mètres (défaut 1500 à la parcelle, 3000 à la commune ; max 20000).' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_logement_social',
    description:
      "LOGEMENT SOCIAL ET OBLIGATION SRU d'une commune : statut au regard de l'article 55 de la loi " +
      "SRU (soumise / non soumise / CARENCÉE), taux de logements locatifs sociaux, objectif légal " +
      "(20 ou 25 %), déficit estimé en nombre de logements, stock de LLS, et lorsque la donnée SNE " +
      "est disponible, demandes en attente et attributions annuelles (tension locative sociale). " +
      "UTILISE CET OUTIL dès qu'un projet de LOGEMENTS est envisagé sur un terrain : dans une " +
      "commune carencée, une part de logements sociaux imposée (servitude de mixité sociale) est " +
      "hautement probable et change l'équilibre financier de l'opération ; le préfet peut aussi " +
      "préempter et majorer le prélèvement. C'est aussi un indicateur de la demande locative " +
      "abordable pour un investisseur (LLI, BRS, Loc'Avantages). " +
      "⚠️ MAILLE COMMUNALE STRICTE : ces chiffres ne disent RIEN de ce qui sera imposé à une " +
      "parcelle précise — la part de LLS exigible se lit dans le règlement du PLU et se confirme " +
      "en mairie. Ne présente jamais le déficit communal comme une obligation parcellaire. " +
      "Si donnee_partielle vaut true, signale que les données SNE ou RPLS manquent. " +
      "Cite [source: Inventaire SRU / RPLS / SNE].",
    input_schema: {
      type: 'object',
      properties: {
        code_insee: { type: 'string', description: 'Code INSEE de la commune (prioritaire).' },
        commune:    { type: 'string', description: 'Nom de la commune (repli).' },
        zip_code:   { type: 'string', description: 'Code postal (repli).' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_contexte_commune',
    description:
      "CONTEXTE TERRITORIAL ÉDITORIAL d'une commune (Wikidata + Wikipédia) : situation " +
      "géographique, patrimoine, tourisme, transports, histoire. Sert UNIQUEMENT à donner de la " +
      "couleur et du contexte narratif à une analyse (introduction d'un rapport, présentation d'un " +
      "secteur, compréhension d'un territoire qu'on ne connaît pas). " +
      "⚠️ CE N'EST PAS UNE SOURCE RÉGLEMENTAIRE NI STATISTIQUE : n'en tire aucune règle " +
      "d'urbanisme, aucun chiffre de marché, aucun risque, aucune donnée fiscale — pour cela, " +
      "utilise les outils dédiés (get_parcel_plu, get_dvf_comparables, get_risks_georisques, " +
      "get_taxes_locales…). Le contenu est encyclopédique, potentiellement daté et non vérifié. " +
      "⚠️ N'utilise que le nom de commune renvoyé par cet outil : ne traduis JAMAIS un code INSEE " +
      "en nom de commune de mémoire. Cite [source: Wikipédia].",
    input_schema: {
      type: 'object',
      properties: {
        code_insee: { type: 'string', description: 'Code INSEE de la commune (prioritaire).' },
        commune:    { type: 'string', description: 'Nom de la commune (repli).' },
        zip_code:   { type: 'string', description: 'Code postal (repli).' },
      },
    },
    available_in_modes: ['advanced', 'report'],
  },
  {
    name: 'creer_zone_veille',
    description:
      "ACTION — CRÉE une veille IMMOBILIÈRE géographique : une commune, éventuellement avec un " +
      "rayon, sur laquelle l'utilisateur sera alerté (mouvements de marché, biens qui sortent). " +
      "⚠️ AMBIGUÏTÉ À LEVER AVANT TOUT APPEL : « surveiller un secteur » peut vouloir dire DEUX " +
      "choses très différentes chez Mimmoza — une veille IMMOBILIÈRE (biens, marché) ou une veille " +
      "APPELS D'OFFRES (marchés publics, cessions foncières, cf. creer_veille_appels_offres). " +
      "Si l'utilisateur n'a pas dit clairement laquelle, tu lui POSES la question avant d'appeler " +
      "quoi que ce soit. N'appelle cet outil que pour la veille IMMOBILIÈRE, et seulement une fois " +
      "l'intention confirmée. " +
      "⚠️ DEUX TEMPS OBLIGATOIRES. Premier appel SANS `confirmer` : rien n'est écrit, l'outil " +
      "renvoie un APERÇU exact de ce qui serait créé. Tu PRÉSENTES cet aperçu à l'utilisateur et tu " +
      "lui demandes de valider. Second appel avec `confirmer: true` UNIQUEMENT après un accord " +
      "EXPLICITE de sa part dans le message suivant. Ne mets JAMAIS `confirmer: true` au premier " +
      "appel, même si la demande semble claire : une écriture ne doit jamais être l'effet de bord " +
      "d'une question mal comprise. " +
      "Après création, annonce ce qui a été créé et rappelle que la zone peut être désactivée avec " +
      "desactiver_zone_veille.",
    input_schema: {
      type: 'object',
      properties: {
        commune:   { type: 'string', description: "Nom de la commune à surveiller (ou code INSEE dans code_insee)." },
        code_insee:{ type: 'string', description: "Code INSEE de la commune (prioritaire sur le nom)." },
        libelle:   { type: 'string', description: "Nom donné à la veille par l'utilisateur. À défaut, le nom de la commune est utilisé." },
        rayon_m:   { type: 'number', description: "Rayon de surveillance en mètres autour du point (100 à 50000)." },
        lat:       { type: 'number' },
        lng:       { type: 'number' },
        confirmer: { type: 'boolean', description: "true UNIQUEMENT après accord explicite de l'utilisateur sur l'aperçu." },
      },
      // ⚠️ Une zone de veille immobilière est une COMMUNE (+ rayon facultatif).
      //    Elle ne porte NI type de bien, NI fourchette de prix, NI surface, NI
      //    département entier. Si l'utilisateur demande « les appartements du 64 »,
      //    dis-lui ce que cet outil sait faire et ce qu'il ne sait pas faire, au
      //    lieu d'afficher un aperçu contenant des critères qui seront perdus.
      required: ['commune'],
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'creer_watchlist',
    description:
      "ACTION — CRÉE une ou plusieurs WATCHLISTS de biens : des critères de recherche (type de bien, " +
      "fourchette de prix, de surface, score minimal) sur une ou plusieurs COMMUNES. C'est l'outil " +
      "pour « alerte-moi sur les appartements à moins de 300 000 € à Bayonne ». " +
      "⚠️ UNE WATCHLIST = UNE COMMUNE. La table ne connaît ni département, ni région, ni rayon. Si " +
      "l'utilisateur demande « les appartements du 64 » ou « dans les Landes », tu NE peux PAS créer " +
      "une entrée départementale : DIS-LE, et demande-lui quelles communes l'intéressent. Tu peux " +
      "alors en passer plusieurs d'un coup dans `communes` — une watchlist sera créée par commune. " +
      "Ne propose pas toi-même une liste de communes « représentatives » du département : c'est à " +
      "l'utilisateur de choisir son terrain de chasse. " +
      "⚠️ À NE PAS CONFONDRE avec creer_zone_veille (zone géographique immobilière, sans critère de " +
      "bien) ni avec creer_veille_appels_offres (marchés publics). " +
      "Protocole en deux temps : premier appel sans `confirmer` = aperçu de TOUTES les watchlists " +
      "qui seraient créées, aucune écriture ; second appel avec `confirmer: true` après accord.",
    input_schema: {
      type: 'object',
      properties: {
        communes:     { type: 'array', items: { type: 'string' }, description: "Noms de communes (une watchlist par commune)." },
        libelle:      { type: 'string', description: "Nom de la recherche. Le nom de la commune y est ajouté si plusieurs." },
        type_bien:    { type: 'string', description: "Ex. « appartement », « maison », « terrain ». Valeur libre." },
        prix_min:     { type: 'number' },
        prix_max:     { type: 'number' },
        surface_min:  { type: 'number', description: 'En m².' },
        surface_max:  { type: 'number', description: 'En m².' },
        score_min:    { type: 'number', description: "Score d'opportunité minimal (0-100)." },
        confirmer:    { type: 'boolean' },
      },
      required: ['communes'],
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'lister_watchlists',
    description:
      "Liste les watchlists de biens de l'utilisateur (actives par défaut) avec leurs critères. " +
      "À appeler avant d'en créer une (doublon), pour répondre « qu'est-ce que je recherche ? », ou " +
      "pour retrouver un identifiant à désactiver. " +
      "⚠️ NE VOIT NI les zones de veille immobilière, NI les veilles appels d'offres : une réponse " +
      "vide signifie « aucune watchlist », jamais « aucune veille ». Lecture seule.",
    input_schema: {
      type: 'object',
      properties: { inclure_inactives: { type: 'boolean' } },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'desactiver_watchlist',
    description:
      "ACTION — DÉSACTIVE une watchlist de biens (is_active = false), sans la supprimer. " +
      "Protocole en deux temps, identifiant obtenu via lister_watchlists — jamais inventé.",
    input_schema: {
      type: 'object',
      properties: {
        watchlist_id: { type: 'string' },
        confirmer:    { type: 'boolean' },
      },
      required: ['watchlist_id'],
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'creer_veille_appels_offres',
    description:
      "ACTION — CRÉE une veille APPELS D'OFFRES : mémorise des critères de recherche BOAMP " +
      "(départements, catégories, mots-clés) pour que l'utilisateur soit alerté des nouveaux avis. " +
      "À distinguer de creer_zone_veille, qui surveille le MARCHÉ IMMOBILIER : si la demande de " +
      "l'utilisateur est ambiguë (« surveille Bayonne »), POSE-LUI la question avant d'appeler. " +
      "Catégories : `foncier` (cessions de terrains publics, AMI, concessions d'aménagement), " +
      "`travaux` (construction, réhabilitation), `moe` (maîtrise d'œuvre, signal précoce). " +
      "⚠️ Une veille doit avoir une PORTÉE : au moins un département, ou un texte de recherche. " +
      "Sans quoi elle balaierait la France entière à chaque passage et noierait l'utilisateur — la " +
      "base refusera l'insertion. " +
      "⚠️ MÊME PROTOCOLE EN DEUX TEMPS que les autres verbes : premier appel sans `confirmer` = " +
      "aperçu, aucune écriture ; second appel avec `confirmer: true` seulement après accord " +
      "EXPLICITE. Ne mets jamais `confirmer: true` au premier appel.",
    input_schema: {
      type: 'object',
      properties: {
        libelle:      { type: 'string', description: "Nom de la veille (ex. « Foncier public Pays basque »)." },
        departements: { type: 'array', items: { type: 'string' }, description: "Codes département (ex. [\"64\",\"40\"])." },
        categories:   { type: 'array', items: { type: 'string', enum: ['foncier', 'travaux', 'moe'] } },
        texte:        { type: 'string', description: "Mots-clés recherchés dans l'objet de l'avis." },
        frequence:    { type: 'string', enum: ['daily', 'weekly'] },
        confirmer:    { type: 'boolean' },
      },
      required: ['libelle'],
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'desactiver_veille_appels_offres',
    description:
      "ACTION — DÉSACTIVE une veille APPELS D'OFFRES (is_active = false). Réversible : la ligne " +
      "n'est pas supprimée. " +
      "⚠️ NE CONFONDS PAS avec desactiver_zone_veille, qui ne concerne QUE les veilles " +
      "IMMOBILIÈRES et ne verra jamais une veille appels d'offres. " +
      "Protocole en deux temps : premier appel sans `confirmer` = aperçu de la veille visée, " +
      "aucune modification ; second appel avec `confirmer: true` après accord explicite. " +
      "Obtiens l'identifiant via lister_veilles_appels_offres — ne l'invente JAMAIS.",
    input_schema: {
      type: 'object',
      properties: {
        veille_id: { type: 'string', description: "UUID de la veille, via lister_veilles_appels_offres." },
        confirmer: { type: 'boolean' },
      },
      required: ['veille_id'],
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'lister_nouveautes_appels_offres',
    description:
      "NOUVEAUTÉS détectées par les veilles appels d'offres de l'utilisateur depuis le dernier " +
      "passage : avis BOAMP jamais encore signalés, avec l'objet, l'acheteur, la date limite, les " +
      "jours restants et le lien. À appeler pour « quoi de neuf ? », « des nouveautés sur mes " +
      "veilles ? », « qu'est-ce qui est sorti cette semaine ? », ou spontanément en début de " +
      "conversation SI l'utilisateur demande un point de situation. " +
      "Par défaut, seules les nouveautés NON LUES sont renvoyées, les plus urgentes d'abord. " +
      "⚠️ Ces avis ont été captés au moment du passage de la veille : une DATE LIMITE peut avoir " +
      "été franchie depuis. Fie-toi au champ jours_restants recalculé, et signale explicitement " +
      "tout avis dont le délai est dépassé ou inférieur à 3 jours. " +
      "⚠️ Un avis marqué zone_incertaine a été diffusé sur plusieurs départements sans préciser le " +
      "lieu des travaux : dis-le pour ceux-là. " +
      "Le champ lien_markdown contient DÉJÀ un lien complet : colle-le tel quel, seul dans sa cellule, " +
      "sans crochets supplémentaires et sans y accoler la citation [source: BOAMP], qui va dans une " +
      "phrase à part. Après présentation, propose de marquer " +
      "les nouveautés comme lues avec marquer_nouveautes_lues.",
    input_schema: {
      type: 'object',
      properties: {
        inclure_lues: { type: 'boolean', description: "Inclure aussi les nouveautés déjà consultées." },
        limite:       { type: 'number', description: "Nombre maximum d'avis renvoyés (1-50, défaut 20)." },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'marquer_nouveautes_lues',
    description:
      "ACTION — marque comme lues les nouveautés de veille appels d'offres, pour qu'elles ne " +
      "reviennent plus. Sans paramètre, marque TOUTES les nouveautés non lues ; avec `avis_ids`, " +
      "seulement celles-là. Action bénigne et réversible côté produit, mais elle modifie l'état : " +
      "ne l'appelle QUE si l'utilisateur le demande ou accepte ta proposition — jamais " +
      "automatiquement après un affichage.",
    input_schema: {
      type: 'object',
      properties: {
        avis_ids: { type: 'array', items: { type: 'string' }, description: "Identifiants d'avis (champ id renvoyé par lister_nouveautes_appels_offres). Omettre = tout marquer." },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'lister_veilles_appels_offres',
    description:
      "Liste les veilles appels d'offres de l'utilisateur. À appeler avant d'en créer une (doublon) " +
      "ou quand il demande ce qu'il surveille côté marchés publics. Lecture seule.",
    input_schema: {
      type: 'object',
      properties: { inclure_inactives: { type: 'boolean' } },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'lister_zones_veille',
    description:
      "Liste les zones de veille IMMOBILIÈRE de l'utilisateur (actives par défaut). À appeler avant " +
      "de créer une zone pour éviter un doublon, ou pour retrouver l'identifiant d'une zone à " +
      "désactiver. Lecture seule. " +
      "⚠️ CET OUTIL NE VOIT PAS les veilles APPELS D'OFFRES, qui vivent ailleurs " +
      "(lister_veilles_appels_offres). Une réponse vide signifie « aucune veille IMMOBILIÈRE », " +
      "JAMAIS « aucune veille » : ne conclus pas qu'une veille appels d'offres n'existe pas ou n'a " +
      "pas été enregistrée sur la foi de cet outil. Si l'utilisateur demande « tout ce que je " +
      "surveille », appelle LES DEUX outils.",
    input_schema: {
      type: 'object',
      properties: {
        inclure_inactives: { type: 'boolean', description: "Inclure aussi les zones désactivées." },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'desactiver_zone_veille',
    description:
      "ACTION — DÉSACTIVE une zone de veille (is_active = false). Réversible : la ligne n'est pas " +
      "supprimée. Même protocole en deux temps que creer_zone_veille : premier appel sans " +
      "`confirmer` pour l'aperçu, second avec `confirmer: true` après accord explicite. " +
      "Utilise lister_zones_veille pour obtenir l'identifiant : ne l'invente JAMAIS.",
    input_schema: {
      type: 'object',
      properties: {
        zone_id:   { type: 'string', description: "Identifiant (UUID) de la zone, obtenu via lister_zones_veille." },
        confirmer: { type: 'boolean' },
      },
      required: ['zone_id'],
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_appels_offres',
    description:
      "APPELS D'OFFRES PUBLICS ENCORE OUVERTS auxquels un promoteur, un aménageur ou un contractant " +
      "général peut répondre, lus au BOAMP (Bulletin officiel des annonces des marchés publics). " +
      "Renvoie pour chaque avis : l'objet, l'acheteur public, le type de marché, la procédure, la " +
      "DATE LIMITE DE RÉPONSE, le nombre de JOURS RESTANTS et l'URL de l'avis officiel. " +
      "Trois catégories, cumulables via le paramètre `categories` (par défaut les trois) : " +
      "`foncier` = le gisement d'un promoteur (cessions de terrains publics, appels à manifestation " +
      "d'intérêt, concessions d'aménagement, consultations promoteurs, baux emphytéotiques) ; " +
      "`travaux` = marchés de construction, réhabilitation, VRD ; " +
      "`moe` = maîtrise d'œuvre, AMO, études de faisabilité, utile comme SIGNAL PRÉCOCE d'un projet " +
      "public avant qu'il ne sorte en travaux. " +
      "Filtre géographique par `departements` (ex. [\"64\",\"40\"]) — sans ce paramètre la recherche " +
      "porte sur la FRANCE ENTIÈRE. Si l'utilisateur dit « ici », « dans le coin » ou « autour de " +
      "cette parcelle », déduis le département des 2 premiers chiffres du code INSEE du contexte et " +
      "passe-le ; sinon DEMANDE la zone plutôt que de balayer la France entière sans le dire. " +
      "`texte` ajoute une recherche libre dans l'objet (ex. « logements sociaux », « friche »). " +
      "⚠️ COUVERTURE — le BOAMP ne recense PAS toutes les cessions foncières : beaucoup passent par " +
      "les sites des collectivités, des EPF ou des SEM. Le champ géographique de la base est en " +
      "outre lacunaire. Une absence de résultat n'est donc JAMAIS une preuve d'absence " +
      "d'opportunité — dis-le, et propose d'élargir la zone ou de retirer un filtre. " +
      "⚠️ N'invente jamais un avis, un acheteur ni une date limite, et n'affirme pas qu'un candidat " +
      "est éligible : l'éligibilité se lit dans le règlement de consultation. " +
      "Cite [source: BOAMP] et donne l'URL de l'avis pour que l'utilisateur puisse candidater.",
    input_schema: {
      type: 'object',
      properties: {
        departements: {
          type: 'array', items: { type: 'string' },
          description: "Codes département sur 2 caractères (ex. [\"64\",\"40\"], Corse \"2A\"/\"2B\"). Omettre = France entière.",
        },
        categories: {
          type: 'array', items: { type: 'string', enum: ['foncier', 'travaux', 'moe'] },
          description: "Par défaut les trois.",
        },
        texte:     { type: 'string', description: "Recherche libre dans l'objet de l'avis." },
        limite:    { type: 'number', description: "Nombre d'avis renvoyés (1-50, défaut 15)." },
        jours_min: { type: 'number', description: "N'affiche que les avis dont la clôture est à plus de N jours." },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_zonage_plu',
    description:
      "ZONAGE D'URBANISME OPPOSABLE AU POINT, lu directement dans le Géoportail de l'urbanisme " +
      "(source officielle, aucune importation préalable nécessaire) : code de la zone (UA, UD, 1AU, " +
      "A, N…), son libellé long, son TYPE réglementaire (U urbaine / AU à urbaniser / A agricole / " +
      "N naturelle) avec le sens de ce type en matière de constructibilité, la référence du document " +
      "d'urbanisme et du règlement, et sa date de validité. Renvoie aussi deux informations " +
      "structurantes sur la commune : au_rnu (la commune n'a AUCUN document d'urbanisme, elle est au " +
      "Règlement National d'Urbanisme, la constructibilité est alors très restreinte hors parties " +
      "urbanisées) et commune_littorale (la loi Littoral s'applique et PRIME sur le PLU). " +
      "C'EST L'OUTIL À UTILISER EN PREMIER pour toute question de constructibilité d'un terrain " +
      "(« est-ce constructible ? », « en quelle zone suis-je ? », « puis-je construire ici ? »). " +
      "⚠️ IL DONNE LA CONSTRUCTIBILITÉ DE PRINCIPE, PAS LES RÈGLES CHIFFRÉES : hauteur maximale, " +
      "emprise au sol, retraits, stationnement se lisent dans le RÈGLEMENT ÉCRIT — pour cela utilise " +
      "get_parcel_plu (règlement importé sur la page Foncier). N'invente jamais une règle chiffrée à " +
      "partir du seul code de zone. " +
      "⚠️ Le GPU ne contient que ce que la collectivité a numérisé : une absence de zonage n'est PAS " +
      "une preuve d'absence de PLU, et encore moins une preuve de constructibilité. " +
      "⚠️ Exige une localisation PRÉCISE (coordonnées ou parcelle) : un zonage change d'une rue à " +
      "l'autre, il ne se déduit jamais d'un centre de commune — si seule la commune est connue, " +
      "dis-le et ne réponds pas au niveau parcellaire. " +
      "Cite [source: Géoportail de l'urbanisme].",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id:     { type: 'string' },
        cadastral_ref: { type: 'string', description: 'Identifiant cadastral IDU (résolu en centroïde parcelle).' },
        lat:           { type: 'number', description: 'Latitude du point (prioritaire).' },
        lng:           { type: 'number', description: 'Longitude du point.' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'get_prescriptions_urbanisme',
    description:
      "PRESCRIPTIONS ET INFORMATIONS D'URBANISME AU POINT (Géoportail de l'urbanisme) : tout ce que " +
      "le PLU grève ou impose sur ce terrain précis, en plus du zonage — espaces boisés classés, " +
      "emplacements réservés, servitudes de mixité sociale (part de logements sociaux imposée), " +
      "prescriptions de hauteur, règles de stationnement spécifiques, protections patrimoniales ou " +
      "paysagères, reculs et alignements, obligations de végétalisation ou de pleine terre, secteurs " +
      "particuliers. Chaque prescription est renvoyée avec son LIBELLÉ OFFICIEL, sa portée " +
      "(surfacique / linéaire / ponctuelle), ses codes CNIG bruts, et lorsqu'un mot-clé le permet un " +
      "champ enjeu_probable qui explique l'impact opérationnel. " +
      "UTILISE CET OUTIL dès qu'on évalue la FAISABILITÉ RÉELLE d'un projet : c'est ici que se " +
      "cachent les contraintes qui tuent une opération (terrain grevé d'un emplacement réservé, EBC " +
      "inconstructible, part de logement social imposée, hauteur plafonnée). " +
      "⚠️ enjeu_probable est une lecture HEURISTIQUE par mots-clés, pas une interprétation " +
      "juridique : présente-le comme une piste à vérifier au règlement, jamais comme une règle. " +
      "Les codes typepsc/stypepsc sont relayés bruts et ne doivent PAS être décodés de mémoire. " +
      "⚠️ LE DROIT DE PRÉEMPTION (DPU) ET LES ZAD NE FIGURENT PAS dans ces couches : si on te pose la " +
      "question de la préemption, dis explicitement que cette donnée n'est pas publiée au GPU et " +
      "renvoie au service urbanisme de la mairie. Ne conclus JAMAIS à l'absence de préemption. " +
      "⚠️ Une absence de prescription n'est pas une preuve d'absence de contrainte (numérisation " +
      "partielle). Cite [source: Géoportail de l'urbanisme].",
    input_schema: {
      type: 'object',
      properties: {
        parcel_id:     { type: 'string' },
        cadastral_ref: { type: 'string', description: 'Identifiant cadastral IDU (résolu en centroïde parcelle).' },
        lat:           { type: 'number', description: 'Latitude du point (prioritaire).' },
        lng:           { type: 'number', description: 'Longitude du point.' },
        limite:        { type: 'number', description: 'Nombre maximum de prescriptions détaillées (défaut 25, max 40).' },
      },
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },

  // ===========================================================================
  // OUTILS D'ACTION — le copilote pilote la chaîne promoteur.
  //
  // ⚠️  Ces outils N'ÉCRIVENT RIEN ici, contrairement aux verbes ci-dessus qui
  //     écrivent sous l'identité de l'utilisateur. Ils renvoient une
  //     *proposition* que le FRONT exécute avec la session de l'utilisateur :
  //     les écritures passent par RLS, la provenance (vous / l'agent) est
  //     tracée à l'écriture, et une hallucination du modèle ne peut pas
  //     corrompre une étude — au pire elle propose une action refusée.
  //
  //     L'état de la chaîne (étapes prêtes / périmées / bloquées) arrive par le
  //     contexte `promoteur_chain`, pas par un outil : c'est une lecture
  //     systématique, inutile de la laisser à la décision du modèle.
  // ===========================================================================
  {
    name: 'action_ouvrir_page',
    description:
      "ACTION — propose d'OUVRIR une page de l'application. À utiliser quand la réponse utile n'est " +
      "pas un texte mais un écran : l'utilisateur veut voir, saisir ou vérifier quelque chose. Ne " +
      "l'utilise pas pour illustrer un propos — uniquement quand ouvrir la page est l'action " +
      "attendue. La route doit venir de `promoteur_chain.steps[].route` ou être une route connue de " +
      "l'application. Rien n'est écrit : l'utilisateur confirme avant que la page s'ouvre.",
    input_schema: {
      type: 'object',
      properties: {
        route:  { type: 'string', description: "Chemin interne, commençant par '/'." },
        raison: { type: 'string', description: "Pourquoi cette page, en une phrase, pour l'utilisateur." },
      },
      required: ['route', 'raison'],
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'action_creer_operation',
    description:
      "ACTION — propose de CRÉER une opération promoteur (étude) et d'y poser le foncier. À utiliser " +
      "quand l'utilisateur veut étudier un terrain ou monter une opération et qu'aucune opération " +
      "active n'apparaît dans `promoteur_chain`. Renseigne commune_insee et parcel_ids dès que tu " +
      "les connais : sans eux l'étape foncier restera à compléter à la main et rien ne pourra " +
      "s'enchaîner. ⚠️ À NE PAS CONFONDRE avec creer_zone_veille (surveillance d'un secteur) ni " +
      "creer_watchlist (critères de recherche de biens) : ici on ouvre un DOSSIER D'OPÉRATION.",
    input_schema: {
      type: 'object',
      properties: {
        titre:         { type: 'string', description: "Nom de l'opération, court et parlant." },
        commune_insee: { type: 'string', description: 'Code INSEE de la commune.' },
        commune_nom:   { type: 'string' },
        parcel_ids:    { type: 'array', items: { type: 'string' }, description: 'Identifiants cadastraux.' },
        surface_m2:    { type: 'number', description: 'Surface totale du foncier.' },
      },
      required: ['titre'],
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
  {
    name: 'action_lancer_etape',
    description:
      "ACTION — propose de LANCER une étape de la chaîne promoteur (enveloppe, programmation, bilan, " +
      "synthèse…). N'appelle JAMAIS cet outil sur une étape dont `runnable` est false dans " +
      "`promoteur_chain` : explique d'abord ce qui la bloque et propose l'étape amont. Utilise-le " +
      "aussi pour relancer une étape passée en `stale` après modification d'une étape amont. " +
      "⚠️ Le calcul est fait par la PAGE de l'étape, pas par toi : n'annonce jamais un résultat " +
      "avant qu'il existe.",
    input_schema: {
      type: 'object',
      properties: {
        step:   { type: 'string', enum: ['foncier', 'plu', 'marche', 'risques', 'enveloppe', 'programmation', 'bilan', 'synthese'] },
        raison: { type: 'string', description: "Ce que cette étape va produire, en une phrase." },
      },
      required: ['step', 'raison'],
    },
    available_in_modes: ['quick', 'advanced', 'report'],
  },
];

function toolsForMode(mode: CopilotMode): ToolDef[] {
  return TOOLS.filter((t) => t.available_in_modes.includes(mode));
}

// =============================================================
// EXÉCUTION DES TOOLS — retourne toujours un ToolResult normalisé
// =============================================================

// Identite AUTHENTIFIEE, issue du JWT verifie par requireUserId() — jamais de
// ctx.user.id, que le front remplit et qu'un client malveillant peut falsifier.
// authHeader sert a ecrire via getUserClient() : les politiques RLS s'appliquent
// alors normalement, ce que getAdmin() court-circuiterait.
interface AuthCtx { userId: string; authHeader: string }

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: MimmozaContext,
  auth: AuthCtx | null = null,
): Promise<ToolResult> {
  switch (name) {
    case 'creer_zone_veille':        return await toolCreerZoneVeille(input, ctx, auth);
    case 'creer_watchlist':          return await toolCreerWatchlist(input, ctx, auth);
    case 'lister_watchlists':        return await toolListerWatchlists(input, ctx, auth);
    case 'desactiver_watchlist':     return await toolDesactiverWatchlist(input, ctx, auth);
    case 'creer_veille_appels_offres':   return await toolCreerVeilleAo(input, ctx, auth);
    case 'lister_veilles_appels_offres': return await toolListerVeillesAo(input, ctx, auth);
    case 'lister_nouveautes_appels_offres': return await toolNouveautesAo(input, ctx, auth);
    case 'desactiver_veille_appels_offres': return await toolDesactiverVeilleAo(input, ctx, auth);
    case 'marquer_nouveautes_lues':         return await toolMarquerNouveautesLues(input, ctx, auth);
    case 'lister_zones_veille':      return await toolListerZonesVeille(input, ctx, auth);
    case 'desactiver_zone_veille':   return await toolDesactiverZoneVeille(input, ctx, auth);
    case 'get_parcel_summary':       return await toolParcelSummary(input, ctx);
    case 'get_parcel_plu':           return await toolParcelPlu(input, ctx);
    case 'get_dvf_comparables':      return await toolDvfComparables(input, ctx);
    case 'get_risks_georisques':     return await toolRisksGeorisques(input, ctx);
    case 'compute_smartscore':       return await toolSmartScore(input, ctx);
    case 'get_dpe_ademe':            return await toolDpeAdeme(input, ctx);
    case 'get_monuments_historiques': return await toolMonumentsHistoriques(input, ctx);
    case 'get_batiment_bdnb':          return await toolBatimentBdnb(input, ctx);
    case 'get_quick_market_insight': return await toolQuickMarketInsight(input, ctx);
    case 'recherche_biens':          return await toolRechercheBiens(input, ctx);
    case 'get_loyers_reference':     return await toolLoyersReference(input, ctx);
    case 'get_servitudes':           return await toolServitudes(input, ctx);
    case 'get_potentiel_solaire':    return await toolPotentielSolaire(input, ctx);
    case 'get_zonage_abc':           return await toolZonageAbc(input, ctx);
    case 'get_taxes_locales':        return await toolTaxesLocales(input, ctx);
    case 'get_ppr_detail':           return await toolPprDetail(input, ctx);
    case 'get_assainissement':       return await toolAssainissement(input, ctx);
    case 'get_altimetrie':           return await toolAltimetrie(input, ctx);
    case 'get_classement_sonore':    return await toolClassementSonore(input, ctx);
    case 'get_etude_parcelle':       return await toolEtudeParcelle(input, ctx);
    case 'get_etude_marche':         return await toolEtudeMarche(input, ctx);
    case 'get_couts_construction':   return await toolCoutsConstruction(input, ctx);
    case 'get_couts_renovation':     return await toolCoutsRenovation(input, ctx);
    case 'get_sitadel':              return await toolSitadel(input, ctx);
    case 'get_appels_offres':        return await toolAppelsOffres(input, ctx);
    case 'get_etablissements_proches': return await toolEtablissementsProches(input, ctx);
    case 'get_equipements_proches':  return await toolEquipementsProches(input, ctx);
    case 'get_logement_social':      return await toolLogementSocial(input, ctx);
    case 'get_contexte_commune':     return await toolContexteCommune(input, ctx);
    case 'get_zonage_plu':           return await toolZonagePlu(input, ctx);
    case 'get_prescriptions_urbanisme': return await toolPrescriptionsUrbanisme(input, ctx);
    case 'action_ouvrir_page':       return toolActionOuvrirPage(input, ctx);
    case 'action_creer_operation':   return toolActionCreerOperation(input);
    case 'action_lancer_etape':      return toolActionLancerEtape(input, ctx);
    default:
      return { status: 'error', source: 'copilot', message: `Tool inconnu : ${name}` };
  }
}

// =============================================================
// OUTILS D'ACTION — production de propositions, jamais d'écriture
// -------------------------------------------------------------
// Différence assumée avec les VERBES (creer_zone_veille & co.) : les verbes
// écrivent ici, sous l'identité de l'utilisateur, avec le protocole en deux
// temps. Les actions promoteur, elles, ne touchent PAS la base côté serveur —
// elles décrivent une intention que le front exécute avec la session de
// l'utilisateur. C'est ce qui permet au front de savoir si l'écriture vient
// de l'utilisateur ou de l'agent, information impossible à produire ici.
// =============================================================

interface ChainStepCtx {
  step: string;
  label?: string;
  route?: string;
  status?: string;
  blocked_by?: string[];
  runnable?: boolean;
}

/** Repli si la chaîne n'est pas dans le contexte (aucune opération active). */
const STEP_ROUTES: Record<string, string> = {
  foncier:       '/promoteur/foncier',
  plu:           '/promoteur/foncier',
  marche:        '/promoteur/marche',
  risques:       '/promoteur/risques',
  enveloppe:     '/promoteur/implantation-2d',
  programmation: '/promoteur/programmation',
  bilan:         '/promoteur/bilan-promoteur',
  synthese:      '/promoteur/synthese',
};

function readChain(ctx: MimmozaContext): { study_id?: string; steps: ChainStepCtx[] } {
  const raw = (ctx as unknown as Record<string, unknown>).promoteur_chain;
  if (!raw || typeof raw !== 'object') return { steps: [] };
  const o = raw as { study_id?: unknown; steps?: unknown };
  return {
    study_id: typeof o.study_id === 'string' ? o.study_id : undefined,
    steps: Array.isArray(o.steps) ? (o.steps as ChainStepCtx[]) : [],
  };
}

function proposal(action: Record<string, unknown>): ToolResult {
  return { status: 'ok', source: 'copilot', data: { action } };
}

function toolActionOuvrirPage(input: Record<string, unknown>, ctx: MimmozaContext): ToolResult {
  const route = str(input.route) ?? '';
  const raison = str(input.raison) ?? '';
  if (!route.startsWith('/')) {
    return { status: 'error', source: 'copilot', message: 'Route interne invalide.' };
  }
  const known = readChain(ctx).steps.find((s) => s.route === route);
  return proposal({
    kind: 'open_page',
    label: known?.label ? `Ouvrir ${known.label}` : 'Ouvrir la page',
    summary: raison || `Ouvrir ${route}`,
    params: { route },
  });
}

function toolActionCreerOperation(input: Record<string, unknown>): ToolResult {
  const titre = str(input.titre) ?? '';
  if (!titre) return { status: 'error', source: 'copilot', message: 'Titre manquant.' };

  const parcelIds = Array.isArray(input.parcel_ids)
    ? (input.parcel_ids as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const communeNom = str(input.commune_nom);
  const communeInsee = str(input.commune_insee);

  const bits = [`Créer l'opération « ${titre} »`];
  if (communeNom || communeInsee) bits.push(`sur ${communeNom ?? communeInsee}`);
  if (parcelIds.length) {
    bits.push(parcelIds.length === 1 ? `parcelle ${parcelIds[0]}` : `${parcelIds.length} parcelles`);
  }

  return proposal({
    kind: 'create_operation',
    label: 'Créer l’opération',
    summary: `${bits.join(' — ')}.`,
    params: {
      title: titre,
      commune_insee: communeInsee,
      commune_nom: communeNom,
      parcel_ids: parcelIds,
      surface_m2: num(input.surface_m2),
    },
  });
}

function toolActionLancerEtape(input: Record<string, unknown>, ctx: MimmozaContext): ToolResult {
  const step = str(input.step) ?? '';
  const raison = str(input.raison) ?? '';
  if (!STEP_ROUTES[step]) {
    return { status: 'error', source: 'copilot', message: `Étape inconnue : ${step}` };
  }

  const chain = readChain(ctx);
  if (!chain.study_id) {
    return {
      status: 'not_found',
      source: 'copilot',
      message: "Aucune opération active : propose d'abord d'en créer une (action_creer_operation).",
    };
  }

  // Garde-fou serveur : le modèle peut se tromper d'ordre, la chaîne fait foi.
  const known = chain.steps.find((s) => s.step === step);
  if (known && known.runnable === false) {
    const blockers = (known.blocked_by ?? []).join(', ');
    return {
      status: 'error',
      source: 'copilot',
      message: `L'étape « ${step} » est bloquée${blockers ? ` par : ${blockers}` : ''}. `
             + `Traite d'abord ces étapes et explique-le à l'utilisateur.`,
    };
  }

  return proposal({
    kind: 'run_step',
    label: `Lancer ${known?.label ?? step}`,
    summary: raison || `Lancer l'étape ${known?.label ?? step}.`,
    params: {
      step,
      route: known?.route ?? STEP_ROUTES[step],
      study_id: chain.study_id,
    },
  });
}

// ─── get_parcel_summary (fallback contexte si non branché) ────
async function toolParcelSummary(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  const ref = resolveParcelRef(input, ctx);
  if (!hasAnyIdentifier(ref)) {
    return {
      status: 'not_found', source: 'MimmozaContext',
      message: "Aucune parcelle identifiée. Demande à l'utilisateur d'en sélectionner une.",
    };
  }
  if (INTERNAL_FUNCTIONS.parcel) {
    try {
      const raw = await callInternalFunction(INTERNAL_FUNCTIONS.parcel, { ...ref });
      // TODO[contrat-parcel]: aligner les clés sur la vraie réponse.
      const data = pick(raw, [
        'parcel_id', 'cadastral_ref', 'address', 'commune',
        'code_postal', 'code_insee', 'surface_m2', 'surface', 'plu_zone', 'lat', 'lng',
      ]);
      return { status: 'ok', source: INTERNAL_FUNCTIONS.parcel, data };
    } catch (e) {
      return { status: 'error', source: INTERNAL_FUNCTIONS.parcel, message: errMsg(e) };
    }
  }
  // Fallback : on renvoie ce que le contexte connaît (pas d'invention).
  return {
    status: 'ok', source: 'MimmozaContext',
    data: {
      parcel_id: ref.parcel_id ?? null,
      cadastral_ref: ref.cadastral_ref ?? null,
      address: ref.address ?? null,
      commune: ref.commune ?? null,
      code_insee: ref.code_insee ?? null,
      surface_m2: ctx.parcel?.surface_m2 ?? null,
      plu_zone: ctx.parcel?.plu_zone ?? null,
      lat: ref.lat ?? null,
      lng: ref.lng ?? null,
    },
  };
}

// ─── get_parcel_plu : lit le PLU extrait par le parser (contexte), puis fonction dédiée si branchée ──
async function toolParcelPlu(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  // 1) Source de vérité actuelle : le PLU déjà extrait par plu-parser et présent dans le contexte.
  if (ctx.plu && (ctx.plu.zone_code || ctx.plu.ruleset || ctx.plu.oap)) {
    return { status: 'ok', source: 'plu-parser (Mimmoza)', data: summarizePluContext(ctx.plu) };
  }
  // 2) Repli extensible : fonction PLU dédiée (table plu_documents / Storage) si un jour configurée.
  if (INTERNAL_FUNCTIONS.plu) {
    const ref = resolveParcelRef(input, ctx);
    if (!hasAnyIdentifier(ref)) {
      return { status: 'not_found', source: 'PLU', message: 'Aucune parcelle identifiée.' };
    }
    try {
      const raw = await callInternalFunction(INTERNAL_FUNCTIONS.plu, { ...ref });
      return { status: 'ok', source: INTERNAL_FUNCTIONS.plu, data: summarizePlu(raw) };
    } catch (e) {
      return { status: 'error', source: INTERNAL_FUNCTIONS.plu, message: errMsg(e) };
    }
  }
  // 3) REPLI AUTOMATIQUE sur le Géoportail de l'urbanisme (gpu-parcelle-v1).
  //    Aucun règlement importé ≠ aucune donnée d'urbanisme : le GPU donne le
  //    zonage opposable au point. On le renvoie en disant EXPLICITEMENT que le
  //    niveau de détail est dégradé — zonage seul, aucune règle chiffrée.
  if (INTERNAL_FUNCTIONS.gpu) {
    const gpu = await toolZonagePlu(input, ctx);
    if (gpu.status === 'ok' && gpu.data && (gpu.data as any).empty !== true) {
      return {
        status: 'ok',
        source: `${INTERNAL_FUNCTIONS.gpu} (repli GPU — aucun règlement importé)`,
        data: {
          ...(gpu.data as Record<string, unknown>),
          niveau_de_detail: 'zonage_seul',
          regle_ecrite_disponible: false,
          note_repli:
            "Aucun règlement de PLU n'a été importé sur la page Foncier : ces éléments viennent du " +
            "Géoportail de l'urbanisme et se limitent au ZONAGE OPPOSABLE (code de zone, type U/AU/A/N). " +
            "Les règles CHIFFRÉES — hauteur maximale, emprise au sol, retraits, stationnement, OAP — ne " +
            "sont PAS disponibles ici : ne les invente sous aucun prétexte. Dis à l'utilisateur que pour " +
            "les obtenir il doit importer le PDF du règlement sur la page Foncier de Mimmoza.",
        },
      };
    }
    // GPU muet ou en échec : on retombe sur le message d'origine, sans rien inventer.
  }

  // 4) Ni règlement importé, ni zonage GPU : on le dit, sans inventer de règle.
  return {
    status: 'not_found', source: 'PLU',
    message:
      "Aucune donnée PLU disponible : le règlement n'a pas été importé sur la page Foncier de Mimmoza, " +
      "et le Géoportail de l'urbanisme ne renvoie aucun zonage sur ce point (commune non numérisée, " +
      "localisation trop imprécise, ou commune au RNU). " +
      "Invite l'utilisateur à uploader le PDF du PLU. N'invente aucune règle d'urbanisme ni aucune OAP, " +
      "et ne conclus SURTOUT PAS que le terrain est constructible ou non.",
  };
}

// ─── compute_smartscore (branché sur smartscore-enriched-v3) ──
async function toolSmartScore(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.smartscore) {
    return {
      status: 'not_configured', source: 'SmartScore',
      message: "Le moteur SmartScore n'est pas encore branché (COPILOT_FN_SMARTSCORE non défini). Signale-le sans inventer de score.",
    };
  }

  const ref = resolveParcelRef(input, ctx);

  // ── PATCH annonce : pas de parcelle ni GPS → résoudre code_insee + centroïde
  //    commune depuis zip/city (contexte annonce investisseur/marchand).
  //    smartscore-enriched-v3 a besoin de lat/lon pour les piliers services/
  //    transport (Overpass) ; à défaut on prend le centre de la commune.
  if (!ref.code_insee && ref.lat == null) {
    const zipCode = str(input.zip_code) ?? (ctx as any).zip_code;
    const city    = str(input.commune) ?? str(input.city) ?? (ctx as any).city ?? ref.commune;
    const query = zipCode
      ? `codePostal=${encodeURIComponent(zipCode)}`
      : (city ? `nom=${encodeURIComponent(city)}` : null);
    if (query) {
      try {
        const r = await fetch(
          `https://geo.api.gouv.fr/communes?${query}&fields=code,nom,centre&limit=1`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d) && d[0]?.code) {
            ref.code_insee = d[0].code;
            if (!ref.commune && d[0].nom) ref.commune = d[0].nom;
            const c = d[0].centre?.coordinates;
            if (Array.isArray(c) && c.length === 2) { ref.lng = c[0]; ref.lat = c[1]; }
          }
        }
      } catch { /* geo.api injoignable → on continue sans */ }
    }
  }

  if (!hasAnyIdentifier(ref) && !ref.commune && !ref.code_insee) {
    return { status: 'not_found', source: 'SmartScore', message: 'Aucune parcelle ni localisation identifiée.' };
  }
  try {
    // Contrat smartscore-enriched-v3 : mode "standard", lng→lon, commune_insee.
    const body = {
      mode: 'standard',
      parcel_id: ref.parcel_id ?? undefined,
      commune_insee: ref.code_insee ?? undefined,
      lat: ref.lat ?? undefined,
      lon: ref.lng ?? undefined,   // ⚠️ la fonction attend "lon", pas "lng"
      type_local: str(input.type_local) ?? undefined,
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.smartscore, body);
    return { status: 'ok', source: INTERNAL_FUNCTIONS.smartscore, data: summarizeSmartScore(raw) };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.smartscore, message: errMsg(e) };
  }
}

// ─── get_dvf_comparables ──
// Priorité à la fonction DVF dédiée (dvf-comparables-v1, COPILOT_FN_DVF), au contrat
// { status, summary, stats, comps }. Repli mutualisé sur smartscore-enriched-v3 (bloc
// market_like.dvf) si seul COPILOT_FN_SMARTSCORE est défini.
async function toolDvfComparables(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  const ref = resolveParcelRef(input, ctx);

  // ── PATCH : si code_insee manquant mais commune connue, on le résout via geo.api ──
  if (!ref.code_insee && !ref.lat && ref.commune) {
    try {
      const r = await fetch(
        `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(ref.commune)}&fields=code&limit=1`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d[0]?.code) ref.code_insee = d[0].code;
      }
    } catch { /* geo.api injoignable → on continue sans */ }
  }

  if (!hasAnyIdentifier(ref) && !ref.commune && !ref.code_insee) {
    return { status: 'not_found', source: 'DVF', message: 'Ni parcelle ni commune identifiée.' };
  }

  const radiusKm = num(input.rayon_m) != null ? num(input.rayon_m)! / 1000 : 2;
  const horizonMonths = num(input.horizon_months) ?? 24;
  const typeLocal = str(input.type_local) ?? undefined;

  // ── Path A : fonction DVF dédiée (dvf-comparables-v1) ──
  const dedicated = INTERNAL_FUNCTIONS.dvf;
  if (dedicated) {
    try {
      const body = {
        lat: ref.lat ?? undefined,
        lon: ref.lng ?? undefined,            // ⚠️ dvf-comparables-v1 attend "lon", pas "lng"
        commune_insee: ref.code_insee ?? undefined,
        parcel_id: ref.parcel_id ?? undefined,
        radius_km: radiusKm,
        horizon_months: horizonMonths,
        type_local: typeLocal,
      };
      const raw = await callInternalFunction(dedicated, body);
      const s = summarizeDvfDedicated(raw);
      return { status: s.status, source: dedicated, data: s.data, message: s.message };
    } catch (e) {
      return { status: 'error', source: dedicated, message: errMsg(e) };
    }
  }

  // ── Path B : repli mutualisé sur smartscore-enriched-v3 (mode standard) ──
  const fn = INTERNAL_FUNCTIONS.smartscore;
  if (!fn) {
    return {
      status: 'not_configured', source: 'DVF',
      message: "Le service DVF n'est pas encore branché (ni COPILOT_FN_DVF ni COPILOT_FN_SMARTSCORE). Signale-le sans inventer de prix.",
    };
  }
  try {
    const body = {
      mode: 'standard',
      parcel_id: ref.parcel_id ?? undefined,
      commune_insee: ref.code_insee ?? undefined,
      lat: ref.lat ?? undefined,
      lon: ref.lng ?? undefined,             // ⚠️ "lon"
      type_local: typeLocal,
      radius_km: radiusKm,
    };
    const raw = await callInternalFunction(fn, body);
    return { status: 'ok', source: fn, data: summarizeDvfFromSmartScore(raw) };
  } catch (e) {
    return { status: 'error', source: fn, message: errMsg(e) };
  }
}

// ─── get_risks_georisques (branché sur risk-study via COPILOT_FN_RISKS) ──
async function toolRisksGeorisques(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.risks) {
    return {
      status: 'not_configured', source: 'Géorisques',
      message: "Le service Géorisques n'est pas encore branché (COPILOT_FN_RISKS non défini). Signale-le sans inventer de risque.",
    };
  }

  const ref = resolveParcelRef(input, ctx);

  // ── PATCH listing : résoudre code_insee depuis city/zip du contexte annonce ──
  if (!ref.code_insee && !ref.lat) {
    const zipCode = str(input.zip_code) ?? (ctx as any).zip_code;
    const city    = str(input.city)     ?? (ctx as any).city ?? ref.commune;

    if (zipCode) {
      try {
        const r = await fetch(
          `https://geo.api.gouv.fr/communes?codePostal=${encodeURIComponent(zipCode)}&fields=code,nom&limit=1`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d) && d[0]?.code) {
            ref.code_insee = d[0].code;
            if (!ref.commune && d[0].nom) ref.commune = d[0].nom;
          }
        }
      } catch { /* geo.api injoignable → on continue sans */ }
    }

    if (!ref.commune && city) ref.commune = city;
  }

  if (!hasAnyIdentifier(ref) && !ref.code_insee && !ref.commune) {
    return {
      status: 'not_found', source: 'Géorisques',
      message: 'Aucune localisation exploitable (ni lat/lng, ni parcelle, ni code INSEE, ni ville).',
    };
  }

  try {
    const body = {
      lat:           ref.lat        ?? undefined,
      lon:           ref.lng        ?? undefined,
      commune_insee: ref.code_insee ?? undefined,
      parcel_id:     ref.parcel_id  ?? undefined,
      address:       ref.address    ?? undefined,
      radius_km: num(input.rayon_m) != null ? num(input.rayon_m)! / 1000 : undefined,
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.risks, body);
    return { status: 'ok', source: INTERNAL_FUNCTIONS.risks, data: summarizeRisks(raw) };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.risks, message: errMsg(e) };
  }
}

// ─── get_dpe_ademe (branché sur dpe-ademe-v1 via COPILOT_FN_DPE) ──
async function toolDpeAdeme(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.dpe) {
    return {
      status: 'not_configured', source: 'DPE ADEME',
      message: "Le service DPE n'est pas encore branché (COPILOT_FN_DPE non défini). Signale-le sans inventer de classe.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  const address = str(input.address) ?? ref.address;
  const codePostal =
    str(input.code_postal) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;

  // Localisation minimale : adresse OU coordonnées OU code postal.
  if (!address && ref.lat == null && !codePostal) {
    return {
      status: 'not_found', source: 'DPE ADEME',
      message: "Aucune localisation exploitable pour interroger le DPE (ni adresse, ni coordonnées, ni code postal).",
    };
  }

  try {
    const body = {
      address: address ?? undefined,
      lat: ref.lat ?? undefined,
      lon: ref.lng ?? undefined,        // ⚠️ dpe-ademe-v1 attend "lon", pas "lng"
      code_postal: codePostal ?? undefined,
      radius_m: num(input.radius_m) ?? undefined,
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.dpe, body);
    const s = summarizeDpeDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.dpe, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.dpe, message: errMsg(e) };
  }
}

// ─── get_monuments_historiques (branché sur patrimoine-merimee-v1) ──
async function toolMonumentsHistoriques(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.merimee) {
    return {
      status: 'not_configured', source: 'Mérimée',
      message: "Le service Monuments historiques n'est pas encore branché (COPILOT_FN_MERIMEE non défini). Signale-le sans inventer de périmètre.",
    };
  }

  const ref = resolveParcelRef(input, ctx);

  // Le périmètre ABF se mesure à 500 m d'un POINT : sans coordonnées, le repli
  // communal ne peut PAS répondre « suis-je dans les abords ? ». On tente donc
  // d'abord le centroïde cadastral depuis l'IDU.
  if (ref.lat == null || ref.lng == null) {
    const idu = str(input.cadastral_ref) ?? str(input.parcel_id) ?? ref.cadastral_ref ?? ref.parcel_id;
    if (idu) {
      const c = await parcelCentroidFromIdu(idu);
      if (c) { ref.lat = c.lat; ref.lng = c.lon; }
    }
  }

  // Mérimée n'a de sens qu'en géographique. Si pas de lat/lon mais une commune,
  // on résout le code INSEE via geo.api (repli commune, moins précis).
  if (ref.lat == null && !ref.code_insee && ref.commune) {
    try {
      const r = await fetch(
        `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(ref.commune)}&fields=code&limit=1`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d[0]?.code) ref.code_insee = d[0].code;
      }
    } catch { /* geo.api injoignable → on continue sans */ }
  }

  if (ref.lat == null && !ref.code_insee) {
    return {
      status: 'not_found', source: 'Mérimée',
      message: "Aucune localisation exploitable (ni coordonnées, ni commune) pour rechercher les monuments historiques.",
    };
  }

  try {
    const body = {
      lat: ref.lat ?? undefined,
      lon: ref.lng ?? undefined,        // ⚠️ patrimoine-merimee-v1 attend "lon"
      code_insee: ref.code_insee ?? undefined,
      radius_m: num(input.radius_m) ?? undefined,
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.merimee, body);
    const s = summarizeMerimeeDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.merimee, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.merimee, message: errMsg(e) };
  }
}

// ─── get_batiment_bdnb (branché sur batiment-bdnb-v1 via COPILOT_FN_BDNB) ──
async function toolBatimentBdnb(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.bdnb) {
    return {
      status: 'not_configured', source: 'BDNB',
      message: "Le service BDNB n'est pas encore branché (COPILOT_FN_BDNB non défini). Signale-le sans inventer de caractéristique.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  const address = str(input.address) ?? ref.address;
  let codeInsee = str(input.code_insee) ?? ref.code_insee;

  // Repli commune → code INSEE via geo.api si besoin.
  if (!address && !codeInsee && ref.commune) {
    try {
      const r = await fetch(
        `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(ref.commune)}&fields=code&limit=1`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d[0]?.code) codeInsee = d[0].code;
      }
    } catch { /* geo.api injoignable → on continue sans */ }
  }

  if (!address && !codeInsee) {
    return {
      status: 'not_found', source: 'BDNB',
      message: "Aucune localisation exploitable (ni adresse, ni commune) pour interroger la BDNB.",
    };
  }

  try {
    const body = { address: address ?? undefined, code_insee: codeInsee ?? undefined };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.bdnb, body);
    const s = summarizeBdnbDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.bdnb, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.bdnb, message: errMsg(e) };
  }
}

// ─── get_loyers_reference (branché sur loyers-reference-v1 via COPILOT_FN_LOYERS) ──
// Source #1 : Carte des loyers ANIL/DHUP. Le tool résout le code INSEE
// (input LLM → contexte → geo.api depuis ville/CP) ; la fonction lit la table
// et gère l'éclatement PLM (Paris/Lyon/Marseille → fourchette arrondissements).
async function toolLoyersReference(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.loyers) {
    return {
      status: 'not_configured', source: 'Loyers de référence',
      message: "Le service Loyers de référence n'est pas encore branché (COPILOT_FN_LOYERS non défini). Signale-le sans inventer de loyer.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  let codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
  const commune = str(input.commune) ?? str(input.city) ?? ref.commune ?? (ctx as any).city;
  const zipCode = str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;

  // Repli : résoudre le code INSEE depuis une commune / un code postal.
  // ⚠️ geo.api renvoie le code « commune globale » (75056/69123/13055) pour
  //    Paris/Lyon/Marseille recherchés par nom → l'éclatement PLM côté fonction
  //    prend le relais. Un code postal d'arrondissement cible l'arrondissement.
  if (!codeInsee && (commune || zipCode)) {
    const query = zipCode
      ? `codePostal=${encodeURIComponent(zipCode)}`
      : `nom=${encodeURIComponent(commune!)}`;
    try {
      const r = await fetch(
        `https://geo.api.gouv.fr/communes?${query}&fields=code&limit=1`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d[0]?.code) codeInsee = String(d[0].code);
      }
    } catch { /* geo.api injoignable → la fonction retentera de résoudre */ }
  }

  if (!codeInsee && !commune && !zipCode) {
    return {
      status: 'not_found', source: 'Loyers de référence',
      message: "Aucune commune identifiée (ni code INSEE, ni ville, ni code postal) pour interroger les loyers de référence.",
    };
  }

  try {
    const body = {
      code_insee: codeInsee ?? undefined,
      commune: commune ?? undefined,
      zip_code: zipCode ?? undefined,
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.loyers, body);
    const s = summarizeLoyersDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.loyers, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.loyers, message: errMsg(e) };
  }
}

// ─── get_servitudes (branché sur servitudes-gpu-v1 via COPILOT_FN_SERVITUDES) ──
// SUP = donnée parcellaire → nécessite lat/lon. Pas de repli centroïde commune :
// interroger un centre-ville renverrait des servitudes hors sujet. La fonction
// récupère elle-même le polygone parcelle (cadastre) et intersecte les assiettes.
async function toolServitudes(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.servitudes) {
    return {
      status: 'not_configured', source: 'Servitudes (GPU)',
      message: "Le service Servitudes n'est pas encore branché (COPILOT_FN_SERVITUDES non défini). Signale-le sans inventer de servitude.",
    };
  }

  // Même cascade que le GPU : coordonnées du contexte, sinon centroïde cadastral
  // résolu depuis l'IDU. Sans cela l'outil rendait la main en 0 ms sur une simple
  // référence cadastrale, alors que la donnée était parfaitement atteignable.
  const loc = await resolvePointPrecis(input, ctx);
  if (!loc.pt) {
    const idu = loc.idu ?? 'non fournie';
    const MSG: Record<string, string> = {
      idu_invalide:
        `La référence cadastrale « ${idu} » n'a pas le format d'un identifiant parcellaire français ` +
        `(14 caractères). Demande à l'utilisateur de vérifier sa saisie. N'avance aucune servitude.`,
      introuvable_cadastre:
        `La référence cadastrale « ${idu} » est bien formée mais INTROUVABLE au cadastre : référence ` +
        `erronée, parcelle renumérotée après division ou fusion, ou commune non couverte par le plan ` +
        `cadastral informatisé. C'est un problème de RÉFÉRENCE, pas de servitude : demande à ` +
        `l'utilisateur de la vérifier, et ne conclus RIEN sur les contraintes du terrain.`,
      reseau:
        `Le service cadastre (API Carto/IGN) n'a pas répondu : impossible de convertir « ${idu} » en ` +
        `coordonnées. Panne temporaire, pas une information sur le terrain. Propose de réessayer.`,
    };
    return {
      status: 'not_found', source: 'Servitudes (GPU)',
      message: (loc.echec && MSG[loc.echec]) ??
        ("Coordonnées précises (lat/lng) indisponibles. Les servitudes se recherchent à la parcelle, " +
         "pas à la commune : demande à l'utilisateur d'ouvrir une parcelle localisée. " +
         "Une absence de résultat ne prouve JAMAIS l'absence de servitude."),
    };
  }
  const lat = loc.pt.lat;
  const lng = loc.pt.lon;

  try {
    const body = {
      lat,
      lon: lng,                                    // ⚠️ servitudes-gpu-v1 attend "lon"
      // ⚠️ CORRECTIF : `ref` n'existe plus ici depuis le passage à
      // resolvePointPrecis — cette ligne levait un ReferenceError à CHAQUE
      // appel de get_servitudes. On repasse par resolveParcelRef, qui conserve
      // le repli sur la référence cadastrale du contexte.
      cadastral_ref:
        str(input.cadastral_ref) ?? resolveParcelRef(input, ctx).cadastral_ref ?? undefined,
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.servitudes, body);
    const s = summarizeServitudesDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.servitudes, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.servitudes, message: errMsg(e) };
  }
}

// ─── get_potentiel_solaire (branché sur potentiel-solaire-v1 via COPILOT_FN_SOLAIRE) ──
// PVGIS accepte un centroïde commune (l'irradiation varie peu à l'échelle du km),
// donc repli geo.api autorisé ici — contrairement aux servitudes.
async function toolPotentielSolaire(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.solaire) {
    return {
      status: 'not_configured', source: 'Potentiel solaire',
      message: "Le service Potentiel solaire n'est pas encore branché (COPILOT_FN_SOLAIRE non défini). Signale-le sans inventer de valeur.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  let lat = num(input.lat) ?? ref.lat;
  let lng = num(input.lng) ?? ref.lng;

  // Repli : centroïde de la commune (INSEE prioritaire, sinon nom) via geo.api.
  if (lat == null || lng == null) {
    const codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
    const commune = str(input.commune) ?? ref.commune ?? (ctx as any).city;
    const query = codeInsee
      ? `code=${encodeURIComponent(codeInsee)}`
      : (commune ? `nom=${encodeURIComponent(commune)}` : null);
    if (query) {
      try {
        const r = await fetch(
          `https://geo.api.gouv.fr/communes?${query}&fields=centre&limit=1`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (r.ok) {
          const d = await r.json();
          const c = Array.isArray(d) && d[0]?.centre?.coordinates;
          if (Array.isArray(c) && c.length === 2) { lng = c[0]; lat = c[1]; }
        }
      } catch { /* geo.api injoignable → on continue sans */ }
    }
  }

  if (lat == null || lng == null) {
    return {
      status: 'not_found', source: 'Potentiel solaire',
      message: "Aucune localisation exploitable (ni coordonnées, ni commune) pour estimer le potentiel solaire.",
    };
  }

  try {
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.solaire, { lat, lon: lng });
    const s = summarizePotentielSolaireDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.solaire, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.solaire, message: errMsg(e) };
  }
}

// ─── get_zonage_abc (branché sur zonage-abc-v1 via COPILOT_FN_ZONAGE) ──
// Le tool résout le code INSEE (input → contexte → geo.api depuis ville/CP) ;
// la fonction lit la table zonage_abc. Donnée à la commune (pas de lat/lon requis).
async function toolZonageAbc(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.zonage) {
    return {
      status: 'not_configured', source: 'Zonage ABC',
      message: "Le service Zonage ABC n'est pas encore branché (COPILOT_FN_ZONAGE non défini). Signale-le sans inventer de zone.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  let codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
  const commune = str(input.commune) ?? ref.commune ?? (ctx as any).city;
  const zipCode = str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;

  if (!codeInsee && (commune || zipCode)) {
    const query = zipCode
      ? `codePostal=${encodeURIComponent(zipCode)}`
      : `nom=${encodeURIComponent(commune!)}`;
    try {
      const r = await fetch(
        `https://geo.api.gouv.fr/communes?${query}&fields=code&limit=1`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d[0]?.code) codeInsee = String(d[0].code);
      }
    } catch { /* geo.api injoignable → la fonction retentera de résoudre */ }
  }

  if (!codeInsee && !commune && !zipCode) {
    return {
      status: 'not_found', source: 'Zonage ABC',
      message: "Aucune commune identifiée (ni code INSEE, ni ville, ni code postal) pour déterminer le zonage ABC.",
    };
  }

  try {
    const body = { code_insee: codeInsee ?? undefined, commune: commune ?? undefined, zip_code: zipCode ?? undefined };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.zonage, body);
    const s = summarizeZonageDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.zonage, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.zonage, message: errMsg(e) };
  }
}

// ─── get_taxes_locales (branché sur taxes-locales-v1 via COPILOT_FN_TAXES) ──
// Le tool résout le code INSEE (input → contexte → geo.api depuis ville/CP) ;
// la fonction interroge l'API DGFiP Opendatasoft. Donnée à la commune.
async function toolTaxesLocales(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.taxes) {
    return {
      status: 'not_configured', source: 'Taxes locales',
      message: "Le service Taxes locales n'est pas encore branché (COPILOT_FN_TAXES non défini). Signale-le sans inventer de taux.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  let codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
  const commune = str(input.commune) ?? ref.commune ?? (ctx as any).city;
  const zipCode = str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;

  if (!codeInsee && (commune || zipCode)) {
    const query = zipCode
      ? `codePostal=${encodeURIComponent(zipCode)}`
      : `nom=${encodeURIComponent(commune!)}`;
    try {
      const r = await fetch(
        `https://geo.api.gouv.fr/communes?${query}&fields=code&limit=1`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d[0]?.code) codeInsee = String(d[0].code);
      }
    } catch { /* geo.api injoignable → la fonction retentera de résoudre */ }
  }

  if (!codeInsee && !commune && !zipCode) {
    return {
      status: 'not_found', source: 'Taxes locales',
      message: "Aucune commune identifiée (ni code INSEE, ni ville, ni code postal) pour interroger les taxes locales.",
    };
  }

  try {
    const body = { code_insee: codeInsee ?? undefined, commune: commune ?? undefined, zip_code: zipCode ?? undefined };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.taxes, body);
    const s = summarizeTaxesDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.taxes, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.taxes, message: errMsg(e) };
  }
}

// ─── get_ppr_detail (branché sur ppr-detail-v1 via COPILOT_FN_PPR) ──
// Détail PPR par commune (Géorisques GASPAR) + test dans-périmètre si lat/lng.
// Le tool résout l'INSEE ; passe aussi lat/lon pour affiner à la parcelle.
async function toolPprDetail(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.ppr) {
    return {
      status: 'not_configured', source: 'PPR (Géorisques)',
      message: "Le service PPR détaillés n'est pas encore branché (COPILOT_FN_PPR non défini). Signale-le sans inventer de PPR.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  let codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
  const commune = str(input.commune) ?? ref.commune ?? (ctx as any).city;
  const zipCode = str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;
  const lat = num(input.lat) ?? ref.lat;
  const lng = num(input.lng) ?? ref.lng;

  if (!codeInsee && (commune || zipCode)) {
    const query = zipCode
      ? `codePostal=${encodeURIComponent(zipCode)}`
      : `nom=${encodeURIComponent(commune!)}`;
    try {
      const r = await fetch(
        `https://geo.api.gouv.fr/communes?${query}&fields=code&limit=1`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d[0]?.code) codeInsee = String(d[0].code);
      }
    } catch { /* geo.api injoignable → la fonction retentera de résoudre */ }
  }

  if (!codeInsee && !commune && !zipCode) {
    return {
      status: 'not_found', source: 'PPR (Géorisques)',
      message: "Aucune commune identifiée (ni code INSEE, ni ville, ni code postal) pour lister les PPR.",
    };
  }

  try {
    const body = {
      code_insee: codeInsee ?? undefined,
      commune: commune ?? undefined,
      zip_code: zipCode ?? undefined,
      lat: lat ?? undefined,
      lon: lng ?? undefined,          // ⚠️ ppr-detail-v1 attend "lon"
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.ppr, body);
    const s = summarizePprDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.ppr, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.ppr, message: errMsg(e) };
  }
}

// ─── get_assainissement (branché sur assainissement-commune-v1 via COPILOT_FN_ASSAINISSEMENT) ──
// Le tool résout le code INSEE (input → contexte → geo.api depuis ville/CP) ;
// la fonction lit la table assainissement_commune. Donnée à la commune.
async function toolAssainissement(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.assainissement) {
    return {
      status: 'not_configured', source: 'Assainissement',
      message: "Le service Assainissement n'est pas encore branché (COPILOT_FN_ASSAINISSEMENT non défini). Signale-le sans inventer.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  let codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
  const commune = str(input.commune) ?? ref.commune ?? (ctx as any).city;
  const zipCode = str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;

  if (!codeInsee && (commune || zipCode)) {
    const query = zipCode
      ? `codePostal=${encodeURIComponent(zipCode)}`
      : `nom=${encodeURIComponent(commune!)}`;
    try {
      const r = await fetch(
        `https://geo.api.gouv.fr/communes?${query}&fields=code&limit=1`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d) && d[0]?.code) codeInsee = String(d[0].code);
      }
    } catch { /* geo.api injoignable → la fonction retentera de résoudre */ }
  }

  if (!codeInsee && !commune && !zipCode) {
    return {
      status: 'not_found', source: 'Assainissement',
      message: "Aucune commune identifiée (ni code INSEE, ni ville, ni code postal) pour l'assainissement.",
    };
  }

  try {
    const body = { code_insee: codeInsee ?? undefined, commune: commune ?? undefined, zip_code: zipCode ?? undefined };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.assainissement, body);
    const s = summarizeAssainissementDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.assainissement, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.assainissement, message: errMsg(e) };
  }
}

// ─── get_altimetrie (branché sur altimetrie-v1 via COPILOT_FN_ALTIMETRIE) ──
// Altitude + pente estimée (RGE Alti). lat/lng pour la parcelle ; sinon repli
// centre commune (précision dégradée, signalée par la fonction).
async function toolAltimetrie(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  console.log('[altimetrie-tool] input=', JSON.stringify(input),
              '| parcel=', JSON.stringify(ctx.parcel),
              '| city=', (ctx as any).city, '| zip=', (ctx as any).zip_code);
  if (!INTERNAL_FUNCTIONS.altimetrie) {
    return {
      status: 'not_configured', source: 'Altimétrie',
      message: "Le service Altimétrie n'est pas encore branché (COPILOT_FN_ALTIMETRIE non défini). Signale-le sans inventer.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  const lat = num(input.lat) ?? ref.lat;
  const lng = num(input.lng) ?? ref.lng;
  const codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
  const commune = str(input.commune) ?? ref.commune ?? (ctx as any).city;
  // Identifiant cadastral (IDU) : permet à la fonction de retrouver le centroïde
  // exact de la parcelle via le cadastre, même sans coordonnées ni commune.
  const idu = str(input.cadastral_ref) ?? str(input.parcel_id) ?? ref.cadastral_ref ?? ref.parcel_id;

  if (lat == null && lng == null && !codeInsee && !commune && !idu) {
    return {
      status: 'not_found', source: 'Altimétrie',
      message: "Aucune localisation (ni coordonnées, ni identifiant cadastral, ni commune) pour l'altimétrie.",
    };
  }

  try {
    const body = {
      lat: lat ?? undefined,
      lon: lng ?? undefined,          // ⚠️ altimetrie-v1 attend "lon"
      cadastral_ref: idu ?? undefined,
      code_insee: codeInsee ?? undefined,
      commune: commune ?? undefined,
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.altimetrie, body);
    const s = summarizeAltimetrieDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.altimetrie, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.altimetrie, message: errMsg(e) };
  }
}

// ─── get_classement_sonore (branché sur bruit-classement-v1 via COPILOT_FN_BRUIT) ──
// Donnée parcellaire (secteurs affectés par le bruit, GPU info-surf/prescription-surf).
// Besoin d'un IDU (→ polygone cadastre côté fonction) ou de lat/lng. Pas de repli commune.
async function toolClassementSonore(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.bruit) {
    return {
      status: 'not_configured', source: 'Classement sonore',
      message: "Le service Classement sonore n'est pas encore branché (COPILOT_FN_BRUIT non défini). Signale-le sans inventer de secteur.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  const lat = num(input.lat) ?? ref.lat;
  const lng = num(input.lng) ?? ref.lng;
  const idu = str(input.cadastral_ref) ?? str(input.parcel_id) ?? ref.cadastral_ref ?? ref.parcel_id;

  if (!idu && (lat == null || lng == null)) {
    return {
      status: 'not_found', source: 'Classement sonore',
      message: "Le classement sonore s'interroge à la parcelle : fournis un identifiant cadastral (IDU) ou des coordonnées précises (lat/lng), pas seulement une commune.",
    };
  }

  try {
    const body = {
      lat: lat ?? undefined,
      lon: lng ?? undefined,          // ⚠️ bruit-classement-v1 attend "lon"
      cadastral_ref: idu ?? undefined,
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.bruit, body);
    const s = summarizeBruitDedicated(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.bruit, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.bruit, message: errMsg(e) };
  }
}

// ─── get_etude_parcelle (branché sur etude-parcelle-v1 via COPILOT_FN_ETUDE) ──
// Un seul appel → 7 sources en parallèle côté serveur. Contourne la limite
// MAX_TOOL_ITERATIONS.quick = 2 qui interdit d'enchaîner les outils en mode rapide.
async function toolEtudeParcelle(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.etude) {
    return {
      status: 'not_configured', source: 'Étude de parcelle',
      message: "L'étude complète n'est pas encore branchée (COPILOT_FN_ETUDE non défini). Signale-le sans inventer de synthèse.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  const idu = str(input.cadastral_ref) ?? str(input.parcel_id) ?? ref.cadastral_ref ?? ref.parcel_id;
  const lat = num(input.lat) ?? ref.lat;
  const lng = num(input.lng) ?? ref.lng;
  const codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
  const commune = str(input.commune) ?? ref.commune ?? (ctx as any).city;
  const zipCode = str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;

  if (!idu && lat == null && !codeInsee && !commune && !zipCode) {
    return {
      status: 'not_found', source: 'Étude de parcelle',
      message: "Aucune localisation exploitable. Demande à l'utilisateur d'ouvrir une parcelle ou de préciser une commune.",
    };
  }

  try {
    const body = {
      cadastral_ref: idu ?? undefined,
      lat: lat ?? undefined,
      lon: lng ?? undefined,          // ⚠️ etude-parcelle-v1 attend "lon"
      code_insee: codeInsee ?? undefined,
      commune: commune ?? undefined,
      zip_code: zipCode ?? undefined,
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.etude, body);
    const s = summarizeEtudeParcelle(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.etude, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.etude, message: errMsg(e) };
  }
}

// ─── get_etude_marche (branché sur market-study-investisseur-v1) ──
// ⚠️ CONTRAT : la fonction attend "lon" (pas "lng") et "zipCode" en camelCase.
async function toolEtudeMarche(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.market) {
    return {
      status: 'not_configured', source: 'Étude de marché',
      message: "L'étude de marché n'est pas encore branchée (COPILOT_FN_MARKET non défini). Signale-le sans inventer de chiffre.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  const lat = num(input.lat) ?? ref.lat;
  const lng = num(input.lng) ?? ref.lng;
  const address = str(input.address) ?? ref.address;
  const city = str(input.city) ?? str(input.commune) ?? ref.commune ?? (ctx as any).city;
  const zip = str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;
  // v1.9 — L'IDU cadastral et le code INSEE sont résolus depuis le contexte par
  // resolveParcelRef (qui dérive même l'INSEE des 5 premiers caractères de l'IDU),
  // mais ils n'étaient tout simplement PAS transmis à la fonction.
  const parcelId = ref.cadastral_ref ?? ref.parcel_id;
  const codeInsee = str(input.commune_insee) ?? ref.code_insee;

  // Le garde exigeait lat/adresse/ville. Sur « étude de marché de la parcelle
  // 64065000AI0002 », aucun des trois n'est connu au premier appel : l'outil
  // répondait donc « Indisponible » alors que l'identifiant portait toute
  // l'information. Le copilote allait ensuite chercher le NOM de la commune et
  // relançait — d'où deux échecs, et une analyse finalement centrée sur le
  // centre-bourg au lieu de la parcelle.
  if (lat == null && !address && !city && !parcelId && !codeInsee) {
    return {
      status: 'not_found', source: 'Étude de marché',
      message: "Aucune localisation exploitable (ni coordonnées, ni identifiant de parcelle, ni code INSEE, ni adresse, ni ville) pour l'étude de marché.",
    };
  }

  try {
    const body: Record<string, unknown> = {
      project_type: str(input.project_type) ?? 'logement',
      radius_km: num(input.rayon_km) ?? 5,
    };
    // ⚠️ ORDRE DE PRÉCISION. market-study v1.4.1 essaie la parcelle EN PREMIER
    // (Apicarto IGN → centroïde réel), puis l'adresse, la ville, et enfin
    // l'INSEE. Transmettre parcel_id est donc ce qui permet de centrer le rayon
    // d'analyse sur le terrain plutôt que sur le clocher.
    if (parcelId) body.parcel_id = parcelId;
    if (codeInsee) body.commune_insee = codeInsee;
    if (lat != null && lng != null) { body.lat = lat; body.lon = lng; }   // ⚠️ "lon"
    else if (address) body.address = address;
    if (zip) body.zipCode = zip;                                          // ⚠️ camelCase
    if (city) body.city = city;

    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.market, body);
    const s = summarizeMarketStudy(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.market, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.market, message: errMsg(e) };
  }
}

// ─── get_couts_construction (branché sur couts-construction-v1) ──
// Barème interne × coefficient de zone × indexation BT01. Le calcul est
// DÉTERMINISTE côté fonction : le LLM restitue, il ne recalcule pas.
async function toolCoutsConstruction(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.couts) {
    return {
      status: 'not_configured', source: 'Coûts de construction',
      message: "Le barème de coûts n'est pas encore branché (COPILOT_FN_COUTS non défini). Signale-le sans inventer de montant.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  const body = {
    typologie: str(input.typologie) ?? undefined,
    gamme: str(input.gamme) ?? undefined,
    surface_sdp: num(input.surface_sdp) ?? undefined,
    zone_abc: str(input.zone_abc) ?? undefined,
    code_insee: str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee ?? undefined,
    commune: str(input.commune) ?? ref.commune ?? (ctx as any).city ?? undefined,
  };

  try {
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.couts, body);
    const s = summarizeCoutsConstruction(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.couts, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.couts, message: errMsg(e) };
  }
}

// ─── get_couts_renovation (branché sur couts-renovation-v1 via COPILOT_FN_COUTS_RENOVATION) ──
// Barème rénovation interne, poste par poste. Calcul DÉTERMINISTE côté fonction :
// le LLM lit l'état sur les photos, transmet les postes ; il restitue sans recalculer.
async function toolCoutsRenovation(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.couts_renovation) {
    return {
      status: 'not_configured', source: 'Coûts de rénovation',
      message: "Le barème rénovation n'est pas encore branché (COPILOT_FN_COUTS_RENOVATION non défini). Signale-le sans inventer de montant.",
    };
  }

  const body = {
    surface_habitable_m2:
      num(input.surface_habitable_m2) ?? ctx.surface ?? (ctx as any).plan_surface_retenue_m2 ?? undefined,
    gamme: str(input.gamme) ?? undefined,
    alea_pct: num(input.alea_pct) ?? undefined,
    restructuration: input.restructuration === true ? true : undefined,
    niveau_global: str(input.niveau_global) ?? undefined,
    // Transmis tel quel : la fonction valide/normalise chaque poste (synonymes tolérés).
    postes: Array.isArray(input.postes) ? input.postes : undefined,
  };

  try {
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.couts_renovation, body);
    const s = summarizeCoutsRenovation(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.couts_renovation, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.couts_renovation, message: errMsg(e) };
  }
}

// ─── IDU (identifiant cadastral) → centroïde parcelle via API Carto cadastre ──
// Même brique qu'altimetrie-v1 : évite de dépendre d'un lat/lon présent au
// contexte (les parcelles Mimmoza n'en portent pas toujours). Réutilisable pour
// servitudes / solaire. Repli silencieux (null) si le cadastre ne répond pas.
type IduEchec = 'idu_invalide' | 'introuvable_cadastre' | 'reseau';
type IduResultat = { lat: number; lon: number; echec: null } | { lat: null; lon: null; echec: IduEchec };

// Wrapper de compatibilite : les appelants qui se moquent de la cause.
async function parcelCentroidFromIdu(iduRaw: string): Promise<{ lat: number; lon: number } | null> {
  const r = await parcelCentroidDetaille(iduRaw);
  return r.echec === null ? { lat: r.lat, lon: r.lon } : null;
}

async function parcelCentroidDetaille(iduRaw: string): Promise<IduResultat> {
  const idu = iduRaw.replace(/\s/g, '').toUpperCase();
  // IDU 14 car. : INSEE[0..5) prefixe[5..8) section[8..10) numero[10..14).
  const m = /^(2[AB]\d{3}|\d{5})(\d{3})([0-9A-Z]{2})(\d{4})$/.exec(idu);
  if (!m) { console.log('[cadastre] IDU non parsable :', idu); return { lat: null, lon: null, echec: 'idu_invalide' }; }
  const [, codeInsee, prefixe, section, numeroRaw] = m;

  // API Carto sert le cadastre PCI : le numero y est stocke sur 4 caracteres
  // zero-remplis ("0002"). Certains millesimes repondent aussi au format court
  // ("2"). On essaie les deux : la premiere reponse peuplee gagne.
  const numeros = numeroRaw === String(Number(numeroRaw))
    ? [numeroRaw]
    : [numeroRaw, String(Number(numeroRaw))];

  let reseauKo = false;
  for (const numero of numeros) {
    const url = new URL('https://apicarto.ign.fr/api/cadastre/parcelle');
    url.searchParams.set('code_insee', codeInsee);
    url.searchParams.set('section', section);
    url.searchParams.set('numero', numero);
    // Commune absorbee : le prefixe "000" est le cas courant (pas de fusion).
    if (prefixe !== '000') url.searchParams.set('com_abs', prefixe);

    try {
      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(7000) });
      if (!r.ok) {
        // Un 4xx dit « cette parcelle n'existe pas / ces paramètres ne matchent rien » :
        // c'est une réponse SUR le fond, pas une panne. Seuls 429 et 5xx sont des incidents.
        const incident = r.status === 429 || r.status >= 500;
        if (incident) reseauKo = true;
        console.log('[cadastre] HTTP', r.status, 'numero=' + numero, incident ? '(incident)' : '(reponse negative)');
        continue;
      }
      const fc = await r.json();
      const feats = Array.isArray(fc?.features) ? fc.features : [];
      if (feats.length === 0) { console.log('[cadastre] 0 feature numero=' + numero); continue; }

      const geom = feats[0]?.geometry;
      let ring: unknown = null;
      if (geom?.type === 'Polygon') ring = geom.coordinates?.[0];
      else if (geom?.type === 'MultiPolygon') ring = geom.coordinates?.[0]?.[0];
      if (!Array.isArray(ring) || ring.length === 0) continue;

      // Centroide surfacique (formule du polygone) : robuste aux parcelles en L,
      // la ou la moyenne des sommets peut tomber hors de la parcelle.
      let a = 0, cx = 0, cy = 0;
      for (let i = 0, n = ring.length; i < n; i++) {
        const p1 = ring[i] as number[], p2 = ring[(i + 1) % n] as number[];
        if (!Array.isArray(p1) || !Array.isArray(p2)) continue;
        const f = p1[0] * p2[1] - p2[0] * p1[1];
        a += f; cx += (p1[0] + p2[0]) * f; cy += (p1[1] + p2[1]) * f;
      }
      let lon: number, lat: number;
      if (Math.abs(a) > 1e-12) {
        lon = cx / (3 * a); lat = cy / (3 * a);
      } else {
        let sx = 0, sy = 0, n = 0;
        for (const pt of ring as number[][]) {
          if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) { sx += pt[0]; sy += pt[1]; n++; }
        }
        if (n === 0) continue;
        lon = sx / n; lat = sy / n;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      console.log('[cadastre]', codeInsee, section, numero, '-> lat=', lat, 'lon=', lon);
      return { lat, lon, echec: null };
    } catch (e) {
      reseauKo = true;
      console.log('[cadastre] echec numero=' + numero, ':', String(e));
    }
  }

  console.log('[cadastre] aucune geometrie pour', idu, '| reseau=', reseauKo);
  return { lat: null, lon: null, echec: reseauKo ? 'reseau' : 'introuvable_cadastre' };
}

// ─── get_sitadel (branché sur sitadel-commune-v1 via COPILOT_FN_SITADEL) ──
// Dynamique de construction à la maille commune (ODS Sitadel/SDES national).
// Le tool résout l'INSEE (input → contexte → geo.api) ; la fonction lit les 2 jeux ODS.
async function toolSitadel(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.sitadel) {
    return {
      status: 'not_configured', source: 'Sitadel',
      message: "Le service Sitadel n'est pas encore branché (COPILOT_FN_SITADEL non défini). Signale-le sans inventer de chiffre.",
    };
  }

  const ref = resolveParcelRef(input, ctx);

  // 1) Coordonnées : parcelle du contexte → IDU cadastre → centroïde commune.
  let lat = num(input.lat) ?? ref.lat;
  let lon = num(input.lng) ?? ref.lng;
  let precision: 'parcelle' | 'centre_commune' =
    lat != null && lon != null ? 'parcelle' : 'centre_commune';

  let codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
  const commune = str(input.commune) ?? ref.commune ?? (ctx as any).city;
  const zipCode = str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;

  // 1a) Repli IDU → centroïde cadastre (précision parcelle même sans lat/lon au contexte).
  //     On MÉMORISE la cause d'un échec : une référence fournie puis non résolue
  //     ne doit pas se dégrader en silence vers l'échelle communale (dérive de contexte).
  let iduFourni: string | null = null;
  let iduEchec: IduEchec | null = null;
  if (lat == null || lon == null) {
    const idu = str(input.cadastral_ref) ?? str(input.parcel_id) ?? ref.cadastral_ref ?? ref.parcel_id;
    if (idu) {
      iduFourni = idu;
      const c = await parcelCentroidDetaille(idu);
      if (c.echec === null) { lat = c.lat; lon = c.lon; precision = 'parcelle'; }
      else { iduEchec = c.echec; }
    }
  }

  // 1a-bis) Référence MALFORMÉE : le code INSEE dérivé de ses 5 premiers caractères
  //         n'est pas fiable. On refuse plutôt que de répondre sur une autre commune.
  if (iduEchec === 'idu_invalide' && !str(input.code_insee) && !str(input.commune)) {
    return {
      status: 'not_found', source: 'Sitadel',
      message:
        `La référence « ${iduFourni} » n'est pas un identifiant cadastral valide : le code commune qu'on ` +
        `en déduirait ne serait pas fiable. Demande à l'utilisateur de préciser la COMMUNE, et ne réponds ` +
        `sur AUCUN périmètre en attendant.`,
    };
  }

  // 1b) Dernier repli : centroïde commune (INSEE prioritaire, sinon CP, sinon nom) via geo.api.
  if (lat == null || lon == null) {
    const query = codeInsee
      ? `code=${encodeURIComponent(codeInsee)}`
      : zipCode
      ? `codePostal=${encodeURIComponent(zipCode)}`
      : commune
      ? `nom=${encodeURIComponent(commune)}`
      : null;
    if (query) {
      try {
        const r = await fetch(
          `https://geo.api.gouv.fr/communes?${query}&fields=code,centre&limit=1`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (r.ok) {
          const d = await r.json();
          const first = Array.isArray(d) ? d[0] : null;
          if (first) {
            if (!codeInsee && first.code) codeInsee = String(first.code);
            const c = first.centre?.coordinates;
            if (Array.isArray(c) && c.length === 2) { lon = c[0]; lat = c[1]; precision = 'centre_commune'; }
          }
        }
      } catch { /* geo.api injoignable → on continue sans */ }
    }
  }

  // Périmètre effectif de la réponse, à ANNONCER : c'est le garde-fou contre une
  // analyse lue comme parcellaire alors qu'elle est communale.
  const perimetre: Record<string, unknown> = {
    echelle: precision === 'parcelle' ? 'autour de la parcelle' : 'centre de la commune',
    precision,
  };
  if (iduEchec) {
    perimetre.reference_non_resolue = iduFourni;
    perimetre.avertissement =
      iduEchec === 'introuvable_cadastre'
        ? `⚠️ La référence « ${iduFourni} » est INTROUVABLE au cadastre. Ces chiffres portent donc sur la ` +
          `COMMUNE (code dérivé de la référence), PAS sur cette parcelle — dont l'existence n'est pas établie. ` +
          `DIS-LE explicitement à l'utilisateur en tête de réponse et invite-le à vérifier sa référence.`
        : `⚠️ Le service cadastre n'a pas répondu : ces chiffres portent sur la COMMUNE et non sur la ` +
          `parcelle. Signale-le explicitement et propose de réessayer.`;
  }

  console.log('[sitadel] precision=', precision, '| lat=', lat, '| lon=', lon, '| iduEchec=', iduEchec);

  if (lat == null || lon == null) {
    return {
      status: 'not_found', source: 'Sitadel',
      message: "Aucune localisation exploitable (ni coordonnées, ni commune) pour interroger les permis Sitadel.",
    };
  }

  // 2) Paramètres de recherche (bornés comme l'exige promoteur-permis-construire).
  const rayonKm = Math.min(25, Math.max(0.5, num(input.rayon_km) ?? (precision === 'parcelle' ? 3 : 5)));
  const periodMonths = Math.min(120, Math.max(1, Math.trunc(num(input.periode_mois) ?? 24)));

  try {
    // ⚠️ Contrat promoteur-permis-construire : latitude/longitude OBLIGATOIRES.
    //    commune=null volontaire → le rayon capte aussi les permis des communes
    //    voisines (le « projet à côté »), non bridé par la limite administrative.
    const body = {
      latitude: lat,
      longitude: lon,
      radiusKm: rayonKm,
      periodMonths,
      typeAutorisation: 'all',
      typologie: 'all',
      commune: null,
      limit: 100,   // borne maxLimit de promoteur-permis-construire
      offset: 0,
      sortBy: 'date',
      sortOrder: 'desc',
    };
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.sitadel, body);
    const s = summarizeSitadel(raw, { rayonKm, periodMonths, precision });
    // Le périmètre voyage AVEC la donnée : le modèle ne peut plus l'ignorer.
    const data = s.data && typeof s.data === 'object'
      ? { perimetre, ...(s.data as Record<string, unknown>) }
      : { perimetre };
    return { status: s.status, source: INTERNAL_FUNCTIONS.sitadel, data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.sitadel, message: errMsg(e) };
  }
}

// ─── get_etablissements_proches (branché sur etablissements-sirene-v1 via COPILOT_FN_SIRENE) ──
// Établissements immatriculés autour d'un point (API DINUM Recherche d'entreprises,
// token-free). Même cascade de localisation que Sitadel : contexte → IDU cadastre →
// centroïde commune. La fonction renvoie déjà un contrat compact.
async function toolEtablissementsProches(
  input: Record<string, unknown>,
  ctx: MimmozaContext,
): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.sirene) {
    return {
      status: 'not_configured', source: 'SIRENE',
      message: "Le service Établissements (SIRENE) n'est pas encore branché (COPILOT_FN_SIRENE non défini). Signale-le sans inventer d'établissement.",
    };
  }

  const ref = resolveParcelRef(input, ctx);

  // 1) Coordonnées : parcelle du contexte → IDU cadastre → centroïde commune.
  let lat = num(input.lat) ?? ref.lat;
  let lon = num(input.lng) ?? ref.lng;
  let precision: 'parcelle' | 'centre_commune' =
    lat != null && lon != null ? 'parcelle' : 'centre_commune';

  let codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
  const commune = str(input.commune) ?? ref.commune ?? (ctx as any).city;
  const zipCode = str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;

  // 1a) Repli IDU → centroïde cadastre (précision parcelle même sans lat/lon au contexte).
  if (lat == null || lon == null) {
    const idu = str(input.cadastral_ref) ?? str(input.parcel_id) ?? ref.cadastral_ref ?? ref.parcel_id;
    if (idu) {
      const c = await parcelCentroidFromIdu(idu);
      if (c) { lat = c.lat; lon = c.lon; precision = 'parcelle'; }
    }
  }

  // 1b) Dernier repli : centroïde commune (INSEE prioritaire, sinon CP, sinon nom) via geo.api.
  if (lat == null || lon == null) {
    const query = codeInsee
      ? `code=${encodeURIComponent(codeInsee)}`
      : zipCode
      ? `codePostal=${encodeURIComponent(zipCode)}`
      : commune
      ? `nom=${encodeURIComponent(commune)}`
      : null;
    if (query) {
      try {
        const r = await fetch(
          `https://geo.api.gouv.fr/communes?${query}&fields=code,centre&limit=1`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (r.ok) {
          const d = await r.json();
          const first = Array.isArray(d) ? d[0] : null;
          if (first) {
            if (!codeInsee && first.code) codeInsee = String(first.code);
            const c = first.centre?.coordinates;
            if (Array.isArray(c) && c.length === 2) { lon = c[0]; lat = c[1]; precision = 'centre_commune'; }
          }
        }
      } catch { /* geo.api injoignable → on continue sans */ }
    }
  }

  console.log('[sirene] precision=', precision, '| lat=', lat, '| lon=', lon);

  if (lat == null || lon == null) {
    return {
      status: 'not_found', source: 'SIRENE',
      message: "Aucune localisation exploitable (ni coordonnées, ni commune) pour interroger les établissements SIRENE.",
    };
  }

  // 2) Paramètres bornés comme l'exige etablissements-sirene-v1 (radius 0.1–10 km, limit ≤ 30).
  const rayonKm = Math.min(10, Math.max(0.1, num(input.rayon_km) ?? (precision === 'parcelle' ? 1 : 2)));
  const limite = Math.min(30, Math.max(1, Math.trunc(num(input.limite) ?? 15)));
  const section = str(input.section_naf)?.toUpperCase().slice(0, 1);

  try {
    const body: Record<string, unknown> = {
      latitude: lat,
      longitude: lon,
      radius_km: rayonKm,
      limit: limite,
    };
    if (section && /^[A-U]$/.test(section)) body.section = section;

    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.sirene, body);
    const s = summarizeSirene(raw, { rayonKm, precision });
    return { status: s.status, source: INTERNAL_FUNCTIONS.sirene, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.sirene, message: errMsg(e) };
  }
}

// ─── get_equipements_proches (branché sur bpe-proxy via COPILOT_FN_BPE) ──
// Base Permanente des Équipements (INSEE) via OpenDataSoft. Même cascade de
// localisation que SIRENE/Sitadel.
async function toolEquipementsProches(
  input: Record<string, unknown>,
  ctx: MimmozaContext,
): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.bpe) {
    return {
      status: 'not_configured', source: 'BPE',
      message: "Le service Équipements (BPE) n'est pas encore branché (COPILOT_FN_BPE non défini). Signale-le sans inventer d'équipement.",
    };
  }

  const loc = await resolvePointForTool(input, ctx);
  if (!loc) {
    return {
      status: 'not_found', source: 'BPE',
      message: "Aucune localisation exploitable (ni coordonnées, ni commune) pour interroger les équipements.",
    };
  }
  console.log('[bpe] precision=', loc.precision, '| lat=', loc.lat, '| lon=', loc.lon);

  const rayonM = Math.min(20000, Math.max(200,
    num(input.rayon_m) ?? (loc.precision === 'parcelle' ? 1500 : 3000)));

  try {
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.bpe, {
      lat: loc.lat,
      lon: loc.lon,
      radius_m: rayonM,
      limit: 500,
    });
    const s = summarizeBpe(raw, { rayonM, precision: loc.precision });
    return { status: s.status, source: INTERNAL_FUNCTIONS.bpe, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.bpe, message: errMsg(e) };
  }
}

// ─── get_logement_social (branché sur besoin-logements-sociaux via COPILOT_FN_SRU) ──
// Maille COMMUNE. La fonction attend un unique champ { query } : INSEE, CP ou nom.
async function toolLogementSocial(
  input: Record<string, unknown>,
  ctx: MimmozaContext,
): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.sru) {
    return {
      status: 'not_configured', source: 'SRU',
      message: "Le service Logement social n'est pas encore branché (COPILOT_FN_SRU non défini). Signale-le sans inventer de taux.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  const query =
    str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee ??
    str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code ??
    str(input.commune) ?? ref.commune ?? (ctx as any).city ?? null;

  if (!query) {
    return {
      status: 'not_found', source: 'SRU',
      message: 'Aucune commune exploitable (ni code INSEE, ni code postal, ni nom) pour interroger l\'inventaire SRU.',
    };
  }

  try {
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.sru, { query: String(query) });
    const s = summarizeSru(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.sru, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.sru, message: errMsg(e) };
  }
}

// ─── get_contexte_commune (branché sur contexte-commune-v1 via COPILOT_FN_CONTEXTE) ──
async function toolContexteCommune(
  input: Record<string, unknown>,
  ctx: MimmozaContext,
): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.contexte) {
    return {
      status: 'not_configured', source: 'Contexte commune',
      message: "Le service Contexte commune n'est pas encore branché (COPILOT_FN_CONTEXTE non défini). Signale-le sans inventer de contexte.",
    };
  }

  const ref = resolveParcelRef(input, ctx);
  const body: Record<string, unknown> = {
    code_insee: str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee ?? undefined,
    commune:    str(input.commune) ?? ref.commune ?? (ctx as any).city ?? undefined,
    zip_code:   str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code ?? undefined,
  };
  if (!body.code_insee && !body.commune && !body.zip_code) {
    return {
      status: 'not_found', source: 'Contexte commune',
      message: 'Aucune commune exploitable pour récupérer le contexte territorial.',
    };
  }

  try {
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.contexte, body);
    const s = summarizeContexteCommune(raw);
    return { status: s.status, source: INTERNAL_FUNCTIONS.contexte, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.contexte, message: errMsg(e) };
  }
}

// ─── Résolution d'un point (lat/lon) mutualisée par les outils à rayon ──
// Cascade identique à Sitadel/SIRENE : contexte → IDU cadastre → centroïde commune.
async function resolvePointForTool(
  input: Record<string, unknown>,
  ctx: MimmozaContext,
): Promise<{ lat: number; lon: number; precision: 'parcelle' | 'centre_commune' } | null> {
  const ref = resolveParcelRef(input, ctx);

  let lat = num(input.lat) ?? ref.lat;
  let lon = num(input.lng) ?? ref.lng;
  let precision: 'parcelle' | 'centre_commune' =
    lat != null && lon != null ? 'parcelle' : 'centre_commune';

  const codeInsee = str(input.code_insee) ?? ref.code_insee ?? (ctx as any).code_insee;
  const commune = str(input.commune) ?? ref.commune ?? (ctx as any).city;
  const zipCode = str(input.zip_code) ?? ctx.parcel?.code_postal ?? (ctx as any).zip_code;

  if (lat == null || lon == null) {
    const idu = str(input.cadastral_ref) ?? str(input.parcel_id) ?? ref.cadastral_ref ?? ref.parcel_id;
    if (idu) {
      const c = await parcelCentroidFromIdu(idu);
      if (c) { lat = c.lat; lon = c.lon; precision = 'parcelle'; }
    }
  }

  if (lat == null || lon == null) {
    const query = codeInsee
      ? `code=${encodeURIComponent(codeInsee)}`
      : zipCode
      ? `codePostal=${encodeURIComponent(zipCode)}`
      : commune
      ? `nom=${encodeURIComponent(commune)}`
      : null;
    if (query) {
      try {
        const r = await fetch(
          `https://geo.api.gouv.fr/communes?${query}&fields=code,centre&limit=1`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (r.ok) {
          const d = await r.json();
          const first = Array.isArray(d) ? d[0] : null;
          const c = first?.centre?.coordinates;
          if (Array.isArray(c) && c.length === 2) { lon = c[0]; lat = c[1]; precision = 'centre_commune'; }
        }
      } catch { /* geo.api injoignable → on continue sans */ }
    }
  }

  if (lat == null || lon == null) return null;
  return { lat, lon, precision };
}

// ─── Brique GPU (gpu-parcelle-v1 via COPILOT_FN_GPU) ──────────
// ⚠️ PAS DE REPLI CENTRE-COMMUNE ICI, à la différence des outils à rayon : un
// zonage d'urbanisme change d'une parcelle à l'autre. Répondre depuis le centre
// de la commune produirait une réponse fausse avec l'apparence du sérieux —
// même décision que pour les servitudes (servitudes-gpu-v1).
async function resolvePointPrecis(
  input: Record<string, unknown>,
  ctx: MimmozaContext,
): Promise<{ pt: { lat: number; lon: number } | null; echec: IduEchec | null; idu: string | null }> {
  const ref = resolveParcelRef(input, ctx);
  let lat = num(input.lat) ?? ref.lat;
  let lon = num(input.lng) ?? ref.lng;

  let echec: IduEchec | null = null;
  if (lat == null || lon == null) {
    const idu = str(input.cadastral_ref) ?? str(input.parcel_id) ?? ref.cadastral_ref ?? ref.parcel_id;
    if (idu) {
      const c = await parcelCentroidDetaille(idu);
      if (c.echec === null) { lat = c.lat; lon = c.lon; } else { echec = c.echec; }
    }
  }
  if (lat == null || lon == null) return { pt: null, echec, idu: str(input.cadastral_ref) ?? ref.cadastral_ref ?? ref.parcel_id ?? null };
  return { pt: { lat, lon }, echec: null, idu: null };
}

async function callGpu(
  input: Record<string, unknown>,
  ctx: MimmozaContext,
  couches: string[],
  vue: 'zonage' | 'prescriptions',
  source: string,
): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.gpu) {
    return {
      status: 'not_configured', source,
      message: `Le service Urbanisme GPU n'est pas encore branché (COPILOT_FN_GPU non défini). Signale-le sans inventer de zonage ni de règle.`,
    };
  }

  const loc = await resolvePointPrecis(input, ctx);
  if (!loc.pt) {
    const idu = loc.idu ?? 'non fournie';
    const MSG: Record<string, string> = {
      idu_invalide:
        `La référence cadastrale « ${idu} » n'a pas le format d'un identifiant parcellaire français ` +
        `(14 caractères : INSEE sur 5, préfixe sur 3, section sur 2, numéro sur 4 — ex. 64065000AI0002). ` +
        `Demande à l'utilisateur de vérifier sa saisie. N'avance aucun zonage.`,
      introuvable_cadastre:
        `La référence cadastrale « ${idu} » est bien formée mais INTROUVABLE au cadastre (API Carto/IGN) : ` +
        `elle n'existe pas, elle a été renumérotée après division ou fusion, ou la commune n'est pas couverte ` +
        `par le plan cadastral informatisé. Dis-le clairement — c'est un problème de RÉFÉRENCE, pas de PLU : ` +
        `n'invite PAS l'utilisateur à chercher des coordonnées GPS, demande-lui de vérifier la référence. ` +
        `Ne conclus RIEN sur la constructibilité.`,
      reseau:
        `Le service cadastre (API Carto/IGN) n'a pas répondu : impossible de convertir « ${idu} » en coordonnées. ` +
        `C'est une panne temporaire, pas une information sur le terrain. Propose de réessayer. N'avance aucun zonage.`,
    };
    return {
      status: 'not_found', source,
      message: (loc.echec && MSG[loc.echec]) ??
        ("Localisation précise indisponible (ni coordonnées, ni identifiant cadastral). " +
         "Le zonage d'urbanisme se lit au point : il ne peut PAS être approché par le centre de la commune. " +
         "Demande à l'utilisateur d'ouvrir une parcelle ou de préciser l'adresse, et n'avance aucun zonage."),
    };
  }
  const pt = loc.pt;

  console.log('[gpu]', vue, '| lat=', pt.lat, '| lon=', pt.lon);

  try {
    const body: Record<string, unknown> = {
      latitude: pt.lat,
      longitude: pt.lon,
      couches,
    };
    const lim = num(input.limite);
    if (lim != null) body.limite = Math.min(40, Math.max(1, Math.trunc(lim)));

    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.gpu, body);
    const s = summarizeGpu(raw, vue);
    return { status: s.status, source: INTERNAL_FUNCTIONS.gpu, data: s.data, message: s.message };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.gpu, message: errMsg(e) };
  }
}

// =============================================================
// VERBES — outils d'ACTION (écriture)
// -------------------------------------------------------------
// Trois règles non négociables, valables pour tout verbe futur :
//   1. L'identité vient du JWT vérifié (AuthCtx), jamais de ctx.user.
//   2. L'écriture passe par getUserClient(authHeader) : le RLS s'applique.
//      getAdmin() ici court-circuiterait toutes les politiques de sécurité.
//   3. Aucune écriture sans `confirmer: true` : le premier appel ne fait que
//      décrire ce qui serait écrit. Le modèle doit obtenir un accord explicite
//      entre les deux appels.
// =============================================================

function refuseSansIdentite(source: string): ToolResult {
  return {
    status: 'error', source,
    message:
      "Action impossible : l'utilisateur n'est pas authentifié pour cette requête. " +
      "N'invente pas de confirmation et ne prétends pas que l'action a été réalisée.",
  };
}

// Résout commune → { code_insee, nom, lat, lng } via geo.api.gouv.fr.
async function resoudreCommune(
  nom?: string, insee?: string,
): Promise<{ code: string; nom: string; cp?: string; lat?: number; lng?: number } | null> {
  const query = insee
    ? `code=${encodeURIComponent(insee)}`
    : nom
    ? `nom=${encodeURIComponent(nom)}&boost=population`
    : null;
  if (!query) return null;
  try {
    const r = await fetch(
      `https://geo.api.gouv.fr/communes?${query}&fields=code,nom,centre,codesPostaux&limit=1`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!r.ok) return null;
    const d = await r.json();
    const c = Array.isArray(d) ? d[0] : null;
    if (!c?.code) return null;
    const xy = c.centre?.coordinates;
    const cps = Array.isArray(c.codesPostaux) ? c.codesPostaux : [];
    return {
      code: String(c.code), nom: String(c.nom ?? nom ?? ''),
      cp: cps.length ? String(cps[0]) : undefined,
      lng: Array.isArray(xy) ? xy[0] : undefined,
      lat: Array.isArray(xy) ? xy[1] : undefined,
    };
  } catch { return null; }
}

async function toolCreerZoneVeille(
  input: Record<string, unknown>, ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Zones de veille Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);

  const nomCommune = str(input.commune) ?? ctx.parcel?.commune ?? (ctx as any).city;
  const inseeIn    = str(input.code_insee) ?? ctx.parcel?.code_insee;
  const commune = await resoudreCommune(nomCommune, inseeIn);
  if (!commune) {
    return {
      status: 'not_found', source: SOURCE,
      message:
        `Commune « ${nomCommune ?? inseeIn ?? 'non précisée'} » introuvable au référentiel officiel. ` +
        `Demande à l'utilisateur de préciser la commune (ou son code INSEE). Ne crée RIEN.`,
    };
  }

  const rayon = num(input.rayon_m);
  const rayonM = rayon != null ? Math.min(50000, Math.max(100, Math.trunc(rayon))) : null;
  const lat = num(input.lat) ?? ctx.parcel?.lat ?? commune.lat ?? null;
  const lng = num(input.lng) ?? ctx.parcel?.lng ?? commune.lng ?? null;
  const libelle = str(input.libelle) ?? commune.nom;

  const ligne = {
    user_id: auth.userId,
    label: libelle,
    city: commune.nom,
    insee_code: commune.code,
    lat, lng,
    radius_m: rayonM,
    is_active: true,
  };

  // ── Temps 1 : APERÇU, aucune écriture ────────────────────────
  if (input.confirmer !== true) {
    return {
      status: 'ok', source: SOURCE,
      data: {
        confirmation_requise: true,
        action: 'création d\'une zone de veille',
        apercu: {
          libelle, commune: commune.nom, code_insee: commune.code,
          rayon_m: rayonM, centre: lat != null && lng != null ? { lat, lng } : null,
          precision_centre: num(input.lat) != null ? 'point fourni'
            : ctx.parcel?.lat != null ? 'parcelle ouverte' : 'centre de la commune',
        },
        note:
          "RIEN N'A ÉTÉ CRÉÉ. Présente cet aperçu à l'utilisateur et demande-lui de valider. " +
          "Rappelle-lui le rayon retenu et l'origine du centre : s'il visait un secteur précis et " +
          "que le centre est celui de la commune, propose-lui d'ouvrir la parcelle ou de préciser " +
          "un point. Rappelle UNIQUEMENT après son accord explicite, avec confirmer: true.",
      },
    };
  }

  // ── Temps 2 : écriture, sous l'identité de l'utilisateur ─────
  try {
    const db = getUserClient(auth.authHeader);
    const { data, error } = await db.from('watch_zones').insert(ligne).select().single();
    if (error) throw new Error(error.message);
    console.log('[verbe] zone de veille creee', data?.id, commune.code);
    return {
      status: 'ok', source: SOURCE,
      data: {
        cree: true, zone_id: data?.id, libelle, commune: commune.nom,
        code_insee: commune.code, rayon_m: rayonM,
        note: "Zone créée. Annonce-le, cite l'identifiant, et rappelle qu'elle peut être désactivée à tout moment.",
      },
    };
  } catch (e) {
    return {
      status: 'error', source: SOURCE,
      message:
        `Création refusée par la base : ${errMsg(e)}. La zone n'a PAS été créée — dis-le clairement ` +
        `et ne prétends pas le contraire. Si le message évoque une politique de sécurité (RLS), ` +
        `c'est que la session de l'utilisateur n'autorise pas cette écriture.`,
    };
  }
}

// Le moteur de rapprochement des watchlists tourne-t-il encore ? On ne le
// DÉCLARE pas, on le CONSTATE : dernier rapprochement observé en base. Sans
// cela, le copilote promet des alertes que rien ne produit — c'est arrivé.
async function dernierRapprochementWatchlist(db: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await db.from('user_watchlist_matches')
      .select('last_matched_at').order('last_matched_at', { ascending: false }).limit(1);
    if (error) return null;
    const v = (data ?? [])[0]?.last_matched_at;
    return typeof v === 'string' ? v : null;
  } catch { return null; }
}

function noteRapprochement(dernier: string | null): string {
  if (!dernier) {
    return "⚠️ AUCUN rapprochement n'a jamais été enregistré : les critères sont MÉMORISÉS, mais " +
           "aucune alerte automatique n'est produite à ce jour. DIS-LE explicitement — ne promets " +
           "PAS à l'utilisateur qu'il « sera alerté ».";
  }
  const jours = Math.round((Date.now() - Date.parse(dernier)) / 86400000);
  if (!Number.isFinite(jours)) return '';
  if (jours > 14) {
    return `⚠️ Le dernier rapprochement de watchlist remonte à ${jours} jours (${dernier.slice(0, 10)}). ` +
           `Le moteur d'alerte semble à l'arrêt : les critères sont bien mémorisés, mais ne promets PAS ` +
           `d'alerte automatique — signale que le rapprochement n'a pas tourné récemment.`;
  }
  return `Dernier rapprochement il y a ${jours} jour(s) : le moteur d'alerte tourne.`;
}

async function toolCreerWatchlist(
  input: Record<string, unknown>, ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Watchlists Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);

  const noms = Array.isArray(input.communes)
    ? input.communes.map((c) => String(c).trim()).filter(Boolean)
    : str(input.communes) ? [String(input.communes).trim()] : [];
  if (noms.length === 0 && ctx.parcel?.commune) noms.push(ctx.parcel.commune);

  if (noms.length === 0) {
    return {
      status: 'not_found', source: SOURCE,
      message:
        "Aucune commune fournie. Une watchlist s'attache à UNE commune : demande à l'utilisateur " +
        "lesquelles l'intéressent. S'il a cité un département ou une région, explique-lui que la " +
        "recherche se définit commune par commune et propose de lui en créer plusieurs d'un coup. " +
        "Ne choisis PAS les communes à sa place. Ne crée RIEN.",
    };
  }
  if (noms.length > 15) {
    return {
      status: 'not_found', source: SOURCE,
      message: `${noms.length} communes demandées : c'est trop pour une seule opération (maximum 15). Propose à l'utilisateur de resserrer sa sélection.`,
    };
  }

  // Résolution officielle : une commune inconnue est signalée, pas devinée.
  const resolues: { nom: string; cp?: string; code: string }[] = [];
  const introuvables: string[] = [];
  for (const n of noms) {
    const c = await resoudreCommune(n);
    if (c) resolues.push({ nom: c.nom, cp: c.cp, code: c.code });
    else introuvables.push(n);
  }
  if (resolues.length === 0) {
    return {
      status: 'not_found', source: SOURCE,
      message: `Aucune de ces communes n'est reconnue au référentiel officiel : ${introuvables.join(', ')}. Demande à l'utilisateur de vérifier l'orthographe. Ne crée RIEN.`,
    };
  }

  const typeBien   = str(input.type_bien) ?? null;
  const prixMin    = num(input.prix_min) ?? null;
  const prixMax    = num(input.prix_max) ?? null;
  const surfMin    = num(input.surface_min) ?? null;
  const surfMax    = num(input.surface_max) ?? null;
  const scoreMinBr = num(input.score_min);
  const scoreMin   = scoreMinBr != null ? Math.min(100, Math.max(0, Math.trunc(scoreMinBr))) : null;
  const base       = str(input.libelle) ?? (typeBien ? `Recherche ${typeBien}` : 'Recherche');

  // Incohérences signalées AVANT l'écriture : un min supérieur au max ne
  // remontera jamais aucun bien, et l'utilisateur attendrait pour rien.
  const alertes: string[] = [];
  if (prixMin != null && prixMax != null && prixMin > prixMax) alertes.push('prix minimum supérieur au prix maximum');
  if (surfMin != null && surfMax != null && surfMin > surfMax) alertes.push('surface minimale supérieure à la surface maximale');
  if (alertes.length) {
    return {
      status: 'not_found', source: SOURCE,
      message: `Critères incohérents (${alertes.join(' ; ')}) : cette recherche ne remonterait jamais aucun bien. Fais corriger avant de créer quoi que ce soit.`,
    };
  }

  const lignes = resolues.map((c) => ({
    user_id: auth.userId,
    name: resolues.length > 1 ? `${base} — ${c.nom}` : base,
    city: c.nom,
    zip_code: c.cp ?? null,
    property_type: typeBien,
    min_price: prixMin, max_price: prixMax,
    min_surface_m2: surfMin, max_surface_m2: surfMax,
    min_opportunity_score: scoreMin,
    is_active: true,
  }));

  if (input.confirmer !== true) {
    return {
      status: 'ok', source: SOURCE,
      data: {
        confirmation_requise: true,
        action: `création de ${lignes.length} watchlist(s) de biens`,
        apercu: lignes.map((l) => ({
          libelle: l.name, commune: l.city, code_postal: l.zip_code,
          type_bien: l.property_type, prix: [l.min_price, l.max_price],
          surface_m2: [l.min_surface_m2, l.max_surface_m2], score_min: l.min_opportunity_score,
        })),
        communes_introuvables: introuvables.length ? introuvables : undefined,
        note:
          "RIEN N'A ÉTÉ CRÉÉ. Présente la liste et fais valider." +
          (introuvables.length
            ? ` ⚠️ SIGNALE que ces communes n'ont pas été reconnues et seront IGNORÉES : ${introuvables.join(', ')}.`
            : '') +
          " Rappelle ensuite avec confirmer: true.",
      },
    };
  }

  try {
    const db = getUserClient(auth.authHeader);
    const { data, error } = await db.from('user_watchlists').insert(lignes).select('id, name, city');
    if (error) throw new Error(error.message);
    console.log('[verbe] watchlists creees', (data ?? []).length);
    const dernier = await dernierRapprochementWatchlist(db);
    return {
      status: 'ok', source: SOURCE,
      data: {
        creees: (data ?? []).length, watchlists: data,
        communes_ignorees: introuvables.length ? introuvables : undefined,
        dernier_rapprochement: dernier,
        note_alerte: noteRapprochement(dernier),
      },
    };
  } catch (e) {
    return {
      status: 'error', source: SOURCE,
      message: `Création refusée par la base : ${errMsg(e)}. AUCUNE watchlist n'a été créée — dis-le clairement.`,
    };
  }
}

async function toolListerWatchlists(
  input: Record<string, unknown>, _ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Watchlists Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);
  try {
    const db = getUserClient(auth.authHeader);
    let q = db.from('user_watchlists')
      .select('id, name, city, zip_code, property_type, min_price, max_price, min_surface_m2, max_surface_m2, min_opportunity_score, is_active, created_at')
      .order('created_at', { ascending: false }).limit(50);
    if (input.inclure_inactives !== true) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const w = data ?? [];
    if (w.length === 0) {
      return {
        status: 'not_found', source: SOURCE,
        message: "Aucune watchlist de biens" + (input.inclure_inactives === true ? '' : ' active') +
                 ". Cela ne dit RIEN des zones de veille ni des veilles appels d'offres, qui ont leurs propres outils.",
      };
    }
    const dernier = await dernierRapprochementWatchlist(db);
    return { status: 'ok', source: SOURCE,
             data: { total: w.length, watchlists: w, dernier_rapprochement: dernier, note_alerte: noteRapprochement(dernier) } };
  } catch (e) {
    return { status: 'error', source: SOURCE, message: errMsg(e) };
  }
}

async function toolDesactiverWatchlist(
  input: Record<string, unknown>, _ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Watchlists Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);

  const id = str(input.watchlist_id);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !UUID_RE.test(id)) {
    return { status: 'not_found', source: SOURCE,
             message: "Identifiant absent ou invalide. Appelle lister_watchlists pour l'obtenir — ne l'invente pas." };
  }

  const db = getUserClient(auth.authHeader);
  let wl: Record<string, unknown> | null = null;
  try {
    const { data, error } = await db.from('user_watchlists')
      .select('id, name, city, property_type, is_active').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    wl = data ?? null;
  } catch (e) {
    return { status: 'error', source: SOURCE, message: errMsg(e) };
  }
  if (!wl) {
    return { status: 'not_found', source: SOURCE,
             message: `Aucune watchlist accessible sous l'identifiant ${id}. Ne prétends pas l'avoir désactivée.` };
  }
  if (wl.is_active === false) {
    return { status: 'ok', source: SOURCE, data: { deja_inactive: true, watchlist: wl },
             message: "Cette watchlist est déjà désactivée." };
  }

  if (input.confirmer !== true) {
    return {
      status: 'ok', source: SOURCE,
      data: { confirmation_requise: true, action: 'désactivation d\'une watchlist', watchlist: wl,
              note: "RIEN N'A ÉTÉ MODIFIÉ. Fais valider, puis rappelle avec confirmer: true." },
    };
  }

  try {
    const { error } = await db.from('user_watchlists')
      .update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw new Error(error.message);
    return { status: 'ok', source: SOURCE, data: { desactivee: true, watchlist_id: id, watchlist: wl } };
  } catch (e) {
    return { status: 'error', source: SOURCE,
             message: `Désactivation refusée : ${errMsg(e)}. La watchlist est TOUJOURS active.` };
  }
}

const AO_CATEGORIES = ['foncier', 'travaux', 'moe'] as const;

async function toolCreerVeilleAo(
  input: Record<string, unknown>, ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Veilles appels d\'offres Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);

  // Départements : 2 chiffres, Corse, ou DOM sur 3.
  const depsBruts = Array.isArray(input.departements)
    ? input.departements
    : str(input.departements) ? String(input.departements).split(/[,;\s]+/) : [];
  const departements: string[] = [];
  for (const d of depsBruts) {
    const m = /^(2[AB]|\d{2,3})$/i.exec(String(d).trim().toUpperCase());
    if (m && !departements.includes(m[1])) departements.push(m[1]);
  }
  // Repli sur le contexte : la parcelle ouverte donne le département.
  if (departements.length === 0) {
    const insee = ctx.parcel?.code_insee;
    if (insee && /^\d{2}/.test(insee)) departements.push(insee.slice(0, 2));
  }

  const cats = Array.isArray(input.categories)
    ? input.categories.map((c) => String(c).toLowerCase().trim())
        .filter((c) => (AO_CATEGORIES as readonly string[]).includes(c))
    : [];
  const categories = cats.length ? [...new Set(cats)] : [...AO_CATEGORIES];

  const texte = str(input.texte) ?? null;
  const frequence = str(input.frequence) === 'weekly' ? 'weekly' : 'daily';
  const libelle = str(input.libelle) ?? 'Veille appels d\'offres';

  // Contrainte de portée, vérifiée AVANT l'aperçu : mieux vaut l'expliquer que
  // laisser la base refuser une insertion que l'utilisateur croyait validée.
  if (departements.length === 0 && !texte) {
    return {
      status: 'not_found', source: SOURCE,
      message:
        "Cette veille n'a aucune portée : ni département, ni mots-clés. Elle balaierait la France " +
        "entière à chaque passage. Demande à l'utilisateur sur quels départements il veut être " +
        "alerté, ou quels mots-clés l'intéressent. Ne crée RIEN.",
    };
  }

  const ligne = {
    user_id: auth.userId, label: libelle, departements, categories,
    texte, jours_min: 0, frequency: frequence,
    notify_inapp: true, notify_email: false, is_active: true,
  };

  if (input.confirmer !== true) {
    return {
      status: 'ok', source: SOURCE,
      data: {
        confirmation_requise: true,
        action: 'création d\'une veille APPELS D\'OFFRES (marchés publics, pas immobilier)',
        apercu: {
          libelle, departements: departements.length ? departements : 'aucun (recherche par mots-clés)',
          categories, texte, frequence,
        },
        note:
          "RIEN N'A ÉTÉ CRÉÉ. Présente l'aperçu et fais valider. VÉRIFIE au passage que l'utilisateur " +
          "voulait bien une veille APPELS D'OFFRES et non une veille IMMOBILIÈRE : les deux se " +
          "demandent avec les mêmes mots. Rappelle ensuite avec confirmer: true.",
      },
    };
  }

  try {
    const db = getUserClient(auth.authHeader);
    const { data, error } = await db.from('ao_watches').insert(ligne).select().single();
    if (error) throw new Error(error.message);
    console.log('[verbe] veille AO creee', data?.id, departements.join('/'));
    return {
      status: 'ok', source: SOURCE,
      data: { cree: true, veille_id: data?.id, libelle, departements, categories, texte, frequence },
    };
  } catch (e) {
    return {
      status: 'error', source: SOURCE,
      message: `Création refusée par la base : ${errMsg(e)}. La veille n'a PAS été créée — dis-le clairement.`,
    };
  }
}

async function toolDesactiverVeilleAo(
  input: Record<string, unknown>, _ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Veilles appels d\'offres Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);

  const id = str(input.veille_id);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !UUID_RE.test(id)) {
    return {
      status: 'not_found', source: SOURCE,
      message: "Identifiant de veille absent ou invalide. Appelle lister_veilles_appels_offres pour l'obtenir — ne l'invente pas.",
    };
  }

  const db = getUserClient(auth.authHeader);
  let veille: Record<string, unknown> | null = null;
  try {
    const { data, error } = await db.from('ao_watches')
      .select('id, label, departements, categories, texte, is_active').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    veille = data ?? null;
  } catch (e) {
    return { status: 'error', source: SOURCE, message: errMsg(e) };
  }
  if (!veille) {
    return {
      status: 'not_found', source: SOURCE,
      message: `Aucune veille appels d'offres accessible sous l'identifiant ${id}. Ne prétends pas l'avoir désactivée.`,
    };
  }
  if (veille.is_active === false) {
    return { status: 'ok', source: SOURCE, data: { deja_inactive: true, veille },
             message: "Cette veille est déjà désactivée : aucune action nécessaire." };
  }

  if (input.confirmer !== true) {
    return {
      status: 'ok', source: SOURCE,
      data: {
        confirmation_requise: true,
        action: 'désactivation d\'une veille APPELS D\'OFFRES', veille,
        note: "RIEN N'A ÉTÉ MODIFIÉ. Fais valider, puis rappelle avec confirmer: true. Réversible : la veille n'est pas supprimée.",
      },
    };
  }

  try {
    const { error } = await db.from('ao_watches')
      .update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw new Error(error.message);
    console.log('[verbe] veille AO desactivee', id);
    return { status: 'ok', source: SOURCE, data: { desactivee: true, veille_id: id, veille } };
  } catch (e) {
    return { status: 'error', source: SOURCE,
             message: `Désactivation refusée : ${errMsg(e)}. La veille est TOUJOURS active.` };
  }
}

async function toolNouveautesAo(
  input: Record<string, unknown>, _ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Veilles appels d\'offres Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);

  const limite = Math.min(50, Math.max(1, Math.trunc(num(input.limite) ?? 20)));

  try {
    const db = getUserClient(auth.authHeader);
    let q = db.from('ao_watch_events')
      .select('id, avis_id, objet, acheteur, url, departements, zone_incertaine, date_limite, is_read, created_at, ao_watches(label)')
      .order('date_limite', { ascending: true, nullsFirst: false })
      .limit(limite);
    if (input.inclure_lues !== true) q = q.eq('is_read', false);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const lignes = data ?? [];
    if (lignes.length === 0) {
      return {
        status: 'not_found', source: SOURCE,
        message:
          "Aucune nouveauté" + (input.inclure_lues === true ? '' : ' non lue') + " sur les veilles " +
          "appels d'offres. Si l'utilisateur s'en étonne, vérifie avec lister_veilles_appels_offres " +
          "qu'il a bien une veille ACTIVE : une veille absente ou désactivée ne produit rien, ce qui " +
          "n'est pas la même chose qu'une absence d'opportunité.",
      };
    }

    // jours_restants est RECALCULÉ ici : la valeur stockée date du passage de la
    // veille et a pu vieillir de plusieurs jours. Une date limite dépassée doit
    // se voir, pas se déduire.
    const maintenant = Date.now();
    const avis = lignes.map((r: any) => {
      const t = r.date_limite ? Date.parse(r.date_limite) : NaN;
      const jours = Number.isFinite(t) ? Math.round((t - maintenant) / 86400000) : null;
      return {
        id: r.avis_id,
        veille: r.ao_watches?.label ?? null,
        objet: r.objet, acheteur: r.acheteur,
        departements_diffusion: r.departements,
        zone_incertaine: r.zone_incertaine === true,
        date_limite: r.date_limite,
        jours_restants: jours,
        expire: jours != null && jours < 0,
        deja_lu: r.is_read === true,
        lien_markdown: r.url ? `[Avis ${r.avis_id}](${r.url})` : null,
      };
    });

    const expires = avis.filter((a) => a.expire).length;
    const urgents = avis.filter((a) => !a.expire && a.jours_restants != null && a.jours_restants <= 3).length;
    const flous = avis.filter((a) => a.zone_incertaine).length;

    return {
      status: 'ok', source: SOURCE,
      data: {
        total: avis.length, expires, urgents, zone_incertaine: flous, avis,
        note:
          (expires ? `⚠️ ${expires} avis dont la DATE LIMITE EST DÉPASSÉE depuis le passage de la veille : signale-les comme tels, ne les présente pas comme des opportunités ouvertes. ` : '') +
          (urgents ? `⚠️ ${urgents} avis à 3 jours ou moins de la clôture : mets-les en tête. ` : '') +
          (flous ? `⚠️ ${flous} avis à zone d'exécution incertaine. ` : '') +
          "Propose ensuite de les marquer comme lus, sans le faire de ta propre initiative.",
      },
    };
  } catch (e) {
    return { status: 'error', source: SOURCE, message: errMsg(e) };
  }
}

async function toolMarquerNouveautesLues(
  input: Record<string, unknown>, _ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Veilles appels d\'offres Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);

  const ids = Array.isArray(input.avis_ids)
    ? input.avis_ids.map((v) => String(v)).filter(Boolean).slice(0, 200)
    : null;

  try {
    const db = getUserClient(auth.authHeader);
    let q = db.from('ao_watch_events').update({ is_read: true }).eq('is_read', false);
    if (ids && ids.length) q = q.in('avis_id', ids);
    const { data, error } = await q.select('avis_id');
    if (error) throw new Error(error.message);
    const n = (data ?? []).length;
    return {
      status: 'ok', source: SOURCE,
      data: { marques: n, portee: ids && ids.length ? 'sélection' : 'toutes les non lues' },
      message: n === 0
        ? "Aucune nouveauté n'était à marquer : elles étaient déjà lues."
        : `${n} nouveauté(s) marquée(s) comme lue(s).`,
    };
  } catch (e) {
    return { status: 'error', source: SOURCE,
             message: `Marquage refusé : ${errMsg(e)}. Rien n'a été modifié.` };
  }
}

async function toolListerVeillesAo(
  input: Record<string, unknown>, _ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Veilles appels d\'offres Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);
  try {
    const db = getUserClient(auth.authHeader);
    let q = db.from('ao_watches')
      .select('id, label, departements, categories, texte, frequency, is_active, last_run_at, created_at')
      .order('created_at', { ascending: false }).limit(50);
    if (input.inclure_inactives !== true) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const v = data ?? [];
    if (v.length === 0) {
      return {
        status: 'not_found', source: SOURCE,
        message: "Aucune veille appels d'offres" + (input.inclure_inactives === true ? '' : ' active') +
                 ". Propose d'en créer une, sans le faire de ta propre initiative.",
      };
    }
    return { status: 'ok', source: SOURCE, data: { total: v.length, veilles: v } };
  } catch (e) {
    return { status: 'error', source: SOURCE, message: errMsg(e) };
  }
}

async function toolListerZonesVeille(
  input: Record<string, unknown>, _ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Zones de veille Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);

  try {
    const db = getUserClient(auth.authHeader);
    let q = db.from('watch_zones')
      .select('id, label, city, insee_code, lat, lng, radius_m, is_active, created_at')
      .order('created_at', { ascending: false }).limit(50);
    if (input.inclure_inactives !== true) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const zones = data ?? [];
    if (zones.length === 0) {
      return {
        status: 'not_found', source: SOURCE,
        message: "L'utilisateur n'a aucune zone de veille" +
          (input.inclure_inactives === true ? '.' : ' active.') +
          " Propose-lui d'en créer une avec creer_zone_veille, sans le faire de ta propre initiative.",
      };
    }
    return { status: 'ok', source: SOURCE, data: { total: zones.length, zones } };
  } catch (e) {
    return { status: 'error', source: SOURCE, message: errMsg(e) };
  }
}

async function toolDesactiverZoneVeille(
  input: Record<string, unknown>, _ctx: MimmozaContext, auth: AuthCtx | null,
): Promise<ToolResult> {
  const SOURCE = 'Zones de veille Mimmoza';
  if (!auth?.userId || !auth.authHeader) return refuseSansIdentite(SOURCE);

  const id = str(input.zone_id);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || !UUID_RE.test(id)) {
    return {
      status: 'not_found', source: SOURCE,
      message: "Identifiant de zone absent ou invalide. Appelle lister_zones_veille pour l'obtenir — ne l'invente pas.",
    };
  }

  const db = getUserClient(auth.authHeader);

  // On relit la zone AVANT : l'aperçu doit décrire ce qui existe vraiment, pas
  // ce que le modèle croit avoir compris.
  let zone: Record<string, unknown> | null = null;
  try {
    const { data, error } = await db.from('watch_zones')
      .select('id, label, city, insee_code, radius_m, is_active').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    zone = data ?? null;
  } catch (e) {
    return { status: 'error', source: SOURCE, message: errMsg(e) };
  }
  if (!zone) {
    return {
      status: 'not_found', source: SOURCE,
      message: `Aucune zone de veille accessible sous l'identifiant ${id} (inexistante, ou appartenant à un autre utilisateur). Ne prétends pas l'avoir désactivée.`,
    };
  }
  if (zone.is_active === false) {
    return { status: 'ok', source: SOURCE, data: { deja_inactive: true, zone },
             message: "Cette zone est déjà désactivée : aucune action nécessaire." };
  }

  if (input.confirmer !== true) {
    return {
      status: 'ok', source: SOURCE,
      data: {
        confirmation_requise: true, action: 'désactivation d\'une zone de veille', zone,
        note: "RIEN N'A ÉTÉ MODIFIÉ. Fais valider par l'utilisateur, puis rappelle avec confirmer: true. La désactivation est réversible : la zone n'est pas supprimée.",
      },
    };
  }

  try {
    const { error } = await db.from('watch_zones')
      .update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw new Error(error.message);
    console.log('[verbe] zone de veille desactivee', id);
    return { status: 'ok', source: SOURCE, data: { desactivee: true, zone_id: id, zone } };
  } catch (e) {
    return { status: 'error', source: SOURCE,
             message: `Désactivation refusée par la base : ${errMsg(e)}. La zone est TOUJOURS active.` };
  }
}

// ─── get_appels_offres (branché sur appels-offres-v1 via COPILOT_FN_APPELS_OFFRES) ──
// Avis BOAMP encore ouverts. Aucun ancrage géographique implicite : si le modèle
// ne passe pas de département, la recherche est nationale et le résultat le dit
// (règle 4vicies — le périmètre d'une réponse s'annonce, il ne se devine pas).
async function toolAppelsOffres(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  if (!INTERNAL_FUNCTIONS.appels_offres) {
    return {
      status: 'not_configured', source: 'BOAMP',
      message: "Le service Appels d'offres n'est pas encore branché (COPILOT_FN_APPELS_OFFRES non défini). Signale-le sans inventer d'avis.",
    };
  }

  const body: Record<string, unknown> = {};
  if (Array.isArray(input.departements)) body.departements = input.departements;
  else if (str(input.departements)) body.departements = str(input.departements);
  if (Array.isArray(input.categories)) body.categories = input.categories;
  if (str(input.texte)) body.texte = str(input.texte);
  const lim = num(input.limite);
  if (lim != null) body.limite = Math.min(50, Math.max(1, Math.trunc(lim)));
  const jm = num(input.jours_min);
  if (jm != null) body.jours_min = Math.max(0, Math.trunc(jm));

  console.log('[boamp]', JSON.stringify(body));

  try {
    const raw = await callInternalFunction(INTERNAL_FUNCTIONS.appels_offres, body) as Record<string, unknown>;
    const st = str(raw?.status) ?? 'ok';
    return {
      status: st === 'ok' ? 'ok' : st === 'no_data' ? 'not_found' : 'error',
      source: INTERNAL_FUNCTIONS.appels_offres,
      data: { perimetre: body.departements ? { echelle: 'départements', valeur: body.departements } : { echelle: 'France entière' }, ...raw },
      message: str(raw?.summary),
    };
  } catch (e) {
    return { status: 'error', source: INTERNAL_FUNCTIONS.appels_offres, message: errMsg(e) };
  }
}

async function toolZonagePlu(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  return await callGpu(input, ctx, ['municipality', 'zone-urba'], 'zonage', 'Zonage PLU (GPU)');
}

async function toolPrescriptionsUrbanisme(input: Record<string, unknown>, ctx: MimmozaContext): Promise<ToolResult> {
  return await callGpu(
    input, ctx,
    ['prescription-surf', 'prescription-lin', 'prescription-pct', 'info-surf'],
    'prescriptions', 'Prescriptions d\'urbanisme (GPU)',
  );
}

// ─── get_quick_market_insight (LOT 5) ────────────────────────
// Lecture directe de la vue SQL public.v_quick_questions_mvp via getAdmin().
// Stratégie de matching : listing_id → url → city+zip_code+price+surface (±2%).
// Le calcul est DÉJÀ fait en SQL : le LLM présente, ne recalcule pas.
async function toolQuickMarketInsight(
  input: Record<string, unknown>,
  ctx: MimmozaContext,
): Promise<ToolResult> {
  const qi: QuickMarketInput = {
    listing_id: str(input.listing_id) ?? (ctx as any).listing_id,
    url:        str(input.url)        ?? (ctx as any).url,
    city:       str(input.city)       ?? (ctx as any).city,
    zip_code:   str(input.zip_code)   ?? (ctx as any).zip_code,
    price:      num(input.price)      ?? (ctx as any).price,
    surface:    num(input.surface)    ?? (ctx as any).surface,
  };

  const SELECT_FIELDS = [
    'id', 'portal', 'listing_portal_id', 'url', 'city', 'zip_code',
    'price', 'surface', 'computed_price_m2', 'median_price_m2',
    'listings_count', 'ecart_marche_pct', 'position_marche',
    'profondeur_marche', 'confidence_level', 'is_discount_opportunity',
    'is_market_coherent', 'has_liquid_market', 'quick_verdict', 'quick_payload',
  ].join(', ');

  const db = getAdmin();
  let row: Record<string, any> | null = null;

  try {
    // ── Stratégie 1 : par listing_id (UUID valide uniquement) ─
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (qi.listing_id && UUID_RE.test(qi.listing_id)) {
      const { data, error } = await db
        .from('v_quick_questions_mvp').select(SELECT_FIELDS)
        .eq('id', qi.listing_id).maybeSingle();
      if (error) throw new Error(error.message);
      if (data) row = data;
    }

    // ── Stratégie 2 : par url ──────────────────────────────────
    if (!row && qi.url) {
      const { data, error } = await db
        .from('v_quick_questions_mvp').select(SELECT_FIELDS)
        .eq('url', qi.url).maybeSingle();
      if (error) throw new Error(error.message);
      if (data) row = data;
    }

    // ── Stratégie 3 : city + zip + price + surface (±2%) ──────
    if (!row && qi.city && qi.zip_code && qi.price != null && qi.surface != null) {
      const { data, error } = await db
        .from('v_quick_questions_mvp').select(SELECT_FIELDS)
        .ilike('city', qi.city.trim())
        .eq('zip_code', qi.zip_code.trim())
        .gte('price', qi.price * 0.98).lte('price', qi.price * 1.02)
        .gte('surface', qi.surface * 0.98).lte('surface', qi.surface * 1.02)
        .limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      if (data) row = data;
    }

    // ── Stratégie 4 (fallback) : médiane marché city+zip ──────
    // Le bien est saisi manuellement (pas ingéré depuis un portail).
    // On récupère la médiane marché de la ville pour calculer la position.
    if (!row && qi.city && qi.zip_code && qi.price != null && qi.surface != null) {
      const { data, error } = await db
        .from('v_quick_questions_mvp').select('median_price_m2, listings_count, profondeur_marche, has_liquid_market')
        .ilike('city', qi.city.trim())
        .eq('zip_code', qi.zip_code.trim())
        .limit(1).maybeSingle();

      if (!error && data && data.median_price_m2) {
        const medianPriceM2 = Number(data.median_price_m2);
        const prixM2Bien = qi.price / qi.surface;
        const ecartPct = ((prixM2Bien - medianPriceM2) / medianPriceM2) * 100;

        let positionMarche: string;
        let isDiscount: boolean;
        let verdict: string;
        if (ecartPct <= -20) { positionMarche = 'fortement décoté'; isDiscount = true; verdict = 'opportunité à étudier'; }
        else if (ecartPct <= -5) { positionMarche = 'légèrement décoté'; isDiscount = true; verdict = 'décote modérée'; }
        else if (ecartPct <= 5) { positionMarche = 'cohérent marché'; isDiscount = false; verdict = 'prix cohérent'; }
        else if (ecartPct <= 20) { positionMarche = 'légèrement surcoté'; isDiscount = false; verdict = 'prix à négocier'; }
        else { positionMarche = 'fortement surcoté'; isDiscount = false; verdict = 'prix à négocier'; }

        // ── Simulation travaux intégrée ──────────────────────────────────
        const ctxAny = ctx as any;
        const renovCost  = typeof ctxAny.renovation_cost_total === 'number' ? ctxAny.renovation_cost_total : 0;
        const fraisAchat = Math.round(qi.price * 0.075);
        const prixRevient = qi.price + renovCost + fraisAchat;
        const margeMediane = Math.round(medianPriceM2 * qi.surface) - prixRevient;
        const margePct     = Math.round((margeMediane / prixRevient) * 100);

        return {
          status: 'ok',
          source: 'v_quick_questions_mvp (marché local)',
          data: {
            note: "Bien saisi manuellement — analyse basée sur la médiane marché de la ville.",
            ville: qi.city,
            code_postal: qi.zip_code,
            prix: qi.price,
            surface: qi.surface,
            prix_m2_bien: Math.round(prixM2Bien),
            prix_m2_marche: medianPriceM2,
            ecart_marche_pct: Math.round(ecartPct * 100) / 100,
            position_marche: positionMarche,
            profondeur_marche: data.profondeur_marche ?? null,
            confiance: 'moyenne',
            nb_annonces_comparables: data.listings_count ?? null,
            opportunite_decote: isDiscount,
            marche_liquide: data.has_liquid_market ?? null,
            verdict,
            // ── Simulation travaux ───────────────────────────────────────
            ...(renovCost > 0 ? {
              simulation_travaux: {
                cout_travaux_ttc:    renovCost,
                cout_par_m2:         ctxAny.renovation_cost_per_m2 ?? null,
                niveau:              ctxAny.renovation_level ?? null,
                gamme:               ctxAny.renovation_gamme  ?? null,
                frais_achat_estimes: fraisAchat,
                prix_de_revient:     prixRevient,
                revente_cible_mediane: Math.round(medianPriceM2 * qi.surface),
                marge_brute_estimee: margeMediane,
                marge_brute_pct:     margePct,
                note_calcul: "Prix revient = achat + travaux TTC + frais achat 7.5%. Revente cible = médiane ville × surface.",
              },
            } : {}),
          },
        };
      }
    }
  } catch (e) {
    console.error('[quick_market_insight] SQL error:', errMsg(e));
    return {
      status: 'error',
      source: 'v_quick_questions_mvp',
      message: `Erreur lecture vue SQL : ${errMsg(e)}`,
    };
  }

  if (!row) {
    return {
      status: 'not_found',
      source: 'v_quick_questions_mvp',
      message: `Aucune donnée marché trouvée pour ${qi.city ?? '?'} (${qi.zip_code ?? '?'}). La ville n'est peut-être pas encore couverte par la veille marché Mimmoza.`,
    };
  }

  return {
    status: 'ok',
    source: 'v_quick_questions_mvp',
    data: {
      ville: row.city ?? null,
      code_postal: row.zip_code ?? null,
      prix: row.price ?? null,
      surface: row.surface ?? null,
      prix_m2_bien: row.computed_price_m2 ?? null,
      prix_m2_marche: row.median_price_m2 ?? null,
      ecart_marche_pct: row.ecart_marche_pct ?? null,
      position_marche: row.position_marche ?? null,
      profondeur_marche: row.profondeur_marche ?? null,
      confiance: row.confidence_level ?? null,
      nb_annonces_comparables: row.listings_count ?? null,
      opportunite_decote: row.is_discount_opportunity ?? null,
      prix_coherent: row.is_market_coherent ?? null,
      marche_liquide: row.has_liquid_market ?? null,
      verdict: row.quick_verdict ?? null,
      ...(row.quick_payload != null ? { detail_payload: row.quick_payload } : {}),
    },
  };
}

// ─── recherche_biens ─────────────────────────────────────────
// Recherche multi-critères en lecture directe sur la vue annonces.
// TODO[contrat-biens]: si une table `listings` plus riche existe (pièces,
// property_type…), remplacer TABLE et ajouter les filtres correspondants.
async function toolRechercheBiens(
  input: Record<string, unknown>,
  ctx: MimmozaContext,
): Promise<ToolResult> {
  const TABLE = 'v_quick_questions_mvp';
  const SELECT_FIELDS = [
    'id', 'url', 'city', 'zip_code', 'price', 'surface',
    'computed_price_m2', 'median_price_m2', 'ecart_marche_pct',
    'position_marche', 'is_discount_opportunity', 'quick_verdict',
  ].join(', ');

  const city         = str(input.city)     ?? (ctx as any).city;
  const zip          = str(input.zip_code) ?? (ctx as any).zip_code;
  const priceMin     = num(input.price_min);
  const priceMax     = num(input.price_max);
  const surfaceMin   = num(input.surface_min);
  const surfaceMax   = num(input.surface_max);
  const onlyDiscount = input.only_discounts === true;
  const limit        = Math.min(Math.max(num(input.limit) ?? 10, 1), 25);

  // Un critère de localisation minimum pour éviter un scan global de la vue.
  if (!city && !zip) {
    return {
      status: 'not_found', source: TABLE,
      message: "Précise au moins une ville ou un code postal pour lancer la recherche de biens.",
    };
  }

  try {
    let q = getAdmin().from(TABLE).select(SELECT_FIELDS);
    if (city)          q = q.ilike('city', `%${city.trim()}%`);
    if (zip)           q = q.eq('zip_code', zip.trim());
    if (priceMin != null)   q = q.gte('price', priceMin);
    if (priceMax != null)   q = q.lte('price', priceMax);
    if (surfaceMin != null) q = q.gte('surface', surfaceMin);
    if (surfaceMax != null) q = q.lte('surface', surfaceMax);
    if (onlyDiscount)  q = q.eq('is_discount_opportunity', true);
    // Meilleures décotes d'abord (écart marché croissant ; NULL en dernier).
    q = q.order('ecart_marche_pct', { ascending: true, nullsFirst: false }).limit(limit);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      return {
        status: 'not_found', source: TABLE,
        message:
          `Aucun bien ne correspond à ces critères (${city ?? '?'}${zip ? ` ${zip}` : ''}). ` +
          "La ville n'est peut-être pas encore couverte par la veille marché Mimmoza.",
      };
    }

    return {
      status: 'ok', source: TABLE,
      data: {
        count: rows.length,
        criteres: {
          ville: city ?? null, code_postal: zip ?? null,
          budget: { min: priceMin ?? null, max: priceMax ?? null },
          surface: { min: surfaceMin ?? null, max: surfaceMax ?? null },
          uniquement_decotes: onlyDiscount,
        },
        biens: rows.map((r: Record<string, any>) => ({
          id: r.id ?? null,
          url: r.url ?? null,
          ville: r.city ?? null,
          code_postal: r.zip_code ?? null,
          prix: r.price ?? null,
          surface: r.surface ?? null,
          prix_m2: r.computed_price_m2 ?? null,
          prix_m2_marche: r.median_price_m2 ?? null,
          ecart_marche_pct: r.ecart_marche_pct ?? null,
          position_marche: r.position_marche ?? null,
          opportunite_decote: r.is_discount_opportunity ?? null,
          verdict: r.quick_verdict ?? null,
        })),
      },
    };
  } catch (e) {
    console.error('[recherche_biens] SQL error:', errMsg(e));
    return { status: 'error', source: TABLE, message: `Erreur lecture ${TABLE} : ${errMsg(e)}` };
  }
}

// =============================================================
// LOT 6 — Bloc snapshot prédictif pour le system prompt
// =============================================================

function buildPredictiveSnapshotBlock(ps: NonNullable<MimmozaContext['predictive_snapshot']>): string {
  const lines: string[] = [
    `## Données prédictives Mimmoza — ${ps.sources_count ?? '?'}/17 sources actives`,
    ps.deal_label ? `Deal : ${ps.deal_label}` : '',
    '',
  ];

  if (ps.dvf) {
    lines.push('### DVF — Marché immobilier [source: market-study v1]');
    if (ps.dvf.prix_m2_median != null) lines.push(`- Prix médian : ${ps.dvf.prix_m2_median.toLocaleString('fr-FR')} €/m²`);
    if (ps.dvf.nb_transactions != null) lines.push(`- Volume : ${ps.dvf.nb_transactions} transactions`);
    if (ps.dvf.evolution_prix_pct != null) {
      const sign = ps.dvf.evolution_prix_pct > 0 ? '+' : '';
      lines.push(`- Évolution annuelle : ${sign}${ps.dvf.evolution_prix_pct}%`);
    } else {
      lines.push('- Évolution annuelle : non disponible (historique insuffisant en base)');
    }
    if (ps.dvf.prix_m2_min != null && ps.dvf.prix_m2_max != null)
      lines.push(`- Fourchette : ${ps.dvf.prix_m2_min.toLocaleString('fr-FR')} – ${ps.dvf.prix_m2_max.toLocaleString('fr-FR')} €/m²`);
    lines.push('');
  }

  if (ps.market_scores) {
    lines.push('### Scores marché [source: market-study v1]');
    if (ps.market_scores.global != null)        lines.push(`- Score global : ${ps.market_scores.global}/100`);
    if (ps.market_scores.demande != null)        lines.push(`- Demande : ${ps.market_scores.demande}/100`);
    if (ps.market_scores.offre != null)          lines.push(`- Offre : ${ps.market_scores.offre}/100`);
    if (ps.market_scores.environnement != null)  lines.push(`- Environnement : ${ps.market_scores.environnement}/100`);
    if (ps.market_scores.accessibilite != null)  lines.push(`- Accessibilité : ${ps.market_scores.accessibilite}/100`);
    if (ps.market_scores.transport_exclu)        lines.push('- ⚠️ Transport non évalué (zone non-urbaine)');
    lines.push('');
  }

  if (ps.insee) {
    lines.push('### INSEE — Démographie & économie [source: geo.api + FiLoSoFi]');
    if (ps.insee.commune_nom)           lines.push(`- Commune : ${ps.insee.commune_nom}${ps.insee.departement ? ` (dépt. ${ps.insee.departement})` : ''}`);
    if (ps.insee.population != null)    lines.push(`- Population : ${ps.insee.population.toLocaleString('fr-FR')} hab.`);
    if (ps.insee.revenu_median != null) lines.push(`- Revenu médian : ${ps.insee.revenu_median.toLocaleString('fr-FR')} €/an`);
    if (ps.insee.taux_chomage != null)  lines.push(`- Taux de chômage : ${ps.insee.taux_chomage}%`);
    if (ps.insee.taux_pauvrete != null) lines.push(`- Taux de pauvreté : ${ps.insee.taux_pauvrete}%`);
    lines.push('');
  }

  if (ps.bpe) {
    lines.push('### BPE — Équipements locaux [source: BPE / Supabase]');
    if (ps.bpe.score != null)             lines.push(`- Score équipements : ${ps.bpe.score}/100`);
    if (ps.bpe.total_equipements != null) lines.push(`- Total équipements : ${ps.bpe.total_equipements}`);
    const d = [
      ps.bpe.commerces_count != null ? `commerces: ${ps.bpe.commerces_count}` : null,
      ps.bpe.sante_count     != null ? `santé: ${ps.bpe.sante_count}`         : null,
      ps.bpe.education_count != null ? `éducation: ${ps.bpe.education_count}` : null,
      ps.bpe.loisirs_count   != null ? `loisirs: ${ps.bpe.loisirs_count}`     : null,
    ].filter(Boolean);
    if (d.length > 0) lines.push(`- Détail : ${d.join(' | ')}`);
    lines.push('');
  }

  if (ps.transport) {
    lines.push('### Transport [source: Overpass/OSM]');
    if (ps.transport.is_urban === false) {
      lines.push('- Zone non-urbaine — pilier transport non applicable');
    } else {
      if (ps.transport.score != null)          lines.push(`- Score transport : ${ps.transport.score}/100`);
      if (ps.transport.nearest_stop_m != null) lines.push(`- Arrêt le plus proche : ${ps.transport.nearest_stop_m} m`);
      if (ps.transport.has_metro_train)        lines.push('- Métro/train : ✓');
      if (ps.transport.has_tram)               lines.push('- Tramway : ✓');
    }
    lines.push('');
  }

  if (ps.georisques) {
    lines.push('### Géorisques [source: risk-study]');
    if (ps.georisques.nb_risques != null)        lines.push(`- Risques identifiés : ${ps.georisques.nb_risques}`);
    if (ps.georisques.inondation != null)        lines.push(`- Zone inondable : ${ps.georisques.inondation ? 'OUI ⚠️' : 'non'}`);
    if (ps.georisques.sismique != null)          lines.push(`- Zone sismique : ${ps.georisques.sismique}`);
    if (ps.georisques.retrait_gonflement)        lines.push('- Retrait-gonflement argiles : ⚠️ présent');
    if (ps.georisques.radon != null)             lines.push(`- Radon classe : ${ps.georisques.radon}`);
    if (ps.georisques.cavites)                   lines.push('- Cavités souterraines : ⚠️ présentes');
    lines.push('');
  }

  if (ps.dpe) {
    lines.push(`### DPE — Performance énergétique${ps.dpe_source ? ` [source: ${ps.dpe_source}]` : ''}`);
    lines.push(`- Classe : ${ps.dpe}`);
    lines.push('');
  }

  if (ps.plu_zone) {
    lines.push('### PLU — Zonage');
    lines.push(`- Zone : ${ps.plu_zone}`);
    lines.push('');
  }

  if (ps.sitadel_score != null) {
    lines.push('### Sitadel — Concurrence constructive [source: Sitadel/SDES]');
    lines.push(`- Score : ${Math.round(ps.sitadel_score)}/100`);
    lines.push('');
  }

  if (ps.demographie_score != null) {
    lines.push('### Score démographie INSEE');
    lines.push(`- Score : ${Math.round(ps.demographie_score)}/100`);
    lines.push('');
  }

  if (ps.loyer_median_zone != null) {
    lines.push('### Loyer médian de zone [source: saisie manuelle]');
    lines.push(`- ${ps.loyer_median_zone} €/m²/mois`);
    lines.push('');
  }

  if (ps.rentabilite) {
    lines.push('### Rentabilité calculée [source: module Rentabilité Mimmoza]');
    if (ps.rentabilite.rendement_brut != null)     lines.push(`- Rendement brut : ${ps.rentabilite.rendement_brut}%`);
    if (ps.rentabilite.rendement_net != null)      lines.push(`- Rendement net : ${ps.rentabilite.rendement_net}%`);
    if (ps.rentabilite.cashflow_mensuel != null)   lines.push(`- Cash-flow mensuel : ${ps.rentabilite.cashflow_mensuel.toLocaleString('fr-FR')} €`);
    if (ps.rentabilite.marge_brute != null)        lines.push(`- Marge brute : ${ps.rentabilite.marge_brute.toLocaleString('fr-FR')} €`);
    if (ps.rentabilite.marge_brute_pct != null)    lines.push(`- Marge brute % : ${ps.rentabilite.marge_brute_pct}%`);
    if (ps.rentabilite.prix_revente_cible != null) lines.push(`- Prix revente cible : ${ps.rentabilite.prix_revente_cible.toLocaleString('fr-FR')} €`);
    lines.push('');
  }

  if (ps.travaux_budget != null) {
    lines.push('### Budget travaux [source: simulation Mimmoza]');
    lines.push(`- Budget total TTC : ${ps.travaux_budget.toLocaleString('fr-FR')} €`);
    lines.push('');
  }

  if (ps.fiscal_regime) {
    lines.push('### Régime fiscal [source: module Rentabilité Mimmoza]');
    lines.push(`- Régime : ${ps.fiscal_regime}`);
    lines.push('');
  }

  if (ps.bce_rate != null) {
    lines.push('### Pression crédit BCE [source: API ECB]');
    lines.push(`- Taux directeur : ${ps.bce_rate}%${ps.bce_pressure_label ? ` — ${ps.bce_pressure_label}` : ''}`);
    lines.push('');
  }

  if (ps.horizon_mois != null) {
    lines.push('### Horizon de détention');
    lines.push(`- ${ps.horizon_mois} mois`);
    lines.push('');
  }

  return lines.filter(Boolean).join('\n');
}

// =============================================================
// LOT 8 — Bloc snapshot de page (donnees visibles a l'ecran)
// =============================================================

function buildPageSnapshotBlock(
  psnap: Record<string, string | number | null>,
  pageContext?: MimmozaContext['pageContext'],
): string {
  const entries = Object.entries(psnap).filter(([, v]) => v !== null && v !== '');
  if (entries.length === 0) return '';

  const header = pageContext?.space
    ? `## Donnees de la page actuellement ouverte — espace ${pageContext.space}${pageContext.tab ? ` / ${pageContext.tab}` : ''}`
    : "## Donnees de la page actuellement ouverte (visibles a l'ecran)";

  return [
    header,
    "Ces valeurs ont ete saisies ou calculees par l'utilisateur sur la page courante. Utilise-les directement pour repondre, sans reclamer d'annonce, de parcelle ni d'URL.",
    ...entries.map(([k, v]) => `- ${k} : ${typeof v === 'number' ? v.toLocaleString('fr-FR') : v}`),
  ].join('\n');
}

// =============================================================
// LOT 9 — Bloc étude de risques (données déjà calculées par la page)
// =============================================================

function buildRiskStudyBlock(rs: Record<string, unknown>): string {
  const s = summarizeRisks(rs) as Record<string, any>;
  if (!s || s.note) return ''; // réponse vide/en erreur → pas de bloc

  const lines: string[] = [
    "## Étude de risques Mimmoza — DÉJÀ CALCULÉE (page actuellement ouverte) [source: risk-study]",
    "⚠️ Convention : scores de SÉCURITÉ (100 = zone très sûre, 0 = risque maximal). Un score élevé est POSITIF. Le champ « niveau_risque » reste un niveau de RISQUE (fort = mauvais).",
    "⚠️ RÈGLE ABSOLUE — absence de donnée ≠ absence de risque. Un score « non mesuré », un niveau « inconnu » ou un critère non listé ci-dessous signifie que la source publique n'a pas répondu. Tu ne dois JAMAIS le présenter comme rassurant, ni écrire « hors zone », « aucun risque » ou « pas de PPRI » pour un critère non mesuré. Dis « non mesuré » et indique quelle source manque.",
    "",
  ];

  if (s.commune_nom) lines.push(`- Commune : ${s.commune_nom}${s.departement ? ` (dépt. ${s.departement})` : ''}`);

  const sc = s.scores_securite ?? {};
  const conf = s.confiance ?? {};
  const label = (v: unknown, nom: string) => (v == null ? `${nom} non mesuré` : `${nom} ${v}/100`);
  const scParts = [
    label(sc.global, 'global'),
    label(sc.naturels, 'naturels'),
    label(sc.technologiques, 'technologiques'),
    label(sc.pollution, 'pollution'),
    label(sc.geotechniques, 'géotechniques'),
  ];
  lines.push(`- Scores de sécurité : ${scParts.join(' · ')}`);

  // Indicateur de confiance : une note assise sur une fraction des critères doit
  // se lire comme telle, y compris dans la réponse du Copilot.
  if (conf.criteres_total != null) {
    lines.push(`- Confiance : ${conf.criteres_mesures ?? 0} critère(s) mesuré(s) sur ${conf.criteres_total} (couverture ${conf.coverage ?? 'n.c.'})`);
  }
  if (Array.isArray(conf.categories_non_mesurees) && conf.categories_non_mesurees.length) {
    lines.push(`- ⚠️ Catégories NON MESURÉES, exclues du score global : ${conf.categories_non_mesurees.join(', ')}. Le score global a été renormalisé sur les seules catégories mesurées — signale-le si tu commentes ce score, et ne conclus rien sur les catégories exclues.`);
  }

  if (Array.isArray(s.categories) && s.categories.length) {
    lines.push('', '### Niveau de risque par catégorie');
    for (const c of s.categories) {
      if (!c?.nom) continue;
      if (c.score_securite == null) {
        lines.push(`- ${c.nom} : NON MESURÉ (aucune source disponible) — ne rien conclure`);
      } else {
        const couv = c.criteres_total != null && c.criteres_mesures !== c.criteres_total
          ? `, ${c.criteres_mesures}/${c.criteres_total} critères mesurés`
          : '';
        lines.push(`- ${c.nom} : risque ${c.niveau_risque ?? 'n.c.'} (sécurité ${c.score_securite}/100${couv})`);
      }
    }
  }

  const f = s.faits ?? {};
  const faits: string[] = [];
  // v1.1.0 : `zone_inondable` peut valoir null (GASPAR muet). Le `!= null`
  // d'origine laissait passer `false` et écrivait « hors zone » comme un fait.
  if (f.inondation?.zone_inondable == null) {
    faits.push("Inondation : non mesuré (GASPAR indisponible) — ne pas conclure « hors zone »");
  } else {
    faits.push(`Inondation : ${f.inondation.zone_inondable ? 'zone inondable ⚠️' : 'hors zone (donnée GASPAR confirmée)'}${f.inondation.ppri ? ' (PPRI)' : ''}`);
  }
  // Le libellé (« Moyen ») est celui du zonage réglementaire français ; le
  // niveau de risque Mimmoza (« fort ») est une échelle interne. Sans cette
  // précision le modèle écrit « zone 4 (Moyen) » puis « risque fort » deux
  // lignes plus loin, ce qui se lit comme une contradiction.
  if (f.seisme?.zone == null) {
    faits.push("Séisme : non mesuré (département non résolu)");
  } else {
    faits.push(`Séisme : zone ${f.seisme.zone}${f.seisme.libelle ? ` — libellé réglementaire « ${f.seisme.libelle} »` : ''}${f.seisme.niveau_risque ? `, niveau de risque Mimmoza « ${f.seisme.niveau_risque} » (échelle interne, à ne pas confondre avec le libellé réglementaire)` : ''}`);
  }
  if (f.argiles?.niveau_alea != null) faits.push(`Retrait-gonflement argiles : aléa ${f.argiles.niveau_alea}`);
  if (f.radon?.classe != null) faits.push(`Radon : classe ${f.radon.classe}${f.radon.libelle ? ` (${f.radon.libelle})` : ''}`);
  // risk-study v1.1.1 : `total` est plafonné par la pagination Géorisques.
  // « ICPE : 100 » se lisait comme un décompte exact alors que c'est le plafond.
  // v1.1.1 — Ces quatre faits sont des DÉCOMPTES, et un décompte vaut 0 même
  // quand la source n'a pas répondu. Le test `count != null` les publiait donc
  // tels quels : « Sites pollués (SIS) : 0 · Cavités : 0 · Mouvements : 0 » sur
  // des sources muettes, ce dont le modèle concluait « aucun risque identifié »
  // — juste au-dessus d'un tableau annonçant ces mêmes catégories non mesurées.
  // On ne publie un décompte que si le critère a effectivement été mesuré.
  const compte = (bloc: any, nom: string, valeur: unknown, tronque?: boolean) => {
    if (bloc?.niveau_risque === 'inconnu' || bloc?.coverage === 'error' || bloc?.coverage === 'no_data') {
      faits.push(`${nom} : NON MESURÉ (source indisponible) — ne pas écrire « 0 » ni « aucun »`);
      return;
    }
    if (valeur == null) return;
    faits.push(`${nom} : ${valeur}${tronque ? '+ (décompte plafonné par la pagination Géorisques — dis « au moins N », jamais « N »)' : ''}`);
  };

  compte(
    f.icpe_seveso, 'ICPE',
    f.icpe_seveso?.total != null
      ? `${f.icpe_seveso.total}${f.icpe_seveso.seveso_haut ? `, dont ${f.icpe_seveso.seveso_haut} SEVESO haut ⚠️` : ''}`
      : null,
    f.icpe_seveso?.tronque,
  );
  compte(f.sites_pollues_sis, 'Sites pollués (SIS)', f.sites_pollues_sis?.count, f.sites_pollues_sis?.tronque);
  compte(f.cavites, 'Cavités', f.cavites?.count, f.cavites?.tronque);
  compte(f.mouvements_terrain, 'Mouvements de terrain', f.mouvements_terrain?.count, f.mouvements_terrain?.tronque);
  if (f.feux_foret?.zone_risque != null) faits.push(`Feux de forêt : ${f.feux_foret.zone_risque ? 'zone à risque' : 'hors zone'}${f.feux_foret.obligation_debroussaillement ? ' (débroussaillement obligatoire)' : ''}`);
  if (f.gaspar_coverage === 'error' || f.gaspar_coverage === 'no_data') {
    faits.push("Arrêtés CatNat : NON MESURÉ (GASPAR indisponible) — ne pas écrire « 0 »");
  } else if (f.catnat_count != null) {
    faits.push(`Arrêtés CatNat : ${f.catnat_count}${f.catnat_tronque ? '+ (plafonné)' : ''}`);
  }
  if (faits.length) { lines.push('', '### Faits saillants'); for (const x of faits) lines.push(`- ${x}`); }

  if (Array.isArray(s.insights) && s.insights.length) {
    lines.push('', '### Constats');
    for (const i of s.insights) if (i?.message) lines.push(`- ${i.message}`);
  }

  return lines.join('\n');
}

// =============================================================
// LOT 10 — Bloc implantation 2D (plan déjà dessiné par la page)
// =============================================================

function buildImplantation2DBlock(im: Record<string, any>): string {
  if (!im || typeof im !== 'object') return '';

  const lines: string[] = [
    "## Implantation 2D — PLAN ACTUELLEMENT DESSINÉ PAR L'UTILISATEUR [source: Implantation 2D Mimmoza]",
    "Ces valeurs proviennent du plan ouvert à l'écran. Elles sont la source de vérité pour toute question sur l'implantation, les surfaces bâties ou la conformité du scénario dessiné.",
    "",
  ];

  // ── Parcelle & enveloppe ──
  lines.push('### Parcelle et enveloppe constructible');
  if (im.parcelle_surface_m2 != null)
    lines.push(`- Surface parcelle : ${Number(im.parcelle_surface_m2).toLocaleString('fr-FR')} m²`);
  lines.push(`- Enveloppe constructible : ${im.enveloppe_constructible_definie ? 'calculée' : 'non calculée'}`);
  const reculs = [
    im.recul_facade_m  != null ? `façade ${im.recul_facade_m} m`   : null,
    im.recul_lateral_m != null ? `latéral ${im.recul_lateral_m} m` : null,
    im.recul_fond_m    != null ? `fond ${im.recul_fond_m} m`       : null,
  ].filter(Boolean);
  if (reculs.length) lines.push(`- Reculs appliqués : ${reculs.join(' · ')}`);

  // ── Règles PLU utilisées ──
  const rp = im.regles_plu as Record<string, any> | undefined;
  if (rp) {
    lines.push('', '### Règles utilisées par le moteur de conformité');
    if (rp.maxHeightMeters      != null) lines.push(`- Hauteur max : ${rp.maxHeightMeters} m`);
    if (rp.maxCoverageRatio     != null) lines.push(`- Emprise au sol max : ${Math.round(rp.maxCoverageRatio * 100)} %`);
    if (rp.minSetbackMeters     != null) lines.push(`- Recul minimal : ${rp.minSetbackMeters} m`);
    if (rp.parkingSpacesPerUnit != null) lines.push(`- Stationnement : ${rp.parkingSpacesPerUnit} place(s)/logement`);
    if (im.regles_plu_source === 'placeholder') {
      lines.push(
        "- ⚠️ IMPORTANT : ces règles sont des valeurs PAR DÉFAUT de l'éditeur, PAS le PLU réel de la parcelle. " +
        "Tu dois le signaler à chaque fois que tu commentes une conformité, et inviter l'utilisateur à importer le règlement PLU sur la page Foncier."
      );
    }
  }

  // ── Programme dessiné ──
  lines.push('', '### Programme dessiné');
  lines.push(`- Bâtiments : ${im.nb_batiments ?? 0}`);
  if (im.places_parking_totales != null)
    lines.push(`- Places de stationnement dessinées : ${im.places_parking_totales} (${im.nb_parkings_zones ?? 0} zone(s))`);
  if (Array.isArray(im.batiments) && im.batiments.length) {
    for (const b of im.batiments.slice(0, 12)) {
      lines.push(`  · ${b.nom ?? b.id} — R+${(b.niveaux ?? 1) - 1}, emprise ${b.emprise_m2} m²`);
    }
  }
  if (im.nb_logements != null) lines.push(`- Logements programmés : ${im.nb_logements}`);
  if (im.surface_moy_logement_m2 != null) lines.push(`- Surface moyenne logement : ${im.surface_moy_logement_m2} m²`);

  // ── Conformité PLU (déjà calculée par le moteur, ne PAS recalculer) ──
  const plu = im.plu_checks as Record<string, any> | undefined;
  if (plu) {
    lines.push('', '### Conformité — résultats du moteur PLU (déjà calculés)');
    if (Array.isArray(plu.checks)) {
      for (const c of plu.checks.slice(0, 15)) {
        const label  = c.label ?? c.rule ?? c.id ?? 'règle';
        const statut = c.passed === true ? 'CONFORME' : c.passed === false ? 'NON CONFORME ⚠️' : 'n.c.';
        lines.push(`- ${label} : ${statut}${c.message ? ` — ${c.message}` : ''}`);
      }
    } else {
      lines.push(`- Résultat brut : ${JSON.stringify(plu).slice(0, 800)}`);
    }
  }

  // ── Diagnostic parcellaire ──
  const diag = im.diagnostics as Record<string, any> | undefined;
  if (diag) {
    lines.push('', '### Diagnostic parcellaire (déjà calculé)');
    lines.push(JSON.stringify(diag).slice(0, 800));
  }

  // ── Scénario économique ──
  const sc = im.scenario as Record<string, any> | undefined;
  if (sc) {
    lines.push('', '### Scénario d\'implantation (déjà calculé)');
    lines.push(JSON.stringify(sc).slice(0, 1200));
  }

  return lines.join('\n');
}

// =============================================================
// SECTION 7 — System prompt
// =============================================================

/**
 * Bloc « chaîne d'opération » : l'état réel du projet promoteur, transmis par
 * le front dans ctx.promoteur_chain. Sans lui, le copilote propose des étapes
 * dans le désordre ou relance ce qui est déjà fait — c'est ce bloc qui fait la
 * différence entre répondre et piloter.
 */
function buildPromoteurChainBlock(ctx: MimmozaContext): string {
  const chain = readChain(ctx);
  if (!chain.study_id || chain.steps.length === 0) {
    return "Aucune opération promoteur active. Si l'utilisateur veut étudier un terrain ou monter "
         + "une opération, propose d'en créer une (action_creer_operation) plutôt que de répondre "
         + "dans le vide.";
  }

  const STATUS_FR: Record<string, string> = {
    empty: 'à faire', running: 'en cours', ready: 'faite',
    stale: 'PÉRIMÉE (une étape amont a changé, à relancer)', error: 'en erreur',
  };

  const lignes = chain.steps.map((s) => {
    const bits = [`- ${s.label ?? s.step} (${s.step}) : ${STATUS_FR[s.status ?? 'empty'] ?? s.status}`];
    if (s.runnable === false && (s.blocked_by ?? []).length) {
      bits.push(`— bloquée par : ${(s.blocked_by ?? []).join(', ')}`);
    } else if (s.status === 'empty' || s.status === 'stale') {
      bits.push('— lançable maintenant');
    }
    return bits.join(' ');
  });

  return [
    "## Chaîne de l'opération en cours",
    "État réel du projet. Il fait autorité : ne propose JAMAIS une étape bloquée, et n'affirme "
    + "JAMAIS le résultat d'une étape qui n'est pas « faite ».",
    ...lignes,
    "Si des étapes sont PÉRIMÉES, signale-le en PREMIER : les chiffres affichés ailleurs dans "
    + "l'application ne sont plus cohérents tant qu'elles n'ont pas été relancées.",
  ].join('\n');
}

function buildSystemPrompt(ctx: MimmozaContext, mode: CopilotMode): string {
  console.log('[copilot] pageSnapshot reçu:', JSON.stringify(ctx.pageSnapshot)?.slice(0, 300));
  const verticalLine: Record<Vertical, string> = {
    promoteur: "Tu assistes un promoteur immobilier (constructibilité, bilan, marge, risques).",
    investisseur: "Tu assistes un investisseur (rentabilité, cash-flow, fiscalité, marché).",
    marchand: "Tu assistes un marchand de biens (marge brute, travaux, revente, délais).",
    apporteur: "Tu assistes un apporteur d'affaires (qualification, sourcing, mise en relation).",
    particulier: "Tu assistes un particulier (analyse simple, vulgarisation).",
    generique: "Tu assistes un utilisateur de Mimmoza.",
  };

  // ⚠️ On NE nomme la commune dans le contexte QUE si elle est explicitement fournie.
  // On n'expose pas le code INSEE comme s'il valait un nom de ville (cf. règle 4quater).
  const parcelLine = ctx.parcel
    ? `Parcelle ouverte : ${ctx.parcel.address ?? ctx.parcel.id}` +
      (ctx.parcel.commune ? `, ${ctx.parcel.commune}` : '') +
      (ctx.parcel.plu_zone ? ` (zone ${ctx.parcel.plu_zone})` : '') + '.'
    : "Aucune parcelle ouverte.";

  // Le PLU extrait par le parser est-il disponible dans le contexte ?
  const pluAvailable = !!(ctx.plu && (ctx.plu.zone_code || ctx.plu.ruleset || ctx.plu.oap));

  // Règle quick_market_insight : active pour investisseur + marchand uniquement.
  const showQuickMarketRule = ctx.vertical === 'investisseur' || ctx.vertical === 'marchand';

  // Annonce active transmise par le front
  const hasListing = !!(ctx.listing_id || ctx.url || (ctx.city && ctx.price && ctx.surface));
  // Travaux simulés disponibles dans le contexte
  const ctxAny = ctx as any;
  const hasRenovation = typeof ctxAny.renovation_cost_total === 'number' && ctxAny.renovation_cost_total > 0;
  const renovationLine = hasRenovation
    ? `Budget travaux simulé (Mimmoza) : ${Number(ctxAny.renovation_cost_total).toLocaleString('fr-FR')} € TTC` +
      (ctxAny.renovation_cost_per_m2 ? ` · ${ctxAny.renovation_cost_per_m2} €/m²` : '') +
      (ctxAny.renovation_level ? ` · Niveau : ${ctxAny.renovation_level}` : '') +
      (ctxAny.renovation_gamme  ? ` · Gamme : ${ctxAny.renovation_gamme}` : '') + '.'
    : '';
  const listingLine = hasListing
    ? `Annonce ouverte : ${[
        ctx.city && ctx.zip_code ? `${ctx.city} (${ctx.zip_code})` : ctx.city ?? null,
        ctx.price != null ? `${ctx.price.toLocaleString('fr-FR')} €` : null,
        ctx.surface != null ? `${ctx.surface} m²` : null,
        ctx.listing_id ? `ID: ${ctx.listing_id}` : null,
      ].filter(Boolean).join(' · ')}.`
    : '';

  // ── V1.6 — Analyse de plan (Réhabilitation), poussée à plat par AnalysePlanPage ──
  const hasPlanAnalysis =
    typeof ctxAny.plan_summary === 'string' ||
    typeof ctxAny.plan_rooms === 'string' ||
    typeof ctxAny.plan_surface_retenue_m2 === 'number';
  const planAnalysisBlock = hasPlanAnalysis
    ? [
        '---',
        "## Analyse du plan (page Réhabilitation actuellement ouverte)",
        "Une analyse de plan a été réalisée sur la page courante. Utilise ces données DIRECTEMENT pour répondre, sans réclamer de parcelle, d'annonce ni de plan à charger.",
        ctxAny.plan_surface_retenue_m2 != null
          ? `- Surface retenue : ${Number(ctxAny.plan_surface_retenue_m2).toLocaleString('fr-FR')} m²${ctxAny.plan_room_count ? ` (somme de ${ctxAny.plan_room_count} pièces)` : ''}`
          : null,
        ctxAny.plan_rooms ? `- Pièces détectées : ${ctxAny.plan_rooms}` : null,
        ctxAny.plan_summary ? `- Synthèse de l'analyse : ${ctxAny.plan_summary}` : null,
        ctxAny.plan_anomalies ? `- Anomalies / points de contrôle : ${ctxAny.plan_anomalies}` : null,
        "Ces données proviennent de l'analyse réglementaire et fonctionnelle Mimmoza [source: analyse-plan]. Termine toute conclusion par « À faire valider par un professionnel. »",
        '---',
      ].filter(Boolean).join('\n')
    : '';

  // LOT 6 — snapshot prédictif
  const ps = (ctx as any).predictive_snapshot ?? null;
  if (ps) console.log('[copilot] snapshot sources_count=', ps.sources_count, '· non-null:', Object.keys(ps).filter((k) => ps[k] != null));
  const snapshotBlock = ps ? buildPredictiveSnapshotBlock(ps) : '';
  const hasSnapshot = !!snapshotBlock;

  // LOT 8 — snapshot de page (donnees visibles a l'ecran)
  const psnap = (ctx as any).pageSnapshot ?? null;
  const pageSnapshotBlock = psnap ? buildPageSnapshotBlock(psnap, ctx.pageContext ?? undefined) : '';
  const hasPageSnapshot = !!pageSnapshotBlock;

  // LOT 9 — étude de risques déjà calculée (transmise par la page)
  const rstudy = (ctx as any).risk_study ?? null;
  const riskStudyBlock = rstudy ? buildRiskStudyBlock(rstudy) : '';
  const hasRiskStudy = !!riskStudyBlock;

  // LOT 10 — implantation 2D dessinée (transmise par la page)
  const impl = (ctx as any).implantation_2d ?? null;
  if (impl) console.log('[copilot] implantation_2d reçue · bâtiments=', impl.nb_batiments, '· parcelle_m2=', impl.parcelle_surface_m2);
  const implantationBlock = impl ? buildImplantation2DBlock(impl) : '';
  const hasImplantation = !!implantationBlock;

  // Chaîne d'opération promoteur : où en est le projet, ce qui est lançable.
  const chainBlock = buildPromoteurChainBlock(ctx);

  return [
    "Tu es Mimmoza Copilot, l'assistant IA intégré à la plateforme Mimmoza (intelligence immobilière et foncière française).",
    verticalLine[ctx.vertical],
    `Contexte : route ${ctx.route}. ${parcelLine}`,
    chainBlock,
    listingLine,
    renovationLine,
    planAnalysisBlock,
    pluAvailable
      ? "Des données PLU extraites par le parser Mimmoza sont disponibles pour cette parcelle : appelle get_parcel_plu pour lire zone, règles et OAP avant de te prononcer sur la constructibilité."
      : "",
    "",
    hasSnapshot ? [
      "---",
      "# DONNÉES PRÉDICTIVES MIMMOZA — DÉJÀ CALCULÉES",
      "Les données suivantes ont été calculées par le moteur prédictif Mimmoza et sont disponibles IMMÉDIATEMENT.",
      "Utilise-les EN PRIORITÉ. N'appelle un tool que pour des données absentes du snapshot ou pour plus de détails (comparables détaillés, recalcul, PLU complet).",
      "Ces données sont sourcées : cite les mentions [source: …] dans tes réponses.",
      "",
      snapshotBlock,
      "---",
    ].join('\n') : "",
    "",
    hasPageSnapshot ? [
      "---",
      pageSnapshotBlock,
      "---",
    ].join('\n') : "",
    "",
    hasRiskStudy ? [
      "---",
      riskStudyBlock,
      "---",
    ].join('\n') : "",
    "",
    hasImplantation ? [
      "---",
      implantationBlock,
      "---",
    ].join('\n') : "",
    "",
    "RÈGLES IMPÉRATIVES :",
    "1. Tu n'inventes jamais de donnée. Si une information n'a pas été obtenue via un outil ou le snapshot, dis-le explicitement.",
    "2. Toute affirmation factuelle (chiffre, zone PLU, prix) doit indiquer sa source entre crochets, ex: [source: market-study v1].",
    "2bis. Tu n'introduis JAMAIS un étalon de comparaison absent des données (moyenne nationale ou départementale, « ordre de grandeur habituel », « au-dessus/en dessous de la moyenne »), ni une étiquette qualitative que les données ne portent pas (« classe aisée », « périurbain », « premium », « fiscalité favorable »). Un qualificatif n'est admis que s'il repose sur un chiffre présent dans la réponse d'un outil — par exemple un score fourni, ou un écart calculé entre deux valeurs fournies. Sinon, tu donnes le chiffre brut et son effet concret, sans jugement.",
    "3. Toute analyse juridique, urbanistique, fiscale ou financière se termine par : « À faire valider par un professionnel. »",
    "4. Tu utilises les données du snapshot prédictif EN PRIORITÉ. Tu n'appelles un tool que pour des données absentes du snapshot.",
    "4bis. Les outils renvoient un champ \"status\". Si status = \"not_configured\", le service n'est pas encore disponible : mentionne-le brièvement en une phrase seulement. Si status = \"not_found\" ou \"error\", la donnée est indisponible : concentre-toi sur ce qui est disponible.",
    "4ter. Quand tu cites un chiffre issu d'un outil ou du snapshot, mentionne sa source.",
    "4quater. Tu ne traduis JAMAIS un code INSEE en nom de commune par toi-même. N'affiche un nom de commune QUE s'il est explicitement présent dans le contexte ou dans le champ \"data\" d'un outil.",
    "4vicies. ANCRAGE GÉOGRAPHIQUE — tu annonces TOUJOURS sur quel périmètre porte ta réponse (telle parcelle, telle commune, tel rayon) dès qu\'une réponse repose sur une localisation. Tu ne RÉUTILISES JAMAIS une référence cadastrale, une commune ou des coordonnées issues d\'un tour PRÉCÉDENT de la conversation dont la résolution a ÉCHOUÉ : une référence qui n\'a pas pu être localisée est morte, elle ne sert ni d\'ancrage, ni de source de code INSEE, ni de repli. Si l\'utilisateur enchaîne une question sans préciser le bien, et que le dernier ancrage valide est ambigu ou absent, tu DEMANDES de quel terrain il parle au lieu de supposer. Quand un outil renvoie un champ \"perimetre\" ou \"avertissement\", tu le restitues en TÊTE de réponse, jamais en note de bas de page : une analyse communale présentée comme parcellaire est une erreur grave.",
    "4quatervicies. NE PROMETS JAMAIS UN TRAITEMENT AUTOMATIQUE que tu n\'as pas constaté. Créer une veille, une watchlist ou une alerte MÉMORISE des critères ; cela ne prouve pas qu\'un moteur les rejoue. Tu n\'écris « vous serez alerté », « vous recevrez une notification » ou « je vous préviens dès que » QUE si la réponse de l\'outil l\'atteste — par exemple un champ dernier_rapprochement récent ou une note_alerte qui le confirme. Si l\'outil signale que le traitement n\'a pas tourné récemment ou jamais, tu le DIS à l\'utilisateur en une phrase claire, et tu formules ce qui est vrai : ses critères sont enregistrés. Une promesse d\'alerte non tenue coûte plus cher qu\'une absence de promesse : l\'utilisateur attend au lieu de chercher.",
    "4tervicies. PORTÉE D\'UN OUTIL — un outil ne voit QUE son domaine. Une réponse vide signifie « rien dans CE périmètre », jamais « cet objet n\'existe pas ». Tu ne conclus JAMAIS qu\'une chose n\'a pas été enregistrée, a échoué ou n\'existe pas en te fondant sur un outil qui couvre un AUTRE domaine — et surtout pas après avoir toi-même annoncé une création réussie : si tu ne retrouves pas ce que tu viens de créer, c\'est que tu interroges le mauvais outil. Dans ce cas, cherche l\'outil du bon domaine ou dis que tu ne peux pas vérifier, mais n\'annonce pas à l\'utilisateur que son enregistrement a disparu. Chaque famille d\'objets a ses propres verbes : veilles immobilières (creer/lister/desactiver_zone_veille) et veilles appels d\'offres (creer/lister/desactiver_veille_appels_offres) sont deux familles SÉPARÉES.",
    "4duovicies. DEUX VEILLES DISTINCTES — chez Mimmoza, « surveille tel secteur » est AMBIGU : cela peut désigner une veille IMMOBILIÈRE (biens, marché, opportunités d\'achat) ou une veille APPELS D\'OFFRES (marchés publics, cessions de terrains publics, concessions d\'aménagement). Les deux se formulent avec les mêmes mots et n\'ont rien à voir. Tant que l\'utilisateur n\'a pas levé l\'ambiguïté, tu NE CRÉES RIEN et tu lui POSES la question en une phrase. Ne devine pas depuis le métier de l\'utilisateur ni depuis la page où il se trouve : un promoteur suit les deux.",
    "4unvicies. IDENTIFIANTS ET LIENS — tu ne RECOMPOSES JAMAIS de mémoire un identifiant, une référence d\'avis, un numéro de dossier ou une URL : tu les REPRODUIS caractère par caractère depuis le champ correspondant de la réponse d\'outil, et quand un champ prêt à l\'emploi existe (par exemple lien_markdown) tu l\'utilises tel quel plutôt que de reconstruire le lien. Dans un tableau, chaque ligne doit porter l\'identifiant de SON propre enregistrement : deux lignes différentes qui affichent le même lien sont une ERREUR de recopie — relis avant d\'envoyer. Si tu n\'as pas l\'identifiant d\'une ligne, laisse la cellule vide plutôt que d\'en inventer un. ⚠️ UN CHAMP DÉJÀ FORMATÉ NE SE COMBINE AVEC RIEN : lien_markdown contient DÉJÀ un lien complet de la forme [texte](url). Tu le colles TEL QUEL, seul dans sa cellule ou sa puce. Tu ne l\'entoures JAMAIS de crochets ou de parenthèses supplémentaires, tu ne l\'imbriques pas dans un autre lien, et tu n\'y accoles NI la citation de source NI aucun autre texte — la mention [source: ...] se place dans une phrase à part, jamais collée à un lien.",
    "4quinquies. Pour les RISQUES, les scores sont des scores de SÉCURITÉ : 100 = zone très sûre, 0 = risque maximal. Un score élevé est POSITIF.",
    "4quinquies-a. Si AUCUNE donnée de risque n'est disponible (ni étude de risques injectée, ni bloc géorisques dans le snapshot, ni résultat de get_risks_georisques), tu NE fournis AUCUNE estimation de risque — même « typique », « générale » ou « probable » — déduite du seul nom de la commune. Tu n'inventes JAMAIS un aléa argile, une zone inondable, un PPRI, une sismicité ou une cavité à partir de la localisation. Tu réponds uniquement : l'étude de risques n'a pas encore été lancée pour ce bien, et tu invites l'utilisateur à la lancer depuis l'espace Risques. Aucun tableau de risques estimés.",
    "4quinquies-b. Pour une question portant UNIQUEMENT sur les risques, tu ne mentionnes AUCUNE donnée financière non demandée (budget travaux, prix, marge, rentabilité), même si elle est présente dans le contexte ou le snapshot. Reste strictement sur le périmètre risques.",
    "4sexies. Pour le DVF (get_dvf_comparables), si le résultat contient \"empty\": true, aucune transaction n'a été trouvée : ne donne AUCUN prix au m².",
    "4sexies-bis. Pour le DPE (get_dpe_ademe), si le résultat contient \"empty\": true, aucun DPE n'existe à cette adresse dans la base ADEME : ne donne AUCUNE classe énergétique et rappelle que la base n'est pas exhaustive. Ne déduis JAMAIS une classe DPE du seul âge ou type du bâtiment.",
    "4septies. Si l'utilisateur demande une synthèse de marché et qu'aucune localisation n'est disponible, invite-le à lancer une étude Marché/Risques.",
    showQuickMarketRule
      ? "4octies. Pour toute question sur le prix, la décote, l'opportunité ou la liquidité d'une annonce (investisseur/marchand), appelle get_quick_market_insight en premier. Présente uniquement les champs renvoyés par l'outil ; ne recalcule pas la décote toi-même."
      : "",
    hasSnapshot
      ? "4nonies. Les données du snapshot prédictif (DVF, scores marché, géorisques, DPE, rentabilité…) sont disponibles sans appel de tool. Utilise-les directement pour répondre aux questions sur le marché, les risques ou la performance du deal."
      : "",
    "4decies. Plusieurs scores peuvent porter sur un même thème (environnement, services/équipements, démographie…) tout en provenant de moteurs DIFFÉRENTS : le pilier SmartScore (compute_smartscore) mesure une proximité/qualité pondérée et normalisée, tandis que market-study (scores marché) et BPE (équipements) mesurent autre chose (volume d'équipements, dynamique de marché). Ces scores ne sont donc PAS redondants et ne doivent JAMAIS être présentés comme contradictoires. Quand tu affiches deux scores d'un même thème issus de sources distinctes, indique systématiquement entre parenthèses ce que chacun mesure et garde sa source. En cas d'écart, explique-le par la différence de méthode, jamais comme une incohérence des données.",
    hasPageSnapshot
      ? "4undecies. Des données de la page actuellement ouverte sont fournies (section « Donnees de la page actuellement ouverte »). Si l'utilisateur pose une question sur le bien, la marge, le prix de sortie, le coût de revient ou la rentabilité affichés à l'écran, réponds DIRECTEMENT avec ces valeurs SANS réclamer d'annonce, de parcelle ou d'URL. Ces données priment pour toute question portant sur « cette page », « ce bien » ou « ma valorisation »."
      : "",
    hasRiskStudy
      ? "4duodecies. Une étude de risques Mimmoza DÉJÀ CALCULÉE est fournie ci-dessus. Pour toute question sur les risques (inondation, séisme, argiles, radon, ICPE/SEVESO, cavités, mouvements de terrain, feux de forêt, sites pollués…), réponds DIRECTEMENT à partir de ces données [source: risk-study], sans appeler aucun outil et sans réclamer de parcelle ni de localisation."
      : "",
    "4terdecies. get_parcel_plu concerne UNIQUEMENT l'urbanisme et la constructibilité (zone PLU, hauteur, emprise, reculs, stationnement, OAP). Ne l'appelle JAMAIS pour une question de risques naturels ou technologiques : le PLU n'est pas la bonne source pour les risques.",
    "4quaterdecies. Ne traduis JAMAIS un code INSEE en nom de commune de mémoire (tu te trompes). Utilise UNIQUEMENT le nom de commune renvoyé par un outil. Si aucun outil n'a fourni le nom, écris « commune {code INSEE} » sans inventer de nom.",
    "4sexdecies. Le contexte peut contenir un DEAL ACTIF, un snapshot prédictif ou des données de page portant sur un bien précis. Tu ne les utilises QUE si la question porte sur ce bien, sur « cette page » ou sur « mon projet ». Tu n'introduis JAMAIS de toi-même un bien, un prix, une estimation, une décote ou un budget que l'utilisateur n'a pas évoqué dans la conversation en cours : une question générale sur une ville, un secteur ou une réglementation reçoit une réponse générale. Si un rapprochement avec le deal actif te paraît utile, tu le PROPOSES en une phrase (« souhaitez-vous que je rapproche cela de votre projet en cours ? ») au lieu d'en dérouler les chiffres.",
    "4quindecies-a. En mode rapide, get_etude_parcelle se suffit à lui-même : après l'avoir appelé, tu n'appelles AUCUN autre outil (ni PLU, ni risques, ni DVF) et tu rédiges directement le rapport. Le budget d'itérations est limité : un outil supplémentaire consomme le tour de synthèse et l'utilisateur ne reçoit alors aucun rapport. Si le PLU ou les risques manquent, tu le signales en partie 5 comme point à vérifier, sans chercher à les récupérer.",
    "4quindecies. Quand tu réponds à partir de get_etude_parcelle, tu ne listes PAS les données brutes : tu rédiges un RAPPORT structuré en cinq parties — (1) Identité de la parcelle ; (2) Contraintes réglementaires (zonage, servitudes) ; (3) Aptitude physique du terrain (pente, altitude, assainissement, solaire) ; (4) Potentiel économique (loyers, zone ABC, fiscalité) ; (5) VERDICT ET POINTS DE VIGILANCE. La partie 5 est la plus importante : elle hiérarchise ce qui bloque, ce qui coûte cher et ce qui reste à vérifier. Tu t'appuies UNIQUEMENT sur les données du bundle, tu cites la source de chaque chiffre, et tu consacres un paragraphe explicite aux sources indisponibles et à ce qu'elles empêchent de conclure. Termine par « À faire valider par un professionnel. » INTERDICTIONS ABSOLUES dans ce rapport : ne JAMAIS nommer ni décrire une couleur de zone d'un PPR (rouge, bleue, orange…) — ce zonage réglementaire n'est dans aucune donnée, renvoie au règlement du PPR en mairie ; ne JAMAIS déduire une caractéristique géographique non fournie (proximité du littoral, d'un cours d'eau, nature de l'aléa) à partir d'une altitude ou d'un nom de commune ; ne JAMAIS introduire un étalon de comparaison absent des données (moyenne nationale, moyenne départementale, ordre de grandeur « habituel ») ; ne JAMAIS qualifier un chiffre de modéré, élevé, favorable, attractif ou pénalisant sans référence chiffrée issue du bundle — présente le taux brut et son effet concret (« TFB 31,75 % : à intégrer au coût de portage »), sans jugement de valeur.",
    "4septdecies. Pour toute question de COÛT ou de BUDGET de construction neuve, appelle get_couts_construction — n'avance JAMAIS un €/m² de mémoire, et ne déduis JAMAIS un coût de construction d'un prix DVF (le DVF porte sur des ventes de biens EXISTANTS, pas sur un coût de construction : les deux ne sont pas comparables). Présente le montant comme un ordre de grandeur issu du barème Mimmoza, cite la source, rappelle les postes non inclus (foncier, honoraires, VRD, taxes d'urbanisme, aléas) et la nécessité d'un devis. Si l'outil signale que la typologie n'est pas couverte (EHPAD, clinique, hôtel, école), dis-le franchement et renvoie vers un économiste de la construction : n'utilise JAMAIS 'tertiaire' comme approximation.",
    "4octodecies. COÛT DES TRAVAUX DE RÉNOVATION (bien EXISTANT, distinct de la construction neuve de la règle 4septdecies). Si un budget travaux Mimmoza est déjà fourni (contexte renovation_* ou snapshot travaux_budget), utilise-le EN PRIORITÉ [source: simulation Mimmoza]. SINON, dès que l'utilisateur fournit des photos (ou décrit l'état) d'un bien PRÉCIS qu'il envisage d'acheter, d'estimer ou de rénover, tu estimes le coût des travaux DE TA PROPRE INITIATIVE — sans attendre une demande explicite de budget : une question sur le prix, l'opportunité, la qualité ou un simple « qu'en penses-tu ? » suffit à le déclencher. Et si un prix d'achat est connu, tu enchaînes dans le MÊME message la synthèse d'investissement de la règle 4novodecies (prix de revient + lecture des 3 angles). Cela ne s'applique qu'à un bien précis soumis par l'utilisateur, jamais à une question de marché générale (cf. règle 4sexdecies). Pour le chiffrage lui-même, tu appelles TOUJOURS get_couts_renovation : tu lis l'état sur les photos, tu en déduis les postes à reprendre et leurs quantités (surface, nombre d'ouvertures, nombre de pièces…), tu les transmets à l'outil qui applique les ratios et renvoie la décomposition chiffrée, que tu restitues SANS la recalculer. MODE DE CHIFFRAGE — RÈGLE STRICTE : dès que tu peux nommer NE SERAIT-CE QU'UN poste depuis les photos ou la description (cuisine, salle de bains, sols, peinture, électricité, menuiseries…), tu chiffres OBLIGATOIREMENT poste par poste (paramètre `postes`). Le paramètre `niveau_global` (rafraichissement/partielle/moyenne/lourde/complete) est un forfait grossier de DERNIER RECOURS, réservé au SEUL cas où l'état du bien est totalement illisible et qu'aucun poste n'est identifiable : il ne doit JAMAIS servir de raccourci quand tu as déjà identifié des postes. Chiffrer en `niveau_global` un bien dont tu viens de décrire les postes est une ERREUR (le forfait surestime massivement). Tu choisis aussi la `gamme` (economique/standard/premium) en cohérence avec le bien et tu l'ANNONCES explicitement dans ta réponse (« chiffrage en gamme premium »), pour que l'hypothèse soit traçable. Tu ne réponds JAMAIS « à chiffrer » ni « budget à anticiper » sans montant, et tu ne demandes JAMAIS son budget à l'utilisateur — c'est toi qui l'estimes via l'outil. Donnée absente (surface d'une pièce, gamme) → hypothèse explicite notée [H] transmise en quantité/paramètre à l'outil, et tu chiffres quand même. Présente la sortie sous forme de tableau poste par poste + TOTAL (fourchette) + ratio €/m² implicite (contrôle de cohérence) + 3 scénarios (indispensable / recommandé / valorisation max) si pertinent. Présente les montants comme des ordres de grandeur à confirmer par devis et cite [source: barème rénovation Mimmoza]. Postes non visibles sur photo (structure, réseaux enterrés, humidité, amiante <1997, plomb <1949, assainissement) : signale-les « à confirmer par visite/diagnostic » (l'aléa de l'outil les couvre), mais ne t'en sers JAMAIS comme prétexte pour ne pas chiffrer. Réserves regroupées en un seul bloc final. Termine par « À faire valider par un professionnel. »",
        "4novodecies. SYNTHÈSE INVESTISSEMENT — enchaînement OBLIGATOIRE. Dès que tu disposes À LA FOIS d'une estimation de valeur (comparables DVF/outil ou valeur saisie) ET d'un coût travaux (barème rénovation ou budget Mimmoza), tu ne t'arrêtes PAS au chiffrage : tu enchaînes sur une synthèse d'investissement chiffrée. (a) PRIX DE REVIENT = prix d'achat + travaux + frais d'acquisition ; les frais de notaire dans l'ancien (~7-8 %) sont un ordre de grandeur réglementaire standard que tu peux appliquer en l'annonçant. Si l'utilisateur n'a pas donné le prix d'achat, pose une hypothèse [H] (par défaut le bas de ta fourchette de valeur) pour illustrer le calcul, et marque-la comme hypothèse. (b) Positionne ce prix de revient face à la valeur de marché APRÈS travaux (comparables) et déduis, CHIFFRÉES : la marge brute sous l'angle marchand (valeur de revente − prix de revient, en € et en %) et/ou le rendement locatif si un loyer est disponible. Pour le loyer, appelle get_loyers_reference — ne l'invente JAMAIS. Si un calcul de rentabilité Mimmoza est déjà fourni (snapshot rentabilite / loyer_median_zone), utilise-le EN PRIORITÉ [source: module Rentabilité Mimmoza]. (c) ORDRE IMPÉRATIF : tu livres TOUJOURS le prix de revient EN PREMIER dès qu'il est calculable — il ne dépend d'AUCUN angle, ne le retarde donc jamais derrière une question. Tu ne demandes PAS son angle à l'utilisateur avant de produire la synthèse : tu enchaînes directement une lecture COURTE des trois angles à partir des données disponibles — résidence (paie-t-il le juste prix ? prix de revient face à la valeur de marché), locatif (rendement brut ≈ loyer annuel / prix de revient ; appelle get_loyers_reference pour le loyer, ne l'invente jamais), marchand (marge = valeur de revente − prix de revient, en € et en %). PUIS seulement tu proposes d'approfondir l'angle qui l'intéresse. Tu ne bloques JAMAIS toute la synthèse sur le choix de l'angle. (d) Le prix d'achat est le seul intrant réellement bloquant : s'il manque, réclame-le en UNE phrase ; s'il est connu, tu n'as plus aucune raison de t'arrêter — tu produis la synthèse complète. Termine par « À faire valider par un professionnel. »",
        mode === "quick"
      ? "5. Mode rapide : réponse concise et directe (quelques phrases). Pas de digression. EXCEPTION : une réponse construite sur get_etude_parcelle est un rapport complet en 5 parties (règle 4quindecies) — la concision ne s'y applique pas, et tu ne sacrifies JAMAIS la partie 5 (verdict et points de vigilance), qui est la plus importante."
      : "5. Mode avancé : raisonnement structuré, factuel et sourcé. Pas de digression. EXCEPTION : une réponse construite sur get_etude_parcelle est un rapport complet en 5 parties (règle 4quindecies) — la concision ne s'y applique pas, et tu ne sacrifies JAMAIS la partie 5 (verdict et points de vigilance), qui est la plus importante.",
    "",
    // ── CONCLUSION OBLIGATOIRE SUR LES ÉTUDES ────────────────────────────────
    // Les études (marché, risques, parcelle) produisent beaucoup de tableaux et
    // peu de sens : l'utilisateur reçoit une accumulation de chiffres sans
    // lecture d'ensemble. Cette règle impose une conclusion RÉDIGÉE en fin de
    // réponse — le seul endroit où le modèle doit trancher.
    [
      "# CONCLUSION OBLIGATOIRE — étude de marché, de risques ou de parcelle",
      "",
      "Dès que ta réponse présente une étude (marché, risques, parcelle, faisabilité), tu TERMINES par une section « ## Conclusion » rédigée en PROSE — pas en tableau, pas en liste à puces. 5 à 10 phrases, dans cet ordre :",
      "",
      "1. **Ce que dit le marché / le site, en une phrase tranchée.** Le chiffre qui compte et ce qu'il implique concrètement pour ce projet. Pas de reformulation des tableaux.",
      "2. **Les deux ou trois éléments qui pèsent vraiment** sur la décision, et pourquoi. Tu hiérarchises : tout n'a pas le même poids. Un aléa sismique de zone 4 engage des coûts de structure ; une pharmacie manquante non.",
      "3. **Ce sur quoi la donnée ne permet PAS de se prononcer**, nommément, et ce qu'il faudrait pour lever le doute (quelle source, quel interlocuteur).",
      "4. **La prochaine action utile**, une seule, celle qui débloque le plus.",
      "",
      "Règles de véracité dans cette conclusion — elles priment sur la fluidité :",
      "- Un critère non mesuré n'est JAMAIS présenté comme favorable, ni passé sous silence. « Non mesuré » et « nul » sont deux choses différentes et tu les nommes différemment.",
      "- Tu rappelles le périmètre réel des chiffres cités (commune, département, rayon en km) quand il diffère de ce que le lecteur supposerait.",
      "- Si le score global repose sur une partie seulement des critères, tu le dis dans la conclusion, pas seulement dans un tableau plus haut.",
      "- Tu ne réconcilies pas artificiellement deux chiffres divergents : tu expliques d'où vient l'écart (périmètres, dates, sources) ou tu dis que tu ne peux pas l'expliquer.",
      "- Aucun chiffre nouveau n'apparaît dans la conclusion : elle interprète, elle ne calcule pas.",
      "- Elle se termine par « À faire valider par un professionnel. »",
      "",
      "Cette conclusion est la partie la plus importante de ta réponse. Si tu dois raccourcir, tu coupes les tableaux, jamais la conclusion.",
    ].join('\n'),
    "",
    "Tu réponds toujours en français.",
  ].filter(Boolean).join('\n');
}

// =============================================================
// SECTION 8 — Construction de l'historique (budget tokens)
// =============================================================

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | unknown[];
};

async function buildMessages(
  conversationId: string,
  newUserMessage: string,
  mode: CopilotMode,
  attachments?: CopilotAttachment[],
): Promise<AnthropicMessage[]> {
  const limit = MAX_HISTORY_MESSAGES[mode];
  const { data: history } = await getAdmin()
    .from('copilot_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(limit);

  const ordered = (history ?? []).reverse();
  const msgs: AnthropicMessage[] = [];

  for (const m of ordered) {
    const text = extractText(m.content);
    if (text.trim()) {
      msgs.push({ role: m.role as 'user' | 'assistant', content: text });
    }
  }

  // Blocs image/document AVANT le texte (recommandation Anthropic).
  if (attachments?.length) {
    const blocks: unknown[] = attachments.map((a) =>
      a.mediaType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } }
        : { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } },
    );
    blocks.push({ type: 'text', text: newUserMessage });
    msgs.push({ role: 'user', content: blocks });
    console.log('[copilot] pieces jointes recues :', attachments.length);
  } else {
    msgs.push({ role: 'user', content: newUserMessage });
  }
  return msgs;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
  }
  return '';
}

// =============================================================
// SECTION 9 — SSE writer
// =============================================================

type StreamEvent =
  | { type: 'reservation'; reserved_credits: number; remaining: number }
  | { type: 'conversation'; conversation_id: string }
  | { type: 'message_start'; message_id: string }
  | { type: 'token'; delta: string }
  | { type: 'tool_use_start'; call: { id: string; name: string; input: unknown } }
  | { type: 'tool_use_end'; call: { id: string; name: string; output: unknown; duration_ms: number; status: string; error?: string } }
  | { type: 'done'; message_id: string; final_credits: number }
  | { type: 'error'; error: string; refunded_credits?: number };

class SSEWriter {
  private encoder = new TextEncoder();
  private closed = false;
  constructor(private controller: ReadableStreamDefaultController<Uint8Array>) {}
  send(event: StreamEvent) {
    if (this.closed) return;
    try {
      this.controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      this.closed = true; // client déconnecté : on cesse d'écrire sans throw
    }
  }
  get isClosed() { return this.closed; }
  close() {
    this.closed = true;
    try { this.controller.close(); } catch { /* already closed */ }
  }
}

// =============================================================
// SECTION 10 — Appel Anthropic (streaming) + parsing + timeout
// =============================================================

interface LLMTurnResult {
  textBlocks: string[];
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

async function streamLLMTurn(params: {
  model: string;
  system: string;
  messages: AnthropicMessage[];
  tools: ToolDef[];
  maxTokens: number;
  onToken: (delta: string) => void;
  onGenerationStart?: () => void;   // NEW
}): Promise<LLMTurnResult> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new CopilotError('LLM_ERROR', 'ANTHROPIC_API_KEY manquant');

  const body = {
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: params.messages,
    stream: true,
    ...(params.tools.length > 0
      ? {
          tools: params.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
        }
      : {}),
  };

  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), LLM_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new CopilotError('LLM_ERROR', `Timeout Anthropic (${LLM_TIMEOUT_MS}ms dépassés)`);
    }
    throw new CopilotError('LLM_ERROR', `Échec requête Anthropic : ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok || !res.body) {
    clearTimeout(timeoutId);
    const errText = await res.text().catch(() => '');
    if (res.status === 429) {
      throw new CopilotError('RATE_LIMITED', `Anthropic rate limit : ${errText.slice(0, 200)}`);
    }
    throw new CopilotError('LLM_ERROR', `Anthropic API ${res.status} : ${errText.slice(0, 300)}`);
  }

  const textBlocks: string[] = [];
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const partialBlocks: Record<number, {
    type: string; text?: string; id?: string; name?: string; partialJson?: string;
  }> = {};
  let stopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let evt: Record<string, unknown>;
        try { evt = JSON.parse(payload); } catch { continue; }

        switch (evt.type) {
          case 'message_start': {
  const usage = (evt.message as { usage?: { input_tokens?: number } })?.usage;
  inputTokens = usage?.input_tokens ?? 0;
  params.onGenerationStart?.();   // NEW : pivot de non-remboursement
  break;
}
          case 'content_block_start': {
            const idx = evt.index as number;
            const block = evt.content_block as Record<string, unknown>;
            if (block.type === 'tool_use') {
              partialBlocks[idx] = {
                type: 'tool_use', id: block.id as string,
                name: block.name as string, partialJson: '',
              };
            } else if (block.type === 'text') {
              partialBlocks[idx] = { type: 'text', text: '' };
            }
            break;
          }
          case 'content_block_delta': {
            const idx = evt.index as number;
            const delta = evt.delta as Record<string, unknown>;
            const pb = partialBlocks[idx];
            if (!pb) break;
            if (delta.type === 'text_delta') {
              const t = delta.text as string;
              pb.text = (pb.text ?? '') + t;
              params.onToken(t);
            } else if (delta.type === 'input_json_delta') {
              pb.partialJson = (pb.partialJson ?? '') + (delta.partial_json as string);
            }
            break;
          }
          case 'content_block_stop': {
            const idx = evt.index as number;
            const pb = partialBlocks[idx];
            if (!pb) break;
            if (pb.type === 'text' && pb.text) {
              textBlocks.push(pb.text);
            } else if (pb.type === 'tool_use') {
              let parsedInput: Record<string, unknown> = {};
              try { parsedInput = pb.partialJson ? JSON.parse(pb.partialJson) : {}; } catch { /* keep {} */ }
              toolUses.push({ id: pb.id!, name: pb.name!, input: parsedInput });
            }
            delete partialBlocks[idx];
            break;
          }
          case 'message_delta': {
            const delta = evt.delta as { stop_reason?: string };
            if (delta?.stop_reason) stopReason = delta.stop_reason;
            const usage = (evt.usage as { output_tokens?: number }) ?? {};
            if (usage.output_tokens) outputTokens = usage.output_tokens;
            break;
          }
          case 'error': {
            const e = evt.error as { message?: string };
            throw new CopilotError('LLM_ERROR', `Stream error : ${e?.message ?? 'unknown'}`);
          }
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  return { textBlocks, toolUses, stopReason, inputTokens, outputTokens };
}

// =============================================================
// SECTION 11 — Orchestrateur (boucle tool-calling)
// =============================================================

interface OrchestratorResult {
  finalText: string;
  toolCallsLog: Array<{
    id: string; name: string; input: unknown; output: unknown;
    status: 'success' | 'error'; durationMs: number; error?: string;
  }>;
  totalInputTokens: number;
  totalOutputTokens: number;
  model: string;
  finishReason: string;
}

async function runOrchestrator(params: {
  mode: CopilotMode;
  tier: ModelTier;                    // ⬅️ nouveau
  ctx: MimmozaContext;
  messages: AnthropicMessage[];
  sse: SSEWriter;
  auth?: AuthCtx | null;
  onGenerationStart?: () => void;
}): Promise<OrchestratorResult> {
  const { mode, tier, ctx, sse, onGenerationStart } = params;
  const auth = params.auth ?? null;
  const model = TIER_MODEL_ID[tier];   // ⬅️ le modèle suit le plan, pas le mode
  const system = buildSystemPrompt(ctx, mode);
  const tools = toolsForMode(mode);
  const maxIter = MAX_TOOL_ITERATIONS[mode];

  const messages = [...params.messages];
  const toolCallsLog: OrchestratorResult['toolCallsLog'] = [];
  let finalText = '';
  let totalIn = 0;
  let totalOut = 0;
  let finishReason = 'end_turn';

  for (let iter = 0; iter < maxIter; iter++) {
    const turn = await streamLLMTurn({
      model, system, messages, tools,
      maxTokens: MAX_OUTPUT_TOKENS[mode],
      onToken: (delta) => sse.send({ type: 'token', delta }),
      onGenerationStart,   // NEW
    });

    totalIn += turn.inputTokens;
    totalOut += turn.outputTokens;
    finalText += turn.textBlocks.join('\n');
    finishReason = turn.stopReason;

    if (turn.stopReason !== 'tool_use' || turn.toolUses.length === 0) {
      break;
    }

    const assistantContent: unknown[] = [];
    for (const t of turn.textBlocks) {
      assistantContent.push({ type: 'text', text: t });
    }
    for (const tu of turn.toolUses) {
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults: unknown[] = [];
    for (const tu of turn.toolUses) {
      sse.send({ type: 'tool_use_start', call: { id: tu.id, name: tu.name, input: tu.input } });
      const started = Date.now();
      try {
        const output = await executeTool(tu.name, tu.input, ctx, auth);
        const durationMs = Date.now() - started;
        // Le statut métier (not_configured, not_found…) n'est PAS une erreur
        // technique : on le transmet au LLM qui sait l'interpréter.
        const isOk = output.status === 'ok' || output.status === 'partial';
        toolCallsLog.push({
          id: tu.id, name: tu.name, input: tu.input,
          output, status: isOk ? 'success' : 'error', durationMs,
          error: isOk ? undefined : `${output.status}: ${output.message ?? ''}`,
        });
        sse.send({
          type: 'tool_use_end',
          call: {
            id: tu.id, name: tu.name, output,
            duration_ms: durationMs,
            status: isOk ? 'success' : output.status,
            error: isOk ? undefined : output.message,
          },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(output),
        });
      } catch (e) {
        const durationMs = Date.now() - started;
        const msg = e instanceof Error ? e.message : 'tool error';
        toolCallsLog.push({
          id: tu.id, name: tu.name, input: tu.input,
          output: null, status: 'error', durationMs, error: msg,
        });
        sse.send({
          type: 'tool_use_end',
          call: { id: tu.id, name: tu.name, output: null, duration_ms: durationMs, status: 'error', error: msg },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `Erreur outil : ${msg}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Filet de sécurité : si la boucle s'arrête alors que le modèle voulait encore
  // un outil (plafond d'itérations atteint), on force une dernière passe SANS
  // outils pour produire la réponse finale — sinon l'utilisateur ne voit que la
  // narration d'avant-outil (cas quick mode + 2 outils enchaînés).
  if (finishReason === 'tool_use') {
    const finalTurn = await streamLLMTurn({
      model, system, messages, tools: [],
      maxTokens: MAX_OUTPUT_TOKENS[mode],
      onToken: (delta) => sse.send({ type: 'token', delta }),
    });
    totalIn += finalTurn.inputTokens;
    totalOut += finalTurn.outputTokens;
    finalText += (finalText ? '\n' : '') + finalTurn.textBlocks.join('\n');
    finishReason = finalTurn.stopReason;
  }

  return {
    finalText,
    toolCallsLog,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    model,
    finishReason,
  };
}

// =============================================================
// SECTION 12 — Persistance
// =============================================================

async function ensureConversation(params: {
  conversationId?: string;
  userId: string;
  ctx: MimmozaContext;
  firstMessage: string;
}): Promise<string> {
  const { conversationId, userId, ctx, firstMessage } = params;
  if (conversationId) {
    const { data } = await getAdmin()
      .from('copilot_conversations')
      .select('id').eq('id', conversationId).eq('user_id', userId).maybeSingle();
    if (data?.id) return data.id;
  }
  const title = firstMessage.slice(0, 60) + (firstMessage.length > 60 ? '…' : '');

  // ⚠️ context_study_id est une colonne uuid : un slug type "demo-study-001"
  // fait échouer l'insert avec « invalid input syntax for type uuid », ce qui
  // tue la conversation AVANT tout appel LLM. On n'écrit que si c'est un uuid ;
  // sinon null (l'étude reste exploitable via le contexte injecté au prompt).
  const rawStudyId = ctx.study?.id ?? null;
  const studyIdUuid =
    rawStudyId && UUID_V4_RE.test(rawStudyId) ? rawStudyId : null;
  if (rawStudyId && !studyIdUuid) {
    console.warn('[copilot] study.id non-uuid ignoré pour context_study_id:', rawStudyId);
  }

  const { data, error } = await getAdmin()
    .from('copilot_conversations')
    .insert({
      user_id: userId,
      title,
      vertical: ctx.vertical,
      context_parcel_id: ctx.parcel?.id ?? null,
      context_route: ctx.route,
      context_study_id: studyIdUuid,
    })
    .select('id').single();
  if (error || !data) throw new CopilotError('INTERNAL_ERROR', `Création conversation : ${error?.message}`);
  return data.id;
}

async function saveUserMessage(p: {
  conversationId: string; userId: string; text: string; mode: CopilotMode;
}): Promise<void> {
  await getAdmin().from('copilot_messages').insert({
    conversation_id: p.conversationId, user_id: p.userId, role: 'user',
    content: [{ type: 'text', text: p.text }], mode: p.mode, credits_cost: 0,
  });
}

async function saveAssistantMessage(p: {
  conversationId: string; userId: string; result: OrchestratorResult;
  mode: CopilotMode; latencyMs: number; creditsCost?: number;
}): Promise<string> {
  const content: unknown[] = [{ type: 'text', text: p.result.finalText }];
  const { data, error } = await getAdmin().from('copilot_messages').insert({
    conversation_id: p.conversationId, user_id: p.userId, role: 'assistant',
    content, mode: p.mode, model: p.result.model,
    input_tokens: p.result.totalInputTokens,
    output_tokens: p.result.totalOutputTokens,
    credits_cost: p.creditsCost ?? CREDIT_COST[p.mode],
    latency_ms: p.latencyMs, finish_reason: p.result.finishReason,
  }).select('id').single();
  if (error || !data) throw new CopilotError('INTERNAL_ERROR', `Sauvegarde message : ${error?.message}`);

  if (p.result.toolCallsLog.length > 0) {
    try {
      await getAdmin().from('copilot_tool_calls').insert(
        p.result.toolCallsLog.map((tc) => ({
          message_id: data.id, conversation_id: p.conversationId, user_id: p.userId,
          tool_name: tc.name, tool_input: tc.input, tool_output: tc.output,
          status: tc.status, error: tc.error ?? null, duration_ms: tc.durationMs,
        })),
      );
    } catch (e) { console.error('[persist] tool_calls failed', e); }
  }
  return data.id;
}

// =============================================================
// SECTION 13 — Handler HTTP principal
// =============================================================

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

async function requireUserId(req: Request): Promise<string> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) throw new CopilotError('UNAUTHORIZED', 'Missing Authorization');
  const { data, error } = await getUserClient(authHeader).auth.getUser();
  if (error || !data?.user) throw new CopilotError('UNAUTHORIZED', 'Invalid JWT');
  return data.user.id;
}

function validateRequest(body: unknown): ChatRequest {
  const b = body as Partial<ChatRequest>;
  if (!b || typeof b.message !== 'string' || !b.message.trim()) {
    throw new CopilotError('BAD_REQUEST', 'message requis');
  }
  // Le mode est désormais dérivé du plan côté serveur ; on n'exige plus rien du client.
  b.mode = b.mode ?? 'quick';
  if (!b.context || !b.context.vertical || !b.context.route) {
    throw new CopilotError('CONTEXT_REQUIRED', 'context.vertical et context.route requis');
  }
  if (b.message.length > 8000) {
    throw new CopilotError('CONTEXT_TOO_LARGE', 'message trop long (max 8000 caractères)');
  }
  if (b.attachments !== undefined) {
    if (!Array.isArray(b.attachments) || b.attachments.length > MAX_ATTACHMENTS) {
      throw new CopilotError('BAD_REQUEST', `attachments : tableau de ${MAX_ATTACHMENTS} elements maximum`);
    }
    let totalB64 = 0;
    for (const a of b.attachments) {
      if (!a || typeof a.data !== 'string' || !ALLOWED_MEDIA_TYPES.has(a.mediaType)) {
        throw new CopilotError('BAD_REQUEST', `Type de piece jointe non pris en charge : ${a?.mediaType}`);
      }
      totalB64 += a.data.length;
    }
    if (totalB64 > MAX_ATTACHMENT_B64) {
      throw new CopilotError('CONTEXT_TOO_LARGE', 'Pieces jointes trop volumineuses');
    }
  }
  return b as ChatRequest;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'POST only' }), {
      status: 404, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  let userId: string;
  let payload: ChatRequest;
  let conversationId: string;
  let reservationId: string;
  let remainingBalance: number;
  let mode: CopilotMode;
  let tier: ModelTier;
  let plan: Plan;
  let reserved: number;          // montant RÉELLEMENT réservé (pire cas)

  try {
    userId = await requireUserId(req);
    payload = validateRequest(await req.json());

    conversationId = await ensureConversation({
      conversationId: payload.conversation_id,
      userId, ctx: payload.context, firstMessage: payload.message,
    });

    // ── Plan lu CÔTÉ SERVEUR (jamais depuis le client) ──────────
    plan = await getUserPlan(userId);
    mode = PLAN_POLICY[plan].mode;
    const requestedTier = (payload as any).tier as ModelTier | undefined;
    tier = resolveTier(plan, plan === 'pro' ? requestedTier : undefined);

    reserved = worstCaseJetons(tier, mode);
    const reservation = await reserveCredits({
      userId,
      amount: reserved,                       // ⬅️ gate = pire cas
      reason: `copilot ${plan}/${tier}`,
      conversationId,
    });
    reservationId = reservation.reservationId;
    remainingBalance = reservation.remainingBalance;

    await saveUserMessage({
      conversationId, userId, text: payload.message, mode,
    });
  } catch (err) {
    const e = err instanceof CopilotError ? err : new CopilotError('INTERNAL_ERROR', String(err));
    return new Response(JSON.stringify(e.toJSON()), {
      status: e.statusCode, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const startedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
  const sse = new SSEWriter(controller);
  let billable = false;   // NEW : la génération a démarré → plus de refund
  let settled  = false;   // NEW : évite double settle/refund

  try {
    sse.send({ type: 'reservation', reserved_credits: reserved, remaining: remainingBalance });
    sse.send({ type: 'conversation', conversation_id: conversationId });

    const messages = await buildMessages(conversationId, payload.message, mode, payload.attachments);

    const result = await runOrchestrator({
      mode, tier, ctx: payload.context, messages, sse,   // ⬅️ tier ajouté
      // userId vient de requireUserId() (JWT vérifié) ; l'en-tête est réutilisé
      // tel quel pour que les écritures passent par le client UTILISATEUR.
      auth: { userId, authHeader: req.headers.get('Authorization') ?? '' },
      onGenerationStart: () => { billable = true; },
    });

    const latencyMs = Date.now() - startedAt;
    // ── Débit RÉEL calculé sur l'usage renvoyé par l'API ────────
    const debit = debitJetons(tier, result.totalInputTokens, result.totalOutputTokens);

    const messageId = await saveAssistantMessage({
      conversationId, userId, result, mode, latencyMs, creditsCost: debit,
    });

    await settleCredits({
      userId, reservationId, messageId, mode,
      finalAmount: debit,                       // ⬅️ le settle rend la différence
      metadata: {
        inputTokens: result.totalInputTokens,
        outputTokens: result.totalOutputTokens,
        model: result.model, tier, plan, debit, latencyMs,
        toolCalls: result.toolCallsLog.length,
      },
    });
    
    settled = true;   // NEW

    sse.send({ type: 'message_start', message_id: messageId });
    sse.send({ type: 'done', message_id: messageId, final_credits: debit });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erreur interne';
    console.error('[copilot-chat] orchestration error', err);

    if (billable && !settled) {
      // NEW : génération déjà commencée → on FACTURE, pas de refund.
      try {
        const messageId = await saveAssistantMessage({
          conversationId, userId, mode,
          latencyMs: Date.now() - startedAt,
          result: {
            finalText: '[réponse interrompue]',
            toolCallsLog: [],
            totalInputTokens: 0,
            totalOutputTokens: 0,
            model: TIER_MODEL_ID[tier],
            finishReason: 'interrupted',
          },
        });
        await settleCredits({
          userId, reservationId, messageId, mode,
          metadata: { interrupted: true },
        });
        settled = true;
      } catch (e) {
        console.error('[credits] settle-after-interrupt failed', e);
      }
      sse.send({ type: 'error', error: msg });   // NEW : aucun refunded_credits

    } else if (!settled) {
      // Échec AVANT toute génération → remboursable (429, timeout, clé API…).
      const refunded = await refundCredits({ userId, reservationId, reason: 'failed before generation' });
      sse.send({ type: 'error', error: msg, refunded_credits: refunded });
    }
  } finally {
        sse.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});