// supabase/functions/appels-offres-v1/index.ts
// =============================================================
// Appels d'offres v1 — avis de marchés publics ouverts (BOAMP)
// Source : API Opendatasoft du BOAMP — https://www.boamp.fr/api/explore/v2.1
//   dataset : boamp (~1,69 M d'avis)
//
// ⚠️ L'hôte api.boamp.fr NE RÉSOUT PAS (DNS). Le point d'entrée valide est
//    www.boamp.fr/api/explore/v2.1 — vérifié en production le 04/08/2026.
//
// ENTRÉE (body JSON) :
//   {
//     departements?: string[] | string,   // ex ["64","40"] ou "64"
//     categories?:   ('foncier'|'travaux'|'moe')[],  // défaut : les trois
//     texte?:        string,              // recherche libre dans l'objet
//     limite?:       number,              // 1..50, défaut 15
//     jours_min?:    number,              // délai minimal restant, défaut 0
//   }
//
// SORTIE : { status, summary, stats, items }
//   status : 'ok' | 'no_data' | 'error'
//
// ⚠️ code_departement = zone de DIFFUSION de l'annonce, PAS le lieu des travaux.
//    code_departement_prestation désigne le lieu réel mais est presque toujours
//    nul. On filtre sur le premier (dix fois mieux rempli) et on expose les deux,
//    avec un drapeau zone_execution_incertaine quand le doute existe.
// =============================================================

const BOAMP_BASE =
  'https://www.boamp.fr/api/explore/v2.1/catalog/datasets/boamp/records';

const BOAMP_TIMEOUT_MS = 12000;

type AoStatus = 'ok' | 'no_data' | 'error';
type Categorie = 'foncier' | 'travaux' | 'moe';

const CATEGORIES: Categorie[] = ['foncier', 'travaux', 'moe'];

// Mots-clés recherchés dans l'objet de l'avis. `search()` est insensible à la
// casse et aux accents (vérifié : "œuvre" et "oeuvre" renvoient le même total).
const MOTS_CLES: Record<Categorie, string[]> = {
  // Le gisement foncier d'un promoteur : ces avis ne portent pas de type_marche
  // exploitable, ils ne se repèrent qu'au texte.
  foncier: [
    'cession', 'vente de terrain', 'manifestation d\'intérêt',
    'concession d\'aménagement', 'consultation promoteurs', 'appel à projets',
    'bail emphytéotique', 'valorisation foncière', 'désaffectation',
  ],
  // Couvert par type_marche, pas par mots-clés (cf. buildWhere).
  travaux: [],
  moe: [
    'maîtrise d\'oeuvre', 'assistance à maîtrise d\'ouvrage',
    'étude de faisabilité', 'programmiste',
  ],
};

interface AoInput {
  departements?: string[] | string;
  categories?: string[];
  texte?: string;
  limite?: number;
  jours_min?: number;
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

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

// Neutralise les guillemets : une valeur utilisateur ne doit jamais pouvoir
// refermer une chaîne ODSQL et injecter sa propre clause.
function litt(s: string): string {
  return `"${s.replace(/["\\]/g, ' ').trim()}"`;
}

function normDeps(v: unknown): string[] {
  const brut = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\s]+/) : [];
  const out: string[] = [];
  for (const d of brut) {
    // 2 chiffres, ou Corse (2A/2B), ou DOM sur 3 chiffres.
    const m = /^(2[AB]|\d{2,3})$/i.exec(String(d).trim().toUpperCase());
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out.slice(0, 12);
}

function normCats(v: unknown): Categorie[] {
  if (!Array.isArray(v) || v.length === 0) return [...CATEGORIES];
  const out = v
    .map((c) => String(c).toLowerCase().trim())
    .filter((c): c is Categorie => (CATEGORIES as string[]).includes(c));
  return out.length ? [...new Set(out)] : [...CATEGORIES];
}

function buildWhere(deps: string[], cats: Categorie[], texte?: string, joursMin = 0): string {
  const parts: string[] = [];

  // 1) Uniquement les avis encore ouverts à la candidature.
  parts.push(
    joursMin > 0
      ? `datelimitereponse > now(days=${Math.trunc(joursMin)})`
      : 'datelimitereponse > now()',
  );

  // 2) Géographie — code_departement (diffusion), seul champ correctement rempli.
  if (deps.length) {
    parts.push('(' + deps.map((d) => `code_departement like ${litt(d)}`).join(' or ') + ')');
  }

  // 3) Catégories : travaux via type_marche, les deux autres au texte.
  const ors: string[] = [];
  for (const c of cats) {
    if (c === 'travaux') ors.push('type_marche like "TRAVAUX"');
    else for (const kw of MOTS_CLES[c]) ors.push(`search(objet, ${litt(kw)})`);
  }
  if (ors.length) parts.push('(' + ors.join(' or ') + ')');

  // 4) Recherche libre de l'utilisateur, en plus des catégories.
  const t = (texte ?? '').trim();
  if (t) parts.push(`search(objet, ${litt(t)})`);

  return parts.join(' and ');
}

const CHAMPS = [
  'idweb', 'objet', 'nomacheteur', 'type_marche', 'nature_libelle',
  'procedure_libelle', 'famille_libelle', 'datelimitereponse', 'dateparution',
  'code_departement', 'code_departement_prestation', 'etat', 'url_avis',
].join(',');

