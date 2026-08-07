// ============================================================================
// MARKET STUDY INVESTISSEUR V1 - VERSION 1.5.1
// ============================================================================
// CHANGEMENTS v1.5.1 — deux défauts révélés par la première étude en réel
// MARQUEUR DE VERSION : constante `ROAD_SCORE_METHOD`
//
// 1. FIX — `nearest_stop_m` ne porte plus une distance de gare.
//    v1.5.0 y rangeait, en régime routier, la distance à la gare TER la plus
//    proche. L'écran et le Copilot l'ont fidèlement affichée sous le libellé du
//    champ : « Arrêt le plus proche : ~4 700 m » — pour la gare de
//    Saint-Jean-de-Luz, à 4,7 km, qu'on ne rejoint pas à pied. Le champ disait
//    « arrêt », le contenu était une gare. C'est le défaut du pilier
//    « environnement » qui mesurait des équipements : le nom lu à la place du
//    contenu. Le champ vaut désormais `null` en régime routier ; la distance à
//    la gare vit dans `rail.nearest_station_km`, dont le nom est exact.
//
// 2. FIX — la recette du score voyage avec le score.
//    v1.5.0 exposait la méthode de calcul des MINUTES (`estimation_method`)
//    mais rien sur la composition du SCORE. Interrogé sur le 83/100 d'Ascain,
//    le Copilot a comblé : « il mesure la facilité d'accès à un bassin
//    d'emplois et de services en voiture, via la grille zonage INSEE ». Deux
//    inventions — aucune donnée de bassin d'emploi n'entre dans ce calcul (le
//    critère a été écarté faute de centroïdes communaux), et la grille INSEE ne
//    mesure rien, elle choisit le régime.
//    Leçon déjà rencontrée trois fois cette semaine : un signal d'honnêteté ne
//    sert à rien s'il n'est pas relayé. Ici il n'existait même pas.
//    → `ROAD_SCORE_METHOD` / `TRANSIT_SCORE_METHOD` énoncent le barème, la
//      source unique, et surtout ce que le score NE mesure PAS. Exposés dans
//      `meta.perimetres.accessibilite_score_methode` et dans `scoring_details`.
//
// ============================================================================
// MARKET STUDY INVESTISSEUR V1 - VERSION 1.5.0
// ============================================================================
// CHANGEMENTS v1.5.0 — l'accessibilité à deux régimes
// MARQUEUR DE VERSION : constante `ROAD_REGIME_SCORE_CAP`
//
// Le problème. Depuis v1.4.0, Ascain ressortait avec un pilier accessibilité
// ÉCARTÉ : Overpass ne trouvait aucun arrêt dans le rayon d'1 km, et l'on
// refusait — à raison — de transformer ce vide en 0/100. Le verdict restait
// pourtant faux : la commune est desservie par le réseau Txik Txak, la gare TER
// de Saint-Jean-de-Luz est à 6,5 km et la gare TGV de Bayonne à 19,5 km.
//
// La cause n'était pas le seuil mais l'UNITÉ DE MESURE. Un rayon d'1 km mesure
// la marche vers un arrêt : c'est le bon critère dans une ville dense, et un
// critère sans objet dans une ceinture urbaine, où l'on rejoint une gare en
// voiture. Un seul barème, celui de la ville, était appliqué au territoire
// entier — et hors des villes il ne mesurait rien, ce qui se lisait « pas de
// donnée » alors que la donnée existait, ailleurs.
//
// La correction. Deux régimes, choisis sur `niveau_7` de la grille de densité
// INSEE — les sept niveaux, pas un binaire :
//   • niveau_7 1-3 → régime TRANSPORTS EN COMMUN. Barème inchangé.
//   • niveau_7 4-7 → régime ROUTIER. Gare TER/TGV la plus proche, distance
//     convertie en minutes de voiture ESTIMÉES, densité du réseau TER à 20 km.
//
// ⚠️ `niveau_7` n'est pas `niveau_3`. Ascain est URBAINE au sens niveau_3 = 2 et
//    relève du régime ROUTIER au sens niveau_7 = 4. Les deux prédicats répondent
//    à deux questions distinctes ; les confondre est la faute corrigée sur
//    `isRural` dans smartscore v4.6, qui faisait un libellé et une politique de
//    rayons avec la même variable.
//
// ⚠️ Source. `mobility_stops` en mode 'ter' (2 628) et 'tgv' (145) couvre la
//    France entière — vérifié : lat 42,43-51,02, lon -4,39-8,18. Le mode
//    'metro' (53 967) et la table `gtfs_stops` (119 428) sont en revanche
//    bornés à lat 47,96-49,46 / lon 1,15-3,56, c'est-à-dire l'Île-de-France
//    seule. Les utiliser hors IdF renverrait zéro, et ce zéro se lirait comme
//    une absence de desserte. Ne pas s'en servir ici.
//
// ⚠️ Les minutes sont une ESTIMATION, jamais une mesure : distance à vol
//    d'oiseau × 1,30 ÷ 55 km/h. Le champ `estimated: true` et
//    `estimation_method` accompagnent le chiffre partout où il circule.
//
// ⚠️ Plafond. Le régime routier est plafonné à 85/100. Sans ce plafond Ascain
//    sortait à 100 — le score d'une adresse parisienne — par cumul des bonus
//    TGV et densité TER. Deux régimes qui ne mesurent pas la même chose ne
//    peuvent pas partager la même échelle haute.
//
// ⚠️ Les bonus/malus du barème urbain (« Pas de transport lourd », -20 sur
//    bureaux) sont désormais conditionnés au régime. En régime routier,
//    `has_metro_train` et `has_tram` valent false par construction : appliquer
//    ce bloc aurait infligé un malus de -20 à une commune dont on venait
//    justement de mesurer l'accessibilité autrement.
//
// Non fait, et volontairement : le second critère « pôle d'emploi le plus
// proche » supposait des centroïdes communaux. Il n'en existe aucun en base —
// `v_commune_population` et `epci_communes` n'ont pas de coordonnées, `dvf_geo`
// est vide. Le seul substitut, le centroïde des équipements BPE, ne couvre que
// 23 441 communes sur 34 871, et manque précisément les petites communes
// rurales que ce régime vise. On aurait reconstruit le défaut qu'on corrige :
// une source lacunaire produisant quand même une valeur. Le critère retenu à la
// place — qualité du nœud ferroviaire, gare TGV et densité TER — s'appuie sur
// la même source complète. Le chargement des 34 875 centroïdes reste ouvert.
//
// ============================================================================
// MARKET STUDY INVESTISSEUR V1 - VERSION 1.4.4
// ============================================================================
// CHANGEMENTS v1.4.4 — le périmètre de chaque source, et non un rayon global
//
// Dernier maillon de la même série. `meta.radius_km` était exposé seul, et se
// lisait naturellement comme le rayon de toute l'étude : « les scores demande,
// offre et environnement sont calculés sur un rayon de 5 km autour de la
// parcelle ». Faux — les trois sont COMMUNAUX (INSEE, DVF filtré commune, BPE
// filtré depcom). En réalité `radius_km` ne gouverne QUE fetchEhpadConcurrence :
// pour un projet logement, il ne sert strictement à rien.
//   → `meta.perimetres` énumère ce que chaque source couvre réellement, et dit
//     explicitement à quoi `radius_km` s'applique — ou qu'il ne s'applique à
//     rien. Relayé au Copilot par copilot-chat.
//
// ============================================================================
// MARKET STUDY INVESTISSEUR V1 - VERSION 1.4.3
// ============================================================================
// CHANGEMENTS v1.4.3 — le pilier « environnement » ne mesure pas l'environnement
//
// Observé sur Ascain : le Copilot a conclu « un environnement qui score
// fortement (80/100), ce qui reflète un cadre favorable ». Or ce pilier vaut
// `bpe.score` majoré de bonus d'ÉQUIPEMENT : 65 + 10 (≥3 écoles) + 5
// (≥5 commerces) = 80. Il ne dit rien du cadre de vie, du paysage, du bruit ni
// des risques. Le nom a été lu à la place du contenu — et c'est notre faute,
// pas celle du modèle.
//   → Un `lexique_scores` est transmis au Copilot par copilot-chat, qui nomme
//     ce que chaque pilier mesure réellement.
//
// - FIX ASYMÉTRIE : les bonus d'équipement ne sont plus accordés sur un extrait
//   BPE partiel. Une catégorie absente ne pénalise jamais (aucun malus n'existe
//   dans ce calcul) tandis qu'une catégorie présente accorde un bonus : sur un
//   extrait incomplet, le score ne pouvait donc QUE monter, précisément là où
//   la donnée est la moins fiable. Ascain cumulait les deux défauts — extrait de
//   18 lignes, confiance « faible », et +10 pour « ≥ 3 écoles » accordé sur les
//   3 seules lignes C108 que contenait l'extrait.
//
// ============================================================================
// MARKET STUDY INVESTISSEUR V1 - VERSION 1.4.2
// ============================================================================
// CHANGEMENTS v1.4.2 — les décomptes BPE et leurs zéros
//
// Observé sur Ascain : « Total équipements dans le rayon : 18 · Pharmacies 0 ·
// Supermarchés 0 ». Deux erreurs de lecture, aucune inventée par le modèle :
//   • le BPE est filtré sur `depcom`, donc sur la COMMUNE — jamais sur un rayon.
//     `radius_km` ne s'applique qu'au transport ;
//   • l'extrait ne contient que 18 lignes (A206, B202×3, B206, B207×9, C108×3,
//     D307) et aucun code D301. « 0 pharmacie » traduit une lacune de la source,
//     pas une commune sans pharmacie — invraisemblable à 4 658 habitants.
// `bpe_quality` calculait déjà `full_coverage` et `zero_categories` : personne
// ne les lisait. On y ajoute le périmètre et un avertissement explicite sur les
// zéros, désormais relayés au Copilot par copilot-chat.
//
// ============================================================================
// MARKET STUDY INVESTISSEUR V1 - VERSION 1.4.1
// ============================================================================
// CHANGEMENTS v1.4.1 — géolocalisation de la parcelle (fix « Indisponible »)
//
// Symptôme : sur 64065000AI0002, deux réponses « 400 Impossible de
// géolocaliser » avant que le copilote ne réussisse au 3e essai. Cause :
// geocodeParcel → geocodeInseeCode → geo.api.gouv.fr, service injoignable
// depuis l'infra Supabase. Le contournement existait dans risk-study v1.0.3,
// il n'avait jamais été porté ici. Le succès final venait d'un géocodage par
// NOM de commune via la BAN — donc de coordonnées de CENTRE-BOURG : le
// « rayon d'analyse de 5 km » n'était pas centré sur le terrain, sans que rien
// ne le signale.
// - `geocodeParcel` interroge désormais Apicarto IGN (service cadastral
//   officiel, sans clé) et calcule le centroïde de la géométrie réelle.
//   Vérifié : 64065000AI0002 → 43,3480 / −1,6210, contenance 2 283 m².
// - La parcelle est testée en PREMIER dans resolveCoordinates (elle était en
//   4e position, après un géocodage par ville moins précis).
// - Repli commune conservé, mais ANNONCÉ dans le label (« position approchée :
//   centre de la commune »).
// - `resolveCommune` accepte un INSEE connu et bascule sur un repli hors-ligne
//   (département + libellé lu dans insee_grille_densite) si geo.api se tait.
// ⚠️ `cadastre_parcelles` en base ne couvre que l'Île-de-France (75, 77, 78,
//    91-95, 3,7 M parcelles) : aucune résolution locale possible hors IdF, d'où
//    la dépendance à Apicarto.
//
// CHANGEMENTS v1.4.0 — périmètre DVF et urbanité déterministe
//
// 1. FIX CRITIQUE — DVF interrogeait le DÉPARTEMENT, pas la commune.
//    `fetchDvfFromSupabase(dept, _communeNom)` — le nom de commune était
//    préfixé d'un underscore, donc volontairement inutilisé. Les trois requêtes
//    filtraient sur `.eq("code_departement", dept)` avec `.limit(500)`.
//    Conséquences, toutes présentées à l'utilisateur comme des faits locaux :
//      • la médiane départementale passait pour le prix du marché de la parcelle ;
//      • « 500 transactions » était le PLAFOND de la requête, pas un décompte,
//        et valait donc 500 pour toutes les communes de France ;
//      • la « fourchette » min–max reflétait les bornes de filtrage du code
//        (500 / 25 000 €/m²) autant que le marché.
//    Mesure sur Ascain (INSEE 64065) : l'étude affichait 4 184 €/m², soit
//    exactement la médiane des 500 dernières mutations du 64. Le marché communal
//    réel est de 5 902 €/m² sur 95 ventes → sous-évaluation de 29 %.
//    → Filtre communal via `code_commune`. ⚠️ Cette colonne est stockée SANS
//      zéro de tête ('65' pour Ascain, pas '065') : cf. dvfCodeCommuneFromInsee.
//    → Repli départemental conservé sous 10 ventes communales, mais DÉCLARÉ
//      (`perimetre`, `perimetre_label`) — jamais un chiffre départemental
//      déguisé en local.
//    → `nb_transactions_plafonne` expose la troncature.
//
// 2. FIX SCORING — les seuils du pilier offre étaient faussés par le point 1.
//    `nb_transactions > 50` était vrai en permanence (500) : le bonus de +15
//    « marché liquide » était acquis d'office et le malus des marchés atones
//    jamais déclenché. Le seuil `prix_m2_median > 5000` s'évaluait sur une
//    médiane départementale — Ascain ratait le bonus avec 4 184 alors que la
//    commune vaut 5 902. Ces deux règles ne s'appliquent plus qu'en périmètre
//    communal : au niveau départemental, le volume ne dit rien du marché local.
//
// 3. FIX — `is_urban` ne dépend plus d'Overpass ni de la population.
//    v1.3.7 décidait de l'urbanité selon le SUCCÈS d'un appel Overpass, avec
//    repli sur un seuil de 50 000 habitants. Mêmes entrées, verdict différent
//    selon la santé d'un serveur tiers — défaut déjà corrigé côté
//    market-study-promoteur-v1 (v1.3.24), jamais porté ici.
//    Faux négatif observé : Ascain, 4 658 hab., déclarée « zone non-urbaine »
//    alors que la grille INSEE la classe niveau_3 = 2, niveau_7 = 4
//    « Ceintures urbaines ». Elle n'est PAS rurale au sens INSEE.
//    → Lecture de `insee_grille_densite` (34 875 communes, millésime 2026),
//      déjà en base depuis le 05/08/2026. niveau_3 ∈ {1,2} = urbain.
//    → Overpass ne sert plus qu'à mesurer la DESSERTE. Son indisponibilité
//      donne `coverage: 'error'` sans altérer le verdict d'urbanité.
//    → `is_urban_source` distingue 'insee' (déterministe) de 'population'
//      (repli heuristique, à ne pas présenter comme un fait).
//
// 4. FIX — l'exclusion du pilier accessibilité a maintenant DEUX motifs.
//    Corriger le point 3 seul aurait aggravé la situation : Ascain devenant
//    urbaine, le pilier serait entré dans le calcul avec le score 0 d'un
//    Overpass n'ayant trouvé aucun arrêt — alors que la commune est desservie
//    par Txik Txak et que la gare TER de Saint-Jean-de-Luz est à 5,9 km. On
//    aurait troqué un faux « non applicable » contre un faux « 0/100 », ce qui
//    est pire : le zéro entre dans la moyenne, l'exclusion non.
//    → Le pilier n'est évalué que si une desserte a été RÉELLEMENT mesurée
//      (coverage 'ok' ET au moins un arrêt). Sinon il est écarté avec un motif
//      distinct : « non applicable » (rural INSEE) vs « non mesuré » (source
//      muette, ou aucun arrêt référencé dans OSM).
//    ⚠️ Reste à faire : la métrique d'accessibilité à deux régimes (niveaux
//      INSEE 1-3 → transports en commun ; 4-7 → minutes de voiture jusqu'à la
//      gare / au pôle d'emploi / à l'échangeur). Un promoteur à Ascain ne vend
//      pas « à 300 m du tram », il vend « 20 minutes de Saint-Jean-de-Luz ».
//
// ============================================================================
// VERSION 1.3.8
// ============================================================================
// CHANGEMENTS v1.3.8:
// - FEATURE DVF : calcul de evolution_prix_pct par comparaison de deux périodes
//   glissantes (médiane 0-12 mois vs médiane 12-24 mois). Minimum 5 transactions
//   par période requis ; valeurs aberrantes (|écart| > 50%) rejetées → null.
//   → 3 requêtes Supabase parallèles (récente, ancienne, toutes)
//   → log console [DVF] avec détail des deux médianes
//
// CHANGEMENTS v1.3.7:
// - FIX SCORING : Suppression du pilier Accessibilité/Transport pour les communes
//   non-urbaines (population < 50 000 et aucun arrêt Overpass trouvé).
//   → is_urban: boolean ajouté à TransportData
//   → fetchTransport reçoit population en paramètre
//   → computeDifferentiatedScores : si !is_urban, accessibilite exclu du score
//     global et son poids redistribué proportionnellement sur demande/offre/environnement
//   → transport_exclu exposé dans scores + scoring_details
//
// CHANGEMENTS v1.3.6 (fix appel navigateur):
// - FIX CRITIQUE: helper jsonResponse() centralisé pour CORS garanti sur 100%
//   des réponses (y compris erreurs, exceptions, timeouts).
// - FIX: safeFetch() wrapper pour tous les appels externes.
// - FIX: req.json() protégé — body vide ou malformé ne crashe plus le runtime.
// - FIX: Promise.all avec isolation individuelle.
// - FIX: suppression des valeurs `undefined` dans la réponse JSON.
// - FIX: transactions DVF limitées à 20.
// - FIX: BPE details limités à 8 par catégorie.
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

type ProjectType = 'logement' | 'commerce' | 'bureaux' | 'hotel' | 'residence_etudiante' | 'ehpad';
type Coverage = 'ok' | 'no_data' | 'partial' | 'error';

const VERSION = "1.5.1";
const GEO_API_BASE = "https://geo.api.gouv.fr";
const OVERPASS_API_URL = "https://overpass-api.de/api/interpreter";
const BAN_API_URL = "https://api-adresse.data.gouv.fr";

// v1.3.7 : seuil de population pour qualifier une commune d'urbaine
const URBAN_POP_THRESHOLD = 50_000;

