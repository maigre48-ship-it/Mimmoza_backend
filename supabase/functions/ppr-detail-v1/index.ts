// supabase/functions/ppr-detail-v1/index.ts
// =============================================================
// Mimmoza — PPR détaillés (source #6)
//
// Rôle : détailler les Plans de Prévention des Risques (PPRN/PPRT/PPRM) qui
//   concernent une commune, AU-DELÀ du booléen déjà fourni par risk-study :
//   - nom du PPR, type de risque (inondation, mouvement de terrain, techno…) ;
//   - statut : APPROUVÉ (opposable, vaut servitude, annexé au PLU) vs PRESCRIT
//     (application anticipée possible, sursis à statuer) ;
//   - dates d'approbation / fin de validité ;
//   - si des coordonnées parcelle sont fournies : test POINT-IN-PÉRIMÈTRE pour
//     dire si la parcelle est RÉELLEMENT dans l'emprise du PPR (pas seulement
//     « la commune est concernée »).
//
// ⚠️ LIMITE ASSUMÉE : l'API ne fournit PAS le zonage réglementaire interne
//   (zone rouge / bleue / etc.) ni son règlement — ces données sont diffusées
//   en WMS/COVADIS morcelé par PPR, sans API nationale. La réponse renvoie vers
//   le document du PPR (Géorisques / Errial / DDT) pour la couleur de zone exacte.
//   Ne jamais inventer une zone rouge/bleue.
//
// Source : API Géorisques v1 (BD GASPAR), publique, sans jeton.
// Autonome (Dashboard, aucun import _shared, aucune clé requise).
//
// Contrat de sortie : { status, summary, stats, items } — toujours HTTP 200
//   status ∈ 'ok' | 'no_data' | 'no_localization' | 'error'
// =============================================================

// gaspar/ppr n'existe PAS en v1 (404 « No endpoint »). On tente d'abord la v2
// (schéma riche : nom_ppr, etat, risque, geom_perimetre — le mapping ci-dessous
// est calé dessus, comme le package R officiel), puis repli sur v1 gaspar/risques
// (confirmé en prod, sans jeton). La fonction logue l'endpoint réellement retenu.
const PPR_ENDPOINTS: Array<(insee: string) => string> = [
  (insee) => `https://georisques.gouv.fr/api/v2/gaspar/ppr?code_insee=${encodeURIComponent(insee)}&page_size=20`,
  (insee) => `https://georisques.gouv.fr/api/v1/gaspar/risques?code_insee=${encodeURIComponent(insee)}&rayon=1000`,
];
const FETCH_TIMEOUT_MS = 9000;

const NOTE_ZONAGE =
  "L'API Géorisques donne le périmètre et le statut de chaque PPR, PAS le zonage réglementaire interne (zone rouge/bleue) ni son règlement. Pour la zone précise applicable à la parcelle et ses prescriptions, consulter le règlement du PPR (Géorisques / errial.georisques.gouv.fr) ou la DDT.";
