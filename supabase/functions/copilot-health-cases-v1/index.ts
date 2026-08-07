// supabase/functions/copilot-health-cases-v1/index.ts
// =============================================================================
// Mimmoza — contrôle de santé PAR CAS TÉMOINS
// -----------------------------------------------------------------------------
// copilot-fn-health répond à « le câblage est-il correct ? » (secret défini,
// slug non-404). Cette fonction répond à la question suivante, la seule qui
// compte vraiment : « les sources renvoient-elles encore la BONNE donnée ? »
//
// Raison d'être — journée du 04/08/2026, trois pannes SILENCIEUSES :
//   1. patrimoine-merimee-v1 interrogeait data.culture.gouv.fr, qui a migré et
//      répondait 200 OK avec du HTML. La fonction existait, répondait, et se
//      trompait. Câblage : vert. Donnée : absente depuis des semaines.
//   2. get_servitudes rendait la main en 0 ms faute de coordonnées, alors que
//      la résolution cadastrale existait ailleurs dans le code.
//   3. La résolution IDU → coordonnées cherchait le numéro de parcelle au
//      mauvais format et ne trouvait jamais rien.
// Aucune n'aurait été vue par un contrôle de câblage. Toutes seraient tombées
// ici, parce qu'on compare à un résultat CONNU.
//
// Principe : chaque cas est un couple (entrée figée, attentes vérifiables) sur
// un objet réel et stable — la cathédrale de Bayonne ne va pas déménager.
// Les attentes sont volontairement LARGES (bornes, pas égalités exactes) :
// un contrôle qui casse à chaque mise à jour du millésime ne serait pas relu.
//
// GET ou POST. Corps optionnel : { seulement?: string[] } pour ne jouer que
// certains cas (par leur id). HTTP 200 toujours — l'état est dans le corps.
// =============================================================================

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
const FN_AUTH = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');

const TIMEOUT_MS = 20000;

// ── Langage d'attente ────────────────────────────────────────────────────────
// chemin : notation pointée, [] pour « longueur du tableau ».
type Op = 'eq' | 'neq' | 'gte' | 'lte' | 'contient' | 'existe' | 'vrai';
interface Attente { chemin: string; op: Op; valeur?: unknown; pourquoi: string }

interface Cas {
  id: string;
  libelle: string;
  secret: string;          // secret portant le slug à appeler
  corps: Record<string, unknown>;
  attentes: Attente[];
}