// ── v1.5.0 — Paramètres du régime d'accessibilité ROUTIER ───────────────────
// Ces quatre constantes gouvernent une ESTIMATION, jamais une mesure. Elles
// sont nommées, exposées dans la réponse et commentées pour que le chiffre
// affiché soit auditable : personne ne doit avoir à deviner d'où sortent les
// minutes annoncées.
//
// Facteur de sinuosité : rapport moyen entre la distance routière réelle et la
// distance à vol d'oiseau. 1,30 est la valeur usuelle en France hors montagne.
const ROAD_DETOUR_FACTOR = 1.30;
// Vitesse moyenne porte-à-porte hors agglomération dense, feux et traversées
// de bourgs compris. Volontairement prudente.
const ROAD_AVG_SPEED_KMH = 55;
// Rayon de recherche des gares. 60 km : au-delà, une gare ne structure plus
// l'accessibilité quotidienne d'un logement.
const RAIL_SEARCH_RADIUS_KM = 60;
// Rayon de comptage de la densité du réseau TER.
const RAIL_DENSITY_RADIUS_KM = 20;
// ⚠️ Plafond du régime routier. Les deux régimes ne mesurent PAS la même chose :
// être à 9 minutes de voiture d'un TER n'équivaut pas à être à 300 m d'un métro.
// Sans ce plafond, Ascain sortait à 100/100 — soit le score d'une adresse
// parisienne — ce qui est exactement la forme d'inflation que la chaîne
// s'emploie à supprimer. Le régime routier plafonne donc sous le régime
// transports en commun, et le libellé dit lequel a été appliqué.
const ROAD_REGIME_SCORE_CAP = 85;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============================================================================
// HELPERS CENTRALISÉS — CORS + JSON SAFE
// ============================================================================

function cleanForJson(obj: unknown): unknown {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(cleanForJson);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    clean[k] = cleanForJson(v);
  }
  return clean;
}

