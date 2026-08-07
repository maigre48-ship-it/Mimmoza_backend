// supabase/functions/batiment-bdnb-v1/index.ts
// =============================================================
// Bâtiment BDNB v1 — Carte d'identité du bâti (CSTB)
// Source : API BDNB Open  https://api.bdnb.io/v1/bdnb
//   Sans authentification, 10 000 req/mois. Format PostgREST (champ=eq.valeur).
//   Table batiment_groupe_complet : agrège ~400 attributs par groupe bâtiment.
//
// ENTRÉE (body JSON) : { address?, code_insee? }
//   → /adresse (géocode BAN interne) en priorité ; repli commune (code_insee).
//
// SORTIE : { status, summary, stats, items }
//   status : 'ok' | 'no_data' | 'no_localization' | 'error'
//
// Attribution obligatoire : « BDNB - CSTB ».
// ⚠️ Beaucoup de champs sont null (données non renseignées, pas absentes du bâti).
//    On ne conclut jamais d'un null.
// =============================================================

const BDNB_BASE = 'https://api.bdnb.io/v1/bdnb/donnees/batiment_groupe_complet';
const BDNB_TIMEOUT_MS = 12000;

// Colonnes utiles (limite la charge — la table en a ~400).
const SELECT_COLS = [
  'batiment_groupe_id',
  'annee_construction',
  'usage_principal_bdnb_open',
  'usage_niveau_1_txt',
  'mat_mur_txt',
  'mat_toit_txt',
  'nb_niveau',
  'nb_log',
  'hauteur_mean',
  'surface_emprise_sol',
  's_geom_groupe',
  'classe_bilan_dpe',
  'alea_argile',
  'perimetre_bat_historique',
  'distance_monument_historique',
  'nom_batiment_historique_plus_proche',
  'batenr_favorabilite_solaire_thermique',
  'libelle_adr_principale_ban',
  'libelle_commune_insee',
  'l_parcelle_id',
].join(',');

type BdnbStatus = 'ok' | 'no_data' | 'no_localization' | 'error';

interface BdnbInput {
  address?: string;
  code_insee?: string;
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function fetchBdnb(path: string, params: URLSearchParams): Promise<Record<string, unknown>[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BDNB_TIMEOUT_MS);
  try {
    const res = await fetch(`${path}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`BDNB HTTP ${res.status}`);
    const data = await res.json();
    // La BDNB enrobe dans { value: [...], Count } ; certains endpoints renvoient
    // un tableau direct. On gère les deux.
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.value)) return data.value;
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function summarizeBatiment(b: Record<string, unknown>): Record<string, unknown> {
  return {
    annee_construction: numOrNull(b['annee_construction']),
    usage: str(b['usage_principal_bdnb_open']) ?? str(b['usage_niveau_1_txt']) ?? null,
    materiau_murs: str(b['mat_mur_txt']) ?? null,
    materiau_toit: str(b['mat_toit_txt']) ?? null,
    nb_niveaux: numOrNull(b['nb_niveau']),
    nb_logements: numOrNull(b['nb_log']),
    hauteur_moyenne_m: numOrNull(b['hauteur_mean']),
    emprise_sol_m2: numOrNull(b['surface_emprise_sol']) ?? numOrNull(b['s_geom_groupe']),
    classe_dpe_representative: str(b['classe_bilan_dpe']) ?? null,
    alea_argile: str(b['alea_argile']) ?? null,
    dans_perimetre_mh: b['perimetre_bat_historique'] === true,
    distance_mh_m: numOrNull(b['distance_monument_historique']),
    monument_proche: str(b['nom_batiment_historique_plus_proche']) ?? null,
    potentiel_solaire_thermique: b['batenr_favorabilite_solaire_thermique'] === true,
    adresse: str(b['libelle_adr_principale_ban']) ?? null,
    commune: str(b['libelle_commune_insee']) ?? null,
    parcelles: Array.isArray(b['l_parcelle_id']) ? b['l_parcelle_id'] : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== 'POST') return json({ status: 'error', summary: 'POST only' }, 405);

  let input: BdnbInput;
  try {
    input = (await req.json()) as BdnbInput;
  } catch {
    return json({ status: 'error', summary: 'Body JSON invalide.' }, 400);
  }

  const address = str(input.address);
  const codeInsee = str(input.code_insee);

  if (!address && !codeInsee) {
    return json({
      status: 'no_localization' as BdnbStatus,
      summary: "Localisation insuffisante pour interroger la BDNB (ni adresse, ni code INSEE).",
      stats: null,
      items: [],
    });
  }

  try {
    let rows: Record<string, unknown>[] = [];

    if (address) {
      // Endpoint /adresse : géocode l'adresse via BAN en interne.
      const p = new URLSearchParams();
      p.set('adresse', address);
      p.set('select', SELECT_COLS);
      p.set('limit', '5');
      rows = await fetchBdnb(`${BDNB_BASE}/adresse`, p);
    }

    // Repli commune : filtre PostgREST code_commune_insee=eq.XXXXX
    if (rows.length === 0 && codeInsee) {
      const p = new URLSearchParams();
      p.set('code_commune_insee', `eq.${codeInsee}`);
      p.set('select', SELECT_COLS);
      p.set('limit', '5');
      rows = await fetchBdnb(BDNB_BASE, p);
    }

    if (rows.length === 0) {
      return json({
        status: 'no_data' as BdnbStatus,
        summary: "Aucun bâtiment trouvé dans la BDNB pour cette localisation.",
        stats: null,
        items: [],
      });
    }

    const principal = summarizeBatiment(rows[0]);
    const parts = [
      `Bâtiment BDNB identifié${principal.adresse ? ` : ${principal.adresse}` : ''}.`,
      principal.annee_construction ? `Construit vers ${principal.annee_construction}.` : '',
      principal.usage ? `Usage : ${principal.usage}.` : '',
      principal.materiau_murs ? `Murs : ${principal.materiau_murs}.` : '',
      principal.classe_dpe_representative ? `DPE représentatif : ${principal.classe_dpe_representative}.` : '',
      principal.dans_perimetre_mh ? `⚠️ Dans le périmètre d'un monument historique (${principal.distance_mh_m} m).` : '',
      'Source : BDNB - CSTB.',
    ].filter(Boolean);

    return json({
      status: 'ok' as BdnbStatus,
      summary: parts.join(' '),
      stats: {
        nb_batiments_trouves: rows.length,
        source: 'BDNB - CSTB',
      },
      // Premier = bâtiment principal détaillé ; les autres en aperçu léger.
      items: rows.slice(0, 5).map(summarizeBatiment),
    });
  } catch (e) {
    return json({
      status: 'error' as BdnbStatus,
      summary: `Erreur interrogation BDNB : ${e instanceof Error ? e.message : String(e)}`,
      stats: null,
      items: [],
    }, 200);
  }
});