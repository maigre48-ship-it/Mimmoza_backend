// supabase/functions/contexte-commune-v1/index.ts
// =============================================================
// Mimmoza — CONTEXTE DE LA COMMUNE (Wikidata + Wikipédia)
//
// v2 — DENSITÉ. La v1 lisait l'API REST /page/summary, qui ne renvoie que le
// premier paragraphe. Or sur les communes françaises ce paragraphe est un
// gabarit administratif sans valeur (« X est une commune française située
// dans le département de Y »). Toute la matière utile — géographie, économie,
// tourisme, patrimoine — vit dans les SECTIONS de l'article.
// v2 récupère donc le texte intégral (prop=extracts) et en extrait des
// sections CIBLÉES, choisies pour ce qui éclaire une décision immobilière.
//
// ⚠️ NATURE DE LA DONNÉE — cadrage non négociable :
//   Wikipédia est une source ÉDITORIALE COLLABORATIVE, pas une donnée
//   opposable. Elle sert au CONTEXTE, jamais :
//     · à un chiffre réglementaire (zonage, servitude, risque, fiscalité) ;
//     · à une donnée de marché (prix, loyer, population) — l'INSEE, la DGFiP
//       et la DVF font autorité et sont déjà branchées.
//   Le caveat est embarqué dans la réponse pour que le LLM le reprenne.
//
// MÉTHODE (3 appels, tokens-free) :
//   1. Wikidata SPARQL : recherche EXACTE par code INSEE (propriété P374)
//      → aucune ambiguïté d'homonymie.
//   2. API action=query&prop=extracts : texte intégral en clair, découpé
//      par titres de section, dont on retient les rubriques prioritaires.
//   3. API REST /page/summary : intro courte, vignette, URL canonique.
//   Repli : recherche par nom + département si Wikidata échoue, avec
//   `correspondance: 'approximative'`.
//
// Contrat : { status, summary, stats, items } — toujours HTTP 200, aligné
// sur les autres sources (donc AUCUN adaptateur côté etude-parcelle).
// =============================================================

const SPARQL_URL = 'https://query.wikidata.org/sparql';
const WIKI_REST = 'https://fr.wikipedia.org/api/rest_v1/page/summary';
const WIKI_API = 'https://fr.wikipedia.org/w/api.php';
const GEO_API = 'https://geo.api.gouv.fr/communes';

// Wikimedia exige un User-Agent identifiant l'application (sinon 403).
const UA = 'Mimmoza/1.0 (https://mimmoza.fr; contact@mimmoza.fr)';

const CAVEAT =
  "Contexte éditorial issu de Wikipédia (contenu collaboratif, non opposable). " +
  "AUCUN chiffre de ce bloc ne doit être cité (population, emploi, revenus, prix, " +
  "surfaces) : Wikipédia y recopie des données souvent périmées de plus de dix ans, " +
  "et les valeurs à jour viennent de l'INSEE, de la DGFiP et de la DVF, déjà interrogés. " +
  "Ce bloc sert uniquement à décrire le cadre, l'attractivité et le patrimoine.";

// ── Rubriques retenues, par ordre d'intérêt pour une décision immobilière ──
// Chaque rubrique prend la PREMIÈRE section dont le titre correspond.
const RUBRIQUES: Array<{ cle: string; label: string; motifs: RegExp[]; max: number }> = [
  { cle: 'geographie', label: 'Géographie et cadre', max: 500,
    motifs: [/^geographie/, /^situation/, /^relief/, /^hydrographie/, /^localisation/] },
  // ⚠️ Pas de rubrique économie/démographie : Wikipédia y recopie des chiffres
  // INSEE souvent périmés de 10-15 ans (relevé : taux d'activité 2009), alors
  // que le snapshot prédictif porte les valeurs à jour. Doublon = contradiction.
  { cle: 'tourisme', label: 'Tourisme et attractivité', max: 500,
    motifs: [/^tourisme/, /activites touristiques/, /^station/, /^loisirs/] },
  { cle: 'patrimoine', label: 'Patrimoine et monuments', max: 700,
    motifs: [/patrimoine civil/, /patrimoine religieux/, /^lieux et monuments/, /^monuments/,
             /^edifices/, /^eglise/, /^chateau/, /patrimoine/, /^culture locale/] },
  { cle: 'transports', label: 'Accès et transports', max: 350,
    motifs: [/^transport/, /voies de communication/, /^acces/, /^infrastructures/] },
  { cle: 'histoire', label: 'Histoire et toponymie', max: 350,
    motifs: [/^histoire/, /^toponymie/] },
];

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
    headers: { ...cors(), 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function normStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
/** Minuscules sans accents — pour comparer des titres de section. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
/** Tronque sur une frontière de phrase. */
function trim(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut) + ' […]';
}

