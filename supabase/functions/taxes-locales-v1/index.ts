// supabase/functions/taxes-locales-v1/index.ts
// =============================================================
// Mimmoza — Taxes locales (source #5)
//
// Rôle : renvoyer les taux de fiscalité directe locale VOTÉS d'une commune :
//   - taxe foncière sur les propriétés bâties (TFB)      ← la plus utile en immo
//   - taxe foncière sur les propriétés non bâties (TFNB)
//   - taxe d'habitation (TH)  — ⚠️ résidences secondaires (THRS) + logements
//       vacants (THLV) uniquement : la TH sur résidence principale est SUPPRIMÉE
//       depuis 2023.
//   - majoration THRS (5–60 %) le cas échéant (communes en zone tendue)
//   - taxe d'enlèvement des ordures ménagères (TEOM)
//
// Source : DGFiP « Fiscalité locale des particuliers » via l'API Opendatasoft
//   de data.economie.gouv.fr (taux issus du REI). Interrogée par code INSEE.
//   → Pas d'import de table : officiel, toujours à jour.
//
// Robustesse : le schéma ODS exact n'étant pas figé, la fonction SONDE le
//   dataset (1 enregistrement) pour DÉTECTER les noms de champs par motif, puis
//   cache ce mapping. Elle logue le mapping détecté (débogage). Un repli renvoie
//   aussi tous les champs « taux » bruts si une détection fine échoue.
//
// Autonome (Dashboard, aucun import _shared, aucune clé requise).
//
// Contrat de sortie (aligné dpe/loyers/servitudes/solaire/zonage) :
//   { status, summary, stats, items }  — toujours HTTP 200
// =============================================================

// Dataset ODS (surchargeable si l'id évolue).
const DATASET = Deno.env.get('TAXES_ODS_DATASET') ?? 'fiscalite-locale-des-particuliers';
const ODS_RECORDS = `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/${DATASET}/records`;
const FETCH_TIMEOUT_MS = 8000;

const NOTE_TH =
  "La taxe d'habitation sur la résidence principale est supprimée depuis 2023 : ce taux TH ne s'applique qu'aux résidences secondaires (THRS) et aux logements vacants (THLV).";
const NOTE_MAJORATION =
  "Majoration THRS (5–60 %) possible dans les communes en zone tendue ; elle porte sur la seule part communale de la cotisation.";
const SOURCE = 'DGFiP — Fiscalité locale des particuliers (data.economie.gouv.fr, taux votés issus du REI)';

// PLM : repli sur un arrondissement si le code « commune globale » est absent.
const PLM_FALLBACK: Record<string, string> = {
  '75056': '75101', '69123': '69381', '13055': '13201',
};