function jsonResponse(body: unknown, status = 200): Response {
  const safe = cleanForJson(body);
  return new Response(JSON.stringify(safe), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function safeFetch(
  url: string,
  options?: RequestInit & { timeoutMs?: number },
): Promise<globalThis.Response | null> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { timeoutMs: _, ...fetchOpts } = options ?? {};
    const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
    return res;
  } catch (e) {
    console.warn(`[safeFetch] ${url.substring(0, 80)}… → ${String(e).substring(0, 120)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// PROJECT CONFIG avec SCORING DIFFÉRENCIÉ
// ============================================================================

interface ScoringWeights {
  demande: number;
  offre: number;
  accessibilite: number;
  environnement: number;
}

interface ProjectConfig {
  label: string;
  defaultRadiusKm: number;
  maxRadiusKm: number;
  weights: ScoringWeights;
  description: string;
}

const PROJECT_CONFIG: Record<ProjectType, ProjectConfig> = {
  logement: {
    label: "Logement",
    defaultRadiusKm: 5,
    maxRadiusKm: 10,
    weights: { demande: 0.30, offre: 0.25, accessibilite: 0.25, environnement: 0.20 },
    description: "Résidentiel - Pondération équilibrée",
  },
  commerce: {
    label: "Commerce",
    defaultRadiusKm: 3,
    maxRadiusKm: 5,
    weights: { demande: 0.35, offre: 0.15, accessibilite: 0.25, environnement: 0.25 },
    description: "Commerce - Focus pouvoir d'achat et flux",
  },
  bureaux: {
    label: "Bureaux",
    defaultRadiusKm: 3,
    maxRadiusKm: 5,
    weights: { demande: 0.20, offre: 0.20, accessibilite: 0.45, environnement: 0.15 },
    description: "Bureaux - Accessibilité prioritaire",
  },
  hotel: {
    label: "Hôtel",
    defaultRadiusKm: 5,
    maxRadiusKm: 10,
    weights: { demande: 0.30, offre: 0.25, accessibilite: 0.30, environnement: 0.15 },
    description: "Hôtel - Accessibilité et attractivité",
  },
  residence_etudiante: {
    label: "Résidence étudiante",
    defaultRadiusKm: 5,
    maxRadiusKm: 10,
    weights: { demande: 0.35, offre: 0.20, accessibilite: 0.30, environnement: 0.15 },
    description: "Étudiant - Pop jeune et transports",
  },
  ehpad: {
    label: "EHPAD / Résidence senior",
    defaultRadiusKm: 20,
    maxRadiusKm: 30,
    weights: { demande: 0.40, offre: 0.30, accessibilite: 0.15, environnement: 0.15 },
    description: "EHPAD - Pop senior et équipement zone",
  },
};

// ============================================================================
// DONNÉES DE RÉFÉRENCE STATIQUES
// ============================================================================

const TAUX_CHOMAGE_DEPT: Record<string, number> = {
  "75": 6.5, "92": 6.8, "78": 5.9, "69": 6.8, "13": 9.2, "31": 7.5, "33": 7.8, "06": 7.2,
  "59": 9.5, "62": 10.2, "93": 10.8, "95": 8.2, "default": 7.5
};

const REVENU_MEDIAN_DEPT_FALLBACK: Record<string, number> = {
  "01": 23800, "02": 20900, "03": 20600, "04": 21500, "05": 22100,
  "06": 26200, "07": 20900, "08": 21000, "09": 19800, "10": 21800,
  "11": 19800, "12": 21200, "13": 22000, "14": 22500, "15": 21400,
  "16": 20600, "17": 21600, "18": 20600, "19": 21000, "21": 22700,
  "22": 21400, "23": 19200, "24": 20500, "25": 23100, "26": 22000,
  "27": 22000, "28": 22800, "29": 22000, "30": 21000, "31": 23100,
  "32": 20500, "33": 23100, "34": 22000, "35": 23500, "36": 20200,
  "37": 22300, "38": 24200, "39": 22400, "40": 22100, "41": 22100,
  "42": 22000, "43": 21300, "44": 24100, "45": 22600, "46": 20700,
  "47": 20600, "48": 20600, "49": 22800, "50": 22200, "51": 23400,
  "52": 21200, "53": 22000, "54": 22100, "55": 20800, "56": 22500,
  "57": 22200, "58": 21000, "59": 21800, "60": 23200, "61": 21200,
  "62": 20800, "63": 22200, "64": 23200, "65": 21200, "66": 20200,
  "67": 24000, "68": 23300, "69": 25500, "70": 21600, "71": 21700,
  "72": 22300, "73": 23500, "74": 26800, "75": 27500, "76": 22600,
  "77": 25900, "78": 29200, "79": 21600, "80": 21100, "81": 20900,
  "82": 20700, "83": 24000, "84": 22900, "85": 22700, "86": 21900,
  "87": 20900, "88": 21300, "89": 21400, "90": 22600, "91": 26800,
  "92": 33500, "93": 20500, "94": 27000, "95": 24900,
  "2A": 21000, "2B": 20500,
  "971": 18500, "972": 18800, "973": 16500, "974": 18000, "976": 14500,
  "default": 22000,
};

const DEMOGRAPHICS_DEPT: Record<string, {
  pct_moins_15: number; pct_15_29: number; pct_30_44: number;
  pct_45_59: number; pct_60_74: number; pct_75_plus: number;
  pct_etudiants: number; pct_actifs: number
}> = {
  "75": { pct_moins_15: 14, pct_15_29: 22, pct_30_44: 24, pct_45_59: 18, pct_60_74: 13, pct_75_plus: 9, pct_etudiants: 12, pct_actifs: 52 },
  "69": { pct_moins_15: 18, pct_15_29: 20, pct_30_44: 22, pct_45_59: 19, pct_60_74: 13, pct_75_plus: 8, pct_etudiants: 10, pct_actifs: 48 },
  "31": { pct_moins_15: 18, pct_15_29: 21, pct_30_44: 22, pct_45_59: 18, pct_60_74: 13, pct_75_plus: 8, pct_etudiants: 11, pct_actifs: 49 },
  "33": { pct_moins_15: 17, pct_15_29: 18, pct_30_44: 20, pct_45_59: 20, pct_60_74: 15, pct_75_plus: 10, pct_etudiants: 8, pct_actifs: 46 },
  "34": { pct_moins_15: 17, pct_15_29: 19, pct_30_44: 19, pct_45_59: 19, pct_60_74: 16, pct_75_plus: 10, pct_etudiants: 9, pct_actifs: 44 },
  "92": { pct_moins_15: 18, pct_15_29: 18, pct_30_44: 24, pct_45_59: 20, pct_60_74: 12, pct_75_plus: 8, pct_etudiants: 8, pct_actifs: 52 },
  "93": { pct_moins_15: 22, pct_15_29: 20, pct_30_44: 22, pct_45_59: 18, pct_60_74: 11, pct_75_plus: 7, pct_etudiants: 7, pct_actifs: 46 },
  "94": { pct_moins_15: 20, pct_15_29: 18, pct_30_44: 22, pct_45_59: 20, pct_60_74: 12, pct_75_plus: 8, pct_etudiants: 7, pct_actifs: 48 },
  "06": { pct_moins_15: 15, pct_15_29: 14, pct_30_44: 17, pct_45_59: 20, pct_60_74: 20, pct_75_plus: 14, pct_etudiants: 5, pct_actifs: 40 },
  "83": { pct_moins_15: 16, pct_15_29: 13, pct_30_44: 17, pct_45_59: 21, pct_60_74: 20, pct_75_plus: 13, pct_etudiants: 4, pct_actifs: 40 },
  "23": { pct_moins_15: 14, pct_15_29: 11, pct_30_44: 14, pct_45_59: 22, pct_60_74: 23, pct_75_plus: 16, pct_etudiants: 2, pct_actifs: 38 },
  "03": { pct_moins_15: 15, pct_15_29: 12, pct_30_44: 15, pct_45_59: 22, pct_60_74: 22, pct_75_plus: 14, pct_etudiants: 3, pct_actifs: 39 },
  "default": { pct_moins_15: 18, pct_15_29: 16, pct_30_44: 19, pct_45_59: 20, pct_60_74: 17, pct_75_plus: 10, pct_etudiants: 6, pct_actifs: 45 },
};

// ============================================================================
// BPE TYPE CODES MAPPING
// ============================================================================

const BPE_TYPES: Record<string, { label: string; category: 'commerces' | 'sante' | 'services' | 'education' | 'loisirs' }> = {
  'A101': { label: 'Police', category: 'services' },
  'A104': { label: 'Gendarmerie', category: 'services' },
  'A203': { label: 'Banque', category: 'services' },
  'A206': { label: 'Bureau de poste', category: 'services' },
  'A207': { label: 'Relais poste', category: 'services' },
  'A208': { label: 'Agence postale', category: 'services' },
  'B101': { label: 'Hypermarché', category: 'commerces' },
  'B102': { label: 'Supermarché', category: 'commerces' },
  'B103': { label: 'Grande surface bricolage', category: 'commerces' },
  'B104': { label: 'Supérette', category: 'commerces' },
  'B105': { label: 'Épicerie', category: 'commerces' },
  'B201': { label: 'Boulangerie', category: 'commerces' },
  'B202': { label: 'Boucherie', category: 'commerces' },
  'B206': { label: 'Librairie', category: 'commerces' },
  'B207': { label: 'Magasin vêtements', category: 'commerces' },
  'B304': { label: 'Magasin électroménager', category: 'commerces' },
  'B305': { label: 'Magasin meubles', category: 'commerces' },
  'B311': { label: 'Station service', category: 'commerces' },
  'C101': { label: 'École maternelle', category: 'education' },
  'C102': { label: 'École maternelle RPI', category: 'education' },
  'C104': { label: 'École élémentaire', category: 'education' },
  'C105': { label: 'École élémentaire RPI', category: 'education' },
  'C201': { label: 'Collège', category: 'education' },
  'C301': { label: 'Lycée général', category: 'education' },
  'C302': { label: 'Lycée technologique', category: 'education' },
  'C303': { label: 'Lycée professionnel', category: 'education' },
  'C401': { label: 'STS-CPGE', category: 'education' },
  'C402': { label: 'Formation santé', category: 'education' },
  'C403': { label: 'Formation commerce', category: 'education' },
  'C409': { label: 'UFR', category: 'education' },
  'C501': { label: 'Institut universitaire', category: 'education' },
  'C502': { label: 'École ingénieurs', category: 'education' },
  'C503': { label: 'Enseignement général supérieur', category: 'education' },
  'C504': { label: 'EPCI', category: 'education' },
  'C509': { label: 'Autre enseignement supérieur', category: 'education' },
  'D101': { label: 'Hôpital', category: 'sante' },
  'D102': { label: 'Hôpital de proximité', category: 'sante' },
  'D103': { label: 'Clinique', category: 'sante' },
  'D106': { label: 'Urgences', category: 'sante' },
  'D107': { label: 'Maternité', category: 'sante' },
  'D108': { label: 'Centre de santé', category: 'sante' },
  'D201': { label: 'Médecin généraliste', category: 'sante' },
  'D202': { label: 'Spécialiste', category: 'sante' },
  'D206': { label: 'Chirurgien-dentiste', category: 'sante' },
  'D221': { label: 'Dentiste', category: 'sante' },
  'D232': { label: 'Infirmier', category: 'sante' },
  'D233': { label: 'Kinésithérapeute', category: 'sante' },
  'D301': { label: 'Pharmacie', category: 'sante' },
  'D302': { label: 'Laboratoire', category: 'sante' },
  'D307': { label: 'EHPAD', category: 'sante' },
  'F101': { label: 'Bassin de natation', category: 'loisirs' },
  'F102': { label: 'Boulodrome', category: 'loisirs' },
  'F103': { label: 'Tennis', category: 'loisirs' },
  'F104': { label: 'Équipement athlétisme', category: 'loisirs' },
  'F106': { label: 'Terrain de foot', category: 'loisirs' },
  'F107': { label: 'Salle multisports', category: 'loisirs' },
  'F108': { label: 'Salle de combat', category: 'loisirs' },
  'F109': { label: 'Salle fitness', category: 'loisirs' },
  'F111': { label: 'Roller-Skate', category: 'loisirs' },
  'F112': { label: 'Sports nautiques', category: 'loisirs' },
  'F113': { label: 'Terrain de golf', category: 'loisirs' },
  'F114': { label: 'Équitation', category: 'loisirs' },
  'F116': { label: 'Cinéma', category: 'loisirs' },
  'F117': { label: 'Théâtre', category: 'loisirs' },
  'F303': { label: 'Musée', category: 'loisirs' },
  'F306': { label: 'Bibliothèque', category: 'loisirs' },
};

const DATA_GOUV_BPE_API = "https://tabular-api.data.gouv.fr/api/resources";
const BPE_RESOURCE_ID = "7257eb8b-f2eb-48f5-9c06-172675496269";

// ============================================================================
// SUPABASE CLIENT
// ============================================================================

function getSupabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key);
}

// ============================================================================
// UTILITIES
// ============================================================================

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function safeNum(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === "number") return isNaN(val) ? null : val;
  const str = String(val).replace(",", ".").trim();
  if (!str) return null;
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

function normalizeProjectType(input: string | null | undefined): ProjectType {
  if (!input) return "logement";
  const n = input.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (n.includes("ehpad") || n.includes("retraite") || n.includes("senior") || n === "rss" || n.includes("residence_senior")) return "ehpad";
  if (n.includes("etudiant") || n === "residence_etudiante") return "residence_etudiante";
  if (n === "hotel" || n === "hotellerie") return "hotel";
  if (n === "bureaux" || n === "bureau" || n === "office") return "bureaux";
  if (n === "commerce" || n === "retail") return "commerce";
  return "logement";
}

// ============================================================================
// GEOCODING
// ============================================================================

interface GeocodedLocation {
  lat: number;
  lon: number;
  source: 'address' | 'insee' | 'parcel' | 'coordinates';
  label?: string;
}

async function geocodeAddress(address: string): Promise<GeocodedLocation | null> {
  try {
    const url = `${BAN_API_URL}/search/?q=${encodeURIComponent(address)}&limit=1`;
    const res = await safeFetch(url, { timeoutMs: 8000 });
    if (!res || !res.ok) return null;
    const data = await res.json();
    if (!data?.features?.length) return null;
    const feature = data.features[0];
    const [lon, lat] = feature.geometry.coordinates;
    return { lat, lon, source: 'address', label: feature.properties?.label || address };
  } catch { return null; }
}

async function geocodeInseeCode(codeInsee: string): Promise<GeocodedLocation | null> {
  try {
    const url = `${GEO_API_BASE}/communes/${codeInsee}?fields=centre,nom&format=json`;
    const res = await safeFetch(url, { timeoutMs: 8000 });
    if (!res || !res.ok) return null;
    const data = await res.json();
    if (!data?.centre?.coordinates) return null;
    const [lon, lat] = data.centre.coordinates;
    return { lat, lon, source: 'insee', label: data.nom || codeInsee };
  } catch { return null; }
}

// ── v1.4.1 — Résolution de parcelle par Apicarto IGN ────────────────────────
// AVANT : geocodeParcel extrayait l'INSEE des 5 premiers caractères puis
// appelait geocodeInseeCode → geo.api.gouv.fr, service injoignable depuis
// l'infra Supabase (contournement déjà posé dans risk-study v1.0.3, jamais
// porté ici). Résultat observé sur 64065000AI0002 : deux réponses
// « 400 Impossible de géolocaliser » avant que le copilote ne se rabatte sur un
// géocodage par NOM de commune via la BAN.
// Deux défauts en un :
//   1. l'étude échouait alors que l'identifiant portait toute l'information ;
//   2. quand elle finissait par passer, les coordonnées étaient celles du
//      CENTRE-BOURG — le « rayon d'analyse de 5 km » n'était donc pas centré
//      sur la parcelle. Silencieux, et invisible dans la réponse.
// Apicarto est le service cadastral officiel de l'IGN, sans clé, et renvoie la
// géométrie réelle. Note : `cadastre_parcelles` en base ne couvre que
// l'Île-de-France (75, 77, 78, 91-95) — aucune résolution locale possible ici.
const APICARTO_CADASTRE_URL = "https://apicarto.ign.fr/api/cadastre/parcelle";

// Centroïde d'une géométrie GeoJSON (Polygon / MultiPolygon), sans dépendance.
// Moyenne des sommets de l'anneau extérieur : suffisant pour centrer un rayon
// de plusieurs kilomètres sur une parcelle de quelques milliers de m².
function centroidFromGeoJson(geometry: unknown): { lat: number; lon: number } | null {
  const g = geometry as { type?: string; coordinates?: unknown };
  if (!g?.coordinates) return null;
  const rings: number[][][] = g.type === 'MultiPolygon'
    ? (g.coordinates as number[][][][]).map((poly) => poly[0])
    : g.type === 'Polygon'
      ? [(g.coordinates as number[][][])[0]]
      : [];
  let sumLat = 0, sumLon = 0, n = 0;
  for (const ring of rings) {
    for (const pt of ring ?? []) {
      const [lon, lat] = pt;
      if (Number.isFinite(lat) && Number.isFinite(lon)) { sumLat += lat; sumLon += lon; n++; }
    }
  }
  return n > 0 ? { lat: sumLat / n, lon: sumLon / n } : null;
}

// Découpe un IDU à 14 caractères : INSEE(5) + com_abs(3) + section(2) + numéro(4).
function parseParcelId(parcelId: string): { codeInsee: string; section: string; numero: string } | null {
  const clean = parcelId.replace(/\s/g, '').toUpperCase();
  if (clean.length < 14) return null;
  return {
    codeInsee: clean.substring(0, 5),
    section: clean.substring(8, 10),
    numero: clean.substring(10, 14),
  };
}

async function geocodeParcel(parcelId: string): Promise<GeocodedLocation | null> {
  try {
    const parts = parseParcelId(parcelId);
    if (!parts) return null;
    const { codeInsee, section, numero } = parts;

    // 1. Apicarto IGN — géométrie réelle de la parcelle (source privilégiée).
    try {
      const url = `${APICARTO_CADASTRE_URL}?code_insee=${codeInsee}`
        + `&section=${encodeURIComponent(section)}&numero=${encodeURIComponent(numero)}`;
      const res = await safeFetch(url, { timeoutMs: 10000 });
      if (res && res.ok) {
        const data = await res.json();
        const feature = data?.features?.[0];
        const c = feature ? centroidFromGeoJson(feature.geometry) : null;
        if (c) {
          const nom = feature?.properties?.nom_com ?? codeInsee;
          console.log(`[Parcelle] ${parcelId} résolue par Apicarto → ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)} (${nom})`);
          return {
            lat: c.lat, lon: c.lon, source: 'parcel',
            label: `Parcelle ${parcelId} — ${nom}`,
          };
        }
      }
      console.warn(`[Parcelle] Apicarto sans résultat pour ${parcelId} → repli commune`);
    } catch (e) {
      console.warn(`[Parcelle] Apicarto en échec pour ${parcelId}:`, e);
    }

    // 2. Repli : centre de la commune via geo.api. Dégradé — ce n'est PAS la
    //    parcelle, donc le repli est explicite dans le label.
    const communeGeo = await geocodeInseeCode(codeInsee);
    if (communeGeo) {
      return {
        ...communeGeo, source: 'parcel',
        label: `Parcelle ${parcelId} (position approchée : centre de la commune)`,
      };
    }
    return null;
  } catch { return null; }
}

async function resolveCoordinates(payload: {
  lat?: number; lon?: number; address?: string;
  commune_insee?: string; code_insee?: string;
  parcel_id?: string; zipCode?: string; city?: string;
}): Promise<GeocodedLocation | null> {
  if (typeof payload.lat === 'number' && typeof payload.lon === 'number' && !isNaN(payload.lat) && !isNaN(payload.lon)) {
    return { lat: payload.lat, lon: payload.lon, source: 'coordinates' };
  }
  // v1.4.1 — La parcelle passe AVANT l'adresse et la ville : c'est la donnée la
  // plus précise dont on dispose. Elle était testée en 4e position, après un
  // géocodage par nom de commune qui renvoie un centre-bourg — l'étude pouvait
  // donc être centrée à des kilomètres du terrain alors que l'identifiant
  // cadastral exact était fourni.
  if (payload.parcel_id && payload.parcel_id.length >= 10) {
    const result = await geocodeParcel(payload.parcel_id);
    if (result) return result;
  }
  if (payload.address && payload.address.trim().length > 3) {
    const result = await geocodeAddress(payload.address);
    if (result) return result;
  }
  if (payload.zipCode && payload.city) {
    const result = await geocodeAddress(`${payload.city}, ${payload.zipCode}`);
    if (result) return result;
  }
  const inseeCode = payload.commune_insee || payload.code_insee;
  if (inseeCode && inseeCode.length === 5) {
    const result = await geocodeInseeCode(inseeCode);
    if (result) return result;
  }
  return null;
}

// ============================================================================
// COMMUNE RESOLUTION
// ============================================================================

interface CommuneInfo {
  code_insee: string;
  nom: string | null;
  departement: string | null;
  region: string | null;
  population: number | null;
}

// v1.4.1 — Repli hors-ligne quand geo.api ne répond pas. Si un code INSEE est
// connu (fourni dans le payload ou extrait de l'identifiant de parcelle), on
// construit la commune sans réseau : le département (2 premiers chiffres) suffit
// aux fallbacks internes, et le libellé vient de insee_grille_densite, déjà en
// base. Même philosophie que risk-study v1.0.3 — ne pas laisser un service tiers
// injoignable faire échouer toute l'étude.
async function resolveCommuneOffline(codeInsee: string): Promise<CommuneInfo> {
  let nom: string | null = null;
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("insee_grille_densite")
      .select("libelle")
      .eq("code_insee", codeInsee)
      .maybeSingle();
    nom = data?.libelle ?? null;
  } catch { /* le nom reste null : cosmétique, non bloquant */ }

  console.warn(`[Commune] geo.api injoignable → repli hors-ligne INSEE ${codeInsee}${nom ? ` (${nom})` : ''}`);
  return {
    code_insee: codeInsee,
    nom,
    departement: codeInsee.substring(0, 2),
    region: null,
    population: null,
  };
}

async function resolveCommune(
  lat: number, lon: number,
  codeInseeConnu?: string | null,
): Promise<CommuneInfo | null> {
  try {
    const url = `${GEO_API_BASE}/communes?lat=${lat}&lon=${lon}&fields=code,nom,departement,region,population&limit=1`;
    const res = await safeFetch(url, { timeoutMs: 8000 });
    if (res && res.ok) {
      const data = await res.json();
      if (data?.length) {
        const c = data[0];
        return {
          code_insee: c.code,
          nom: c.nom,
          departement: c.departement?.code || null,
          region: c.region?.nom || null,
          population: c.population ?? null,
        };
      }
    }
  } catch { /* on tombe sur le repli ci-dessous */ }

  if (codeInseeConnu && /^(\d{5}|2[AB]\d{3})$/.test(codeInseeConnu)) {
    return await resolveCommuneOffline(codeInseeConnu);
  }
  return null;
}

// ============================================================================
// DVF FROM SUPABASE — v1.3.8 : calcul evolution_prix_pct
// ============================================================================

interface DvfData {
  nb_transactions: number;
  prix_m2_median: number | null;
  prix_m2_moyen: number | null;
  prix_m2_min: number | null;
  prix_m2_max: number | null;
  evolution_prix_pct: number | null;
  transactions: Array<{
    date_mutation: string;
    valeur_fonciere: number;
    surface_reelle_bati: number | null;
    type_local: string;
    commune: string;
    prix_m2: number | null;
  }>;
  coverage: Coverage;
  // v1.4.0 — Périmètre réellement interrogé, et sincérité du décompte.
  // Sans ces trois champs, une médiane départementale se lisait comme locale
  // et un plafond de requête comme un nombre de ventes.
  perimetre: 'commune' | 'departement' | null;
  perimetre_label: string | null;
  nb_transactions_plafonne: boolean;
}

// v1.4.0 — La table `dvf` stocke `code_commune` SANS zéro de tête ('65' pour
// Ascain, et non '065'). La clé INSEE complète est donc
// code_departement || lpad(code_commune, 3, '0') → '64' + '065' = '64065'.
// Inversement, depuis un INSEE à 5 chiffres, le code commune DVF est le suffixe
// à 3 chiffres débarrassé de ses zéros de tête.
function dvfCodeCommuneFromInsee(insee: string): string | null {
  if (!/^\d{5}$/.test(insee) && !/^(2A|2B)\d{3}$/.test(insee)) return null;
  return String(Number(insee.slice(-3)));
}

// Nombre de ventes communales en dessous duquel une médiane n'est pas
// statistiquement exploitable : on bascule alors sur le département, mais en
// le DISANT (perimetre: 'departement').
const DVF_MIN_VENTES_COMMUNE = 10;
const DVF_LIMIT = 500;

async function fetchDvfFromSupabase(
  dept: string | null,
  _communeNom: string | null,
  communeInsee?: string | null,
): Promise<DvfData> {
  const empty: DvfData = {
    nb_transactions: 0, prix_m2_median: null, prix_m2_moyen: null,
    prix_m2_min: null, prix_m2_max: null, evolution_prix_pct: null,
    transactions: [], coverage: "no_data",
    perimetre: null, perimetre_label: null, nb_transactions_plafonne: false,
  };

  if (!dept) return empty;

  try {
    const supabase = getSupabaseClient();

    // Calcul des bornes temporelles dynamiques
    const now = new Date();
    const dateRecente = new Date(now);
    dateRecente.setFullYear(dateRecente.getFullYear() - 1);
    const dateAncienne = new Date(now);
    dateAncienne.setFullYear(dateAncienne.getFullYear() - 2);
    const dateRecenteStr  = dateRecente.toISOString().split("T")[0];
    const dateAncienneStr = dateAncienne.toISOString().split("T")[0];

    // ── v1.4.0 : détermination du périmètre ──────────────────────────────────
    // AVANT : toutes les requêtes filtraient sur `.eq("code_departement", dept)`
    // avec `.limit(500)`. Résultat : la médiane des 500 dernières mutations du
    // DÉPARTEMENT était présentée comme le prix du marché local, et « 500 »
    // comme un nombre de transactions. Sur Ascain (64065) cela donnait
    // 4 184 €/m² / « 500 transactions » là où la commune vaut réellement
    // 5 902 €/m² sur 95 ventes — une sous-évaluation de 29 % du marché local,
    // qui pilotait en plus le score d'offre (seuils 50 ventes et 5 000 €/m²).
    const codeCommuneDvf = communeInsee ? dvfCodeCommuneFromInsee(communeInsee) : null;

    // Applique le périmètre choisi à une requête. Le filtre départemental est
    // conservé même en mode commune : `code_commune` n'est unique qu'à
    // l'intérieur d'un département.
    const scope = <T>(q: T, mode: 'commune' | 'departement'): T => {
      const qq = (q as any).eq("code_departement", dept);
      return (mode === 'commune' && codeCommuneDvf
        ? qq.eq("code_commune", codeCommuneDvf)
        : qq) as T;
    };

    const baseSelect = (cols: string) =>
      supabase.from("dvf").select(cols)
        .not("prix_m2", "is", null)
        .gte("prix_m2", 500)
        .lte("prix_m2", 25000);

    // Sonde communale : y a-t-il assez de ventes pour une médiane locale ?
    let mode: 'commune' | 'departement' = 'departement';
    if (codeCommuneDvf) {
      const sonde = await scope(baseSelect("prix_m2"), 'commune').limit(DVF_LIMIT);
      if (!sonde.error && (sonde.data?.length ?? 0) >= DVF_MIN_VENTES_COMMUNE) {
        mode = 'commune';
      } else {
        console.warn(
          `[DVF] commune ${communeInsee} : ${sonde.data?.length ?? 0} vente(s) exploitable(s)` +
          ` (< ${DVF_MIN_VENTES_COMMUNE}) → repli DÉCLARÉ sur le département ${dept}`
        );
      }
    }

    const [resAll, resRecent, resOld] = await Promise.all([
      // Toutes transactions — stats globales + liste des 20 dernières
      scope(
        baseSelect("date_mutation, valeur_fonciere, surface_reelle_bati, type_local, commune, prix_m2"),
        mode,
      ).order("date_mutation", { ascending: false }).limit(DVF_LIMIT),

      // Période récente : 0-12 mois
      scope(baseSelect("prix_m2"), mode).gte("date_mutation", dateRecenteStr).limit(DVF_LIMIT),

      // Période ancienne : 12-24 mois
      scope(baseSelect("prix_m2"), mode)
        .gte("date_mutation", dateAncienneStr)
        .lt("date_mutation", dateRecenteStr)
        .limit(DVF_LIMIT),
    ]);

    if (resAll.error || !resAll.data?.length) return empty;
    const data = resAll.data;

    // Stats globales
    const prixM2Values = data
      .map((d: Record<string, unknown>) => d.prix_m2 as number)
      .filter((p): p is number => p != null);

    const medianPrice = median(prixM2Values);
    const avgPrice = prixM2Values.length
      ? Math.round(prixM2Values.reduce((a, b) => a + b, 0) / prixM2Values.length)
      : null;

    // Calcul évolution — v1.3.8
    let evolution_prix_pct: number | null = null;
    const prixRecents = (resRecent.data ?? [])
      .map((d: Record<string, unknown>) => d.prix_m2 as number)
      .filter((p): p is number => p != null);
    const prixAnciens = (resOld.data ?? [])
      .map((d: Record<string, unknown>) => d.prix_m2 as number)
      .filter((p): p is number => p != null);

    if (prixRecents.length >= 5 && prixAnciens.length >= 5) {
      const medianeRecente  = median(prixRecents);
      const medianeAncienne = median(prixAnciens);
      if (medianeRecente !== null && medianeAncienne !== null && medianeAncienne > 0) {
        const pct = ((medianeRecente - medianeAncienne) / medianeAncienne) * 100;
        if (Math.abs(pct) <= 50) {
          evolution_prix_pct = Math.round(pct * 10) / 10;
        } else {
          console.warn(`[DVF] évolution ${dept}: écart aberrant (${Math.round(pct * 10) / 10}%) → null`);
        }
        console.log(
          `[DVF] évolution ${dept}: récents=${prixRecents.length} (${Math.round(medianeRecente ?? 0)}€/m²)` +
          ` anciens=${prixAnciens.length} (${Math.round(medianeAncienne ?? 0)}€/m²)` +
          ` → ${evolution_prix_pct !== null ? evolution_prix_pct + "%" : "null (aberrant)"}`
        );
      }
    } else {
      console.log(
        `[DVF] évolution ${dept}: données insuffisantes — récents=${prixRecents.length}, anciens=${prixAnciens.length} (min 5 requis)`
      );
    }

    return {
      nb_transactions: data.length,
      prix_m2_median: medianPrice ? Math.round(medianPrice) : null,
      prix_m2_moyen: avgPrice,
      prix_m2_min: prixM2Values.length ? Math.min(...prixM2Values) : null,
      prix_m2_max: prixM2Values.length ? Math.max(...prixM2Values) : null,
      evolution_prix_pct,
      transactions: data.slice(0, 20).map((d: Record<string, unknown>) => ({
        date_mutation: String(d.date_mutation ?? ""),
        valeur_fonciere: Number(d.valeur_fonciere ?? 0),
        surface_reelle_bati: safeNum(d.surface_reelle_bati),
        type_local: String(d.type_local ?? "Inconnu"),
        commune: String(d.commune ?? ""),
        prix_m2: safeNum(d.prix_m2),
      })),
      coverage: "ok",
      // Le périmètre est exposé pour que ni l'écran ni le copilote ne puissent
      // présenter une médiane départementale comme locale.
      perimetre: mode,
      perimetre_label: mode === 'commune'
        ? `commune ${communeInsee}`
        : `département ${dept} (repli : pas assez de ventes communales)`,
      // `nb_transactions` est le nombre de lignes RENVOYÉES. S'il touche le
      // plafond, c'est une borne inférieure, pas un décompte.
      nb_transactions_plafonne: data.length >= DVF_LIMIT,
    };
  } catch (e) {
    console.error("[DVF] Error:", e);
    return empty;
  }
}

// ============================================================================
// EHPAD TARIFS FROM SUPABASE
// ============================================================================

interface EhpadTarifParsed {
  finess: string;
  departement: string;
  prix_hebergement_simple: number | null;
  prix_hebergement_double: number | null;
  tarif_gir_1_2: number | null;
  tarif_gir_3_4: number | null;
  tarif_gir_5_6: number | null;
}

async function fetchEhpadTarifsFromSupabase(dept: string | null): Promise<EhpadTarifParsed[]> {
  if (!dept) return [];
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("ehpad_tarifs")
      .select(`"finessEt", "prixHebPermCs", "prixHebPermCd", "prixHebTempCs", "prixHebTempCd", "TARIF_GIR_12", "TARIF_GIR_34", "TARIF_GIR_56"`)
      .ilike("finessEt", `${dept}%`)
      .limit(200);

    if (error || !data?.length) return [];

    return data.map((row: Record<string, unknown>) => ({
      finess: String(row.finessEt ?? ""),
      departement: String(row.finessEt ?? "").substring(0, 2) || dept,
      prix_hebergement_simple: safeNum(row.prixHebPermCs),
      prix_hebergement_double: safeNum(row.prixHebPermCd),
      tarif_gir_1_2: safeNum(row.TARIF_GIR_12),
      tarif_gir_3_4: safeNum(row.TARIF_GIR_34),
      tarif_gir_5_6: safeNum(row.TARIF_GIR_56),
    }));
  } catch (e) {
    console.error("[EHPAD_TARIFS] Error:", e);
    return [];
  }
}

// ============================================================================
// FILOSOFI DATA FROM SUPABASE
// ============================================================================

const FILOSOFI_MED_RE = /^med(\d{2})$/i;
const FILOSOFI_TXPAU_RE = /^txpau(\d{2})$/i;
const FILOSOFI_PARTIMP_RE = /^partimp(\d{2})$/i;

const LONG_FORM_MED_CANDIDATES = ["mediane_du_niveau_de_vie", "mediane_niveau_de_vie", "mediane_revenu_disponible", "med_niveau_vie", "mediane_rev_disp_uc"];
const LONG_FORM_TXPAU_CANDIDATES = ["taux_de_pauvrete", "taux_pauvrete", "tx_pauvrete"];
const LONG_FORM_PARTIMP_CANDIDATES = ["part_des_menages_fiscaux_imposes", "part_menages_imposes", "pct_menages_imposes"];

interface FilosofiResult {
  revenu_median: number | null;
  incomeMedianUcEur: number | null;
  incomeMedianUcYear: number | null;
  taux_pauvrete: number | null;
  part_menages_imposes: number | null;
  source: 'filosofi_long' | 'filosofi_short' | 'none';
  coverage: Coverage;
  warnings: string[];
}

function findLatestColumn(keys: string[], pattern: RegExp): { key: string; year: number } | null {
  let best: { key: string; year: number } | null = null;
  for (const k of keys) {
    const m = k.match(pattern);
    if (m) {
      const yearSuffix = parseInt(m[1], 10);
      const year = yearSuffix < 100 ? 2000 + yearSuffix : yearSuffix;
      if (!best || year > best.year) best = { key: k, year };
    }
  }
  return best;
}

function findLongFormValue(row: Record<string, unknown>, rowKeysLower: Map<string, string>, candidates: string[]): { key: string; value: number } | null {
  for (const candidate of candidates) {
    const originalKey = rowKeysLower.get(candidate.toLowerCase());
    if (originalKey) {
      const v = safeNum(row[originalKey]);
      if (v !== null) return { key: originalKey, value: v };
    }
  }
  return null;
}

async function fetchFilosofiData(codeInsee: string): Promise<FilosofiResult> {
  const empty: FilosofiResult = {
    revenu_median: null, incomeMedianUcEur: null, incomeMedianUcYear: null,
    taux_pauvrete: null, part_menages_imposes: null,
    source: 'none', coverage: 'no_data', warnings: [],
  };

  if (!codeInsee) return empty;

  try {
    const supabase = getSupabaseClient();
    const { data: row, error } = await supabase
      .from("filosofi_staging")
      .select("*")
      .eq("codgeo", codeInsee)
      .limit(1)
      .maybeSingle();

    if (error) { empty.warnings.push(`Erreur requête filosofi: ${error.message}`); empty.coverage = 'error'; return empty; }
    if (!row) { empty.warnings.push(`Aucune donnée FiLoSoFi pour la commune ${codeInsee}`); return empty; }

    const allKeys = Object.keys(row);
    const rowKeysLower = new Map<string, string>();
    for (const k of allKeys) rowKeysLower.set(k.toLowerCase(), k);

    const result: FilosofiResult = {
      revenu_median: null, incomeMedianUcEur: null, incomeMedianUcYear: null,
      taux_pauvrete: null, part_menages_imposes: null,
      source: 'none', coverage: 'partial', warnings: [],
    };

    const longMed = findLongFormValue(row, rowKeysLower, LONG_FORM_MED_CANDIDATES);
    const longTxpau = findLongFormValue(row, rowKeysLower, LONG_FORM_TXPAU_CANDIDATES);
    const longPartimp = findLongFormValue(row, rowKeysLower, LONG_FORM_PARTIMP_CANDIDATES);

    if (longMed) { result.revenu_median = Math.round(longMed.value); result.incomeMedianUcEur = Math.round(longMed.value); result.source = 'filosofi_long'; }
    if (longTxpau) result.taux_pauvrete = Math.round(longTxpau.value * 10) / 10;
    if (longPartimp) result.part_menages_imposes = Math.round(longPartimp.value * 10) / 10;

    if (!result.revenu_median) {
      const medCol = findLatestColumn(allKeys, FILOSOFI_MED_RE);
      if (medCol) {
        const v = safeNum(row[medCol.key]);
        if (v !== null && v > 0) { result.revenu_median = Math.round(v); result.incomeMedianUcEur = Math.round(v); result.incomeMedianUcYear = medCol.year; result.source = 'filosofi_short'; }
      }
    } else {
      const medCol = findLatestColumn(allKeys, FILOSOFI_MED_RE);
      if (medCol) result.incomeMedianUcYear = medCol.year;
    }

    if (result.taux_pauvrete === null) {
      const txpauCol = findLatestColumn(allKeys, FILOSOFI_TXPAU_RE);
      if (txpauCol) { const v = safeNum(row[txpauCol.key]); if (v !== null) result.taux_pauvrete = Math.round(v * 10) / 10; }
    }
    if (result.part_menages_imposes === null) {
      const partimpCol = findLatestColumn(allKeys, FILOSOFI_PARTIMP_RE);
      if (partimpCol) { const v = safeNum(row[partimpCol.key]); if (v !== null) result.part_menages_imposes = Math.round(v * 10) / 10; }
    }

    result.coverage = result.revenu_median !== null ? 'ok' : 'partial';
    if (result.revenu_median === null) result.warnings.push(`Ligne FiLoSoFi trouvée pour ${codeInsee} mais aucune colonne MEDxx/mediane_* exploitable.`);
    return result;
  } catch (e) {
    console.error("[FILOSOFI] Error:", e);
    empty.warnings.push(`Exception filosofi: ${String(e)}`);
    empty.coverage = 'error';
    return empty;
  }
}

// ============================================================================
// INSEE DATA
// ============================================================================

interface InseeData {
  code_commune: string; commune_nom: string; departement: string; region: string;
  population: number; densite: number;
  revenu_median: number | null; revenu_median_source: 'filosofi' | 'socioeco' | 'dept_fallback' | 'none';
  incomeMedianUcEur: number | null; incomeMedianUcYear: number | null;
  taux_pauvrete: number | null; part_menages_imposes: number | null;
  pension_retraite_moyenne: number | null; taux_chomage: number | null;
  pct_proprietaires: number | null; pct_moins_15: number | null; pct_15_29: number | null;
  pct_30_44: number | null; pct_45_59: number | null; pct_60_74: number | null;
  pct_75_plus: number | null; pct_etudiants: number | null; pct_actifs: number | null;
  pct_logements_vacants: number | null; pct_locataires: number | null;
  economic_data_quality: Record<string, unknown> | null;
  revenu_median_uc: number | null; revenu_moyen: number | null; niveau_vie_median: number | null;
  part_cadres: number | null; part_professions_intermediaires: number | null;
  part_employes: number | null; part_ouvriers: number | null; part_actifs_occupes: number | null;
  evolution_population_5y: number | null; evolution_revenu_5y: number | null;
  evolution_chomage_5y: number | null; taxe_fonciere_moyenne: number | null;
  taxe_fonciere_evolution_3y: number | null;
  revenu_source: 'filosofi' | 'none'; coverage: Coverage; warnings: string[];
}

// ============================================================================
// SOCIO-ÉCO HELPERS
// ============================================================================

const SOCIOECO_FIELD_CANDIDATES: Record<string, string[]> = {
  revenu_moyen: ['revenu_moyen_eur', 'revenu_moyen', 'rev_moyen', 'mean_income', 'revenu_disponible_moyen', 'rev_disp_moyen', 'revenu_net_moyen'],
  taux_chomage: ['taux_chomage_pct', 'taux_chomage', 'tx_chomage', 'chomage_pct'],
  niveau_vie_median: ['niveau_vie_median', 'niv_vie_median', 'mediane_niveau_vie', 'mediane_rev_disp_uc', 'revenu_median_eur', 'med_niveau_vie', 'niveauvie_median', 'niveau_de_vie_median'],
  revenu_median_uc: ['revenu_median_uc_eur', 'revenu_median_uc', 'mediane_uc', 'mediane_rev_disp_uc', 'revenu_median_eur', 'med_niveau_vie', 'med19', 'med20', 'med21', 'med22'],
  taux_pauvrete: ['taux_pauvrete_pct', 'taux_pauvrete', 'tx_pauvrete', 'txpau', 'txpau19', 'txpau20', 'txpau21', 'txpau22', 'part_pauvrete'],
  part_menages_imposes: ['part_menages_imposes_pct', 'part_menages_imposes', 'pct_menages_imposes', 'partimp', 'part_imp', 'partimp19', 'partimp20', 'partimp21', 'partimp22'],
  pension_retraite_moyenne: ['pension_retraite_moyenne_eur_mois', 'pension_retraite_moyenne', 'pension_moyenne_eur', 'retraite_moyenne', 'pension_moy', 'montant_pension_moyen', 'pension_moyenne_mensuelle'],
  part_cadres: ['part_cadres', 'pct_cadres', 'part_cadres_pct', 'cadres_pct', 'cs3_pct', 'p_cadres', 'part_cs3', 'c3_pct'],
  part_professions_intermediaires: ['part_professions_intermediaires', 'pct_professions_intermediaires', 'prof_inter_pct', 'cs4_pct', 'p_pi', 'part_cs4', 'c4_pct', 'professions_intermediaires_pct'],
  part_employes: ['part_employes', 'pct_employes', 'employes_pct', 'cs5_pct', 'p_employes', 'part_cs5', 'c5_pct'],
  part_ouvriers: ['part_ouvriers', 'pct_ouvriers', 'ouvriers_pct', 'cs6_pct', 'p_ouvriers', 'part_cs6', 'c6_pct'],
  part_actifs_occupes: ['part_actifs_occupes', 'pct_actifs_occupes', 'taux_emploi', 'emploi_pct', 'actifs_occupes_pct', 'part_emploi', 'taux_activite', 'p_actifs_occupes'],
  evolution_revenu_5y: ['evolution_revenu_5y', 'evol_revenu_5y', 'variation_revenu_5y', 'rev_evol_5y', 'delta_revenu_5y', 'tx_evol_revenu_5y'],
  evolution_chomage_5y: ['evolution_chomage_5y', 'evol_chomage_5y', 'variation_chomage_5y', 'delta_chomage_5y', 'tx_evol_chomage_5y'],
  taxe_fonciere_moyenne: ['taxe_fonciere_moyenne', 'tf_moyenne', 'taxe_fonciere_moy', 'tf_moy', 'taxe_fonciere_eur', 'montant_tf_moyen'],
  taxe_fonciere_evolution_3y: ['taxe_fonciere_evolution_3y', 'tf_evol_3y', 'taxe_fonciere_evol', 'delta_tf_3y', 'evolution_tf_3y'],
  evolution_population_5y: ['evolution_population_5y', 'evol_pop_5y', 'variation_pop_5y', 'pop_evol_5y', 'tx_evol_pop_5y', 'evolution_pop', 'pop_evolution', 'delta_pop_5y'],
};

function pickFirstNumeric(row: Record<string, unknown> | null | undefined, candidateKeys: string[]): number | null {
  if (!row) return null;
  const lowerIndex: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) lowerIndex[k.toLowerCase()] = v;
  for (const key of candidateKeys) {
    const val = lowerIndex[key.toLowerCase()];
    if (val == null || val === '' || val === 'ns' || val === 'nd') continue;
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.').replace(/\s/g, ''));
    if (Number.isFinite(n)) return Math.round(n * 100) / 100;
  }
  return null;
}

function pickField(row: Record<string, unknown> | null | undefined, fieldName: keyof typeof SOCIOECO_FIELD_CANDIDATES): number | null {
  return pickFirstNumeric(row, SOCIOECO_FIELD_CANDIDATES[fieldName] ?? []);
}

interface SocioEcoExtended {
  revenu_moyen: number | null; niveau_vie_median: number | null; revenu_median_uc: number | null;
  part_cadres: number | null; part_professions_intermediaires: number | null;
  part_employes: number | null; part_ouvriers: number | null; part_actifs_occupes: number | null;
  taux_pauvrete: number | null; taux_chomage: number | null; part_menages_imposes: number | null;
  pension_retraite_moyenne: number | null; evolution_revenu_5y: number | null;
  evolution_chomage_5y: number | null; taxe_fonciere_moyenne: number | null;
  taxe_fonciere_evolution_3y: number | null; _fields_found: string[];
}

async function fetchSocioEcoExtended(codeInsee: string): Promise<SocioEcoExtended> {
  const empty: SocioEcoExtended = {
    revenu_moyen: null, niveau_vie_median: null, revenu_median_uc: null,
    part_cadres: null, part_professions_intermediaires: null,
    part_employes: null, part_ouvriers: null, part_actifs_occupes: null,
    taux_pauvrete: null, taux_chomage: null, part_menages_imposes: null,
    pension_retraite_moyenne: null, evolution_revenu_5y: null, evolution_chomage_5y: null,
    taxe_fonciere_moyenne: null, taxe_fonciere_evolution_3y: null, _fields_found: [],
  };
  if (!codeInsee) return empty;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from("insee_socioeco_communes").select("*").eq("code_commune", codeInsee).limit(1).maybeSingle();
    if (error || !data) return empty;
    const row = data as Record<string, unknown>;
    const found: string[] = [];
    const pf = (field: keyof typeof SOCIOECO_FIELD_CANDIDATES): number | null => { const v = pickField(row, field); if (v !== null) found.push(field); return v; };
    const result: SocioEcoExtended = {
      revenu_moyen: pf('revenu_moyen'), niveau_vie_median: pf('niveau_vie_median'), revenu_median_uc: pf('revenu_median_uc'),
      part_cadres: pf('part_cadres'), part_professions_intermediaires: pf('part_professions_intermediaires'),
      part_employes: pf('part_employes'), part_ouvriers: pf('part_ouvriers'), part_actifs_occupes: pf('part_actifs_occupes'),
      taux_pauvrete: pf('taux_pauvrete'), taux_chomage: pf('taux_chomage'), part_menages_imposes: pf('part_menages_imposes'),
      pension_retraite_moyenne: pf('pension_retraite_moyenne'), evolution_revenu_5y: pf('evolution_revenu_5y'),
      evolution_chomage_5y: pf('evolution_chomage_5y'), taxe_fonciere_moyenne: pf('taxe_fonciere_moyenne'),
      taxe_fonciere_evolution_3y: pf('taxe_fonciere_evolution_3y'), _fields_found: found,
    };
    console.log(`[SocioEco] ${codeInsee} — ${found.length} champs trouvés`);
    return result;
  } catch (e) { console.warn("[SocioEco] Exception:", e); return empty; }
}

async function fetchPopulationEvolution(codeInsee: string): Promise<{ evolution_population_5y: number | null }> {
  const empty = { evolution_population_5y: null };
  if (!codeInsee) return empty;
  try {
    const supabase = getSupabaseClient();
    const { data: statsRow } = await supabase.from("insee_communes_stats").select("*").eq("code_commune", codeInsee).limit(1).maybeSingle();
    if (statsRow) { const v = pickField(statsRow as Record<string, unknown>, 'evolution_population_5y'); if (v !== null) return { evolution_population_5y: v }; }
    const { data: socioRow } = await supabase.from("insee_socioeco_communes").select("evolution_population_5y, evol_pop_5y, variation_pop_5y").eq("code_commune", codeInsee).limit(1).maybeSingle();
    if (socioRow) { const v = pickFirstNumeric(socioRow as Record<string, unknown>, ['evolution_population_5y', 'evol_pop_5y', 'variation_pop_5y']); if (v !== null) return { evolution_population_5y: v }; }
    return empty;
  } catch (e) { console.warn("[PopEvol] Exception:", e); return empty; }
}

async function fetchInseeData(codeInsee: string, communeNom: string | null, dept: string | null): Promise<InseeData | null> {
  try {
    const url = `${GEO_API_BASE}/communes/${codeInsee}?fields=code,nom,departement,region,population,surface`;
    let geoData: { nom?: string; population?: number; surface?: number; departement?: { code?: string }; region?: { nom?: string } } = {};
    try {
      const res = await safeFetch(url, { timeoutMs: 8000 });
      if (res && res.ok) geoData = await res.json();
      else console.warn(`[INSEE] GEO fallback local pour ${codeInsee}`);
    } catch { console.warn("[INSEE] GEO indisponible — fallback local pour", codeInsee); }

    const deptCode = dept ?? geoData.departement?.code ?? codeInsee.substring(0, 2);
    const surface = geoData.surface ? geoData.surface / 100 : 1;
    const densite = surface > 0 ? Math.round((geoData.population ?? 0) / surface) : 0;
    const demoData = DEMOGRAPHICS_DEPT[deptCode] || DEMOGRAPHICS_DEPT["default"];

    let pct75Adjusted = demoData.pct_75_plus;
    if (densite < 100) pct75Adjusted = Math.min(18, demoData.pct_75_plus + 4);
    else if (densite < 500) pct75Adjusted = Math.min(14, demoData.pct_75_plus + 2);
    else if (densite > 5000) pct75Adjusted = Math.max(6, demoData.pct_75_plus - 2);

    let pctEtudiantsAdjusted = demoData.pct_etudiants;
    if (densite > 5000) pctEtudiantsAdjusted = Math.min(15, demoData.pct_etudiants + 3);
    else if (densite < 500) pctEtudiantsAdjusted = Math.max(1, demoData.pct_etudiants - 3);

    const filosofi = await fetchFilosofiData(codeInsee);
    let revenuMedian: number | null = filosofi.revenu_median;
    let tauxPauvrete: number | null = filosofi.taux_pauvrete;
    let partMenagesImposes: number | null = filosofi.part_menages_imposes;
    let pensionRetraiteMoyenne: number | null = null;
    let revenuMedianSource: InseeData['revenu_median_source'] = revenuMedian !== null ? 'filosofi' : 'none';

    const [socioEco, popEvol] = await Promise.all([
      fetchSocioEcoExtended(codeInsee).catch(() => ({
        revenu_moyen: null, niveau_vie_median: null, revenu_median_uc: null,
        part_cadres: null, part_professions_intermediaires: null,
        part_employes: null, part_ouvriers: null, part_actifs_occupes: null,
        taux_pauvrete: null, taux_chomage: null, part_menages_imposes: null,
        pension_retraite_moyenne: null, evolution_revenu_5y: null, evolution_chomage_5y: null,
        taxe_fonciere_moyenne: null, taxe_fonciere_evolution_3y: null, _fields_found: [] as string[],
      } as SocioEcoExtended)),
      fetchPopulationEvolution(codeInsee).catch(() => ({ evolution_population_5y: null })),
    ]);

    if (revenuMedian === null) {
      const socioMedian = socioEco.revenu_median_uc ?? socioEco.niveau_vie_median;
      if (socioMedian != null) { revenuMedian = socioMedian; revenuMedianSource = 'socioeco'; }
    }
    if (tauxPauvrete === null) tauxPauvrete = socioEco.taux_pauvrete;
    if (partMenagesImposes === null) partMenagesImposes = socioEco.part_menages_imposes;
    if (pensionRetraiteMoyenne === null) pensionRetraiteMoyenne = socioEco.pension_retraite_moyenne;

    if (revenuMedian === null) {
      revenuMedian = REVENU_MEDIAN_DEPT_FALLBACK[deptCode] ?? REVENU_MEDIAN_DEPT_FALLBACK["default"] ?? 22000;
      revenuMedianSource = 'dept_fallback';
    }

    const warnings: string[] = [...filosofi.warnings];
    if (revenuMedianSource === 'dept_fallback') warnings.push(`Revenu médian estimé (département ${deptCode}) — données FiLoSoFi et socioeco absentes pour ${codeInsee}.`);

    const tauxChomage = socioEco.taux_chomage ?? TAUX_CHOMAGE_DEPT[deptCode] ?? TAUX_CHOMAGE_DEPT["default"] ?? null;
    const coverage: Coverage = (revenuMedianSource === 'filosofi' || revenuMedianSource === 'socioeco') ? 'ok' : 'partial';

    const ff = socioEco._fields_found;
    const pcsFields = ['part_cadres', 'part_employes', 'part_ouvriers', 'part_professions_intermediaires'];
    const pcsFound = pcsFields.filter(f => ff.includes(f)).length;
    const coreFields = ['taux_pauvrete', 'part_menages_imposes', 'pension_retraite_moyenne'];
    const coreFound = coreFields.filter(f => ff.includes(f)).length;
    const totalFound = ff.length;
    const socioProfile: "partial" | "complete" | "missing" = totalFound === 0 ? 'missing' : totalFound >= 6 && pcsFound >= 2 && coreFound >= 2 ? 'complete' : 'partial';

    return {
      code_commune: codeInsee, commune_nom: geoData.nom || communeNom || "",
      departement: deptCode, region: geoData.region?.nom || "", population: geoData.population ?? 0, densite,
      revenu_median: revenuMedian, revenu_median_source: revenuMedianSource,
      incomeMedianUcEur: filosofi.incomeMedianUcEur ?? revenuMedian, incomeMedianUcYear: filosofi.incomeMedianUcYear,
      taux_pauvrete: tauxPauvrete, part_menages_imposes: partMenagesImposes,
      pension_retraite_moyenne: pensionRetraiteMoyenne, taux_chomage: tauxChomage,
      pct_proprietaires: 58, pct_moins_15: demoData.pct_moins_15, pct_15_29: demoData.pct_15_29,
      pct_30_44: demoData.pct_30_44, pct_45_59: demoData.pct_45_59, pct_60_74: demoData.pct_60_74,
      pct_75_plus: pct75Adjusted, pct_etudiants: pctEtudiantsAdjusted, pct_actifs: demoData.pct_actifs,
      pct_logements_vacants: densite < 200 ? 12 : densite < 1000 ? 8 : 5,
      pct_locataires: densite > 3000 ? 55 : densite > 1000 ? 45 : 35,
      revenu_median_uc: socioEco.revenu_median_uc, revenu_moyen: socioEco.revenu_moyen,
      niveau_vie_median: socioEco.niveau_vie_median ?? revenuMedian,
      part_cadres: socioEco.part_cadres, part_professions_intermediaires: socioEco.part_professions_intermediaires,
      part_employes: socioEco.part_employes, part_ouvriers: socioEco.part_ouvriers,
      part_actifs_occupes: socioEco.part_actifs_occupes,
      evolution_population_5y: popEvol.evolution_population_5y,
      evolution_revenu_5y: socioEco.evolution_revenu_5y, evolution_chomage_5y: socioEco.evolution_chomage_5y,
      taxe_fonciere_moyenne: socioEco.taxe_fonciere_moyenne,
      taxe_fonciere_evolution_3y: socioEco.taxe_fonciere_evolution_3y,
      economic_data_quality: {
        revenu_median: revenuMedianSource === 'filosofi' ? 'real' : revenuMedianSource === 'socioeco' ? 'real' : revenuMedianSource === 'dept_fallback' ? 'fallback' : 'missing',
        revenu_moyen: socioEco.revenu_moyen != null ? 'real' : 'missing',
        niveau_vie_median: socioEco.niveau_vie_median != null ? 'real' : revenuMedian != null ? 'derived' : 'missing',
        tax_data: socioEco.taxe_fonciere_moyenne != null ? 'real' : 'missing',
        pcs_data: pcsFound >= 2 ? 'real' : pcsFound === 1 ? 'partial' : 'missing',
        evolution_data: (socioEco.evolution_revenu_5y != null || socioEco.evolution_chomage_5y != null) ? 'real' : 'missing',
        socioeco_profile: socioProfile, fields_found_count: totalFound,
      },
      revenu_source: revenuMedianSource !== 'none' ? 'filosofi' : 'none',
      coverage, warnings,
    };
  } catch (e) { console.error("[INSEE] Error:", e); return null; }
}

// ============================================================================
// TRANSPORT DATA — v1.5.0 : deux régimes d'accessibilité
// ============================================================================
//
// ── Pourquoi deux régimes ───────────────────────────────────────────────────
// v1.4.0 avait corrigé l'urbanité (grille INSEE) mais laissait le pilier
// accessibilité ÉCARTÉ pour Ascain : Overpass ne trouvait aucun arrêt à moins
// d'1 km, et l'on refusait à juste titre de transformer ce vide en 0/100.
// Le résultat restait faux dans l'autre sens — une commune desservie par le
// réseau Txik Txak, à 6,5 km de la gare TER de Saint-Jean-de-Luz et à 19,5 km
// de la gare TGV de Bayonne, ressortait « accessibilité non mesurée ».
//
// Le défaut de fond : un seul barème, celui de la ville dense, appliqué à tout
// le territoire. Un rayon de 1 km autour du point mesure la marche vers un
// arrêt — pertinent niveau_7 1 à 3, sans objet niveau_7 4 à 7, où l'on ne se
// déplace pas à pied vers un arrêt mais en voiture vers une gare ou un pôle.
// Un promoteur à Ascain ne vend pas « à 300 m du tram », il vend « 20 minutes
// de Saint-Jean-de-Luz ». Deux marchés, deux unités de mesure.
//
// Régime lu sur `niveau_7` de la grille de densité INSEE (7 niveaux) :
//   1-3 (grands centres, centres intermédiaires, petites villes)
//        → régime TRANSPORTS EN COMMUN : arrêts OSM dans 1 km, barème inchangé
//   4-7 (ceintures urbaines, bourgs, rural)
//        → régime ROUTIER : gare TER/TGV la plus proche, en minutes estimées
//
// ⚠️ Ce n'est PAS le binaire `is_urban` (niveau_3) : Ascain est urbaine au sens
// niveau_3 = 2 tout en relevant du régime routier au sens niveau_7 = 4. Les
// deux prédicats répondent à deux questions différentes et ne doivent pas être
// confondus — c'est la leçon du `isRural` de smartscore v4.6, qui faisait deux
// métiers à la fois.

type AccessRegime = 'transports_commun' | 'routier';

/**
 * Accessibilité ferroviaire — source `mobility_stops` (2 628 gares TER,
 * 145 gares TGV, couverture France entière vérifiée : lat 42,43-51,02,
 * lon -4,39-8,18).
 *
 * ⚠️ NE PAS utiliser `mobility_stops` en mode 'metro' (53 967 lignes) ni
 * `gtfs_stops` (119 428) pour cet usage : les deux sont bornés à
 * lat 47,96-49,46 / lon 1,15-3,56, c'est-à-dire l'Île-de-France seule. Hors
 * IdF ils renvoient zéro, et ce zéro se lirait comme « aucune desserte ».
 */
interface RailAccess {
  nearest_station_km: number | null;
  nearest_station_name: string | null;
  nearest_station_mode: 'ter' | 'tgv' | null;
  nearest_tgv_km: number | null;
  nearest_tgv_name: string | null;
  ter_stations_nearby: number | null;
  /** Minutes de voiture ESTIMÉES, jamais mesurées. Voir `estimation_method`. */
  drive_minutes_estimated: number | null;
  /** Toujours `true` : ce champ existe pour qu'aucun consommateur ne puisse
   *  présenter ces minutes comme un temps de trajet mesuré. */
  estimated: true;
  estimation_method: string;
  coverage: Coverage;
}

interface TransportData {
  score: number;
  stops: Array<{ name: string; type: string; distance_m: number }>;
  nearest_stop_m: number | null;
  has_metro_train: boolean;
  has_tram: boolean;
  // v1.3.7 : false = commune non-urbaine, pilier accessibilité exclu du score global
  is_urban: boolean;
  // v1.4.0 : d'où vient le verdict d'urbanité — 'insee' (déterministe) ou
  // 'population' (heuristique de repli, à ne pas présenter comme un fait).
  is_urban_source?: 'insee' | 'population' | null;
  is_urban_label?: string | null;
  // ── v1.5.0 ────────────────────────────────────────────────────────────────
  /** Régime appliqué, et pourquoi. À relayer jusqu'au Copilot : un score
   *  d'accessibilité ne veut pas dire la même chose selon le régime. */
  regime: AccessRegime;
  regime_source: 'insee_niveau_7' | 'repli';
  regime_label: string;
  niveau_7: number | null;
  /** Renseigné uniquement en régime routier. */
  rail: RailAccess | null;
  coverage: Coverage;
}

/** Régime déduit de niveau_7. `null` = grille INSEE muette pour cette commune. */
function regimeFromNiveau7(niveau7: number | null): AccessRegime | null {
  if (niveau7 == null) return null;
  return niveau7 <= 3 ? 'transports_commun' : 'routier';
}

/** Minutes de voiture estimées à partir d'une distance à vol d'oiseau. */
function estimateDriveMinutes(km: number | null): number | null {
  if (km == null || !Number.isFinite(km)) return null;
  return Math.round((km * ROAD_DETOUR_FACTOR / ROAD_AVG_SPEED_KMH) * 60);
}

const ROAD_ESTIMATION_METHOD =
  `distance à vol d'oiseau × ${ROAD_DETOUR_FACTOR} (sinuosité) ÷ ${ROAD_AVG_SPEED_KMH} km/h ` +
  `(vitesse moyenne porte-à-porte) — estimation, pas un temps de trajet mesuré`;

// ── v1.5.1 — Dire de quoi le score est fait ─────────────────────────────────
// v1.5.0 exposait la méthode de calcul des MINUTES, mais rien sur la
// composition du SCORE. Interrogé sur le 83/100 d'Ascain, le Copilot a comblé
// le vide en inventant : « il mesure la facilité d'accès à un bassin d'emplois
// et de services en voiture, via la grille zonage INSEE ». Deux inventions —
// aucune donnée de bassin d'emploi n'entre dans ce calcul (le critère a été
// écarté faute de centroïdes communaux), et la grille INSEE ne mesure rien,
// elle choisit le régime. Un modèle à qui l'on donne un chiffre sans sa recette
// écrira une recette. On la lui donne.
const ROAD_SCORE_METHOD =
  `Barème par paliers sur les minutes de voiture ESTIMÉES jusqu'à la gare TER/TGV la plus proche `
  + `(≤10 min : 70 ; ≤20 : 58 ; ≤30 : 45 ; ≤45 : 32 ; au-delà : 20), `
  + `puis +8 si une gare TGV est à moins de 30 min estimées, +5 s'il y a au moins 3 gares TER `
  + `dans ${RAIL_DENSITY_RADIUS_KM} km. Plafonné à ${ROAD_REGIME_SCORE_CAP}/100. `
  + `Source unique : gares TER et TGV de la table mobility_stops. `
  + `Ce score ne mesure NI la desserte en transports en commun (bus, car, fréquences : aucune donnée), `
  + `NI l'accès à un bassin d'emploi (aucune donnée de pôle d'emploi n'entre dans le calcul). `
  + `La grille de densité INSEE ne participe PAS au score : elle sert uniquement à choisir le régime.`;

const TRANSIT_SCORE_METHOD =
  `Barème par paliers sur la distance à pied jusqu'à l'arrêt le plus proche référencé dans `
  + `OpenStreetMap, dans un rayon de 1 km (<300 m : 90 ; <500 : 75 ; <800 : 60 ; au-delà : 45), `
  + `puis +10 si métro ou train, +5 si tramway. Source unique : Overpass / OpenStreetMap. `
  + `Ce score ne mesure ni les fréquences, ni les horaires, ni les destinations desservies.`;

/**
 * Gares TER/TGV autour du point. Une seule requête, filtrée par boîte
 * englobante côté base, distances calculées en JS (haversine) — la table n'a
 * pas d'index géographique exploitable via PostgREST.
 */
async function fetchRailAccess(lat: number, lon: number): Promise<RailAccess> {
  const empty: RailAccess = {
    nearest_station_km: null, nearest_station_name: null, nearest_station_mode: null,
    nearest_tgv_km: null, nearest_tgv_name: null, ter_stations_nearby: null,
    drive_minutes_estimated: null, estimated: true,
    estimation_method: ROAD_ESTIMATION_METHOD,
    coverage: "no_data",
  };

  try {
    const supabase = getSupabaseClient();
    // 1° de latitude ≈ 111 km ; la longitude se resserre avec le cosinus.
    const dLat = RAIL_SEARCH_RADIUS_KM / 111;
    const dLon = RAIL_SEARCH_RADIUS_KM / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));

    const { data, error } = await supabase
      .from("mobility_stops")
      .select("stop_name, lat, lon, mode")
      .in("mode", ["ter", "tgv"])
      .gte("lat", lat - dLat).lte("lat", lat + dLat)
      .gte("lon", lon - dLon).lte("lon", lon + dLon)
      // ⚠️ La limite tronque AVANT le tri par distance, qui se fait en JS. Un
      // plafond bas ferait manquer la gare la plus proche là où elles sont
      // nombreuses. 3 000 dépasse le total national (2 628 TER + 145 TGV) :
      // aucune boîte englobante ne peut l'atteindre. C'est la même erreur que
      // le `limit 500` de DVF présenté comme un décompte — ici on la neutralise.
      .limit(3000);

    if (error) {
      // Base muette : on ne sait rien de la desserte ferroviaire. Surtout pas
      // « il n'y a pas de gare ».
      console.error("[Rail] Erreur mobility_stops:", error.message);
      return { ...empty, coverage: "error" };
    }
    if (!data) return { ...empty, coverage: "error" };

    const stations = data
      .map((s: Record<string, unknown>) => ({
        name: String(s.stop_name ?? "Gare"),
        mode: String(s.mode) === "tgv" ? "tgv" as const : "ter" as const,
        km: haversine(lat, lon, Number(s.lat), Number(s.lon)) / 1000,
      }))
      .filter((s) => Number.isFinite(s.km) && s.km <= RAIL_SEARCH_RADIUS_KM)
      .sort((a, b) => a.km - b.km);

    if (stations.length === 0) {
      // La requête a abouti et il n'y a réellement aucune gare dans 60 km.
      // C'est une information de desserte, pas une lacune de source.
      return { ...empty, ter_stations_nearby: 0, coverage: "ok" };
    }

    const nearest = stations[0];
    const tgv = stations.find((s) => s.mode === "tgv") ?? null;
    const terNearby = stations.filter(
      (s) => s.mode === "ter" && s.km <= RAIL_DENSITY_RADIUS_KM,
    ).length;

    return {
      nearest_station_km: Math.round(nearest.km * 10) / 10,
      nearest_station_name: nearest.name,
      nearest_station_mode: nearest.mode,
      nearest_tgv_km: tgv ? Math.round(tgv.km * 10) / 10 : null,
      nearest_tgv_name: tgv ? tgv.name : null,
      ter_stations_nearby: terNearby,
      drive_minutes_estimated: estimateDriveMinutes(nearest.km),
      estimated: true,
      estimation_method: ROAD_ESTIMATION_METHOD,
      coverage: "ok",
    };
  } catch (e) {
    console.error("[Rail] Error:", e);
    return { ...empty, coverage: "error" };
  }
}

