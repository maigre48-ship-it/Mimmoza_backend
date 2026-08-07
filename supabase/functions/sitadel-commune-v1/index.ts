// supabase/functions/sitadel-commune-v1/index.ts
// =============================================================
// Mimmoza — Source 11 : Sitadel (permis / dynamique de construction)
// Maille COMMUNE (par code INSEE). ODS national public.opendatasoft.com.
// Deux jeux INSEE-filtrables : logements autorisés + surfaces de locaux.
// Le jeu « nombre de permis » brut est écarté (pas de code commune).
// Contrat compact { status, summary, stats }. HTTP 200 même sur no_data/error.
//   status : ok | no_data | no_localization | error
// Secret d'activation côté copilot-chat : COPILOT_FN_SITADEL
// ⚠️ Maille commune uniquement : la localisation fine des projets voisins
//    (parcelle) n'existe pas en open data national — TODO import géocodé.
// =============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ODS_BASE = 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets';
const DS_LOGEMENTS = 'buildingref-france-sitadel-logement-autorise-type-commune-millesime';
const DS_LOCAUX    = 'buildingref-france-sitadel-surface-locaux-commences-type-commune-millesime';
const YEARS_WINDOW = 6;          // nb d'exercices récents restitués
const ODS_TIMEOUT_MS = 8000;

const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
};
const s = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

interface Body { code_insee?: string; commune?: string; zip_code?: string; }

// ─── Résolution INSEE (input → geo.api depuis commune/CP) ─────
async function resolveInsee(b: Body): Promise<{ insee?: string; nom?: string }> {
  const direct = s(b.code_insee);
  if (direct) return { insee: direct };
  const commune = s(b.commune);
  const zip = s(b.zip_code);
  const query = zip
    ? `codePostal=${encodeURIComponent(zip)}`
    : (commune ? `nom=${encodeURIComponent(commune)}` : null);
  if (!query) return {};
  try {
    const r = await fetch(`https://geo.api.gouv.fr/communes?${query}&fields=code,nom&limit=1`,
      { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d) && d[0]?.code) return { insee: String(d[0].code), nom: d[0].nom };
    }
  } catch { /* geo.api injoignable */ }
  return {};
}

