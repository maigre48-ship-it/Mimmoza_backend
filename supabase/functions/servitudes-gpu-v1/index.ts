// supabase/functions/servitudes-gpu-v1/index.ts
// =============================================================
// Mimmoza — Servitudes d'Utilité Publique (SUP) — Géoportail de l'Urbanisme
// Source de données #2 branchée dans MimmozIA.
//
// Rôle : lister les SUP qui grèvent une parcelle (monuments historiques,
//   PPRn/PPRt, captages, canalisations gaz/électricité, télécom, alignement…),
//   à partir de leur emprise géographique (assiette).
//
// Choix d'architecture (le plus solide/efficace) :
//   - on interroge l'API Carto de l'IGN (apicarto.ign.fr/api/gpu), REST stable
//     et publique, qui expose les données GPU par géométrie en GeoJSON —
//     plutôt que le WFS brut du GPU (endpoint à token, WFS 2.0/GML) ;
//   - on récupère d'abord le POLYGONE de la parcelle (module cadastre) pour
//     intersecter l'emprise réelle, avec repli sur le point (lat/lon) ;
//   - on interroge les 3 couches d'ASSIETTE SUP (surfacique / linéaire /
//     ponctuelle) : l'assiette est la zone qui affecte juridiquement la parcelle.
//
// ⚠️ NON-EXHAUSTIVITÉ : toutes les SUP ne sont pas encore publiées sur le GPU.
//    Une absence de résultat NE prouve PAS l'absence de servitude. La réponse
//    porte cet avertissement ; le LLM ne doit jamais conclure « aucune servitude »
//    de façon absolue.
//
// Autonome (éditée dans le Dashboard, aucun import _shared, aucune clé requise).
//
// Contrat de sortie (aligné dpe/merimee/bdnb/loyers) :
//   { status, summary, stats, items }
//   status ∈ 'ok' | 'no_data' | 'no_localization' | 'error'  (toujours HTTP 200)
// =============================================================

const APICARTO_BASE = 'https://apicarto.ign.fr/api';
const ASSIETTE_LAYERS = ['assiette-sup-s', 'assiette-sup-l', 'assiette-sup-p'] as const;
const FETCH_TIMEOUT_MS = 8000;
const MAX_ITEMS = 40;
const MAX_GEOM_URL_CHARS = 1800; // au-delà → repli point (évite un 414 URI Too Long)

// Libellés de secours pour les catégories CNIG SUP les plus courantes.
// ⚠️ Supplémentaire uniquement : la source fournit déjà `nomsuplitt` (libellé
//    autoritatif) que l'on privilégie toujours ; cette table ne sert qu'à
//    étoffer un code nu.
const SUP_CATEGORIES: Record<string, string> = {
  AC1: 'Monuments historiques (abords)',
  AC2: 'Sites classés ou inscrits',
  AC4: 'Sites patrimoniaux remarquables (SPR / ZPPAUP / AVAP)',
  AS1: 'Protection des eaux potables (captage)',
  A1: 'Forêts de protection',
  EL7: 'Alignement des voies',
  I1: "Canalisations d'hydrocarbures",
  I3: 'Canalisations de gaz',
  I4: 'Lignes électriques',
  INT1: 'Voisinage des cimetières',
  PM1: 'Plan de prévention des risques naturels (PPRn)',
  PM2: 'Risques technologiques / installations classées (PPRt)',
  PM3: 'Plan de prévention des risques miniers',
  PT2: 'Télécommunications — protection contre les obstacles',
  PT3: 'Réseaux de télécommunications',
  T1: 'Voies ferrées',
  T4: 'Balisage aéronautique',
  T5: 'Dégagement aéronautique',
};

// =============================================================
// Helpers HTTP
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
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
function normStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null; // timeout / réseau → null, géré par l'appelant
  }
}