/**
 * Barème du régime routier. Plafonné à ROAD_REGIME_SCORE_CAP : il ne doit
 * jamais atteindre la note d'une adresse desservie à pied par un transport
 * lourd, sous peine de rendre les deux régimes incomparables.
 */
function scoreRoadRegime(rail: RailAccess): number | null {
  const min = rail.drive_minutes_estimated;
  if (min == null) {
    // Requête aboutie mais aucune gare dans 60 km : c'est mesuré, et c'est
    // une accessibilité ferroviaire nulle — pas une absence de mesure.
    return rail.coverage === "ok" ? 15 : null;
  }
  let score =
    min <= 10 ? 70 :
    min <= 20 ? 58 :
    min <= 30 ? 45 :
    min <= 45 ? 32 : 20;

  if (rail.nearest_tgv_km != null) {
    const tgvMin = estimateDriveMinutes(rail.nearest_tgv_km);
    if (tgvMin != null && tgvMin <= 30) score += 8;
  }
  if ((rail.ter_stations_nearby ?? 0) >= 3) score += 5;

  return Math.max(0, Math.min(ROAD_REGIME_SCORE_CAP, score));
}

// ── v1.4.0 — Urbanité déterminée par la grille de densité INSEE ─────────────
// AVANT : `is_urban` dépendait du SUCCÈS d'un appel Overpass, avec repli sur un
// seuil de population de 50 000. Deux conséquences :
//   1. non déterminisme — mêmes entrées, verdict différent selon la santé d'un
//      serveur tiers (défaut déjà corrigé sur market-study-promoteur-v1 v1.3.24) ;
//   2. faux négatifs massifs — Ascain (4 658 hab.) était déclarée « zone
//      non-urbaine » alors que la grille INSEE la classe niveau_7 = 4,
//      « Ceintures urbaines ». Elle n'est PAS rurale au sens INSEE.
// La table `insee_grille_densite` (34 875 communes, millésime 01/01/2026) est
// déjà en base. On la lit : niveau_3 ∈ {1,2} = urbain, 3 = rural.
// v1.5.0 : `niveau_7` était déjà lu dans le `.select` mais jeté — seul
// `libelle_niveau_7` servait, comme étiquette. C'est lui qui porte le régime
// d'accessibilité ; on le renvoie désormais.
async function fetchIsUrbanFromInsee(codeInsee: string | null): Promise<{
  is_urban: boolean | null; label: string | null; niveau_7: number | null;
}> {
  if (!codeInsee) return { is_urban: null, label: null, niveau_7: null };
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("insee_grille_densite")
      .select("niveau_3, niveau_7, libelle_niveau_7")
      .eq("code_insee", codeInsee)
      .maybeSingle();

    if (error || !data || data.niveau_3 == null) {
      console.warn(`[Urbanite] ${codeInsee} absent de insee_grille_densite`);
      return { is_urban: null, label: null, niveau_7: null };
    }
    return {
      is_urban: data.niveau_3 === 1 || data.niveau_3 === 2,
      label: data.libelle_niveau_7 ?? null,
      niveau_7: data.niveau_7 == null ? null : Number(data.niveau_7),
    };
  } catch (e) {
    console.error("[Urbanite] Error:", e);
    return { is_urban: null, label: null, niveau_7: null };
  }
}

