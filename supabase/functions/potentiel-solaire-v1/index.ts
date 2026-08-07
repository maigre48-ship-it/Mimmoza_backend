// supabase/functions/potentiel-solaire-v1/index.ts
// =============================================================
// Mimmoza — Potentiel solaire (PVGIS / JRC) — « cadastre solaire »
// Source de données #3 branchée dans MimmozIA (clôt la vague 1).
//
// Rôle : estimer le potentiel photovoltaïque d'un point (parcelle) :
//   - production spécifique (kWh par kWc installé et par an),
//   - irradiation annuelle dans le plan (kWh/m²/an),
//   - inclinaison et azimut optimaux,
//   - répartition mensuelle.
//
// Choix d'architecture (le plus solide/efficace) :
//   - PVGIS (Photovoltaic Geographical Information System, JRC / Commission
//     européenne) : API publique, gratuite, sans clé, couverture France
//     entière, stable. Endpoint non-interactif versionné v5_2 (PVcalc).
//   - On NE croise PAS avec la surface de toiture BDNB (déjà branchée) :
//     on renvoie la production SPÉCIFIQUE (par kWc), à multiplier par la
//     puissance installée pour une production absolue.
//   - PVGIS ne modélise pas l'ombrage propre à la toiture (contrairement à
//     un cadastre solaire 3D par pan de toit) : c'est une estimation de
//     référence, pas un relevé par toiture. La réponse le précise.
//
// Autonome (Dashboard, aucun import _shared, aucune clé requise).
//
// Contrat de sortie (aligné dpe/merimee/bdnb/loyers/servitudes) :
//   { status, summary, stats, items }
//   status ∈ 'ok' | 'no_data' | 'no_localization' | 'error'  (toujours HTTP 200)
// =============================================================

// v5_2 = endpoint non-interactif stable ; bumper en v5_3 est un simple
// changement de ce segment si besoin.
const PVGIS_PVCALC = 'https://re.jrc.ec.europa.eu/api/v5_2/PVcalc';
const FETCH_TIMEOUT_MS = 9000;
const SYSTEM_LOSS_PCT = 14; // pertes système standard (câblage, onduleur, T°…)

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
function round(v: unknown, digits = 0): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ status: 'error', summary: 'POST only', stats: null, items: [] }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* {} */ }

  const lat = num(body.lat);
  const lon = num(body.lon) ?? num((body as any).lng);

  if (lat == null || lon == null) {
    return json({
      status: 'no_localization',
      summary: "Coordonnées (lat/lon) requises pour estimer le potentiel solaire.",
      stats: null,
      items: [],
    }, 200);
  }

  // PVcalc : 1 kWc de référence, montage toiture, angles optimisés.
  const url =
    `${PVGIS_PVCALC}?lat=${lat}&lon=${lon}` +
    `&peakpower=1&loss=${SYSTEM_LOSS_PCT}&mountingplace=building` +
    `&optimalangles=1&outputformat=json`;

  let raw: any;
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) {
      // PVGIS renvoie un message clair pour les cas hors-couverture (ex. mer).
      const txt = await r.text().catch(() => '');
      const overSea = /over the sea|location over/i.test(txt);
      return json({
        status: overSea ? 'no_data' : 'error',
        summary: overSea
          ? "Point situé hors couverture terrestre PVGIS (mer/hors zone) : pas d'estimation solaire."
          : `PVGIS a répondu HTTP ${r.status}.`,
        stats: null,
        items: [],
      }, 200);
    }
    raw = await r.json();
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    return json({
      status: 'error',
      summary: aborted ? "PVGIS n'a pas répondu à temps (timeout)." : `Erreur PVGIS : ${e instanceof Error ? e.message : String(e)}`,
      stats: null,
      items: [],
    }, 200);
  }

  try {
    const totals = raw?.outputs?.totals?.fixed ?? {};
    const mount = raw?.inputs?.mounting_system?.fixed ?? {};
    const monthly = Array.isArray(raw?.outputs?.monthly?.fixed) ? raw.outputs.monthly.fixed : [];

    const prodSpecifique = round(totals['E_y']);           // kWh / kWc / an
    const irradiation = round(totals['H(i)_y']);           // kWh / m² / an (dans le plan)
    const pertesTotales = round(totals['l_total'], 1);     // % (peut être négatif = gain)
    const inclinaison = round(mount?.slope?.value, 1);
    const azimut = round(mount?.azimuth?.value, 1);

    if (prodSpecifique == null && irradiation == null) {
      return json({
        status: 'no_data',
        summary: "PVGIS n'a renvoyé aucune valeur exploitable pour ce point.",
        stats: null,
        items: [],
      }, 200);
    }

    const items = monthly.map((m: any) => ({
      mois: MONTHS_FR[(num(m?.month) ?? 0) - 1] ?? String(m?.month ?? ''),
      production_kwh_kwc: round(m?.E_m),
    }));

    return json({
      status: 'ok',
      summary:
        `Potentiel solaire (PVGIS) : ~${prodSpecifique} kWh/kWc/an, ` +
        `irradiation ${irradiation} kWh/m²/an, ` +
        `inclinaison optimale ${inclinaison}° / azimut ${azimut}° (0 = plein sud).`,
      stats: {
        production_specifique_kwh_kwc_an: prodSpecifique,
        irradiation_plan_kwh_m2_an: irradiation,
        inclinaison_optimale_deg: inclinaison,
        azimut_optimal_deg: azimut,
        azimut_convention: '0 = plein sud, -90 = est, +90 = ouest (convention PVGIS)',
        pertes_systeme_pct: SYSTEM_LOSS_PCT,
        pertes_totales_estimees_pct: pertesTotales,
        base_calcul: '1 kWc, silicium cristallin, montage sur toiture, angles optimisés',
        note_production_absolue:
          "Production SPÉCIFIQUE (par kWc). Pour une production annuelle absolue, multiplier par la puissance installée en kWc.",
        limite:
          "PVGIS ne modélise pas l'ombrage propre à la toiture (cheminées, pans, masques proches) : estimation de référence, pas un relevé par toiture.",
        source: 'PVGIS (JRC, Commission européenne)',
      },
      items,
    }, 200);
  } catch (e) {
    return json({
      status: 'error',
      summary: `Erreur lecture réponse PVGIS : ${e instanceof Error ? e.message : String(e)}`,
      stats: null,
      items: [],
    }, 200);
  }
});