interface FieldMap {
  insee?: string; commune?: string; annee?: string;
  tfb?: string; tfnb?: string; th?: string; teom?: string; majoration?: string;
  tauxKeys: string[];
}
let _fieldMap: FieldMap | null = null;

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
function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function resolveInseeFromGeo(p: { commune?: string; zipCode?: string }): Promise<string | undefined> {
  const query = p.zipCode
    ? `codePostal=${encodeURIComponent(p.zipCode)}`
    : (p.commune ? `nom=${encodeURIComponent(p.commune)}` : null);
  if (!query) return undefined;
  try {
    const r = await fetch(`https://geo.api.gouv.fr/communes?${query}&fields=code&limit=1`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return undefined;
    const d = await r.json();
    if (Array.isArray(d) && d[0]?.code) return String(d[0].code);
  } catch { /* injoignable */ }
  return undefined;
}

// ── Détection des champs ODS par motif (insensible à la casse) ──
function detectFields(rec: Record<string, any>): FieldMap {
  const keys = Object.keys(rec);
  const find = (re: RegExp, exclude?: RegExp) =>
    keys.find((k) => re.test(k) && !(exclude && exclude.test(k)));
  return {
    insee: find(/insee|codgeo|depcom|code_?comm/i),
    commune: find(/libgeo|lib_?com|libelle|commune|nom_?com/i, /epci|interco|dep|region/i),
    annee: find(/annee|exercice|millesime/i),
    tfb: find(/tf(p)?b|fonc.*bat|taux.*fb/i, /non|tfnb/i),
    tfnb: find(/tfnb|non.?bat/i),
    th: find(/habitation|(^|_)th($|_|glob)/i, /major|thlv|thrs/i) ?? find(/(^|_)th|habitation/i, /major/i),
    teom: find(/teom|ordure/i),
    majoration: find(/major|surtax|thrs.*tau|sup.*rs/i),
    tauxKeys: keys.filter((k) => /taux|(^|_)tf|(^|_)th|teom|major/i.test(k)),
  };
}

async function getFieldMap(): Promise<FieldMap> {
  if (_fieldMap) return _fieldMap;
  const j = await fetchJson(`${ODS_RECORDS}?limit=1`);
  const rec = Array.isArray(j?.results) ? j.results[0] : null;
  _fieldMap = rec ? detectFields(rec) : { tauxKeys: [] };
  console.log('[taxes-locales] champs détectés:', JSON.stringify(_fieldMap));
  return _fieldMap;
}

const INSEE_CANDIDATES = ['code_insee', 'insee', 'codgeo', 'insee_com', 'com_code', 'code_commune'];

async function fetchByInsee(insee: string, fm: FieldMap): Promise<Record<string, any> | null> {
  const orderBy = fm.annee ? `&order_by=${encodeURIComponent(fm.annee + ' desc')}` : '';
  const tryField = async (field: string) => {
    const where = encodeURIComponent(`${field}="${insee}"`);
    const j = await fetchJson(`${ODS_RECORDS}?where=${where}${orderBy}&limit=1`);
    return Array.isArray(j?.results) && j.results[0] ? j.results[0] : null;
  };
  // Champ détecté d'abord, puis repli sur une courte liste de candidats.
  if (fm.insee) { const r = await tryField(fm.insee); if (r) return r; }
  for (const c of INSEE_CANDIDATES) {
    if (c === fm.insee) continue;
    const r = await tryField(c);
    if (r) { if (!fm.insee) fm.insee = c; return r; }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ status: 'error', summary: 'POST only', stats: null, items: [] }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* {} */ }

  let codeInsee = normStr(body.code_insee);
  const commune = normStr(body.commune) ?? normStr(body.city);
  const zipCode = normStr(body.zip_code) ?? normStr(body.code_postal);

  if (!codeInsee && (commune || zipCode)) {
    codeInsee = await resolveInseeFromGeo({ commune, zipCode });
  }
  if (!codeInsee) {
    return json({
      status: 'no_localization',
      summary: "Localisation insuffisante : fournir un code INSEE, une commune ou un code postal.",
      stats: null, items: [],
    }, 200);
  }

  try {
    const fm = await getFieldMap();
    let rec = await fetchByInsee(codeInsee, fm);
    if (!rec && PLM_FALLBACK[codeInsee]) rec = await fetchByInsee(PLM_FALLBACK[codeInsee], fm);

    if (!rec) {
      return json({
        status: 'no_data',
        summary: `Aucun taux de fiscalité locale trouvé pour le code INSEE ${codeInsee}.`,
        stats: null, items: [],
      }, 200);
    }

    const get = (field?: string) => (field ? num(rec![field]) : null);
    const tfb = get(fm.tfb);
    const tfnb = get(fm.tfnb);
    const th = get(fm.th);
    const teom = get(fm.teom);
    const majoration = get(fm.majoration);
    const communeNom = fm.commune ? (rec[fm.commune] ?? null) : null;
    const annee = fm.annee ? (rec[fm.annee] ?? null) : null;

    // Repli : tous les champs « taux » bruts, si une détection fine a manqué.
    const tauxBruts: Record<string, unknown> = {};
    for (const k of fm.tauxKeys) tauxBruts[k] = rec[k];

    const parts = [
      tfb != null ? `taxe foncière bâtie ${tfb} %` : null,
      tfnb != null ? `TFNB ${tfnb} %` : null,
      th != null ? `TH (rés. secondaires/vacants) ${th} %` : null,
      majoration != null && majoration > 0 ? `majoration THRS ${majoration} %` : null,
      teom != null ? `TEOM ${teom} %` : null,
    ].filter(Boolean);

    return json({
      status: 'ok',
      summary:
        `Taxes locales ${communeNom ?? `INSEE ${codeInsee}`}${annee ? ` (${annee})` : ''} : ` +
        `${parts.length ? parts.join(', ') : 'taux non détaillés'}.`,
      stats: {
        code_insee: codeInsee,
        commune_nom: communeNom,
        annee,
        taxe_fonciere_batie_pct: tfb,
        taxe_fonciere_non_batie_pct: tfnb,
        taxe_habitation_pct: th,
        majoration_thrs_pct: majoration,
        teom_pct: teom,
        note_th: NOTE_TH,
        note_majoration: NOTE_MAJORATION,
        ...(parts.length === 0 ? { taux_bruts: tauxBruts } : {}),
        source: SOURCE,
      },
      items: [rec],
    }, 200);
  } catch (e) {
    return json({
      status: 'error',
      summary: `Erreur interrogation fiscalité locale : ${e instanceof Error ? e.message : String(e)}`,
      stats: null, items: [],
    }, 200);
  }
});