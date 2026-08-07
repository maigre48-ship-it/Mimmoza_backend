// supabase/functions/etude-parcelle-v1/index.ts
// =============================================================
// Mimmoza — ÉTUDE COMPLÈTE DE PARCELLE (rapport de synthèse)
//
// v4 — FIABILITÉ DE LA DONNÉE (phase 1). La v3 produisait des faits justes
//      mais INDIFFÉRENCIÉS : rien ne distinguait une mesure à la parcelle
//      d'une moyenne communale, ni un fait confirmé d'une estimation. Sept
//      erreurs d'interprétation en découlaient (donnée communale lue comme
//      parcellaire, monument voisin lu comme servitude grevante, zone
//      inondable annoncée avec « pas de PPRI », score de sécurité élevé
//      masquant un aléa bloquant, service communal lu comme raccordement,
//      comparables DVF hétérogènes, conclusion affirmative sur données
//      trouées). La v4 ajoute QUATRE couches, toutes déterministes :
//        1. QUALIFICATION  — chaque donnée significative est enveloppée dans
//           un DataEvidence { value, status, scope, source, sourceDate,
//           confidence, warning }. La portée n'est jamais déduite du texte :
//           elle est déclarée par source et bornée par la précision de
//           localisation.
//        2. COHÉRENCE      — six règles croisent les sources et marquent les
//           données en conflit `contradictory`. Aucune version n'est
//           arbitrée : l'étude affiche le conflit et exige le document
//           opposable.
//        3. VERDICT        — trois indicateurs SÉPARÉS (potentiel, risque,
//           fiabilité) + recommandation, calculés ICI et jamais par le LLM.
//           Pas de score global unique : un potentiel favorable ne compense
//           jamais un risque bloquant.
//        4. PLAN D'ACTION  — actions de vérification déduites des manques et
//           contradictions RÉELLEMENT constatés dans cette étude. Aucune
//           action générique.
//      + tableau de traçabilité des sources, généré depuis les réponses.
//      + correcteur des artefacts de langue produits en amont
//        (« orientation sudienne » → « orientation sud »).
//
// v3 — MARCHÉ ET NUISANCES. Trois évolutions par rapport à v2 :
//   1. DVF (dvf-comparables-v1) — le prix de sortie manquait, or c'est la
//      donnée qui rend un bilan chiffrable. Contrat standard MAIS transactions
//      dans un champ `comps` séparé → adaptateur dédié qui les replie dans
//      stats (échantillon borné à 8).
//   2. BRUIT (bruit-classement-v1) — classement sonore réglementaire des
//      voies. Source PARTIELLE assumée : dégrade proprement en no_data sur les
//      communes n'ayant pas numérisé la couche au GPU.
//   3. GARDE DE PRÉCISION — les sources `needs: 'geo'` exigent désormais
//      precision === 'parcelle'. Avant, un repli centroïde commune renseignait
//      lat/lon et les servitudes du centre-bourg étaient présentées comme
//      parcellaires : faux positif dangereux.
//
// v2 — DENSITÉ : surface cadastrale (contenance), risques Géorisques nommés,
// timeout par source.
//
// Rôle : à partir d'UN SEUL identifiant (IDU cadastral, coordonnées ou
// commune), interroger EN PARALLÈLE toutes les sources Mimmoza déployées et
// renvoyer un bundle structuré, QUALIFIÉ et ARBITRÉ, prêt à être rédigé par
// le LLM.
//
// POURQUOI UNE FONCTION PLUTÔT QU'UNE BOUCLE D'OUTILS :
//   · 1 appel LLM au lieu de 8 → ~2 s au lieu de ~30 s, coût jetons divisé ;
//   · MAX_TOOL_ITERATIONS.quick = 2 rend l'enchaînement impossible en mode
//     quick (le mode de la majorité des comptes) ;
//   · déterministe → testable dans le harnais de non-régression.
//
// AUTONOME (édité dans le Dashboard, aucun import _shared) :
//   · résout le code INSEE depuis l'IDU (5 premiers caractères) ;
//   · résout le CENTROÏDE + la CONTENANCE via le cadastre API Carto
//     (⚠️ numero PADDÉ sur 4 caractères, sinon apicarto renvoie HTTP 400) ;
//   · repli centroïde commune (geo.api) → précision dégradée SIGNALÉE.
//
// HORS PORTÉE (limite structurelle, ne pas tenter de l'ajouter ici) :
//   · le PLU est extrait par le parser côté FRONT et vit dans ctx.plu du
//     contexte copilot. Une Edge Function n'y a aucun accès. L'étude signale
//     son absence, copilot-chat le traite via get_parcel_plu.
//     → CONSÉQUENCE DIRECTE : verdict.constructibilite vaut TOUJOURS
//       'indeterminable'. Aucune capacité constructive n'est calculable sans
//       règlement opposable.
//   · aucune source n'est branchée pour : eau potable, électricité, gaz,
//     fibre, défense incendie, eaux pluviales, remontée de nappe,
//     ruissellement, géométrie fine (forme / largeur sur voie / profondeur),
//     accès et voirie, enclavement, emplacements réservés, espaces boisés
//     classés, droit de préemption, BASOL/CASIAS. Ces sujets ne produisent
//     AUCUNE section ici : ils n'apparaissent que comme action de
//     vérification (« consulter les concessionnaires ») quand c'est justifié.
//
// DÉGRADATION : chaque source est indépendante (Promise.allSettled). Une
// source morte n'empêche jamais le rapport ; elle apparaît en 'ko' avec son
// motif. Aucune valeur n'est inventée. L'absence de donnée n'est JAMAIS
// convertie en absence de contrainte.
//
// ⚠️ BUDGET TEMPS : risques ~20 s et DVF ~18 s s'exécutent en parallèle, donc
// l'étude reste bornée par la plus lente (~20 s). Les couches v4 sont du
// calcul local en mémoire (aucun appel réseau, aucune I/O) : coût mesuré < 5 ms,
// l'enveloppe reste ~20 s. C'est proche du INTERNAL_FN_TIMEOUT_MS de
// copilot-chat (25 s par défaut) : passer le secret COPILOT_FN_TIMEOUT_MS
// à 30000.
//
// Contrat : { status, summary, stats, items } — toujours HTTP 200.
// COMPATIBILITÉ ASCENDANTE : tous les champs v3 de stats et items sont
// conservés à l'identique. La v4 n'AJOUTE que des champs.
// =============================================================

const CADASTRE_URL = 'https://apicarto.ign.fr/api/cadastre/parcelle';
const GEO_API = 'https://geo.api.gouv.fr/communes';

const DEFAULT_TIMEOUT_MS = 14000;

interface Resolved {
  idu?: string;
  insee?: string;
  commune?: string;
  lat?: number;
  lon?: number;
  surface_m2?: number;
  precision: 'parcelle' | 'centre_commune' | 'aucune';
}

// Les `stats` des fonctions sources n'ont AUCUN schéma commun et leur code ne
// vit pas dans ce dépôt (déploiement Dashboard) : aux points d'entrée, on
// manipule donc structurellement du non typé. On le nomme plutôt que de le
// disséminer, pour que la frontière « donnée externe non validée » soit
// visible — et pour que la lecture typée passe TOUJOURS par pluck(), qui
// renvoie undefined plutôt qu'une valeur inventée quand la clé est absente.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Brut = any;

/** Réponse normalisée d'une source, quel que soit son contrat d'origine. */
interface Adapted {
  status: 'ok' | 'no_data' | 'ko';
  summary: string | null;
  stats: unknown;
  motif?: string;
}

// =============================================================
// PHASE 1 — MODÈLE DE QUALIFICATION
// =============================================================

/**
 * Portée géographique de la donnée. C'est la question « à quoi cette valeur
 * s'applique-t-elle ? », jamais « d'où vient-elle ? ».
 *   parcel            — mesurée / démontrée au droit de la parcelle
 *   nearby            — dans un voisinage (rayon de comparables, périmètre)
 *   municipality      — vaut pour toute la commune (moyenne, taux, zonage)
 *   intermunicipality — EPCI
 *   department        — département
 *   national          — barème ou référence nationale
 */
type DataScope =
  | 'parcel' | 'nearby' | 'municipality'
  | 'intermunicipality' | 'department' | 'national';

/**
 * État épistémique de la donnée.
 *   confirmed      — la source la fournit explicitement, sans conflit
 *   estimated      — dérivée, extrapolée, ou mesurée à une portée dégradée
 *   unavailable    — la source n'a rien fourni (≠ « pas de contrainte »)
 *   contradictory  — au moins deux signaux incompatibles ; NON arbitré ici
 *   not_applicable — la question ne se pose pas dans ce contexte
 */
type DataStatus =
  | 'confirmed' | 'estimated' | 'unavailable'
  | 'contradictory' | 'not_applicable';

interface DataEvidence<T = unknown> {
  /** Identifiant stable, utilisable par MimmozIA pour référencer la donnée. */
  id: string;
  /** Libellé humain, en français, prêt à l'affichage. */
  label: string;
  value: T | null;
  /** Unité de `value` quand elle est numérique (m², %, €/m²…). */
  unit?: string;
  status: DataStatus;
  scope: DataScope;
  /** Organisme + jeu de données. */
  source: string;
  /** Millésime ou date de la donnée, tel que la source le déclare. */
  sourceDate?: string;
  /** 0-100 — formule documentée dans computeConfidence(). */
  confidence: number;
  /** Condition d'usage ou réserve. Affichable tel quel. */
  warning?: string;
}

// ── Formule de confiance (documentée, déterministe) ──────────
// confidence = socle(status) + bonus_millésime − malus_portée − malus_réserve
//
//   socle(status)      confirmed 85 · estimated 50 · contradictory 20
//                      unavailable 0 · not_applicable 0
//   bonus_millésime    +10 si millésime ≤ 3 ans · +5 si ≤ 6 ans
//                      0 si plus ancien ou inconnu
//   malus_portée       parcel 0 · nearby 10 · municipality 15
//                      intermunicipality 20 · department 25 · national 30
//                      (une donnée juste mais large est moins actionnable au
//                       droit de la parcelle — c'est un malus d'ACTIONNABILITÉ,
//                       pas un doute sur la véracité de la source)
//   malus_réserve      10 si un `warning` est attaché
//
// Bornée 0..100. Une donnée `unavailable` ou `not_applicable` vaut toujours 0 :
// elle ne doit jamais peser dans un raisonnement.
const SOCLE_STATUS: Record<DataStatus, number> = {
  confirmed: 85, estimated: 50, contradictory: 20, unavailable: 0, not_applicable: 0,
};
const MALUS_PORTEE: Record<DataScope, number> = {
  parcel: 0, nearby: 10, municipality: 15, intermunicipality: 20, department: 25, national: 30,
};

function anneeDe(sourceDate?: string): number | null {
  if (!sourceDate) return null;
  const m = /(?:19|20)\d{2}/.exec(String(sourceDate));
  return m ? Number(m[0]) : null;
}

