// supabase/functions/zonage-abc-v1/index.ts
// =============================================================
// Mimmoza — Zonage ABC (source #4, ouvre la vague 2)
//
// Rôle : renvoyer la zone de tension d'une commune (Abis / A / B1 / B2 / C)
//   à partir de la table public.zonage_abc (import data.gouv, arrêté 23/06/2026).
//
// ⚠️ Pinel : le dispositif a pris fin le 31/12/2024. Ce zonage ne sert PLUS à
//    ouvrir droit au Pinel pour un nouvel investissement. Il reste LA référence
//    pour Loc'Avantages, PTZ, LLI, Denormandie, PSLA/PLS/BRS, et les plafonds
//    de loyers/ressources. La réponse porte cette mise au point.
//
// Autonome (Dashboard, aucun import _shared) :
//   - lit la table par code_insee ;
//   - repli : résout l'INSEE depuis commune / code postal via geo.api ;
//   - PLM : si un code « commune globale » (75056/69123/13055) n'existe pas en
//     base, repli sur les arrondissements (même zone).
//
// Secrets : SUPABASE_URL + clé service-role (SUPABASE_SECRET_KEYS prioritaire).
//
// Contrat de sortie (aligné dpe/merimee/bdnb/loyers/servitudes/solaire) :
//   { status, summary, stats, items }
//   status ∈ 'ok' | 'no_data' | 'no_localization' | 'error'  (toujours HTTP 200)
// =============================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const ZONE_LIBELLE: Record<string, string> = {
  Abis: 'A bis — marché le plus tendu (Paris et petite couronne, quelques communes très tendues)',
  A: 'A — agglomérations très tendues',
  B1: 'B1 — grandes agglomérations et zones tendues',
  B2: 'B2 — communes de tension moyenne',
  C: 'C — reste du territoire, marché détendu',
};

const PLM_FALLBACK: Record<string, string[]> = {
  '75056': range(75101, 75120), // Paris
  '69123': range(69381, 69389), // Lyon
  '13055': range(13201, 13216), // Marseille
};
function range(from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(String(i));
  return out;
}

// ── Client service-role (multi-clés, JWT Signing Keys) ───────
function readFirstJsonKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const first = Object.values(parsed).find((v) => typeof v === 'string');
      if (typeof first === 'string') return first;
    }
  } catch { return raw; }
  return null;
}
let _admin: SupabaseClient | null = null;
function getAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const url = Deno.env.get('SUPABASE_URL');
  const key =
    readFirstJsonKey(Deno.env.get('SUPABASE_SECRET_KEYS')) ??
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
    Deno.env.get('SERVICE_ROLE_KEY');
  if (!url) throw new Error('Missing SUPABASE_URL env');
  if (!key) throw new Error('Missing Supabase service role key env');
  _admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
  return _admin;
}

// ── Helpers HTTP ─────────────────────────────────────────────
function cors(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}
function normStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

async function resolveInseeFromGeo(p: { commune?: string; zipCode?: string }): Promise<{ code?: string; nom?: string }> {
  const query = p.zipCode
    ? `codePostal=${encodeURIComponent(p.zipCode)}`
    : (p.commune ? `nom=${encodeURIComponent(p.commune)}` : null);
  if (!query) return {};
  try {
    const r = await fetch(
      `https://geo.api.gouv.fr/communes?${query}&fields=code,nom&limit=1`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!r.ok) return {};
    const d = await r.json();
    if (Array.isArray(d) && d[0]?.code) return { code: String(d[0].code), nom: d[0].nom };
  } catch { /* injoignable */ }
  return {};
}

const COLS = 'code_insee, commune_nom, zone, millesime';

async function readByInsee(code: string): Promise<Record<string, any> | null> {
  const { data, error } = await getAdmin()
    .from('zonage_abc').select(COLS).eq('code_insee', code).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}
async function readFirstOf(codes: string[]): Promise<Record<string, any> | null> {
  const { data, error } = await getAdmin()
    .from('zonage_abc').select(COLS).in('code_insee', codes)
    .order('code_insee', { ascending: true }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

const DISPOSITIFS =
  "Zone de référence pour Loc'Avantages, PTZ, LLI, Denormandie, PSLA/PLS/BRS et les plafonds de loyers/ressources.";
const PINEL_NOTE =
  'Le dispositif Pinel a pris fin le 31/12/2024 : ce zonage ne conditionne plus aucun nouvel investissement Pinel.';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ status: 'error', summary: 'POST only', stats: null, items: [] }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* {} */ }

  let codeInsee = normStr(body.code_insee);
  const commune = normStr(body.commune) ?? normStr(body.city);
  const zipCode = normStr(body.zip_code) ?? normStr(body.code_postal);

  let communeNomResolu: string | undefined;
  if (!codeInsee && (commune || zipCode)) {
    const g = await resolveInseeFromGeo({ commune, zipCode });
    if (g.code) { codeInsee = g.code; communeNomResolu = g.nom; }
  }

  if (!codeInsee) {
    return json({
      status: 'no_localization',
      summary: "Localisation insuffisante : fournir un code INSEE, une commune ou un code postal.",
      stats: null, items: [],
    }, 200);
  }

  try {
    let row = await readByInsee(codeInsee);
    // PLM : code global absent → repli arrondissements (même zone).
    if (!row && PLM_FALLBACK[codeInsee]) row = await readFirstOf(PLM_FALLBACK[codeInsee]);

    if (!row) {
      const who = communeNomResolu ?? commune ?? `code INSEE ${codeInsee}`;
      return json({
        status: 'no_data',
        summary: `Zonage ABC introuvable pour ${who} (code INSEE ${codeInsee}).`,
        stats: null, items: [],
      }, 200);
    }

    const zone = String(row.zone);
    return json({
      status: 'ok',
      summary: `${row.commune_nom ?? codeInsee} est en zone ${zone} (${ZONE_LIBELLE[zone] ?? 'zonage ABC'}). ${PINEL_NOTE}`,
      stats: {
        code_insee: row.code_insee,
        commune_nom: row.commune_nom ?? null,
        zone,
        zone_libelle: ZONE_LIBELLE[zone] ?? null,
        millesime: row.millesime ?? null,
        dispositifs_concernes: DISPOSITIFS,
        pinel: PINEL_NOTE,
        source: 'Zonage ABC (DHUP / data.gouv, arrêté du 23/06/2026)',
      },
      items: [row],
    }, 200);
  } catch (e) {
    return json({
      status: 'error',
      summary: `Erreur lecture zonage_abc : ${e instanceof Error ? e.message : String(e)}`,
      stats: null, items: [],
    }, 200);
  }
});