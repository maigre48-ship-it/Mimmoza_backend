// supabase/functions/bruit-classement-v1/index.ts
// =============================================================
// Mimmoza — Source 9 : Classement sonore des voies (secteurs
// affectés par le bruit), via API Carto GPU (info-surf + prescription-surf).
// Token-free. Contrat compact { status, summary, stats, items }.
// HTTP 200 même sur no_data / no_localization / error.
// Réutilise la brique IDU→polygone cadastre (comme altimetrie).
// =============================================================

const APICARTO = 'https://apicarto.ign.fr';
const TIMEOUT_MS = 20000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function fetchJson(url: string): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ─── Résolution géométrie parcelle : IDU→polygone cadastre, sinon point lat/lon ──
async function resolveGeom(body: any): Promise<{ geom: any; precision: string } | null> {
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const idu = String(body.cadastral_ref ?? body.parcel_id ?? '').replace(/\s/g, '');

  if (/^(2[ab]\d{3}|\d{5})/i.test(idu) && idu.length >= 14) {
    const insee = idu.slice(0, 5).toUpperCase();
    const section = idu.slice(8, 10);
    const numero = idu.slice(10, 14);
    try {
      const url = `${APICARTO}/api/cadastre/parcelle?code_insee=${insee}&section=${encodeURIComponent(section)}&numero=${encodeURIComponent(numero)}`;
      const fc = await fetchJson(url);
      const feat = Array.isArray(fc?.features) ? fc.features[0] : null;
      if (feat?.geometry) {
        console.log(`[bruit] cadastre insee=${insee} sec=${section} num=${numero} → ${fc.features.length} parcelle(s)`);
        return { geom: feat.geometry, precision: 'parcelle' };
      }
      console.log(`[bruit] cadastre insee=${insee} sec=${section} num=${numero} → 0 parcelle, repli point`);
    } catch (e) {
      console.log('[bruit] cadastre error', String(e));
    }
  }

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { geom: { type: 'Point', coordinates: [lon, lat] }, precision: 'point' };
  }
  return null;
}

// ─── Filtre bruit (best-effort, à affiner sur les vrais champs loggés) ──
const BRUIT_RE = /(bruit|sonore|classement\s*sonore|nuisance)/i;

function isBruit(props: Record<string, any>): boolean {
  const hay = [props.libelle, props.typeref, props.nomsrctit, props.txt, props.destdomi, props.typeinfo, props.nomfic]
    .filter(Boolean).join(' ');
  return BRUIT_RE.test(hay);
}

function categorie(props: Record<string, any>): number | null {
  const hay = [props.libelle, props.typeref, props.txt].filter(Boolean).join(' ');
  const m = /cat[ée]gorie\s*([1-5])|\bcat\.?\s*([1-5])\b|\b([1-5])\s*(?:è|e)?me?\s*cat/i.exec(hay);
  const c = m ? Number(m[1] ?? m[2] ?? m[3]) : null;
  return c && c >= 1 && c <= 5 ? c : null;
}

const LARGEUR_M: Record<number, number> = { 1: 300, 2: 250, 3: 100, 4: 30, 5: 10 };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }

  const resolved = await resolveGeom(body);
  if (!resolved) {
    return json({
      status: 'no_localization',
      summary: "Coordonnées ou identifiant cadastral requis : le classement sonore s'interroge à la parcelle, pas à la commune.",
    });
  }

  // Deux couches GPU pour hedger info vs prescription selon les communes.
  const geomStr = encodeURIComponent(JSON.stringify(resolved.geom));
  let features: any[] = [];
  for (const ep of ['info-surf', 'prescription-surf']) {
    try {
      const fc = await fetchJson(`${APICARTO}/api/gpu/${ep}?geom=${geomStr}`);
      if (Array.isArray(fc?.features)) features.push(...fc.features);
    } catch (e) {
      console.log(`[bruit] gpu ${ep} error`, String(e));
    }
  }

  const bruit = features.filter((f) => isBruit(f?.properties ?? {}));
  console.log(`[bruit] gpu total=${features.length} bruit=${bruit.length} precision=${resolved.precision}`);
  if (bruit[0]) console.log('[bruit] item brut[0]:', JSON.stringify(bruit[0].properties).slice(0, 400));

  if (bruit.length === 0) {
    return json({
      status: 'no_data',
      summary:
        `Aucun secteur affecté par le bruit ne recoupe cette parcelle dans le GPU (precision: ${resolved.precision}). ` +
        "⚠️ Le GPU n'est pas exhaustif : une absence ne prouve pas l'absence de classement sonore " +
        "(la commune ne l'a peut-être pas annexé). À recouper avec l'arrêté préfectoral / la DDT.",
      stats: { in_secteur_bruit: false, nb_secteurs: 0, precision: resolved.precision },
      items: [],
    });
  }

  const items = bruit.slice(0, 15).map((f) => {
    const p = f.properties ?? {};
    const cat = categorie(p);
    return {
      libelle: p.libelle ?? p.typeref ?? null,
      categorie: cat,
      largeur_secteur_m: cat ? LARGEUR_M[cat] ?? null : null,
      source: p.nomsrctit ?? null,
      partition: p.partition ?? null,
    };
  });

  const cats = items.map((i) => i.categorie).filter((c): c is number => c != null);
  const catMin = cats.length ? Math.min(...cats) : null; // 1 = la plus sévère

  return json({
    status: 'ok',
    summary:
      `Parcelle en secteur affecté par le bruit : ${bruit.length} secteur(s)` +
      (catMin ? `, catégorie la plus sévère = ${catMin} (secteur ${LARGEUR_M[catMin]} m)` : '') +
      ". Isolation acoustique renforcée exigée pour tout bâtiment sensible neuf (logement, école, santé, hôtel). " +
      `Precision: ${resolved.precision}.`,
    stats: {
      in_secteur_bruit: true,
      nb_secteurs: bruit.length,
      categorie_la_plus_severe: catMin,
      largeur_max_m: catMin ? LARGEUR_M[catMin] : null,
      precision: resolved.precision,
    },
    items,
  });
});