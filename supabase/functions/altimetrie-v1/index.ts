// supabase/functions/altimetrie-v1/index.ts
// =============================================================
// Mimmoza — Altimétrie & pente (source #8)
//
// Altitude + PENTE estimée d'une parcelle via le RGE Alti de l'IGN.
// La pente est calculée par échantillonnage local (centre + 4 voisins).
//
// AUTONOME À LA PARCELLE : si aucune coordonnée n'est fournie, la fonction
// résout elle-même le centroïde de la parcelle à partir de son identifiant
// cadastral (IDU) via le module cadastre d'API Carto → mesure « parcelle ».
// Repli ultime : centroïde de la commune (geo.api) → « centre_commune ».
//
// Sources : IGN RGE Alti (data.geopf.fr) + API Carto cadastre (apicarto.ign.fr)
//           + geo.api.gouv.fr. Toutes publiques, sans jeton.
//
// Contrat : { status, summary, stats, items } — toujours HTTP 200
// =============================================================

const ALTI_URL = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const RESOURCES = ['ign_rge_alti_wld', 'rgealti'];
const CADASTRE_URL = 'https://apicarto.ign.fr/api/cadastre/parcelle';
const STEP_M = 15;
const NODATA = -99999;
const FETCH_TIMEOUT_MS = 9000;

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
function round(v: number, d = 2): number { const f = 10 ** d; return Math.round(v * f) / f; }

// ── IDU → parcelle → centroïde (module cadastre API Carto) ──
function parseIdu(idu: string): { insee: string; section: string; numero: string } | null {
  const s = idu.replace(/\s/g, '').toUpperCase();
  if (s.length < 14) return null;                       // IDU standard = 14 caractères
  const insee = s.slice(0, 5);
  const section = s.slice(8, 10);                       // 2 caractères, ex "AI", "0A"
  // ⚠️ NE PAS dépadder : API Carto exige numero sur 4 caractères.
  // parseInt("0002") → "2" provoquait un HTTP 400 systématique.
  const numero = s.slice(10, 14).padStart(4, '0');
  if (!/^(\d{5}|2[AB]\d{3})$/.test(insee)) return null;
  if (!/^[0-9A-Z]{2}$/.test(section) || !/^\d{4}$/.test(numero)) return null;
  return { insee, section, numero };
}
function centroidOf(geom: any): { lat: number; lon: number } | null {
  let ring: number[][] | null = null;
  if (geom?.type === 'Polygon') ring = geom.coordinates?.[0];
  else if (geom?.type === 'MultiPolygon') ring = geom.coordinates?.[0]?.[0];
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sx = 0, sy = 0, n = 0;
  for (const c of ring) { if (Array.isArray(c) && c.length >= 2) { sx += c[0]; sy += c[1]; n++; } }
  return n ? { lon: sx / n, lat: sy / n } : null;
}
async function centroidFromIdu(idu: string): Promise<{ lat: number; lon: number } | null> {
  const p = parseIdu(idu);
  if (!p) { console.error(`[altimetrie] IDU illisible: ${idu}`); return null; }
  const url = `${CADASTRE_URL}?code_insee=${p.insee}&section=${encodeURIComponent(p.section)}&numero=${encodeURIComponent(p.numero)}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) { console.error(`[altimetrie] cadastre HTTP ${r.status} — URL: ${url}`); return null; }
    const fc = await r.json();
    const nb = Array.isArray(fc?.features) ? fc.features.length : 0;
    console.log(`[altimetrie] cadastre insee=${p.insee} section=${p.section} numero=${p.numero} → ${nb} parcelle(s)`);
    const geom = nb ? fc.features[0]?.geometry : null;
    return geom ? centroidOf(geom) : null;
  } catch (e) { console.error(`[altimetrie] cadastre échec: ${e instanceof Error ? e.message : String(e)}`); return null; }
}

async function communeCentroid(p: { codeInsee?: string; commune?: string }): Promise<{ lat: number; lon: number } | null> {
  const query = p.codeInsee ? `code=${encodeURIComponent(p.codeInsee)}` : (p.commune ? `nom=${encodeURIComponent(p.commune)}` : null);
  if (!query) return null;
  try {
    const r = await fetch(`https://geo.api.gouv.fr/communes?${query}&fields=centre&limit=1`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const d = await r.json();
    const c = Array.isArray(d) && d[0]?.centre?.coordinates;
    if (Array.isArray(c) && c.length === 2) return { lon: c[0], lat: c[1] };
  } catch { /* injoignable */ }
  return null;
}