/** Résout commune / code postal → code INSEE + nom (geo.api, déjà whitelistée). */
async function resolveInsee(p: { insee?: string; commune?: string; zip?: string }): Promise<{ insee?: string; nom?: string; dept?: string }> {
  const query = p.insee ? `code=${encodeURIComponent(p.insee)}`
    : p.zip ? `codePostal=${encodeURIComponent(p.zip)}`
    : p.commune ? `nom=${encodeURIComponent(p.commune)}` : null;
  if (!query) return {};
  try {
    const r = await fetch(`${GEO_API}?${query}&fields=code,nom,departement&limit=1`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return {};
    const d = await r.json();
    const row = Array.isArray(d) ? d[0] : null;
    if (!row?.code) return {};
    return { insee: String(row.code), nom: row.nom ?? undefined, dept: row.departement?.nom ?? undefined };
  } catch { return {}; }
}

/** Wikidata : code INSEE (P374) → identifiant + titre de l'article frwiki. */
async function wikidataByInsee(insee: string): Promise<{ qid?: string; titre?: string }> {
  const sparql = `SELECT ?item ?article WHERE {
    ?item wdt:P374 "${insee}" .
    OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://fr.wikipedia.org/> . }
  } LIMIT 1`;
  try {
    const r = await fetch(`${SPARQL_URL}?format=json&query=${encodeURIComponent(sparql)}`, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { console.error(`[contexte] wikidata HTTP ${r.status}`); return {}; }
    const d = await r.json();
    const b = d?.results?.bindings?.[0];
    if (!b) return {};
    const qid = typeof b.item?.value === 'string' ? b.item.value.split('/').pop() : undefined;
    let titre: string | undefined;
    if (typeof b.article?.value === 'string') {
      const seg = b.article.value.split('/wiki/')[1];
      if (seg) titre = decodeURIComponent(seg);
    }
    return { qid, titre };
  } catch (e) {
    console.error(`[contexte] wikidata échec: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

/** Repli : recherche Wikipédia par nom (+ département pour lever l'homonymie). */
async function wikiSearch(nom: string, dept?: string): Promise<string | undefined> {
  const q = dept ? `${nom} ${dept} commune` : `${nom} commune France`;
  try {
    const r = await fetch(
      `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json&origin=*`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return undefined;
    const d = await r.json();
    return d?.query?.search?.[0]?.title ?? undefined;
  } catch { return undefined; }
}

/** Intro courte + vignette + URL canonique (API REST). */
async function wikiSummary(titre: string): Promise<{ intro?: string; description?: string; url?: string; image?: string; homonymie?: boolean }> {
  try {
    const r = await fetch(`${WIKI_REST}/${encodeURIComponent(titre.replace(/ /g, '_'))}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { console.error(`[contexte] wikipedia summary HTTP ${r.status} pour "${titre}"`); return {}; }
    const d = await r.json();
    if (d?.type === 'disambiguation') return { homonymie: true };
    return {
      intro: typeof d?.extract === 'string' ? d.extract : undefined,
      description: typeof d?.description === 'string' ? d.description : undefined,
      url: d?.content_urls?.desktop?.page ?? undefined,
      image: d?.thumbnail?.source ?? undefined,
    };
  } catch (e) {
    console.error(`[contexte] wikipedia summary échec: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

/** Texte intégral de l'article en clair, titres de section conservés (== … ==). */
async function wikiFullText(titre: string): Promise<string | undefined> {
  const url = `${WIKI_API}?action=query&prop=extracts&explaintext=1&exsectionformat=wiki` +
    `&redirects=1&format=json&origin=*&titles=${encodeURIComponent(titre)}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) { console.error(`[contexte] wikipedia extracts HTTP ${r.status}`); return undefined; }
    const d = await r.json();
    const pages = d?.query?.pages ?? {};
    const first = Object.values(pages)[0] as any;
    const txt = first?.extract;
    return typeof txt === 'string' && txt.length > 0 ? txt : undefined;
  } catch (e) {
    console.error(`[contexte] wikipedia extracts échec: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Découpe le texte en sections { titre, texte } d'après les marqueurs == … ==. */
function decouperSections(texte: string): Array<{ titre: string; texte: string }> {
  const out: Array<{ titre: string; texte: string }> = [];
  const re = /^(={2,4})\s*([^=\n]+?)\s*\1\s*$/gm;
  let m: RegExpExecArray | null;
  let courant: { titre: string; debut: number } | null = null;
  while ((m = re.exec(texte)) !== null) {
    if (courant) out.push({ titre: courant.titre, texte: texte.slice(courant.debut, m.index).trim() });
    courant = { titre: m[2], debut: re.lastIndex };
  }
  if (courant) out.push({ titre: courant.titre, texte: texte.slice(courant.debut).trim() });
  return out;
}

/** Retient, pour chaque rubrique, la première section pertinente et non vide. */
function extraireRubriques(sections: Array<{ titre: string; texte: string }>): Record<string, { titre_section: string; texte: string }> {
  const out: Record<string, { titre_section: string; texte: string }> = {};
  for (const rub of RUBRIQUES) {
    const trouvee = sections.find((s) => {
      const t = fold(s.titre);
      return rub.motifs.some((re) => re.test(t)) && s.texte.replace(/\s+/g, ' ').trim().length > 80;
    });
    if (trouvee) out[rub.cle] = { titre_section: trouvee.titre, texte: trim(trouvee.texte, rub.max) };
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ status: 'error', summary: 'POST only', stats: null, items: [] }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* {} */ }

  let insee = normStr(body.code_insee);
  let commune = normStr(body.commune) ?? normStr(body.city);
  const zip = normStr(body.zip_code) ?? normStr(body.code_postal);
  let dept: string | undefined;

  if (!insee || !commune) {
    const g = await resolveInsee({ insee, commune, zip });
    insee = insee ?? g.insee;
    commune = commune ?? g.nom;
    dept = g.dept;
  }

  if (!insee && !commune) {
    return json({
      status: 'no_localization',
      summary: "Commune requise (code INSEE, nom ou code postal) pour le contexte territorial.",
      stats: null, items: [],
    }, 200);
  }

  // 1) Wikidata par code INSEE : correspondance EXACTE, pas d'homonymie.
  let titre: string | undefined;
  let qid: string | undefined;
  let correspondance: 'exacte' | 'approximative' = 'exacte';
  if (insee) {
    const w = await wikidataByInsee(insee);
    titre = w.titre; qid = w.qid;
  }
  if (!titre && commune) {
    titre = await wikiSearch(commune, dept);
    if (titre) correspondance = 'approximative';
  }

  if (!titre) {
    return json({
      status: 'no_data',
      summary: `Aucun article Wikipédia identifié pour ${commune ?? `la commune ${insee}`}.`,
      stats: { code_insee: insee ?? null, commune: commune ?? null, caveat: CAVEAT },
      items: [],
    }, 200);
  }

  // 2 & 3) Intro/vignette et texte intégral, en parallèle.
  const [resume, texte] = await Promise.all([wikiSummary(titre), wikiFullText(titre)]);

  if (resume.homonymie) {
    return json({
      status: 'no_data',
      summary: `L'article « ${titre} » est une page d'homonymie : contexte territorial non exploitable.`,
      stats: { code_insee: insee ?? null, commune: commune ?? null, article: titre, correspondance, caveat: CAVEAT },
      items: [],
    }, 200);
  }

  const sections = texte ? decouperSections(texte) : [];
  const rubriques = extraireRubriques(sections);
  const nbRubriques = Object.keys(rubriques).length;

  if (!resume.intro && nbRubriques === 0) {
    return json({
      status: 'no_data',
      summary: `Article Wikipédia « ${titre} » trouvé mais sans contenu exploitable.`,
      stats: { code_insee: insee ?? null, commune: commune ?? null, article: titre, url: resume.url ?? null, correspondance, caveat: CAVEAT },
      items: [],
    }, 200);
  }

  // Résumé : on privilégie la matière (géographie, économie, patrimoine) à la
  // phrase de définition administrative, qui n'apprend rien.
  const morceaux = [
    rubriques.geographie?.texte,
    rubriques.economie?.texte,
    rubriques.patrimoine?.texte,
  ].filter(Boolean) as string[];
  const corps = morceaux.length ? morceaux.join(' ') : (resume.intro ?? '');

  return json({
    status: 'ok',
    summary: `Contexte territorial — ${commune ?? titre} : ${trim(corps, 900)}`,
    stats: {
      code_insee: insee ?? null,
      commune: commune ?? null,
      article: titre,
      description: resume.description ?? null,
      intro: resume.intro ?? null,
      rubriques,                       // géographie / tourisme / patrimoine / …
      nb_rubriques: nbRubriques,
      // Diagnostic : titres réellement présents dans l'article, pour ajuster
      // les motifs si une rubrique attendue ressort vide.
      sections_detectees: sections.map((s) => s.titre).slice(0, 40),
      url: resume.url ?? null,
      image: resume.image ?? null,
      wikidata_id: qid ?? null,
      correspondance,                  // 'approximative' = résolu par nom, à vérifier
      nature: 'contexte éditorial',
      caveat: CAVEAT,
      source: 'Wikipédia (FR) via Wikimedia API + Wikidata',
    },
    items: [],
  }, 200);
});