/** Lecture insensible à la casse d'une propriété (CNIG mélange MAJ/min selon les lots). */
function prop(props: Record<string, any> | undefined, names: string[]): any {
  if (!props) return undefined;
  const lowerMap: Record<string, any> = {};
  for (const [k, v] of Object.entries(props)) lowerMap[k.toLowerCase()] = v;
  for (const n of names) {
    const v = lowerMap[n.toLowerCase()];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// =============================================================
// Géométrie : polygone parcelle (cadastre) avec repli point
// =============================================================

/** Récupère le polygone de la parcelle contenant le point via le module cadastre. */
async function fetchParcelGeometry(lon: number, lat: number): Promise<any | null> {
  const point = { type: 'Point', coordinates: [lon, lat] };
  const url = `${APICARTO_BASE}/cadastre/parcelle?geom=${encodeURIComponent(JSON.stringify(point))}`;
  const fc = await fetchJson(url);
  const feat = Array.isArray(fc?.features) ? fc.features[0] : null;
  const geom = feat?.geometry;
  if (geom && (geom.type === 'Polygon' || geom.type === 'MultiPolygon')) return geom;
  return null;
}

// =============================================================
// Interrogation d'une couche GPU par géométrie
// =============================================================

async function queryGpuLayer(layer: string, geom: any): Promise<any[]> {
  const encoded = encodeURIComponent(JSON.stringify(geom));
  const url = `${APICARTO_BASE}/gpu/${layer}?geom=${encoded}&_limit=${MAX_ITEMS}`;
  if (url.length > MAX_GEOM_URL_CHARS + 200) return []; // garde-fou taille (géré en amont)
  const fc = await fetchJson(url);
  return Array.isArray(fc?.features) ? fc.features : [];
}

// =============================================================
// Handler
// =============================================================

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ status: 'error', summary: 'POST only', stats: null, items: [] }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* {} */ }

  const lat = num(body.lat);
  const lon = num(body.lon) ?? num((body as any).lng);

  // SUP = donnée parcellaire : sans coordonnées précises, on NE devine PAS
  // (un centroïde de commune donnerait des servitudes hors sujet).
  if (lat == null || lon == null) {
    return json({
      status: 'no_localization',
      summary: "Coordonnées précises requises (lat/lon) pour interroger les servitudes d'utilité publique. Le centroïde d'une commune ne convient pas.",
      stats: null,
      items: [],
    }, 200);
  }

  try {
    // 1) Géométrie d'interrogation : polygone parcelle (solide), repli point.
    let geom: any = await fetchParcelGeometry(lon, lat);
    let geomKind: 'parcelle' | 'point' = 'parcelle';
    if (!geom || encodeURIComponent(JSON.stringify(geom)).length > MAX_GEOM_URL_CHARS) {
      geom = { type: 'Point', coordinates: [lon, lat] };
      geomKind = 'point';
    }

    // 2) Interrogation parallèle des 3 assiettes SUP.
    const settled = await Promise.allSettled(ASSIETTE_LAYERS.map((l) => queryGpuLayer(l, geom)));
    const allFailed = settled.every((s) => s.status === 'rejected');
    if (allFailed) {
      return json({
        status: 'error',
        summary: "L'API Carto (GPU) est momentanément injoignable pour les servitudes. Réessaie plus tard.",
        stats: null,
        items: [],
      }, 200);
    }

    const features = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));

    // 3) Normalisation + dédoublonnage par identifiant d'assiette.
    const seen = new Set<string>();
    const items: Record<string, unknown>[] = [];
    for (const f of features) {
      const p = f?.properties ?? {};
      const idass = prop(p, ['idass', 'id_ass']);
      const key = String(idass ?? `${prop(p, ['idgen'])}-${prop(p, ['nomsuplitt'])}-${items.length}`);
      if (seen.has(key)) continue;
      seen.add(key);

      const categorie = prop(p, ['categorie', 'cat', 'categori']);
      const nom = prop(p, ['nomsuplitt', 'libelle', 'nomass']);
      items.push({
        categorie: categorie ?? null,
        categorie_label: categorie && SUP_CATEGORIES[String(categorie)] ? SUP_CATEGORIES[String(categorie)] : null,
        nom: nom ?? null,
        type_assiette: prop(p, ['typeass', 'type']) ?? null,
        idass: idass ?? null,
        idgen: prop(p, ['idgen']) ?? null,
        partition: prop(p, ['partition']) ?? null,
        date_maj: prop(p, ['datemaj', 'date_maj']) ?? null,
      });
      if (items.length >= MAX_ITEMS) break;
    }

    const avertissement =
      "Le Géoportail de l'Urbanisme n'est pas exhaustif : une absence de résultat ne garantit pas l'absence de servitude sur la parcelle.";
    const source = "Géoportail de l'Urbanisme (SUP) via API Carto IGN";

    if (items.length === 0) {
      return json({
        status: 'no_data',
        summary:
          `Aucune servitude d'utilité publique publiée sur l'emprise interrogée (${geomKind}). ⚠️ ${avertissement}`,
        stats: { nb_servitudes: 0, geometrie_utilisee: geomKind, avertissement, source },
        items: [],
      }, 200);
    }

    // 4) Agrégat par catégorie pour un résumé lisible.
    const byCat = new Map<string, number>();
    for (const it of items) {
      const label = (it.categorie_label as string) ?? (it.categorie as string) ?? (it.nom as string) ?? 'SUP';
      byCat.set(label, (byCat.get(label) ?? 0) + 1);
    }
    const categories = [...byCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count }));

    const topLabels = categories.slice(0, 4).map((c) => c.label).join(', ');
    return json({
      status: 'ok',
      summary:
        `${items.length} servitude(s) d'utilité publique sur l'emprise (${geomKind}) : ${topLabels}` +
        `${categories.length > 4 ? '…' : ''}. ⚠️ ${avertissement}`,
      stats: {
        nb_servitudes: items.length,
        geometrie_utilisee: geomKind,
        categories,
        avertissement,
        source,
      },
      items: items.slice(0, MAX_ITEMS),
    }, 200);
  } catch (e) {
    return json({
      status: 'error',
      summary: `Erreur interrogation servitudes GPU : ${e instanceof Error ? e.message : String(e)}`,
      stats: null,
      items: [],
    }, 200);
  }
});