async function queryElevations(lons: number[], lats: number[]): Promise<number[] | null> {
  const lonStr = lons.map((v) => v.toFixed(8)).join('|');
  const latStr = lats.map((v) => v.toFixed(8)).join('|');
  for (const resource of RESOURCES) {
    const url = `${ALTI_URL}?lon=${lonStr}&lat=${latStr}&resource=${resource}&delimiter=%7C&zonly=true&indent=false`;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) { console.error(`[altimetrie] alti HTTP ${r.status} (resource ${resource})`); continue; }
      const d = await r.json();
      if (d?.error) { console.error(`[altimetrie] alti error (${resource}): ${JSON.stringify(d.error).slice(0, 200)}`); continue; }
      const els = Array.isArray(d?.elevations) ? d.elevations : null;
      if (!els) continue;
      return els.map((e: any) => (typeof e === 'number' ? e : Number(e?.z)));
    } catch (e) {
      console.error(`[altimetrie] alti fetch échec (${resource}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return null;
}

function classePente(pct: number): string {
  if (pct < 2) return 'terrain plat';
  if (pct < 5) return 'faible pente';
  if (pct < 10) return 'pente modérée';
  if (pct < 15) return 'forte pente';
  return 'très forte pente (surcoûts terrassement/VRD importants)';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ status: 'error', summary: 'POST only', stats: null, items: [] }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* {} */ }

  let lat = num(body.lat);
  let lon = num(body.lon) ?? num((body as any).lng);
  let precision: 'parcelle' | 'centre_commune' = 'parcelle';
  const cadastralRef = normStr(body.cadastral_ref);
  const communeName = normStr(body.commune);
  const codeInsee = normStr(body.code_insee) ?? (cadastralRef && cadastralRef.length >= 5 ? cadastralRef.slice(0, 5) : undefined);

  // 1) coordonnées fournies → parcelle
  // 2) sinon centroïde de la parcelle depuis l'IDU (cadastre) → parcelle
  if ((lat == null || lon == null) && cadastralRef) {
    const c = await centroidFromIdu(cadastralRef);
    if (c) { lat = c.lat; lon = c.lon; precision = 'parcelle'; }
  }
  // 3) sinon centroïde de la commune → centre_commune
  if (lat == null || lon == null) {
    const c = await communeCentroid({ codeInsee, commune: communeName });
    if (c) { lat = c.lat; lon = c.lon; precision = 'centre_commune'; }
  }
  if (lat == null || lon == null) {
    return json({ status: 'no_localization', summary: "Coordonnées, identifiant cadastral ou commune requis pour l'altimétrie.", stats: null, items: [] }, 200);
  }

  try {
    const dLat = STEP_M / 111320;
    const dLon = STEP_M / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
    const lons = [lon, lon + dLon, lon - dLon, lon, lon];
    const lats = [lat, lat, lat, lat + dLat, lat - dLat];

    const z = await queryElevations(lons, lats);
    if (!z || z.length < 5) {
      return json({ status: 'error', summary: "L'API altimétrie IGN est momentanément injoignable.", stats: null, items: [] }, 200);
    }

    const [zC, zE, zW, zN, zS] = z;
    const valid = (v: number) => typeof v === 'number' && Number.isFinite(v) && v !== NODATA;
    if (!valid(zC)) {
      return json({ status: 'no_data', summary: 'Point hors couverture RGE Alti : altitude indisponible.', stats: { precision }, items: [] }, 200);
    }

    const sx = valid(zE) && valid(zW) ? (zE - zW) / (2 * STEP_M) : valid(zE) ? (zE - zC) / STEP_M : valid(zW) ? (zC - zW) / STEP_M : 0;
    const sy = valid(zN) && valid(zS) ? (zN - zS) / (2 * STEP_M) : valid(zN) ? (zN - zC) / STEP_M : valid(zS) ? (zC - zS) / STEP_M : 0;
    const grad = Math.sqrt(sx * sx + sy * sy);
    const pentePct = round(grad * 100, 1);
    const penteDeg = round(Math.atan(grad) * 180 / Math.PI, 1);
    const classe = classePente(pentePct);

    const note = precision === 'centre_commune'
      ? " ⚠️ Mesure au centre de la commune (parcelle non localisée) : altitude et pente INDICATIVES."
      : '';

    return json({
      status: 'ok',
      summary: `Altitude ~${round(zC, 0)} m. Pente estimée ${pentePct} % (${penteDeg}°) — ${classe}.${note}`,
      stats: {
        altitude_m: round(zC, 1),
        pente_pct: pentePct,
        pente_deg: penteDeg,
        classe_pente: classe,
        precision,
        note: "Pente estimée par échantillonnage RGE Alti ; à confirmer par un relevé topographique pour un projet.",
        source: 'IGN — RGE Alti via API Géoplateforme + cadastre API Carto',
      },
      items: [{ z_centre: round(zC, 2), z_est: zE, z_ouest: zW, z_nord: zN, z_sud: zS }],
    }, 200);
  } catch (e) {
    return json({ status: 'error', summary: `Erreur altimétrie : ${e instanceof Error ? e.message : String(e)}`, stats: null, items: [] }, 200);
  }
});