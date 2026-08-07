// supabase/functions/loyers-reference-v1/index.ts
// =============================================================
// Mimmoza — Loyers de référence (Carte des loyers ANIL/DHUP)
// Source de données #1 branchée dans MimmozIA.
//
// Rôle : renvoyer le loyer médian (€/m²/mois) d'une commune,
//   ventilé appartement / maison + médiane globale, à partir de
//   la table public.loyers_reference (34 900 communes, millésime 2025).
//
// Autonome (éditée dans le Dashboard, aucun import _shared) :
//   - chemin principal : lit la table par code_insee ;
//   - repli : résout code_insee depuis une commune / un code postal
//     via geo.api.gouv.fr (déjà whitelistée réseau) ;
//   - PLM : Paris (75056), Lyon (69123), Marseille (13055) n'ont PAS
//     de ligne « commune globale » → éclatement sur les arrondissements
//     et renvoi d'une fourchette min–médiane–max.
//
// Contrat de sortie (aligné dpe-ademe-v1 / patrimoine-merimee-v1 / batiment-bdnb-v1) :
//   { status, summary, stats, items }
//   status ∈ 'ok' | 'no_data' | 'no_localization' | 'error'
//   → renvoyé en HTTP 200 même pour no_data / error, pour que
//     l'orchestrateur (callInternalFunction) ne les traite pas comme
//     des erreurs HTTP mais comme des statuts métier.
//
// Secrets utilisés : SUPABASE_URL + clé service-role.
//   ⚠️ Projet sur JWT Signing Keys : on lit SUPABASE_SECRET_KEYS
//      (dictionnaire JSON) EN PRIORITÉ ; la legacy provoque un 401.
// =============================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

// ── PLM : codes « commune globale » (absents de la table) → arrondissements ──
const PLM_ARRONDISSEMENTS: Record<string, string[]> = {
  '75056': range(75101, 75120), // Paris  (20 arrondissements)
  '69123': range(69381, 69389), // Lyon   (9 arrondissements)
  '13055': range(13201, 13216), // Marseille (16 arrondissements)
};
const PLM_LABEL: Record<string, string> = {
  '75056': 'Paris',
  '69123': 'Lyon',
  '13055': 'Marseille',
};

function range(from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(String(i));
  return out;
}

// ── Colonnes lues (schéma public.loyers_reference) ───────────
const COLS = [
  'code_insee', 'commune_nom',
  'loyer_median_appartement', 'loyer_median_maison', 'loyer_median_global',
  'nbobs_appartement', 'nbobs_maison', 'nb_observations',
  'typpred_appartement', 'typpred_maison',
  'millesime',
].join(', ');

// =============================================================
// Client Supabase service-role (multi-clés, JWT Signing Keys)
// =============================================================

function readFirstJsonKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const first = Object.values(parsed).find((v) => typeof v === 'string');
      if (typeof first === 'string') return first;
    }
  } catch {
    return raw; // valeur brute (pas du JSON)
  }
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

// =============================================================
// Helpers
// =============================================================

function cors(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}

function normStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Résout un code INSEE (+ nom) depuis une commune ou un code postal via geo.api. */
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
  } catch { /* geo.api injoignable → on continue sans */ }
  return {};
}

/** min / médiane / max d'une série numérique (ignore les valeurs non finies). */
function stat(values: unknown[]): { min: number; median: number; max: number } | null {
  const v = values
    .map((x) => (typeof x === 'string' ? Number(x) : x))
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return {
    min: v[0],
    median: Math.round(median * 100) / 100,
    max: v[v.length - 1],
  };
}

/** Arrondi d'affichage : 13.5907932383616 → 13.59. Renvoie undefined si non numérique. */
function money(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
}