// ── Cas témoins ──────────────────────────────────────────────────────────────
// Points de référence utilisés :
//   Bayonne, cathédrale Sainte-Marie  → 43.49275 / -1.47616  (parcelle 64102000BY0109)
//   Ascain, parcelle AI 0002          → 43.34843 / -1.62138
const CAS: Cas[] = [
  {
    id: 'merimee_bayonne',
    libelle: 'Monuments historiques — abords de la cathédrale de Bayonne',
    secret: 'COPILOT_FN_MERIMEE',
    corps: { lat: 43.49275, lon: -1.47616, radius_m: 500 },
    attentes: [
      { chemin: 'status', op: 'eq', valeur: 'ok', pourquoi: "Le cœur historique de Bayonne ne peut pas être vide de monuments : un autre statut signale une source cassée." },
      { chemin: 'stats.total', op: 'gte', valeur: 5, pourquoi: "14 monuments au 04/08/2026 ; sous 5, la requête géographique ne filtre plus correctement." },
      { chemin: 'stats.dans_perimetre_abf_500m', op: 'vrai', pourquoi: "Le plus proche est à 169 m : ce drapeau doit être vrai, sinon le calcul de distance est faux." },
    ],
  },
  {
    id: 'merimee_ascain',
    libelle: 'Monuments historiques — Ascain (densité faible)',
    secret: 'COPILOT_FN_MERIMEE',
    corps: { lat: 43.34843, lon: -1.62138, radius_m: 500 },
    attentes: [
      { chemin: 'status', op: 'eq', valeur: 'ok', pourquoi: "Le Pont Romain sur la Nivelle est à 209 m : la zone n'est pas vide." },
      { chemin: 'stats.total', op: 'lte', valeur: 20, pourquoi: "Contre-épreuve du cas Bayonne : un total explosif ici signalerait un filtre géographique inopérant." },
    ],
  },
  {
    id: 'gpu_zonage_ascain',
    libelle: 'Zonage PLU (GPU) — Ascain en zone UC',
    secret: 'COPILOT_FN_GPU',
    corps: { latitude: 43.34843, longitude: -1.62138, couches: ['municipality', 'zone-urba'] },
    attentes: [
      { chemin: 'status', op: 'neq', valeur: 'error', pourquoi: "API Carto GPU doit répondre." },
      { chemin: 'JSON', op: 'contient', valeur: 'UC', pourquoi: "Ascain est en zone UC au PLU du 04/02/2023 : l'absence de ce code signale un changement de contrat de sortie." },
    ],
  },
  {
    id: 'gpu_prescriptions_ascain',
    libelle: 'Prescriptions (GPU) — PPRI d\'Ascain',
    secret: 'COPILOT_FN_GPU',
    corps: { latitude: 43.34843, longitude: -1.62138, couches: ['prescription-surf', 'info-surf'] },
    attentes: [
      { chemin: 'JSON', op: 'contient', valeur: 'inondab', pourquoi: "La parcelle est couverte par l'indice I de zone inondable (renvoi PPRI du 06/02/2014)." },
    ],
  },
  {
    id: 'servitudes_bayonne',
    libelle: 'Servitudes (GPU) — SPR de Bayonne (AC4)',
    secret: 'COPILOT_FN_SERVITUDES',
    corps: { lat: 43.49275, lng: -1.47616 },
    attentes: [
      { chemin: 'JSON', op: 'contient', valeur: 'AC4', pourquoi: "La parcelle est dans le Site patrimonial remarquable : la servitude AC4 doit remonter." },
    ],
  },
  {
    id: 'appels_offres_64',
    libelle: 'Appels d\'offres (BOAMP) — avis ouverts dans le 64',
    secret: 'COPILOT_FN_APPELS_OFFRES',
    corps: { departements: ['64'], limite: 10 },
    attentes: [
      { chemin: 'status', op: 'eq', valeur: 'ok', pourquoi: "Il y a toujours des avis ouverts dans un département entier ; 'no_data' signale une clause where cassée." },
      { chemin: 'items[]', op: 'gte', valeur: 1, pourquoi: "Au moins un avis." },
      { chemin: 'items.0.lien_markdown', op: 'existe', pourquoi: "Le lien prêt à copier doit être présent (parade anti-recopie)." },
      { chemin: 'items.0.date_limite_reponse', op: 'existe', pourquoi: "Sans date limite, l'avis est inexploitable." },
    ],
  },
  {
    id: 'sitadel_ascain',
    libelle: 'Permis récents (Sitadel) — bassin d\'Ascain',
    secret: 'COPILOT_FN_SITADEL',
    // ⚠️ Contrat exact de promoteur-permis-construire : radiusKm / periodMonths
    //    (et non rayon_km / periode_mois). Se tromper ici produit une FAUSSE
    //    alerte — le premier piège d'un contrôle de santé mal écrit.
    corps: {
      latitude: 43.34843, longitude: -1.62138, radiusKm: 5, periodMonths: 60,
      typeAutorisation: 'all', typologie: 'all', commune: null,
      limit: 10, offset: 0, sortBy: 'date', sortOrder: 'desc',
    },
    attentes: [
      { chemin: 'items[]', op: 'gte', valeur: 1, pourquoi: "Le bassin de Saint-Jean-de-Luz / Ascain dépose des permis en continu : zéro signale un filtre cassé." },
      { chemin: 'items.0.dateDepot', op: 'existe', pourquoi: "Sans date de dépôt, l'antériorité d'un permis est inexploitable." },
      { chemin: 'items.0.distanceKm', op: 'existe', pourquoi: "La distance est ce qui rend le permis pertinent : son absence signale une perte de la géolocalisation." },
    ],
  },
  {
    id: 'dvf_bayonne',
    libelle: 'DVF — transactions autour de Bayonne',
    secret: 'COPILOT_FN_DVF',
    // ⚠️ dvf-comparables-v1 attend "lon" (pas "lng") et "radius_km" (pas "rayon_m").
    corps: { lat: 43.49275, lon: -1.47616, radius_km: 1, horizon_months: 36 },
    attentes: [
      { chemin: 'status', op: 'eq', valeur: 'ok', pourquoi: "Un centre-ville de 50 000 habitants a forcément des transactions." },
      { chemin: 'stats.transactions_count', op: 'gte', valeur: 50, pourquoi: "1 010 transactions au 04/08/2026 dans 1 km sur 36 mois ; sous 50, le filtre géographique a dérivé." },
      { chemin: 'stats.price_median_eur_m2', op: 'gte', valeur: 1000, pourquoi: "Un prix médian sous 1 000 €/m² à Bayonne centre serait une erreur d'unité ou de calcul." },
      { chemin: 'stats.price_median_eur_m2', op: 'lte', valeur: 15000, pourquoi: "Borne haute : au-delà, la médiane a été confondue avec une moyenne polluée par des valeurs aberrantes." },
    ],
  },
];

