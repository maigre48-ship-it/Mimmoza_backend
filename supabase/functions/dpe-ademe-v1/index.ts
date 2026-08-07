// supabase/functions/dpe-ademe-v1/index.ts
// =============================================================
// DPE ADEME v1 — Diagnostics de Performance Énergétique
// Source : API Data Fair ADEME (dpe-v2-logements-existants)
//   https://data.ademe.fr/data-fair/api/v1/datasets/dpe-v2-logements-existants/lines
//
// Contrat d'ENTRÉE (body JSON) :
//   { address?, lat?, lon?, code_insee?, code_postal?, radius_m? }
//   → recherche par adresse (q=) en priorité ; repli géo (geo_distance) si lat/lon.
//
// Contrat de SORTIE (aligné sur dvf-comparables-v1 pour cohérence orchestrateur) :
//   { status: 'ok' | 'no_data' | 'no_localization' | 'error',
//     summary: string,
//     stats: { total, distribution_dpe, distribution_ges, plus_recent } | null,
//     items: [...] }
//
// ⚠️ La base DPE ne couvre PAS tout le parc et n'en est pas représentative
//    (source ADEME). On l'annonce dans "summary". On n'invente jamais de classe.
// =============================================================

const ADEME_BASE =
  'https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines';

// Champs réels du dataset (attention aux accents et parenthèses).
const SELECT_FIELDS = [
  'numero_dpe',
  'etiquette_dpe',
  'etiquette_ges',
  'surface_habitable_logement',
  'date_etablissement_dpe',
  'type_batiment',
  'periode_construction',
  'adresse_ban',
  'code_postal_ban',
  'nom_commune_ban',
].join(',');

const ADEME_TIMEOUT_MS = 12000;

// ── Types ────────────────────────────────────────────────────
type DpeStatus = 'ok' | 'no_data' | 'no_localization' | 'error';

interface DpeInput {
  address?: string;
  lat?: number;
  lon?: number;
  code_insee?: string;
  code_postal?: string;
  radius_m?: number;
}

interface DpeRow {
  classe_dpe: string | null;
  classe_ges: string | null;
  surface_m2: number | null;
  date_dpe: string | null;
  type_batiment: string | null;
  annee_construction: string | null;
  adresse: string | null;
  code_postal: string | null;
}

// ── Helpers ──────────────────────────────────────────────────
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

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// Ordre canonique des classes pour tri / "pire classe".
const DPE_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

function normalizeRow(raw: Record<string, unknown>): DpeRow {
  return {
    classe_dpe: str(raw['etiquette_dpe'])?.toUpperCase() ?? null,
    classe_ges: str(raw['etiquette_ges'])?.toUpperCase() ?? null,
    surface_m2: num(raw['surface_habitable_logement']) ?? null,
    date_dpe: str(raw['date_etablissement_dpe']) ?? null,
    type_batiment: str(raw['type_batiment']) ?? null,
    // periode_construction est une tranche ("2001-2005"), pas un nombre → on garde le texte.
    annee_construction: str(raw['periode_construction']) ?? null,
    adresse: str(raw['adresse_ban']) ?? null,
    code_postal: str(raw['code_postal_ban']) ?? null,
  };
}

// Distribution A→G à partir des lignes.
function buildDistribution(rows: DpeRow[], key: 'classe_dpe' | 'classe_ges') {
  const dist: Record<string, number> = {};
  for (const c of DPE_ORDER) dist[c] = 0;
  let known = 0;
  for (const r of rows) {
    const cls = r[key];
    if (cls && DPE_ORDER.includes(cls)) { dist[cls] += 1; known += 1; }
  }
  return known > 0 ? dist : null;
}

// Le DPE le plus récent (date ISO ou JJ/MM/AAAA → on compare en string ISO si possible).
function mostRecent(rows: DpeRow[]): DpeRow | null {
  const dated = rows.filter((r) => r.date_dpe);
  if (dated.length === 0) return rows[0] ?? null;
  return dated.sort((a, b) => (b.date_dpe! > a.date_dpe! ? 1 : -1))[0];
}