// v1.3.7 : population en paramètre pour détecter le contexte urbain/rural
// v1.4.0 : codeInsee en paramètre — l'urbanité ne dépend plus d'Overpass.
async function fetchTransport(
  lat: number, lon: number,
  dept: string | null,
  population: number | null = null,
  codeInsee: string | null = null,
): Promise<TransportData> {
  // Verdict d'urbanité calculé AVANT tout appel réseau, donc identique à
  // chaque exécution. Overpass ne sert plus qu'à compter les arrêts.
  const urbain = await fetchIsUrbanFromInsee(codeInsee);
  const isUrbanDeterministe = urbain.is_urban;
  const urbanSource: 'insee' | 'population' = isUrbanDeterministe !== null ? 'insee' : 'population';
  const isUrban = isUrbanDeterministe !== null
    ? isUrbanDeterministe
    : (population ?? 0) >= URBAN_POP_THRESHOLD;
  const urbanLabel = urbanSource === 'insee'
    ? urbain.label
    : `estimation par population (${population ?? 'inconnue'} hab.) — commune absente de la grille INSEE`;

  // ── v1.5.0 — Choix du régime, AVANT tout appel réseau ──────────────────────
  // Repli quand la grille est muette : régime ROUTIER. Ce n'est pas arbitraire —
  // le régime routier s'appuie sur une source complète (gares TER/TGV, France
  // entière), là où le régime transports en commun dépend d'Overpass, dont le
  // silence est indiscernable d'une absence de desserte. À défaut de savoir,
  // on choisit le régime qui sait répondre.
  const regimeInsee = regimeFromNiveau7(urbain.niveau_7);
  const regime: AccessRegime = regimeInsee ?? 'routier';
  const regimeSource: 'insee_niveau_7' | 'repli' = regimeInsee ? 'insee_niveau_7' : 'repli';
  const regimeLabel = regimeInsee
    ? (regime === 'transports_commun'
        ? `desserte à pied — grille INSEE niveau ${urbain.niveau_7} (${urbain.label ?? 'non libellé'})`
        : `accessibilité routière — grille INSEE niveau ${urbain.niveau_7} (${urbain.label ?? 'non libellé'})`)
    : `accessibilité routière — régime de repli, commune absente de la grille de densité INSEE`;

  // v1.4.0 : `is_urban` ne retombe plus sur `false` par défaut — il porte le
  // verdict INSEE, indépendant du succès d'Overpass.
  const emptyTransport: TransportData = {
    score: 0, stops: [], nearest_stop_m: null,
    has_metro_train: false, has_tram: false,
    is_urban: isUrban,
    is_urban_source: urbanSource,
    is_urban_label: urbanLabel,
    regime, regime_source: regimeSource, regime_label: regimeLabel,
    niveau_7: urbain.niveau_7,
    rail: null,
    coverage: "no_data",
  };

  // ── Régime ROUTIER (niveau_7 4-7) ─────────────────────────────────────────
  // On ne demande RIEN à Overpass : chercher des arrêts à pied dans un rayon
  // d'1 km autour d'un bourg n'a pas de sens et c'est ce vide qui écartait le
  // pilier. On mesure ce qui structure réellement l'accessibilité ici.
  if (regime === 'routier') {
    const rail = await fetchRailAccess(lat, lon);
    const railScore = scoreRoadRegime(rail);
    return {
      ...emptyTransport,
      rail,
      score: railScore ?? 0,
      // `has_metro_train` décrit une desserte À PIED : en régime routier elle
      // reste false, sinon les bonus du barème urbain s'appliqueraient à une
      // gare située à 20 minutes de voiture.
      has_metro_train: false,
      has_tram: false,
      // ⚠️ v1.5.1 — `nearest_stop_m` reste NULL en régime routier.
      // v1.5.0 y rangeait la distance à la gare, et l'écran comme le Copilot
      // l'ont affichée sous le libellé « Arrêt le plus proche : 4 700 m » : le
      // champ dit « arrêt » (de bus, à pied), le contenu était une gare (en
      // voiture). Même défaut que le pilier « environnement » qui mesurait des
      // équipements — le nom lu à la place du contenu. La distance à la gare a
      // son propre champ, `rail.nearest_station_km`, qui ne ment pas.
      nearest_stop_m: null,
      coverage: rail.coverage === 'ok' ? 'ok' : rail.coverage,
    };
  }

  try {
    const radius = 1000;
    const query = `[out:json][timeout:12];(node["public_transport"="stop_position"](around:${radius},${lat},${lon});node["public_transport"="platform"](around:${radius},${lat},${lon});node["highway"="bus_stop"](around:${radius},${lat},${lon});node["railway"="station"](around:${radius},${lat},${lon});node["railway"="halt"](around:${radius},${lat},${lon});node["railway"="tram_stop"](around:${radius},${lat},${lon});node["railway"="subway_entrance"](around:${radius},${lat},${lon});node["station"="subway"](around:${radius},${lat},${lon}););out tags 50;`;

    const res = await safeFetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      timeoutMs: 15000,
    });

    if (!res || !res.ok) {
      // v1.4.0 : Overpass indisponible → on ne sait rien de la DESSERTE, mais
      // l'urbanité reste connue (grille INSEE). Plus de verdict au hasard.
      console.warn(`[Transport] Overpass indisponible — desserte non mesurée (urbanité : ${urbanSource})`);
      return { ...emptyTransport, coverage: "error" };
    }

    const data = await res.json();

    if (!data?.elements?.length) {
      // Aucun arrêt dans le rayon de 1 km. C'est une vraie information de
      // desserte — mais elle ne dit rien de l'urbanité, qui vient de l'INSEE.
      return { ...emptyTransport, coverage: "ok" };
    }

    // Des arrêts trouvés. v1.4.0 : cela renseigne la DESSERTE, pas l'urbanité —
    // qui reste celle de la grille INSEE. Un hameau peut avoir un arrêt de car,
    // une ceinture urbaine peut n'en avoir aucun dans OSM.
    const stops: Array<{ name: string; type: string; distance_m: number }> = [];
    let hasMetroTrain = false;
    let hasTram = false;

    for (const el of data.elements) {
      if (!el.lat || !el.lon) continue;
      const dist = haversine(lat, lon, el.lat, el.lon);
      const tags = el.tags || {};
      let type = "bus";
      if (tags.railway === "station" || tags.railway === "halt" || tags.train === "yes") { type = "train"; hasMetroTrain = true; }
      else if (tags.subway === "yes" || tags.station === "subway") { type = "metro"; hasMetroTrain = true; }
      else if (tags.tram === "yes" || tags.railway === "tram_stop") { type = "tram"; hasTram = true; }
      stops.push({ name: tags.name || "Arrêt", type, distance_m: Math.round(dist) });
    }

    stops.sort((a, b) => a.distance_m - b.distance_m);
    const nearest = stops[0]?.distance_m ?? null;

    let score = 30;
    if (nearest !== null) {
      if (nearest < 300) score = 90;
      else if (nearest < 500) score = 75;
      else if (nearest < 800) score = 60;
      else score = 45;
    }
    if (hasMetroTrain) score = Math.min(100, score + 10);
    if (hasTram) score = Math.min(100, score + 5);

    return {
      score, stops: stops.slice(0, 15), nearest_stop_m: nearest,
      has_metro_train: hasMetroTrain, has_tram: hasTram,
      is_urban: isUrban, is_urban_source: urbanSource, is_urban_label: urbanLabel,
      regime, regime_source: regimeSource, regime_label: regimeLabel,
      niveau_7: urbain.niveau_7, rail: null,
      coverage: "ok",
    };
  } catch (e) {
    console.error("[Transport] Error:", e);
    return { ...emptyTransport, coverage: "error" };
  }
}