function computeConfidence(
  status: DataStatus, scope: DataScope, sourceDate: string | undefined, hasWarning: boolean,
): number {
  if (status === 'unavailable' || status === 'not_applicable') return 0;
  const annee = anneeDe(sourceDate);
  const age = annee != null ? new Date().getFullYear() - annee : null;
  const bonus = age == null ? 0 : age <= 3 ? 10 : age <= 6 ? 5 : 0;
  const v = SOCLE_STATUS[status] + bonus - MALUS_PORTEE[scope] - (hasWarning ? 10 : 0);
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** Fabrique un DataEvidence en calculant sa confiance. Point d'entrée unique. */
function evidence<T>(e: Omit<DataEvidence<T>, 'confidence'>): DataEvidence<T> {
  return { ...e, confidence: computeConfidence(e.status, e.scope, e.sourceDate, Boolean(e.warning)) };
}

/** Contradiction détectée entre deux signaux. Jamais arbitrée, toujours exposée. */
interface Contradiction {
  id: string;
  gravite: 'bloquante' | 'importante';
  /** Message prêt à l'affichage, préfixé de la formule imposée. */
  message: string;
  /** ids des DataEvidence concernés. */
  donnees: string[];
  /** Document opposable qui tranche le conflit. */
  verification: string;
  organisme: string;
}

/** Action de vérification. Toujours déduite d'un manque ou d'un conflit réel. */
interface ActionVerification {
  priorite: 'bloquante' | 'importante' | 'recommandee';
  action: string;
  /** Le fait constaté DANS CETTE ÉTUDE qui déclenche l'action. */
  motif: string;
  organisme: string;
  document: string;
}

// ── Adaptateur risk-study ────────────────────────────────────
// risk-study ne suit pas le contrat { status, summary, stats } : il renvoie
// { meta, scores, data, categories, insights }. ⚠️ Ses scores sont des scores
// de SÉCURITÉ (100 = sûr). On produit ici un résumé en aléas NOMMÉS, seule
// façon de sortir du « aléa inconnu » qui rendait le verdict flou.
function adaptRisques(j: Brut): Adapted {
  if (!j || typeof j !== 'object' || j.success === false) {
    return { status: 'ko', summary: null, stats: null, motif: j?.error ?? 'réponse risk-study vide ou en erreur' };
  }
  const d = j.data ?? {};
  const s = j.scores ?? {};
  const faits: string[] = [];

  if (d.inondation?.zone_inondable === true) faits.push(d.inondation?.ppri ? 'zone inondable avec PPRI' : 'zone inondable');
  if (d.argiles?.niveau_alea) faits.push(`retrait-gonflement des argiles : aléa ${d.argiles.niveau_alea}`);
  if (d.seisme?.zone) faits.push(`sismicité zone ${d.seisme.zone}${d.seisme.libelle ? ` (${d.seisme.libelle})` : ''}`);
  if (d.radon?.classe_potentiel) faits.push(`radon classe ${d.radon.classe_potentiel}`);
  if (d.cavites?.count) faits.push(`${d.cavites.count} cavité(s) souterraine(s) recensée(s)`);
  if (d.mouvements_terrain?.count) faits.push(`${d.mouvements_terrain.count} mouvement(s) de terrain recensé(s)`);
  if (d.icpe?.seveso_haut_count) faits.push(`${d.icpe.seveso_haut_count} site(s) SEVESO seuil haut`);
  else if (d.icpe?.count) faits.push(`${d.icpe.count} ICPE`);
  if (d.sis?.count) faits.push(`${d.sis.count} site(s) pollué(s) (SIS)`);
  if (d.feux_foret?.zone_risque === true) faits.push(`zone à risque feux de forêt${d.feux_foret?.obligation_debroussaillement ? ' (débroussaillement obligatoire)' : ''}`);
  if (d.gaspar?.catnat_count) faits.push(`${d.gaspar.catnat_count} arrêté(s) de catastrophe naturelle`);

  // risk-study v1.1.0 — « aucun fait saillant » peut vouloir dire deux choses
  // opposées : la commune est épargnée, ou les sources n'ont pas répondu. Sans
  // ce garde-fou, une réponse entièrement muette produisait « Aucun aléa majeur
  // remonté par Géorisques », phrase rassurante envoyée telle quelle au LLM.
  const scoreLabel = s.global == null ? 'non mesuré' : `${s.global}/100 (100 = zone sûre)`;
  const mesures = typeof s.criteres_mesures === 'number' ? s.criteres_mesures : null;
  const rienMesure = s.global == null || mesures === 0;
  const confiance = typeof s.criteres_total === 'number' && mesures !== null && mesures < s.criteres_total
    ? ` Note établie sur ${mesures} critère(s) sur ${s.criteres_total} : à interpréter avec prudence.`
    : '';

  const summary = rienMesure
    ? `Aucun critère de risque n'a pu être mesuré (sources Géorisques indisponibles). Score de sécurité global : non mesuré. Ne pas en conclure que la parcelle est sans risque — l'analyse est à relancer.`
    : faits.length
      ? `Risques identifiés : ${faits.join(' · ')}. Score de sécurité global ${scoreLabel}.${confiance}`
      : `Aucun aléa majeur remonté par Géorisques sur les critères effectivement mesurés. Score de sécurité global ${scoreLabel}.${confiance}`;

  return {
    status: 'ok',
    summary,
    stats: {
      convention_score: 'Scores de SÉCURITÉ : 100 = zone très sûre, 0 = risque maximal. Un score élevé est BON.',
      scores_securite: {
        global: s.global ?? null, naturels: s.naturels ?? null,
        technologiques: s.technologiques ?? null, pollution: s.pollution ?? null,
        geotechniques: s.geotechniques ?? null,
      },
      inondation: { zone_inondable: d.inondation?.zone_inondable ?? null, ppri: d.inondation?.ppri ?? null },
      argiles_alea: d.argiles?.niveau_alea ?? null,
      seisme_zone: d.seisme?.zone ?? null,
      radon_classe: d.radon?.classe_potentiel ?? null,
      cavites_count: d.cavites?.count ?? null,
      mouvements_terrain_count: d.mouvements_terrain?.count ?? null,
      icpe_count: d.icpe?.count ?? null,
      seveso_haut_count: d.icpe?.seveso_haut_count ?? null,
      sis_count: d.sis?.count ?? null,
      feux_foret: d.feux_foret?.zone_risque ?? null,
      catnat_count: d.gaspar?.catnat_count ?? null,
      ppr_count: d.gaspar?.ppr_count ?? null,
      constats: Array.isArray(j.insights) ? j.insights.slice(0, 8).map((i: Brut) => i?.message).filter(Boolean) : [],
      source: 'Géorisques via risk-study',
    },
  };
}

// ── Adaptateur DVF ───────────────────────────────────────────
// dvf-comparables-v1 suit le contrat standard MAIS sort les transactions dans
// un champ `comps` séparé, que le handler générique jetterait. On les replie
// dans stats (échantillon borné) : le prix de sortie est la donnée qui rend un
// bilan chiffrable. `no_localization` reste traité en 'ko' par le générique.
function adaptDvf(j: Brut): Adapted {
  if (!j || typeof j !== 'object') {
    return { status: 'ko', summary: null, stats: null, motif: 'réponse DVF illisible' };
  }
  const st = String(j.status ?? '');
  if (st !== 'ok' && st !== 'no_data') {
    return { status: 'ko', summary: null, stats: null, motif: j?.summary ?? st ?? 'statut inconnu' };
  }
  const comps = Array.isArray(j.comps) ? j.comps : [];
  const vide = st === 'no_data' || comps.length === 0;
  return {
    status: vide ? 'no_data' : 'ok',
    summary: typeof j.summary === 'string' ? j.summary : null,
    stats: {
      ...(j.stats ?? {}),
      nb_comparables: comps.length,
      echantillon: comps.slice(0, 8).map((c: Brut) => ({
        date: c?.date ?? null, prix_m2: c?.price_m2 ?? null,
        surface_m2: c?.surface_m2 ?? null, type_local: c?.type_local ?? null,
        distance_m: c?.distance_m ?? null,
      })),
      source: 'DVF (DGFiP) via dvf-comparables-v1',
    },
  };
}

// ── Sources mobilisées ───────────────────────────────────────
// `needs` : 'commune' = code INSEE suffit ; 'geo' = exige une localisation
//           RÉELLEMENT parcellaire (precision === 'parcelle').
// `adapt` : seulement pour les sources au contrat non standard.
// `scope` : portée géographique NON NÉGOCIABLE de la donnée produite. C'est
//           une propriété de la SOURCE, jamais une déduction faite sur son
//           texte. Les règles imposées :
//             · assainissement, loyers, taxes, zonage ABC → municipality
//               (jamais parcel, quelle que soit la précision de localisation)
//             · servitudes, classement sonore → nearby par défaut ; parcel
//               UNIQUEMENT si une intersection est démontrée (promotion faite
//               dans qualifier(), pas ici)
//             · altimétrie / pente / solaire → parcel si precision ===
//               'parcelle', sinon municipality + status 'estimated'
//             · risques Géorisques → municipality par défaut ; parcel
//               uniquement si la source le qualifie explicitement
//             · DVF → nearby : ce sont des comparables dans un rayon, pas une
//               moyenne communale et pas une valeur de la parcelle
// Ajouter une source = UNE entrée ici.
interface SourceDef {
  cle: string;
  env: string;                  // secret portant le slug de la fonction
  needs: 'commune' | 'geo';
  label: string;
  timeout?: number;
  body: (r: Resolved) => Record<string, unknown>;
  adapt?: (j: Brut) => Adapted;
  // ── v4 : métadonnées de qualification et de traçabilité ──
  organisme: string;
  dataset: string;
  scope: (r: Resolved) => DataScope;
}

const SOURCES: SourceDef[] = [
  { cle: 'loyers', env: 'COPILOT_FN_LOYERS', needs: 'commune', label: 'Loyers de référence',
    organisme: 'ministère du Logement / ANIL', dataset: 'Carte des loyers (indicateurs communaux)',
    scope: () => 'municipality',
    body: (r) => ({ code_insee: r.insee }) },
  { cle: 'zonage', env: 'COPILOT_FN_ZONAGE', needs: 'commune', label: 'Zonage ABC',
    organisme: 'ministère du Logement', dataset: 'Zonage A/B/C (tension locative)',
    scope: () => 'municipality',
    body: (r) => ({ code_insee: r.insee }) },
  { cle: 'taxes', env: 'COPILOT_FN_TAXES', needs: 'commune', label: 'Fiscalité locale',
    organisme: 'DGFiP', dataset: "Taux d'imposition des collectivités locales",
    scope: () => 'municipality',
    body: (r) => ({ code_insee: r.insee }) },
  { cle: 'assainissement', env: 'COPILOT_FN_ASSAINISSEMENT', needs: 'commune', label: 'Assainissement',
    organisme: 'ministère de la Santé / SISPEA', dataset: "Services d'assainissement communaux",
    scope: () => 'municipality',
    body: (r) => ({ code_insee: r.insee }) },
  { cle: 'altimetrie', env: 'COPILOT_FN_ALTIMETRIE', needs: 'commune', label: 'Altitude et pente',
    organisme: 'IGN', dataset: 'RGE ALTI (modèle numérique de terrain)',
    scope: (r) => (r.precision === 'parcelle' ? 'parcel' : 'municipality'),
    body: (r) => ({ lat: r.lat, lon: r.lon, cadastral_ref: r.idu, code_insee: r.insee }) },
  { cle: 'servitudes', env: 'COPILOT_FN_SERVITUDES', needs: 'geo', label: "Servitudes d'utilité publique",
    organisme: "Géoportail de l'urbanisme (GPU)", dataset: "Servitudes d'utilité publique",
    scope: () => 'nearby',   // promu 'parcel' seulement si intersection démontrée
    body: (r) => ({ lat: r.lat, lon: r.lon, cadastral_ref: r.idu }) },
  { cle: 'solaire', env: 'COPILOT_FN_SOLAIRE', needs: 'commune', label: 'Potentiel solaire',
    organisme: 'Commission européenne / JRC', dataset: 'PVGIS (irradiation solaire)',
    scope: (r) => (r.precision === 'parcelle' ? 'parcel' : 'municipality'),
    body: (r) => ({ lat: r.lat, lon: r.lon, code_insee: r.insee }) },
  { cle: 'contexte', env: 'COPILOT_FN_CONTEXTE', needs: 'commune', label: 'Contexte territorial (Wikipédia)',
    organisme: 'Wikipédia', dataset: 'Article de commune',
    scope: () => 'municipality',
    body: (r) => ({ code_insee: r.insee, commune: r.commune }) },
  // ── Risques : contrat non standard → adaptateur. Plus lent (multi-API).
  { cle: 'risques', env: 'COPILOT_FN_RISKS', needs: 'commune', label: 'Risques naturels et technologiques',
    organisme: 'BRGM / Géorisques', dataset: 'Géorisques (GASPAR, aléas, ICPE, SIS)',
    scope: () => 'municipality',   // la source ne qualifie pas ses aléas à la parcelle
    timeout: 20000, adapt: adaptRisques,
    body: (r) => ({ lat: r.lat, lon: r.lon, commune_insee: r.insee }) },
  // ── DVF : prix de sortie. Contrat standard + champ comps → adaptateur.
  { cle: 'dvf', env: 'COPILOT_FN_DVF', needs: 'commune', label: 'Transactions comparables (DVF)',
    organisme: 'DGFiP', dataset: 'Demandes de valeurs foncières (DVF)',
    scope: () => 'nearby',   // comparables dans un rayon de 2 km
    timeout: 18000, adapt: adaptDvf,
    body: (r) => ({ lat: r.lat, lon: r.lon, commune_insee: r.insee, radius_km: 2, horizon_months: 24 }) },
  // ── Bruit : classement sonore réglementaire. Donnée strictement parcellaire
  //    (GPU) → needs 'geo'. Source partielle assumée : dégrade en no_data sur
  //    les communes n'ayant pas numérisé la couche.
  { cle: 'bruit', env: 'COPILOT_FN_BRUIT', needs: 'geo', label: 'Classement sonore des voies',
    organisme: "Préfecture / Géoportail de l'urbanisme", dataset: 'Classement sonore des infrastructures de transport',
    scope: () => 'nearby',   // promu 'parcel' seulement si intersection démontrée
    body: (r) => ({ lat: r.lat, lon: r.lon, cadastral_ref: r.idu }) },
  // ── Non intégrables ici : PLU (lu par le FRONT dans ctx.plu, hors de portée
  //    d'une Edge Function → traité par copilot-chat) ; PPR détaillé (dormant,
  //    exige un jeton Géorisques gratuit non créé).
];

// ── Helpers ──────────────────────────────────────────────────
function cors(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...cors(), 'Content-Type': 'application/json; charset=utf-8' } });
}
function normStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
function readFirstJsonKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const first = Object.values(parsed).find((v) => typeof v === 'string');
      if (typeof first === 'string') return first;
    }
  } catch { return raw; }
  return null;
}
function serviceKey(): string {
  // ⚠️ JWT Signing Keys : SUPABASE_SECRET_KEYS en priorité (la legacy → 401).
  const k = readFirstJsonKey(Deno.env.get('SUPABASE_SECRET_KEYS'))
    ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SERVICE_ROLE_KEY');
  if (!k) throw new Error('Missing Supabase service role key env');
  return k;
}

// ── Correcteur d'artefacts de langue ─────────────────────────
// Certaines fonctions sources fabriquent leurs phrases par concaténation et
// produisent des adjectifs inexistants (« orientation sudienne »). Le correctif
// de fond appartient à la fonction émettrice ; en attendant, on nettoie ici
// pour ne pas faire lire une faute au LLM, qui la reproduirait à l'utilisateur.
// N'AGIT QUE SUR LE TEXTE : aucune valeur numérique n'est touchée.
// Les formes composées viennent AVANT les simples (« sud-ouestienne » contient
// « ouestienne »).
const CORRECTIONS_TEXTE: Array<[RegExp, string]> = [
  [/\bsud[-\s]?ouestiennes?\b/gi, 'sud-ouest'],
  [/\bsud[-\s]?estiennes?\b/gi, 'sud-est'],
  [/\bnord[-\s]?ouestiennes?\b/gi, 'nord-ouest'],
  [/\bnord[-\s]?estiennes?\b/gi, 'nord-est'],
  [/\bsudiennes?\b/gi, 'sud'],
  [/\bnordiennes?\b/gi, 'nord'],
  [/\bestiennes?\b/gi, 'est'],
  [/\bouestiennes?\b/gi, 'ouest'],
  [/\bnulle?\s+m²/gi, '0 m²'],
  [/\bnull\b\s*(€|%|m²|m2)/gi, 'valeur non disponible'],
];

let CORRECTIONS_APPLIQUEES = 0;

function assainirTexte(t: string | null): string | null {
  if (typeof t !== 'string' || !t) return t;
  let out = t;
  for (const [re, rep] of CORRECTIONS_TEXTE) {
    if (re.test(out)) { CORRECTIONS_APPLIQUEES++; out = out.replace(re, rep); }
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}

// ── Extraction tolérante de champs ───────────────────────────
// Les fonctions sources ne partagent pas un schéma de `stats` commun et leur
// code n'est pas dans ce dépôt. On cherche donc une valeur par NOMS DE CLÉS
// CANDIDATS, en parcours borné en largeur.
// RÈGLE ABSOLUE : si aucune clé ne correspond, on renvoie undefined et la
// donnée passe en `unavailable`. On n'invente JAMAIS de valeur de repli, et
// l'absence d'extraction ne change jamais le statut de la SOURCE (qui reste
// visible telle quelle dans items[]).
function pluck(root: unknown, names: string[], maxDepth = 4): unknown {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const file: Array<{ v: unknown; d: number }> = [{ v: root, d: 0 }];
  let garde = 0;
  while (file.length && garde++ < 400) {
    const cur = file.shift();
    if (!cur) break;
    const { v, d } = cur;
    if (!v || typeof v !== 'object' || d > maxDepth) continue;
    const o = v as Record<string, unknown>;
    // Largeur d'abord : une clé du niveau courant prime sur une clé profonde.
    for (const k of Object.keys(o)) {
      if (wanted.has(k.toLowerCase())) {
        const val = o[k];
        if (val !== null && val !== undefined && val !== '') return val;
      }
    }
    for (const k of Object.keys(o)) {
      const val = o[k];
      if (val && typeof val === 'object') file.push({ v: val, d: d + 1 });
    }
  }
  return undefined;
}
const pluckNum = (root: unknown, names: string[]): number | undefined => num(pluck(root, names));
const pluckStr = (root: unknown, names: string[]): string | undefined => normStr(pluck(root, names));
function pluckBool(root: unknown, names: string[]): boolean | undefined {
  const v = pluck(root, names);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') {
    if (/^(true|oui|yes|1)$/i.test(v)) return true;
    if (/^(false|non|no|0)$/i.test(v)) return false;
  }
  return undefined;
}

