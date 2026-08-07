// supabase/functions/patrimoine-merimee-v1/index.ts
// =============================================================
// Patrimoine Mérimée v1 — Monuments Historiques (abords 500 m)
// Source : API Opendatasoft — data hub public
//   dataset : liste-des-immeubles-proteges-au-titre-des-monuments-historiques@culture
//
// ⚠️ 2026-08 : l'ancien hôte data.culture.gouv.fr a migré vers
//    culture.data.gouv.fr et n'expose plus l'API Opendatasoft. Il répond
//    200 OK avec du HTML — ce qui faisait échouer le parsing et remonter un
//    faux « service indisponible ». On pointe désormais le data hub ODS, qui
//    sert le même jeu (46 714 notices) sous le suffixe @culture.
//
// ENTRÉE (body JSON) : { lat, lon, radius_m?, code_insee? }
//   → recherche géographique par rayon (within_distance).
//   → repli code_insee (commune entière) si pas de coordonnées.
//
// SORTIE : { status, summary, stats, items }
//   status : 'ok' | 'no_data' | 'no_localization' | 'error'
//
// ⚠️ Un monument CLASSÉ ou INSCRIT génère un périmètre de protection de 500 m
//    (abords). Tout projet dans ce périmètre passe en avis ABF. On le signale.
//    On n'invente jamais : si aucun MH dans le rayon, on le dit clairement.
// =============================================================

const ODS_BASE =
  'https://data.opendatasoft.com/api/explore/v2.1/catalog/datasets/' +
  'liste-des-immeubles-proteges-au-titre-des-monuments-historiques@culture/records';

const ODS_TIMEOUT_MS = 12000;

// Périmètre réglementaire des abords MH.
const PERIMETRE_ABF_M = 500;

type MerimeeStatus = 'ok' | 'no_data' | 'no_localization' | 'error';

interface MerimeeInput {
  lat?: number;
  lon?: number;
  radius_m?: number;
  code_insee?: string;
}

