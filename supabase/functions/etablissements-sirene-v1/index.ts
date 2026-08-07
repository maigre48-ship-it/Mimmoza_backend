// supabase/functions/etablissements-sirene-v1/index.ts
// Mimmoza — Source 12 (SIRENE) : établissements immatriculés autour d'un point
// -----------------------------------------------------------------------------
// Source : API Recherche d'entreprises (DINUM / Annuaire des Entreprises),
//   endpoint /near_point — synthèse RNE + base Sirene, TOKEN-FREE.
// ⚠️ SIRENE = établissements IMMATRICULÉS, PAS des permis ni des projets futurs.
// Contrat compact { status, summary, stats, items }, HTTP 200 toujours.
//
// CHAMPS CONFIRMÉS AU 1ER TEST RÉEL (04/08/2026, Ascain 43.3486/-1.6297) et
// CORRECTIFS APPLIQUÉS :
//   1) SECTION NAF : l'ancien code prenait ul.section_activite_principale
//      (niveau UNITÉ LÉGALE) tout en affichant le NAF de l'ÉTABLISSEMENT
//      → « JEAN IRAZOQUI — Agriculture (NAF 68.20A) » alors que 68.20A = section L
//      (immobilier). La section est désormais TOUJOURS dérivée du NAF de
//      l'établissement affiché ; le champ parent n'est qu'un repli si NAF absent.
//   2) ÉTAT ADMINISTRATIF : le code INSEE de fermeture est 'F', pas 'C'.
//      L'ancien mapping laissait passer les établissements FERMÉS dans le
//      décompte des « actifs » (constaté : PARLEMENTIA SPOT, etat 'F').
//   3) PORTÉE DU TOTAL : total_results de l'API compte des UNITÉS LÉGALES
//      (entreprises), pas des établissements — et le repli sur le siège pouvait
//      injecter un établissement HORS RAYON (constaté : LA POSTE, siège Paris,
//      remonté sur une requête Ascain). On filtre désormais par distance réelle
//      et total_dans_rayon compte des ÉTABLISSEMENTS effectivement retenus.
// -----------------------------------------------------------------------------

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const NEAR_POINT = 'https://recherche-entreprises.api.gouv.fr/near_point';
const FETCH_TIMEOUT_MS = 8000;
const PER_PAGE = 25;      // maximum accepté par l'API
const MAX_PAGES = 4;      // 4 pages = 100 unités légales, sous la limite 7 req/s/IP