// ─── Appel ODS générique (une commune, tri année décroissante) ─
async function odsRows(dataset: string, insee: string): Promise<Record<string, unknown>[]> {
  const url = `${ODS_BASE}/${dataset}/records`
    + `?where=${encodeURIComponent(`com_arm_code="${insee}"`)}`
    + `&order_by=${encodeURIComponent('year DESC')}`
    + `&limit=40`;
  const r = await fetch(url, { signal: AbortSignal.timeout(ODS_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${dataset} → HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.results) ? j.results : [];
}

function computeLogements(rows: Record<string, unknown>[]) {
  const parAnnee = rows.slice(0, YEARS_WINDOW).map((row) => ({
    annee: s(row.year) ?? null,
    total: n(row.total_nombre_de_logements),
    individuel: n(row.nombre_de_logements_autorises_individuels_purs)
              + n(row.nombre_de_logements_autorises_individuels_groupes),
    collectif: n(row.nombre_de_logements_autorises_collectifs),
    residence: n(row.nombre_de_logements_autorises_en_residence),
    surface_m2: n(row.total_surface_en_m2),
  }));
  const total3 = parAnnee.slice(0, 3).reduce((a, x) => a + x.total, 0);
  const collectif3 = parAnnee.slice(0, 3).reduce((a, x) => a + x.collectif, 0);
  return { par_annee: parAnnee, total_3_ans: total3, collectif_3_ans: collectif3 };
}

function computeLocaux(rows: Record<string, unknown>[]) {
  const P = 'surface_autorisee_en_m2_de_locaux_';
  const parAnnee = rows.slice(0, YEARS_WINDOW).map((row) => ({
    annee: s(row.year) ?? null,
    total_m2: n(row.total_surface_en_m2),
    commerce: n(row[`${P}de_commerce`]),
    bureaux: n(row[`${P}de_bureaux`]),
    industriel: n(row[`${P}industriels`]),
    artisanat: n(row[`${P}d_artisanat`]),
    entrepots: n(row[`${P}d_entrepots`]),
    agricole: n(row[`${P}agricoles`]),
    hotelier: n(row[`${P}d_hebergement_hotelier`]),
    service_public: n(row.surface_totale_autorisee_en_m2_de_locaux_de_service_public),
  }));
  const commerce3 = parAnnee.slice(0, 3).reduce((a, x) => a + x.commerce, 0);
  const total3 = parAnnee.slice(0, 3).reduce((a, x) => a + x.total_m2, 0);
  return { par_annee: parAnnee, total_m2_3_ans: total3, commerce_m2_3_ans: commerce3 };
}

async function compute(body: Body) {
  const { insee, nom } = await resolveInsee(body);
  if (!insee) {
    return { status: 'no_localization',
      summary: "Localisation insuffisante (ni code INSEE, ni commune, ni code postal) pour interroger Sitadel." };
  }

  let logRows: Record<string, unknown>[] = [];
  let locRows: Record<string, unknown>[] = [];
  try {
    [logRows, locRows] = await Promise.all([
      odsRows(DS_LOGEMENTS, insee).catch(() => []),
      odsRows(DS_LOCAUX, insee).catch(() => []),
    ]);
  } catch (e) {
    return { status: 'error', summary: `Erreur Sitadel : ${e instanceof Error ? e.message : String(e)}` };
  }

  // Log de trancheage (caveat autorisée/commencée sur le jeu locaux).
  if (locRows[0]) console.log('[sitadel] item brut locaux[0]:', JSON.stringify(locRows[0]));

  if (logRows.length === 0 && locRows.length === 0) {
    return { status: 'no_data',
      summary: `Aucune donnée Sitadel pour la commune ${nom ?? insee} sur la période récente `
        + `(commune peu couverte, ou aucun permis créant logement/local non résidentiel).`,
      stats: { commune_insee: insee, commune_nom: nom ?? null } };
  }

  const logements = logRows.length ? computeLogements(logRows) : null;
  const locaux    = locRows.length ? computeLocaux(locRows) : null;

  const anneeMin = [...logRows, ...locRows].map((r) => s(r.year)).filter(Boolean).sort()[0];
  const anneeMax = [...logRows, ...locRows].map((r) => s(r.year)).filter(Boolean).sort().at(-1);

  const parts: string[] = [`Sitadel — ${nom ?? `commune ${insee}`}`];
  if (logements) parts.push(
    `${logements.total_3_ans} logement(s) autorisé(s) sur les 3 derniers exercices `
    + `(dont ${logements.collectif_3_ans} collectif(s))`);
  if (locaux) parts.push(
    `${locaux.total_m2_3_ans.toLocaleString('fr-FR')} m² de locaux non résidentiels autorisés/3 ans `
    + `(dont ${locaux.commerce_m2_3_ans.toLocaleString('fr-FR')} m² de commerce)`);
  const summary = parts.join(' · ')
    + `${anneeMin ? ` [période ${anneeMin}–${anneeMax}]` : ''}.`;

  return {
    status: 'ok',
    summary,
    stats: {
      commune_insee: insee,
      commune_nom: nom ?? null,
      logements,
      locaux,
      avertissement:
        "Données Sitadel/SDES agrégées à la COMMUNE (permis créant logement ou local non "
        + "résidentiel). La localisation fine des projets voisins d'une parcelle n'est pas "
        + "disponible en open data national. Séries millésimées ; les derniers exercices peuvent "
        + "être incomplets (remontée mensuelle). Paris/Lyon/Marseille : donnée par arrondissement.",
    },
    source: 'Sitadel/SDES via Opendatasoft',
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ status: 'error', summary: 'POST only' }),
      { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  try {
    const body = (await req.json()) as Body;
    const out = await compute(body ?? {});
    return new Response(JSON.stringify(out),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({
      status: 'error',
      summary: `Entrée illisible : ${e instanceof Error ? e.message : String(e)}`,
    }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});