const SOURCE = 'Géorisques — BD GASPAR (API v1)';

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
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
function normStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[ppr-detail] HTTP ${r.status} sur ${url} — ${body.slice(0, 300)}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error(`[ppr-detail] fetch échec ${url} — ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
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

// ── Point-in-polygon (ray casting), Polygon + MultiPolygon + trous ──
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInPolygon(lon: number, lat: number, poly: number[][][]): boolean {
  if (!poly?.length || !pointInRing(lon, lat, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (pointInRing(lon, lat, poly[k])) return false; // trou
  return true;
}
function pointInGeoJSON(lon: number, lat: number, geom: any): boolean {
  if (!geom || !geom.type) return false;
  try {
    if (geom.type === 'Polygon') return pointInPolygon(lon, lat, geom.coordinates);
    if (geom.type === 'MultiPolygon') return geom.coordinates.some((p: number[][][]) => pointInPolygon(lon, lat, p));
  } catch { /* géométrie inattendue */ }
  return false;
}

// ── Normalisation d'un item PPR (tolérante aux variations de champs) ──
function normalizePpr(it: Record<string, any>): Record<string, any> {
  const nom = it.nom_ppr ?? it.libelle_ppr ?? it.libelle ?? null;
  const id = it.id_gaspar ?? it.code_national_ppr ?? it.code_ppr ?? null;

  // état : string ou objet { code_etat, libelle_etat }
  let etat: string | null = null;
  if (typeof it.etat === 'string') etat = it.etat;
  else if (it.etat && typeof it.etat === 'object') etat = it.etat.libelle_etat ?? it.etat.libelle ?? it.etat.code_etat ?? null;
  etat = etat ?? it.libelle_etat ?? it.code_etat ?? null;

  // risque(s) : objet, tableau, ou champ plat
  const risques: string[] = [];
  const pushRisque = (r: any) => {
    if (!r) return;
    if (typeof r === 'string') risques.push(r);
    else if (typeof r === 'object') { const l = r.libelle_risque ?? r.libelle ?? r.code_risque; if (l) risques.push(String(l)); }
  };
  if (Array.isArray(it.risques)) it.risques.forEach(pushRisque);
  else if (Array.isArray(it.risque)) it.risque.forEach(pushRisque);
  else { pushRisque(it.risque); pushRisque(it.libelle_risque); }

  const opposable = typeof etat === 'string' && /approuv/i.test(etat);

  return {
    nom_ppr: nom,
    id_gaspar: id,
    risques: [...new Set(risques)],
    statut: etat,
    opposable,                                   // approuvé => opposable (vaut SUP)
    date_approbation: it.date_approbation ?? it.dat_approbation ?? null,
    date_fin_validite: it.date_fin_validite ?? null,
    _geom: it.geom_perimetre ?? it.perimetre ?? it.geom ?? null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ status: 'error', summary: 'POST only', stats: null, items: [] }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* {} */ }

  let codeInsee = normStr(body.code_insee);
  const commune = normStr(body.commune) ?? normStr(body.city);
  const zipCode = normStr(body.zip_code) ?? normStr(body.code_postal);
  const lat = num(body.lat);
  const lon = num(body.lon) ?? num((body as any).lng);

  if (!codeInsee && (commune || zipCode)) codeInsee = await resolveInseeFromGeo({ commune, zipCode });
  if (!codeInsee) {
    return json({
      status: 'no_localization',
      summary: "Code INSEE requis (ou commune / code postal) pour lister les PPR.",
      stats: null, items: [],
    }, 200);
  }

  try {
    let raw: any = null;
    let usedUrl = '';
    for (const build of PPR_ENDPOINTS) {
      const url = build(codeInsee);
      raw = await fetchJson(url);
      if (raw != null) { usedUrl = url; break; }
    }
    console.log('[ppr-detail] endpoint retenu:', usedUrl || 'AUCUN (tous en échec)');
    if (raw == null) {
      return json({
        status: 'error',
        summary: "L'API Géorisques est momentanément injoignable pour les PPR.",
        stats: null, items: [],
      }, 200);
    }
    const list = Array.isArray(raw?.results) ? raw.results
      : Array.isArray(raw?.data) ? raw.data
      : Array.isArray(raw) ? raw : [];

    if (list.length) console.log('[ppr-detail] item brut[0]:', JSON.stringify(list[0]).slice(0, 600));

    if (list.length === 0) {
      return json({
        status: 'no_data',
        summary: `Aucun PPR recensé pour la commune (INSEE ${codeInsee}) dans la BD GASPAR.`,
        stats: { code_insee: codeInsee, nb_ppr: 0, source: SOURCE }, items: [],
      }, 200);
    }

    const hasPoint = lat != null && lon != null;
    const items = list.map((it: Record<string, any>) => {
      const n = normalizePpr(it);
      const dans = hasPoint && n._geom ? pointInGeoJSON(lon!, lat!, n._geom)
        : (hasPoint ? null : null);
      const { _geom, ...rest } = n;
      return { ...rest, parcelle_dans_perimetre: hasPoint ? (n._geom ? dans : null) : null };
    });

    const nbApprouves = items.filter((i: any) => i.opposable).length;
    const nbPrescrits = items.length - nbApprouves;
    const couvrants = hasPoint ? items.filter((i: any) => i.parcelle_dans_perimetre === true) : [];

    const teteliste = items.slice(0, 4).map((i: any) =>
      `${i.nom_ppr ?? 'PPR'}${i.risques?.length ? ` (${i.risques.join('/')})` : ''} — ${i.opposable ? 'approuvé' : (i.statut ?? 'statut n.c.')}`,
    ).join(' ; ');

    const summary =
      `${items.length} PPR concernent la commune (${nbApprouves} approuvé(s), ${nbPrescrits} autre(s)) : ${teteliste}${items.length > 4 ? '…' : ''}.` +
      (hasPoint
        ? (couvrants.length
            ? ` La parcelle est DANS le périmètre de : ${couvrants.map((i: any) => i.nom_ppr).join(', ')}.`
            : ` La parcelle ne ressort dans aucun périmètre PPR testé (vérifier le règlement en cas de doute).`)
        : ' (Aucune coordonnée fournie : liste au niveau commune, périmètre parcelle non testé.)') +
      ` ${NOTE_ZONAGE}`;

    return json({
      status: 'ok',
      summary,
      stats: {
        code_insee: codeInsee,
        nb_ppr: items.length,
        nb_approuves: nbApprouves,
        nb_prescrits_autres: nbPrescrits,
        test_perimetre_parcelle: hasPoint,
        nb_ppr_couvrant_parcelle: hasPoint ? couvrants.length : null,
        note_zonage: NOTE_ZONAGE,
        note_statut: "Un PPR approuvé est opposable (vaut servitude, annexé au PLU). Un PPR prescrit permet un sursis à statuer et l'application anticipée de mesures.",
        source: SOURCE,
      },
      items,
    }, 200);
  } catch (e) {
    return json({
      status: 'error',
      summary: `Erreur interrogation PPR (Géorisques) : ${e instanceof Error ? e.message : String(e)}`,
      stats: null, items: [],
    }, 200);
  }
});