// ── Évaluation ───────────────────────────────────────────────────────────────
function lire(obj: unknown, chemin: string): unknown {
  if (chemin === 'JSON') return obj;
  let cur: unknown = obj;
  for (const seg of chemin.split('.')) {
    if (cur == null) return undefined;
    if (seg.endsWith('[]')) {
      const k = seg.slice(0, -2);
      const t = (cur as Record<string, unknown>)[k];
      return Array.isArray(t) ? t.length : undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function evalue(reponse: unknown, a: Attente): { ok: boolean; obtenu: string } {
  const v = lire(reponse, a.chemin);
  const brut = a.chemin === 'JSON' ? '' : JSON.stringify(v) ?? 'undefined';
  switch (a.op) {
    case 'existe': return { ok: v != null && v !== '', obtenu: brut };
    case 'vrai':   return { ok: v === true, obtenu: brut };
    case 'eq':     return { ok: v === a.valeur, obtenu: brut };
    case 'neq':    return { ok: v !== a.valeur, obtenu: brut };
    case 'gte':    return { ok: typeof v === 'number' && v >= (a.valeur as number), obtenu: brut };
    case 'lte':    return { ok: typeof v === 'number' && v <= (a.valeur as number), obtenu: brut };
    case 'contient': {
      const hay = (a.chemin === 'JSON' ? JSON.stringify(reponse) : String(v ?? '')).toLowerCase();
      const ok = hay.includes(String(a.valeur).toLowerCase());
      return { ok, obtenu: ok ? 'trouvé' : 'absent' };
    }
  }
}

async function joue(c: Cas): Promise<Record<string, unknown>> {
  const slug = env(c.secret);
  if (!slug) {
    return { id: c.id, libelle: c.libelle, etat: 'non_cable', secret: c.secret,
             diagnostic: `Secret ${c.secret} absent — cas non joué (le câblage se contrôle avec copilot-fn-health).` };
  }

  const t0 = Date.now();
  let corpsTexte = '';
  let httpCode: number | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FN_AUTH}`, apikey: FN_AUTH },
      body: JSON.stringify(c.corps),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    httpCode = r.status;
    corpsTexte = await r.text();
  } catch (e) {
    return { id: c.id, libelle: c.libelle, slug, etat: 'injoignable', duree_ms: Date.now() - t0,
             diagnostic: `Appel impossible : ${e instanceof Error ? e.message : String(e)}` };
  }

  // Le piège Mérimée : 200 OK, mais du HTML. On le nomme explicitement.
  let reponse: unknown;
  try {
    reponse = JSON.parse(corpsTexte);
  } catch {
    return { id: c.id, libelle: c.libelle, slug, etat: 'reponse_non_json', http: httpCode,
             duree_ms: Date.now() - t0, extrait: corpsTexte.slice(0, 160),
             diagnostic: "La fonction a répondu autre chose que du JSON (page HTML ?). C'est la signature d'une source amont qui a changé d'adresse — cf. la migration data.culture.gouv.fr." };
  }

  const details = c.attentes.map((a) => {
    const { ok, obtenu } = evalue(reponse, a);
    return { attendu: `${a.chemin} ${a.op} ${a.valeur ?? ''}`.trim(), obtenu, ok, pourquoi: a.pourquoi };
  });
  const echecs = details.filter((d) => !d.ok);

  return {
    id: c.id, libelle: c.libelle, slug, http: httpCode, duree_ms: Date.now() - t0,
    etat: echecs.length ? 'echec' : 'ok',
    verifications: details.length,
    echecs: echecs.length,
    details: echecs.length ? details : undefined,   // on ne détaille que ce qui casse
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  let seulement: string[] | null = null;
  if (req.method === 'POST') {
    try {
      const b = await req.json();
      if (Array.isArray(b?.seulement)) seulement = b.seulement.map(String);
    } catch { /* corps vide accepté */ }
  }

  const t0 = Date.now();
  const aJouer = seulement ? CAS.filter((c) => seulement!.includes(c.id)) : CAS;
  const lignes = await Promise.all(aJouer.map(joue));

  const ok = lignes.filter((l) => l.etat === 'ok');
  const ko = lignes.filter((l) => l.etat === 'echec' || l.etat === 'reponse_non_json' || l.etat === 'injoignable');
  const nonCables = lignes.filter((l) => l.etat === 'non_cable');

  const summary =
    `${ok.length}/${aJouer.length} cas témoins conformes.` +
    (ko.length ? ` ⚠️ ${ko.length} EN ÉCHEC : ${ko.map((l) => l.id).join(', ')} — une source répond mais renvoie une donnée fausse ou absente.` : '') +
    (nonCables.length ? ` ${nonCables.length} non joué(s) faute de secret : ${nonCables.map((l) => l.secret).join(', ')}.` : '') +
    (!ko.length && !nonCables.length ? ' Aucune anomalie.' : '');

  return new Response(JSON.stringify({
    status: ko.length ? 'error' : nonCables.length ? 'partial' : 'ok',
    summary,
    stats: { total: aJouer.length, conformes: ok.length, echecs: ko.length, non_cables: nonCables.length, duree_ms: Date.now() - t0 },
    items: lignes,
  }, null, 2), { status: 200, headers: CORS });
});