// ── Lectures table ───────────────────────────────────────────
async function readCommune(codeInsee: string): Promise<Record<string, any> | null> {
  const { data, error } = await getAdmin()
    .from('loyers_reference').select(COLS)
    .eq('code_insee', codeInsee).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function readArrondissements(codes: string[]): Promise<Record<string, any>[]> {
  const { data, error } = await getAdmin()
    .from('loyers_reference').select(COLS)
    .in('code_insee', codes)
    .order('code_insee', { ascending: true });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data : [];
}

// =============================================================
// Handler
// =============================================================

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ status: 'error', summary: 'POST only', stats: null, items: [] }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* corps vide/illisible → {} */ }

  let codeInsee = normStr(body.code_insee);
  const commune = normStr(body.commune) ?? normStr(body.city);
  const zipCode = normStr(body.zip_code) ?? normStr(body.code_postal);

  // ── Résolution INSEE (repli autonome) ──────────────────────
  // geo.api renvoie le code « commune globale » (75056/69123/13055) pour
  // Paris/Lyon/Marseille recherchés par nom → l'éclatement PLM prend le relais.
  // Un code postal d'arrondissement (ex. 75001) renvoie l'arrondissement (75101).
  let communeNomResolu: string | undefined;
  if (!codeInsee && (commune || zipCode)) {
    const g = await resolveInseeFromGeo({ commune, zipCode });
    if (g.code) { codeInsee = g.code; communeNomResolu = g.nom; }
  }

  if (!codeInsee) {
    return json({
      status: 'no_localization',
      summary: "Localisation insuffisante : fournir un code INSEE, une commune ou un code postal.",
      stats: null,
      items: [],
    }, 200);
  }

  try {
    // ── Cas PLM : code « commune globale » → éclatement arrondissements ──
    if (PLM_ARRONDISSEMENTS[codeInsee]) {
      const label = PLM_LABEL[codeInsee];
      const rows = await readArrondissements(PLM_ARRONDISSEMENTS[codeInsee]);
      if (rows.length === 0) {
        return json({
          status: 'no_data',
          summary: `Aucun loyer de référence trouvé pour les arrondissements de ${label}.`,
          stats: { is_plm: true, commune_nom: label, unite: '€/m²/mois' },
          items: [],
        }, 200);
      }
      const millesime = rows[0].millesime ?? null;
      const g = stat(rows.map((r) => r.loyer_median_global));
      const app = stat(rows.map((r) => r.loyer_median_appartement));
      const mai = stat(rows.map((r) => r.loyer_median_maison));
      const ref = g ?? app ?? mai; // repli si la médiane globale manque partout
      return json({
        status: 'ok',
        summary: ref
          ? `Loyers de référence ${label} (millésime ${millesime}) — varie selon arrondissement : ` +
            `${ref.min}–${ref.max} €/m²/mois (médiane ${ref.median})${g ? '' : ' — sur la base des ventilations appartement/maison'}.`
          : `Loyers de référence ${label} (millésime ${millesime}) : données par arrondissement disponibles, médiane non calculable.`,
        stats: {
          is_plm: true,
          commune_nom: label,
          millesime,
          nb_arrondissements: rows.length,
          global: g,
          appartement: app,
          maison: mai,
          unite: '€/m²/mois',
          source: 'Carte des loyers ANIL/DHUP',
        },
        items: rows.map((r) => ({
          code_insee: r.code_insee,
          commune_nom: r.commune_nom,
          loyer_median_global: r.loyer_median_global,
          loyer_median_appartement: r.loyer_median_appartement,
          loyer_median_maison: r.loyer_median_maison,
        })),
      }, 200);
    }

    // ── Cas standard : commune unique ou arrondissement précis ──
    const row = await readCommune(codeInsee);
    if (!row) {
      const who = communeNomResolu ?? commune ?? `code INSEE ${codeInsee}`;
      return json({
        status: 'no_data',
        summary: `Aucun loyer de référence pour ${who} (code INSEE ${codeInsee}). Commune peut-être non couverte par la Carte des loyers.`,
        stats: null,
        items: [],
      }, 200);
    }
    // La source ne fournit pas toujours la médiane globale : on la reconstitue
    // à partir des ventilations plutôt que d'afficher « null » à l'utilisateur.
    const app = money(row.loyer_median_appartement);
    const mai = money(row.loyer_median_maison);
    let global = money(row.loyer_median_global);
    let globalEstime = false;
    if (global === undefined) {
      const dispo = [app, mai].filter((x): x is number => x !== undefined);
      if (dispo.length) {
        global = Math.round((dispo.reduce((a, b) => a + b, 0) / dispo.length) * 100) / 100;
        globalEstime = true;
      }
    }
    const ventilation = [
      app !== undefined ? `appartement ${app}` : null,
      mai !== undefined ? `maison ${mai}` : null,
    ].filter(Boolean).join(', ');
    const tete = global !== undefined
      ? `${global} €/m²/mois${globalEstime ? ' (estimé : moyenne appartement/maison, la source ne publie pas de médiane globale ici)' : ''}`
      : 'médiane non disponible';

    return json({
      status: 'ok',
      summary:
        `Loyer médian ${row.commune_nom} (millésime ${row.millesime}) : ${tete}` +
        `${ventilation ? ` — ${ventilation}` : ''}.`,
      stats: {
        is_plm: false,
        code_insee: row.code_insee,
        commune_nom: row.commune_nom,
        millesime: row.millesime,
        loyer_median_global: global ?? null,
        loyer_median_global_estime: globalEstime,
        loyer_median_appartement: app ?? null,
        loyer_median_maison: mai ?? null,
        nb_observations: row.nb_observations,
        nbobs_appartement: row.nbobs_appartement,
        nbobs_maison: row.nbobs_maison,
        typpred_appartement: row.typpred_appartement,
        typpred_maison: row.typpred_maison,
        unite: '€/m²/mois',
        source: 'Carte des loyers ANIL/DHUP',
      },
      items: [row],
    }, 200);
  } catch (e) {
    return json({
      status: 'error',
      summary: `Erreur lecture loyers_reference : ${e instanceof Error ? e.message : String(e)}`,
      stats: null,
      items: [],
    }, 200);
  }
});