async function fetchBoamp(where: string, limite: number): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams();
  qs.set('limit', String(limite));
  qs.set('order_by', 'datelimitereponse');
  qs.set('select', CHAMPS);
  qs.set('where', where);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BOAMP_TIMEOUT_MS);
  try {
    const res = await fetch(`${BOAMP_BASE}?${qs.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`BOAMP HTTP ${res.status}`);

    // Une plateforme qui déménage répond 200 avec du HTML : URL morte, pas panne.
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('json')) {
      throw new Error(
        `BOAMP a renvoyé "${ctype || 'type inconnu'}" au lieu de JSON — ` +
          `l'endpoint a probablement changé d'adresse (BOAMP_BASE à mettre à jour).`,
      );
    }

    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  } finally {
    clearTimeout(timer);
  }
}

function joursRestants(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((t - Date.now()) / 86400000));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return json({ status: 'error', summary: 'POST only' }, 405);
  }

  let input: AoInput;
  try {
    input = (await req.json()) as AoInput;
  } catch {
    return json({ status: 'error', summary: 'Body JSON invalide.' }, 400);
  }

  const deps = normDeps(input.departements);
  const cats = normCats(input.categories);
  const limite = Math.min(50, Math.max(1, num(input.limite) ?? 15));
  const joursMin = Math.max(0, num(input.jours_min) ?? 0);
  const texte = typeof input.texte === 'string' ? input.texte : undefined;

  const where = buildWhere(deps, cats, texte, joursMin);

  try {
    const rows = await fetchBoamp(where, limite);

    const items = rows.map((r) => {
      const limite_iso = (r['datelimitereponse'] as string | null) ?? null;
      const tm = r['type_marche'];
      const dRaw = r['code_departement'];
      const diff: string[] = Array.isArray(dRaw) ? dRaw.map(String) : dRaw ? [String(dRaw)] : [];
      const pRaw = r['code_departement_prestation'];
      const prest: string[] | null = Array.isArray(pRaw) ? pRaw.map(String) : pRaw ? [String(pRaw)] : null;
      return {
        id: r['idweb'] ?? null,
        objet: r['objet'] ?? null,
        acheteur: r['nomacheteur'] ?? null,
        type_marche: Array.isArray(tm) ? tm.join(', ') : (tm ?? null),
        nature: r['nature_libelle'] ?? null,
        procedure: r['procedure_libelle'] ?? null,
        famille: r['famille_libelle'] ?? null,
        // ⚠️ code_departement = zone de DIFFUSION de l'annonce, pas lieu des travaux.
        //    Un acheteur girondin qui publie sur toute la Nouvelle-Aquitaine fait
        //    remonter son avis sur le 40. Le lieu réel est code_departement_prestation,
        //    presque toujours nul — on expose donc les deux et on signale le doute.
        departements_diffusion: diff,
        departements_execution: prest,
        zone_execution_incertaine: prest == null && diff.length > 2,
        date_parution: r['dateparution'] ?? null,
        date_limite_reponse: limite_iso,
        jours_restants: joursRestants(limite_iso),
        etat: r['etat'] ?? null,
        url: r['url_avis'] ?? null,
        // Lien markdown PRÊT À COPIER. Un modèle qui recompose une URL au milieu
        // d'un tableau de 25 lignes finit par recopier celle de la ligne d'à côté
        // (constaté en production). Lui donner la chaîne complète supprime l'étape
        // où l'erreur se produit.
        lien_markdown: r['url_avis'] ? `[Avis ${r['idweb'] ?? ''}](${r['url_avis']})` : null,
      };
    });

    const urgents = items.filter((i) => i.jours_restants != null && i.jours_restants <= 15).length;
    const flous = items.filter((i) => i.zone_execution_incertaine).length;

    if (items.length === 0) {
      return json({
        status: 'no_data' as AoStatus,
        summary:
          "Aucun avis ouvert ne correspond à ces critères au BOAMP. " +
          "⚠️ Ce n'est PAS une preuve d'absence d'opportunité : le champ géographique du BOAMP est " +
          "lacunaire, et les cessions foncières ne sont pas toutes publiées ici (certaines passent " +
          "par les sites des collectivités ou des EPF). Élargis la zone ou retire un filtre.",
        stats: { total: 0, urgents: 0, zone_incertaine: 0, departements: deps, categories: cats },
        items: [],
        where,
      });
    }

    return json({
      status: 'ok' as AoStatus,
      summary:
        `${items.length} avis ouvert(s) correspondant aux critères` +
        (deps.length ? ` (départements ${deps.join(', ')})` : ' (France entière)') +
        `, triés par date limite la plus proche.` +
        (urgents ? ` ⚠️ ${urgents} avis à moins de 15 jours de la clôture.` : '') +
        (flous
          ? ` ⚠️ ${flous} avis ont une ZONE D'EXÉCUTION INCERTAINE : ils ont été diffusés sur plusieurs `
            + `départements sans préciser le lieu des travaux (zone_execution_incertaine=true). Le filtre `
            + `géographique porte sur la DIFFUSION de l'annonce, pas sur le lieu du chantier — signale-le `
            + `pour ceux-là et invite à ouvrir l'avis avant de s'engager.`
          : '') +
        " Le BOAMP ne recense pas toutes les cessions foncières : une absence n'est pas une preuve.",
      stats: {
        total: items.length,
        urgents,
        zone_incertaine: flous,
        departements: deps,
        categories: cats,
        plus_proche_echeance: items[0]?.date_limite_reponse ?? null,
      },
      items,
      where,
    });
  } catch (e) {
    return json({
      status: 'error' as AoStatus,
      summary: `Erreur interrogation BOAMP : ${e instanceof Error ? e.message : String(e)}`,
      stats: null,
      items: [],
      where,
    }, 200);
  }
});