async function fetchAdeme(qs: URLSearchParams): Promise<Record<string, unknown>[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ADEME_TIMEOUT_MS);
  try {
    const res = await fetch(`${ADEME_BASE}?${qs.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`ADEME HTTP ${res.status}`);
    }
    const data = await res.json();
    const results = data?.results;
    return Array.isArray(results) ? results : [];
  } finally {
    clearTimeout(timer);
  }
}

// ── Handler ──────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return json({ status: 'error', summary: 'POST only' }, 405);
  }

  let input: DpeInput;
  try {
    input = (await req.json()) as DpeInput;
  } catch {
    return json({ status: 'error', summary: 'Body JSON invalide.' }, 400);
  }

  const address = str(input.address);
  const lat = num(input.lat);
  const lon = num(input.lon);
  const codePostal = str(input.code_postal);
  const radiusM = num(input.radius_m) ?? 150; // rayon serré : le DPE est à l'adresse

  // Aucune localisation exploitable.
  if (!address && (lat == null || lon == null) && !codePostal) {
    return json({
      status: 'no_localization' as DpeStatus,
      summary:
        "Localisation insuffisante pour interroger la base DPE (ni adresse, ni coordonnées, ni code postal).",
      stats: null,
      items: [],
    });
  }

  try {
    const qs = new URLSearchParams();
    qs.set('size', '50');
    qs.set('select', SELECT_FIELDS);

    // Priorité 1 : recherche géographique si coordonnées présentes (plus précis).
    if (lat != null && lon != null) {
      // Data Fair : geo_distance = "lon:lat:distance" (mètres).
      qs.set('geo_distance', `${lon}:${lat}:${radiusM}`);
      if (address) qs.set('q', address); // affine sur l'adresse dans le rayon
    } else if (address) {
      // Priorité 2 : recherche texte libre sur l'adresse.
      qs.set('q', codePostal ? `${address} ${codePostal}` : address);
    } else if (codePostal) {
      // Priorité 3 : filtre code postal seul (agrégat commune, large).
      qs.set('qs', `Code_postal_(BAN):"${codePostal}"`);
    }

    const raw = await fetchAdeme(qs);
    const rows = raw.map(normalizeRow).filter((r) => r.classe_dpe);

    if (rows.length === 0) {
      return json({
        status: 'no_data' as DpeStatus,
        summary:
          "Aucun DPE trouvé à cette localisation dans la base ADEME. La base ne couvre pas l'intégralité du parc : l'absence de DPE ne signifie pas que le bien n'en a pas.",
        stats: null,
        items: [],
      });
    }

    const distDpe = buildDistribution(rows, 'classe_dpe');
    const distGes = buildDistribution(rows, 'classe_ges');
    const recent = mostRecent(rows);

    // Pire classe présente (utile réhab : gisement de passoires).
    const classesPresentes = DPE_ORDER.filter((c) => (distDpe?.[c] ?? 0) > 0);
    const pireClasse = classesPresentes.length
      ? classesPresentes[classesPresentes.length - 1]
      : null;
    const passoires = (distDpe?.['F'] ?? 0) + (distDpe?.['G'] ?? 0);

    const summaryParts = [
      `${rows.length} DPE trouvé(s) à proximité.`,
      recent?.classe_dpe ? `Plus récent : classe ${recent.classe_dpe}${recent.date_dpe ? ` (${recent.date_dpe})` : ''}.` : '',
      passoires > 0 ? `${passoires} passoire(s) énergétique(s) (F/G).` : '',
      "Base ADEME non exhaustive du parc.",
    ].filter(Boolean);

    return json({
      status: 'ok' as DpeStatus,
      summary: summaryParts.join(' '),
      stats: {
        total: rows.length,
        distribution_dpe: distDpe,
        distribution_ges: distGes,
        pire_classe_dpe: pireClasse,
        nb_passoires_fg: passoires,
        plus_recent: recent
          ? {
              classe_dpe: recent.classe_dpe,
              classe_ges: recent.classe_ges,
              surface_m2: recent.surface_m2,
              date_dpe: recent.date_dpe,
              annee_construction: recent.annee_construction,
            }
          : null,
      },
      // Échantillon borné pour le LLM (jamais le brut complet).
      items: rows.slice(0, 15).map((r) => ({
        classe_dpe: r.classe_dpe,
        classe_ges: r.classe_ges,
        surface_m2: r.surface_m2,
        date_dpe: r.date_dpe,
        type_batiment: r.type_batiment,
        adresse: r.adresse,
      })),
    });
  } catch (e) {
    return json({
      status: 'error' as DpeStatus,
      summary: `Erreur interrogation ADEME : ${e instanceof Error ? e.message : String(e)}`,
      stats: null,
      items: [],
    }, 200); // 200 volontaire : l'orchestrateur lit le status métier, pas le HTTP.
  }
});