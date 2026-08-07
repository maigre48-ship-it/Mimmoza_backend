// supabase/functions/assainissement-commune-v1/index.ts
// =============================================================
// Mimmoza — Assainissement niveau commune (source #7)
//
// Rôle : indiquer, pour une commune, la présence d'un service d'assainissement
//   COLLECTIF (raccordement au réseau possible) et/ou NON COLLECTIF (ANC/SPANC),
//   avec l'opérateur, à partir de la table public.assainissement_commune
//   (import SISPEA composition communale, millésime 2025).
//
// ⚠️ LIMITE ASSUMÉE : le zonage d'assainissement à la PARCELLE (collectif vs
//   non collectif) est annexé au PLU et publié commune par commune — pas de
//   couverture nationale. Cette source répond au niveau COMMUNE :
//     - ac_present = false  → aucun service collectif → assainissement non
//       collectif (ANC/fosse) à prévoir pour tout projet ;
//     - ac_present = true   → la commune a un service collectif, MAIS une
//       parcelle donnée peut rester en zone non collective. À confirmer par le
//       zonage d'assainissement communal / la mairie. Ne jamais l'affirmer à la
//       parcelle depuis cette seule donnée.
//
// Autonome (Dashboard, aucun import _shared) :
//   - lit la table par code_insee ;
//   - repli : résout l'INSEE depuis commune / code postal via geo.api ;
//   - PLM : repli arrondissement si code global absent.
//
// Secrets : SUPABASE_URL + clé service-role (SUPABASE_SECRET_KEYS prioritaire).
//
// Contrat de sortie : { status, summary, stats, items } — toujours HTTP 200
//   status ∈ 'ok' | 'no_data' | 'no_localization' | 'error'
// =============================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const PLM_FALLBACK: Record<string, string> = {
  '75056': '75101', '69123': '69381', '13055': '13201',
};

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

function cors(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...cors(), 'Content-Type': 'application/json' } });
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
    const r = await fetch(`https://geo.api.gouv.fr/communes?${query}&fields=code,nom&limit=1`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return {};
    const d = await r.json();
    if (Array.isArray(d) && d[0]?.code) return { code: String(d[0].code), nom: d[0].nom };
  } catch { /* injoignable */ }
  return {};
}

const COLS = 'code_insee, commune_nom, ac_present, anc_present, ac_service, anc_service, millesime';

async function readByInsee(code: string): Promise<Record<string, any> | null> {
  const { data, error } = await getAdmin().from('assainissement_commune').select(COLS).eq('code_insee', code).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

const NOTE_PARCELLE =
  "Donnée au niveau COMMUNE. Le zonage d'assainissement à la parcelle (collectif vs non collectif) n'existe pas en national : le confirmer via le zonage d'assainissement communal ou la mairie.";
const SOURCE = 'SISPEA — Observatoire des services d\'eau et d\'assainissement (services.eaufrance.fr)';

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
    if (!row && PLM_FALLBACK[codeInsee]) row = await readByInsee(PLM_FALLBACK[codeInsee]);

    if (!row) {
      return json({
        status: 'no_data',
        summary: `Aucune donnée d'assainissement pour ${communeNomResolu ?? commune ?? `INSEE ${codeInsee}`} (code INSEE ${codeInsee}).`,
        stats: null, items: [],
      }, 200);
    }

    const nom = row.commune_nom ?? communeNomResolu ?? codeInsee;
    const ac = row.ac_present === true;
    const anc = row.anc_present === true;
    const summary =
      `${nom} : assainissement collectif ${ac ? 'PRÉSENT' : 'absent'}` +
      (ac && row.ac_service ? ` (service ${row.ac_service})` : '') +
      `. Service ANC/SPANC ${anc ? 'présent' : 'non recensé'}` +
      (anc && row.anc_service ? ` (${row.anc_service})` : '') + '.' +
      (ac ? '' : ' Sans service collectif → assainissement non collectif (ANC) à prévoir.') +
      ` ${NOTE_PARCELLE}`;

    return json({
      status: 'ok',
      summary,
      stats: {
        code_insee: row.code_insee,
        commune_nom: row.commune_nom ?? null,
        assainissement_collectif_present: ac,
        assainissement_non_collectif_present: anc,
        service_collectif: row.ac_service ?? null,
        service_anc: row.anc_service ?? null,
        millesime: row.millesime ?? null,
        note_parcelle: NOTE_PARCELLE,
        source: SOURCE,
      },
      items: [row],
    }, 200);
  } catch (e) {
    return json({
      status: 'error',
      summary: `Erreur lecture assainissement_commune : ${e instanceof Error ? e.message : String(e)}`,
      stats: null, items: [],
    }, 200);
  }
});