/** Millésime déclaré par la source, quel que soit le nom du champ. */
function pluckMillesime(root: unknown): string | undefined {
  const v = pluck(root, [
    'millesime', 'millesime_data', 'annee', 'annee_reference', 'year',
    'date_maj', 'derniere_maj', 'last_update', 'source_date', 'date_source',
    'vintage', 'exercice', 'annee_donnees',
  ]);
  if (v == null) return undefined;
  const s = String(v).trim();
  return s && s !== 'null' ? s : undefined;
}

// ── Statistiques robustes (échantillon DVF) ──────────────────
function mediane(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Qualité de l'échantillon DVF : hétérogénéité de catégories et valeurs
 * extrêmes. Deux défauts classiques rendent une médiane brute trompeuse —
 * mélanger maisons, appartements et terrains, et laisser une mutation aberrante
 * tirer la moyenne. On mesure, on écarte selon Tukey (1,5 × écart
 * interquartile), et on expose les deux versions. On ne masque rien.
 * ⚠️ L'échantillon est BORNÉ à 8 par adaptDvf : la médiane robuste calculée ici
 * porte sur cet échantillon, pas sur la population complète des mutations.
 */
function qualiteDvf(stats: unknown): {
  nb_comparables: number | null;
  taille_echantillon: number;
  categories: string[];
  echantillon_heterogene: boolean;
  extremes_ecartes: number;
  prix_m2_median_echantillon: number | null;
  prix_m2_median_robuste: number | null;
  dispersion_pct: number | null;
  reserves: string[];
} {
  const s = (stats ?? {}) as Record<string, unknown>;
  const ech = Array.isArray(s.echantillon) ? (s.echantillon as Array<Record<string, unknown>>) : [];
  const prix = ech.map((c) => num(c.prix_m2)).filter((n): n is number => n != null && n > 0);
  const cats = [...new Set(ech.map((c) => normStr(c.type_local)).filter((v): v is string => Boolean(v)))];

  const reserves: string[] = [];
  let robustes = prix;
  let extremes = 0;

  if (prix.length >= 4) {
    const tri = [...prix].sort((a, b) => a - b);
    const q1 = quantile(tri, 0.25), q3 = quantile(tri, 0.75);
    const iqr = q3 - q1;
    const bas = q1 - 1.5 * iqr, haut = q3 + 1.5 * iqr;
    robustes = prix.filter((p) => p >= bas && p <= haut);
    extremes = prix.length - robustes.length;
    if (extremes > 0) {
      reserves.push(`${extremes} valeur(s) extrême(s) écartée(s) de l'échantillon (méthode de Tukey, 1,5 × écart interquartile).`);
    }
  }

  const medEch = mediane(prix);
  const medRob = mediane(robustes.length ? robustes : prix);
  const dispersion = medRob && prix.length >= 2
    ? Math.round(((Math.max(...prix) - Math.min(...prix)) / medRob) * 100)
    : null;

  if (cats.length > 1) {
    reserves.push(`L'échantillon mélange ${cats.length} catégories de biens (${cats.join(', ')}) : la médiane agrégée n'est pas un prix de marché exploitable pour une catégorie donnée.`);
  }
  const nb = num(s.nb_comparables) ?? null;
  if (nb != null && nb < 5) {
    reserves.push(`Échantillon insuffisant (${nb} mutation(s)) : aucune médiane n'est statistiquement représentative en dessous de 5 comparables.`);
  }
  if (dispersion != null && dispersion > 120) {
    reserves.push(`Dispersion des prix très forte (${dispersion} % de la médiane) : le marché local n'est pas homogène.`);
  }

  return {
    nb_comparables: nb,
    taille_echantillon: prix.length,
    categories: cats,
    echantillon_heterogene: cats.length > 1,
    extremes_ecartes: extremes,
    prix_m2_median_echantillon: medEch != null ? Math.round(medEch) : null,
    prix_m2_median_robuste: medRob != null ? Math.round(medRob) : null,
    dispersion_pct: dispersion,
    reserves,
  };
}

// ── Résolution de la localisation ────────────────────────────
/** IDU 14 car. → { insee, section, numero }. numero PADDÉ (apicarto exige 4 car.). */
function parseIdu(idu: string): { insee: string; section: string; numero: string } | null {
  const s = idu.replace(/\s/g, '').toUpperCase();
  if (s.length < 14) return null;
  const insee = s.slice(0, 5);
  const section = s.slice(8, 10);
  const numero = s.slice(10, 14).padStart(4, '0');
  if (!/^(\d{5}|2[AB]\d{3})$/.test(insee)) return null;
  if (!/^[0-9A-Z]{2}$/.test(section) || !/^\d{4}$/.test(numero)) return null;
  return { insee, section, numero };
}
function centroidOf(geom: Brut): { lat: number; lon: number } | null {
  let ring: number[][] | null = null;
  if (geom?.type === 'Polygon') ring = geom.coordinates?.[0];
  else if (geom?.type === 'MultiPolygon') ring = geom.coordinates?.[0]?.[0];
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sx = 0, sy = 0, n = 0;
  for (const c of ring) if (Array.isArray(c) && c.length >= 2) { sx += c[0]; sy += c[1]; n++; }
  return n ? { lon: sx / n, lat: sy / n } : null;
}
/** Centroïde + CONTENANCE + nom de commune depuis l'IDU (une seule requête). */
async function parcelleFromIdu(idu: string): Promise<{ lat: number; lon: number; surface_m2?: number; commune?: string } | null> {
  const p = parseIdu(idu);
  if (!p) { console.error(`[etude] IDU illisible: ${idu}`); return null; }
  const url = `${CADASTRE_URL}?code_insee=${p.insee}&section=${encodeURIComponent(p.section)}&numero=${encodeURIComponent(p.numero)}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) { console.error(`[etude] cadastre HTTP ${r.status} — URL: ${url}`); return null; }
    const fc = await r.json();
    const nb = Array.isArray(fc?.features) ? fc.features.length : 0;
    console.log(`[etude] cadastre insee=${p.insee} section=${p.section} numero=${p.numero} → ${nb} parcelle(s)`);
    if (!nb) return null;
    const f = fc.features[0];
    const c = centroidOf(f?.geometry);
    if (!c) return null;
    return {
      ...c,
      surface_m2: num(f?.properties?.contenance),   // ← la donnée qu'on jetait
      commune: f?.properties?.nom_com ?? undefined,
    };
  } catch (e) {
    console.error(`[etude] cadastre échec: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
async function communeInfo(p: { insee?: string; commune?: string; zip?: string }): Promise<{ insee?: string; nom?: string; lat?: number; lon?: number }> {
  const query = p.insee ? `code=${encodeURIComponent(p.insee)}`
    : p.zip ? `codePostal=${encodeURIComponent(p.zip)}`
    : p.commune ? `nom=${encodeURIComponent(p.commune)}` : null;
  if (!query) return {};
  try {
    const r = await fetch(`${GEO_API}?${query}&fields=code,nom,centre&limit=1`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return {};
    const d = await r.json();
    const row = Array.isArray(d) ? d[0] : null;
    if (!row) return {};
    const c = row.centre?.coordinates;
    return {
      insee: row.code ? String(row.code) : undefined,
      nom: row.nom ?? undefined,
      lon: Array.isArray(c) ? c[0] : undefined,
      lat: Array.isArray(c) ? c[1] : undefined,
    };
  } catch { return {}; }
}

// ── Appel d'une source ───────────────────────────────────────
interface SourceResult {
  cle: string; label: string; status: 'ok' | 'no_data' | 'ko';
  summary: string | null; stats: unknown; motif?: string; duree_ms: number;
  // ── v4 : traçabilité portée par l'item lui-même ──
  portee?: DataScope;
  organisme?: string;
  jeu_de_donnees?: string;
  millesime?: string | null;
}
async function callSource(def: SourceDef, r: Resolved, baseUrl: string, key: string): Promise<SourceResult> {
  const t0 = Date.now();
  const slug = Deno.env.get(def.env);
  const base = { cle: def.cle, label: def.label, summary: null, stats: null };

  if (!slug) return { ...base, status: 'ko', motif: `non branché (${def.env} non défini)`, duree_ms: 0 };
  // ⚠️ GARDE DE PRÉCISION : lat/lon peuvent provenir du centroïde COMMUNE.
  // Interroger le GPU au centre-bourg renverrait des servitudes / secteurs de
  // bruit qui ne concernent PAS la parcelle : faux positif inacceptable.
  if (def.needs === 'geo' && (r.lat == null || r.lon == null || r.precision !== 'parcelle')) {
    return { ...base, status: 'ko', motif: 'exige une localisation à la parcelle (non résolue)', duree_ms: 0 };
  }
  if (def.needs === 'commune' && !r.insee && r.lat == null) {
    return { ...base, status: 'ko', motif: 'aucune commune identifiée', duree_ms: 0 };
  }

  try {
    const res = await fetch(`${baseUrl}/functions/v1/${slug}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(def.body(r)),
      signal: AbortSignal.timeout(def.timeout ?? DEFAULT_TIMEOUT_MS),
    });
    const duree_ms = Date.now() - t0;
    if (!res.ok) {
      // Cas vécu : slug déployé ≠ valeur du secret → 404 silencieux.
      console.error(`[etude] ${def.cle} → HTTP ${res.status} (slug "${slug}")`);
      return { ...base, status: 'ko', motif: `HTTP ${res.status} sur "${slug}"`, duree_ms };
    }
    const j = await res.json();

    // Contrat non standard (risques, DVF…) → adaptateur dédié.
    if (def.adapt) {
      const a = def.adapt(j);
      return { cle: def.cle, label: def.label, status: a.status, summary: assainirTexte(a.summary), stats: a.stats, motif: a.motif, duree_ms };
    }

    const st = String(j?.status ?? '');
    if (st === 'ok' || st === 'no_data') {
      return {
        cle: def.cle, label: def.label,
        status: st === 'ok' ? 'ok' : 'no_data',
        summary: typeof j.summary === 'string' ? assainirTexte(j.summary) : null,
        stats: j.stats ?? null,
        duree_ms,
      };
    }
    return { ...base, status: 'ko', motif: j?.summary ?? st ?? 'statut inconnu', duree_ms };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[etude] ${def.cle} échec: ${msg}`);
    const limite = def.timeout ?? DEFAULT_TIMEOUT_MS;
    return { ...base, status: 'ko', motif: msg.includes('timed out') ? `timeout (${limite}ms)` : msg, duree_ms: Date.now() - t0 };
  }
}

// =============================================================
// PHASE 1 / COUCHE 1 — QUALIFICATION
// =============================================================

/** Formulations qui affirment une portée PARCELLAIRE. Sert à détecter qu'une
 *  donnée à portée communale ou de voisinage est rédigée comme si elle valait
 *  au droit de la parcelle. */
const FORMULATION_PARCELLAIRE =
  /\b(la parcelle est|votre parcelle|au droit de la parcelle|sur la parcelle|cette parcelle est|raccordable|raccordée?|desservie?|grève|grevée|frappée|intersecte|traverse la parcelle)\b/i;

/** Formulations qui affirment une INTERSECTION géométrique. */
const FORMULATION_INTERSECTION =
  /\b(grève|grevée|frappée|intersecte|située? dans le périmètre|incluse dans|recoupe)\b/i;

interface Qualification {
  evidences: DataEvidence[];
  /** Index par id, pour les couches suivantes. */
  parId: Map<string, DataEvidence>;
  dvf: ReturnType<typeof qualiteDvf> | null;
}

function qualifier(items: SourceResult[], r: Resolved): Qualification {
  const evidences: DataEvidence[] = [];
  const byCle = new Map(items.map((i) => [i.cle, i]));
  const get = (cle: string) => byCle.get(cle);
  const statsOf = (cle: string) => get(cle)?.stats ?? null;
  const okOf = (cle: string) => get(cle)?.status === 'ok';
  const sourceOf = (cle: string) => {
    const d = SOURCES.find((s) => s.cle === cle);
    return d ? `${d.organisme} — ${d.dataset}` : cle;
  };
  const dateOf = (cle: string) => pluckMillesime(statsOf(cle));

  /** Évidence « source absente » homogène : la raison exacte y figure. */
  const indisponible = (id: string, label: string, cle: string, scope: DataScope): DataEvidence =>
    evidence({
      id, label, value: null, status: 'unavailable', scope,
      source: sourceOf(cle),
      warning: `Donnée non disponible — vérification requise. Motif : ${get(cle)?.motif ?? get(cle)?.status ?? 'source non interrogée'}. L'absence de donnée ne vaut pas absence de contrainte.`,
    });

  // ── 1. Surface cadastrale ──────────────────────────────────
  // Portée parcel par construction : la contenance vient de la fiche cadastrale
  // de CETTE parcelle. Si la résolution a échoué, la donnée est absente — on ne
  // la remplace jamais par une estimation.
  evidences.push(r.surface_m2 != null
    ? evidence({
        id: 'surface_cadastrale', label: 'Surface cadastrale (contenance)',
        value: r.surface_m2, unit: 'm²', status: 'confirmed', scope: 'parcel',
        source: 'DGFiP / IGN — API Carto, parcellaire cadastral (contenance)',
      })
    : evidence({
        id: 'surface_cadastrale', label: 'Surface cadastrale (contenance)',
        value: null, status: 'unavailable', scope: 'parcel',
        source: 'DGFiP / IGN — API Carto, parcellaire cadastral',
        warning: "Donnée non disponible — vérification requise. Sans contenance, aucun raisonnement en emprise au sol ni en prix au m² de terrain n'est possible.",
      }));

  // ── 2. Altitude et pente ───────────────────────────────────
  // Portée bornée par la précision : en repli centre commune, la valeur décrit
  // le bourg, pas le terrain → 'estimated' + 'municipality', jamais 'parcel'.
  {
    const cle = 'altimetrie';
    const st = statsOf(cle);
    const parcellaire = r.precision === 'parcelle';
    const scope: DataScope = parcellaire ? 'parcel' : 'municipality';
    const alt = pluckNum(st, ['altitude_m', 'altitude', 'altitude_moyenne', 'elevation_m', 'elevation', 'z']);
    const pente = pluckNum(st, ['pente_pct', 'pente_moyenne_pct', 'slope_pct', 'pente', 'pente_moyenne', 'slope']);
    const reserve = parcellaire ? undefined
      : "Parcelle non localisée : valeur mesurée au centre de la commune, INDICATIVE. Ne décrit pas le relief du terrain.";

    const grandeurs: Array<[string, string, number | undefined, string]> = [
      ['altitude', 'Altitude', alt, 'm'],
      ['pente', 'Pente moyenne du terrain', pente, '%'],
    ];
    for (const [id, label, val, unit] of grandeurs) {
      evidences.push(!okOf(cle) ? indisponible(id, label, cle, scope)
        : val == null
          ? evidence({ id, label, value: null, status: 'unavailable', scope, source: sourceOf(cle), sourceDate: dateOf(cle),
              warning: "Donnée non disponible — vérification requise. La source a répondu mais ne fournit pas cette grandeur." })
          : evidence({ id, label, value: val, unit, status: parcellaire ? 'confirmed' : 'estimated', scope,
              source: sourceOf(cle), sourceDate: dateOf(cle), warning: reserve }));
    }
  }

  // ── 3. Servitudes d'utilité publique ───────────────────────
  // RÈGLE : portée 'parcel' UNIQUEMENT si la source démontre une intersection.
  // Sans preuve d'intersection, la donnée reste 'nearby' — et l'expression
  // « grève la parcelle » devient interdite en aval.
  {
    const cle = 'servitudes';
    const st = statsOf(cle);
    const it = get(cle);
    const intersecte = pluckBool(st, [
      'intersecte', 'intersects', 'intersection', 'dans_perimetre', 'in_perimeter',
      'sur_parcelle', 'grevee', 'grevant', 'concerne_parcelle',
    ]);
    const nbIntersect = pluckNum(st, ['nb_intersectantes', 'count_intersect', 'nb_servitudes_parcelle', 'servitudes_intersectantes']);
    const nb = pluckNum(st, ['nb_servitudes', 'count', 'total', 'nb']);
    const demontree = intersecte === true || (nbIntersect != null && nbIntersect > 0);
    const libelles = pluck(st, ['servitudes', 'liste', 'types', 'categories', 'items']);

    if (!okOf(cle)) {
      evidences.push(indisponible('servitudes', "Servitudes d'utilité publique", cle, 'nearby'));
    } else {
      evidences.push(evidence({
        id: 'servitudes',
        label: "Servitudes d'utilité publique",
        value: {
          nb_recensees: nb ?? null,
          nb_intersectantes: nbIntersect ?? null,
          intersection_demontree: demontree,
          detail: Array.isArray(libelles) ? libelles.slice(0, 8) : (libelles ?? null),
        },
        status: demontree ? 'confirmed' : 'estimated',
        scope: demontree ? 'parcel' : 'nearby',
        source: sourceOf(cle), sourceDate: dateOf(cle),
        warning: demontree
          ? "Servitude intersectant la parcelle : contrainte opposable, à confirmer sur le plan des SUP annexé au PLU."
          : "Aucune intersection démontrée par la source : les servitudes recensées sont situées À PROXIMITÉ. Ne pas écrire qu'elles grèvent la parcelle. Le GPU n'est pas exhaustif — l'absence de servitude au GPU ne vaut pas absence de servitude.",
      }));

      // Monument historique : cas particulier explicitement exigé. La présence
      // d'un monument dans les environs n'est PAS une servitude intersectante.
      const txt = `${it?.summary ?? ''} ${JSON.stringify(st ?? {})}`;
      if (/monument|\bAC1\b|abords|classé|inscrit|\bABF\b|architecte des bâtiments/i.test(txt)) {
        evidences.push(evidence({
          id: 'monument_historique', label: 'Monument historique / abords',
          value: { signale: true, intersection_demontree: demontree },
          status: demontree ? 'confirmed' : 'estimated',
          scope: demontree ? 'parcel' : 'nearby',
          source: sourceOf(cle), sourceDate: dateOf(cle),
          warning: demontree
            ? "Périmètre de protection intersectant : avis de l'Architecte des Bâtiments de France requis."
            : "Monument signalé À PROXIMITÉ. Aucune intersection démontrée avec la parcelle : ce n'est pas une servitude grevant le terrain tant que l'appartenance au périmètre délimité des abords n'est pas vérifiée.",
        }));
      }
    }
  }

  // ── 4. Risques — une évidence par aléa NOMMÉ ───────────────
  // Portée 'municipality' par défaut : risk-study ne qualifie pas ses aléas au
  // droit de la parcelle. Un aléa communal reste un aléa : il n'est pas
  // minoré, seulement correctement porté.
  {
    const cle = 'risques';
    const st = statsOf(cle) as Brut;
    const src = sourceOf(cle), sd = dateOf(cle);
    const portee: DataScope = 'municipality';
    const reserveCommunale = "Aléa qualifié à l'échelle communale par la source. Son emprise réelle au droit de la parcelle doit être vérifiée sur le zonage réglementaire opposable.";

    if (!okOf(cle)) {
      evidences.push(indisponible('risques', 'Risques naturels et technologiques', cle, portee));
    } else {
      const push = (id: string, label: string, value: unknown, present: boolean, warn = reserveCommunale) => {
        evidences.push(evidence({
          id, label, value: value ?? null,
          status: value == null ? 'unavailable' : 'confirmed',
          scope: portee, source: src, sourceDate: sd,
          warning: value == null
            ? "Donnée non disponible — vérification requise."
            : (present ? warn : undefined),
        }));
      };
      const inond = st?.inondation ?? {};
      evidences.push(evidence({
        id: 'risque_inondation', label: "Risque d'inondation",
        value: { zone_inondable: inond.zone_inondable ?? null, ppri: inond.ppri ?? null },
        status: inond.zone_inondable == null ? 'unavailable' : 'confirmed',
        scope: portee, source: src, sourceDate: sd,
        warning: inond.zone_inondable === true
          ? "Zone inondable identifiée. Contrainte potentiellement bloquante : le règlement du PPRI (ou du PPRN valant PPRI) prime sur le PLU et peut interdire toute construction nouvelle."
          : inond.zone_inondable == null ? "Donnée non disponible — vérification requise." : reserveCommunale,
      }));
      push('risque_argiles', 'Retrait-gonflement des argiles', st?.argiles_alea, Boolean(st?.argiles_alea),
        /fort|moyen/i.test(String(st?.argiles_alea ?? ''))
          ? "Aléa moyen ou fort : étude géotechnique préalable G1 obligatoire à la vente du terrain (loi ELAN), étude G2 avant construction."
          : reserveCommunale);
      push('risque_sismique', 'Sismicité', st?.seisme_zone, st?.seisme_zone != null,
        Number(st?.seisme_zone) >= 4 ? "Zone de sismicité 4 ou 5 : règles parasismiques renforcées applicables à la construction." : reserveCommunale);
      push('risque_radon', 'Potentiel radon', st?.radon_classe, st?.radon_classe != null,
        Number(st?.radon_classe) >= 3 ? "Classe 3 : mesurage et dispositions constructives de ventilation recommandés." : reserveCommunale);
      push('risque_cavites', 'Cavités souterraines', st?.cavites_count, Number(st?.cavites_count) > 0);
      push('risque_mouvements_terrain', 'Mouvements de terrain', st?.mouvements_terrain_count, Number(st?.mouvements_terrain_count) > 0);
      push('risque_icpe', 'Installations classées (ICPE)', st?.icpe_count, Number(st?.icpe_count) > 0);
      push('risque_seveso', 'Sites SEVESO seuil haut', st?.seveso_haut_count, Number(st?.seveso_haut_count) > 0,
        Number(st?.seveso_haut_count) > 0 ? "SEVESO seuil haut : un PPRT peut interdire ou contraindre fortement la constructibilité. Contrainte potentiellement bloquante." : reserveCommunale);
      push('risque_sis', 'Sites et sols pollués (SIS)', st?.sis_count, Number(st?.sis_count) > 0,
        Number(st?.sis_count) > 0 ? "Secteur d'information sur les sols : étude de sols et attestation de prise en compte de la pollution exigibles au permis." : reserveCommunale);
      push('risque_feux_foret', 'Feux de forêt', st?.feux_foret, st?.feux_foret === true);
      push('risque_catnat', 'Arrêtés de catastrophe naturelle', st?.catnat_count, Number(st?.catnat_count) > 0);
      push('risque_ppr', 'Plans de prévention des risques (PPR)', st?.ppr_count, Number(st?.ppr_count) > 0);

      // Score de sécurité : porté explicitement avec sa convention, parce que
      // c'est exactement l'inversion qui a fait lire « 78/100 » comme un risque.
      const glob = st?.scores_securite?.global;
      evidences.push(evidence({
        id: 'score_securite', label: 'Score de sécurité global',
        value: glob ?? null, unit: '/100',
        status: glob == null ? 'unavailable' : 'confirmed',
        scope: portee, source: src, sourceDate: sd,
        warning: "Convention INVERSE d'un score de risque : 100 = zone très sûre, 0 = risque maximal. Ce score est un agrégat ; il ne prime jamais sur un aléa nommé et ne peut pas compenser une contrainte bloquante.",
      }));
    }
  }

  // ── 5. Assainissement ──────────────────────────────────────
  // RÈGLE ABSOLUE : portée 'municipality', jamais 'parcel'. La présence d'un
  // service collectif dans la commune ne dit RIEN de la desserte au droit du
  // terrain ni de la faisabilité du branchement.
  {
    const cle = 'assainissement';
    const it = get(cle);
    const txt = `${it?.summary ?? ''} ${JSON.stringify(statsOf(cle) ?? {})}`;
    const nonCollectif = /non[\s-]?collectif|assainissement individuel|\banc\b|spanc/i.test(txt);
    const collectif = !nonCollectif && /\bcollectif\b|tout[\s-]à[\s-]l'égout|station d'épuration/i.test(txt);
    const mode = !okOf(cle) ? null : collectif ? 'collectif' : nonCollectif ? 'non collectif' : null;

    evidences.push(!okOf(cle)
      ? indisponible('assainissement', 'Assainissement', cle, 'municipality')
      : evidence({
          id: 'assainissement', label: 'Assainissement',
          value: { mode, operateur: pluckStr(statsOf(cle), ['operateur', 'exploitant', 'gestionnaire', 'delegataire']) ?? null },
          status: mode ? 'confirmed' : 'estimated',
          scope: 'municipality',
          source: sourceOf(cle), sourceDate: dateOf(cle),
          warning: "Donnée COMMUNALE. L'existence d'un service d'assainissement dans la commune ne vaut PAS raccordement, ni raccordabilité, au droit de la parcelle. Seuls le zonage d'assainissement et l'avis du gestionnaire de réseau l'établissent.",
        }));
  }

  // ── 6. Zonage ABC ──────────────────────────────────────────
  {
    const cle = 'zonage';
    const it = get(cle);
    const brut = pluckStr(statsOf(cle), ['zone', 'zonage', 'zone_abc', 'classement', 'zone_abc_libelle']);
    const m = /\b(a\s?bis|abis|b1|b2|c|a)\b/i.exec(brut ?? '') ?? /zone\s+(a\s?bis|abis|b1|b2|c|a)\b/i.exec(it?.summary ?? '');
    const zone = m ? m[1].toUpperCase().replace(/\s/g, '') : null;

    evidences.push(!okOf(cle)
      ? indisponible('zonage_abc', 'Zonage ABC (tension locative)', cle, 'municipality')
      : evidence({
          id: 'zonage_abc', label: 'Zonage ABC (tension locative)',
          value: zone, status: zone ? 'confirmed' : 'estimated', scope: 'municipality',
          source: sourceOf(cle), sourceDate: dateOf(cle),
          warning: "Zonage COMMUNAL de tension du marché locatif. Il ne qualifie ni la parcelle ni un droit à construire.",
        }));
  }

  // ── 7. Fiscalité locale ────────────────────────────────────
  {
    const cle = 'taxes';
    const tfb = pluckNum(statsOf(cle), ['taux_tfb', 'tfb', 'taux_foncier_bati', 'taux_taxe_fonciere_bati', 'taux_tf', 'taux_fb']);
    evidences.push(!okOf(cle)
      ? indisponible('fiscalite_tfb', 'Taux de taxe foncière sur le bâti', cle, 'municipality')
      : evidence({
          id: 'fiscalite_tfb', label: 'Taux de taxe foncière sur le bâti',
          value: tfb ?? null, unit: '%',
          status: tfb != null ? 'confirmed' : 'estimated', scope: 'municipality',
          source: sourceOf(cle), sourceDate: dateOf(cle),
          warning: "Taux COMMUNAL de l'exercice publié. Il évolue chaque année par délibération et ne préjuge pas de la base d'imposition du bien.",
        }));
  }

  // ── 8. Loyers de référence ─────────────────────────────────
  {
    const cle = 'loyers';
    const st = statsOf(cle);
    const appt = pluckNum(st, ['loyer_median_appartement', 'loyer_median_appart', 'loyer_m2_appartement']);
    const maison = pluckNum(st, ['loyer_median_maison', 'loyer_m2_maison']);
    const med = appt ?? maison ?? pluckNum(st, ['loyer_median', 'loyer_reference_median', 'loyer_m2_median']);
    evidences.push(!okOf(cle)
      ? indisponible('loyers_reference', 'Loyer de référence', cle, 'municipality')
      : evidence({
          id: 'loyers_reference', label: 'Loyer de référence',
          value: { median_appartement: appt ?? null, median_maison: maison ?? null, retenu: med ?? null },
          unit: '€/m²/mois',
          status: med != null ? 'confirmed' : 'estimated', scope: 'municipality',
          source: sourceOf(cle), sourceDate: dateOf(cle),
          warning: "Indicateur COMMUNAL modélisé (moyenne). Il ne remplace pas une étude de loyers de marché sur le segment visé.",
        }));
  }

  // ── 9. DVF — statistiques et qualité de l'échantillon ──────
  let dvfQ: ReturnType<typeof qualiteDvf> | null = null;
  {
    const cle = 'dvf';
    const st = statsOf(cle);
    if (!okOf(cle)) {
      evidences.push(indisponible('dvf_prix_m2', 'Prix au m² (transactions comparables)', cle, 'nearby'));
    } else {
      dvfQ = qualiteDvf(st);
      const source = pluckNum(st, ['prix_m2_median', 'price_m2_median', 'median_price_m2', 'prix_median_m2']);
      const reserves = dvfQ.reserves;
      evidences.push(evidence({
        id: 'dvf_prix_m2', label: 'Prix au m² (transactions comparables)',
        value: {
          prix_m2_median_source: source ?? null,
          prix_m2_median_robuste: dvfQ.prix_m2_median_robuste,
          nb_comparables: dvfQ.nb_comparables,
          categories: dvfQ.categories,
          extremes_ecartes: dvfQ.extremes_ecartes,
          dispersion_pct: dvfQ.dispersion_pct,
        },
        unit: '€/m²',
        // Un échantillon hétérogène ou trop petit n'est pas un fait confirmé :
        // c'est un ordre de grandeur. On le dit dans le statut, pas seulement
        // dans une note de bas de page.
        status: (dvfQ.nb_comparables ?? 0) === 0 ? 'unavailable'
          : (dvfQ.echantillon_heterogene || (dvfQ.nb_comparables ?? 0) < 5) ? 'estimated' : 'confirmed',
        scope: 'nearby',
        source: sourceOf(cle), sourceDate: dateOf(cle),
        warning: reserves.length
          ? reserves.join(' ')
          : "Comparables situés dans un rayon de 2 km sur 24 mois : ordre de grandeur du marché local, pas une valeur de la parcelle.",
      }));
    }
  }

  // ── 10. Classement sonore ──────────────────────────────────
  // Même règle que les servitudes : 'parcel' seulement si intersection démontrée.
  {
    const cle = 'bruit';
    const st = statsOf(cle);
    const intersecte = pluckBool(st, ['intersecte', 'intersects', 'dans_secteur', 'concerne_parcelle', 'in_sector']);
    const cat = pluckStr(st, ['categorie', 'category', 'classement', 'categorie_voie']);
    const largeur = pluckNum(st, ['largeur_secteur_m', 'largeur_m', 'distance_m', 'buffer_m']);
    const demontree = intersecte === true;

    evidences.push(!okOf(cle)
      ? indisponible('classement_sonore', 'Classement sonore des voies', cle, 'nearby')
      : evidence({
          id: 'classement_sonore', label: 'Classement sonore des voies',
          value: { categorie: cat ?? null, largeur_secteur_m: largeur ?? null, intersection_demontree: demontree },
          status: demontree ? 'confirmed' : 'estimated',
          scope: demontree ? 'parcel' : 'nearby',
          source: sourceOf(cle), sourceDate: dateOf(cle),
          warning: demontree
            ? "Parcelle située dans un secteur affecté par le bruit : isolement acoustique renforcé obligatoire pour les constructions nouvelles."
            : "Voie classée recensée À PROXIMITÉ, sans intersection démontrée avec la parcelle. Couche partiellement numérisée selon les communes : une absence ne vaut pas absence de classement.",
        }));
  }

  // ── 11. Potentiel solaire ──────────────────────────────────
  {
    const cle = 'solaire';
    const parcellaire = r.precision === 'parcelle';
    const scope: DataScope = parcellaire ? 'parcel' : 'municipality';
    const irr = pluckNum(statsOf(cle), ['irradiation_kwh_m2_an', 'irradiation', 'kwh_m2_an', 'productible_kwh_kwc']);
    evidences.push(!okOf(cle)
      ? indisponible('potentiel_solaire', 'Potentiel solaire', cle, scope)
      : evidence({
          id: 'potentiel_solaire', label: 'Potentiel solaire',
          value: irr ?? null, unit: 'kWh/m²/an',
          status: irr == null ? 'unavailable' : parcellaire ? 'confirmed' : 'estimated',
          scope, source: sourceOf(cle), sourceDate: dateOf(cle),
          warning: parcellaire
            ? "Irradiation théorique du site : ne tient compte ni des masques bâtis ou végétaux, ni de l'orientation réelle des toitures."
            : "Parcelle non localisée : irradiation calculée au centre de la commune, INDICATIVE.",
        }));
  }

  // ── 12. Règlement PLU — absence STRUCTURELLE, déclarée ─────
  // Ce n'est pas un échec : c'est une limite d'architecture. Elle est portée
  // comme une donnée manquante explicite pour que le verdict s'y adosse.
  evidences.push(evidence({
    id: 'reglement_plu', label: 'Règlement PLU opposable',
    value: null, status: 'unavailable', scope: 'parcel',
    source: 'Non collecté par cette étude — extraction assurée côté application (page Foncier)',
    warning: "Donnée non disponible — vérification requise. Aucune règle d'urbanisme (zone, emprise, hauteur, recul, stationnement, servitudes du PLU) n'est connue de cette étude. Toute capacité constructive est donc INDÉTERMINABLE.",
  }));

  return { evidences, parId: new Map(evidences.map((e) => [e.id, e])), dvf: dvfQ };
}

// =============================================================
// PHASE 1 / COUCHE 2 — MOTEUR DE COHÉRENCE
// =============================================================

/**
 * Croise les sources et marque les données en conflit. Principe directeur :
 * on n'ARBITRE JAMAIS entre deux versions. On déclare le conflit, on dégrade
 * la confiance, et on renvoie l'utilisateur au document opposable.
 * Six familles de règles, toutes déclenchées par un signal réellement observé.
 */
function detecterContradictions(
  q: Qualification, items: SourceResult[], r: Resolved,
): Contradiction[] {
  const out: Contradiction[] = [];
  const byCle = new Map(items.map((i) => [i.cle, i]));
  const st = (cle: string) => (byCle.get(cle)?.stats ?? null) as Brut;
  const ok = (cle: string) => byCle.get(cle)?.status === 'ok';

  // ── Règle A — PPR recensé vs absence de PPRI affirmée ──────
  // Cas vécu : GASPAR remonte des PPR sur la commune tandis que le volet
  // inondation déclare `ppri: false`. Les deux ne peuvent pas être vrais si le
  // PPR recensé est un PPRI. On ne tranche pas : on exige l'arrêté.
  if (ok('risques')) {
    const s = st('risques');
    const pprCount = num(s?.ppr_count) ?? 0;
    const ppri = s?.inondation?.ppri;
    const inondable = s?.inondation?.zone_inondable;
    if (pprCount > 0 && ppri === false) {
      out.push({
        id: 'ppr_vs_ppri', gravite: 'bloquante',
        message: `Données contradictoires — vérification du document opposable requise : ${pprCount} plan(s) de prévention des risques recensé(s) sur la commune, alors que la source déclare l'absence de PPRI. L'étude ne tranche pas.`,
        donnees: ['risque_ppr', 'risque_inondation'],
        verification: "Arrêté préfectoral d'approbation du PPR et son règlement, ou état des risques ERRIAL à l'adresse",
        organisme: 'Préfecture / Géorisques',
      });
    }
    if (inondable === true && ppri == null) {
      out.push({
        id: 'inondable_ppri_inconnu', gravite: 'importante',
        message: "Données contradictoires — vérification du document opposable requise : zone inondable identifiée mais l'existence d'un PPRI n'est pas renseignée. Le caractère bloquant de la contrainte ne peut pas être établi ici.",
        donnees: ['risque_inondation'],
        verification: 'Règlement du PPRI ou du PPRN valant PPRI, zonage réglementaire à la parcelle',
        organisme: 'Préfecture / DDTM',
      });
    }
    // ── Règle B — zone inondable vs score de sécurité élevé ──
    // Le score est un agrégat : il peut rester haut alors qu'un aléa bloquant
    // existe. C'est exactement le masquage qu'on veut rendre impossible.
    const scoreNat = num(s?.scores_securite?.naturels) ?? num(s?.scores_securite?.global);
    if (inondable === true && scoreNat != null && scoreNat >= 70) {
      out.push({
        id: 'inondable_vs_score', gravite: 'importante',
        message: `Données contradictoires — vérification du document opposable requise : zone inondable identifiée alors que le score de sécurité naturelle atteint ${scoreNat}/100. Un score agrégé élevé ne compense JAMAIS un aléa nommé ; le verdict de risque retient l'aléa.`,
        donnees: ['risque_inondation', 'score_securite'],
        verification: 'Zonage réglementaire du PPRI à la parcelle',
        organisme: 'Préfecture / DDTM',
      });
    }
  }

  // ── Règle C — donnée communale rédigée au parcellaire ──────
  // On lit le TEXTE des sources à portée communale : s'il affirme quelque chose
  // au droit de la parcelle, la formulation dépasse la portée de la donnée.
  for (const def of SOURCES) {
    const it = byCle.get(def.cle);
    if (!it || it.status !== 'ok' || !it.summary) continue;
    if (def.scope(r) !== 'municipality') continue;
    if (!FORMULATION_PARCELLAIRE.test(it.summary)) continue;
    out.push({
      id: `portee_${def.cle}`, gravite: 'importante',
      message: `Données contradictoires — vérification du document opposable requise : « ${def.label} » est une donnée COMMUNALE, mais sa formulation affirme un fait au droit de la parcelle. La portée ne permet pas cette affirmation.`,
      donnees: [def.cle],
      verification: def.cle === 'assainissement'
        ? "Zonage d'assainissement communal et avis du gestionnaire de réseau sur la desserte de la parcelle"
        : 'Document de référence de la donnée à la parcelle',
      organisme: def.organisme,
    });
  }

  // ── Règle D — voisinage présenté comme intersectant ────────
  // Un monument, une servitude ou une voie bruyante « à proximité » n'est pas
  // une contrainte grevant le terrain.
  const cibles: Array<['servitudes' | 'bruit', string]> = [['servitudes', 'servitudes'], ['bruit', 'classement_sonore']];
  for (const [cle, evId] of cibles) {
    const it = byCle.get(cle);
    if (!it || it.status !== 'ok' || !it.summary) continue;
    const ev = q.parId.get(evId);
    const demontree = ev?.scope === 'parcel';
    if (!demontree && FORMULATION_INTERSECTION.test(it.summary)) {
      out.push({
        id: `intersection_${cle}`, gravite: 'importante',
        message: `Données contradictoires — vérification du document opposable requise : « ${it.label} » emploie une formulation d'intersection alors qu'aucune intersection avec la parcelle n'est démontrée par la source. L'élément est situé à proximité.`,
        donnees: [evId],
        verification: cle === 'servitudes'
          ? "Plan des servitudes d'utilité publique annexé au PLU, et périmètre délimité des abords le cas échéant"
          : "Arrêté préfectoral de classement sonore des infrastructures de transport terrestre",
        organisme: cle === 'servitudes' ? 'Commune / DDT / UDAP' : 'Préfecture',
      });
    }
  }
  // Monument signalé sans intersection : réserve systématique, indépendante du texte.
  const mon = q.parId.get('monument_historique');
  if (mon && mon.scope !== 'parcel') {
    out.push({
      id: 'monument_proximite', gravite: 'importante',
      message: "Monument historique signalé À PROXIMITÉ, sans intersection démontrée avec la parcelle. Tant que l'appartenance au périmètre délimité des abords n'est pas vérifiée, il ne s'agit PAS d'une servitude grevant le terrain — mais l'hypothèse ne peut pas être écartée.",
      donnees: ['monument_historique'],
      verification: "Périmètre délimité des abords (PDA) ou périmètre de 500 m, et avis de l'Architecte des Bâtiments de France",
      organisme: 'UDAP / Architecte des Bâtiments de France',
    });
  }

  // ── Règle E — géométrie en repli commune lue au parcellaire ─
  if (r.precision !== 'parcelle') {
    const geo: Array<['altimetrie' | 'solaire', string]> = [['altimetrie', 'pente'], ['solaire', 'potentiel_solaire']];
    for (const [cle, evId] of geo) {
      const it = byCle.get(cle);
      if (!it || it.status !== 'ok' || !it.summary) continue;
      if (!FORMULATION_PARCELLAIRE.test(it.summary)) continue;
      out.push({
        id: `precision_${cle}`, gravite: 'importante',
        message: `Données contradictoires — vérification du document opposable requise : « ${it.label} » est mesurée au centre de la commune (précision « ${r.precision} ») mais sa formulation la présente comme parcellaire.`,
        donnees: [evId],
        verification: 'Relevé topographique du terrain',
        organisme: 'Géomètre-expert',
      });
    }
  }

  // ── Règle F — millésimes incohérents ───────────────────────
  const anneeCourante = new Date().getFullYear();
  for (const ev of q.evidences) {
    const a = anneeDe(ev.sourceDate);
    if (a == null) continue;
    if (a > anneeCourante) {
      out.push({
        id: `millesime_futur_${ev.id}`, gravite: 'importante',
        message: `Données contradictoires — vérification du document opposable requise : « ${ev.label} » porte un millésime ${a}, postérieur à l'année en cours (${anneeCourante}). La date de la donnée est incohérente.`,
        donnees: [ev.id], verification: 'Millésime officiel du jeu de données', organisme: ev.source,
      });
    } else if (anneeCourante - a > 10) {
      out.push({
        id: `millesime_ancien_${ev.id}`, gravite: 'importante',
        message: `« ${ev.label} » repose sur un millésime ${a}, soit ${anneeCourante - a} ans d'ancienneté. La donnée peut ne plus refléter la situation actuelle.`,
        donnees: [ev.id], verification: 'Version à jour du jeu de données', organisme: ev.source,
      });
    }
  }

  return out;
}

/** Applique les contradictions aux évidences : statut, confiance, réserve. */
function appliquerContradictions(q: Qualification, contradictions: Contradiction[]): void {
  for (const c of contradictions) {
    for (const id of c.donnees) {
      const ev = q.parId.get(id);
      if (!ev) continue;
      // Une donnée absente reste absente : un conflit ne la ressuscite pas.
      if (ev.status === 'unavailable' || ev.status === 'not_applicable') continue;
      ev.status = 'contradictory';
      ev.warning = `Données contradictoires — vérification du document opposable requise. ${c.message}${ev.warning ? ` (Réserve initiale : ${ev.warning})` : ''}`;
      ev.confidence = computeConfidence(ev.status, ev.scope, ev.sourceDate, true);
    }
  }
}

// =============================================================
// PHASE 1 / COUCHE 3 — VERDICT DÉTERMINISTE
// =============================================================

interface Facteur { nom: string; valeur: unknown; effet: number | string; explication: string }

interface Verdict {
  potentiel: { niveau: 'favorable' | 'intermediaire' | 'defavorable'; score: number; facteurs: Facteur[]; formule: string };
  risque: { niveau: 'faible' | 'modere' | 'eleve' | 'bloquant' | 'indetermine'; facteurs: Facteur[]; bloquants: string[]; formule: string };
  fiabilite: { score: number; facteurs: Facteur[]; formule: string };
  recommandation: { valeur: 'poursuivre' | 'poursuivre_sous_conditions' | 'suspendre' | 'ecarter'; motif: string; formule: string };
  constructibilite: { statut: 'indeterminable'; motif: string; condition_levee: string };
}

/**
 * Trois indicateurs SÉPARÉS, jamais agrégés en un score unique. Un score
 * unique permet à une accumulation de signaux positifs de noyer un aléa
 * rédhibitoire : c'est précisément le défaut qu'on corrige.
 */
function calculerVerdict(
  q: Qualification, items: SourceResult[], contradictions: Contradiction[], r: Resolved,
): Verdict {
  const byCle = new Map(items.map((i) => [i.cle, i]));
  const st = (cle: string) => (byCle.get(cle)?.stats ?? null) as Brut;
  const ok = (cle: string) => byCle.get(cle)?.status === 'ok';
  const ev = (id: string) => q.parId.get(id);
  const val = (id: string): Brut => ev(id)?.value ?? null;

  // ─────────────────────────────────────────────────────────
  // POTENTIEL — dérivé des SEULES données positives disponibles.
  // FORMULE : somme de facteurs entiers, chacun borné et documenté.
  //   tension_zonage        Abis/A/B1 +2 · B2 +1 · C 0 · inconnu 0
  //   assainissement        collectif +1 · non collectif −1 · inconnu 0
  //   pente                 ≤10 % +1 · 10–20 % 0 · >20 % −1 · non mesurée 0
  //   liquidite_dvf         ≥10 comps +2 · 5–9 +1 · 1–4 0 · 0 −1
  //   rendement_indicatif   ≥7 % +2 · 5–7 % +1 · 3–5 % 0 · <3 % −1 · incalculable 0
  //   → total ≥ +3 favorable · 0..+2 intermédiaire · < 0 défavorable
  // GARDE-FOU : si la fiabilité < 40, le potentiel est plafonné à
  // « intermédiaire ». On ne déclare pas un terrain favorable sur des données
  // trouées.
  // Les facteurs « inconnu » valent 0 (neutre) et NON une valeur favorable :
  // l'absence de donnée n'est jamais un signal positif.
  // ─────────────────────────────────────────────────────────
  const fPot: Facteur[] = [];
  let sPot = 0;

  const zone = val('zonage_abc') as string | null;
  {
    const e = zone == null ? 0 : /^(ABIS|A|B1)$/.test(zone) ? 2 : zone === 'B2' ? 1 : 0;
    sPot += e;
    fPot.push({ nom: 'tension_zonage', valeur: zone, effet: e,
      explication: zone == null ? "Zonage ABC non déterminé : facteur neutre." : `Zone ${zone} — tension du marché locatif communal.` });
  }
  {
    const mode = (val('assainissement') as Brut)?.mode ?? null;
    const e = mode === 'collectif' ? 1 : mode === 'non collectif' ? -1 : 0;
    sPot += e;
    fPot.push({ nom: 'assainissement_collectif', valeur: mode, effet: e,
      explication: mode == null ? "Mode d'assainissement non déterminé : facteur neutre."
        : mode === 'collectif' ? "Service collectif présent dans la commune (coût de viabilisation a priori moindre — raccordement au droit de la parcelle NON confirmé)."
        : "Assainissement non collectif : filière individuelle à dimensionner, surface et aptitude des sols requises." });
  }
  {
    const pente = ev('pente');
    const p = typeof pente?.value === 'number' ? pente.value : null;
    const mesuree = p != null && pente?.status === 'confirmed';
    const e = !mesuree ? 0 : p <= 10 ? 1 : p <= 20 ? 0 : -1;
    sPot += e;
    fPot.push({ nom: 'pente_exploitable', valeur: p, effet: e,
      explication: !mesuree ? 'Pente non mesurée à la parcelle : facteur neutre.'
        : p <= 10 ? `Pente de ${p} % : terrain aisément aménageable.`
        : p <= 20 ? `Pente de ${p} % : terrassement significatif à prévoir.`
        : `Pente de ${p} % : surcoût de terrassement et de fondations important.` });
  }
  const nbComps = q.dvf?.nb_comparables ?? null;
  {
    const e = nbComps == null ? 0 : nbComps >= 10 ? 2 : nbComps >= 5 ? 1 : nbComps >= 1 ? 0 : -1;
    sPot += e;
    fPot.push({ nom: 'liquidite_marche', valeur: nbComps, effet: e,
      explication: nbComps == null ? 'Aucune donnée de transaction : facteur neutre.'
        : nbComps === 0 ? 'Aucune mutation comparable sur 24 mois dans un rayon de 2 km : marché illiquide.'
        : `${nbComps} mutation(s) comparable(s) sur 24 mois : mesure de la liquidité du marché local, pas du niveau de prix.` });
  }
  {
    // Rendement locatif brut indicatif = loyer €/m²/mois × 12 ÷ prix €/m².
    // Calculé UNIQUEMENT si les deux termes sont réellement disponibles.
    // Hors charges, hors fiscalité, hors vacance : c'est un ordre de grandeur.
    const loyer = (val('loyers_reference') as Brut)?.retenu ?? null;
    const prix = q.dvf?.prix_m2_median_robuste ?? null;
    const rdt = loyer && prix ? (loyer * 12) / prix * 100 : null;
    const e = rdt == null ? 0 : rdt >= 7 ? 2 : rdt >= 5 ? 1 : rdt >= 3 ? 0 : -1;
    sPot += e;
    fPot.push({ nom: 'rendement_brut_indicatif', valeur: rdt != null ? Math.round(rdt * 10) / 10 : null, effet: e,
      explication: rdt == null
        ? 'Rendement incalculable : loyer de référence ou prix DVF manquant. Facteur neutre.'
        : `Rendement brut indicatif de ${Math.round(rdt * 10) / 10} % (loyer communal médian × 12 ÷ prix DVF médian robuste). Hors charges, fiscalité et vacance ; croise deux portées différentes (communale et voisinage).` });
  }

  // ─────────────────────────────────────────────────────────
  // RISQUE — dérivé des aléas NOMMÉS et des servitudes intersectantes.
  // Trois familles de déclencheurs, évaluées de la plus grave à la plus faible.
  // BLOQUANT est ABSORBANT : aucune accumulation de signaux positifs, aucun
  // score de sécurité, ne peut le ramener à un niveau inférieur.
  //   bloquant : zone inondable AVEC PPRI · servitude intersectante démontrée
  //              · SEVESO seuil haut ≥ 1
  //   élevé    : zone inondable sans PPRI · argiles aléa fort · sismicité ≥ 4
  //              · cavités > 0 · mouvements de terrain > 0 · SIS > 0
  //              · radon classe 3 · secteur de bruit intersectant
  //   modéré   : argiles aléa moyen · sismicité 3 · ICPE > 0 · catnat ≥ 3
  //   faible   : source risques exploitable et aucun déclencheur ci-dessus
  //   indéterminé : source risques indisponible. « faible » est INTERDIT dans
  //              ce cas — l'absence de donnée n'est pas une absence de risque.
  // ─────────────────────────────────────────────────────────
  const fRis: Facteur[] = [];
  const bloquants: string[] = [];
  const eleves: string[] = [];
  const moderes: string[] = [];
  const sR = st('risques');

  const inondable = sR?.inondation?.zone_inondable === true;
  const ppri = sR?.inondation?.ppri === true;
  if (inondable && ppri) bloquants.push('Zone inondable couverte par un PPRI');
  else if (inondable) eleves.push('Zone inondable sans PPRI identifié');
  if (inondable) fRis.push({ nom: 'inondation', valeur: { zone_inondable: true, ppri: sR?.inondation?.ppri ?? null }, effet: ppri ? 'bloquant' : 'élevé',
    explication: ppri ? "Le règlement du PPRI prime sur le PLU et peut interdire toute construction nouvelle." : "Zone inondable sans PPRI identifié : l'aléa existe, son opposabilité reste à établir." });

  const servIntersect = ev('servitudes')?.scope === 'parcel'
    && (val('servitudes') as Brut)?.intersection_demontree === true;
  if (servIntersect) {
    bloquants.push("Servitude d'utilité publique intersectant la parcelle");
    fRis.push({ nom: 'servitude_intersectante', valeur: (val('servitudes') as Brut)?.nb_intersectantes ?? true, effet: 'bloquant',
      explication: "Servitude opposable grevant le terrain : elle peut interdire ou contraindre fortement la construction." });
  }

  const seveso = num(sR?.seveso_haut_count) ?? 0;
  if (seveso > 0) {
    bloquants.push(`${seveso} site(s) SEVESO seuil haut`);
    fRis.push({ nom: 'seveso_seuil_haut', valeur: seveso, effet: 'bloquant',
      explication: "Un PPRT peut interdire la construction ou imposer des prescriptions lourdes." });
  }

  const argiles = String(sR?.argiles_alea ?? '');
  if (/fort/i.test(argiles)) { eleves.push('Retrait-gonflement des argiles : aléa fort'); fRis.push({ nom: 'argiles', valeur: argiles, effet: 'élevé', explication: "Aléa fort : étude géotechnique G1 obligatoire à la vente (loi ELAN), G2 avant construction, surcoût de fondations probable." }); }
  else if (/moyen/i.test(argiles)) { moderes.push('Retrait-gonflement des argiles : aléa moyen'); fRis.push({ nom: 'argiles', valeur: argiles, effet: 'modéré', explication: "Aléa moyen : étude géotechnique G1 obligatoire à la vente (loi ELAN)." }); }

  const seisme = num(sR?.seisme_zone) ?? null;
  if (seisme != null && seisme >= 4) { eleves.push(`Sismicité zone ${seisme}`); fRis.push({ nom: 'sismicite', valeur: seisme, effet: 'élevé', explication: 'Règles parasismiques renforcées applicables.' }); }
  else if (seisme === 3) { moderes.push('Sismicité zone 3'); fRis.push({ nom: 'sismicite', valeur: seisme, effet: 'modéré', explication: 'Règles parasismiques modérées applicables.' }); }

  const radon = num(sR?.radon_classe) ?? null;
  if (radon != null && radon >= 3) { eleves.push('Potentiel radon classe 3'); fRis.push({ nom: 'radon', valeur: radon, effet: 'élevé', explication: 'Dispositions de ventilation et mesurage recommandés.' }); }

  const comptages: Array<[string, string, string]> = [
    ['cavites_count', 'cavité(s) souterraine(s)', "Étude géotechnique nécessaire avant tout engagement."],
    ['mouvements_terrain_count', 'mouvement(s) de terrain', "Étude géotechnique nécessaire avant tout engagement."],
    ['sis_count', 'site(s) et sol(s) pollué(s) — SIS', "Étude de sols et attestation de prise en compte de la pollution exigibles au permis."],
  ];
  for (const [champ, libelle, expl] of comptages) {
    const n = num(sR?.[champ]) ?? 0;
    if (n > 0) { eleves.push(`${n} ${libelle}`); fRis.push({ nom: champ, valeur: n, effet: 'élevé', explication: expl }); }
  }
  const icpe = num(sR?.icpe_count) ?? 0;
  if (icpe > 0 && seveso === 0) { moderes.push(`${icpe} installation(s) classée(s)`); fRis.push({ nom: 'icpe', valeur: icpe, effet: 'modéré', explication: "Installations classées recensées sur la commune : vérifier les distances d'éloignement." }); }
  const catnat = num(sR?.catnat_count) ?? 0;
  if (catnat >= 3) { moderes.push(`${catnat} arrêté(s) de catastrophe naturelle`); fRis.push({ nom: 'catnat', valeur: catnat, effet: 'modéré', explication: 'Sinistralité récurrente sur la commune : impact assurantiel possible.' }); }
  if (sR?.feux_foret === true) { eleves.push('Zone à risque feux de forêt'); fRis.push({ nom: 'feux_foret', valeur: true, effet: 'élevé', explication: "Obligations légales de débroussaillement et contraintes d'accès pompiers possibles." }); }

  const bruitIntersect = ev('classement_sonore')?.scope === 'parcel';
  if (bruitIntersect) { eleves.push('Secteur affecté par le bruit intersectant la parcelle'); fRis.push({ nom: 'classement_sonore', valeur: (val('classement_sonore') as Brut)?.categorie ?? true, effet: 'élevé', explication: 'Isolement acoustique renforcé obligatoire pour les constructions nouvelles.' }); }

  const risqueEvaluable = ok('risques');
  const niveauRisque: Verdict['risque']['niveau'] =
    bloquants.length ? 'bloquant'
      : !risqueEvaluable ? 'indetermine'
      : eleves.length ? 'eleve'
      : moderes.length ? 'modere'
      : 'faible';

  if (!risqueEvaluable) {
    fRis.push({ nom: 'source_risques_indisponible', valeur: byCle.get('risques')?.motif ?? 'non interrogée', effet: 'indéterminé',
      explication: "La source Géorisques n'a pas répondu. Le niveau de risque ne peut pas être établi. « Faible » serait un contresens : l'absence de donnée n'est pas une absence de risque." });
  }

  // ─────────────────────────────────────────────────────────
  // FIABILITÉ DES DONNÉES (0-100)
  // FORMULE :
  //   part_confirmee = 100 × (nb evidences `confirmed` ÷ nb evidences qualifiables)
  //     (« qualifiables » = toutes sauf `not_applicable`)
  //   × facteur_precision  ( parcelle 1,00 · centre_commune 0,75 · aucune 0,50 )
  //   − 6 par source indisponible (statut 'ko')
  //   − 12 par contradiction détectée
  //   − 8 si la surface cadastrale est absente
  //   borné 0..100
  // ─────────────────────────────────────────────────────────
  const qualifiables = q.evidences.filter((e) => e.status !== 'not_applicable');
  const confirmees = qualifiables.filter((e) => e.status === 'confirmed');
  const partConfirmee = qualifiables.length ? (confirmees.length / qualifiables.length) * 100 : 0;
  const facteurPrecision = r.precision === 'parcelle' ? 1 : r.precision === 'centre_commune' ? 0.75 : 0.5;
  const nbKo = items.filter((i) => i.status === 'ko').length;
  const malusSurface = r.surface_m2 == null ? 8 : 0;
  const fiabilite = Math.max(0, Math.min(100, Math.round(
    partConfirmee * facteurPrecision - nbKo * 6 - contradictions.length * 12 - malusSurface,
  )));

  const fFia: Facteur[] = [
    { nom: 'part_donnees_confirmees', valeur: `${confirmees.length}/${qualifiables.length}`, effet: Math.round(partConfirmee),
      explication: `${confirmees.length} donnée(s) confirmée(s) sur ${qualifiables.length} qualifiable(s).` },
    { nom: 'precision_localisation', valeur: r.precision, effet: `× ${facteurPrecision}`,
      explication: r.precision === 'parcelle' ? 'Parcelle résolue au cadastre : aucune pénalité.'
        : r.precision === 'centre_commune' ? 'Repli sur le centre de la commune : les données géométriques ne décrivent pas le terrain.'
        : 'Aucune localisation exploitable.' },
    { nom: 'sources_indisponibles', valeur: nbKo, effet: -nbKo * 6, explication: `${nbKo} source(s) n'ont pas répondu (−6 chacune).` },
    { nom: 'contradictions', valeur: contradictions.length, effet: -contradictions.length * 12, explication: `${contradictions.length} contradiction(s) détectée(s) (−12 chacune).` },
    { nom: 'surface_cadastrale', valeur: r.surface_m2 ?? null, effet: -malusSurface, explication: r.surface_m2 == null ? 'Contenance non résolue (−8).' : 'Contenance cadastrale disponible.' },
  ];

  // Garde-fou : pas de « favorable » sur données trouées.
  let niveauPot: Verdict['potentiel']['niveau'] = sPot >= 3 ? 'favorable' : sPot >= 0 ? 'intermediaire' : 'defavorable';
  if (niveauPot === 'favorable' && fiabilite < 40) {
    niveauPot = 'intermediaire';
    fPot.push({ nom: 'plafonnement_fiabilite', valeur: fiabilite, effet: 'plafond',
      explication: `Potentiel plafonné à « intermédiaire » : la fiabilité des données (${fiabilite}/100) est insuffisante pour conclure favorablement.` });
  }

  // ─────────────────────────────────────────────────────────
  // RECOMMANDATION — évaluée de haut en bas, premier match retenu.
  //   écarter                    risque bloquant ET potentiel défavorable
  //   suspendre                  risque bloquant · OU risque indéterminé
  //                              · OU fiabilité < 30
  //   poursuivre_sous_conditions risque élevé · OU ≥ 1 contradiction
  //                              · OU fiabilité < 60 · OU potentiel non favorable
  //   poursuivre                 tout le reste
  // ─────────────────────────────────────────────────────────
  let reco: Verdict['recommandation']['valeur'];
  let motifReco: string;
  if (niveauRisque === 'bloquant' && niveauPot === 'defavorable') {
    reco = 'ecarter';
    motifReco = `Contrainte bloquante (${bloquants.join(' ; ')}) sur un potentiel défavorable : le dossier n'a pas d'issue raisonnable en l'état.`;
  } else if (niveauRisque === 'bloquant') {
    reco = 'suspendre';
    motifReco = `Contrainte potentiellement bloquante identifiée : ${bloquants.join(' ; ')}. Aucun engagement avant levée documentaire.`;
  } else if (niveauRisque === 'indetermine') {
    reco = 'suspendre';
    motifReco = "Le niveau de risque n'a pas pu être établi (source Géorisques indisponible). Aucun engagement sans état des risques.";
  } else if (fiabilite < 30) {
    reco = 'suspendre';
    motifReco = `Fiabilité des données trop faible (${fiabilite}/100) pour fonder une décision.`;
  } else if (niveauRisque === 'eleve' || contradictions.length > 0 || fiabilite < 60 || niveauPot !== 'favorable') {
    reco = 'poursuivre_sous_conditions';
    const raisons = [
      niveauRisque === 'eleve' ? 'niveau de risque élevé' : null,
      contradictions.length ? `${contradictions.length} contradiction(s) à lever` : null,
      fiabilite < 60 ? `fiabilité des données à ${fiabilite}/100` : null,
      niveauPot !== 'favorable' ? `potentiel ${niveauPot}` : null,
    ].filter(Boolean);
    motifReco = `Poursuite possible sous réserve de lever : ${raisons.join(', ')}.`;
  } else {
    reco = 'poursuivre';
    motifReco = `Aucun aléa bloquant, aucune contradiction, fiabilité des données à ${fiabilite}/100 et potentiel favorable.`;
  }
  motifReco += " La constructibilité reste indéterminable : elle ne dépend pas de ces indicateurs mais du règlement PLU opposable, non collecté par cette étude.";

  return {
    potentiel: {
      niveau: niveauPot, score: sPot, facteurs: fPot,
      formule: 'Somme de 5 facteurs entiers (tension_zonage, assainissement_collectif, pente_exploitable, liquidite_marche, rendement_brut_indicatif). ≥ +3 favorable · 0 à +2 intermédiaire · < 0 défavorable. Une donnée inconnue vaut 0 (neutre), jamais un signal positif. Plafonné à « intermédiaire » si fiabilité < 40.',
    },
    risque: {
      niveau: niveauRisque, facteurs: fRis, bloquants,
      formule: "Déclencheurs nommés, du plus grave au plus faible. BLOQUANT est absorbant : inondable avec PPRI, servitude intersectante démontrée ou SEVESO seuil haut forcent « bloquant », qu'aucun signal positif ni score de sécurité ne peut compenser. Source risques indisponible → « indéterminé », jamais « faible ».",
    },
    fiabilite: {
      score: fiabilite, facteurs: fFia,
      formule: '100 × (confirmées ÷ qualifiables) × facteur_précision (parcelle 1,00 · centre_commune 0,75 · aucune 0,50) − 6 × sources_indisponibles − 12 × contradictions − 8 si contenance absente. Borné 0-100.',
    },
    recommandation: {
      valeur: reco, motif: motifReco,
      formule: 'Cascade évaluée de haut en bas, premier match retenu : écarter (bloquant ET défavorable) → suspendre (bloquant · risque indéterminé · fiabilité < 30) → poursuivre sous conditions (risque élevé · contradiction · fiabilité < 60 · potentiel non favorable) → poursuivre.',
    },
    constructibilite: {
      statut: 'indeterminable',
      motif: "Le règlement PLU opposable n'est pas collecté par cette étude (limite d'architecture : il est extrait côté application, page Foncier). Sans zone, emprise au sol, hauteur, reculs, stationnement ni servitudes du PLU, aucune surface de plancher ni aucune capacité constructive ne peut être établie. Toute valeur avancée serait une invention.",
      condition_levee: "Fournir le règlement PLU de la zone via la page Foncier, ou produire un certificat d'urbanisme opérationnel.",
    },
  };
}

// =============================================================
// PHASE 1 / COUCHE 4 — PLAN D'ACTION
// =============================================================

/**
 * Chaque action est déclenchée par un fait constaté DANS CETTE ÉTUDE : une
 * donnée manquante, une portée insuffisante, un aléa nommé ou une
 * contradiction. Aucune action n'est émise « par principe ».
 */
function construirePlanAction(
  q: Qualification, items: SourceResult[], contradictions: Contradiction[], r: Resolved,
): ActionVerification[] {
  const out: ActionVerification[] = [];
  const byCle = new Map(items.map((i) => [i.cle, i]));
  const st = (cle: string) => (byCle.get(cle)?.stats ?? null) as Brut;
  const ev = (id: string) => q.parId.get(id);
  const val = (id: string): Brut => ev(id)?.value ?? null;
  const add = (a: ActionVerification) => { if (!out.some((x) => x.action === a.action)) out.push(a); };

  // ── Déclenché par : règlement PLU absent (constat systématique et vérifié) ──
  add({
    priorite: 'bloquante',
    action: "Consulter le règlement PLU opposable de la zone (règlement écrit, plan de zonage, OAP, annexes)",
    motif: "Constat de cette étude : aucune règle d'urbanisme n'est connue — la constructibilité est indéterminable.",
    organisme: "Commune — service urbanisme, ou Géoportail de l'urbanisme",
    document: "Règlement écrit de la zone + plan de zonage + orientations d'aménagement + liste des servitudes annexées",
  });
  add({
    priorite: 'bloquante',
    action: "Demander un certificat d'urbanisme opérationnel (CUb)",
    motif: "Constat de cette étude : ni les règles d'urbanisme, ni la desserte par les réseaux, ni les taxes d'aménagement applicables ne sont établies. Le CUb les cristallise pour 18 mois.",
    organisme: 'Commune — service urbanisme',
    document: "Certificat d'urbanisme opérationnel (article L.410-1 b du code de l'urbanisme)",
  });

  // ── Déclenché par : chaque contradiction réellement détectée ──
  for (const c of contradictions) {
    add({
      priorite: c.gravite === 'bloquante' ? 'bloquante' : 'importante',
      action: `Lever la contradiction : ${c.message.replace(/^Données contradictoires — vérification du document opposable requise\s*:?\s*/i, '')}`,
      motif: "Contradiction détectée entre deux signaux de cette étude. Aucune version n'a été retenue arbitrairement.",
      organisme: c.organisme,
      document: c.verification,
    });
  }

  // ── Déclenché par : précision de localisation dégradée ──
  if (r.precision !== 'parcelle') {
    add({
      priorite: 'bloquante',
      action: "Faire confirmer l'identifiant cadastral exact de la parcelle (IDU)",
      motif: `Constat de cette étude : la parcelle n'a pas été résolue au cadastre (précision « ${r.precision} »). Toutes les données géométriques valent pour le centre de la commune, et les sources strictement parcellaires n'ont pas été interrogées.`,
      organisme: 'DGFiP — service du cadastre',
      document: 'Relevé de propriété et extrait de plan cadastral',
    });
  }
  if (r.surface_m2 == null) {
    add({
      priorite: 'importante',
      action: 'Obtenir la contenance cadastrale de la parcelle',
      motif: "Constat de cette étude : la contenance n'a pas été résolue — aucun calcul d'emprise au sol ni de prix au m² de terrain n'est possible.",
      organisme: 'DGFiP — service du cadastre',
      document: "Relevé de propriété (contenance) ou document d'arpentage",
    });
  }

  // ── Déclenché par : aléas nommés réellement présents ──
  const sR = st('risques');
  if (sR?.inondation?.zone_inondable === true) {
    add({
      priorite: sR?.inondation?.ppri === true ? 'bloquante' : 'importante',
      action: "Obtenir le règlement du PPRI et le zonage réglementaire à la parcelle, ainsi que l'état des risques",
      motif: `Constat de cette étude : zone inondable identifiée${sR?.inondation?.ppri === true ? ' et couverte par un PPRI, dont le règlement prime sur le PLU' : ", sans PPRI identifié — l'opposabilité reste à établir"}.`,
      organisme: 'Préfecture / DDTM — Géorisques (ERRIAL)',
      document: 'Règlement et zonage du PPRI, état des risques et pollutions (ERP)',
    });
  }
  if (/fort|moyen/i.test(String(sR?.argiles_alea ?? ''))) {
    const fort = /fort/i.test(String(sR?.argiles_alea));
    add({
      priorite: fort ? 'bloquante' : 'importante',
      action: `Faire réaliser une étude géotechnique préalable G1${fort ? ', puis une étude G2 avant conception' : ''}`,
      motif: `Constat de cette étude : aléa retrait-gonflement des argiles « ${sR.argiles_alea} ». L'étude G1 est une obligation légale à la vente d'un terrain constructible en aléa moyen ou fort (loi ELAN).`,
      organisme: "Bureau d'études géotechniques",
      document: 'Étude géotechnique préalable G1 (norme NF P94-500)' + (fort ? ' puis étude de conception G2' : ''),
    });
  }
  const geotech: Array<[string, string, string]> = [
    ['cavites_count', 'cavité(s) souterraine(s) recensée(s)', 'Étude géotechnique et consultation de la base des cavités souterraines'],
    ['mouvements_terrain_count', 'mouvement(s) de terrain recensé(s)', 'Étude géotechnique de stabilité de pente'],
  ];
  for (const [champ, libelle, doc] of geotech) {
    const n = num(sR?.[champ]) ?? 0;
    if (n > 0) add({
      priorite: 'importante',
      action: 'Faire réaliser une étude géotechnique de site',
      motif: `Constat de cette étude : ${n} ${libelle} sur la commune.`,
      organisme: "Bureau d'études géotechniques / BRGM",
      document: doc,
    });
  }
  if ((num(sR?.sis_count) ?? 0) > 0) {
    add({
      priorite: 'importante',
      action: "Consulter la fiche du secteur d'information sur les sols et faire réaliser une étude de sols",
      motif: `Constat de cette étude : ${sR.sis_count} site(s) et sol(s) pollué(s) recensé(s) (SIS).`,
      organisme: 'Préfecture / Géorisques',
      document: "Fiche SIS et attestation de prise en compte de la pollution (article L.556-1 du code de l'environnement)",
    });
  }
  if ((num(sR?.seveso_haut_count) ?? 0) > 0) {
    add({
      priorite: 'bloquante',
      action: "Vérifier l'existence et le zonage d'un plan de prévention des risques technologiques (PPRT)",
      motif: `Constat de cette étude : ${sR.seveso_haut_count} site(s) SEVESO seuil haut. Un PPRT peut interdire la construction.`,
      organisme: 'Préfecture / DREAL',
      document: 'Règlement et zonage du PPRT',
    });
  }
  if ((num(sR?.radon_classe) ?? 0) >= 3) {
    add({
      priorite: 'recommandee',
      action: 'Prévoir un mesurage radon et des dispositions de ventilation',
      motif: `Constat de cette étude : potentiel radon classe ${sR.radon_classe}.`,
      organisme: 'IRSN / diagnostiqueur agréé',
      document: 'Mesurage radon et note de dimensionnement de la ventilation',
    });
  }
  if (sR?.feux_foret === true) {
    add({
      priorite: 'importante',
      action: "Vérifier les obligations légales de débroussaillement et les conditions d'accès des secours",
      motif: 'Constat de cette étude : commune classée à risque feux de forêt.',
      organisme: 'Préfecture / SDIS',
      document: "Arrêté préfectoral relatif au débroussaillement et prescriptions de défense extérieure contre l'incendie",
    });
  }
  if (byCle.get('risques')?.status !== 'ok') {
    add({
      priorite: 'bloquante',
      action: "Obtenir l'état des risques à l'adresse (ERRIAL)",
      motif: `Constat de cette étude : la source Géorisques n'a pas répondu (${byCle.get('risques')?.motif ?? 'motif inconnu'}). Aucun niveau de risque n'a pu être établi.`,
      organisme: 'Géorisques (service ERRIAL)',
      document: 'État des risques et pollutions (ERP)',
    });
  }

  // ── Déclenché par : servitudes / abords ──
  const evServ = ev('servitudes');
  if (byCle.get('servitudes')?.status !== 'ok') {
    add({
      priorite: 'importante',
      action: "Obtenir le plan des servitudes d'utilité publique annexé au PLU",
      motif: `Constat de cette étude : les servitudes n'ont pas pu être interrogées (${byCle.get('servitudes')?.motif ?? 'motif inconnu'}). Aucune servitude n'est connue — ce qui ne signifie pas qu'il n'y en a pas.`,
      organisme: "Commune / Géoportail de l'urbanisme",
      document: "Liste et plan des servitudes d'utilité publique annexés au PLU",
    });
  } else if (evServ && evServ.scope !== 'parcel') {
    add({
      priorite: 'importante',
      action: "Faire vérifier l'intersection des servitudes recensées avec le périmètre exact de la parcelle",
      motif: "Constat de cette étude : des servitudes sont recensées à proximité, mais la source ne démontre aucune intersection avec la parcelle. Le GPU n'est pas exhaustif.",
      organisme: 'Commune — service urbanisme / DDT',
      document: "Plan des servitudes d'utilité publique à l'échelle cadastrale",
    });
  }
  const evMon = ev('monument_historique');
  if (evMon && evMon.scope !== 'parcel') {
    add({
      priorite: 'importante',
      action: "Vérifier l'appartenance au périmètre délimité des abords et solliciter l'avis de l'ABF",
      motif: 'Constat de cette étude : un monument historique est signalé à proximité, sans intersection démontrée avec la parcelle.',
      organisme: 'UDAP — Architecte des Bâtiments de France',
      document: "Périmètre délimité des abords (PDA) et avis de l'ABF",
    });
  }

  // ── Déclenché par : portée communale de l'assainissement ──
  const modeAssain = (val('assainissement') as Brut)?.mode ?? null;
  if (byCle.get('assainissement')?.status === 'ok') {
    add({
      priorite: 'importante',
      action: modeAssain === 'non collectif'
        ? "Faire réaliser une étude de filière d'assainissement non collectif"
        : "Vérifier le zonage d'assainissement et la faisabilité du raccordement au droit de la parcelle",
      motif: `Constat de cette étude : le mode d'assainissement${modeAssain ? ` (« ${modeAssain} »)` : ''} est connu à l'échelle COMMUNALE uniquement. La desserte et la raccordabilité de la parcelle ne sont pas établies.`,
      organisme: modeAssain === 'non collectif' ? 'SPANC' : "Commune / gestionnaire du réseau d'assainissement",
      document: modeAssain === 'non collectif'
        ? 'Étude de sol et de filière ANC, avis du SPANC'
        : "Plan du zonage d'assainissement et avis de raccordement du gestionnaire de réseau",
    });
  } else {
    add({
      priorite: 'importante',
      action: "Obtenir le zonage d'assainissement de la commune",
      motif: `Constat de cette étude : la source assainissement n'a pas répondu (${byCle.get('assainissement')?.motif ?? 'motif inconnu'}).`,
      organisme: 'Commune / gestionnaire du réseau',
      document: "Plan du zonage d'assainissement collectif et non collectif",
    });
  }

  // ── Déclenché par : aucune source réseau n'est branchée dans cette étude ──
  // Ce n'est pas une section de rapport : c'est un manque assumé, converti en
  // action. Aucune donnée réseau n'est simulée nulle part dans ce fichier.
  add({
    priorite: 'importante',
    action: "Consulter les concessionnaires de réseaux (eau potable, électricité, gaz, télécommunications) et le service de défense extérieure contre l'incendie",
    motif: "Constat de cette étude : aucune source de desserte par les réseaux n'est interrogée. La présence, la capacité et la distance des réseaux au droit de la parcelle sont totalement inconnues, de même que la défense incendie.",
    organisme: 'Concessionnaires (Enedis, GRDF, service des eaux, opérateurs télécom) / SDIS',
    document: 'Réponses aux déclarations de projet de travaux (DT) et attestation de desserte / débit et pression du poteau incendie le plus proche',
  });

  // ── Déclenché par : pente mesurée forte, ou pente non mesurée ──
  const pente = ev('pente');
  const pv = typeof pente?.value === 'number' ? pente.value : null;
  if (pv != null && pente?.status === 'confirmed' && pv > 15) {
    add({
      priorite: 'importante',
      action: 'Faire réaliser un relevé topographique du terrain',
      motif: `Constat de cette étude : pente moyenne mesurée à ${pv} %. Le terrassement, l'accessibilité et l'implantation en dépendent directement.`,
      organisme: 'Géomètre-expert',
      document: 'Plan topographique coté et profil en long',
    });
  } else if (pente && pente.status !== 'confirmed') {
    add({
      priorite: 'recommandee',
      action: 'Faire réaliser un relevé topographique du terrain',
      motif: "Constat de cette étude : la pente n'est pas mesurée à la parcelle (donnée absente ou estimée au centre de la commune).",
      organisme: 'Géomètre-expert',
      document: 'Plan topographique coté',
    });
  }

  // ── Déclenché par : qualité de l'échantillon DVF ──
  if (q.dvf && q.dvf.reserves.length) {
    add({
      priorite: 'importante',
      action: "Consulter le détail des mutations DVF et faire établir un avis de valeur sur le segment de bien visé",
      motif: `Constat de cette étude : ${q.dvf.reserves.join(' ')}`,
      organisme: 'DGFiP (DVF) / expert immobilier',
      document: "Extraction DVF détaillée filtrée par catégorie de bien, ou avis de valeur motivé",
    });
  }

  // ── Déclenché par : classement sonore non interrogé ──
  if (byCle.get('bruit')?.status !== 'ok') {
    add({
      priorite: 'recommandee',
      action: 'Vérifier le classement sonore des infrastructures de transport terrestre',
      motif: `Constat de cette étude : le classement sonore n'a pas pu être consulté (${byCle.get('bruit')?.motif ?? 'motif inconnu'}). La couche n'est pas numérisée dans toutes les communes.`,
      organisme: 'Préfecture',
      document: 'Arrêté préfectoral de classement sonore et plan des secteurs affectés par le bruit',
    });
  }

  // ── Déclenché par : chaque autre source indisponible ──
  for (const it of items) {
    if (it.status !== 'ko') continue;
    if (['risques', 'servitudes', 'assainissement', 'bruit'].includes(it.cle)) continue; // déjà traités
    const def = SOURCES.find((s) => s.cle === it.cle);
    add({
      priorite: 'recommandee',
      action: `Obtenir par une autre voie : ${it.label.toLowerCase()}`,
      motif: `Constat de cette étude : source indisponible (${it.motif ?? 'motif inconnu'}).`,
      organisme: def?.organisme ?? 'organisme producteur',
      document: def?.dataset ?? 'jeu de données de référence',
    });
  }

  const rang: Record<ActionVerification['priorite'], number> = { bloquante: 0, importante: 1, recommandee: 2 };
  return out.sort((a, b) => rang[a.priorite] - rang[b.priorite]);
}

// =============================================================
// PHASE 1 — TABLEAU DE TRAÇABILITÉ
// =============================================================

interface LigneSource {
  donnee: string;
  organisme: string;
  jeu_de_donnees: string;
  millesime: string | null;
  portee: DataScope;
  statut: string;
  motif: string | null;
  duree_ms: number;
}

/** Généré depuis les réponses réelles. Aucune ligne codée en dur. */
function construireTableauSources(items: SourceResult[], r: Resolved): LigneSource[] {
  const lignes: LigneSource[] = items.map((it) => {
    const def = SOURCES.find((s) => s.cle === it.cle);
    return {
      donnee: it.label,
      organisme: def?.organisme ?? 'organisme non déclaré',
      jeu_de_donnees: def?.dataset ?? 'jeu de données non déclaré',
      millesime: pluckMillesime(it.stats) ?? null,
      portee: def ? def.scope(r) : 'municipality',
      statut: it.status,
      motif: it.motif ?? null,
      duree_ms: it.duree_ms,
    };
  });
  // Le cadastre et le PLU ne sont pas des SOURCES[] : ils entrent dans la
  // traçabilité par une autre voie et doivent y figurer quand même.
  lignes.unshift({
    donnee: 'Surface cadastrale (contenance) et centroïde',
    organisme: 'DGFiP / IGN',
    jeu_de_donnees: 'API Carto — parcellaire cadastral',
    millesime: null,
    portee: 'parcel',
    statut: r.surface_m2 != null ? 'ok' : 'ko',
    motif: r.surface_m2 != null ? null : 'parcelle non résolue au cadastre',
    duree_ms: 0,
  });
  lignes.push({
    donnee: 'Règlement PLU opposable',
    organisme: "Commune / Géoportail de l'urbanisme",
    jeu_de_donnees: 'Non collecté par cette fonction (extraction côté application)',
    millesime: null,
    portee: 'parcel',
    statut: 'ko',
    motif: "hors de portée d'une Edge Function — voir page Foncier",
    duree_ms: 0,
  });
  return lignes;
}

// ── Handler ──────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ status: 'error', summary: 'POST only', stats: null, items: [] }, 405);

  CORRECTIONS_APPLIQUEES = 0;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* {} */ }

  const idu = normStr(body.cadastral_ref) ?? normStr(body.parcel_id);
  let lat = num(body.lat);
  let lon = num(body.lon) ?? num(body.lng);
  let insee = normStr(body.code_insee);
  let commune = normStr(body.commune);
  let surface_m2 = num(body.surface_m2);
  const zip = normStr(body.zip_code) ?? normStr(body.code_postal);
  let precision: Resolved['precision'] = 'aucune';

  // 1) INSEE dérivé de l'IDU (tout identifiant cadastral commence par lui).
  if (!insee && idu) {
    const m = /^(2[ab]\d{3}|\d{5})/i.exec(idu.replace(/\s/g, ''));
    if (m) insee = m[1].toUpperCase();
  }
  // 2) Cadastre : centroïde + contenance. Interrogé même si lat/lon fournis,
  //    car la SURFACE est une donnée de décision (emprise, prix au m²).
  if (idu) {
    const p = await parcelleFromIdu(idu);
    if (p) {
      if (lat == null || lon == null) { lat = p.lat; lon = p.lon; }
      surface_m2 = surface_m2 ?? p.surface_m2;
      commune = commune ?? p.commune;
      precision = 'parcelle';
    }
  }
  if (precision === 'aucune' && lat != null && lon != null) precision = 'parcelle';

  // 3) Repli commune (INSEE / nom / code postal) — précision dégradée.
  if (!insee || lat == null || lon == null) {
    const g = await communeInfo({ insee, commune, zip });
    insee = insee ?? g.insee;
    commune = commune ?? g.nom;
    if (lat == null || lon == null) {
      if (g.lat != null && g.lon != null) { lat = g.lat; lon = g.lon; precision = 'centre_commune'; }
    }
  }

  if (!insee && (lat == null || lon == null)) {
    return json({
      status: 'no_localization',
      summary: "Étude impossible : fournir un identifiant cadastral (IDU), des coordonnées ou une commune.",
      stats: null, items: [],
    }, 200);
  }

  const resolved: Resolved = { idu, insee, commune, lat, lon, surface_m2, precision };
  const baseUrl = Deno.env.get('SUPABASE_URL');
  if (!baseUrl) return json({ status: 'error', summary: 'Missing SUPABASE_URL env', stats: null, items: [] }, 200);

  let key: string;
  try { key = serviceKey(); }
  catch (e) { return json({ status: 'error', summary: String(e), stats: null, items: [] }, 200); }

  // ── Collecte PARALLÈLE : une source morte ne bloque jamais le rapport ──
  const t0 = Date.now();
  const settled = await Promise.allSettled(SOURCES.map((s) => callSource(s, resolved, baseUrl, key)));
  const items: SourceResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { cle: SOURCES[i].cle, label: SOURCES[i].label, status: 'ko', summary: null, stats: null, motif: 'exception interne', duree_ms: 0 },
  );
  const dureeTotale = Date.now() - t0;

  // ── v4 : traçabilité portée par chaque item (additif) ──
  for (const it of items) {
    const def = SOURCES.find((s) => s.cle === it.cle);
    if (!def) continue;
    it.portee = def.scope(resolved);
    it.organisme = def.organisme;
    it.jeu_de_donnees = def.dataset;
    it.millesime = pluckMillesime(it.stats) ?? null;
  }

  // ── v4 : les quatre couches, en mémoire, sans I/O ──
  const t1 = Date.now();
  const qualification = qualifier(items, resolved);
  const contradictions = detecterContradictions(qualification, items, resolved);
  appliquerContradictions(qualification, contradictions);
  const verdict = calculerVerdict(qualification, items, contradictions, resolved);
  const planAction = construirePlanAction(qualification, items, contradictions, resolved);
  const tableauSources = construireTableauSources(items, resolved);
  const dureeQualification = Date.now() - t1;

  const ok = items.filter((i) => i.status === 'ok');
  const vides = items.filter((i) => i.status === 'no_data');
  const ko = items.filter((i) => i.status === 'ko');

  const avertissements: string[] = [];
  if (precision === 'centre_commune') {
    avertissements.push("Parcelle non localisée : les données géométriques (pente, solaire, risques) valent pour le centre de la commune et sont INDICATIVES. Les sources strictement parcellaires (servitudes, classement sonore) n'ont PAS été interrogées.");
  }
  if (surface_m2 == null) {
    avertissements.push("Surface cadastrale non résolue : tout raisonnement en emprise au sol ou en prix au m² de terrain est impossible.");
  }
  if (ko.length) {
    avertissements.push(`Sources indisponibles pour cette étude : ${ko.map((k) => k.label).join(', ')}. L'absence de donnée ne vaut pas absence de contrainte.`);
  }
  avertissements.push("Le règlement PLU n'est pas collecté par cette étude (il est extrait côté application, page Foncier) : aucune capacité constructive ne peut être déduite d'ici.");
  // ── v4 : chaque contradiction remonte dans les avertissements (exigé) ──
  for (const c of contradictions) avertissements.push(c.message);
  if (verdict.risque.niveau === 'bloquant') {
    avertissements.push(`Contrainte potentiellement BLOQUANTE : ${verdict.risque.bloquants.join(' ; ')}. Aucune donnée favorable ne la compense.`);
  }
  if (verdict.risque.niveau === 'indetermine') {
    avertissements.push("Le niveau de risque n'a pas pu être établi : la source Géorisques n'a pas répondu. Ne pas conclure à l'absence de risque.");
  }

  return json({
    status: ok.length > 0 ? 'ok' : (vides.length > 0 ? 'no_data' : 'error'),
    summary:
      `Étude de parcelle${commune ? ` — ${commune}` : ''}${idu ? ` (${idu})` : ''}` +
      `${surface_m2 != null ? `, ${surface_m2.toLocaleString('fr-FR')} m²` : ''} : ` +
      `${ok.length} source(s) exploitables, ${vides.length} sans donnée, ${ko.length} indisponible(s). ` +
      `Précision de localisation : ${precision}. ` +
      // ── v4 : le verdict entre dans le summary, que le LLM lit toujours ──
      `Verdict — potentiel ${verdict.potentiel.niveau}, risque ${verdict.risque.niveau}, ` +
      `fiabilité des données ${verdict.fiabilite.score}/100. ` +
      `Recommandation : ${verdict.recommandation.valeur.replace(/_/g, ' ')}. ` +
      `Constructibilité : indéterminable (règlement PLU non collecté).`,
    stats: {
      // ── v3 : champs conservés à l'identique (compatibilité ascendante) ──
      parcelle: {
        idu: idu ?? null,
        code_insee: insee ?? null,
        commune: commune ?? null,
        surface_m2: surface_m2 ?? null,      // ← contenance cadastrale
        lat: lat ?? null,
        lon: lon ?? null,
      },
      precision,
      sources_ok: ok.map((i) => i.cle),
      sources_sans_donnee: vides.map((i) => i.cle),
      sources_indisponibles: ko.map((i) => ({ cle: i.cle, motif: i.motif })),
      duree_ms: dureeTotale,
      avertissements,
      note_methode: "Collecte brute multi-sources, puis qualification, contrôle de cohérence et verdict DÉTERMINISTES calculés dans la fonction. MimmozIA rédige à partir de ces éléments : elle ne recalcule aucun verdict, n'arbitre aucune contradiction et n'extrapole aucune donnée absente. Chaque donnée porte sa portée géographique (scope) : une donnée « municipality » ne doit JAMAIS être formulée au droit de la parcelle.",

      // ── v4 : ajouts ────────────────────────────────────────
      evidences: qualification.evidences,
      coherence: {
        contradictions,
        nb_contradictions: contradictions.length,
        principe: "Aucune contradiction n'est arbitrée par la fonction. Chaque conflit est exposé et renvoyé au document opposable.",
      },
      verdict,
      plan_action: planAction,
      tableau_sources: tableauSources,
      qualite_dvf: qualification.dvf,
      corrections_texte: CORRECTIONS_APPLIQUEES,
      duree_qualification_ms: dureeQualification,
      lexique: {
        scope: {
          parcel: 'mesurée ou démontrée au droit de la parcelle',
          nearby: 'dans un voisinage (rayon de comparables, périmètre) — pas sur la parcelle',
          municipality: 'vaut pour toute la commune — ne dit rien de la parcelle',
          intermunicipality: "vaut pour l'intercommunalité",
          department: 'vaut pour le département',
          national: 'référence nationale',
        },
        status: {
          confirmed: 'fournie explicitement par la source, sans conflit',
          estimated: 'dérivée, extrapolée, ou mesurée à une portée dégradée',
          unavailable: "non fournie — n'implique JAMAIS une absence de contrainte",
          contradictory: 'signaux incompatibles — non arbitré, document opposable requis',
          not_applicable: 'la question ne se pose pas dans ce contexte',
        },
      },
    },
    items,
  }, 200);
});