interface Body {
  latitude?: number;
  longitude?: number;
  radius_km?: number;
  section?: string;
  activite_principale?: string;
  limit?: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS });
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
function s(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t : null;
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

// Division NAF (2 premiers chiffres) → section (lettre A..U). Déterministe.
function nafSection(code: string | null): string | null {
  if (!code) return null;
  const m = /^(\d{2})/.exec(code.replace(/\s/g, ''));
  if (!m) return null;
  const d = Number(m[1]);
  if (d >= 1 && d <= 3) return 'A';
  if (d >= 5 && d <= 9) return 'B';
  if (d >= 10 && d <= 33) return 'C';
  if (d === 35) return 'D';
  if (d >= 36 && d <= 39) return 'E';
  if (d >= 41 && d <= 43) return 'F';
  if (d >= 45 && d <= 47) return 'G';
  if (d >= 49 && d <= 53) return 'H';
  if (d >= 55 && d <= 56) return 'I';
  if (d >= 58 && d <= 63) return 'J';
  if (d >= 64 && d <= 66) return 'K';
  if (d === 68) return 'L';
  if (d >= 69 && d <= 75) return 'M';
  if (d >= 77 && d <= 82) return 'N';
  if (d === 84) return 'O';
  if (d === 85) return 'P';
  if (d >= 86 && d <= 88) return 'Q';
  if (d >= 90 && d <= 93) return 'R';
  if (d >= 94 && d <= 96) return 'S';
  if (d >= 97 && d <= 98) return 'T';
  if (d === 99) return 'U';
  return null;
}

const SECTION_LABEL: Record<string, string> = {
  A: 'Agriculture', B: 'Industries extractives', C: 'Industrie manufacturière',
  D: 'Énergie', E: 'Eau / déchets', F: 'Construction',
  G: 'Commerce / réparation auto', H: 'Transports / entreposage',
  I: 'Hébergement / restauration', J: 'Information / communication',
  K: 'Finance / assurance', L: 'Immobilier', M: 'Activités spécialisées / scientifiques',
  N: 'Services administratifs / soutien', O: 'Administration publique',
  P: 'Enseignement', Q: 'Santé / action sociale', R: 'Arts / spectacles',
  S: 'Autres services', T: 'Services aux ménages', U: 'Organismes extraterritoriaux',
};

// Tranches d'effectif salarié INSEE → libellé lisible (le code brut ne parle pas au LLM).
const EFFECTIF_LABEL: Record<string, string> = {
  NN: 'non renseigné', '00': '0 salarié', '01': '1 à 2 salariés', '02': '3 à 5 salariés',
  '03': '6 à 9 salariés', '11': '10 à 19 salariés', '12': '20 à 49 salariés',
  '21': '50 à 99 salariés', '22': '100 à 199 salariés', '31': '200 à 249 salariés',
  '32': '250 à 499 salariés', '41': '500 à 999 salariés', '42': '1 000 à 1 999 salariés',
  '51': '2 000 à 4 999 salariés', '52': '5 000 à 9 999 salariés', '53': '10 000 salariés et plus',
};

interface EtabOut {
  nom: string | null;
  enseigne: string | null;
  siret: string | null;
  activite_naf: string | null;
  section: string | null;
  section_libelle: string | null;
  adresse: string | null;
  code_postal: string | null;
  commune: string | null;
  distance_m: number | null;
  etat: string | null;
  date_creation: string | null;
  tranche_effectif: string | null;
  latitude: number | null;
  longitude: number | null;
}

async function fetchPage(url: URL): Promise<any | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url.toString(), { headers: { Accept: 'application/json' }, signal: ac.signal });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[sirene] HTTP', r.status, txt.slice(0, 200));
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error('[sirene] fetch fail', e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ status: 'error', error: 'POST only' }, 405);

  let body: Body;
  try { body = await req.json(); }
  catch { return json({ status: 'error', summary: 'Corps JSON invalide.' }, 200); }

  const lat = num(body.latitude);
  const lon = num(body.longitude);
  if (lat === null || lon === null) {
    return json({
      status: 'no_localization',
      summary: "Coordonnées (latitude/longitude) requises pour interroger SIRENE autour d'un point.",
    }, 200);
  }

  const radiusKm = Math.min(10, Math.max(0.1, num(body.radius_km) ?? 1));
  const radiusM = radiusKm * 1000;
  const limit = Math.min(30, Math.max(1, Math.trunc(num(body.limit) ?? 15)));

  const nafFilter = s(body.activite_principale);
  const sectionFilter = s(body.section);

  const buildUrl = (page: number) => {
    const url = new URL(NEAR_POINT);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('long', String(lon));
    url.searchParams.set('radius', String(radiusKm));
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(PER_PAGE));
    if (nafFilter) url.searchParams.set('activite_principale', nafFilter);
    else if (sectionFilter) url.searchParams.set('section_activite_principale', sectionFilter.toUpperCase());
    return url;
  };

  const first = await fetchPage(buildUrl(1));
  if (!first) {
    return json({ status: 'error', summary: "API Recherche d'entreprises injoignable ou en erreur." }, 200);
  }

  // total_results = nombre d'UNITÉS LÉGALES (entreprises) ayant au moins un
  // établissement dans le rayon — PAS un nombre d'établissements.
  const totalEntreprises = num(first?.total_results) ?? 0;
  const results: any[] = Array.isArray(first?.results) ? [...first.results] : [];

  const pagesDispo = Math.ceil(totalEntreprises / PER_PAGE);
  const pagesALire = Math.min(MAX_PAGES, Math.max(1, pagesDispo));
  for (let p = 2; p <= pagesALire; p++) {
    const d = await fetchPage(buildUrl(p));
    if (!d || !Array.isArray(d.results) || d.results.length === 0) break;
    results.push(...d.results);
  }

  // Aplatissement. On ne retient QUE matching_etablissements (ceux réellement
  // proches du point). Le repli sur `siege` est conservé mais soumis au même
  // filtre de distance : sans lui, le siège parisien d'un groupe national
  // remonterait comme « établissement voisin » (cas LA POSTE constaté au test).
  const flat: EtabOut[] = [];
  const vusSiret = new Set<string>();

  for (const ul of results) {
    const nomUl = s(ul?.nom_complet) ?? s(ul?.nom_raison_sociale);
    const etabs: any[] =
      Array.isArray(ul?.matching_etablissements) && ul.matching_etablissements.length
        ? ul.matching_etablissements
        : (ul?.siege ? [ul.siege] : []);

    for (const e of etabs) {
      const eLat = num(e?.latitude);
      const eLon = num(e?.longitude);
      const distance = (eLat !== null && eLon !== null) ? haversineM(lat, lon, eLat, eLon) : null;

      // Filtre de distance dur : pas de coordonnées ou hors rayon → écarté.
      // (tolérance 10 % pour absorber l'arrondi du filtre serveur)
      if (distance === null || distance > radiusM * 1.1) continue;

      const siret = s(e?.siret);
      if (siret) {
        if (vusSiret.has(siret)) continue;
        vusSiret.add(siret);
      }

      // NAF de l'ÉTABLISSEMENT en priorité ; la section en est TOUJOURS dérivée
      // pour rester cohérente avec le code affiché (correctif n°1).
      const naf = s(e?.activite_principale) ?? s(ul?.activite_principale);
      const sec = nafSection(naf) ?? s(ul?.section_activite_principale);

      const enseignes = Array.isArray(e?.liste_enseignes) ? e.liste_enseignes.filter(Boolean) : [];
      const etatRaw = (s(e?.etat_administratif) ?? s(ul?.etat_administratif))?.toUpperCase() ?? null;
      const effRaw = s(e?.tranche_effectif_salarie) ?? s(ul?.tranche_effectif_salarie);

      flat.push({
        nom: nomUl,
        enseigne: enseignes[0] ? String(enseignes[0]) : (s(e?.nom_commercial) ?? null),
        siret,
        activite_naf: naf,
        section: sec,
        section_libelle: sec ? (SECTION_LABEL[sec] ?? null) : null,
        adresse: s(e?.adresse),
        code_postal: s(e?.code_postal),
        commune: s(e?.libelle_commune) ?? s(e?.commune),
        distance_m: distance,
        // Correctif n°2 : 'A' = actif, 'F' = fermé (l'ancien code testait 'C').
        etat: etatRaw === 'A' ? 'actif' : (etatRaw === 'F' || etatRaw === 'C') ? 'fermé' : etatRaw,
        date_creation: s(e?.date_creation) ?? s(ul?.date_creation),
        tranche_effectif: effRaw ? (EFFECTIF_LABEL[effRaw] ?? effRaw) : null,
        latitude: eLat,
        longitude: eLon,
      });
    }
  }

  const actifs = flat.filter((x) => x.etat === 'actif');
  const fermes = flat.length - actifs.length;
  actifs.sort((a, b) => (a.distance_m ?? 1e12) - (b.distance_m ?? 1e12));

  const troncatureApi = pagesDispo > pagesALire;

  if (actifs.length === 0) {
    return json({
      status: 'no_data',
      summary:
        `Aucun établissement immatriculé ACTIF retenu dans un rayon de ${radiusKm} km ` +
        `(${totalEntreprises} entreprise(s) signalées par l'API sur ce rayon, aucune avec un ` +
        `établissement actif géolocalisé dans le périmètre).`,
      stats: {
        total_dans_rayon: 0,
        analyses: 0,
        affichage_tronque: troncatureApi,
        rayon_km: radiusKm,
        entreprises_signalees_api: totalEntreprises,
      },
      items: [],
      source: "SIRENE / RNE via API Recherche d'entreprises (DINUM)",
    }, 200);
  }

  const parSection: Record<string, number> = {};
  for (const x of actifs) {
    const key = x.section ? `${x.section} — ${x.section_libelle ?? x.section}` : 'NC';
    parSection[key] = (parSection[key] ?? 0) + 1;
  }

  const now = Date.now();
  const recent = actifs.filter((x) => {
    if (!x.date_creation) return false;
    const d = new Date(x.date_creation).getTime();
    return Number.isFinite(d) && (now - d) <= 366 * 24 * 3600 * 1000;
  });

  const items = actifs.slice(0, limit).map((x) => ({
    nom: x.enseigne ?? x.nom,
    activite: x.section_libelle ? `${x.section_libelle} (NAF ${x.activite_naf ?? '?'})` : x.activite_naf,
    adresse: x.adresse,
    commune: x.commune,
    distance_m: x.distance_m,
    date_creation: x.date_creation ? x.date_creation.slice(0, 10) : null,
    effectif: x.tranche_effectif,
    etat: x.etat,
  }));

  const sectionsTop = Object.entries(parSection)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, n]) => `${k}: ${n}`).join(' · ');

  // Le summary porte la nuance de comptage : c'est le seul champ texte que le
  // copilot relaie intégralement au modèle.
  const summary =
    `${actifs.length} établissement(s) actif(s) géolocalisé(s) retenus dans un rayon de ${radiusKm} km` +
    (fermes ? ` (${fermes} établissement(s) fermé(s) écarté(s))` : '') +
    (sectionsTop ? `. Principaux secteurs — ${sectionsTop}.` : '.') +
    (recent.length ? ` ${recent.length} création(s) de moins de 12 mois (activité récente).` : '') +
    ` L'API signale ${totalEntreprises} entreprise(s) sur ce rayon — il s'agit d'unités légales (SIREN), ` +
    `pas d'établissements, et ce total inclut sièges sociaux et sociétés sans local commercial : ` +
    `ne le présente jamais comme un nombre de commerces.` +
    (troncatureApi
      ? ` Seules les ${pagesALire * PER_PAGE} premières entreprises ont été dépouillées : le décompte par secteur est partiel.`
      : '');

  return json({
    status: 'ok',
    summary,
    stats: {
      // total_dans_rayon = ÉTABLISSEMENTS actifs réellement retenus après filtre
      // de distance (l'ancienne valeur comptait des entreprises — correctif n°3).
      total_dans_rayon: actifs.length,
      analyses: actifs.length,
      affichage_tronque: troncatureApi,
      rayon_km: radiusKm,
      par_section: parSection,
      creations_recentes_12m: recent.length,
      entreprises_signalees_api: totalEntreprises,
      etablissements_fermes_ecartes: fermes,
    },
    items,
    avertissement:
      "SIRENE recense des établissements IMMATRICULÉS (RNE/Sirene), PAS des permis ni des projets futurs ; " +
      "le code NAF ne garantit pas l'usage réel sur place. Une grande enseigne ou une création récente est un " +
      "INDICE d'activité, pas une preuve de projet.",
    source: "SIRENE / RNE via API Recherche d'entreprises (DINUM)",
  }, 200);
});