interface MonumentRow {
  nom: string | null;
  denomination: string | null;
  protection: string | null;
  date_protection: string | null;
  adresse: string | null;
  commune: string | null;
  siecle: string | null;
  lat: number | null;
  lon: number | null;
  distance_m: number | null;
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// Distance haversine en mètres (l'API ne renvoie pas la distance si on trie
// par geofilter — on la recalcule pour l'afficher).
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function normalizeRow(
  raw: Record<string, unknown>,
  originLat?: number,
  originLon?: number,
): MonumentRow {
  const geo = raw['coordonnees_au_format_wgs84'] as { lat?: number; lon?: number } | null;
  const lat = geo?.lat ?? null;
  const lon = geo?.lon ?? null;
  const distance_m =
    lat != null && lon != null && originLat != null && originLon != null
      ? haversineM(originLat, originLon, lat, lon)
      : null;

  return {
    nom:
      str(raw['titre_editorial_de_la_notice']) ??
      str(raw['denomination_de_l_edifice']) ??
      str(raw['autre_appellation_de_l_edifice']) ??
      null,
    denomination: str(raw['denomination_de_l_edifice']) ?? null,
    protection: str(raw['typologie_de_la_protection']) ?? null,
    date_protection: str(raw['date_et_typologie_de_la_protection']) ?? null,
    adresse: str(raw['adresse_forme_editoriale']) ?? null,
    commune: str(raw['commune_forme_editoriale']) ?? null,
    siecle: str(raw['format_abrege_du_siecle_de_construction']) ?? null,
    lat,
    lon,
    distance_m,
  };
}

async function fetchOds(qs: URLSearchParams): Promise<Record<string, unknown>[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ODS_TIMEOUT_MS);
  try {
    const res = await fetch(`${ODS_BASE}?${qs.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`ODS HTTP ${res.status}`);

    // Une plateforme qui a déménagé répond 200 avec du HTML : ce n'est pas une
    // panne, c'est une URL morte. On le dit, plutôt que d'échouer au parsing.
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('json')) {
      throw new Error(
        `ODS a renvoyé "${ctype || 'type inconnu'}" au lieu de JSON — ` +
          `l'endpoint a probablement changé d'adresse (ODS_BASE à mettre à jour).`,
      );
    }

    const data = await res.json();
    const results = data?.results;
    return Array.isArray(results) ? results : [];
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return json({ status: 'error', summary: 'POST only' }, 405);
  }

  let input: MerimeeInput;
  try {
    input = (await req.json()) as MerimeeInput;
  } catch {
    return json({ status: 'error', summary: 'Body JSON invalide.' }, 400);
  }

  const lat = num(input.lat);
  const lon = num(input.lon);
  const codeInsee = str(input.code_insee);
  const radiusM = num(input.radius_m) ?? PERIMETRE_ABF_M;

  if ((lat == null || lon == null) && !codeInsee) {
    return json({
      status: 'no_localization' as MerimeeStatus,
      summary:
        "Localisation insuffisante pour interroger la base Mérimée (ni coordonnées, ni code INSEE).",
      stats: null,
      items: [],
    });
  }

  try {
    const qs = new URLSearchParams();
    qs.set('limit', '20');

    if (lat != null && lon != null) {
      // ODSQL v2.1 : filtre géo dans la clause where via within_distance().
      // Note l'ordre POINT(lon lat) — longitude d'abord (norme WKT).
      qs.set(
        'where',
        `within_distance(coordonnees_au_format_wgs84, geom'POINT(${lon} ${lat})', ${radiusM}m)`,
      );
    } else if (codeInsee) {
      // Repli commune entière (large) : filtre sur le code INSEE de protection.
      qs.set('where', `cog_insee_lors_de_la_protection = "${codeInsee}"`);
    }

    const raw = await fetchOds(qs);
    const rows = raw
      .map((r) => normalizeRow(r, lat, lon))
      .sort((a, b) => (a.distance_m ?? 1e12) - (b.distance_m ?? 1e12));

    if (rows.length === 0) {
      return json({
        status: 'no_data' as MerimeeStatus,
        summary:
          lat != null
            ? `Aucun monument historique dans un rayon de ${radiusM} m. Le terrain n'est pas dans un périmètre d'abords MH connu à cette distance.`
            : "Aucun monument historique recensé pour cette commune dans la base Mérimée.",
        stats: null,
        items: [],
      });
    }

    // Classés vs inscrits (le périmètre 500 m s'applique aux deux).
    const classes = rows.filter((r) => (r.protection ?? '').toLowerCase().includes('classé'));
    const inscrits = rows.filter((r) => (r.protection ?? '').toLowerCase().includes('inscrit'));
    const plusProche = rows[0];

    // Un projet est en périmètre ABF si un MH est à moins de 500 m.
    const dansPerimetreAbf =
      plusProche.distance_m != null && plusProche.distance_m <= PERIMETRE_ABF_M;

    const summaryParts = [
      `${rows.length} monument(s) historique(s) trouvé(s)` +
        (lat != null ? ` dans un rayon de ${radiusM} m.` : ` sur la commune.`),
      plusProche.nom
        ? `Le plus proche : « ${plusProche.nom} »` +
          (plusProche.distance_m != null ? ` à ${plusProche.distance_m} m` : '') +
          (plusProche.protection ? ` (${plusProche.protection}).` : '.')
        : '',
      dansPerimetreAbf
        ? '⚠️ Terrain probablement dans le périmètre des abords (500 m) : tout projet est soumis à l\'avis de l\'Architecte des Bâtiments de France (ABF).'
        : '',
    ].filter(Boolean);

    return json({
      status: 'ok' as MerimeeStatus,
      summary: summaryParts.join(' '),
      stats: {
        total: rows.length,
        nb_classes: classes.length,
        nb_inscrits: inscrits.length,
        distance_plus_proche_m: plusProche.distance_m,
        dans_perimetre_abf_500m: dansPerimetreAbf,
      },
      items: rows.slice(0, 10).map((r) => ({
        nom: r.nom,
        denomination: r.denomination,
        protection: r.protection,
        date_protection: r.date_protection,
        adresse: r.adresse,
        commune: r.commune,
        siecle: r.siecle,
        distance_m: r.distance_m,
      })),
    });
  } catch (e) {
    return json({
      status: 'error' as MerimeeStatus,
      summary: `Erreur interrogation Mérimée : ${e instanceof Error ? e.message : String(e)}`,
      stats: null,
      items: [],
    }, 200);
  }
});