// ============================================================================
// BPE DATA
// ============================================================================

interface BpeData {
  total_equipements: number; score: number;
  commerces: { count: number; details: Array<{ label: string; distance_m: number }> };
  sante: { count: number; details: Array<{ label: string; distance_m: number }> };
  services: { count: number; details: Array<{ label: string; distance_m: number }> };
  education: { count: number; details: Array<{ label: string; distance_m: number }> };
  loisirs: { count: number; details: Array<{ label: string; distance_m: number }> };
  nb_ecoles: number; nb_pharmacies: number; nb_supermarches: number; nb_universites: number;
  coverage: Coverage; bpe_quality: Record<string, unknown> | null;
}

async function fetchBpeFromSupabase(lat: number, lon: number, codeInsee: string | null, dept: string | null): Promise<BpeData> {
  const emptyBpe: BpeData = {
    total_equipements: 0, score: 30,
    commerces: { count: 0, details: [] }, sante: { count: 0, details: [] },
    services: { count: 0, details: [] }, education: { count: 0, details: [] },
    loisirs: { count: 0, details: [] },
    nb_ecoles: 0, nb_pharmacies: 0, nb_supermarches: 0, nb_universites: 0,
    coverage: "no_data", bpe_quality: null,
  };

  const deptCode = dept ?? (codeInsee ? codeInsee.slice(0, 2) : null);
  if (!codeInsee && !deptCode) return emptyBpe;

  // STEP 1: bpe_import_temp
  if (codeInsee) {
    try {
      const supabase = getSupabaseClient();
      const { data: importData, error: importError } = await supabase
        .from("bpe_import_temp")
        .select("depcom, typequ, latitude, longitude, nb_equip")
        .eq("depcom", codeInsee);

      if (!importError && importData && importData.length > 0) {
        const records = (importData as Array<Record<string, unknown>>).flatMap(r => {
          const count = Math.max(1, Number(r.nb_equip ?? 1));
          return Array.from({ length: count }, () => ({
            TYPEQU: String(r.typequ || ""), NOM: "",
            LATITUDE: String(r.latitude || ""), LONGITUDE: String(r.longitude || ""),
            DEPCOM: String(r.depcom || ""),
          }));
        });
        console.log(`[BPE] bpe_import_temp: ${importData.length} types → ${records.length} équipements`);
        return processBpeRecords(records, lat, lon, "api_datagouv");
      }
      if (importError) console.warn("[BPE] bpe_import_temp erreur:", importError.message);
    } catch (e) { console.warn("[BPE] bpe_import_temp exception:", e); }
  }

  // STEP 2: API data.gouv.fr
  if (codeInsee) {
    try {
      const apiUrl = `${DATA_GOUV_BPE_API}/${BPE_RESOURCE_ID}/data/?DEPCOM__exact=${codeInsee}&page_size=2000`;
      const resp = await safeFetch(apiUrl, { headers: { Accept: "application/json" }, timeoutMs: 15000 });
      if (resp && resp.ok) {
        const json = await resp.json();
        const records: Array<Record<string, string>> = json.data || [];
        console.log(`[BPE] API: ${records.length} équipements pour ${codeInsee}`);
        if (records.length > 0) return processBpeRecords(records, lat, lon, "api_datagouv");
      }
    } catch (e) { console.warn("[BPE] API erreur:", e); }
  }

  // STEP 3: bpe_equipements
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from("bpe_equipements").select("depcom, typequ, nomrs, latitude, longitude").eq("depcom", codeInsee || "");
    if (!error && data && data.length > 0) {
      const records = (data as Array<Record<string, unknown>>).map(r => ({
        TYPEQU: String(r.typequ || ""), NOM: String(r.nomrs || ""),
        LATITUDE: String(r.latitude || ""), LONGITUDE: String(r.longitude || ""),
        DEPCOM: String(r.depcom || ""),
      }));
      return processBpeRecords(records, lat, lon, "supabase");
    }
  } catch (e) { console.error("[BPE] bpe_equipements erreur:", e); }

  return emptyBpe;
}

function processBpeRecords(records: Array<Record<string, string>>, lat: number, lon: number, source: string): BpeData {
  const commerces: Array<{ label: string; distance_m: number }> = [];
  const sante: Array<{ label: string; distance_m: number }> = [];
  const services: Array<{ label: string; distance_m: number }> = [];
  const education: Array<{ label: string; distance_m: number }> = [];
  const loisirs: Array<{ label: string; distance_m: number }> = [];
  let nbEcoles = 0, nbPharmacies = 0, nbSupermarches = 0, nbUniversites = 0;

  for (const r of records) {
    const rawCode = (r.TYPEQU || r.typequ || "").toString().trim();
    const typeCode = rawCode.toUpperCase();
    const typeInfo = BPE_TYPES[rawCode] ?? BPE_TYPES[typeCode];
    const eqLat = parseFloat(r.LATITUDE || r.latitude || "");
    const eqLon = parseFloat(r.LONGITUDE || r.longitude || "");
    const distance_m = (!isNaN(eqLat) && !isNaN(eqLon))
      ? Math.round(Math.sqrt(Math.pow((eqLat - lat) * 111000, 2) + Math.pow((eqLon - lon) * 111000 * Math.cos(lat * Math.PI / 180), 2)))
      : 500;
    const label = r.NOM || r.nomrs || typeInfo?.label || typeCode;
    const item = { label, distance_m };
    if (typeCode === "D301") nbPharmacies++;
    if (typeCode.startsWith("C1") || typeCode.startsWith("C2")) nbEcoles++;
    if (typeCode === "B101" || typeCode === "B102") nbSupermarches++;
    if (typeCode.startsWith("C4") || typeCode.startsWith("C5")) nbUniversites++;
    if (typeInfo) {
      switch (typeInfo.category) {
        case "commerces": commerces.push(item); break;
        case "sante": sante.push(item); break;
        case "services": services.push(item); break;
        case "education": education.push(item); break;
        case "loisirs": loisirs.push(item); break;
      }
    } else {
      if (typeCode.startsWith("B")) commerces.push(item);
      else if (typeCode.startsWith("D")) sante.push(item);
      else if (typeCode.startsWith("A")) services.push(item);
      else if (typeCode.startsWith("C")) education.push(item);
      else if (typeCode.startsWith("F")) loisirs.push(item);
    }
  }

  [commerces, sante, services, education, loisirs].forEach(arr => arr.sort((a, b) => a.distance_m - b.distance_m));
  const total = commerces.length + sante.length + services.length + education.length + loisirs.length;
  let score = 30;
  if (total >= 30) score = 90; else if (total >= 20) score = 80; else if (total >= 10) score = 65;
  else if (total >= 5) score = 50; else if (total >= 2) score = 40;
  if (sante.length >= 3) score = Math.min(100, score + 5);
  const isApiSource = source === "api_datagouv";
  const fullCoverage = (isApiSource && records.length > 20) || total > 30;
  const zeroCats: string[] = [];
  if (commerces.length === 0) zeroCats.push("commerces");
  if (sante.length === 0) zeroCats.push("sante");
  if (services.length === 0) zeroCats.push("services");
  if (education.length === 0) zeroCats.push("education");
  if (loisirs.length === 0) zeroCats.push("loisirs");
  const confidence: "forte" | "moyenne" | "faible" = fullCoverage && isApiSource ? "forte" : fullCoverage ? "moyenne" : "faible";
  return {
    total_equipements: total, score,
    commerces: { count: commerces.length, details: commerces.slice(0, 8) },
    sante: { count: sante.length, details: sante.slice(0, 8) },
    services: { count: services.length, details: services.slice(0, 8) },
    education: { count: education.length, details: education.slice(0, 8) },
    loisirs: { count: loisirs.length, details: loisirs.slice(0, 8) },
    nb_ecoles: nbEcoles, nb_pharmacies: nbPharmacies, nb_supermarches: nbSupermarches, nb_universites: nbUniversites,
    coverage: fullCoverage ? "ok" : (total > 0 ? "ok" : "no_data"),
    bpe_quality: {
      source: isApiSource ? "api_datagouv" : source === "supabase" ? "supabase" : "none",
      raw_count: records.length, full_coverage: fullCoverage, zero_categories: zeroCats,
      suspected_partial_categories: fullCoverage ? [] : zeroCats, confidence,
      // v1.4.2 — Deux précisions qui manquaient et faisaient lire les décomptes
      // de travers :
      //   • le périmètre est la COMMUNE (filtre depcom), jamais un rayon ;
      //   • un compteur à 0 sur un extrait partiel n'est pas un constat.
      // Sur Ascain, l'extrait ne contient que 18 lignes et aucun code D301 :
      // « 0 pharmacie » traduit une lacune de source, pas une commune sans
      // pharmacie. Ces champs sont relayés au Copilot par copilot-chat.
      perimetre: "commune (filtre depcom) — PAS un rayon en km",
      avertissement_zeros:
        (fullCoverage
          ? "Extrait BPE complet : un compteur à 0 peut être lu comme une absence réelle."
          : `Extrait BPE PARTIEL (${records.length} equipement(s) recenses). Un compteur a 0 (pharmacie, supermarche...) traduit `
            + `probablement une lacune de la source, PAS une absence sur le terrain. Ne presente aucun zero comme un constat : `
            + `dis que l'equipement n'est pas recense dans l'extrait disponible.`),
    },
  };
}

// ============================================================================
// EHPAD CONCURRENCE
// ============================================================================

interface EhpadEtablissement {
  nom: string; distance_m: number; capacite: number; capacite_estimee: boolean; finess?: string;
}

async function fetchOverpassEhpad(lat: number, lon: number, radiusKm: number): Promise<EhpadEtablissement[]> {
  try {
    const radiusM = Math.min(radiusKm * 1000, 15000);
    const query = `[out:json][timeout:12];(node["healthcare"="nursing_home"](around:${radiusM},${lat},${lon});way["healthcare"="nursing_home"](around:${radiusM},${lat},${lon});node["amenity"="nursing_home"](around:${radiusM},${lat},${lon});way["amenity"="nursing_home"](around:${radiusM},${lat},${lon});node["social_facility"~"nursing_home|assisted_living"](around:${radiusM},${lat},${lon}););out center tags 40;`;
    const res = await safeFetch(OVERPASS_API_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(query)}`, timeoutMs: 15000 });
    if (!res || !res.ok) return [];
    const data = await res.json();
    const etablissements: EhpadEtablissement[] = [];
    for (const el of data.elements || []) {
      const elLat = el.lat || el.center?.lat; const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;
      const dist = haversine(lat, lon, elLat, elLon);
      if (dist > radiusM) continue;
      const tags = el.tags || {};
      etablissements.push({ nom: tags.name || "Établissement", distance_m: Math.round(dist), capacite: safeNum(tags.capacity || tags.beds) || 0, capacite_estimee: false });
    }
    etablissements.sort((a, b) => a.distance_m - b.distance_m);
    return etablissements;
  } catch { return []; }
}

async function fetchEhpadConcurrence(lat: number, lon: number, radiusKm: number, dept: string | null) {
  const [overpassResults, tarifs] = await Promise.all([
    fetchOverpassEhpad(lat, lon, radiusKm).catch(() => [] as EhpadEtablissement[]),
    fetchEhpadTarifsFromSupabase(dept).catch(() => [] as EhpadTarifParsed[]),
  ]);
  const etablissements: EhpadEtablissement[] = overpassResults.map(e => ({ ...e, capacite: e.capacite || 60, capacite_estimee: !e.capacite || e.capacite === 0 }));
  const prices = tarifs.map(t => t.prix_hebergement_simple).filter((p): p is number => p != null && p > 0);
  const prixStats = prices.length > 0 ? { prix_hebergement_min: Math.round(Math.min(...prices) * 100) / 100, prix_hebergement_max: Math.round(Math.max(...prices) * 100) / 100, prix_hebergement_median: median(prices) ? Math.round(median(prices)! * 100) / 100 : null, prix_hebergement_moyen: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100, nb_etablissements_avec_prix: prices.length } : null;
  const g = (f: (t: EhpadTarifParsed) => number | null) => { const v = tarifs.map(f).filter((v): v is number => v != null && v > 0); return v.length > 0 ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };
  const girsStats = tarifs.length > 0 ? { tarif_gir_1_2_moyen: g(t => t.tarif_gir_1_2), tarif_gir_3_4_moyen: g(t => t.tarif_gir_3_4), tarif_gir_5_6_moyen: g(t => t.tarif_gir_5_6) } : null;
  const withCapacity = etablissements.filter(e => !e.capacite_estimee && e.capacite > 0);
  const avgCapacity = withCapacity.length > 0 ? Math.round(withCapacity.reduce((s, e) => s + e.capacite, 0) / withCapacity.length) : 60;
  for (const e of etablissements) { if (e.capacite_estimee) e.capacite = avgCapacity; }
  const totalLits = etablissements.reduce((s, e) => s + e.capacite, 0);
  return { etablissements: etablissements.slice(0, 25), count: etablissements.length, total_lits: totalLits, prix_stats: prixStats, tarifs_gir: girsStats, nb_ehpad_departement: tarifs.length, sources: { cnsa_tarifs: tarifs.length, overpass: overpassResults.length }, coverage: (tarifs.length > 0 || overpassResults.length > 0) ? "ok" as Coverage : "no_data" as Coverage };
}

// ============================================================================
// SPECIFIC DATA COMPUTATION
// ============================================================================

function computeEhpadSpecific(insee: InseeData | null, bpe: BpeData | null, concurrence: Awaited<ReturnType<typeof fetchEhpadConcurrence>>) {
  const population = insee?.population ?? 50000; const pct75 = insee?.pct_75_plus ?? 10;
  const pop75 = Math.round(population * (pct75 / 100));
  const densiteLits = pop75 > 0 ? Math.round((concurrence.total_lits / pop75) * 1000 * 10) / 10 : null;
  let tauxEquipement: "sous_equipe" | "equilibre" | "sur_equipe" = "equilibre";
  let potentiel: "fort" | "moyen" | "faible" = "moyen";
  if (densiteLits !== null) { if (densiteLits < 80) { tauxEquipement = "sous_equipe"; potentiel = "fort"; } else if (densiteLits > 150) { tauxEquipement = "sur_equipe"; potentiel = "faible"; } }
  const coutMensuelEstime = concurrence.prix_stats?.prix_hebergement_moyen && concurrence.tarifs_gir?.tarif_gir_1_2_moyen ? Math.round((concurrence.prix_stats.prix_hebergement_moyen + concurrence.tarifs_gir.tarif_gir_1_2_moyen) * 30.5) : null;
  return { concurrence, demographie_senior: { population_75_plus: pop75, pct_75_plus: pct75 }, offre_sante: { pharmacies: bpe?.nb_pharmacies ?? 0 }, indicateurs_marche: { densite_lits_1000_seniors: densiteLits, taux_equipement_zone: tauxEquipement, potentiel_marche: potentiel }, analyse_prix: concurrence.prix_stats ? { ...concurrence.prix_stats, ...concurrence.tarifs_gir, cout_mensuel_moyen_gir_1_2: coutMensuelEstime, interpretation: concurrence.prix_stats.prix_hebergement_median ? (concurrence.prix_stats.prix_hebergement_median < 70 ? "Prix compétitifs" : concurrence.prix_stats.prix_hebergement_median < 90 ? "Prix dans la moyenne" : "Prix élevés") : null } : null };
}

function computeLogementSpecific(insee: InseeData | null, dvf: DvfData | null, bpe: BpeData | null) {
  const population = insee?.population ?? 50000;
  return { demographie: { menages_total: Math.round(population / 2.2), pct_logements_vacants: insee?.pct_logements_vacants ?? 5, pct_moins_15: insee?.pct_moins_15 ?? 18, pct_familles: (insee?.pct_30_44 ?? 19) + (insee?.pct_moins_15 ?? 18) }, marche_immobilier: { prix_m2_ancien: dvf?.prix_m2_median ?? null, prix_m2_neuf: dvf?.prix_m2_median ? Math.round(dvf.prix_m2_median * 1.2) : null, evolution_prix_pct: dvf?.evolution_prix_pct ?? null }, cadre_vie: { nb_ecoles: bpe?.nb_ecoles ?? 0, nb_commerces: bpe?.commerces?.count ?? 0, nb_sante: bpe?.sante?.count ?? 0 }, indicateurs_marche: { tension_locative: (insee?.densite ?? 0) > 3000 ? "forte" : (insee?.densite ?? 0) > 1000 ? "moyenne" : "faible", attractivite_familiale: (bpe?.nb_ecoles ?? 0) >= 3 ? "forte" : "moyenne" } };
}

function computeCommerceSpecific(insee: InseeData | null, bpe: BpeData | null, transport: TransportData | null) {
  const revenuMedian = insee?.revenu_median ?? null; const revenuForCalc = revenuMedian ?? 21500;
  return { zone_chalandise: { population: insee?.population ?? 0, revenu_median: revenuMedian, pouvoir_achat: revenuForCalc > 25000 ? "élevé" : revenuForCalc > 20000 ? "moyen" : "faible", pouvoir_achat_indice: Math.round((revenuForCalc / 21500) * 100) }, concurrence: { commerces_total: bpe?.commerces?.count ?? 0, supermarches: bpe?.nb_supermarches ?? 0 }, flux_pietons: { score_flux: transport?.score ?? 50, proximite_metro: transport?.has_metro_train ?? false, proximite_tram: transport?.has_tram ?? false }, indicateurs_marche: { dynamisme_zone: (transport?.score ?? 0) > 70 ? "fort" : "moyen", saturation_commerciale: (bpe?.commerces?.count ?? 0) > 30 ? "élevée" : "normale" } };
}

function computeBureauxSpecific(insee: InseeData | null, transport: TransportData | null) {
  const population = insee?.population ?? 50000; const pctActifs = insee?.pct_actifs ?? 45;
  return { accessibilite: { score_transport: transport?.score ?? 50, metro_train: transport?.has_metro_train ?? false, tram: transport?.has_tram ?? false }, bassin_emploi: { population_active_estimee: Math.round(population * (pctActifs / 100)), pct_actifs: pctActifs, taux_chomage: insee?.taux_chomage ?? 7.5 }, indicateurs_marche: { attractivite_entreprises: (transport?.score ?? 0) > 75 ? "forte" : "moyenne", accessibilite_critique: transport?.has_metro_train ?? false } };
}

function computeEtudiantSpecific(insee: InseeData | null, bpe: BpeData | null, transport: TransportData | null) {
  const population = insee?.population ?? 50000; const pctEtudiants = insee?.pct_etudiants ?? 6; const hasUniv = (bpe?.nb_universites ?? 0) >= 1;
  return { population_etudiante: { estimee: Math.round(population * (pctEtudiants / 100)), pct_etudiants: pctEtudiants, pct_15_29: insee?.pct_15_29 ?? 16, presence_universitaire: hasUniv, nb_etablissements_superieurs: bpe?.nb_universites ?? 0 }, accessibilite: { score_transport: transport?.score ?? 50, metro_train: transport?.has_metro_train ?? false }, cadre_vie: { nb_bibliotheques: bpe?.loisirs?.count ?? 0, nb_loisirs: bpe?.loisirs?.count ?? 0 }, indicateurs_marche: { potentiel_marche: hasUniv || pctEtudiants > 8 ? "fort" : pctEtudiants > 5 ? "moyen" : "faible", marche_locatif: (insee?.pct_locataires ?? 0) > 50 ? "actif" : "modéré" } };
}

function computeHotelSpecific(insee: InseeData | null, bpe: BpeData | null, transport: TransportData | null) {
  return { accessibilite: { score_transport: transport?.score ?? 50, metro_train: transport?.has_metro_train ?? false, tram: transport?.has_tram ?? false }, attractivite: { population: insee?.population ?? 0, densite: insee?.densite ?? 0, nb_loisirs: bpe?.loisirs?.count ?? 0, zone_touristique: (bpe?.loisirs?.count ?? 0) >= 5 }, indicateurs_marche: { potentiel: (transport?.score ?? 0) > 60 && (bpe?.loisirs?.count ?? 0) >= 3 ? "fort" : "moyen" } };
}

// ============================================================================
// SCORING DIFFÉRENCIÉ — v1.3.7 : exclusion transport si !is_urban
// ============================================================================

interface ScoreAdjustment { label: string; value: number; type: 'bonus' | 'malus'; }

interface ScoringResult {
  demande: number; offre: number; accessibilite: number; environnement: number; global: number;
  adjustments: ScoreAdjustment[]; explanation: string;
  transport_exclu: boolean;
}

function computeDifferentiatedScores(
  dvf: DvfData | null, insee: InseeData | null, transport: TransportData | null,
  bpe: BpeData | null, specific: Record<string, unknown> | null, projectType: ProjectType,
): ScoringResult {
  const config = PROJECT_CONFIG[projectType];
  const weights = config.weights;
  const adjustments: ScoreAdjustment[] = [];
  let demande = 50, offre = 50, accessibilite = 50, environnement = 50;

  // ── Demande ──────────────────────────────────────────────────────────────
  if (projectType === "ehpad") {
    const pct75 = insee?.pct_75_plus ?? 10;
    if (pct75 > 14) { demande += 25; adjustments.push({ label: "Pop. 75+ élevée", value: 25, type: 'bonus' }); }
    else if (pct75 > 11) { demande += 15; adjustments.push({ label: "Pop. 75+ correcte", value: 15, type: 'bonus' }); }
    else if (pct75 < 8) { demande -= 15; adjustments.push({ label: "Pop. 75+ faible", value: -15, type: 'malus' }); }
    const ind = specific?.indicateurs_marche as { potentiel_marche?: string } | undefined;
    if (ind?.potentiel_marche === "fort") { demande += 15; adjustments.push({ label: "Fort potentiel marché", value: 15, type: 'bonus' }); }
    else if (ind?.potentiel_marche === "faible") { demande -= 20; adjustments.push({ label: "Faible potentiel", value: -20, type: 'malus' }); }
  } else if (projectType === "residence_etudiante") {
    const pctEtudiants = insee?.pct_etudiants ?? 6; const pct1529 = insee?.pct_15_29 ?? 16;
    if (pctEtudiants > 10) { demande += 30; adjustments.push({ label: "Zone très étudiante", value: 30, type: 'bonus' }); }
    else if (pctEtudiants > 7) { demande += 20; adjustments.push({ label: "Zone étudiante", value: 20, type: 'bonus' }); }
    else if (pctEtudiants < 4) { demande -= 15; adjustments.push({ label: "Peu d'étudiants", value: -15, type: 'malus' }); }
    if (pct1529 > 22) { demande += 10; adjustments.push({ label: "Pop. jeune élevée", value: 10, type: 'bonus' }); }
    const hasUniv = (specific?.population_etudiante as { presence_universitaire?: boolean } | undefined)?.presence_universitaire;
    if (hasUniv) { demande += 15; adjustments.push({ label: "Présence universitaire", value: 15, type: 'bonus' }); }
  } else if (projectType === "commerce") {
    const revenu = insee?.revenu_median ?? 21500; const densite = insee?.densite ?? 0;
    if (revenu > 26000) { demande += 20; adjustments.push({ label: "Haut pouvoir d'achat", value: 20, type: 'bonus' }); }
    else if (revenu > 23000) { demande += 10; adjustments.push({ label: "Bon pouvoir d'achat", value: 10, type: 'bonus' }); }
    else if (revenu < 19000) { demande -= 15; adjustments.push({ label: "Pouvoir d'achat faible", value: -15, type: 'malus' }); }
    if (densite > 3000) { demande += 15; adjustments.push({ label: "Zone très dense", value: 15, type: 'bonus' }); }
    else if (densite > 1000) { demande += 8; }
    else if (densite < 300) { demande -= 10; adjustments.push({ label: "Zone peu dense", value: -10, type: 'malus' }); }
  } else if (projectType === "bureaux") {
    if ((insee?.pct_actifs ?? 45) > 50) { demande += 15; adjustments.push({ label: "Fort bassin d'actifs", value: 15, type: 'bonus' }); }
    else if ((insee?.pct_actifs ?? 45) < 40) { demande -= 10; adjustments.push({ label: "Bassin d'actifs limité", value: -10, type: 'malus' }); }
    if ((insee?.taux_chomage ?? 7.5) > 10) { demande -= 10; adjustments.push({ label: "Chômage élevé", value: -10, type: 'malus' }); }
  } else if (projectType === "logement") {
    const pop = insee?.population ?? 0;
    if (pop > 100000) { demande += 15; adjustments.push({ label: "Grande agglomération", value: 15, type: 'bonus' }); }
    else if (pop > 30000) { demande += 8; }
    if ((insee?.pct_moins_15 ?? 18) > 20) { demande += 10; adjustments.push({ label: "Zone familiale", value: 10, type: 'bonus' }); }
    const tv = insee?.pct_logements_vacants ?? 8;
    if (tv > 12) { demande -= 15; adjustments.push({ label: "Vacance élevée", value: -15, type: 'malus' }); }
    else if (tv < 5) { demande += 10; adjustments.push({ label: "Tension locative", value: 10, type: 'bonus' }); }
  } else if (projectType === "hotel") {
    if ((bpe?.loisirs?.count ?? 0) >= 5) { demande += 15; adjustments.push({ label: "Zone touristique", value: 15, type: 'bonus' }); }
    if ((insee?.densite ?? 0) > 2000) { demande += 10; }
  }

  // ── Offre ────────────────────────────────────────────────────────────────
  if (projectType === "ehpad") {
    const ind2 = specific?.indicateurs_marche as { taux_equipement_zone?: string } | undefined;
    if (ind2?.taux_equipement_zone === "sous_equipe") { offre += 25; adjustments.push({ label: "Zone sous-équipée", value: 25, type: 'bonus' }); }
    else if (ind2?.taux_equipement_zone === "sur_equipe") { offre -= 25; adjustments.push({ label: "Zone sur-équipée", value: -25, type: 'malus' }); }
    if ((specific?.concurrence as { count?: number } | undefined)?.count ?? 0 > 10) { offre -= 10; adjustments.push({ label: "Forte concurrence", value: -10, type: 'malus' }); }
  } else if (projectType === "commerce") {
    const nb = bpe?.commerces?.count ?? 0;
    if (nb > 30) { offre -= 15; adjustments.push({ label: "Forte concurrence commerciale", value: -15, type: 'malus' }); }
    else if (nb > 5 && nb < 20) { offre += 10; adjustments.push({ label: "Zone commerciale équilibrée", value: 10, type: 'bonus' }); }
  } else {
    // v1.4.0 — Ces deux seuils étaient faussés par le périmètre départemental.
    // `nb_transactions` valait 500 (le plafond) pour TOUTES les communes de
    // France : le bonus « marché liquide » de +15 était donc acquis d'office, et
    // le malus des marchés atones jamais déclenché. Le seuil de prix, lui, était
    // évalué sur une médiane départementale — Ascain ratait le bonus « > 5 000 »
    // avec 4 184 alors que la commune vaut 5 902.
    // On ne juge la liquidité que sur un périmètre COMMUNAL : au niveau
    // départemental, le volume ne dit rien du marché local.
    if (dvf?.perimetre === 'commune') {
      if (dvf.nb_transactions > 50) offre += 15;
      else if (dvf.nb_transactions < 10) offre -= 10;
    }
    if (dvf?.prix_m2_median && dvf.perimetre === 'commune') {
      if (dvf.prix_m2_median > 5000) offre += 10;
      else if (dvf.prix_m2_median < 2000) offre -= 10;
    }
  }

  // ── Environnement ────────────────────────────────────────────────────────
  // ⚠️ v1.4.3 — CE PILIER MESURE LES ÉQUIPEMENTS, PAS L'ENVIRONNEMENT.
  // Il vaut le score BPE, majoré de bonus d'équipement. Son nom induit en
  // erreur : sur Ascain, un 80/100 a été lu par le Copilot comme « un cadre
  // favorable », alors qu'il ne dit rien du cadre de vie, du bruit, des risques
  // ni de la qualité paysagère. Le libellé exposé le précise désormais.
  environnement = bpe?.score ?? 50;

  // Les bonus ne sont accordés que sur un extrait BPE COMPLET.
  // Asymétrie corrigée : sur un extrait partiel, une catégorie absente ne
  // pénalise jamais (aucun malus n'existe) tandis qu'une catégorie présente
  // accorde un bonus. Le score ne pouvait donc que monter, précisément là où la
  // donnée est la moins fiable. Ascain : extrait de 18 lignes, confiance
  // « faible », et pourtant +10 pour « ≥ 3 écoles » — les 3 seules lignes C108
  // que contient l'extrait.
  const bpeComplet = (bpe?.bpe_quality as Record<string, unknown> | null)?.full_coverage === true;
  if (!bpeComplet) {
    adjustments.push({
      label: "Bonus d'équipement non appliqués : extrait BPE partiel",
      value: 0, type: 'malus',
    });
  } else if (projectType === "logement") {
    if ((bpe?.nb_ecoles ?? 0) >= 3) { environnement += 10; adjustments.push({ label: "Écoles à proximité", value: 10, type: 'bonus' }); }
    if ((bpe?.commerces?.count ?? 0) >= 5) environnement += 5;
  } else if (projectType === "ehpad") {
    if ((bpe?.sante?.count ?? 0) >= 3) { environnement += 15; adjustments.push({ label: "Services de santé", value: 15, type: 'bonus' }); }
    if ((bpe?.nb_pharmacies ?? 0) >= 2) environnement += 5;
  } else if (projectType === "residence_etudiante") {
    if ((bpe?.loisirs?.count ?? 0) >= 3) { environnement += 10; adjustments.push({ label: "Loisirs à proximité", value: 10, type: 'bonus' }); }
  }

  // ── Accessibilité / Transport (v1.5.0) ───────────────────────────────────
  // Le pilier n'est plus écarté sur un critère d'urbanité mais sur un critère
  // de MESURE, propre au régime appliqué. Son poids n'est redistribué que si
  // rien n'a pu être mesuré dans le régime retenu.
  demande       = Math.max(0, Math.min(100, demande));
  offre         = Math.max(0, Math.min(100, offre));
  environnement = Math.max(0, Math.min(100, environnement));

  // ── v1.4.0 — Deux motifs distincts d'exclusion du pilier accessibilité ────
  // Corriger `is_urban` (point 3) ne suffit pas : Ascain devient urbaine, donc
  // le pilier rentrerait dans le calcul avec le score 0 renvoyé par un Overpass
  // qui n'a trouvé aucun arrêt — alors que la commune est desservie par Txik
  // Txak et que la gare TER de Saint-Jean-de-Luz est à 5,9 km. On échangerait
  // un faux « non applicable » contre un faux « 0/100 », ce qui est PIRE :
  // le zéro entre dans la moyenne, l'exclusion non.
  // Règle retenue, cohérente avec « pas de donnée ⇒ pas de pilier » :
  // on n'évalue l'accessibilité que si une desserte a été RÉELLEMENT mesurée.
  // ── v1.5.0 — La mesure dépend du régime ───────────────────────────────────
  // La règle « pas de donnée ⇒ pas de pilier » ne change pas ; ce qui change,
  // c'est CE QU'ON CHERCHE À MESURER. v1.4.0 écartait l'accessibilité d'Ascain
  // faute d'arrêt à pied dans 1 km — un critère sans objet pour une ceinture
  // urbaine. En régime routier, la desserte est mesurée dès que la base des
  // gares a répondu ; `!isUrban` n'entre plus dans l'exclusion, parce qu'une
  // commune rurale a désormais un barème qui lui correspond au lieu d'être
  // déclarée hors sujet.
  const regime = transport?.regime ?? 'transports_commun';

  const dessertMesuree = regime === 'routier'
    ? (transport?.rail?.coverage === 'ok')
    : (transport?.coverage === 'ok' && (transport?.stops?.length ?? 0) > 0);

  const transportExclu = !dessertMesuree;

  const motifExclusion = regime === 'routier'
    ? "non mesuré — la base des gares TER/TGV n'a pas répondu"
    : transport?.coverage !== 'ok'
      ? "non mesuré — source de desserte (Overpass) indisponible"
      : "non mesuré — aucun arrêt référencé dans OpenStreetMap à moins d'1 km ; l'absence de référencement ne vaut pas absence de desserte";

  if (transportExclu) {
    accessibilite = 0; // valeur sentinelle — NE PAS afficher comme une note
    adjustments.push({ label: `Accessibilité écartée du score : ${motifExclusion}`, value: 0, type: 'bonus' });

    const totalOther = weights.demande + weights.offre + weights.environnement;
    const wd = weights.demande / totalOther;
    const wo = weights.offre / totalOther;
    const we = weights.environnement / totalOther;

    const global = Math.max(0, Math.min(100, Math.round(
      demande * wd + offre * wo + environnement * we,
    )));

    return {
      demande, offre, accessibilite, environnement, global, adjustments,
      transport_exclu: true,
      // Le motif est explicite : « non applicable » (fait établi) et « non
      // mesuré » (lacune de source) ne doivent plus se lire de la même façon.
      explanation: `Pondération ${projectType} — accessibilité écartée (${motifExclusion}) : demande ${Math.round(wd * 100)}%, offre ${Math.round(wo * 100)}%, environnement ${Math.round(we * 100)}%`,
    };
  }

  accessibilite = transport?.score ?? 50;

  // ⚠️ v1.5.0 — Ces bonus et malus sont ceux du régime TRANSPORTS EN COMMUN.
  // `has_metro_train` et `has_tram` y décrivent une desserte À PIED. En régime
  // routier ils valent false par construction : appliquer ce bloc y ferait
  // tomber un malus « Pas de transport lourd » de -20 sur une commune dont on
  // vient précisément de mesurer l'accessibilité autrement. Le barème routier
  // est déjà complet et plafonné dans `scoreRoadRegime` — on n'y touche plus.
  if (regime === 'transports_commun') {
    if (projectType === "bureaux") {
      if (transport?.has_metro_train) { accessibilite += 15; adjustments.push({ label: "Métro/train à proximité", value: 15, type: 'bonus' }); }
      else if (!transport?.has_metro_train && !transport?.has_tram) { accessibilite -= 20; adjustments.push({ label: "Pas de transport lourd", value: -20, type: 'malus' }); }
    } else if (projectType === "residence_etudiante") {
      if (transport?.has_metro_train) { accessibilite += 10; adjustments.push({ label: "Transports en commun", value: 10, type: 'bonus' }); }
      if ((transport?.score ?? 0) < 40) { accessibilite -= 15; adjustments.push({ label: "Accessibilité insuffisante", value: -15, type: 'malus' }); }
    } else if (projectType === "logement" || projectType === "commerce") {
      if (transport?.has_metro_train) accessibilite += 10;
      if (transport?.has_tram) accessibilite += 5;
    }
  } else {
    const rail = transport?.rail ?? null;
    adjustments.push({
      label: rail?.drive_minutes_estimated != null
        ? `Accessibilité routière : ${rail.nearest_station_name} à ${rail.nearest_station_km} km, soit ~${rail.drive_minutes_estimated} min estimées`
        : `Accessibilité routière : aucune gare TER/TGV à moins de ${RAIL_SEARCH_RADIUS_KM} km`,
      value: 0, type: 'bonus',
    });
  }

  accessibilite = Math.max(0, Math.min(100, accessibilite));

  const global = Math.max(0, Math.min(100, Math.round(
    demande * weights.demande + offre * weights.offre +
    accessibilite * weights.accessibilite + environnement * weights.environnement,
  )));

  return { demande, offre, accessibilite, environnement, global, adjustments, transport_exclu: false, explanation: `Pondération ${projectType}: ${Object.entries(weights).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${Math.round(v * 100)}%`).join(', ')}` };
}

// ============================================================================
// INSIGHTS
// ============================================================================

function generateInsights(dvf: DvfData | null, transport: TransportData | null, bpe: BpeData | null, specific: Record<string, unknown> | null, scores: ScoringResult, projectType: ProjectType, insee: InseeData | null) {
  const insights: Array<{ type: "positive" | "warning" | "negative" | "neutral"; category: string; message: string }> = [];
  if (insee?.revenu_median_source === 'dept_fallback') insights.push({ type: "warning", category: "insee", message: `Revenu médian estimé au niveau du département (source : référentiel Filosofi ${insee.departement})` });
  if (scores.global >= 70) insights.push({ type: "positive", category: "global", message: "Contexte de marché très favorable" });
  else if (scores.global >= 55) insights.push({ type: "positive", category: "global", message: "Contexte de marché favorable" });
  else if (scores.global < 40) insights.push({ type: "warning", category: "global", message: "Contexte de marché défavorable - Analyse approfondie recommandée" });
  if (dvf && dvf.nb_transactions > 0) insights.push({ type: "neutral", category: "dvf", message: `${dvf.nb_transactions} transactions DVF - Prix médian : ${dvf.prix_m2_median?.toLocaleString("fr-FR") ?? "N/A"} €/m²` });
  // ── v1.5.0 — L'insight suit le régime, pas `is_urban` ─────────────────────
  // Cette branche testait `is_urban` et écrivait « Zone non-urbaine — critère
  // transport non applicable ». Deux erreurs désormais : le critère EST
  // applicable en régime routier, et le verdict aurait contredit le score que
  // la même exécution venait de calculer. Un insight qui dément le score est
  // pire qu'un insight absent : c'est lui que le Copilot recopie en prose.
  if (transport?.regime === 'routier') {
    const rail = transport.rail;
    if (rail?.drive_minutes_estimated != null) {
      const tgv = rail.nearest_tgv_km != null
        ? `, gare TGV de ${rail.nearest_tgv_name} à ${rail.nearest_tgv_km} km`
        : "";
      insights.push({
        type: rail.drive_minutes_estimated <= 20 ? "positive" : "neutral",
        category: "transport",
        message: `Accessibilité routière : ${rail.nearest_station_name} à ${rail.nearest_station_km} km, `
          + `soit environ ${rail.drive_minutes_estimated} min de voiture (estimation)${tgv}`,
      });
    } else if (rail?.coverage === 'ok') {
      insights.push({ type: "warning", category: "transport", message: `Aucune gare TER ou TGV à moins de ${RAIL_SEARCH_RADIUS_KM} km` });
    } else {
      insights.push({ type: "neutral", category: "transport", message: "Accessibilité non mesurée — la base des gares n'a pas répondu" });
    }
  } else if (transport?.coverage === 'ok') {
    if (transport.has_metro_train) insights.push({ type: "positive", category: "transport", message: "Excellente desserte transport (métro/train)" });
    else if (transport.has_tram) insights.push({ type: "positive", category: "transport", message: "Bonne desserte transport (tramway)" });
    else if ((transport.score ?? 0) < 40) insights.push({ type: "warning", category: "transport", message: "Accessibilité transport limitée" });
  } else {
    insights.push({ type: "neutral", category: "transport", message: "Accessibilité non mesurée — source de desserte indisponible" });
  }
  if (bpe && bpe.total_equipements > 0) {
    if (bpe.sante.count >= 3) insights.push({ type: "positive", category: "services", message: `${bpe.sante.count} établissements de santé à proximité` });
    if (bpe.commerces.count >= 5) insights.push({ type: "positive", category: "services", message: `${bpe.commerces.count} commerces de proximité` });
    if (bpe.education.count >= 2) insights.push({ type: "positive", category: "services", message: `${bpe.education.count} établissements d'enseignement à proximité` });
    if (bpe.loisirs.count >= 3) insights.push({ type: "positive", category: "services", message: `${bpe.loisirs.count} équipements de loisirs à proximité` });
  }
  const ind = specific?.indicateurs_marche as { taux_equipement_zone?: string; tension_locative?: string } | undefined;
  if (ind?.taux_equipement_zone === "sous_equipe") insights.push({ type: "positive", category: "concurrence", message: "Zone sous-équipée - Fort potentiel de développement" });
  else if (ind?.taux_equipement_zone === "sur_equipe") insights.push({ type: "warning", category: "concurrence", message: "Zone sur-équipée - Concurrence élevée" });
  if (ind?.tension_locative === "forte") insights.push({ type: "positive", category: "marche", message: "Marché locatif tendu - Forte demande" });
  const ap = specific?.analyse_prix as { prix_hebergement_median?: number; interpretation?: string } | undefined;
  if (ap?.prix_hebergement_median) insights.push({ type: "neutral", category: "prix", message: `Prix hébergement médian : ${ap.prix_hebergement_median.toFixed(0)} €/jour (${ap.interpretation})` });
  for (const adj of scores.adjustments.slice(0, 3)) {
    if (adj.type === 'bonus' && adj.value >= 15) insights.push({ type: "positive", category: "scoring", message: adj.label });
    else if (adj.type === 'malus' && adj.value <= -15) insights.push({ type: "warning", category: "scoring", message: adj.label });
  }
  return insights.slice(0, 10);
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const startTime = Date.now();

  try {
    if (req.method !== "POST") return jsonResponse({ success: false, version: VERSION, error: "Method not allowed" }, 405);

    let payload: Record<string, unknown>;
    try { payload = await req.json(); }
    catch { return jsonResponse({ success: false, version: VERSION, error: "Invalid or empty JSON body" }, 400); }

    const isDebug = !!payload.debug;
    const timings: Record<string, number> = {};

    const t0 = Date.now();
    const location = await resolveCoordinates(payload);
    timings.geocoding = Date.now() - t0;

    if (!location) return jsonResponse({ success: false, version: VERSION, error: "Impossible de géolocaliser. Fournir: address, commune_insee, parcel_id, ou lat/lon." }, 400);

    const { lat, lon } = location;
    const projectType = normalizeProjectType(payload.project_type as string | undefined);
    const config = PROJECT_CONFIG[projectType];
    const radiusKm = Math.min(Math.max(Number(payload.radius_km) || config.defaultRadiusKm, 1), config.maxRadiusKm);

    // v1.4.1 — INSEE déjà connu ? (payload direct, ou extrait de l'IDU de la
    // parcelle) On le transmet pour permettre le repli hors-ligne si geo.api
    // ne répond pas — sinon l'étude échouait alors que tout était résoluble.
    const inseeConnu =
      (payload.commune_insee as string | undefined)
      ?? (payload.code_insee as string | undefined)
      ?? (typeof payload.parcel_id === 'string'
            ? parseParcelId(payload.parcel_id)?.codeInsee
            : undefined)
      ?? null;

    const t1 = Date.now();
    const commune = await resolveCommune(lat, lon, inseeConnu);
    timings.commune = Date.now() - t1;

    const codeInsee = commune?.code_insee ?? null;
    const dept = commune?.departement ?? null;
    const communeNom = commune?.nom ?? null;

    // v1.3.7 : population transmise à fetchTransport
    const communePopulation = commune?.population ?? null;

    const [dvf, insee, transport, bpe] = await Promise.all([
      // v1.4.0 : codeInsee transmis en 3e argument → périmètre COMMUNAL.
      (async () => { const t = Date.now(); const r = await fetchDvfFromSupabase(dept, communeNom, codeInsee); timings.dvf = Date.now() - t; return r; })()
        .catch((e) => { console.error("[DVF] crash:", e); return { nb_transactions: 0, prix_m2_median: null, prix_m2_moyen: null, prix_m2_min: null, prix_m2_max: null, evolution_prix_pct: null, transactions: [], coverage: "error" as Coverage, perimetre: null, perimetre_label: null, nb_transactions_plafonne: false } as DvfData; }),
      (async () => { const t = Date.now(); const r = codeInsee ? await fetchInseeData(codeInsee, communeNom, dept) : null; timings.insee = Date.now() - t; return r; })()
        .catch((e) => { console.error("[INSEE] crash:", e); return null; }),
      // v1.3.7 : communePopulation passé en 4e argument
      // v1.4.0 : codeInsee en 5e — urbanité lue dans la grille INSEE.
      (async () => { const t = Date.now(); const r = await fetchTransport(lat, lon, dept, communePopulation, codeInsee); timings.transport = Date.now() - t; return r; })()
        // v1.5.0 : le `as TransportData` masquait l'absence des nouveaux champs.
        // On les renseigne sincèrement — regime_source 'repli' et rail null
        // disent que rien n'a été mesuré, au lieu de laisser des `undefined`
        // que les consommateurs auraient interprétés comme un régime urbain.
        .catch((e) => { console.error("[Transport] crash:", e); return { score: 0, stops: [], nearest_stop_m: null, has_metro_train: false, has_tram: false, is_urban: false, is_urban_source: null, is_urban_label: null, regime: 'transports_commun' as const, regime_source: 'repli' as const, regime_label: "régime indéterminé — la mesure de desserte a échoué", niveau_7: null, rail: null, coverage: "error" as Coverage } as TransportData; }),
      (async () => { const t = Date.now(); const r = await fetchBpeFromSupabase(lat, lon, codeInsee, dept); timings.bpe = Date.now() - t; return r; })()
        .catch((e) => { console.error("[BPE] crash:", e); return { total_equipements: 0, score: 30, commerces: { count: 0, details: [] }, sante: { count: 0, details: [] }, services: { count: 0, details: [] }, education: { count: 0, details: [] }, loisirs: { count: 0, details: [] }, nb_ecoles: 0, nb_pharmacies: 0, nb_supermarches: 0, nb_universites: 0, coverage: "error" as Coverage, bpe_quality: null } as BpeData; }),
    ]);

    let specific: Record<string, unknown> | null = null;
    const t2 = Date.now();
    try {
      if (projectType === "ehpad") { const concurrence = await fetchEhpadConcurrence(lat, lon, radiusKm, dept); specific = computeEhpadSpecific(insee, bpe, concurrence); }
      else if (projectType === "logement") specific = computeLogementSpecific(insee, dvf, bpe);
      else if (projectType === "commerce") specific = computeCommerceSpecific(insee, bpe, transport);
      else if (projectType === "bureaux") specific = computeBureauxSpecific(insee, transport);
      else if (projectType === "residence_etudiante") specific = computeEtudiantSpecific(insee, bpe, transport);
      else if (projectType === "hotel") specific = computeHotelSpecific(insee, bpe, transport);
    } catch (e) { console.error("[Specific] Error:", e); specific = null; }
    timings.specific = Date.now() - t2;

    const scores = computeDifferentiatedScores(dvf, insee, transport, bpe, specific, projectType);
    const insights = generateInsights(dvf, transport, bpe, specific, scores, projectType, insee);
    timings.total = Date.now() - startTime;

    const allWarnings: string[] = [];
    if (insee?.warnings?.length) allWarnings.push(...insee.warnings);

    const debugPayload = isDebug ? {
      timings,
      transport_is_urban: transport?.is_urban ?? false,
      transport_exclu: scores.transport_exclu,
      bpe_domain_counts: bpe ? { commerces: bpe.commerces.count, sante: bpe.sante.count, education: bpe.education.count, loisirs: bpe.loisirs.count, services: bpe.services.count } : null,
      revenu_median_source: insee?.revenu_median_source ?? null,
      economic_fields: insee ? {
        revenu_median_source: insee.revenu_median_source ?? null,
        revenu_moyen_found: insee.revenu_moyen != null, niveau_vie_median_found: insee.niveau_vie_median != null,
        pcs_found: (insee.part_cadres != null || insee.part_professions_intermediaires != null || insee.part_employes != null || insee.part_ouvriers != null),
        actifs_occupes_found: insee.part_actifs_occupes != null, population_evolution_found: insee.evolution_population_5y != null,
        revenu_evolution_found: insee.evolution_revenu_5y != null, chomage_evolution_found: insee.evolution_chomage_5y != null,
        tax_fields_found: insee.taxe_fonciere_moyenne != null, economic_data_quality: insee.economic_data_quality ?? null,
      } : null,
      bpe_quality: bpe?.bpe_quality ?? null,
    } : null;

    return jsonResponse({
      success: true, version: VERSION,
      meta: {
        lat, lon, location_source: location.source, location_label: location.label ?? null,
        commune_insee: codeInsee, commune_nom: communeNom, departement: dept,
        project_type: projectType, project_type_label: config.label,
        radius_km: radiusKm,
        generated_at: new Date().toISOString(),
        // ⚠️ v1.4.4 — PÉRIMÈTRE RÉEL DE CHAQUE SOURCE.
        // `radius_km` était exposé seul, et se lisait comme le rayon de toute
        // l'étude : « les scores demande, offre et environnement sont calculés
        // sur un rayon de 5 km autour de la parcelle ». C'est faux — les trois
        // sont COMMUNAUX. En réalité `radius_km` ne gouverne QUE la recherche de
        // concurrence EHPAD (fetchEhpadConcurrence) ; pour un projet logement il
        // ne sert à rien. Ce bloc dit ce que chaque chiffre couvre vraiment.
        perimetres: {
          dvf: dvf?.perimetre_label ?? "commune",
          insee: "commune (code INSEE)",
          bpe: "commune (filtre depcom) — PAS un rayon",
          // v1.5.0 : le périmètre du pilier accessibilité dépend du régime.
          // L'annoncer en dur à « 1 km » était faux dès qu'on sortait de la
          // ville dense, et c'est le genre de libellé que le Copilot recopie.
          transport: transport?.regime === 'routier'
            ? `rayon de ${RAIL_SEARCH_RADIUS_KM} km autour du point (gares TER/TGV, base mobility_stops)`
            : "rayon de 1 km autour du point (arrêts OpenStreetMap via Overpass)",
          accessibilite_regime: transport?.regime ?? null,
          accessibilite_regime_motif: transport?.regime_label ?? null,
          // v1.5.1 : la recette du score voyage avec le score. Sans elle, le
          // modèle en invente une — constaté sur Ascain.
          accessibilite_score_methode: transport?.regime === 'routier'
            ? ROAD_SCORE_METHOD
            : TRANSIT_SCORE_METHOD,
          ...(transport?.regime === 'routier' ? {
            accessibilite_avertissement:
              "Les minutes de trajet sont ESTIMEES a partir de la distance a vol d'oiseau "
              + `(${ROAD_ESTIMATION_METHOD}). Ne les presente jamais comme un temps de trajet mesure, `
              + "et ne les compare pas a un score d'accessibilite obtenu en regime transports en commun : "
              + `le regime routier plafonne a ${ROAD_REGIME_SCORE_CAP}/100, les deux echelles ne sont pas equivalentes. `
              + "N'ecris pas non plus que ce score reflete une desserte en bus ou un acces a un bassin d'emploi : "
              + "ni l'un ni l'autre n'est mesure ici.",
          } : {}),
          radius_km_s_applique_a: projectType === "ehpad"
            ? "recherche de concurrence EHPAD uniquement"
            : "AUCUNE source pour ce type de projet — ne l'annonce pas comme un rayon d'analyse",
          avertissement:
            "N'ecris JAMAIS que les scores demande / offre / environnement sont calcules sur un rayon en km : "
            + "ils sont communaux. Cite le perimetre reel de chaque source tel qu'indique ci-dessus.",
        },
      },
      core: { dvf, insee, transport, bpe },
      specific,
      scores: {
        demande: scores.demande, offre: scores.offre,
        // v1.3.7 : accessibilite omis si transport_exclu
        ...(scores.transport_exclu ? {} : { accessibilite: scores.accessibilite }),
        environnement: scores.environnement, global: scores.global,
        transport_exclu: scores.transport_exclu,
      },
      scoring_details: {
        weights: config.weights, adjustments: scores.adjustments,
        explanation: scores.explanation, transport_exclu: scores.transport_exclu,
        // v1.5.0 : le régime et son détail voyagent avec le score. Un 83/100
        // d'accessibilité routière et un 83/100 de desserte à pied ne disent
        // pas la même chose ; sans ce bloc, rien ne permet de les distinguer.
        accessibilite_regime: transport?.regime ?? null,
        accessibilite_regime_source: transport?.regime_source ?? null,
        accessibilite_regime_label: transport?.regime_label ?? null,
        accessibilite_score_methode: transport?.regime === 'routier'
          ? ROAD_SCORE_METHOD
          : TRANSIT_SCORE_METHOD,
        accessibilite_detail: transport?.rail ?? null,
      },
      insights,
      warnings: allWarnings.length > 0 ? allWarnings : null,
      debug: debugPayload,
    });

  } catch (err) {
    console.error("[market-study] Unhandled error:", err);
    return jsonResponse({ success: false, version: VERSION, error: String(err) }, 500);
  }
});