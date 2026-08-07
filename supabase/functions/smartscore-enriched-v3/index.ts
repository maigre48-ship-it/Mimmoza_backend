// FILE: supabase/functions/smartscore-enriched-v3/index.ts
// VERSION v4.7 - Géorisques et permis réellement branchés
// CHANGELOG v4.7:
//    La v4.5 avait cessé d'inventer (stubs → null) ; la v4.7 remplit les deux
//    trous ainsi créés avec de vraies sources. Les deux fonctions edge
//    existaient déjà en production, personne ne les appelait depuis ici.
//
//    - NEW: callEdgeFunction() — appel d'une autre fonction edge, centralisé.
//      L'URL et les en-têtes étaient reconstruits dans chaque appelant. Renvoie
//      null sur toute erreur, jamais un objet vide qui passerait pour valide.
//    - NEW: computeGeorisquesScore branché sur risk-study-v1.
//      ⚠️ `scores.global` de risk-study est un score de SÉCURITÉ (100 = sûr),
//      même sens que les autres composants du pilier : aucune inversion. Il vaut
//      null quand rien n'a été mesuré (v1.1.1) — ce null est propagé, pas
//      converti en note. La couverture (criteres_mesures/total) remonte avec le
//      score : un pilier bâti sur 4 critères sur 9 doit pouvoir se dire.
//    - NEW: fetchPermisProches branché sur promoteur-permis-construire
//      (rayon 5 km, 24 mois, communes voisines incluses).
//      ⚠️ Le contrat expose `nombreLogements` là où computeCompetitionScore lit
//      `nb_logements` : sans mappage, tous les permis auraient compté pour 0
//      logement et la concurrence serait sortie « très faible » quel que soit le
//      volume — exactement la panne silencieuse des hooks d'analyse rapide.
//      La distinction null (source muette → pilier écarté) / [] (source
//      interrogée, aucun permis) est préservée.
//
// VERSION v4.6 - Urbanité et rayons de recherche issus de la grille INSEE
// CHANGELOG v4.6:
//    `isRural` valait `!isInGrandeAgglomeration(insee)` : la négation d'une liste
//    blanche de 14 départements et de quelques centaines de codes INSEE. Ce
//    n'était pas un calcul mais une omission — Ascain, Bayonne (51 000 hab.) et
//    Pau sortaient « rurales » parce que le 64 n'avait pas été saisi dans un Set.
//
//    ⚠️ Le point délicat : ce prédicat binaire faisait DEUX métiers.
//      1. un libellé de classification (zone_type, pondérations, score de bruit) ;
//      2. une politique de RAYONS de recherche — 500 m urbain / 20 km rural.
//    Corriger le seul libellé aurait fait passer Ascain de 20 km à 500 m : les
//    services essentiels d'une ceinture urbaine de 4 658 habitants auraient
//    disparu du calcul. Le mot réparé, la donnée cassée.
//
//    - NEW: resolveZoneProfile() lit `insee_grille_densite` (34 875 communes,
//      millésime 2026). Libellé depuis niveau_3 (1-2 urbain, 3 rural), rayons
//      GRADUÉS sur niveau_7 — les sept niveaux de la grille. L'ancien binaire
//      n'offrait que 500 m ou 20 km, un facteur 40 sans rien entre les deux.
//    - NEW: repli sur la liste en dur à l'identique si la commune est absente de
//      la table (DOM récents, fusions, code non résolu), avec `source` exposée.
//    - FIX: fetchTransportScore décidait aussi de l'applicabilité sur cette
//      liste. Toute commune hors des 14 départements était « Hors grande
//      agglomération — critère non évalué », y compris dotée d'un vrai réseau.
//    - FIX: le libellé « Non applicable » devient « Non évalué » avec motif :
//      un fait sur la commune et une lacune de source ne se lisent pas pareil.
//    - NEW: bloc `zone_profile` exposé (niveaux, libellé officiel, rayons
//      réellement appliqués, source) pour que l'écran et le Copilot citent la
//      classification INSEE au lieu de l'inférer de la densité.
//
// VERSION v4.5 - Fin des valeurs fabriquées : « pas de donnée ⇒ pas de note »
// CHANGELOG v4.5:
//    Deux piliers du SmartScore étaient alimentés par des STUBS qui renvoyaient
//    des valeurs en dur, sans qu'aucune source ne soit interrogée. Rien ne les
//    distinguait d'une mesure. Depuis l'ajout de la conclusion obligatoire dans
//    copilot-chat, le modèle les reprend et les interprète avec assurance —
//    d'où la correction.
//
//    - FIX: computeGeorisquesScore renvoyait `{ score: 70, risks_count: 0 }` en
//      dur, pesant 0,40 du pilier environnement. Un « 0 risque » inventé entrait
//      donc dans le score affiché. → renvoie null (composant écarté).
//      À BRANCHER sur risk-study-v1 (honnête depuis v1.1.1).
//    - FIX: fetchPermisProches renvoyait `[]`, lu comme « aucun permis » →
//      score 70 et libellé « Pas de concurrence identifiee ». Un pilier de poids
//      0,10 reposait sur une donnée jamais collectée. → renvoie null.
//      À BRANCHER sur promoteur-permis-construire.
//    - FIX: computeEnvironmentScore renvoie null si AUCUN composant mesuré.
//      Écarter le seul Géorisques aurait sinon fait REMONTER le score : le
//      pilier retombait sur la seule estimation de bruit (85 en « rural »).
//      Une estimation ne porte plus un pilier à elle seule.
//    - FIX: estimateNoiseScore porte un drapeau `estimated` et le dit dans son
//      libellé — ce score n'est jamais mesuré, il est déduit de la desserte ou
//      forcé à 85 selon un classement rural écrit en dur.
//    - FIX: computeSmartScoreV4 renvoie `score: null` au lieu de 50 quand aucun
//      pilier n'est disponible. Un 50 pouvait signifier « moyen » OU « rien n'a
//      répondu ».
//    - FIX: `Math.min(score, max_score_cap)` gardé contre le null, qui aurait
//      été coercé en 0 — le pire score possible là où l'on veut « non calculable ».
//    - NEW: bloc `confidence` { piliers_mesures, piliers_total, piliers_ecartes }
//      exposé, et réserve accolée au verdict quand des piliers manquent.
//
//    ⚠️ RESTE À FAIRE : `isRural` est toujours la négation d'une liste blanche de
//    14 départements écrite en dur (isInGrandeAgglomeration), et non une
//    propriété de la commune. Ascain, Bayonne et Pau en sortent « rurales ». Ce
//    prédicat pilote les rayons de recherche (500 m urbain / 20 km rural), deux
//    pondérations et le score de bruit. La table `insee_grille_densite`
//    (34 875 communes) contient l'information et n'est lue nulle part ici.
//
// VERSION v4.4 - Transport GTFS PostGIS (transport-score-gtfs-v1) en priorité
// CHANGELOG v4.4:
//    - NEW: MobilityGtfsResult type + extractMobilityFromGtfsResponse helper
//    - REPLACE: fetchTransportScore appelle transport-score-gtfs-v1 en priorité
//    - KEEP: fallback /transport-score OSM + IDFM inchangés
//    - NEW: mobility_gtfs exposé dans output.market.transport (handlers market_study + standard)
//    - applicable=true hors grande agglo si GTFS détecte rail national (TER/TGV)
// CHANGELOG v4.3:
//    - REWRITE: fetchEssentialServicesRaw interroge Overpass en live (une requête union multi-catégories)
//    - NEW: osmTagsToTypeCode — mapping OSM tags → type_codes BPE compatibles avec ESSENTIAL_BUCKET_BY_TYPE_CODE
//    - NEW: buildOverpassEssentialsQuery — requête Overpass couvrant toutes les catégories essentielles
//    - Cache: TTL 7 jours pour résultats Overpass (clé lat/lon arrondis + rayon)
//    - FALLBACK: repli RPC get_bpe_essentiels_radius si Overpass échoue ou renvoie 0 résultat
//    - KEEP: fetchEssentialServicesViaRpc, buildEssentialServicesBlock, computeEssentialServicesScore inchangés
// CHANGELOG v4.2:
//    - FIX: EssentialServicesScoreResult.score devient number | null
//    - FIX: computeEssentialServicesScore renvoie null si aucun équipement trouvé (foundCount=0)
// CHANGELOG v4.1:
//    - NEW: DPE bien as dedicated business block
//    - NEW: Types DpeConstraint, EnergyRenovationEstimate, EnergyBusinessImpact
//    - NEW: SmartScore V4 score cap based on DPE constraint

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as turf from "https://esm.sh/@turf/turf@6.5.0";

import { finessEhpadNearby } from "../_shared/providers/finess.ts";
import { servicesProximiteV1 } from "../_shared/providers/services_proximite.ts";
import { weightedAverage } from "../_shared/providers/scoring.ts";
import type { Coverage } from "../_shared/providers/types.ts";

// v4.0: SmartScore V4 INLINED
// ====================================================================
type RuralAccessibilityResult = { score: number; details: Record<string, number | null> };
type EssentialServicesScoreResult = { score: number | null; details: Record<string, number | null> };
function _v4distScore(distM: number | null | undefined, idealM: number, maxM: number): number {
  if (distM == null) return 0; if (distM <= idealM) return 100; if (distM >= maxM) return 0;
  return Math.round(100 * (1 - (distM - idealM) / (maxM - idealM)));
}
function computeEssentialServicesScore(es: any): EssentialServicesScoreResult {
  const scores: Record<string, number | null> = {};
  const buckets = [{key:"pharmacie",ideal:500,max:10000},{key:"commerce_alimentaire",ideal:300,max:5000},{key:"medecin_generaliste",ideal:500,max:10000},{key:"banque_dab",ideal:500,max:8000},{key:"poste",ideal:500,max:8000},{key:"station_service",ideal:1000,max:15000},{key:"dentiste",ideal:500,max:10000}];
  let total = 0, foundCount = 0;
  for (const b of buckets) {
    const nearest = es?.[b.key]?.nearest;
    const s = nearest ? _v4distScore(nearest.distance_m, b.ideal, b.max) : 0;
    scores[b.key] = s;
    total += s;
    if (nearest) foundCount++;
  }
  return { score: foundCount > 0 ? Math.round(total / buckets.length) : null, details: scores };
}
function computeRuralAccessibilityScore(servicesRuraux: any, _es: any): RuralAccessibilityResult {
  if (!servicesRuraux) return { score: 50, details: {} };
  const details: Record<string, number | null> = {}; const items: number[] = [];
  const check = (field: string, idealKm: number, maxKm: number) => { const item = servicesRuraux?.[field]; if (item?.distance_km != null) { const s = _v4distScore(item.distance_km * 1000, idealKm * 1000, maxKm * 1000); details[field] = s; items.push(s); } else { details[field] = null; } };
  check("pharmacie_proche",3,15); check("supermarche_proche",5,20); check("medecin_proche",5,20); check("poste_proche",3,15); check("banque_proche",5,15); check("station_service_proche",5,20);
  return { score: items.length > 0 ? Math.round(items.reduce((a, b) => a + b, 0) / items.length) : 50, details };
}
function computeSmartScoreV4(input: { essentialServicesScore: number | null; ruralAccessibilityScore: number | null; transportScore: number | null; transportApplicable: boolean; ecolesScore: number | null; commoditesScore: number | null; santeScore: number | null; marketCompositeScore: number | null; environmentScore: number | null; demographicScore: number | null; competitionScore: number | null; priceOpportunityScore: number | null; isRural: boolean; projectNature: string; }): { score: number | null; verdict: string; pillar_scores: Record<string, number | null>; weights: Record<string, number>; confidence: { piliers_mesures: number; piliers_total: number; piliers_ecartes: string[] } } {
  const w: Record<string, number> = {}; const p: Record<string, number | null> = {};
  w.market = 0.15; p.market = input.marketCompositeScore;
  if (input.priceOpportunityScore != null) { w.price_opportunity = 0.20; p.price_opportunity = input.priceOpportunityScore; }
  w.services = input.isRural ? 0.15 : 0.10; p.services = input.essentialServicesScore ?? input.commoditesScore;
  if (input.transportApplicable && input.transportScore != null) { w.transport = 0.15; p.transport = input.transportScore; }
  if (input.ecolesScore != null) { w.ecoles = 0.10; p.ecoles = input.ecolesScore; }
  if (input.santeScore != null) { w.sante = 0.10; p.sante = input.santeScore; }
  if (input.environmentScore != null) { w.environment = 0.10; p.environment = input.environmentScore; }
  if (input.demographicScore != null) { w.demographie = 0.10; p.demographie = input.demographicScore; }
  if (input.competitionScore != null) { w.competition = 0.10; p.competition = input.competitionScore; }
  if (input.isRural && input.ruralAccessibilityScore != null) { w.rural_accessibility = 0.10; p.rural_accessibility = input.ruralAccessibilityScore; }
  const totalW = Object.values(w).reduce((a, b) => a + b, 0);
  if (totalW > 0) for (const k of Object.keys(w)) w[k] = w[k] / totalW;
  let sum = 0, wSum = 0;
  for (const k of Object.keys(w)) { const val = p[k]; if (val != null) { sum += w[k] * val; wSum += w[k]; } }

  // v4.5 — Indicateur de confiance. Le score global était déjà renormalisé sur
  // les piliers disponibles (bon réflexe), mais RIEN n'indiquait combien de
  // piliers l'avaient produit : un SmartScore assis sur 2 piliers sur 10 se
  // lisait exactement comme un score complet.
  const piliersRetenus = Object.keys(w).filter((k) => p[k] != null);
  const piliersEcartes = Object.keys(p).filter((k) => p[k] == null);

  // AVANT : `wSum > 0 ? … : 50`. Un 50/100 pouvait donc signifier « moyen » OU
  // « aucune source n'a répondu », sans distinction possible en aval.
  if (wSum <= 0) {
    console.warn("[SmartScore V4] aucun pilier disponible -> score null (et non 50)");
    return {
      score: null,
      verdict: "Score non calculable : aucune source n'a repondu. Ne pas interpreter comme un potentiel moyen.",
      pillar_scores: p, weights: w,
      confidence: { piliers_mesures: 0, piliers_total: Object.keys(p).length, piliers_ecartes: piliersEcartes },
    };
  }

  const score = Math.round(sum / wSum);
  let verdict: string;
  if (score >= 75) verdict = "Excellent potentiel (V4). Emplacement tres favorable.";
  else if (score >= 60) verdict = "Bon potentiel (V4). Conditions favorables.";
  else if (score >= 45) verdict = "Potentiel modere (V4). Points d'attention identifies.";
  else if (score >= 30) verdict = "Potentiel limite (V4). Vigilance requise.";
  else verdict = "Potentiel faible (V4). Analyse approfondie necessaire.";

  // La réserve est accolée au verdict : c'est la chaîne que le LLM reprend.
  if (piliersEcartes.length > 0) {
    verdict += ` Etabli sur ${piliersRetenus.length} pilier(s) sur ${Object.keys(p).length}`
      + ` (non mesure : ${piliersEcartes.join(", ")}) - a interpreter avec prudence.`;
  }

  return {
    score, verdict, pillar_scores: p, weights: w,
    confidence: {
      piliers_mesures: piliersRetenus.length,
      piliers_total: Object.keys(p).length,
      piliers_ecartes: piliersEcartes,
    },
  };
}
type PriceTrendResult = { score: number; trend: string; evolution_pct: number | null };
type LiquidityResult = { score: number; label: string; transactions_count: number };
type RentalTensionResult = { score: number; label: string };
type MarketCompositeResult = { score: number; components: { price_trend: number | null; liquidity: number | null; rental_tension: number | null } };
function computePriceTrend(dvf: any): PriceTrendResult {
  if (!dvf?.evolution_pct) return { score: 50, trend: dvf?.transactions_count > 5 ? "stable" : "unknown", evolution_pct: null };
  const e = dvf.evolution_pct;
  if (e > 5) return { score: 75, trend: "up", evolution_pct: e }; if (e > 2) return { score: 65, trend: "up", evolution_pct: e };
  if (e > -2) return { score: 50, trend: "stable", evolution_pct: e }; if (e > -5) return { score: 35, trend: "down", evolution_pct: e };
  return { score: 20, trend: "down", evolution_pct: e };
}
function computeLiquidityScore(dvf: any, horizonMonths = 24): LiquidityResult {
  if (!dvf?.transactions_count) return { score: 0, label: "Aucune transaction", transactions_count: 0 };
  const ann = dvf.transactions_count * (12 / Math.max(horizonMonths, 1));
  if (ann >= 100) return { score: 95, label: "Tres liquide", transactions_count: dvf.transactions_count };
  if (ann >= 50) return { score: 80, label: "Liquide", transactions_count: dvf.transactions_count };
  if (ann >= 20) return { score: 60, label: "Moderement liquide", transactions_count: dvf.transactions_count };
  if (ann >= 5) return { score: 40, label: "Peu liquide", transactions_count: dvf.transactions_count };
  return { score: 20, label: "Tres peu liquide", transactions_count: dvf.transactions_count };
}
async function computeRentalTension(_c: string): Promise<RentalTensionResult | null> { return null; }
function computeMarketComposite(pr: { priceTrend: PriceTrendResult | null; liquidity: LiquidityResult | null; rentalTension: RentalTensionResult | null }): MarketCompositeResult {
  let sum = 0, w = 0;
  if (pr.priceTrend) { sum += pr.priceTrend.score * 0.35; w += 0.35; }
  if (pr.liquidity) { sum += pr.liquidity.score * 0.45; w += 0.45; }
  if (pr.rentalTension) { sum += pr.rentalTension.score * 0.20; w += 0.20; }
  return { score: w > 0 ? Math.round(sum / w) : 50, components: { price_trend: pr.priceTrend?.score ?? null, liquidity: pr.liquidity?.score ?? null, rental_tension: pr.rentalTension?.score ?? null } };
}
// v4.7 : `coverage` remonte la couverture déclarée par risk-study, pour que le
// pilier environnement puisse distinguer « mesuré » de « partiellement mesuré ».
type GeorisquesScoreResult = { score: number; risks_count: number; main_risks: string[]; coverage?: string; criteres_mesures?: number | null; criteres_total?: number | null };
type DpeQuartierResult = { score: number; dpe_moyen: string | null; label: string };
type AirQualityResult = { score: number; index: number | null; label: string };
// v4.5 : `estimated` distingue une ESTIMATION d'une MESURE. Sans ce drapeau,
// rien ne permettait en aval de savoir qu'un score de bruit n'avait jamais été
// mesuré — il pesait comme une donnée réelle.
type NoiseScoreResult = { score: number; label: string; estimated?: boolean };
type EnvironmentScoreResult = { score: number | null; components: { georisques: number | null; dpe: number | null; air: number | null; noise: number | null } };
// ── v4.7 — Appel d'une autre fonction edge ──────────────────────────────────
// Centralisé : l'URL et les en-têtes étaient reconstruits dans chaque fonction
// appelante. Renvoie null sur toute erreur — jamais un objet vide qui se
// confondrait avec une réponse valide.
// ⚠️ Résolution PARESSEUSE, et non un `const` de module : `supabaseUrl` et
// `serviceKey` sont déclarés bien plus bas dans ce fichier (~l. 537). Un const
// initialisé ici les lirait dans leur zone morte temporelle et lèverait un
// ReferenceError au CHARGEMENT du module — la fonction entière ne démarrerait
// plus. On lit donc l'environnement au moment de l'appel.
function functionsBaseUrl(): string {
  return Deno.env.get("FUNCTIONS_URL")
    ?? (supabaseUrl ? supabaseUrl + "/functions/v1" : "");
}

async function callEdgeFunction(
  slug: string, body: Record<string, unknown>, timeoutMs = 12000,
): Promise<any | null> {
  const base = functionsBaseUrl();
  if (!base) return null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceKey) { headers["Authorization"] = "Bearer " + serviceKey; headers["apikey"] = serviceKey; }
  try {
    const resp = await fetch(`${base}/${slug}`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) { console.warn(`[${slug}] HTTP ${resp.status}`); return null; }
    return await resp.json();
  } catch (e) {
    console.warn(`[${slug}] indisponible:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// ── v4.7 — Géorisques BRANCHÉ sur risk-study-v1 ─────────────────────────────
// Historique : cette fonction retournait `{ score: 70, risks_count: 0 }` EN DUR
// sans jamais interroger quoi que ce soit, tout en pesant 0,40 du pilier
// environnement. La v4.5 l'a mise à null pour cesser d'inventer ; la v4.7 la
// branche pour de bon.
//
// ⚠️ Conventions à ne pas confondre : `scores.global` de risk-study est un score
// de SÉCURITÉ (100 = zone sûre), même sens que les autres composants du pilier
// environnement — il s'utilise donc directement, sans inversion. Et il vaut
// `null` quand aucun critère n'a pu être mesuré (v1.1.1) : on propage ce null
// au lieu de le convertir en note.
async function computeGeorisquesScore(communeInsee: string): Promise<GeorisquesScoreResult | null> {
  if (!communeInsee) return null;

  const raw = await callEdgeFunction("risk-study-v1", { commune_insee: communeInsee });
  if (!raw || raw.success === false) {
    console.warn("[Georisques] risk-study-v1 indisponible → composant ecarte du pilier environnement");
    return null;
  }

  const scores = (raw.scores ?? {}) as Record<string, any>;
  const securite = typeof scores.global === "number" ? scores.global : null;
  if (securite === null) {
    console.warn("[Georisques] risk-study n'a mesure aucun critere → composant ecarte");
    return null;
  }

  // Catégories réellement exposées à un risque. `inconnu` est écarté : non
  // mesuré n'est ni un risque, ni une absence de risque.
  const categories = Array.isArray(raw.categories) ? raw.categories : [];
  const exposees = categories.filter((c: any) =>
    c?.level && c.level !== "nul" && c.level !== "inconnu");

  return {
    score: securite,
    risks_count: exposees.length,
    main_risks: exposees.map((c: any) => String(c.name ?? "")).filter(Boolean).slice(0, 5),
    coverage: typeof scores.coverage === "string" ? scores.coverage : undefined,
    criteres_mesures: typeof scores.criteres_mesures === "number" ? scores.criteres_mesures : null,
    criteres_total: typeof scores.criteres_total === "number" ? scores.criteres_total : null,
  };
}
async function fetchDpeQuartier(_c: string, _lat: number, _lon: number): Promise<DpeQuartierResult | null> { return null; }
async function fetchAirQuality(_lat: number, _lon: number): Promise<AirQualityResult | null> { return null; }
// v4.5 — Le bruit n'est jamais MESURÉ ici : c'est une estimation déduite du score
// de transport, et une valeur en dur (85, « Calme ») dès que la commune est
// classée rurale — classement lui-même issu d'une liste de départements écrite
// en dur (cf. isInGrandeAgglomeration). Le libellé l'annonce désormais, et le
// drapeau `estimated` empêche cette estimation de porter seule tout le pilier.
function estimateNoiseScore(ts: number | null, rural: boolean): NoiseScoreResult {
  if (rural) return { score: 85, label: "Calme (estimation, zone classee rurale - non mesure)", estimated: true };
  if (ts == null) return { score: 60, label: "Bruit moyen estime (non mesure)", estimated: true };
  const s = Math.max(20, Math.min(90, Math.round(80 - (ts - 50) * 0.3)));
  return { score: s, label: (s >= 70 ? "Relativement calme" : s >= 50 ? "Bruit modere" : "Zone potentiellement bruyante") + " (estimation d'apres la desserte)", estimated: true };
}

// v4.5 — Renvoie null quand AUCUN composant mesuré n'est disponible.
// AVANT : `w > 0 ? … : 50` — un pilier sans aucune donnée sortait à 50/100, et
// surtout, avec les stubs Géorisques/DPE/air désactivés, le pilier retombait sur
// la seule estimation de bruit (85 en rural). Le score d'environnement aurait
// donc AUGMENTÉ en perdant sa principale composante : une estimation isolée ne
// doit pas porter un pilier à elle seule.
function computeEnvironmentScore(pr: { georisques: GeorisquesScoreResult | null; dpe: DpeQuartierResult | null; air: AirQualityResult | null; noise: NoiseScoreResult | null }): EnvironmentScoreResult | null {
  let sum = 0, w = 0;
  let measured = 0;
  if (pr.georisques) { sum += pr.georisques.score * 0.40; w += 0.40; measured++; }
  if (pr.noise) { sum += pr.noise.score * 0.25; w += 0.25; if (!pr.noise.estimated) measured++; }
  if (pr.air) { sum += pr.air.score * 0.20; w += 0.20; measured++; }
  if (pr.dpe) { sum += pr.dpe.score * 0.15; w += 0.15; measured++; }

  if (measured === 0) {
    console.warn("[SmartScore V4] environnement : aucun composant mesure (Georisques/DPE/air non branches) -> pilier ecarte");
    return null;
  }
  return { score: w > 0 ? Math.round(sum / w) : null, components: { georisques: pr.georisques?.score ?? null, dpe: pr.dpe?.score ?? null, air: pr.air?.score ?? null, noise: pr.noise?.score ?? null } };
}
type PopulationTrendResult = { trend: string; annual_pct: number | null };
type DemographicScoreResult = { score: number; populationTrend: PopulationTrendResult | null; details: { population_score: number | null; age_adequacy_score: number | null; income_score: number | null } };
async function computeDemographicScore(_c: string, insee: any, projNature: string): Promise<DemographicScoreResult | null> {
  if (!insee) return null;
  let popScore = 50; const pop = insee.population;
  if (pop != null) { if (pop >= 50000) popScore = 85; else if (pop >= 20000) popScore = 75; else if (pop >= 10000) popScore = 65; else if (pop >= 5000) popScore = 55; else if (pop >= 2000) popScore = 45; else if (pop >= 500) popScore = 35; else popScore = 25; }
  let ageScore = 55; const n = (projNature ?? "").toLowerCase();
  if ((n.includes("senior") || n.includes("ehpad")) && insee.pct_plus_65 != null) { ageScore = insee.pct_plus_65 > 25 ? 85 : insee.pct_plus_65 > 20 ? 70 : insee.pct_plus_65 > 15 ? 55 : 40; }
  else if (n.includes("etudiant") && insee.pct_moins_25 != null) { ageScore = insee.pct_moins_25 > 35 ? 85 : insee.pct_moins_25 > 25 ? 70 : 50; }
  let incScore = 50; if (insee.revenu_median) { const r = insee.revenu_median; incScore = r >= 28000 ? 85 : r >= 24000 ? 70 : r >= 20000 ? 55 : r >= 16000 ? 40 : 25; }
  return { score: Math.round(popScore * 0.30 + ageScore * 0.35 + incScore * 0.35), populationTrend: { trend: "unknown", annual_pct: null }, details: { population_score: popScore, age_adequacy_score: ageScore, income_score: incScore } };
}
type CompetitionScoreResult = { score: number; permis_count: number; logements_autorises: number; label: string; details: any[] };
// ── v4.7 — Permis BRANCHÉS sur promoteur-permis-construire ──────────────────
// Historique : retournait `[]` en dur, que computeCompetitionScore lisait comme
// « aucun permis à proximité » → 70/100 et « Pas de concurrence identifiee ». Un
// pilier de poids 0,10 reposait sur une donnée jamais collectée.
//
// Distinction préservée, et c'est tout l'intérêt :
//   `null` → la source n'a pas répondu, le pilier est ÉCARTÉ ;
//   `[]`   → la source a répondu, aucun permis dans le rayon : information réelle.
//
// ⚠️ Le contrat expose `nombreLogements` alors que computeCompetitionScore lit
// `nb_logements`. Sans ce mappage, tous les permis compteraient pour 0 logement
// et la concurrence sortirait « très faible » quel qu'en soit le volume — le
// même genre de panne silencieuse que celle des hooks d'analyse rapide.
const PERMIS_RAYON_KM = 5;
const PERMIS_PERIODE_MOIS = 24;

async function fetchPermisProches(_c: string, lat: number, lon: number): Promise<any[] | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.warn("[Permis] coordonnees absentes → concurrence non mesuree");
    return null;
  }

  const raw = await callEdgeFunction("promoteur-permis-construire", {
    latitude: lat,
    longitude: lon,
    radiusKm: PERMIS_RAYON_KM,
    periodMonths: PERMIS_PERIODE_MOIS,
    typeAutorisation: "all",
    typologie: "all",
    commune: null,      // le rayon capte aussi les communes voisines
    limit: 100,         // borne maxLimit de la fonction
    offset: 0,
    sortBy: "date",
    sortOrder: "desc",
  });

  if (!raw || !Array.isArray(raw.items)) {
    console.warn("[Permis] promoteur-permis-construire indisponible → concurrence non mesuree");
    return null;
  }

  return raw.items.map((it: any) => ({
    nb_logements: typeof it.nombreLogements === "number" ? it.nombreLogements : 0,
    date: it.dateDepot ?? null,
    distance_km: typeof it.distanceKm === "number" ? Math.round(it.distanceKm * 100) / 100 : null,
    type: it.typeAutorisation ?? null,
    nature: it.natureProjet ?? null,
    commune: it.commune ?? null,
  }));
}
function computeCompetitionScore(permis: any[], _projNature: string): CompetitionScoreResult {
  // Tableau vide = la source a répondu, aucun permis dans le périmètre. C'est
  // une information réelle, distincte du `null` renvoyé par fetchPermisProches
  // quand la source n'a pas été interrogée du tout.
  if (!permis || permis.length === 0) {
    return {
      score: 70, permis_count: 0, logements_autorises: 0,
      label: `Aucun permis recense dans un rayon de ${PERMIS_RAYON_KM} km sur ${PERMIS_PERIODE_MOIS} mois (source interrogee)`,
      details: [],
    };
  }
  const totalLog = permis.reduce((s: number, p: any) => s + (p.nb_logements ?? 0), 0);
  let score: number, label: string;
  if (totalLog >= 500) { score = 20; label = "Forte concurrence"; } else if (totalLog >= 200) { score = 35; label = "Concurrence significative"; }
  else if (totalLog >= 100) { score = 50; label = "Concurrence moderee"; } else if (totalLog >= 30) { score = 65; label = "Concurrence faible"; }
  else { score = 80; label = "Tres faible concurrence"; }
  return { score, permis_count: permis.length, logements_autorises: totalLog, label, details: permis.slice(0, 10) };
}
// ==================================================================== END V4 INLINED

// ====================================================================
// v4.1: DPE BIEN - Types & Helpers
// ====================================================================
type DpeConstraint = {
  is_blocking: boolean; severity: "none" | "warning" | "critical";
  code: string | null; title: string | null; description: string | null; max_score_cap: number | null;
};
type EnergyRenovationEstimate = {
  needed: boolean; estimated_cost_total_eur: number | null; estimated_cost_per_m2_eur: number | null;
  scenario: "none" | "light" | "medium" | "heavy"; confidence: "low" | "medium"; description: string | null;
};
type EnergyBusinessImpact = {
  rentability_penalty_score: number | null; estimated_yield_drag_pct: number | null;
  estimated_cashflow_drag_monthly_eur: number | null;
  exploitability_risk: "low" | "moderate" | "high" | "critical"; summary: string | null;
};

function mapDpeLabelToScore(label: string | null | undefined): number | null {
  if (!label) return null;
  const l = label.toString().trim().toUpperCase();
  switch (l) {
    case "A": return 95; case "B": return 90; case "C": return 80; case "D": return 65;
    case "E": return 50; case "F": return 25; case "G": return 5; default: return null;
  }
}

function buildDpeConstraint(label: string | null | undefined): DpeConstraint {
  if (!label) return { is_blocking: false, severity: "none", code: null, title: null, description: null, max_score_cap: null };
  const l = label.toString().trim().toUpperCase();
  switch (l) {
    case "G": return { is_blocking: true, severity: "critical", code: "dpe_g_blocking", title: "DPE G : interdiction de location", description: "Depuis 2025, les logements classes G sont interdits a la location. Renovation energetique lourde obligatoire avant toute mise en exploitation locative. Risque reglementaire maximal.", max_score_cap: 20 };
    case "F": return { is_blocking: true, severity: "warning", code: "dpe_f_blocking", title: "DPE F : interdiction de location imminente", description: "Les logements classes F seront interdits a la location a partir de 2028. Renovation energetique necessaire a court terme pour maintenir l'exploitabilite locative. Risque reglementaire eleve.", max_score_cap: 35 };
    case "E": return { is_blocking: false, severity: "warning", code: "dpe_e_watch", title: "DPE E : vigilance reglementaire", description: "Les logements classes E seront interdits a la location a partir de 2034. Travaux de renovation energetique a anticiper pour securiser la rentabilite a moyen terme.", max_score_cap: null };
    case "A": case "B": case "C": case "D": return { is_blocking: false, severity: "none", code: null, title: null, description: null, max_score_cap: null };
    default: return { is_blocking: false, severity: "none", code: null, title: null, description: null, max_score_cap: null };
  }
}

function estimateEnergyRenovationCost(params: { dpeLabel: string | null; surfaceM2: number | null; projectNature?: string | null; }): EnergyRenovationEstimate {
  const { dpeLabel, surfaceM2 } = params;
  if (!dpeLabel) return { needed: false, estimated_cost_total_eur: null, estimated_cost_per_m2_eur: null, scenario: "none", confidence: "low", description: null };
  const l = dpeLabel.toString().trim().toUpperCase();
  let costPerM2: number | null = null; let scenario: EnergyRenovationEstimate["scenario"] = "none"; let needed = false; let description: string | null = null;
  switch (l) {
    case "A": case "B": case "C": needed = false; scenario = "none"; description = "Performance energetique satisfaisante, pas de travaux structurants necessaires."; break;
    case "D": needed = true; costPerM2 = 80; scenario = "light"; description = "Ameliorations legeres recommandees : isolation combles, remplacement menuiseries, optimisation chauffage."; break;
    case "E": needed = true; costPerM2 = 150; scenario = "medium"; description = "Renovation energetique moderee necessaire : isolation murs/combles, remplacement systeme de chauffage, menuiseries."; break;
    case "F": needed = true; costPerM2 = 300; scenario = "heavy"; description = "Renovation energetique lourde requise : isolation globale, changement de systeme de chauffage, ventilation, menuiseries. Obligatoire pour maintenir la location apres 2028."; break;
    case "G": needed = true; costPerM2 = 450; scenario = "heavy"; description = "Renovation energetique tres lourde requise : refection complete de l'enveloppe thermique et des systemes. Location interdite en l'etat depuis 2025."; break;
    default: return { needed: false, estimated_cost_total_eur: null, estimated_cost_per_m2_eur: null, scenario: "none", confidence: "low", description: null };
  }
  const hasSurface = surfaceM2 != null && surfaceM2 > 0;
  const totalCost = (costPerM2 != null && hasSurface) ? Math.round(costPerM2 * surfaceM2!) : null;
  return { needed, estimated_cost_total_eur: totalCost, estimated_cost_per_m2_eur: costPerM2, scenario, confidence: hasSurface ? "medium" : "low", description };
}

function computeEnergyBusinessImpact(params: { dpeLabel: string | null; prix: number | null; surfaceM2: number | null; monthlyRent?: number | null; nightlyRate?: number | null; renovationCostTotalEur: number | null; }): EnergyBusinessImpact {
  const { dpeLabel, prix, renovationCostTotalEur } = params;
  if (!dpeLabel) return { rentability_penalty_score: null, estimated_yield_drag_pct: null, estimated_cashflow_drag_monthly_eur: null, exploitability_risk: "low", summary: null };
  const l = dpeLabel.toString().trim().toUpperCase();
  let exploitability_risk: EnergyBusinessImpact["exploitability_risk"] = "low"; let rentability_penalty_score: number | null = null; let summary: string | null = null;
  switch (l) {
    case "A": rentability_penalty_score = 0; exploitability_risk = "low"; summary = "Aucun impact energetique sur la rentabilite. Bien performant."; break;
    case "B": rentability_penalty_score = 5; exploitability_risk = "low"; summary = "Impact energetique negligeable. Bien performant."; break;
    case "C": rentability_penalty_score = 10; exploitability_risk = "low"; summary = "Performance energetique correcte, impact marginal sur la rentabilite."; break;
    case "D": rentability_penalty_score = 20; exploitability_risk = "moderate"; summary = "Performance energetique moyenne. Travaux legers recommandes pour optimiser la rentabilite."; break;
    case "E": rentability_penalty_score = 35; exploitability_risk = "moderate"; summary = "Performance energetique mediocre. Renovation a anticiper (interdiction location 2034). Impact significatif sur la rentabilite nette."; break;
    case "F": rentability_penalty_score = 60; exploitability_risk = "high"; summary = "Passoire energetique. Renovation lourde obligatoire avant 2028 pour maintenir la location. Fort impact sur le rendement net."; break;
    case "G": rentability_penalty_score = 85; exploitability_risk = "critical"; summary = "Passoire energetique critique. Location interdite depuis 2025. Investissement non exploitable en l'etat. Renovation tres lourde obligatoire."; break;
    default: return { rentability_penalty_score: null, estimated_yield_drag_pct: null, estimated_cashflow_drag_monthly_eur: null, exploitability_risk: "low", summary: null };
  }
  let estimated_yield_drag_pct: number | null = null;
  if (prix != null && prix > 0 && renovationCostTotalEur != null && renovationCostTotalEur > 0) estimated_yield_drag_pct = Math.round((renovationCostTotalEur / prix) * 10000) / 100;
  let estimated_cashflow_drag_monthly_eur: number | null = null;
  if (renovationCostTotalEur != null && renovationCostTotalEur > 0) estimated_cashflow_drag_monthly_eur = Math.round(renovationCostTotalEur / 120);
  return { rentability_penalty_score, estimated_yield_drag_pct, estimated_cashflow_drag_monthly_eur, exploitability_risk, summary };
}
// ==================================================================== END DPE BIEN

// ── v4.4: MobilityGtfsResult ─────────────────────────────────────────────────
type MobilityGtfsResult = {
  total: number;
  pillars: {
    rail: number | null;
    urban: number | null;
    employment: number | null;
    multimodal: number | null;
  };
  nearest_stop_m: number | null;
  has_metro_train: boolean;
  has_tram: boolean;
  is_urban: boolean;
  label: string;
  summary: string;
};
// ─────────────────────────────────────────────────────────────────────────────

console.log("smartscore-enriched-v3 orchestrator loaded (v4.4 GTFS transport)");

// ----------------------------------------------------
// SUPABASE CLIENT
// ----------------------------------------------------
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("REST_URL") ?? "";
const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } }) : null;
const MAX_PAYLOAD_BYTES = 1_048_576; // 1 Mo

// ----------------------------------------------------
// CONSTANTS
// ----------------------------------------------------
const DVF_CSV_BASE = "https://files.data.gouv.fr/geo-dvf/latest/csv";
const GEO_API_BASE = "https://geo.api.gouv.fr";
const DATA_GOUV_BPE_API = "https://tabular-api.data.gouv.fr/api/resources";
const BPE_RESOURCE_ID = "7257eb8b-f2eb-48f5-9c06-172675496269";
const INSEE_COMPARATEUR_RESOURCE_ID = "a1f09595-0e79-4300-be1d-c05efde75c4c";
const INSEE_COMPARATEUR_API_BASE = "https://tabular-api.data.gouv.fr/api/resources";
const INSEE_COMPARATEUR_CACHE_TTL = 30 * 24 * 3600;
const OVERPASS_API_URL = "https://overpass-api.de/api/interpreter";
const RAYON_URBAIN_M = 500;
const RAYON_RURAL_MIN_M = 3000;
const RAYON_RURAL_MAX_M = 20000;
// ============================================================================
// INCLUDE — exécution sélective des sources (P1-4)
// Si payload.include absent => tout calculé (rétro-compatible).
// Si présent => seules les sources listées tournent + sortie filtrée.
// ============================================================================
type IncludeKey = "dvf" | "bpe" | "insee" | "transport" | "ecoles" | "sante" | "risques";
type IncludeSet = Record<IncludeKey, boolean>;

const ALL_INCLUDE_KEYS: IncludeKey[] = ["dvf", "bpe", "insee", "transport", "ecoles", "sante", "risques"];

function resolveInclude(raw: unknown): { set: IncludeSet; full: boolean } {
  // Aucun include fourni => tout (comportement historique)
  if (!Array.isArray(raw) || raw.length === 0) {
    const set = {} as IncludeSet;
    for (const k of ALL_INCLUDE_KEYS) set[k] = true;
    return { set, full: true };
  }
  const requested = new Set(raw.map((x) => String(x).toLowerCase().trim()));
  const set = {} as IncludeSet;
  for (const k of ALL_INCLUDE_KEYS) set[k] = requested.has(k);
  return { set, full: false };
}
const CODES_COMMERCES_ESSENTIELS = new Set(["B101","B102","B104","B105","B201","B202","B207","B208","B210","G101","D301","B203","B204","B205","B206"]);
const CODES_SERVICES_ESSENTIELS = new Set(["A203","A204","A206","A207","A208","A101","A104"]);
const CODES_SANTE_ESSENTIELS = new Set(["D201","D202","D203","D204","D205","D206","D207","D208","D209","D210","D211","D221","D231","D232","D233","D235","D236","D237","D238","D239","D240","D241","D301"]);

// ----------------------------------------------------
// GRANDES AGGLOMERATIONS
// ----------------------------------------------------
const COMMUNES_GRANDES_AGGLOS = new Set<string>(["75056","92012","92014","92019","92020","92022","92023","92024","92025","92026","92032","92033","92035","92036","92040","92044","92046","92047","92048","92049","92050","92051","92060","92062","92063","92064","92071","92072","92073","92075","92076","92077","92078","93001","93005","93006","93007","93008","93010","93013","93014","93015","93027","93029","93030","93031","93032","93033","93039","93045","93046","93047","93048","93049","93050","93051","93053","93055","93057","93059","93061","93062","93063","93064","93066","93070","93071","93072","93073","93074","93077","93078","93079","94001","94002","94003","94004","94011","94015","94016","94017","94018","94019","94021","94022","94028","94033","94034","94037","94038","94041","94042","94043","94044","94046","94047","94048","94052","94053","94054","94055","94056","94058","94059","94060","94065","94067","94068","94069","94070","94071","94073","94074","94075","94076","94077","94078","94079","94080","94081"]);
const DEPARTEMENTS_GRANDES_AGGLOS = new Set<string>(["75","92","93","94","69","13","33","31","44","59","67","06","34","35"]);
const COMMUNES_METROPOLES = new Set<string>(["69123","69381","69382","69383","69384","69385","69386","69387","69388","69389","69003","69029","69033","69034","69040","69044","69046","69063","69068","69069","69071","69072","69081","69085","69087","69088","69089","69091","69096","69100","69116","69117","69127","69142","69143","69149","69152","69153","69163","69168","69191","69194","69199","69202","69204","69205","69207","69233","69244","69250","69256","69259","69260","69266","69271","69273","69275","69276","69277","69278","69279","69281","69282","69283","69284","69286","69290","69291","69292","69293","69296","13055","13001","13002","13003","13004","13005","13006","13007","13008","13009","13010","13011","13012","13013","13014","13015","13016","13201","13202","13203","13204","13205","13206","13207","13208","13209","13210","13211","13212","13213","13214","13215","13216","33063","33003","33013","33039","33056","33065","33069","33075","33096","33119","33162","33167","33192","33200","33238","33249","33273","33281","33312","33318","33376","33434","33449","33487","33519","33522","33550","31555","31003","31022","31044","31056","31069","31088","31091","31116","31149","31150","31157","31163","31165","31182","31184","31186","31205","31230","31282","31389","31395","31417","31418","31424","31445","31446","31467","31488","31490","31506","31541","31557","31561","31575","44109","44020","44026","44035","44047","44071","44074","44114","44143","44162","44172","44190","44194","44198","44204","44215","59350","59009","59011","59017","59044","59051","59056","59106","59128","59146","59152","59163","59195","59196","59201","59208","59220","59247","59250","59256","59275","59278","59279","59281","59286","59299","59303","59316","59317","59320","59328","59332","59339","59343","59346","59352","59356","59360","59367","59368","59378","59380","59381","59382","59386","59388","59410","59421","59426","59437","59457","59470","59482","59507","59508","59512","59522","59524","59527","59550","59553","59560","59566","59585","59598","59599","59602","59609","59611","59636","59643","59646","59648","59650","59653","59656","59658","59660","67482","67043","67118","67137","67180","67204","67218","67227","67252","67267","67268","67302","67309","67318","67365","67411","67447","67462","67463","67471","67506","67519","06088","06004","06011","06027","06029","06030","06031","06032","06033","06057","06069","06079","06083","06084","06085","06092","06095","06101","06104","06106","06112","06123","06127","06128","06136","06138","06149","06151","06152","06155","06157","06159","06161","34172","34022","34057","34058","34077","34087","34090","34095","34116","34120","34123","34129","34134","34145","34154","34164","34169","34179","34198","34217","34227","34249","34256","34259","34270","34295","34307","34327","34337","35238","35001","35022","35024","35047","35051","35055","35066","35068","35080","35115","35139","35196","35206","35210","35218","35240","35245","35266","35275","35278","35281","35300","35315","35334","35352","35353","38185","38057","38059","38071","38111","38126","38150","38151","38158","38169","38170","38187","38188","38200","38229","38235","38252","38258","38271","38277","38279","38281","38309","38317","38325","38328","38364","38382","38421","38423","38436","38445","38471","38472","38474","38485","38486","38516","38524","38528","38529","38533","38540","38545","38547","38553","38554","38562","76540","76005","76020","76039","76056","76069","76095","76108","76116","76157","76165","76178","76212","76216","76222","76231","76237","76269","76273","76281","76282","76285","76319","76322","76350","76354","76366","76367","76377","76378","76391","76402","76410","76429","76436","76448","76451","76457","76474","76475","76484","76486","76497","76498","76499","76514","76536","76550","76558","76560","76575","76591","76599","76608","76614","76617","76636","76640","76659","76681","76682","76684","76691","76709","76717","76750","76753","83137","83034","83047","83062","83069","83090","83098","83103","83107","83118","83126","83129","83144"]);

function isInGrandeAgglomeration(communeInsee: string | null): boolean {
  if (!communeInsee || communeInsee.length < 2) return false;
  if (COMMUNES_GRANDES_AGGLOS.has(communeInsee)) return true;
  if (COMMUNES_METROPOLES.has(communeInsee)) return true;
  const dep = communeInsee.slice(0, 2);
  return DEPARTEMENTS_GRANDES_AGGLOS.has(dep);
}

// ============================================================================
// v4.6 — PROFIL DE ZONE : grille de densité INSEE
// ============================================================================
// `isRural` valait `!isInGrandeAgglomeration(insee)` : la négation d'une liste
// blanche de 14 départements et de quelques centaines de codes INSEE. Ce n'était
// pas un calcul mais une omission — Ascain, Bayonne (51 000 hab.) et Pau
// sortaient « rurales » parce que le 64 n'avait pas été saisi dans un Set.
//
// ⚠️ Le point délicat : ce prédicat binaire faisait DEUX métiers à la fois.
//   1. un libellé de classification (zone_type, pondérations, score de bruit) ;
//   2. une politique de RAYONS de recherche — 500 m en urbain, 20 km en rural.
// Corriger le seul libellé aurait fait passer Ascain d'un rayon de 20 km à
// 500 m : les services essentiels d'une ceinture urbaine de 4 658 habitants
// auraient disparu du calcul. On aurait réparé le mot et cassé la donnée.
//
// Les deux usages sont donc séparés. Le libellé vient de `niveau_3` (1-2 =
// urbain, 3 = rural), les rayons d'une échelle GRADUÉE sur `niveau_7`, les sept
// niveaux de la grille — un rayon binaire ne convient à aucun des deux extrêmes.
type ZoneProfile = {
  isRural: boolean;
  zoneType: 'rural' | 'urbain';
  niveau_3: number | null;
  niveau_7: number | null;
  libelle_niveau_7: string | null;
  /** 'insee' = déterministe ; 'fallback' = liste en dur, commune absente de la table. */
  source: 'insee' | 'fallback';
  bpeRadius: number;
  essentialServicesRadius: number;
  ehpadRadius: number;
};

/**
 * Rayons par niveau de la grille de densité INSEE (millésime 2026) :
 *   1 Grands centres urbains          2 Centres urbains intermédiaires
 *   3 Petites villes                  4 Ceintures urbaines
 *   5 Bourgs ruraux                   6 Rural à habitat dispersé
 *   7 Rural à habitat très dispersé
 * L'ancien binaire n'offrait que 500 m ou 20 km : un facteur 40 entre deux
 * catégories voisines, et rien entre les deux.
 */
const RAYONS_PAR_NIVEAU_7: Record<number, { bpe: number; essentiels: number; ehpad: number }> = {
  1: { bpe: 500,  essentiels: 500,   ehpad: 5000 },
  2: { bpe: 700,  essentiels: 1000,  ehpad: 5000 },
  3: { bpe: 1200, essentiels: 2500,  ehpad: 8000 },
  4: { bpe: 2000, essentiels: 5000,  ehpad: 12000 },
  5: { bpe: 3000, essentiels: 10000, ehpad: 20000 },
  6: { bpe: 3000, essentiels: 20000, ehpad: 20000 },
  7: { bpe: 3000, essentiels: 20000, ehpad: 20000 },
};

async function resolveZoneProfile(communeInsee: string | null): Promise<ZoneProfile> {
  // Repli : comportement historique à l'identique, pour ne rien changer aux
  // communes absentes de la table (DOM récents, fusions, code non résolu).
  const fallback = (): ZoneProfile => {
    const isRural = !isInGrandeAgglomeration(communeInsee);
    console.warn(`[Zone] ${communeInsee ?? 'INSEE inconnu'} absent de insee_grille_densite -> repli liste en dur (${isRural ? 'rural' : 'urbain'})`);
    return {
      isRural, zoneType: isRural ? 'rural' : 'urbain',
      niveau_3: null, niveau_7: null, libelle_niveau_7: null, source: 'fallback',
      bpeRadius: isRural ? RAYON_RURAL_MIN_M : RAYON_URBAIN_M,
      essentialServicesRadius: isRural ? RAYON_RURAL_MAX_M : RAYON_URBAIN_M,
      ehpadRadius: isRural ? RAYON_RURAL_MAX_M : 5000,
    };
  };

  if (!communeInsee || !supabase) return fallback();

  try {
    const { data, error } = await supabase
      .from('insee_grille_densite')
      .select('niveau_3, niveau_7, libelle_niveau_7')
      .eq('code_insee', communeInsee)
      .maybeSingle();

    if (error || !data || data.niveau_3 == null) return fallback();

    const n7 = typeof data.niveau_7 === 'number' ? data.niveau_7 : null;
    const rayons = (n7 != null && RAYONS_PAR_NIVEAU_7[n7]) || RAYONS_PAR_NIVEAU_7[4];
    const isRural = data.niveau_3 === 3;

    return {
      isRural, zoneType: isRural ? 'rural' : 'urbain',
      niveau_3: data.niveau_3, niveau_7: n7,
      libelle_niveau_7: data.libelle_niveau_7 ?? null,
      source: 'insee',
      bpeRadius: rayons.bpe,
      essentialServicesRadius: rayons.essentiels,
      ehpadRadius: rayons.ehpad,
    };
  } catch (e) {
    console.error('[Zone] erreur lecture insee_grille_densite:', e);
    return fallback();
  }
}

// ----------------------------------------------------
// TYPES
// ----------------------------------------------------
type MarketStudyPayload = { mode: "market_study"; parcel_id?: string; commune_insee?: string | number; project_nature: string; radius_km?: number; horizon_months?: number; lat?: number; lon?: number; targets?: { unit_price_m2?: number; nightly_rate?: number; monthly_rent?: number; }; dpe_label?: string | null; debug?: boolean; };
type ResolvedPoint = { lat: number; lon: number; source: "payload" | "parcel" | "commune"; parcel_id?: string; commune_insee?: string; surface_m2?: number; };
type DvfMarketStats = { transactions_count: number; transactions_count_previous: number; price_median_eur_m2: number | null; price_mean_eur_m2: number | null; price_q1_eur_m2: number | null; price_q3_eur_m2: number | null; evolution_pct: number | null; volume_total_eur: number | null; surface_mean_m2: number | null; };
type MarketKpi = { label: string; value: string | number | null; unit?: string; trend?: "up" | "down" | "stable" | null; description?: string; };
type MarketInsight = { type: "positive" | "negative" | "neutral" | "warning"; title: string; description: string; source?: string; };
type MarketComp = { id: string; address?: string; price_m2?: number; surface_m2?: number; date?: string; type_local?: string; distance_m?: number; commune?: string; };
type StandardPayload = { mode?: "standard" | undefined; address?: string; cp?: string; ville?: string; surface?: number; prix?: number; travaux?: number; userCriteria?: Record<string, unknown>; meloId?: string; type_local?: string; dep_code?: string; commune_code?: string; lat?: number; lon?: number; parcel_id?: string; commune_insee?: string | number; transports?: unknown; radius_km?: number; horizon_months?: number; dpe_label?: string | null; debug?: boolean; };
type CoverageMap = { dvf: Coverage; transport: Coverage; ecoles: Coverage; bpe: Coverage; sante: Coverage; insee: Coverage; ehpad: Coverage; };
type SmartScoreComponents = { transport_score: number | null; ecoles_score: number | null; commodites_score: number | null; marche_score: number | null; sante_score: number | null; };
type ProfessionnelsSanteDetails = { medecins_generalistes: number; medecins_specialistes: number; dentistes: number; infirmiers: number; kinesitherapeutes: number; pharmacies: number; autres: number; };
type HopitalProche = { nom: string; commune: string; distance_km: number; type: string; } | null;
type HealthFicheEnriched = { code_commune: string; commune: string; population: number | null; densite_medecins_10000: number | null; densite_label: string; desert_medical_score: number | null; resume: string; kpi: { medecins_total: number | null; generalistes_total: number | null; generalistes_densite_10000: number | null; infirmiers_total: number | null; pharmacies_total: number | null; dentistes_total: number | null; autres_professionnels: number | null; etablissements_sante: number | null; }; professionnels_details?: ProfessionnelsSanteDetails; hopital_proche?: HopitalProche; medecins_proches?: MedecinProche[]; };
type CommerceProche = { nom: string; type: string; type_code: string; distance_m: number; distance_km?: number; adresse?: string; commune?: string; };
type MedecinProche = { nom: string; specialite: string; type_code: string; distance_m: number; distance_km?: number; adresse?: string; commune?: string; };
type ServiceEssentiel = { nom: string; type: string; type_code: string; distance_m: number; distance_km: number; adresse?: string; commune?: string; };
type ResidenceSenior = { nom: string; type: string; commune: string; distance_km: number; finess?: string; };
type ServicesRuraux = { pharmacie_proche: ServiceEssentiel | null; supermarche_proche: ServiceEssentiel | null; hypermarche_proche: ServiceEssentiel | null; superette_proche: ServiceEssentiel | null; station_service_proche: ServiceEssentiel | null; poste_proche: ServiceEssentiel | null; banque_proche: ServiceEssentiel | null; commissariat_proche: ServiceEssentiel | null; gendarmerie_proche: ServiceEssentiel | null; medecin_proche: MedecinProche | null; rayon_recherche_m: number; };
type EssentialServiceBucket = "pharmacie" | "banque_dab" | "poste" | "station_service" | "commerce_alimentaire" | "medecin_generaliste" | "medecin_specialiste" | "dentiste" | "infirmier" | "kinesitherapeute" | "gendarmerie" | "commissariat";
type EssentialServiceItem = { name: string; type_label: string; type_code: string; distance_m: number; distance_km: number; commune?: string; adresse?: string; };
type EssentialServiceSummary = { radius_km: number; count: number; nearest: EssentialServiceItem | null; top?: EssentialServiceItem[]; };
type EssentialServicesBlock = { zone_type: "rural" | "urbain"; radius_km: number; pharmacie: EssentialServiceSummary; banque_dab: EssentialServiceSummary; poste: EssentialServiceSummary; station_service: EssentialServiceSummary; commerce_alimentaire: EssentialServiceSummary; medecin_generaliste: EssentialServiceSummary; medecin_specialiste: EssentialServiceSummary; dentiste: EssentialServiceSummary; infirmier: EssentialServiceSummary; kinesitherapeute: EssentialServiceSummary; gendarmerie: EssentialServiceSummary; commissariat: EssentialServiceSummary; };
type InseeComparateurData = { code_commune: string; commune: string | null; revenu_median: number | null; taux_pauvrete: number | null; pct_proprietaires: number | null; taux_chomage: number | null; nb_menages: number | null; nb_logements: number | null; };
type InseeComparateurDebug = { ok: boolean; source: string; cache_hit: boolean; fetch_ms: number | null; error: string | null; fields_present: string[]; api_url?: string; http_status?: number; };
type InseeHybridData = { code_commune: string; commune?: string | null; population?: number | null; pct_moins_25?: number | null; pct_plus_65?: number | null; densite_pop?: number | null; revenu_median?: number | null; taux_pauvrete?: number | null; pct_proprietaires?: number | null; pension_retraite_moyenne?: number | null; taux_chomage?: number | null; nb_menages?: number | null; nb_logements?: number | null; source_comparateur?: boolean; [key: string]: unknown; };

const ESSENTIAL_BUCKET_BY_TYPE_CODE: Record<string, EssentialServiceBucket> = {
  D301: "pharmacie",
  D201: "medecin_generaliste",
  D202: "medecin_specialiste", D203: "medecin_specialiste", D204: "medecin_specialiste",
  D205: "medecin_specialiste", D206: "medecin_specialiste", D207: "medecin_specialiste",
  D208: "medecin_specialiste", D209: "medecin_specialiste", D210: "medecin_specialiste", D211: "medecin_specialiste",
  D221: "dentiste",
  D231: "infirmier", D232: "infirmier",
  D233: "kinesitherapeute", D235: "kinesitherapeute", D236: "kinesitherapeute",
  D237: "kinesitherapeute", D238: "kinesitherapeute", D239: "kinesitherapeute",
  D240: "kinesitherapeute", D241: "kinesitherapeute",
  A203: "banque_dab", A204: "banque_dab",
  A206: "poste", A207: "poste", A208: "poste",
  A101: "commissariat",
  A104: "gendarmerie",
  G101: "station_service",
  B101: "commerce_alimentaire", B104: "commerce_alimentaire",
  B102: "commerce_alimentaire", B105: "commerce_alimentaire",
  B201: "commerce_alimentaire", B208: "commerce_alimentaire",
  B202: "commerce_alimentaire", B207: "commerce_alimentaire", B210: "commerce_alimentaire",
  B203: "commerce_alimentaire", B204: "commerce_alimentaire",
  B205: "commerce_alimentaire", B206: "commerce_alimentaire",
};

const ALL_ESSENTIAL_BUCKETS: EssentialServiceBucket[] = ["pharmacie","banque_dab","poste","station_service","commerce_alimentaire","medecin_generaliste","medecin_specialiste","dentiste","infirmier","kinesitherapeute","gendarmerie","commissariat"];

// ----------------------------------------------------
// HELPERS GENERAUX
// ----------------------------------------------------
function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null || v === "") return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
}
function safeToString(v: unknown): string | null { if (v == null) return null; const s = String(v).trim(); return s ? s : null; }
function coverageLabel(c: Coverage): string { if (c === "ok") return "OK"; if (c === "no_data") return "Pas de donnees"; if (c === "not_covered") return "Non couvert"; return "Erreur"; }
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function metersToKm(m: number): number { return Math.round(m / 100) / 10; }
function normalizeTextForSearch(text: string | null | undefined): string {
  if (!text) return ""; return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// ----------------------------------------------------
// CACHE UNIVERSEL
// ----------------------------------------------------
async function getFromCache(cacheKey: string): Promise<any | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from("api_cache").select("data").eq("cache_key", cacheKey).gt("expires_at", new Date().toISOString()).single();
    if (!error && data?.data) { supabase.from("api_cache").update({ hit_count: (data as any).hit_count ? (data as any).hit_count + 1 : 1 }).eq("cache_key", cacheKey).then(() => {}); return data.data; }
  } catch (e) { console.warn("Cache read error:"); }
  return null;
}
async function saveToCache(cacheKey: string, provider: string, data: any, ttlSeconds: number): Promise<void> {
  if (!supabase) return;
  try {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await supabase.from("api_cache").upsert({ cache_key: cacheKey, provider, data, expires_at: expiresAt, hit_count: 0 }, { onConflict: "cache_key" });
  } catch (e) { console.warn("Cache write error:"); }
}

// ----------------------------------------------------
// DVF MAPPING HELPERS
// ----------------------------------------------------
function mapProjectNatureToDvfType(nature: string): string | null {
  const n = (nature ?? "").toString().toLowerCase();
  if (n === "logement") return null; if (n === "residence_senior") return "Appartement"; if (n === "residence_etudiante") return "Appartement";
  if (n === "ehpad") return "Local"; if (n === "hotel") return "Local"; if (n === "bureaux") return "Local"; if (n === "commerce") return "Local";
  if (n.includes("logement")) return null; if (n.includes("bureau")) return "Local"; if (n.includes("commerce")) return "Local"; if (n.includes("hotel")) return "Local";
  return null;
}
function normalizeStandardTypeLocal(input: unknown): string | null {
  const s = safeToString(input); if (!s) return null; const raw = s.toLowerCase();
  if (raw === "appartement") return "Appartement"; if (raw === "maison") return "Maison"; if (raw === "local") return "Local";
  if (raw === "apt" || raw === "appts" || raw.includes("appart")) return "Appartement"; if (raw.includes("maison")) return "Maison";
  if (raw.includes("bureau") || raw.includes("commerce") || raw.includes("hotel") || raw.includes("local")) return "Local";
  return mapProjectNatureToDvfType(raw);
}
function computeIndex(value: number | null, min: number, max: number, invert = false): number | null {
  if (value == null || !Number.isFinite(value)) return null; if (max === min) return 50;
  const clamped = Math.max(min, Math.min(max, value)); const normalized = (clamped - min) / (max - min);
  return Math.max(0, Math.min(100, Math.round((invert ? 1 - normalized : normalized) * 100)));
}

// ----------------------------------------------------
// CADASTRE NATIONAL via API Carto
// ----------------------------------------------------
function isIdfDepFromInsee(communeInsee: string | null): boolean {
  if (!communeInsee || communeInsee.length < 2) return false;
  return ["75","77","78","91","92","93","94","95"].includes(communeInsee.slice(0, 2));
}

// Reverse-geocoding commune depuis lat/lon (P0-1)
// Peuple commune_insee quand seul lat/lon est fourni — sinon BPE/INSEE/sante
// tombent et la zone est classee a tort "rural".
async function reverseGeocodeCommune(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `${GEO_API_BASE}/communes?lat=${lat}&lon=${lon}&fields=code&limit=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const communes = await resp.json();
    if (Array.isArray(communes) && communes.length > 0 && communes[0].code) {
      return String(communes[0].code);
    }
  } catch (_e) {
    // non-bloquant : on continue avec commune_insee nul
  }
  return null;
}

function parseParcelIdu(idu: string): { code_insee: string | null; com_abs: string | null; section: string | null; numero: string | null; } {
  const s = (idu ?? "").trim(); if (!s) return { code_insee: null, com_abs: null, section: null, numero: null };
  if (s.length >= 14) return { code_insee: s.slice(0,5), com_abs: s.slice(5,8), section: s.slice(8,10), numero: s.slice(10,14) };
  return { code_insee: s.length >= 5 ? s.slice(0,5) : null, com_abs: s.length >= 8 ? s.slice(5,8) : null, section: s.length >= 10 ? s.slice(8,10) : null, numero: s.length >= 14 ? s.slice(10,14) : null };
}
type CadastreFetchDebug = { url?: string; status?: number; ok?: boolean; numberReturned?: number | null; error?: string | null; };

async function fetchParcelFromApiCarto(idu: string, communeInseeHint?: string | null, debug = false): Promise<{ point: ResolvedPoint | null; dbg: CadastreFetchDebug }> {
  const dbg: CadastreFetchDebug = {};
  const parsed = parseParcelIdu(idu);
  const code_insee = communeInseeHint?.toString() ?? parsed.code_insee;
  const section = parsed.section; const numero = parsed.numero; const com_abs = parsed.com_abs ?? "000";
  if (!code_insee || !section || !numero) { dbg.error = "Missing code_insee/section/numero"; return { point: null, dbg }; }
  const url = "https://apicarto.ign.fr/api/cadastre/parcelle?code_insee=" + encodeURIComponent(code_insee) + "&section=" + encodeURIComponent(section) + "&numero=" + encodeURIComponent(numero) + "&com_abs=" + encodeURIComponent(com_abs) + "&_limit=1";
  try {
    const resp = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
    const json = await resp.json().catch(() => null);
    if (!json || !resp.ok) { dbg.error = "API_CARTO_ERROR"; return { point: null, dbg }; }
    dbg.numberReturned = numOrNull((json as any).numberReturned) ?? null;
    const feature = Array.isArray((json as any).features) && (json as any).features.length > 0 ? (json as any).features[0] : null;
    if (!feature?.geometry) { dbg.error = "no feature.geometry"; return { point: null, dbg }; }
    const centroid = turf.centroid(feature); const coords = centroid?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) { dbg.error = "centroid coords invalid"; return { point: null, dbg }; }
    const lon = numOrNull(coords[0]); const lat = numOrNull(coords[1]);
    if (lat == null || lon == null) { dbg.error = "lat/lon null"; return { point: null, dbg }; }
    let surface_m2: number | null = null;
    try { surface_m2 = turf.area(feature); } catch { surface_m2 = null; }
    return { point: { lat, lon, source: "parcel", parcel_id: idu, commune_insee: code_insee, surface_m2: surface_m2 ?? undefined }, dbg };
  } catch (e) { dbg.error = "FETCH_EXCEPTION"; return { point: null, dbg }; }
}

async function resolvePointFromParcelId(parcelId: string, communeInsee?: string | number | null, debug = false): Promise<{ point: ResolvedPoint | null; cadastreDebug?: CadastreFetchDebug; rpcDebug?: any }> {
  if (!parcelId) return { point: null };
  const parsed = parseParcelIdu(parcelId); const inseeStr = communeInsee?.toString() ?? parsed.code_insee ?? null;
  if (inseeStr && !isIdfDepFromInsee(inseeStr)) {
    const { point, dbg } = await fetchParcelFromApiCarto(parcelId, inseeStr, debug);
    if (point) return { point, cadastreDebug: dbg }; return { point: null, cadastreDebug: dbg };
  }
  if (!supabase) return { point: null };
  const tryRpc = async (comm: string | null) => await supabase.rpc("get_parcelle_centroid", { p_parcel_id: parcelId, p_commune_insee: comm });
  let { data, error } = await tryRpc(communeInsee?.toString() ?? null);
  if (!error && (!Array.isArray(data) || data.length === 0)) ({ data, error } = await tryRpc(null));
  if (error) { console.error("RPC get_parcelle_centroid error"); return { point: null, rpcDebug: { error: "RPC_ERROR" } }; }
  if (Array.isArray(data) && data.length > 0) {
    const row: any = data[0]; const rLat = numOrNull(row.lat); const rLon = numOrNull(row.lon);
    if (rLat != null && rLon != null) return { point: { lat: rLat, lon: rLon, source: "parcel", parcel_id: parcelId, commune_insee: safeToString(row.commune_insee) ?? communeInsee?.toString() ?? undefined, surface_m2: numOrNull(row.surface_m2) ?? undefined }, rpcDebug: { found: true } };
  }
  return { point: null, rpcDebug: { data_len: Array.isArray(data) ? data.length : null } };
}

async function resolveAnalysisPoint(payload: MarketStudyPayload): Promise<{ point: ResolvedPoint | null; error: string | null; inseeMeta?: any; debugResolve?: any }> {
  const { parcel_id, commune_insee, lat, lon, debug } = payload;
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    let resolvedInsee = commune_insee?.toString() ?? null;
    if (!resolvedInsee) {
      resolvedInsee = await reverseGeocodeCommune(lat, lon);
      if (debug) console.log("[Market] reverse-geocode commune:", resolvedInsee);
    }
    console.log("Point resolu depuis payload lat/lon (commune:", resolvedInsee, ")");
    return { point: { lat, lon, source: "payload", parcel_id: parcel_id ?? undefined, commune_insee: resolvedInsee ?? undefined }, error: null };
  }
  if (parcel_id) {
    const res = await resolvePointFromParcelId(parcel_id, commune_insee ?? null, !!debug);
    if (res.point) return { point: res.point, error: null };
  }
  const inseeCode = commune_insee?.toString() ?? null;
  if (inseeCode && inseeCode.length === 5) {
    try {
      const geoUrl = `${GEO_API_BASE}/communes/${inseeCode}?fields=centre,nom,departement,region`;
      const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(5000) });
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        if (geoData?.centre?.coordinates) {
          const [lon, lat] = geoData.centre.coordinates;
          if (Number.isFinite(lat) && Number.isFinite(lon)) return { point: { lat, lon, source: "commune", commune_insee: inseeCode, parcel_id: parcel_id ?? undefined }, error: null };
        }
      }
    } catch (e) { console.warn("[resolveAnalysisPoint] geo.api fallback error:"); }
  }
  return { point: null, error: "Impossible de géolocaliser. Fournir: address, commune_insee, parcel_id, ou lat/lon." };
}

async function resolveStandardPoint(payload: StandardPayload): Promise<{ point: ResolvedPoint | null; error: string | null; debugResolve?: any }> {
  const { parcel_id, commune_insee, commune_code, lat, lon, debug } = payload;
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    let resolvedInsee = commune_insee?.toString() ?? commune_code ?? null;
    if (!resolvedInsee) {
      resolvedInsee = await reverseGeocodeCommune(lat, lon);
      if (debug) console.log("[Standard] reverse-geocode commune:", resolvedInsee);
    }
    console.log("[Standard] Point resolu depuis payload lat/lon (commune:", resolvedInsee, ")");
    return { point: { lat, lon, source: "payload", parcel_id: parcel_id ?? undefined, commune_insee: resolvedInsee ?? undefined }, error: null };
  }
  const effectiveCommune = commune_insee?.toString() ?? commune_code ?? null;
  if (parcel_id) {
    const res = await resolvePointFromParcelId(parcel_id, effectiveCommune, !!debug);
    if (res.point) return { point: res.point, error: null };
    if (debug) return { point: null, error: "Parcelle non resolue", debugResolve: { parcel_id, commune_insee: effectiveCommune, cadastre: res.cadastreDebug, rpc: res.rpcDebug } };
    return { point: null, error: "Impossible de resoudre le point d'analyse via parcel_id." };
  }
  return { point: null, error: "Impossible de resoudre le point d'analyse. Fournir lat/lon ou parcel_id valide." };
}

// ============================================================================
// CSV PARSER (version simple — DVF n'utilise pas de guillemets)
// ============================================================================
function parseCSV(csvText: string): Array<Record<string, string>> {
  const lines = csvText.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",");
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (values[j] ?? "").trim();
    rows.push(row);
  }
  return rows;
}

// ============================================================================
// ARRONDISSEMENT RESOLVER
// ============================================================================
const COMMUNES_A_ARRONDISSEMENTS: Record<string, { dep: string; prefix: string; arrStart: number; arrEnd: number; codeStart: number }> = {
  "75056": { dep: "75", prefix: "751", arrStart: 1, arrEnd: 20, codeStart: 75101 },
  "69123": { dep: "69", prefix: "6938", arrStart: 1, arrEnd: 9, codeStart: 69381 },
  "13055": { dep: "13", prefix: "132", arrStart: 1, arrEnd: 16, codeStart: 13201 },
};
const CP_TO_ARRONDISSEMENT: Record<string, string> = {};
for (let i = 1; i <= 20; i++) CP_TO_ARRONDISSEMENT["750" + String(i).padStart(2,"0")] = "751" + String(i).padStart(2,"0");
for (let i = 1; i <= 9; i++) CP_TO_ARRONDISSEMENT["6900" + String(i)] = "6938" + String(i);
for (let i = 1; i <= 16; i++) CP_TO_ARRONDISSEMENT["130" + String(i).padStart(2,"0")] = "132" + String(i).padStart(2,"0");

async function resolveArrondissementCode(communeCode: string, lat: number | null, lon: number | null, cp?: string | null, debug = false): Promise<{ dvfCode: string; arrondissement: string | null; source: string }> {
  if (!COMMUNES_A_ARRONDISSEMENTS[communeCode]) return { dvfCode: communeCode, arrondissement: null, source: "direct" };
  if (cp) { const mapped = CP_TO_ARRONDISSEMENT[cp.toString().trim().slice(0,5)]; if (mapped) return { dvfCode: mapped, arrondissement: mapped, source: "cp" }; }
  if (lat != null && lon != null) {
    try {
      const geoUrl = GEO_API_BASE + "/communes?lat=" + String(lat) + "&lon=" + String(lon) + "&fields=code,codesPostaux,nom&limit=1";
      const resp = await fetch(geoUrl, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const communes = await resp.json();
        if (communes.length > 0) {
          const c = communes[0];
          if (c.code !== communeCode && c.code.length === 5) return { dvfCode: c.code, arrondissement: c.code, source: "geoapi_direct" };
          for (const cpVal of (c.codesPostaux || [])) { const mapped = CP_TO_ARRONDISSEMENT[cpVal]; if (mapped) return { dvfCode: mapped, arrondissement: mapped, source: "geoapi_cp" }; }
        }
      }
    } catch (e) { if (debug) console.warn("[DVF Arrondissement] geoapi error:"); }
    if (communeCode === "75056") {
      try {
        const revResp = await fetch("https://api-adresse.data.gouv.fr/reverse/?lat=" + String(lat) + "&lon=" + String(lon) + "&limit=1", { signal: AbortSignal.timeout(5000) });
        if (revResp.ok) { const revData = await revResp.json(); const postcode = revData?.features?.[0]?.properties?.postcode; if (postcode) { const mapped = CP_TO_ARRONDISSEMENT[postcode]; if (mapped) return { dvfCode: mapped, arrondissement: mapped, source: "ban_reverse" }; } }
      } catch (e) { if (debug) console.warn("[DVF Arrondissement] BAN reverse error:"); }
    }
  }
  return { dvfCode: communeCode, arrondissement: null, source: "fallback" };
}

// ============================================================================
// DVF PROVIDER
// ============================================================================
type DvfApiResult = { provider: "dvf"; source: string; coverage: Coverage; reason?: string; kpis: { n: number; median_price_m2: number | null; avg_price_m2: number | null; q1_price_m2: number | null; q3_price_m2: number | null; }; comps: MarketComp[]; };

function getDvfCacheKey(communeInsee: string | null, lat: number, lon: number, months: number, typeLocal: string | null): string {
  const key = communeInsee ?? (String(Math.round(lat*100)) + "_" + String(Math.round(lon*100)));
  return "dvf:" + key + ":" + String(months) + ":" + (typeLocal || "all");
}

async function dvfMarketKpis(params: { lat: number; lon: number; radius_m?: number; horizon_months?: number; type_local?: string | null; commune_insee?: string | null; ttl_seconds?: number; debug?: boolean; }): Promise<DvfApiResult> {
  const { lat, lon, radius_m = 2000, horizon_months = 24, type_local = null, commune_insee = null, ttl_seconds = 86400, debug = false } = params;
  const cacheKey = getDvfCacheKey(commune_insee, lat, lon, horizon_months, type_local);
  const cached = await getFromCache(cacheKey);
  if (cached) { if (debug) console.log("DVF from cache"); return { ...cached, source: "cache" }; }
  let codeCommune = commune_insee; let nomCommune: string | null = null;
  if (!codeCommune) {
    try { const geoResp = await fetch(GEO_API_BASE + "/communes?lat=" + String(lat) + "&lon=" + String(lon) + "&fields=code,nom&limit=1"); if (geoResp.ok) { const communes = await geoResp.json(); if (communes.length > 0) { codeCommune = communes[0].code; nomCommune = communes[0].nom; } } } catch (e) { if (debug) console.warn("DVF: erreur detection commune:"); }
  } else {
    try { const geoResp = await fetch(GEO_API_BASE + "/communes/" + codeCommune + "?fields=nom"); if (geoResp.ok) { nomCommune = (await geoResp.json()).nom; } } catch { /* Ignorer */ }
  }
  if (!codeCommune) return { provider: "dvf", source: "csv", coverage: "not_covered", reason: "Impossible de determiner le code commune", kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null }, comps: [] };
  const arrResult = await resolveArrondissementCode(codeCommune, lat, lon, null, debug);
  const dvfCode = arrResult.dvfCode;
  const dep = dvfCode.slice(0, 2);
  const dateLimit = new Date(); dateLimit.setMonth(dateLimit.getMonth() - horizon_months);
  const dateLimitStr = dateLimit.toISOString().split("T")[0];
  const currentYear = new Date().getFullYear();
  const yearsToFetch: number[] = [];
  for (let y = currentYear; y >= currentYear - 3 && y >= 2019; y--) yearsToFetch.push(y);
  let allRows: Array<Record<string, string>> = []; const csvSources: string[] = [];
  for (const year of yearsToFetch) {
    const csvUrl = DVF_CSV_BASE + "/" + String(year) + "/communes/" + dep + "/" + dvfCode + ".csv";
    try {
      const resp = await fetch(csvUrl, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) { const buf = await resp.arrayBuffer(); const rows = parseCSV(new TextDecoder("utf-8").decode(buf)); allRows = allRows.concat(rows); csvSources.push(String(year)); if (debug) console.log("DVF " + String(year) + ": " + String(rows.length) + " lignes"); }
    } catch (e) { if (debug) console.warn("DVF " + String(year) + " error:"); }
  }
  if (allRows.length === 0) return { provider: "dvf", source: "csv", coverage: "no_data", reason: "Aucune donnee DVF trouvee pour " + dvfCode, kpis: { n: 0, median_price_m2: null, avg_price_m2: null, q1_price_m2: null, q3_price_m2: null }, comps: [] };
  const transactions: Array<{ price_m2: number; valeur: number; surface: number; record: any }> = [];
  const seenMutations = new Set<string>();
  for (const row of allRows) {
    const dateMutation = row.date_mutation || ""; if (dateMutation < dateLimitStr) continue;
    const idMutation = row.id_mutation || ""; if (seenMutations.has(idMutation)) continue;
    const valeur = parseFloat(row.valeur_fonciere || "0"); const surface = parseFloat(row.surface_reelle_bati || "0");
    if (valeur <= 0 || surface <= 0) continue;
    const rowTypeLocal = row.type_local || "";
    if (type_local) { if (type_local === "Appartement" && rowTypeLocal !== "Appartement") continue; if (type_local === "Maison" && rowTypeLocal !== "Maison") continue; if (type_local === "Local" && !rowTypeLocal.toLowerCase().includes("local")) continue; }
    const tLat = parseFloat(row.latitude || "0"); const tLon = parseFloat(row.longitude || "0");
    let distance_m: number | undefined;
    if (tLat && tLon && lat && lon) { distance_m = Math.round(haversineDistance(lat, lon, tLat, tLon)); if (distance_m > radius_m) continue; }
    seenMutations.add(idMutation);
    transactions.push({ price_m2: Math.round(valeur/surface), valeur, surface, record: { id: idMutation, date_mutation: dateMutation, adresse: [row.adresse_numero, row.adresse_suffixe, row.adresse_nom_voie].filter(Boolean).join(" ") || null, type_local: rowTypeLocal, latitude: tLat||null, longitude: tLon||null, distance_m, nom_commune: row.nom_commune || nomCommune || null } });
  }
  transactions.sort((a, b) => (b.record.date_mutation || "").localeCompare(a.record.date_mutation || ""));
  const prices = transactions.map(t => t.price_m2).sort((a, b) => a - b); const n = prices.length;
  let median_price_m2: number | null = null, avg_price_m2: number | null = null, q1_price_m2: number | null = null, q3_price_m2: number | null = null;
  if (n > 0) { median_price_m2 = prices[Math.floor(n/2)]; avg_price_m2 = Math.round(prices.reduce((a,b)=>a+b,0)/n); q1_price_m2 = prices[Math.floor(n*0.25)]; q3_price_m2 = prices[Math.floor(n*0.75)]; }
  const comps: MarketComp[] = transactions.slice(0,20).map((t,idx) => ({ id: t.record.id||String(idx), address: t.record.adresse??undefined, price_m2: t.price_m2, surface_m2: t.surface, date: t.record.date_mutation??undefined, type_local: t.record.type_local??undefined, distance_m: t.record.distance_m, commune: t.record.nom_commune??nomCommune??undefined }));
  const result: DvfApiResult = { provider: "dvf", source: "csv:" + csvSources.join(","), coverage: n > 0 ? "ok" : "no_data", kpis: { n, median_price_m2, avg_price_m2, q1_price_m2, q3_price_m2 }, comps };
  await saveToCache(cacheKey, "dvf", result, ttl_seconds);
  return result;
}

function unwrapRpcSingleRow(data: any): any | null { if (!data) return null; if (Array.isArray(data)) return data.length > 0 ? data[0] : null; return data; }

async function fetchDvfMarketStatsRpc(point: ResolvedPoint, radiusKm: number, months: number, typeLocal: string | null): Promise<{ stats: DvfMarketStats | null; comps: MarketComp[]; error: string | null }> {
  if (!supabase) return { stats: null, comps: [], error: "Supabase non initialise" };
  const radiusM = Math.round(radiusKm * 1000); console.log("Fallback -> RPC get_dvf_market_stats_radius");
  try {
    let statsData: any = null, statsError: any = null;
    const attempt1 = await supabase.rpc("get_dvf_market_stats_radius", { p_lat: point.lat, p_lon: point.lon, p_months: months, p_radius_m: radiusM, p_type_local: typeLocal });
    if (attempt1.error) { const attempt2 = await supabase.rpc("get_dvf_market_stats_radius", { p_lat: point.lat, p_lon: point.lon, p_radius_m: radiusM, p_months: months, p_type_local: typeLocal }); if (attempt2.error) statsError = attempt2.error; else statsData = attempt2.data; } else statsData = attempt1.data;
    if (statsError) return { stats: null, comps: [], error: "STATS_RPC_ERROR" };
    const row = unwrapRpcSingleRow(statsData); const rawStats = row?.stats ? row.stats : row;
    const stats: DvfMarketStats = { transactions_count: Number(rawStats?.transactions_count??0)||0, transactions_count_previous: Number(rawStats?.transactions_count_previous??0)||0, price_median_eur_m2: numOrNull(rawStats?.price_median_eur_m2), price_mean_eur_m2: numOrNull(rawStats?.price_mean_eur_m2), price_q1_eur_m2: numOrNull(rawStats?.price_q1_eur_m2), price_q3_eur_m2: numOrNull(rawStats?.price_q3_eur_m2), evolution_pct: numOrNull(rawStats?.evolution_pct), volume_total_eur: numOrNull(rawStats?.volume_total_eur), surface_mean_m2: numOrNull(rawStats?.surface_mean_m2) };
    const { data: compsData } = await supabase.rpc("get_dvf_comps_radius", { p_lat: point.lat, p_lon: point.lon, p_radius_m: Math.min(radiusM,1500), p_months: Math.min(months,12), p_type_local: typeLocal, p_limit: 15 });
    let comps: MarketComp[] = [];
    if (Array.isArray(compsData)) comps = compsData.map((c: any, idx: number) => ({ id: safeToString(c.id)??String(idx), address: safeToString(c.adresse)??undefined, price_m2: numOrNull(c.price_m2)??undefined, surface_m2: numOrNull(c.surface_m2)??undefined, date: safeToString(c.date_mutation)??undefined, type_local: safeToString(c.type_local)??undefined, distance_m: numOrNull(c.distance_m)??undefined, commune: safeToString(c.commune)??undefined }));
    return { stats, comps, error: null };
  } catch (e) { console.error("fetchDvfMarketStatsRpc error"); return { stats: null, comps: [], error: "DVF_STATS_ERROR" }; }
}

// ============================================================================
// BPE PROVIDER
// ============================================================================
type BpeKpis = { total_equipements: number; nb_commerces: number; nb_sante: number; nb_services: number; nb_enseignement: number; nb_sport_culture: number; score_commerces: number; score_sante: number; score_services: number; scoreCommodites: number; rayon_m: number; sante_details: Array<{ type: string; label: string; count: number; min_distance_m: number | null }>; commerces_proches?: CommerceProche[]; medecins_proches?: MedecinProche[]; };
const DOMAINE_MAP: Record<string, string> = { A: "services", B: "commerces", C: "enseignement", D: "sante", E: "transport", F: "sport_culture", G: "tourisme" };
const SANTE_TYPE_MAP: Record<string, string> = { D201: "medecin_generaliste", D202: "medecin_specialiste", D203: "medecin_specialiste", D204: "medecin_specialiste", D205: "medecin_specialiste", D206: "medecin_specialiste", D207: "medecin_specialiste", D208: "medecin_specialiste", D209: "medecin_specialiste", D210: "medecin_specialiste", D211: "medecin_specialiste", D221: "dentiste", D231: "infirmier", D232: "infirmier", D233: "kinesitherapeute", D235: "kinesitherapeute", D236: "kinesitherapeute", D237: "kinesitherapeute", D238: "kinesitherapeute", D239: "kinesitherapeute", D240: "kinesitherapeute", D241: "kinesitherapeute", D301: "pharmacie" };
const SANTE_LABELS: Record<string, string> = { medecin_generaliste: "Medecins generalistes", medecin_specialiste: "Medecins specialistes", dentiste: "Chirurgiens-dentistes", pharmacie: "Pharmacies", infirmier: "Infirmiers / Sages-femmes", kinesitherapeute: "Kinesitherapeutes / Paramedicaux", autre_sante: "Autres professionnels de sante" };
const COMMERCE_TYPE_LABELS: Record<string, string> = { B101: "Hypermarche", B102: "Supermarche", B103: "Grande surface de bricolage", B104: "Hypermarche", B105: "Supermarche", B201: "Superette", B202: "Epicerie", B203: "Boulangerie", B204: "Boucherie charcuterie", B205: "Produits surgeles", B206: "Poissonnerie", B207: "Epicerie", B208: "Superette", B210: "Commerce alimentaire", B301: "Librairie papeterie journaux", B302: "Magasin de vetements", B303: "Magasin d'equipements du foyer", B304: "Magasin de chaussures", B305: "Magasin d'electromenager et de materiel audio-video", B306: "Magasin de meubles", B307: "Magasin d'articles de sports et de loisirs", B308: "Droguerie quincaillerie bricolage", B309: "Parfumerie", B310: "Horlogerie Bijouterie", B311: "Fleuriste", B312: "Magasin d'optique", G101: "Station service" };
const MEDECIN_SPECIALITE_LABELS: Record<string, string> = { D201: "Medecin generaliste", D202: "Specialiste en cardiologie", D203: "Specialiste en dermatologie", D204: "Specialiste en gastro-enterologie", D205: "Specialiste en psychiatrie", D206: "Specialiste en ophtalmologie", D207: "Specialiste en ORL", D208: "Specialiste en pediatrie", D209: "Specialiste en radiodiagnostic et imagerie medicale", D210: "Specialiste en gynecologie", D211: "Specialiste en gynecologie obstetrique", D221: "Chirurgien-dentiste", D231: "Sage-femme", D232: "Infirmier", D233: "Masseur kinesitherapeute", D235: "Orthophoniste", D236: "Orthoptiste", D237: "Pedicure-podologue", D238: "Audio prothesiste", D239: "Ergotherapeute", D240: "Psychomotricien", D241: "Dieteticien", D301: "Pharmacie", D302: "Laboratoire d'analyses medicales", D303: "Ambulance", D307: "Transfusion sanguine", D310: "Maison de sante pluridisciplinaire" };
const SERVICE_TYPE_LABELS: Record<string, string> = { A101: "Commissariat de police", A104: "Gendarmerie", A203: "Banque", A204: "DAB (distributeur automatique)", A206: "Bureau de poste", A207: "Relais poste", A208: "Agence postale communale", G101: "Station service" };
const FORCE_TYPE_LABEL_CODES = new Set(["G101"]);

function getBpeCacheKey(lat: number, lon: number, radiusM: number): string { return "bpe:" + String(Math.round(lat*100)/100) + ":" + String(Math.round(lon*100)/100) + ":" + String(radiusM); }
async function getCommuneCenter(communeCode: string): Promise<{ lat: number; lon: number; nom: string } | null> {
  try { const resp = await fetch(GEO_API_BASE + "/communes/" + communeCode + "?fields=centre,nom"); if (!resp.ok) return null; const data = await resp.json(); if (data.centre?.coordinates) return { lon: data.centre.coordinates[0], lat: data.centre.coordinates[1], nom: data.nom || communeCode }; } catch { /* Ignorer */ }
  return null;
}

async function fetchBpeStats(lat: number, lon: number, radiusM = 500, communeInsee?: string | null, debug = false): Promise<{ scoreCommodites: number | null; details: BpeKpis | null; coverage: Coverage; totalEquipements: number }> {
  const cacheKey = getBpeCacheKey(lat, lon, radiusM);
  const cached = await getFromCache(cacheKey); if (cached) { if (debug) console.log("BPE from cache"); return cached; }
  let effectiveCommune = communeInsee; let communeCenter: { lat: number; lon: number; nom: string } | null = null;
  if (!effectiveCommune) {
    try { const geoResp = await fetch(GEO_API_BASE + "/communes?lat=" + String(lat) + "&lon=" + String(lon) + "&fields=code,nom,centre&limit=1"); if (geoResp.ok) { const communes = await geoResp.json(); if (communes.length > 0) { effectiveCommune = communes[0].code; if (communes[0].centre?.coordinates) communeCenter = { lon: communes[0].centre.coordinates[0], lat: communes[0].centre.coordinates[1], nom: communes[0].nom }; } } } catch (e) { console.warn("BPE: erreur detection commune:", e); }
  } else { communeCenter = await getCommuneCenter(effectiveCommune); }
  if (!effectiveCommune) return { scoreCommodites: null, details: null, coverage: "not_covered" as Coverage, totalEquipements: 0 };
  const bpeArrResult = await resolveArrondissementCode(effectiveCommune, lat, lon, null, debug);
  const bpeCommune = bpeArrResult.dvfCode;
  try {
    const apiUrl = DATA_GOUV_BPE_API + "/" + BPE_RESOURCE_ID + "/data/?DEPCOM__exact=" + bpeCommune + "&page_size=2000";
    const resp = await fetch(apiUrl, { headers: { Accept: "application/json" } });
    if (!resp.ok) { console.warn("BPE API error"); if (supabase) return await fetchBpeStatsRpc(lat, lon, radiusM); return { scoreCommodites: null, details: null, coverage: "error" as Coverage, totalEquipements: 0 }; }
    const json = await resp.json(); const records = json.data || [];
    if (records.length === 0) { if (supabase) return await fetchBpeStatsRpc(lat, lon, radiusM); }
    const byDomaine: Record<string, number> = {}; const santeByType: Record<string, { count: number; minDist: number | null }> = {};
    let totalInRadius = 0; const commercesProches: CommerceProche[] = []; const medecinsProches: MedecinProche[] = [];
    for (const r of records) {
      let eqLat = parseFloat(r.LATITUDE || r.latitude || ""); let eqLon = parseFloat(r.LONGITUDE || r.longitude || "");
      if (isNaN(eqLat) || isNaN(eqLon)) { if (communeCenter) { eqLat = communeCenter.lat; eqLon = communeCenter.lon; } else continue; }
      const distance = haversineDistance(lat, lon, eqLat, eqLon);
      if (distance <= radiusM) {
        totalInRadius++; const typeCode = r.TYPEQU || r.typequ || ""; const domaine = typeCode.charAt(0);
        byDomaine[DOMAINE_MAP[domaine] || "autre"] = (byDomaine[DOMAINE_MAP[domaine] || "autre"] || 0) + 1;
        if ((domaine === "B" || typeCode === "G101") && commercesProches.length < 15) commercesProches.push({ nom: r.NOM || r.nom || COMMERCE_TYPE_LABELS[typeCode] || "Commerce", type: COMMERCE_TYPE_LABELS[typeCode] || typeCode, type_code: typeCode, distance_m: Math.round(distance), distance_km: metersToKm(distance), adresse: r.ADRESSE || r.adresse || undefined, commune: r.LIBCOM || r.libcom || communeCenter?.nom || undefined });
        if (domaine === "D") {
          const santeType = SANTE_TYPE_MAP[typeCode] || "autre_sante";
          if (!santeByType[santeType]) santeByType[santeType] = { count: 0, minDist: null };
          santeByType[santeType].count++;
          if (santeByType[santeType].minDist === null || distance < santeByType[santeType].minDist!) santeByType[santeType].minDist = Math.round(distance);
          if ((typeCode.startsWith("D2") || typeCode.startsWith("D3")) && medecinsProches.length < 15) medecinsProches.push({ nom: r.NOM || r.nom || MEDECIN_SPECIALITE_LABELS[typeCode] || "Professionnel de sante", specialite: MEDECIN_SPECIALITE_LABELS[typeCode] || typeCode, type_code: typeCode, distance_m: Math.round(distance), distance_km: metersToKm(distance), adresse: r.ADRESSE || r.adresse || undefined, commune: r.LIBCOM || r.libcom || communeCenter?.nom || undefined });
        }
      }
    }
    commercesProches.sort((a,b)=>a.distance_m-b.distance_m); medecinsProches.sort((a,b)=>a.distance_m-b.distance_m);
    const nb_commerces = byDomaine.commerces||0, nb_sante = byDomaine.sante||0, nb_services = byDomaine.services||0, nb_enseignement = byDomaine.enseignement||0, nb_sport_culture = byDomaine.sport_culture||0;
    const score_commerces = Math.min(100, nb_commerces*2.5), score_sante = Math.min(100, nb_sante*3.0), score_services = Math.min(100, nb_services*1.5);
    const scoreCommodites = totalInRadius > 0 ? Math.round((score_commerces+score_sante+score_services)/3) : 0;
    const sante_details = Object.entries(santeByType).map(([type,data])=>({ type, label: SANTE_LABELS[type]||type, count: data.count, min_distance_m: data.minDist }));
    const coverage: Coverage = totalInRadius > 0 ? "ok" : "no_data";
    const details: BpeKpis = { total_equipements: totalInRadius, nb_commerces, nb_sante, nb_services, nb_enseignement, nb_sport_culture, score_commerces, score_sante, score_services, scoreCommodites, rayon_m: radiusM, sante_details, commerces_proches: commercesProches.slice(0,10), medecins_proches: medecinsProches.slice(0,10) };
    const result = { scoreCommodites: coverage === "ok" ? scoreCommodites : null, details, coverage, totalEquipements: totalInRadius };
    await saveToCache(cacheKey, "bpe", result, 86400); return result;
  } catch (e) { console.error("BPE API error"); if (supabase) return await fetchBpeStatsRpc(lat, lon, radiusM); return { scoreCommodites: null, details: null, coverage: "error" as Coverage, totalEquipements: 0 }; }
}

async function fetchBpeStatsRpc(lat: number, lon: number, radiusM = 500): Promise<{ scoreCommodites: number | null; details: BpeKpis | null; coverage: Coverage; totalEquipements: number }> {
  if (!supabase) return { scoreCommodites: null, details: null, coverage: "not_covered", totalEquipements: 0 };
  try {
    const { data, error } = await supabase.rpc("get_bpe_proximite", { p_lat: lat, p_lon: lon, p_rayon_m: radiusM, p_types: null });
    if (error) { console.error("RPC get_bpe_proximite error"); return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 }; }
    const score = numOrNull((data as any)?.scoreCommodites); const totalEquipements = numOrNull((data as any)?.total_equipements_proximite) ?? 0;
    if (totalEquipements === 0 && (score === 0 || score == null)) return { scoreCommodites: null, details: data as BpeKpis, coverage: "no_data", totalEquipements: 0 };
    return { scoreCommodites: score, details: data as BpeKpis, coverage: score != null ? "ok" : "no_data", totalEquipements };
  } catch (e) { console.error("fetchBpeStatsRpc error"); return { scoreCommodites: null, details: null, coverage: "error", totalEquipements: 0 }; }
}

// ============================================================================
// PHARMACIE FALLBACK OSM OVERPASS
// ============================================================================
async function fetchNearestPharmacyOverpass(lat: number, lon: number, maxRadiusM: number = 20000, debug = false): Promise<ServiceEssentiel | null> {
  const radii = [2000, 5000, 10000, maxRadiusM].filter(r => r <= maxRadiusM);
  for (const radiusM of radii) {
    if (debug) console.log("OSM Overpass: recherche pharmacie rayon " + String(radiusM) + "m");
    const query = "[out:json][timeout:10];\n(\n  node[\"amenity\"=\"pharmacy\"](around:" + String(radiusM) + "," + String(lat) + "," + String(lon) + ");\n  way[\"amenity\"=\"pharmacy\"](around:" + String(radiusM) + "," + String(lat) + "," + String(lon) + ");\n);\nout center;";
    try {
      const resp = await fetch(OVERPASS_API_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(query) });
      if (!resp.ok) continue;
      const json = await resp.json(); const elements = json.elements || [];
      if (elements.length === 0) continue;
      let nearest: ServiceEssentiel | null = null; let minDistance = Infinity;
      for (const el of elements) {
        const elLat = el.lat ?? el.center?.lat; const elLon = el.lon ?? el.center?.lon;
        if (elLat == null || elLon == null) continue;
        const distance = haversineDistance(lat, lon, elLat, elLon);
        if (distance < minDistance) { minDistance = distance; const tags = el.tags || {}; nearest = { nom: tags.name || tags["name:fr"] || "Pharmacie", type: "Pharmacie", type_code: "OSM_PHARMACY", distance_m: Math.round(distance), distance_km: metersToKm(distance), adresse: [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ") || undefined, commune: tags["addr:city"] || tags["addr:municipality"] || undefined }; }
      }
      if (nearest) return nearest;
    } catch (e) { if (debug) console.warn("OSM Overpass error (rayon " + String(radiusM) + "m):"); }
  }
  return null;
}

// ============================================================================
// v4.3: MAPPING OSM TAGS → TYPE_CODE BPE
// ============================================================================
function osmTagsToTypeCode(tags: Record<string, string>): string | null {
  const amenity    = tags.amenity    ?? "";
  const shop       = tags.shop       ?? "";
  const healthcare = tags.healthcare ?? "";
  const office     = tags.office     ?? "";
  if (amenity === "pharmacy")             return "D301";
  if (amenity === "doctors")             return "D201";
  if (amenity === "dentist")             return "D221";
  if (healthcare === "nurse")            return "D231";
  if (healthcare === "physiotherapist")  return "D233";
  if (shop === "supermarket")            return "B102";
  if (shop === "hypermarket")            return "B101";
  if (shop === "convenience")            return "B201";
  if (shop === "grocery" || shop === "general") return "B202";
  if (shop === "bakery")                 return "B203";
  if (shop === "butcher")                return "B204";
  if (shop === "frozen_food")            return "B205";
  if (shop === "fishmonger")             return "B206";
  if (amenity === "bank")                return "A203";
  if (amenity === "atm")                 return "A204";
  if (amenity === "post_office")         return "A206";
  if (office === "post")                 return "A207";
  if (amenity === "fuel")                return "G101";
  if (amenity === "police")              return "A101";
  return null;
}

// ============================================================================
// v4.3: REQUÊTE OVERPASS MULTI-CATÉGORIES
// ============================================================================
function buildOverpassEssentialsQuery(lat: number, lon: number, radiusM: number): string {
  const r = Math.round(radiusM);
  const c = `${lat},${lon}`;
  return `[out:json][timeout:25];
(
  node["amenity"="pharmacy"](around:${r},${c});
  way["amenity"="pharmacy"](around:${r},${c});
  node["amenity"="doctors"](around:${r},${c});
  way["amenity"="doctors"](around:${r},${c});
  node["amenity"="dentist"](around:${r},${c});
  way["amenity"="dentist"](around:${r},${c});
  node["amenity"="bank"](around:${r},${c});
  way["amenity"="bank"](around:${r},${c});
  node["amenity"="atm"](around:${r},${c});
  node["amenity"="post_office"](around:${r},${c});
  way["amenity"="post_office"](around:${r},${c});
  node["amenity"="fuel"](around:${r},${c});
  way["amenity"="fuel"](around:${r},${c});
  node["amenity"="police"](around:${r},${c});
  node["shop"="supermarket"](around:${r},${c});
  way["shop"="supermarket"](around:${r},${c});
  node["shop"="hypermarket"](around:${r},${c});
  way["shop"="hypermarket"](around:${r},${c});
  node["shop"="convenience"](around:${r},${c});
  node["shop"="grocery"](around:${r},${c});
  node["shop"="general"](around:${r},${c});
  node["shop"="bakery"](around:${r},${c});
  node["shop"="butcher"](around:${r},${c});
  node["shop"="frozen_food"](around:${r},${c});
  node["shop"="fishmonger"](around:${r},${c});
  node["healthcare"="nurse"](around:${r},${c});
  node["healthcare"="physiotherapist"](around:${r},${c});
  node["office"="post"](around:${r},${c});
);
out center;`;
}

// ============================================================================
// FETCH ESSENTIAL SERVICES — v4.3 : Overpass live + cache 7 j + fallback RPC
// ============================================================================
type EssentialServicesRawItem = { type_code: string; distance_m: number; nom?: string; name?: string; type_libelle?: string; commune?: string; code_commune?: string; adresse?: string; };
type EssentialServicesRawResult = { items: EssentialServicesRawItem[]; type_codes_sent: string[] };

async function fetchEssentialServicesRaw(lat: number, lon: number, radiusM: number, debug = false): Promise<EssentialServicesRawResult> {
  const type_codes = Object.keys(ESSENTIAL_BUCKET_BY_TYPE_CODE);
  const latR = Math.round(lat * 1000) / 1000;
  const lonR = Math.round(lon * 1000) / 1000;
  const cacheKey = `osm_ess:${latR}:${lonR}:${radiusM}`;
  const cached = await getFromCache(cacheKey);
  if (cached) {
    if (debug) console.log(`[Overpass essentials] Cache hit — ${(cached as EssentialServicesRawResult).items?.length ?? 0} items`);
    return cached as EssentialServicesRawResult;
  }
  if (debug) console.log(`[Overpass essentials] Requête Overpass rayon=${radiusM}m`);
  try {
    const query = buildOverpassEssentialsQuery(lat, lon, radiusM);
    const resp = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      console.warn("[Overpass essentials] HTTP error — fallback RPC");
      const rpcItems = await fetchEssentialServicesViaRpc(lat, lon, radiusM, debug);
      return { items: rpcItems, type_codes_sent: type_codes };
    }
    const data = await resp.json();
    const elements: any[] = data.elements ?? [];
    if (debug) console.log(`[Overpass essentials] ${elements.length} éléments OSM bruts reçus`);
    const items: EssentialServicesRawItem[] = [];
    for (const el of elements) {
      const tags: Record<string, string> = el.tags ?? {};
      const typeCode = osmTagsToTypeCode(tags);
      if (!typeCode) continue;
      const elLat: number | null = el.lat ?? el.center?.lat ?? null;
      const elLon: number | null = el.lon ?? el.center?.lon ?? null;
      if (elLat == null || elLon == null) continue;
      const distM = Math.round(haversineDistance(lat, lon, elLat, elLon));
      if (distM > radiusM * 1.05) continue;
      items.push({
        type_code: typeCode,
        distance_m: distM,
        nom: tags.name || tags["name:fr"] || undefined,
        type_libelle: undefined,
        commune: tags["addr:city"] || tags["addr:municipality"] || undefined,
        adresse: [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ") || undefined,
      });
    }
    if (debug) {
      const byCode: Record<string, number> = {};
      for (const it of items) byCode[it.type_code] = (byCode[it.type_code] || 0) + 1;
      console.log(`[Overpass essentials] ${items.length} items retenus, répartition type_code:`, byCode);
    }
    const result: EssentialServicesRawResult = { items, type_codes_sent: type_codes };
    if (items.length > 0) {
      await saveToCache(cacheKey, "osm_overpass", result, 7 * 24 * 3600);
    }
    if (items.length === 0) {
      if (debug) console.log("[Overpass essentials] Aucun résultat — fallback RPC");
      const rpcItems = await fetchEssentialServicesViaRpc(lat, lon, radiusM, debug);
      return { items: rpcItems, type_codes_sent: type_codes };
    }
    return result;
  } catch (e) {
    console.warn("[Overpass essentials] Exception — fallback RPC");
    const rpcItems = await fetchEssentialServicesViaRpc(lat, lon, radiusM, debug);
    return { items: rpcItems, type_codes_sent: type_codes };
  }
}

async function fetchEssentialServicesViaRpc(lat: number, lon: number, radiusM: number, debug = false): Promise<EssentialServicesRawItem[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc("get_bpe_essentiels_radius", { p_lat: lat, p_lon: lon, p_radius_m: radiusM });
    if (error) { if (debug) console.warn("RPC get_bpe_essentiels_radius error"); return []; }
    if (!Array.isArray(data)) return [];
    if (debug) console.log("RPC get_bpe_essentiels_radius: " + String(data.length) + " items");
    return data.map((item: any) => ({ type_code: item.type_code || item.typequ || "", distance_m: item.distance_m || 0, nom: item.nom || item.name || undefined, type_libelle: item.type_libelle || undefined, commune: item.commune || item.libcom || undefined, adresse: item.adresse || undefined }));
  } catch (e) { if (debug) console.error("fetchEssentialServicesViaRpc error"); return []; }
}

// ============================================================================
// RESIDENCES SENIORS
// ============================================================================
async function fetchResidencesSeniors(lat: number, lon: number, radiusKm: number = 20, debug = false): Promise<ResidenceSenior[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from("finess_etablissements").select("finess, raison_sociale, commune, categorie, latitude, longitude").not("latitude","is",null).not("longitude","is",null).or("categorie.ilike.%Residence autonomie%,categorie.ilike.%Residence services%,categorie.ilike.%Logement foyer%,categorie.ilike.%Foyer logement%,categorie.ilike.%MARPA%").limit(200);
    if (error || !data) return [];
    const residences: ResidenceSenior[] = [];
    for (const r of data) { const rLat = parseFloat((r as any).latitude); const rLon = parseFloat((r as any).longitude); if (Number.isNaN(rLat)||Number.isNaN(rLon)) continue; const dist = haversineDistance(lat, lon, rLat, rLon); if (dist <= radiusKm*1000) residences.push({ nom: (r as any).raison_sociale||"Residence seniors", type: (r as any).categorie||"Residence seniors", commune: (r as any).commune||"", distance_km: metersToKm(dist), finess: (r as any).finess }); }
    residences.sort((a,b)=>a.distance_km-b.distance_km);
    return residences.slice(0,10);
  } catch (e) { if (debug) console.warn("fetchResidencesSeniors exception:"); return []; }
}

// ============================================================================
// TRANSPORT — FALLBACK IDFM
// ============================================================================
async function fetchTransportScoreIdfm(lat: number, lon: number, radiusM: number = 1000, communeInsee?: string | null): Promise<number | null> {
  try {
    const url = communeInsee
      ? `https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/arrets-lignes/records?where=code_insee%3D%22${communeInsee}%22&limit=100&select=stop_id,stop_name,mode`
      : `https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/arrets-lignes/records?where=${encodeURIComponent(`distance(pointgeo,geom'POINT(${lon} ${lat})',${radiusM}m)`)}&limit=100&select=stop_id,stop_name,mode`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
    if (!resp.ok) return null;
    const data = await resp.json();
    const records: any[] = data.results ?? [];
    if (records.length === 0) return 30;
    const seenStops = new Set<string>();
    let hasHeavyRail = false;
    for (const r of records) {
      const sid = String(r.stop_id ?? r.id ?? Math.random());
      if (seenStops.has(sid)) continue;
      seenStops.add(sid);
      const mode = (r.mode ?? "").toLowerCase();
      if (mode === "train" || mode === "rer" || mode === "métro" || mode === "metro" || mode === "tram") hasHeavyRail = true;
    }
    const n = seenStops.size;
    let score = n >= 10 ? 90 : n >= 5 ? 80 : n >= 3 ? 70 : n >= 1 ? 60 : 30;
    if (hasHeavyRail) score = Math.min(100, score + 10);
    console.log(`[IDFM fallback] ${n} arrêts uniques à ${radiusM}m → score ${score} (rail: ${hasHeavyRail})`);
    return score;
  } catch (e) {
    console.warn("[fetchTransportScoreIdfm] erreur");
    return null;
  }
}

// ============================================================================
// v4.4: TRANSPORT — helpers GTFS
// ============================================================================
function extractMobilityFromGtfsResponse(json: unknown): MobilityGtfsResult | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const scoring = (j.scoring ?? j) as Record<string, unknown>;
  const total = numOrNull(scoring.scoreTransport ?? scoring.total);
  if (total == null || total <= 0) return null;
  const pillars = (scoring.pillars ?? {}) as Record<string, unknown>;
  return {
    total: Math.round(total),
    pillars: {
      rail:       numOrNull(pillars.rail),
      urban:      numOrNull(pillars.urban),
      employment: numOrNull(pillars.employment),
      multimodal: numOrNull(pillars.multimodal),
    },
    nearest_stop_m:  numOrNull(scoring.nearest_stop_m ?? scoring.nearestStopM),
    has_metro_train: scoring.has_metro_train === true || scoring.hasMetroTrain === true,
    has_tram:        scoring.has_tram === true || scoring.hasTram === true,
    is_urban:        scoring.is_urban === true || scoring.isUrban === true,
    label:   safeToString(scoring.label)   ?? _labelFromGtfsScore(Math.round(total)),
    summary: safeToString(scoring.summary) ?? "",
  };
}

function _labelFromGtfsScore(score: number): string {
  if (score >= 80) return "Très bien desservi";
  if (score >= 60) return "Bien desservi";
  if (score >= 40) return "Desservi";
  if (score >= 20) return "Peu desservi";
  return "Faiblement desservi";
}

// ============================================================================
// TRANSPORT — fonction principale v4.4
// ============================================================================
async function fetchTransportScore(
  lat: number,
  lon: number,
  communeInsee: string | null,
  // v4.6 : profil de zone déjà résolu par l'appelant. Optionnel pour ne pas
  // casser d'éventuels appels existants — on retombe alors sur la liste en dur.
  zone?: ZoneProfile,
): Promise<{
  score: number | null; label: string | null; summary: string | null;
  coverage: Coverage; applicable: boolean; mobility?: MobilityGtfsResult;
}> {
  // v4.6 — L'applicabilité du transport se décidait aussi sur la liste des
  // 14 départements : toute commune hors de cette liste était déclarée
  // « Hors grande agglomération — critère non évalué », y compris une petite
  // ville dotée d'un vrai réseau. On s'appuie désormais sur la grille INSEE.
  const isInMetro = zone ? !zone.isRural : isInGrandeAgglomeration(communeInsee);
  const functionsUrl = Deno.env.get("FUNCTIONS_URL") ?? (supabaseUrl ? supabaseUrl + "/functions/v1" : "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceKey) { headers["Authorization"] = "Bearer " + serviceKey; headers["apikey"] = serviceKey; }

  // ── Tentative 1 : transport-score-gtfs-v1 (GTFS PostGIS) ──────────────────
  if (functionsUrl) {
    try {
      const resp = await fetch(functionsUrl + "/transport-score-gtfs-v1", {
        method: "POST", headers,
        body: JSON.stringify({ lat, lon, radius_m: 1000 }),
        signal: AbortSignal.timeout(10000),
      });
      const json = await resp.json().catch(() => null);
      if (resp.ok && json) {
        const mobility = extractMobilityFromGtfsResponse(json);
        if (mobility) {
          console.log(`[Transport GTFS] score=${mobility.total} rail=${mobility.pillars.rail} urban=${mobility.pillars.urban}`);
          // applicable=true si grande agglo OU si GTFS détecte rail national (TER/TGV)
          const applicable = isInMetro || mobility.has_metro_train || (mobility.pillars.rail ?? 0) > 0;
          return { score: mobility.total, label: mobility.label, summary: mobility.summary, coverage: "ok", applicable, mobility };
        }
      }
      console.warn("[Transport GTFS] réponse invalide ou score=0, fallback OSM");
    } catch (e) { console.warn("[Transport GTFS] indisponible"); }
  }

  // Zone peu dense ET GTFS muet → le pilier est écarté.
  // v4.6 : le motif est explicite. « Non applicable » et « non mesuré » ne se
  // lisent pas de la même façon : le premier est un fait sur la commune, le
  // second l'aveu que la source de desserte n'a rien renvoyé.
  if (!isInMetro) {
    const niveau = zone?.libelle_niveau_7 ? ` (${zone.libelle_niveau_7}, grille de densité INSEE)` : '';
    return {
      score: null, label: "Non évalué",
      summary: `Commune peu dense${niveau} et aucune desserte remontée par le GTFS — critère écarté du score. `
        + `L'absence de desserte référencée ne vaut pas absence de desserte.`,
      coverage: "ok", applicable: false,
    };
  }

  // ── Tentative 2 : ancien transport-score (OSM Overpass) ───────────────────
  if (functionsUrl) {
    try {
      const resp = await fetch(functionsUrl + "/transport-score", {
        method: "POST", headers,
        body: JSON.stringify({ lat, lng: lon, radius_m: 800 }),
      });
      const json = await resp.json().catch(() => null);
      if (resp.ok && json?.success) {
        const scoring = json.scoring ?? {};
        const score = numOrNull(scoring.scoreTransport);
        if (score != null && score > 0) {
          return { score, label: safeToString(scoring.label), summary: safeToString(scoring.summary), coverage: "ok", applicable: true };
        }
      }
    } catch (e) { console.warn("[fetchTransportScore] /transport-score indisponible"); }
  }

  // ── Tentative 3 : IDFM live (IDF uniquement) ──────────────────────────────
  const dep = communeInsee?.slice(0, 2) ?? "";
  const isIdf = ["75","77","78","91","92","93","94","95"].includes(dep);
  if (isIdf) {
    console.log("[fetchTransportScore] Fallback IDFM");
    const idfmScore = await fetchTransportScoreIdfm(lat, lon, 1000, communeInsee);
    if (idfmScore != null) {
      const label = idfmScore >= 80 ? "Très bien desservi (IDFM)" : idfmScore >= 60 ? "Bien desservi (IDFM)" : "Desservi (IDFM)";
      return { score: idfmScore, label, summary: "Score calculé depuis les arrêts IDFM officiels.", coverage: "ok", applicable: true };
    }
  }

  return { score: null, label: null, summary: null, coverage: "error", applicable: true };
}

// ============================================================================
// SANTE ENRICHIE
// ============================================================================
async function fetchHealthFicheForCommune(codeCommune: string): Promise<{ data: HealthFicheEnriched | null; coverage: Coverage }> {
  if (!supabase || !codeCommune) return { data: null, coverage: "not_covered" };
  try { const { data, error } = await supabase.rpc("get_fiche_sante_commune", { p_code_commune: codeCommune }); if (error) return { data: null, coverage: "error" }; return { data: data as HealthFicheEnriched | null, coverage: data ? "ok" : "no_data" }; }
  catch (e) { console.error("[fetchHealthFicheForCommune] error"); return { data: null, coverage: "error" }; }
}

async function fetchHopitalProche(lat: number, lon: number, maxRadiusKm: number = 50): Promise<HopitalProche> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.rpc("get_hopital_proche", { p_lat: lat, p_lon: lon, p_radius_km: maxRadiusKm });
    if (!error && data && Array.isArray(data) && data.length > 0) { const h = data[0]; return { nom: h.raison_sociale||h.nom||"Hopital", commune: h.commune||"", distance_km: Math.round((h.distance_m||0)/100)/10, type: h.categorie||"Etablissement de sante" }; }
    const { data: finessData, error: finessError } = await supabase.from("finess_etablissements").select("finess, raison_sociale, commune, categorie, latitude, longitude").not("latitude","is",null).not("longitude","is",null).in("categorie",["Centre Hospitalier Regional","Centre Hospitalier","Centre Hospitalier Specialise","Hopital local","Clinique MCO","Hopital des armees"]).limit(100);
    if (finessError || !finessData) return null;
    let closest: HopitalProche = null; let minDistance = Infinity;
    for (const h of finessData) { const hLat = parseFloat(h.latitude); const hLon = parseFloat(h.longitude); if (isNaN(hLat)||isNaN(hLon)) continue; const dist = haversineDistance(lat,lon,hLat,hLon); if (dist < minDistance && dist <= maxRadiusKm*1000) { minDistance = dist; closest = { nom: h.raison_sociale||"Hopital", commune: h.commune||"", distance_km: Math.round(dist/100)/10, type: h.categorie||"Etablissement de sante" }; } }
    return closest;
  } catch (e) { console.warn("[fetchHopitalProche] error:"); return null; }
}

async function enrichHealthData(lat: number, lon: number, healthData: HealthFicheEnriched | null, bpeSanteDetails: Array<{ type: string; label: string; count: number; min_distance_m: number | null }> | null, medecinsProches?: MedecinProche[]): Promise<HealthFicheEnriched | null> {
  const baseData: HealthFicheEnriched = healthData || { code_commune: "", commune: "", population: null, densite_medecins_10000: null, densite_label: "Donnees insuffisantes", desert_medical_score: null, resume: "", kpi: { medecins_total: null, generalistes_total: null, generalistes_densite_10000: null, infirmiers_total: null, pharmacies_total: null, dentistes_total: null, autres_professionnels: null, etablissements_sante: null } };
  const hopital = await fetchHopitalProche(lat, lon, 50);
  let professionnels_details: ProfessionnelsSanteDetails = { medecins_generalistes: baseData.kpi.generalistes_total??0, medecins_specialistes: Math.max(0,(baseData.kpi.medecins_total??0)-(baseData.kpi.generalistes_total??0)), dentistes: baseData.kpi.dentistes_total??0, infirmiers: baseData.kpi.infirmiers_total??0, kinesitherapeutes: 0, pharmacies: baseData.kpi.pharmacies_total??0, autres: baseData.kpi.autres_professionnels??0 };
  if (bpeSanteDetails) for (const detail of bpeSanteDetails) { switch(detail.type) { case "medecin_generaliste": professionnels_details.medecins_generalistes = Math.max(professionnels_details.medecins_generalistes, detail.count); break; case "medecin_specialiste": professionnels_details.medecins_specialistes = Math.max(professionnels_details.medecins_specialistes, detail.count); break; case "dentiste": professionnels_details.dentistes = Math.max(professionnels_details.dentistes, detail.count); break; case "infirmier": professionnels_details.infirmiers = Math.max(professionnels_details.infirmiers, detail.count); break; case "kinesitherapeute": professionnels_details.kinesitherapeutes = Math.max(professionnels_details.kinesitherapeutes, detail.count); break; case "pharmacie": professionnels_details.pharmacies = Math.max(professionnels_details.pharmacies, detail.count); break; case "autre_sante": professionnels_details.autres = Math.max(professionnels_details.autres, detail.count); break; } }
  if (medecinsProches) { const countByType: Record<string, number> = {}; for (const m of medecinsProches) { const type = SANTE_TYPE_MAP[m.type_code]||"autre_sante"; countByType[type]=(countByType[type]||0)+1; } if (countByType["medecin_generaliste"]) professionnels_details.medecins_generalistes=Math.max(professionnels_details.medecins_generalistes,countByType["medecin_generaliste"]); if (countByType["medecin_specialiste"]) professionnels_details.medecins_specialistes=Math.max(professionnels_details.medecins_specialistes,countByType["medecin_specialiste"]); if (countByType["dentiste"]) professionnels_details.dentistes=Math.max(professionnels_details.dentistes,countByType["dentiste"]); if (countByType["infirmier"]) professionnels_details.infirmiers=Math.max(professionnels_details.infirmiers,countByType["infirmier"]); if (countByType["pharmacie"]) professionnels_details.pharmacies=Math.max(professionnels_details.pharmacies,countByType["pharmacie"]); if (countByType["kinesitherapeute"]) professionnels_details.kinesitherapeutes=Math.max(professionnels_details.kinesitherapeutes,countByType["kinesitherapeute"]); }
  const resumeParts: string[] = []; const communeName = baseData.commune||"la commune"; const pop = baseData.population;
  if (pop) resumeParts.push("La commune de "+communeName+" compte "+pop.toLocaleString("fr-FR")+" habitants."); else resumeParts.push("La commune de "+communeName+".");
  const profList: string[] = [];
  if (professionnels_details.medecins_generalistes>0) profList.push(String(professionnels_details.medecins_generalistes)+" medecin"+(professionnels_details.medecins_generalistes>1?"s":"")+" generaliste"+(professionnels_details.medecins_generalistes>1?"s":""));
  if (professionnels_details.medecins_specialistes>0) profList.push(String(professionnels_details.medecins_specialistes)+" specialiste"+(professionnels_details.medecins_specialistes>1?"s":""));
  if (professionnels_details.dentistes>0) profList.push(String(professionnels_details.dentistes)+" dentiste"+(professionnels_details.dentistes>1?"s":""));
  if (professionnels_details.infirmiers>0) profList.push(String(professionnels_details.infirmiers)+" infirmier"+(professionnels_details.infirmiers>1?"s":""));
  if (professionnels_details.kinesitherapeutes>0) profList.push(String(professionnels_details.kinesitherapeutes)+" kinesitherapeute"+(professionnels_details.kinesitherapeutes>1?"s":""));
  if (professionnels_details.pharmacies>0) profList.push(String(professionnels_details.pharmacies)+" pharmacie"+(professionnels_details.pharmacies>1?"s":""));
  if (profList.length>0) resumeParts.push("Professionnels de sante : "+profList.join(", ")+".");
  else resumeParts.push("Aucun professionnel de sante recense sur la commune.");
  if (hopital) resumeParts.push("Hopital le plus proche : "+hopital.nom+" a "+hopital.commune+" ("+String(hopital.distance_km)+" km).");
  return { ...baseData, resume: resumeParts.join(" "), professionnels_details, hopital_proche: hopital, medecins_proches: medecinsProches };
}

// ============================================================================
// INSEE SOCIO-ECO
// ============================================================================
type InseeSocioEcoData = { code_commune: string; commune: string | null; revenu_median: number | null; taux_chomage: number | null; pension_retraite_moyenne: number | null; taux_pauvrete: number | null; pct_proprietaires: number | null; annee: number | null; source: string | null; };
type InseeSocioEcoDebug = { ok: boolean; source: string; commune_insee: string; found: boolean; fields_present: string[]; error: string | null; };

async function fetchInseeSocioEco(communeCode: string, debug = false): Promise<{ data: InseeSocioEcoData | null; debugInfo: InseeSocioEcoDebug }> {
  const debugInfo: InseeSocioEcoDebug = { ok: false, source: "supabase", commune_insee: communeCode, found: false, fields_present: [], error: null };
  if (!communeCode) { debugInfo.error = "code_commune vide"; return { data: null, debugInfo }; }
  if (!supabase) { debugInfo.error = "supabase non initialise"; return { data: null, debugInfo }; }
  try {
    const { data, error } = await supabase.from("insee_socioeco_communes").select("*").eq("code_commune", communeCode).limit(1).maybeSingle();
    if (error) { debugInfo.error = "SUPABASE_ERROR"; return { data: null, debugInfo }; }
    if (!data) { debugInfo.error = "commune non trouvee dans insee_socioeco_communes"; return { data: null, debugInfo }; }
    debugInfo.found = true;
    const result: InseeSocioEcoData = { code_commune: communeCode, commune: data.commune||null, revenu_median: data.revenu_median_eur!=null?Number(data.revenu_median_eur):null, taux_chomage: data.taux_chomage_pct!=null?parseFloat(String(data.taux_chomage_pct)):null, taux_pauvrete: data.taux_pauvrete_pct!=null?parseFloat(String(data.taux_pauvrete_pct)):null, pct_proprietaires: data.pct_proprietaires!=null?parseFloat(String(data.pct_proprietaires)):null, pension_retraite_moyenne: data.pension_retraite_moyenne_eur_mois!=null?Number(data.pension_retraite_moyenne_eur_mois):null, annee: data.annee!=null?Number(data.annee):null, source: data.source||null };
    const fieldsPresent: string[] = [];
    if (result.revenu_median!=null) fieldsPresent.push("revenu_median"); if (result.taux_chomage!=null) fieldsPresent.push("taux_chomage"); if (result.taux_pauvrete!=null) fieldsPresent.push("taux_pauvrete"); if (result.pct_proprietaires!=null) fieldsPresent.push("pct_proprietaires"); if (result.pension_retraite_moyenne!=null) fieldsPresent.push("pension_retraite_moyenne");
    debugInfo.ok = true; debugInfo.fields_present = fieldsPresent;
    return { data: result, debugInfo };
  } catch (e) { debugInfo.error = "EXCEPTION"; return { data: null, debugInfo }; }
}

async function fetchInseeStatsHybrid(communeInsee: string | null, debug = false): Promise<{ data: InseeHybridData | null; coverage: Coverage; socioEcoDebug?: InseeSocioEcoDebug }> {
  if (!communeInsee) return { data: null, coverage: "not_covered" };
  let baseData: any = null;
  if (supabase) { try { const { data, error } = await supabase.from("insee_communes_stats").select("*").eq("code_commune", communeInsee).limit(1).maybeSingle(); if (!error && data) baseData = data; } catch { /* Ignorer */ } }
  const socioEcoResult = await fetchInseeSocioEco(communeInsee, debug); const socioEcoData = socioEcoResult.data;
  if (!baseData && !socioEcoData) return { data: null, coverage: "no_data", socioEcoDebug: socioEcoResult.debugInfo };
  const hasSocioEcoData = socioEcoData!=null && socioEcoResult.debugInfo.ok && socioEcoResult.debugInfo.fields_present.length>0;
  const result: InseeHybridData = { code_commune: communeInsee, commune: baseData?.commune??baseData?.nom_commune??socioEcoData?.commune??null, population: numOrNull(baseData?.population), pct_moins_25: numOrNull(baseData?.pct_moins_25), pct_plus_65: numOrNull(baseData?.pct_plus_65), densite_pop: numOrNull(baseData?.densite_pop), revenu_median: socioEcoData?.revenu_median??null, taux_pauvrete: socioEcoData?.taux_pauvrete??null, pct_proprietaires: socioEcoData?.pct_proprietaires??null, taux_chomage: socioEcoData?.taux_chomage??null, pension_retraite_moyenne: socioEcoData?.pension_retraite_moyenne??null, nb_menages: null, nb_logements: null, source_comparateur: hasSocioEcoData };
  if (baseData) for (const [key, value] of Object.entries(baseData)) { if (!(key in result)) result[key] = value; }
  return { data: result, coverage: "ok", socioEcoDebug: socioEcoResult.debugInfo };
}

// ============================================================================
// ECOLES
// ============================================================================
type EcolesStats = { nearestDistanceM: number | null; nearestName: string | null; nearestType: string | null; count300m: number; count500m: number; count1000m: number; scoreEcoles: number | null; };

async function fetchEcolesStats(lat: number, lng: number): Promise<{ data: EcolesStats | null; coverage: Coverage }> {
  if (!supabase) return { data: null, coverage: "not_covered" };
  try {
    const { data, error } = await supabase.rpc("get_ecoles_proximite", { lat, lng, rayon_m: 1000 });
    if (error) return { data: null, coverage: "error" };
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) return { data: { nearestDistanceM: null, nearestName: null, nearestType: null, count300m: 0, count500m: 0, count1000m: 0, scoreEcoles: null }, coverage: "no_data" };
    const nearest = rows[0] as any; const count300m = rows.filter((r: any)=>r.distance_m<=300).length; const count500m = rows.filter((r: any)=>r.distance_m<=500).length; const count1000m = rows.length;
    const nearestDistance = numOrNull(nearest.distance_m); let baseScore = 50;
    if (nearestDistance!=null) { if (nearestDistance<=200) baseScore=95; else if (nearestDistance<=300) baseScore=90; else if (nearestDistance<=500) baseScore=80; else if (nearestDistance<=800) baseScore=70; else if (nearestDistance<=1200) baseScore=60; }
    const densityBonus = (count300m>=2?5:0)+(count500m>=4?5:0)+(count1000m>=8?5:0);
    return { data: { nearestDistanceM: nearestDistance, nearestName: safeToString(nearest.nom), nearestType: safeToString(nearest.type_etablissement), count300m, count500m, count1000m, scoreEcoles: Math.min(100,baseScore+densityBonus) }, coverage: "ok" };
  } catch (e) { console.error("[fetchEcolesStats] error"); return { data: null, coverage: "error" }; }
}

// ============================================================================
// ESSENTIAL SERVICES BLOCK BUILDER
// ============================================================================
function normalizeEquipmentName(eq: any, typeCode: string): string {
  if (FORCE_TYPE_LABEL_CODES.has(typeCode)) { if (COMMERCE_TYPE_LABELS[typeCode]) return COMMERCE_TYPE_LABELS[typeCode]; if (SERVICE_TYPE_LABELS[typeCode]) return SERVICE_TYPE_LABELS[typeCode]; }
  const nom = eq.nom || eq.NOM || eq.name || null; if (nom && nom.trim()) return nom.trim();
  const typeLibelle = eq.type_libelle || eq.TYPE_LIBELLE || null; if (typeLibelle && typeLibelle.trim()) return typeLibelle.trim();
  if (COMMERCE_TYPE_LABELS[typeCode]) return COMMERCE_TYPE_LABELS[typeCode]; if (SERVICE_TYPE_LABELS[typeCode]) return SERVICE_TYPE_LABELS[typeCode]; if (MEDECIN_SPECIALITE_LABELS[typeCode]) return MEDECIN_SPECIALITE_LABELS[typeCode];
  return typeCode;
}
function getTypeLabel(typeCode: string): string { if (COMMERCE_TYPE_LABELS[typeCode]) return COMMERCE_TYPE_LABELS[typeCode]; if (SERVICE_TYPE_LABELS[typeCode]) return SERVICE_TYPE_LABELS[typeCode]; if (MEDECIN_SPECIALITE_LABELS[typeCode]) return MEDECIN_SPECIALITE_LABELS[typeCode]; return typeCode; }
function createEmptySummary(radiusKm: number): EssentialServiceSummary { return { radius_km: radiusKm, count: 0, nearest: null, top: [] }; }
function getEquipmentTextForFallback(eq: any): string { const parts: string[] = []; if (eq.nom) parts.push(eq.nom); if (eq.NOM) parts.push(eq.NOM); if (eq.name) parts.push(eq.name); if (eq.type_libelle) parts.push(eq.type_libelle); if (eq.TYPE_LIBELLE) parts.push(eq.TYPE_LIBELLE); return normalizeTextForSearch(parts.join(" ")); }
function containsOptiqueKeywords(text: string): boolean { const normalized = normalizeTextForSearch(text); return normalized.includes("optique")||normalized.includes("opticien")||normalized.includes("lunette"); }

function buildEssentialServicesBlock(rawItems: Array<{ type_code: string; distance_m: number; nom?: string; name?: string; NOM?: string; type_libelle?: string; TYPE_LIBELLE?: string; commune?: string; LIBCOM?: string; libcom?: string; adresse?: string; ADRESSE?: string; }>, radiusM: number, isRural: boolean, debug = false): EssentialServicesBlock {
  const radiusKm = metersToKm(radiusM);
  const buckets: Record<EssentialServiceBucket, EssentialServiceItem[]> = { pharmacie: [], banque_dab: [], poste: [], station_service: [], commerce_alimentaire: [], medecin_generaliste: [], medecin_specialiste: [], dentiste: [], infirmier: [], kinesitherapeute: [], gendarmerie: [], commissariat: [] };
  const debugPharmacieItems: Array<{ type_code: string; text: string; distance_m: number }> = []; const typeCodeHistogram: Record<string, number> = {};
  for (const eq of rawItems) {
    const typeCode = String(eq.type_code??"").trim(); if (!typeCode) continue;
    const distM = Number(eq.distance_m??0); if (!Number.isFinite(distM)||distM<0) continue;
    if (debug) typeCodeHistogram[typeCode]=(typeCodeHistogram[typeCode]||0)+1;
    let bucket = ESSENTIAL_BUCKET_BY_TYPE_CODE[typeCode];
    if (!bucket) { const textContent = getEquipmentTextForFallback(eq); if (textContent.includes("pharmacie")||textContent.includes("pharma")) { bucket = "pharmacie"; if (debug) console.log("Pharmacie fallback texte: type_code="+typeCode); } if (debug && (typeCode.startsWith("D3")||textContent.includes("pharm"))) debugPharmacieItems.push({ type_code: typeCode, text: textContent.slice(0,80), distance_m: distM }); }
    if (!bucket) continue;
    if (bucket === "station_service") { if (typeCode !== "G101") continue; const textContent = getEquipmentTextForFallback(eq); if (containsOptiqueKeywords(textContent)) continue; }
    let typeLabel = getTypeLabel(typeCode); if (bucket==="pharmacie"&&!ESSENTIAL_BUCKET_BY_TYPE_CODE[typeCode]) typeLabel="Pharmacie";
    buckets[bucket].push({ name: normalizeEquipmentName(eq, typeCode), type_label: typeLabel, type_code: typeCode, distance_m: Math.round(distM), distance_km: metersToKm(distM), commune: eq.commune||eq.LIBCOM||eq.libcom||undefined, adresse: eq.adresse||eq.ADRESSE||undefined });
  }
  const buildSummary = (bucket: EssentialServiceBucket): EssentialServiceSummary => { const items = buckets[bucket]; if (items.length===0) return createEmptySummary(radiusKm); items.sort((a,b)=>a.distance_m-b.distance_m); return { radius_km: radiusKm, count: items.length, nearest: items[0], top: items.slice(0,5) }; };
  const result: EssentialServicesBlock = { zone_type: isRural?"rural":"urbain", radius_km: radiusKm, pharmacie: buildSummary("pharmacie"), banque_dab: buildSummary("banque_dab"), poste: buildSummary("poste"), station_service: buildSummary("station_service"), commerce_alimentaire: buildSummary("commerce_alimentaire"), medecin_generaliste: buildSummary("medecin_generaliste"), medecin_specialiste: buildSummary("medecin_specialiste"), dentiste: buildSummary("dentiste"), infirmier: buildSummary("infirmier"), kinesitherapeute: buildSummary("kinesitherapeute"), gendarmerie: buildSummary("gendarmerie"), commissariat: buildSummary("commissariat") };
  if (debug && result.pharmacie.count===0) console.log("[essential_services] pharmacie count=0");
  return result;
}

// ============================================================================
// CALCUL INDICES V3 & VERDICTS
// ============================================================================
function computeMarketIndices(dvfStats: DvfMarketStats | null, transportScore: number | null, transportApplicable: boolean, commoditesScore: number | null, targets: MarketStudyPayload["targets"], bpeCoverage: Coverage = "ok"): { demand_index: number | null; supply_index: number | null; price_index: number | null; accessibility_index: number | null; risk_index: number | null; global_score: number } {
  const accessibility_index = transportApplicable ? transportScore : null;
  let supply_index: number | null = null; if (dvfStats?.transactions_count!=null) supply_index = computeIndex(dvfStats.transactions_count,0,100,false);
  let demand_index: number | null = null; if (dvfStats?.evolution_pct!=null) demand_index = computeIndex(dvfStats.evolution_pct,-10,10,false);
  let price_index: number | null = null;
  if (dvfStats?.price_median_eur_m2 && targets?.unit_price_m2) { const ratio = dvfStats.price_median_eur_m2/targets.unit_price_m2; if (ratio>=0.1&&ratio<=10) price_index=computeIndex(ratio,0.5,1.5,true); else price_index=50; } else if (dvfStats?.price_median_eur_m2) price_index=50;
  let risk_index: number | null = null; if (bpeCoverage==="ok"&&commoditesScore!=null) risk_index=Math.round(100-commoditesScore);
  const items: Array<{w:number;v:number|null}> = [];
  if (dvfStats&&dvfStats.transactions_count>0) { items.push({w:0.35,v:supply_index}); items.push({w:0.25,v:price_index}); }
  if (transportApplicable&&transportScore!=null) items.push({w:0.20,v:accessibility_index});
  if (bpeCoverage==="ok"&&commoditesScore!=null) items.push({w:0.20,v:commoditesScore});
  const global = weightedAverage(items);
  return { demand_index, supply_index, price_index, accessibility_index, risk_index, global_score: global==null?50:Math.round(global) };
}

function generateVerdict(score: number, dvfStats: DvfMarketStats | null, dvfCoverage: Coverage, projectNature: string, transportApplicable: boolean): string {
  const p = (projectNature??"").toString().toLowerCase();
  const projectLabel = p==="logement"?"logement":p==="bureaux"?"bureaux":p==="commerce"?"commerce":p==="hotel"?"hotel":p==="ehpad"?"EHPAD":p==="residence_senior"?"residence senior":p==="residence_etudiante"?"residence etudiante":projectNature;
  const transportNote = !transportApplicable?" (zone hors metropole, transport non evalue)":"";
  if (dvfCoverage==="not_covered") return "Prix/transactions indisponibles (DVF: "+coverageLabel(dvfCoverage)+").";
  if (dvfCoverage==="error") return "Erreur lors de la recuperation DVF.";
  if (dvfStats==null||dvfStats.transactions_count===0) return "Donnees de marche insuffisantes pour evaluer ce projet de "+projectLabel+". Elargir le perimetre recommande.";
  if (score>=70) return "Marche tres favorable pour un projet de "+projectLabel+transportNote+". Demande soutenue et bonne liquidite.";
  if (score>=55) return "Marche favorable pour un projet de "+projectLabel+transportNote+". Conditions de marche correctes.";
  if (score>=40) return "Marche modere pour un projet de "+projectLabel+transportNote+". Analyse approfondie recommandee.";
  return "Marche tendu pour un projet de "+projectLabel+transportNote+". Vigilance requise sur le positionnement prix.";
}

function generateInsights(dvfStats: DvfMarketStats | null, dvfCoverage: Coverage, transportScore: number | null, transportApplicable: boolean, commoditesScore: number | null, ecolesScore: number | null, radiusKm: number, bpeCoverage: Coverage = "ok", healthSummary: HealthFicheEnriched | null = null, bpeDetails: BpeKpis | null = null, servicesRuraux: ServicesRuraux | null = null, isRural: boolean = false, _essentialServices: EssentialServicesBlock | null = null): MarketInsight[] {
  const insights: MarketInsight[] = [];
  if (dvfCoverage==="not_covered") insights.push({type:"warning",title:"DVF non couvert",description:"La source DVF n'est pas disponible.",source:"DVF"});
  else if (dvfCoverage==="error") insights.push({type:"warning",title:"Erreur DVF",description:"Erreur lors de l'appel DVF.",source:"DVF"});
  else if (dvfStats&&dvfStats.transactions_count>0) { insights.push({type:dvfStats.transactions_count>=30?"positive":"neutral",title:String(dvfStats.transactions_count)+" transactions analysees",description:"Marche actif avec "+String(dvfStats.transactions_count)+" ventes dans un rayon de "+String(radiusKm)+" km.",source:"DVF"}); if (dvfStats.price_median_eur_m2) insights.push({type:"neutral",title:"Prix median : "+dvfStats.price_median_eur_m2.toLocaleString("fr-FR")+" EUR/m2",description:"Intervalle (Q1-Q3) : "+(dvfStats.price_q1_eur_m2?.toLocaleString("fr-FR")??"?")+" a "+(dvfStats.price_q3_eur_m2?.toLocaleString("fr-FR")??"?")+" EUR/m2.",source:"DVF"}); }
  else insights.push({type:"warning",title:"Donnees DVF insuffisantes",description:"Peu ou pas de transactions. Elargir le rayon.",source:"DVF"});
  if (transportApplicable) { if (transportScore!=null) { const level=transportScore>=70?"Excellente":transportScore>=50?"Bonne":transportScore>=30?"Moyenne":"Faible"; insights.push({type:transportScore>=50?"positive":transportScore>=30?"neutral":"negative",title:level+" desserte transports ("+String(transportScore)+"/100)",description:"Accessibilite transports en commun.",source:"Transport"}); } }
  else insights.push({type:"neutral",title:"Transports en commun",description:"Zone hors grande agglomeration - critere non evalue.",source:"Transport"});
  if (servicesRuraux) {
    const radiusLabel = String(metersToKm(servicesRuraux.rayon_recherche_m))+" km";
    if (servicesRuraux.pharmacie_proche) { const ph=servicesRuraux.pharmacie_proche; insights.push({type:ph.distance_km<=5?"positive":ph.distance_km<=10?"neutral":"negative",title:"Pharmacie a "+String(ph.distance_km)+" km",description:ph.nom+(ph.commune?" ("+ph.commune+")":"")+". ",source:"Services ruraux"}); } else if (isRural) insights.push({type:"warning",title:"Aucune pharmacie trouvee",description:"Pas de pharmacie dans un rayon de "+radiusLabel+".",source:"Services ruraux"});
    const commerce = servicesRuraux.supermarche_proche||servicesRuraux.hypermarche_proche||servicesRuraux.superette_proche;
    if (commerce) insights.push({type:commerce.distance_km<=10?"positive":commerce.distance_km<=15?"neutral":"negative",title:commerce.type+" a "+String(commerce.distance_km)+" km",description:commerce.nom+(commerce.commune?" ("+commerce.commune+")":"")+". ",source:"Services ruraux"});
    else if (isRural) insights.push({type:"warning",title:"Aucun commerce alimentaire trouve",description:"Pas de commerce alimentaire dans un rayon de "+radiusLabel+".",source:"Services ruraux"});
    if (servicesRuraux.medecin_proche) { const m=servicesRuraux.medecin_proche; const distKm=m.distance_km??metersToKm(m.distance_m); insights.push({type:distKm<=10?"positive":distKm<=15?"neutral":"negative",title:"Medecin generaliste a "+String(distKm)+" km",description:m.nom+(m.commune?" ("+m.commune+")":"")+". ",source:"Services ruraux"}); } else if (isRural) insights.push({type:"warning",title:"Aucun medecin generaliste trouve",description:"Pas de medecin generaliste dans un rayon de "+radiusLabel+".",source:"Services ruraux"});
    if (servicesRuraux.poste_proche) { const s=servicesRuraux.poste_proche; insights.push({type:s.distance_km<=5?"positive":"neutral",title:s.type+" a "+String(s.distance_km)+" km",description:s.nom+(s.commune?" ("+s.commune+")":"")+". ",source:"Services ruraux"}); }
    if (servicesRuraux.banque_proche) { const b=servicesRuraux.banque_proche; insights.push({type:b.distance_km<=5?"positive":"neutral",title:"Banque/DAB a "+String(b.distance_km)+" km",description:b.nom+(b.commune?" ("+b.commune+")":"")+". ",source:"Services ruraux"}); }
    if (isRural&&servicesRuraux.station_service_proche) { const s=servicesRuraux.station_service_proche; insights.push({type:s.distance_km<=10?"positive":"neutral",title:"Station service a "+String(s.distance_km)+" km",description:s.nom+(s.commune?" ("+s.commune+")":"")+". ",source:"Services ruraux"}); }
  } else if (!isRural) {
    if (bpeDetails?.commerces_proches&&bpeDetails.commerces_proches.length>0) { const top3=bpeDetails.commerces_proches.slice(0,3); insights.push({type:bpeDetails.nb_commerces>=5?"positive":bpeDetails.nb_commerces>=2?"neutral":"negative",title:String(bpeDetails.nb_commerces)+" commerces a proximite",description:"Les plus proches : "+top3.map(c=>c.type+" a "+String(c.distance_m)+"m").join(", ")+".",source:"BPE"}); }
    else if (bpeCoverage==="no_data") insights.push({type:"warning",title:"Donnees BPE indisponibles",description:"Aucun equipement trouve dans le perimetre.",source:"BPE"});
    else if (commoditesScore!=null) { const level=commoditesScore>=70?"Excellente":commoditesScore>=50?"Bonne":commoditesScore>=30?"Moyenne":"Faible"; insights.push({type:commoditesScore>=50?"positive":commoditesScore>=30?"neutral":"negative",title:level+" proximite commerces/services",description:"Densite d'equipements a proximite (BPE).",source:"BPE"}); }
  }
  if (ecolesScore!=null) { const level=ecolesScore>=70?"Tres bonne":ecolesScore>=50?"Bonne":ecolesScore>=30?"Moyenne":"Faible"; insights.push({type:ecolesScore>=50?"positive":ecolesScore>=30?"neutral":"negative",title:level+" accessibilite scolaire ("+String(ecolesScore)+"/100)",description:"Base sur la proximite et la densite d'etablissements a 1 km.",source:"Ecoles"}); }
  if (!isRural) { const medecinsProches=bpeDetails?.medecins_proches||healthSummary?.medecins_proches; if (medecinsProches&&medecinsProches.length>0) insights.push({type:medecinsProches.length>=5?"positive":medecinsProches.length>=2?"neutral":"negative",title:String(medecinsProches.length)+" professionnels de sante a proximite",description:"Les plus proches : "+medecinsProches.slice(0,3).map(m=>m.specialite+" a "+String(m.distance_m)+"m").join(", ")+".",source:"Sante"}); }
  return insights;
}

function buildServicesRurauxFromEssentialServices(es: EssentialServicesBlock): ServicesRuraux {
  const toSE = (item: EssentialServiceItem | null): ServiceEssentiel | null => { if (!item) return null; return { nom: item.name, type: item.type_label, type_code: item.type_code, distance_m: item.distance_m, distance_km: item.distance_km, adresse: item.adresse, commune: item.commune }; };
  const toMP = (item: EssentialServiceItem | null): MedecinProche | null => { if (!item) return null; return { nom: item.name, specialite: item.type_label, type_code: item.type_code, distance_m: item.distance_m, distance_km: item.distance_km, adresse: item.adresse, commune: item.commune }; };
  return { pharmacie_proche: toSE(es.pharmacie.nearest), supermarche_proche: toSE(es.commerce_alimentaire.nearest), hypermarche_proche: null, superette_proche: null, station_service_proche: toSE(es.station_service.nearest), poste_proche: toSE(es.poste.nearest), banque_proche: toSE(es.banque_dab.nearest), commissariat_proche: toSE(es.commissariat.nearest), gendarmerie_proche: toSE(es.gendarmerie.nearest), medecin_proche: toMP(es.medecin_generaliste.nearest), rayon_recherche_m: es.radius_km*1000 };
}

function buildServicesRurauxFromProvider(sp: any): ServicesRuraux {
  const nearest = sp.nearest_by_category || {};
  const toSE = (cat: string, defaultName: string, defaultCode: string): ServiceEssentiel | null => { const item = nearest[cat]; if (!item) return null; return { nom: item.name??defaultName, type: item.label??defaultName, type_code: item.raw_type_code??defaultCode, distance_m: item.distance_m, distance_km: Math.round((item.distance_m/1000)*10)/10, commune: item.commune??undefined }; };
  return { pharmacie_proche: toSE("pharmacie","Pharmacie","D301"), supermarche_proche: toSE("alimentation","Commerce alimentaire",""), hypermarche_proche: toSE("hypermarche","Hypermarche",""), superette_proche: toSE("superette","Superette",""), station_service_proche: nearest.station_service?{nom:"Station service",type:"Station service",type_code:nearest.station_service.raw_type_code??"G101",distance_m:nearest.station_service.distance_m,distance_km:Math.round((nearest.station_service.distance_m/1000)*10)/10,commune:nearest.station_service.commune??undefined}:null, poste_proche: toSE("poste","Bureau de poste",""), banque_proche: toSE("banque_dab","Banque/DAB",""), commissariat_proche: toSE("commissariat","Commissariat",""), gendarmerie_proche: toSE("gendarmerie","Gendarmerie",""), medecin_proche: nearest.medecin_generaliste?{nom:nearest.medecin_generaliste.name??"Medecin generaliste",specialite:"Medecin generaliste",type_code:nearest.medecin_generaliste.raw_type_code??"D201",distance_m:nearest.medecin_generaliste.distance_m,distance_km:Math.round((nearest.medecin_generaliste.distance_m/1000)*10)/10,commune:nearest.medecin_generaliste.commune??undefined}:null, rayon_recherche_m: sp.rayon_recherche_m??RAYON_RURAL_MAX_M };
}

function computeStandardSmartScore(components: SmartScoreComponents, transportApplicable: boolean): number {
  const items: Array<{w:number;v:number|null}> = [];
  if (transportApplicable&&components.transport_score!=null) items.push({w:0.25,v:components.transport_score});
  if (components.commodites_score!=null) items.push({w:0.25,v:components.commodites_score});
  if (components.ecoles_score!=null) items.push({w:0.20,v:components.ecoles_score});
  if (components.marche_score!=null) items.push({w:0.20,v:components.marche_score});
  if (components.sante_score!=null) items.push({w:0.10,v:components.sante_score});
  const result = weightedAverage(items); return result==null?50:Math.round(result);
}

function generateStandardVerdict(score: number, coverage: CoverageMap, transportApplicable: boolean): string {
  const sourcesOk = Object.values(coverage).filter(c=>c==="ok").length; const totalSources = Object.keys(coverage).length;
  const coverageText = "("+String(sourcesOk)+"/"+String(totalSources)+" sources)"; const transportNote = !transportApplicable?" - zone hors metropole":"";
  if (sourcesOk===0) return "Analyse impossible : aucune source disponible.";
  if (score>=80) return "Excellent emplacement "+coverageText+transportNote+". Tres bonne accessibilite.";
  if (score>=65) return "Bon emplacement "+coverageText+transportNote+". Cadre de vie agreable.";
  if (score>=50) return "Emplacement correct "+coverageText+transportNote+". Quelques points d'amelioration.";
  if (score>=35) return "Emplacement moyen "+coverageText+transportNote+". Analyse approfondie recommandee.";
  return "Emplacement a ameliorer "+coverageText+transportNote+". Vigilance requise.";
}

// ============================================================================
// COMPUTE SMARTSCORE V4 BLOCK
// ============================================================================
async function computeSmartScoreV4Block(params: {
  essentialServices: EssentialServicesBlock; servicesRuraux: ServicesRuraux | null; isRural: boolean;
  dvfStats: DvfMarketStats | null; communeInsee: string | null; inseeData: InseeHybridData | null;
  transportScore: number | null; transportApplicable: boolean; commoditesScore: number | null;
  ecolesScore: number | null; santeScore: number | null; healthSummary: HealthFicheEnriched | null;
  projectNature: string; horizonMonths: number; lat: number; lon: number;
  prix_m2_bien: number | null; dpe_label: string | null; surface_m2_bien: number | null;
  prix_bien: number | null; monthly_rent_target: number | null; nightly_rate_target: number | null; debug: boolean;
}): Promise<any> {
  const { essentialServices, servicesRuraux, isRural, dvfStats, communeInsee, inseeData, transportScore, transportApplicable, commoditesScore, ecolesScore, santeScore, healthSummary, projectNature, horizonMonths, lat, lon, prix_m2_bien, dpe_label, surface_m2_bien, prix_bien, monthly_rent_target, nightly_rate_target, debug } = params;
  console.log("[SmartScore V4] Computing...");
  const essServicesResult = computeEssentialServicesScore(essentialServices);
  const ruralAccessResult: RuralAccessibilityResult | null = isRural ? computeRuralAccessibilityScore(servicesRuraux, essentialServices) : null;
  let priceTrend: any = null, liquidity: any = null, rentalTension: any = null, marketComposite: any = null;
  try { priceTrend = computePriceTrend(dvfStats); liquidity = computeLiquidityScore(dvfStats, horizonMonths); rentalTension = communeInsee ? await computeRentalTension(communeInsee) : null; marketComposite = computeMarketComposite({ priceTrend, liquidity, rentalTension }); } catch (e) { console.warn("[SmartScore V4] market_intelligence error:"); }
  let georisquesScore: any = null, dpeResult: any = null, airResult: any = null, noiseResult: any = null, environmentResult: any = null;
  try { georisquesScore = communeInsee ? await computeGeorisquesScore(communeInsee) : null; dpeResult = communeInsee ? await fetchDpeQuartier(communeInsee, lat, lon) : null; airResult = await fetchAirQuality(lat, lon); noiseResult = estimateNoiseScore(transportScore, isRural); environmentResult = computeEnvironmentScore({ georisques: georisquesScore, dpe: dpeResult, air: airResult, noise: noiseResult }); } catch (e) { console.warn("[SmartScore V4] environment error:"); }
  let popTrendResult: PopulationTrendResult | null = null, demographicScore: any = null;
  try { const dr = communeInsee ? await computeDemographicScore(communeInsee, inseeData, projectNature) : null; if (dr) { popTrendResult = dr.populationTrend ?? null; demographicScore = dr; } } catch (e) { console.warn("[SmartScore V4] demographic error:"); }
  let competitionResult: CompetitionScoreResult | null = null;
  try { const permis = communeInsee ? await fetchPermisProches(communeInsee, lat, lon) : null; competitionResult = permis ? computeCompetitionScore(permis, projectNature) : null; } catch (e) { console.warn("[SmartScore V4] competition error:"); }
  let priceOpportunityScore: number | null = null, priceOpportunityDetail: any = null;
  if (prix_m2_bien != null && dvfStats?.price_median_eur_m2 != null && dvfStats.price_median_eur_m2 > 0) {
    const ratio = prix_m2_bien / dvfStats.price_median_eur_m2;
    if (ratio <= 0.15) priceOpportunityScore = 100; else if (ratio <= 0.30) priceOpportunityScore = 97; else if (ratio <= 0.50) priceOpportunityScore = 93; else if (ratio <= 0.70) priceOpportunityScore = 85; else if (ratio <= 0.85) priceOpportunityScore = 72; else if (ratio <= 0.95) priceOpportunityScore = 60; else if (ratio <= 1.05) priceOpportunityScore = 50; else if (ratio <= 1.15) priceOpportunityScore = 40; else if (ratio <= 1.30) priceOpportunityScore = 25; else if (ratio <= 1.50) priceOpportunityScore = 15; else priceOpportunityScore = 5;
    priceOpportunityDetail = { prix_m2_bien, prix_m2_marche: dvfStats.price_median_eur_m2, ratio: Math.round(ratio * 100) / 100, decote_pct: Math.round((1 - ratio) * 100), score: priceOpportunityScore };
  }
  const smartScoreV4 = computeSmartScoreV4({ essentialServicesScore: essServicesResult?.score ?? null, ruralAccessibilityScore: ruralAccessResult?.score ?? null, transportScore: transportApplicable ? transportScore : null, transportApplicable, ecolesScore, commoditesScore, santeScore, marketCompositeScore: marketComposite?.score ?? null, environmentScore: environmentResult?.score ?? null, demographicScore: demographicScore?.score ?? null, competitionScore: competitionResult?.score ?? null, priceOpportunityScore, isRural, projectNature });
  const dpeScore = mapDpeLabelToScore(dpe_label); const dpeConstraint = buildDpeConstraint(dpe_label);
  const energyRenovationEstimate = estimateEnergyRenovationCost({ dpeLabel: dpe_label, surfaceM2: surface_m2_bien, projectNature });
  const energyBusinessImpact = computeEnergyBusinessImpact({ dpeLabel: dpe_label, prix: prix_bien, surfaceM2: surface_m2_bien, monthlyRent: monthly_rent_target, nightlyRate: nightly_rate_target, renovationCostTotalEur: energyRenovationEstimate.estimated_cost_total_eur });
  const scoreBeforeDpeAdjustment = smartScoreV4.score; let adjustedScore = scoreBeforeDpeAdjustment;
  // v4.5 — `score` peut désormais valoir null (aucun pilier mesuré). Sans ce
  // garde-fou, `Math.min(null, cap)` coerce null en 0 et produirait le PIRE
  // score possible là où l'on voulait dire « non calculable ».
  if (dpeConstraint.max_score_cap != null && scoreBeforeDpeAdjustment != null) {
    adjustedScore = Math.min(scoreBeforeDpeAdjustment, dpeConstraint.max_score_cap);
  }
  if (debug) console.log("[SmartScore V4] result", { score: adjustedScore });
  return {
    score: adjustedScore, score_before_dpe_adjustment: scoreBeforeDpeAdjustment, verdict: smartScoreV4.verdict,
    pillar_scores: { ...smartScoreV4.pillar_scores, dpe: dpeScore }, weights: smartScoreV4.weights,
    // v4.5 — exposé pour que l'écran et le Copilot puissent dire sur combien de
    // piliers le score repose, au lieu de le présenter comme complet.
    confidence: smartScoreV4.confidence,
    dpe: { label: dpe_label ?? null, score: dpeScore, constraint: dpeConstraint },
    energy_renovation: energyRenovationEstimate, energy_business_impact: energyBusinessImpact,
    environment: { score: environmentResult?.score ?? null, georisques: georisquesScore, dpe: dpeResult, air: airResult, noise: noiseResult },
    demographie: { score: demographicScore?.score ?? null, population_trend: popTrendResult, details: demographicScore },
    competition: competitionResult,
    market_intelligence: { score: marketComposite?.score ?? null, price_trend: priceTrend, liquidity, rental_tension: rentalTension },
    essential_services_score: essServicesResult, rural_accessibility: ruralAccessResult, price_opportunity: priceOpportunityDetail,
  };
}

// ============================================================================
// HANDLER MARKET STUDY
// ============================================================================
async function handleMarketStudy(payload: MarketStudyPayload): Promise<Response> {
  const { parcel_id, commune_insee, project_nature, radius_km = 2, horizon_months = 24, targets, dpe_label = null, debug = false } = payload;
  const { point, error } = await resolveAnalysisPoint(payload);
  if (!point) return json({ success: false, error: error ?? "Impossible de resoudre le point d'analyse.", mode: "market_study", version: "v4.7" }, 400);
  const communeInseeFinal = point.commune_insee ?? commune_insee?.toString() ?? null;
  // v4.6 : profil de zone lu dans la grille de densité INSEE (cf. resolveZoneProfile).
  const zone = await resolveZoneProfile(communeInseeFinal);
  const isRural = zone.isRural;
  const zoneType = zone.zoneType;
  console.log(`[Market Study] Zone: ${zoneType.toUpperCase()} · niveau_7=${zone.niveau_7 ?? 'n.c.'} (${zone.libelle_niveau_7 ?? 'repli liste en dur'}) · source=${zone.source} · rayons bpe=${zone.bpeRadius}m essentiels=${zone.essentialServicesRadius}m`);
  const bpeRadius = zone.bpeRadius;
  const essentialServicesRadius = zone.essentialServicesRadius;
  const [transportResult, bpeResult, ecolesResult, inseeResult, _essRawMS] = await Promise.all([
    fetchTransportScore(point.lat, point.lon, communeInseeFinal, zone),
    fetchBpeStats(point.lat, point.lon, bpeRadius, communeInseeFinal, debug),
    fetchEcolesStats(point.lat, point.lon),
    fetchInseeStatsHybrid(communeInseeFinal, debug),
    fetchEssentialServicesRaw(point.lat, point.lon, essentialServicesRadius, debug),
  ]);
  let essentialServicesRawResult = _essRawMS;
  if (essentialServicesRawResult.items.length === 0 && supabase) {
    console.log("[Essential services] fallback vers RPC get_bpe_essentiels_radius");
    const rpcItems = await fetchEssentialServicesViaRpc(point.lat, point.lon, essentialServicesRadius, debug);
    if (rpcItems.length > 0) essentialServicesRawResult = { items: rpcItems, type_codes_sent: essentialServicesRawResult.type_codes_sent };
  }
  const essentialServices = buildEssentialServicesBlock(essentialServicesRawResult.items, essentialServicesRadius, isRural, debug);
  let servicesRuraux: ServicesRuraux | null = buildServicesRurauxFromEssentialServices(essentialServices);
  let servicesProximiteDebug: any = null; let residencesSeniors: ResidenceSenior[] = [];
  if (supabase) {
    try {
      const sp = await (servicesProximiteV1 as any)({ supabase, lat: point.lat, lon: point.lon, zone_type: zoneType });
      if (debug) servicesProximiteDebug = (sp as any)?.debug;
      const spServices = buildServicesRurauxFromProvider(sp);
      if (!servicesRuraux.pharmacie_proche && spServices.pharmacie_proche) servicesRuraux.pharmacie_proche = spServices.pharmacie_proche;
      if (!servicesRuraux.supermarche_proche && spServices.supermarche_proche) servicesRuraux.supermarche_proche = spServices.supermarche_proche;
      if (!servicesRuraux.hypermarche_proche && spServices.hypermarche_proche) servicesRuraux.hypermarche_proche = spServices.hypermarche_proche;
      if (!servicesRuraux.superette_proche && spServices.superette_proche) servicesRuraux.superette_proche = spServices.superette_proche;
      if (!servicesRuraux.station_service_proche && spServices.station_service_proche) servicesRuraux.station_service_proche = spServices.station_service_proche;
      if (!servicesRuraux.poste_proche && spServices.poste_proche) servicesRuraux.poste_proche = spServices.poste_proche;
      if (!servicesRuraux.banque_proche && spServices.banque_proche) servicesRuraux.banque_proche = spServices.banque_proche;
      if (!servicesRuraux.commissariat_proche && spServices.commissariat_proche) servicesRuraux.commissariat_proche = spServices.commissariat_proche;
      if (!servicesRuraux.gendarmerie_proche && spServices.gendarmerie_proche) servicesRuraux.gendarmerie_proche = spServices.gendarmerie_proche;
      if (!servicesRuraux.medecin_proche && spServices.medecin_proche) servicesRuraux.medecin_proche = spServices.medecin_proche;
    } catch (e) { console.warn("[servicesProximiteV1] error (non-blocking):"); }
  }
  if (!servicesRuraux.pharmacie_proche) {
    const osmPharmacy = await fetchNearestPharmacyOverpass(point.lat, point.lon, RAYON_RURAL_MAX_M, debug);
    if (osmPharmacy) servicesRuraux.pharmacie_proche = osmPharmacy;
  }
  if (isRural) residencesSeniors = await fetchResidencesSeniors(point.lat, point.lon, 20, debug);
  let healthResult: { data: HealthFicheEnriched | null; coverage: Coverage } = { data: null, coverage: "not_covered" };
  if (communeInseeFinal) { const rawHealth = await fetchHealthFicheForCommune(communeInseeFinal); const enrichedHealth = await enrichHealthData(point.lat, point.lon, rawHealth.data, bpeResult.details?.sante_details ?? null, bpeResult.details?.medecins_proches ?? undefined); healthResult = { data: enrichedHealth, coverage: rawHealth.coverage }; }
  const healthSummary = healthResult.data;
  // v4.6 : rayon gradué sur le niveau INSEE (cf. RAYONS_PAR_NIVEAU_7).
  const ehpadRadius = zone.ehpadRadius;
  const ehpad = await finessEhpadNearby(supabase!, { lat: point.lat, lon: point.lon, radius_m: ehpadRadius, ttl_seconds: 86400, debug });
  const dvfTypeLocal = mapProjectNatureToDvfType(project_nature);
  let dvfCoverage: Coverage = "not_covered", dvfReason: string | null = null, dvfStats: DvfMarketStats | null = null, comps: MarketComp[] = [], dvfSource = "csv";
  const dvfApi = await dvfMarketKpis({ lat: point.lat, lon: point.lon, radius_m: Math.round(radius_km * 1000), horizon_months, type_local: dvfTypeLocal, commune_insee: communeInseeFinal, ttl_seconds: 86400, debug });
  dvfCoverage = dvfApi.coverage; dvfReason = dvfApi.reason ?? null; dvfSource = dvfApi.source;
  if (dvfApi.coverage === "ok" || dvfApi.coverage === "no_data") { dvfStats = { transactions_count: dvfApi.kpis.n, transactions_count_previous: 0, price_median_eur_m2: dvfApi.kpis.median_price_m2, price_mean_eur_m2: dvfApi.kpis.avg_price_m2, price_q1_eur_m2: dvfApi.kpis.q1_price_m2, price_q3_eur_m2: dvfApi.kpis.q3_price_m2, evolution_pct: null, volume_total_eur: null, surface_mean_m2: null }; comps = dvfApi.comps; }
  if ((dvfApi.coverage === "not_covered" || dvfApi.coverage === "error" || dvfApi.coverage === "no_data") && dvfApi.kpis.n === 0) { const r = await fetchDvfMarketStatsRpc(point, radius_km, horizon_months, dvfTypeLocal); if (r.stats && r.stats.transactions_count > 0) { dvfStats = r.stats; comps = r.comps; dvfCoverage = "ok"; dvfReason = "RPC fallback OK"; dvfSource = "rpc"; } else if (r.error) { dvfCoverage = dvfApi.coverage === "no_data" ? "no_data" : "error"; dvfReason = r.error; } }
  const indices = computeMarketIndices(dvfStats, transportResult.score, transportResult.applicable, bpeResult.scoreCommodites, targets, bpeResult.coverage);
  const verdict = generateVerdict(indices.global_score, dvfStats, dvfCoverage, project_nature, transportResult.applicable);
  let santeScore: number | null = null;
  if (healthSummary?.desert_medical_score != null) santeScore = Math.round(100 - (healthSummary.desert_medical_score ?? 0));
  else if (healthSummary?.densite_medecins_10000 != null) santeScore = computeIndex(healthSummary.densite_medecins_10000, 0, 15, false);
  const smartscoreV4Block = await computeSmartScoreV4Block({ essentialServices, servicesRuraux, isRural, dvfStats, communeInsee: communeInseeFinal, inseeData: inseeResult.data, transportScore: transportResult.score, transportApplicable: transportResult.applicable, commoditesScore: bpeResult.scoreCommodites, ecolesScore: ecolesResult.data?.scoreEcoles ?? null, santeScore, healthSummary, projectNature: project_nature, horizonMonths: horizon_months, lat: point.lat, lon: point.lon, prix_m2_bien: targets?.unit_price_m2 ?? null, dpe_label: dpe_label ?? null, surface_m2_bien: point.surface_m2 ?? null, prix_bien: null, monthly_rent_target: targets?.monthly_rent ?? null, nightly_rate_target: targets?.nightly_rate ?? null, debug });
  const insights = generateInsights(dvfStats, dvfCoverage, transportResult.score, transportResult.applicable, bpeResult.scoreCommodites, ecolesResult.data?.scoreEcoles ?? null, radius_km, bpeResult.coverage, healthSummary, bpeResult.details, servicesRuraux, isRural, essentialServices);
  const kpis: MarketKpi[] = [];
  kpis.push({ label: "Score global", value: indices.global_score, unit: "/100", description: verdict });
  if (dvfStats?.transactions_count != null && dvfStats.transactions_count > 0) kpis.push({ label: "Transactions (DVF)", value: dvfStats.transactions_count, description: "Dans un rayon de " + String(radius_km) + " km" });
  if (dvfStats?.price_median_eur_m2 != null) kpis.push({ label: "Prix median", value: dvfStats.price_median_eur_m2, unit: "EUR/m2" });
  if (transportResult.applicable && transportResult.score != null) kpis.push({ label: "Transport", value: transportResult.score, unit: "/100", description: transportResult.label ?? undefined });
  kpis.push({ label: "Ecoles", value: ecolesResult.data?.scoreEcoles ?? null, unit: "/100", description: ecolesResult.coverage === "ok" ? String(ecolesResult.data?.count1000m ?? 0) + " etablissements a 1km" : "Ecoles: " + coverageLabel(ecolesResult.coverage) });
  const rayonKm = servicesRuraux ? metersToKm(servicesRuraux.rayon_recherche_m) : (isRural ? metersToKm(RAYON_RURAL_MAX_M) : metersToKm(RAYON_URBAIN_M));
  if (servicesRuraux?.pharmacie_proche) kpis.push({ label: "Pharmacie", value: servicesRuraux.pharmacie_proche.distance_km, unit: "km", description: servicesRuraux.pharmacie_proche.nom + (servicesRuraux.pharmacie_proche.commune ? " (" + servicesRuraux.pharmacie_proche.commune + ")" : "") }); else kpis.push({ label: "Pharmacie", value: null, unit: "km", description: "Aucune dans " + String(rayonKm) + " km" });
  const commerceAlimentaire = servicesRuraux?.supermarche_proche || servicesRuraux?.hypermarche_proche || servicesRuraux?.superette_proche;
  if (commerceAlimentaire) kpis.push({ label: "Commerce alimentaire", value: commerceAlimentaire.distance_km, unit: "km", description: commerceAlimentaire.type + ": " + commerceAlimentaire.nom + (commerceAlimentaire.commune ? " (" + commerceAlimentaire.commune + ")" : "") }); else kpis.push({ label: "Commerce alimentaire", value: null, unit: "km", description: "Aucun dans " + String(rayonKm) + " km" });
  if (servicesRuraux?.medecin_proche) { const m = servicesRuraux.medecin_proche; kpis.push({ label: "Medecin generaliste", value: m.distance_km ?? metersToKm(m.distance_m), unit: "km", description: m.nom + (m.commune ? " (" + m.commune + ")" : "") }); } else kpis.push({ label: "Medecin generaliste", value: null, unit: "km", description: "Aucun dans " + String(rayonKm) + " km" });
  if (servicesRuraux?.poste_proche) kpis.push({ label: "Poste", value: servicesRuraux.poste_proche.distance_km, unit: "km", description: servicesRuraux.poste_proche.type + ": " + servicesRuraux.poste_proche.nom + (servicesRuraux.poste_proche.commune ? " (" + servicesRuraux.poste_proche.commune + ")" : "") }); else kpis.push({ label: "Poste", value: null, unit: "km", description: "Aucun dans " + String(rayonKm) + " km" });
  if (servicesRuraux?.banque_proche) kpis.push({ label: "Banque/DAB", value: servicesRuraux.banque_proche.distance_km, unit: "km", description: servicesRuraux.banque_proche.type + ": " + servicesRuraux.banque_proche.nom + (servicesRuraux.banque_proche.commune ? " (" + servicesRuraux.banque_proche.commune + ")" : "") }); else kpis.push({ label: "Banque/DAB", value: null, unit: "km", description: "Aucun dans " + String(rayonKm) + " km" });
  if (servicesRuraux?.station_service_proche) kpis.push({ label: "Station service", value: servicesRuraux.station_service_proche.distance_km, unit: "km", description: servicesRuraux.station_service_proche.nom + (servicesRuraux.station_service_proche.commune ? " (" + servicesRuraux.station_service_proche.commune + ")" : "") }); else if (isRural) kpis.push({ label: "Station service", value: null, unit: "km", description: "Aucune dans " + String(rayonKm) + " km" });
  if (!isRural) kpis.push({ label: "Commodites (BPE)", value: bpeResult.coverage === "ok" ? bpeResult.scoreCommodites : null, unit: "/100", description: bpeResult.coverage === "ok" ? "Score commerces/services/sante" : "BPE: " + coverageLabel(bpeResult.coverage) });
  kpis.push({ label: "Population", value: inseeResult.data?.population ?? null, description: "Population communale (INSEE)" });
  if (inseeResult.data?.revenu_median) kpis.push({ label: "Revenu median", value: inseeResult.data.revenu_median, unit: "EUR/an", description: "Revenu median des menages (INSEE)" });
  if (inseeResult.data?.pct_plus_65 != null) kpis.push({ label: "65 ans et plus", value: Math.round(inseeResult.data.pct_plus_65 * 10) / 10, unit: "%", description: "Part de la population âgée de 65 ans et plus (INSEE)" });
  if (inseeResult.data?.taux_chomage != null) kpis.push({ label: "Taux de chomage", value: inseeResult.data.taux_chomage, unit: "%", description: "Part des actifs au chomage (INSEE)" });
  if (inseeResult.data?.pct_proprietaires != null) kpis.push({ label: "Proprietaires", value: inseeResult.data.pct_proprietaires, unit: "%", description: "Part des residences principales en propriete" });
  if (inseeResult.data?.taux_pauvrete != null) kpis.push({ label: "Taux de pauvrete", value: inseeResult.data.taux_pauvrete, unit: "%", description: "Part de la population sous le seuil de pauvrete" });
  if (inseeResult.data?.pension_retraite_moyenne != null) kpis.push({ label: "Retraite moyenne", value: inseeResult.data.pension_retraite_moyenne, unit: "EUR/mois", description: "Pension moyenne des retraités (INSEE)" });
  if (healthSummary?.professionnels_details) {
    const prof = healthSummary.professionnels_details;
    const totalProf = prof.medecins_generalistes + prof.medecins_specialistes + prof.dentistes + prof.infirmiers + prof.pharmacies + prof.kinesitherapeutes;
    const profDescParts = [prof.medecins_generalistes > 0 ? String(prof.medecins_generalistes) + " generaliste(s)" : null, prof.medecins_specialistes > 0 ? String(prof.medecins_specialistes) + " specialiste(s)" : null, prof.infirmiers > 0 ? String(prof.infirmiers) + " infirmier(s)" : null, prof.dentistes > 0 ? String(prof.dentistes) + " dentiste(s)" : null, prof.pharmacies > 0 ? String(prof.pharmacies) + " pharmacie(s)" : null, prof.kinesitherapeutes > 0 ? String(prof.kinesitherapeutes) + " kine(s)" : null].filter(Boolean).join(", ");
    kpis.push({ label: "Professionnels de sante (commune)", value: totalProf > 0 ? totalProf : 0, description: profDescParts || "Aucun sur la commune" });
  }
  if (healthSummary?.hopital_proche) kpis.push({ label: "Hopital le plus proche", value: healthSummary.hopital_proche.distance_km, unit: "km", description: healthSummary.hopital_proche.nom + " (" + healthSummary.hopital_proche.commune + ")" });
  const totalEtablissementsSeniors = (ehpad.coverage === "ok" ? ehpad.count : 0) + residencesSeniors.length;
  kpis.push({ label: "Etablissements seniors", value: totalEtablissementsSeniors > 0 ? totalEtablissementsSeniors : null, description: isRural ? String(ehpad.count || 0) + " EHPAD + " + String(residencesSeniors.length) + " residences (rayon " + String(ehpadRadius / 1000) + "km)" : "FINESS: " + coverageLabel(ehpad.coverage) });
  const output: any = {
    success: true, version: "v4.7", orchestrator: "smartscore-enriched-v3", mode: "market_study", zone_type: zoneType,
    // v4.6 — Classification officielle + rayons réellement appliqués. Sans ce
    // bloc, le Copilot écrivait « commune rurale » sans savoir d'où ça venait,
    // et rien n'indiquait sur quel périmètre les services avaient été cherchés.
    zone_profile: {
      zone_type: zoneType,
      niveau_3: zone.niveau_3,
      niveau_7: zone.niveau_7,
      libelle_niveau_7: zone.libelle_niveau_7,
      source: zone.source === 'insee' ? 'grille de densite INSEE (millesime 2026)' : 'liste d agglomerations en dur (commune absente de la grille)',
      rayons_m: { bpe: zone.bpeRadius, services_essentiels: zone.essentialServicesRadius, ehpad: zone.ehpadRadius },
      avertissement: "N'ecris « commune rurale » que si zone_type vaut 'rural'. Si libelle_niveau_7 est renseigne, cite cette categorie officielle telle quelle (ex. « Ceintures urbaines »). Une faible densite ou une faible population ne suffisent pas a qualifier une commune de rurale. Precise le rayon de recherche quand tu commentes les equipements ou services.",
    },
    input: { parcel_id: parcel_id ?? null, commune_insee: commune_insee?.toString() ?? null, project_nature, radius_km, horizon_months, targets: targets ?? null, dpe_label: dpe_label ?? null, resolved_point: point, dvf_type_local: dvfTypeLocal },
    smartscore_v4: smartscoreV4Block,
    market: {
      verdict, score: indices.global_score, demand_index: indices.demand_index, supply_index: indices.supply_index, price_index: indices.price_index, accessibility_index: indices.accessibility_index, risk_index: indices.risk_index,
      dvf: { coverage: dvfCoverage, reason: dvfReason, source: dvfSource },
      prices: dvfStats ? { median_eur_m2: dvfStats.price_median_eur_m2, mean_eur_m2: dvfStats.price_mean_eur_m2, q1_eur_m2: dvfStats.price_q1_eur_m2, q3_eur_m2: dvfStats.price_q3_eur_m2 } : null,
      transactions: dvfStats ? { count: dvfStats.transactions_count, count_previous: dvfStats.transactions_count_previous } : null,
      transport: { ...transportResult, applicable: transportResult.applicable, mobility_gtfs: transportResult.mobility ?? null }, // v4.4
      ecoles: ecolesResult.data, bpe: bpeResult.details, bpeCoverage: bpeResult.coverage, commoditesScore: bpeResult.scoreCommodites,
      commerces_proches: bpeResult.details?.commerces_proches ?? [], medecins_proches: bpeResult.details?.medecins_proches ?? [],
      essential_services: essentialServices, services_ruraux: servicesRuraux, residences_seniors: residencesSeniors, healthSummary,
      insee: inseeResult.data,
      ehpad: { coverage: ehpad.coverage, source: ehpad.source, count: ehpad.count, radius_m: ehpad.radius_m, nearest: ehpad.nearest ?? null, reason: ehpad.reason ?? null },
      kpis, insights, comps,
    },
  };
  console.info("[smartscore-enriched-v3] market_study completed", { version: "v4.7", zone_type: zoneType, dvf_source: dvfSource, score_v3: indices.global_score, score_v4: smartscoreV4Block.score });
  return json(output, 200);
}

// ============================================================================
// HANDLER STANDARD
// ============================================================================
async function handleStandard(payload: StandardPayload): Promise<Response> {
  const { address, cp, ville, surface, prix, travaux, userCriteria, meloId, type_local, dep_code, commune_code, parcel_id, commune_insee, transports, radius_km = 2, horizon_months = 24, dpe_label = null, debug = false } = payload;
  if (!supabase) return json({ success: false, error: "INTERNAL_ERROR", mode: "standard", version: "v4.7" }, 500);
  const { set: inc, full: includeFull } = resolveInclude((payload as any).include);
  if (debug) console.log("[Standard] include:", inc, "full:", includeFull);
  const { point, error: pointError } = await resolveStandardPoint(payload);
  if (!point) return json({ success: false, error: pointError ?? "Impossible de resoudre le point d'analyse.", mode: "standard", version: "v4.7" }, 400);
  const communeInseeFinal = point.commune_insee ?? commune_insee?.toString() ?? commune_code ?? null;
  // v4.6 : profil de zone lu dans la grille de densité INSEE (cf. resolveZoneProfile).
  const zone = await resolveZoneProfile(communeInseeFinal);
  const isRural = zone.isRural;
  const zoneType = zone.zoneType;
  console.log(`[Standard] Zone: ${zoneType.toUpperCase()} · niveau_7=${zone.niveau_7 ?? 'n.c.'} (${zone.libelle_niveau_7 ?? 'repli liste en dur'}) · source=${zone.source} · rayons bpe=${zone.bpeRadius}m essentiels=${zone.essentialServicesRadius}m`);
  const bpeRadius = zone.bpeRadius;
  const essentialServicesRadius = zone.essentialServicesRadius;
  const [transportResult, bpeResult, ecolesResult, inseeResult, _essRawStd] = await Promise.all([
    inc.transport
      ? fetchTransportScore(point.lat, point.lon, communeInseeFinal, zone)
      : Promise.resolve({ score: null, label: null, summary: null, coverage: "not_covered" as Coverage, applicable: false, mobility: undefined }),
    inc.bpe
      ? fetchBpeStats(point.lat, point.lon, bpeRadius, communeInseeFinal, debug)
      : Promise.resolve({ scoreCommodites: null, details: null, coverage: "not_covered" as Coverage, totalEquipements: 0 }),
    inc.ecoles
      ? fetchEcolesStats(point.lat, point.lon)
      : Promise.resolve({ data: null, coverage: "not_covered" as Coverage }),
    inc.insee
      ? fetchInseeStatsHybrid(communeInseeFinal, debug)
      : Promise.resolve({ data: null, coverage: "not_covered" as Coverage }),
    (inc.bpe || inc.sante)
      ? fetchEssentialServicesRaw(point.lat, point.lon, essentialServicesRadius, debug)
      : Promise.resolve({ items: [], type_codes_sent: [] }),
  ]);
  let essentialServicesRawResult = _essRawStd;
  if (essentialServicesRawResult.items.length === 0 && supabase) {
    console.log("[Standard] Essential services: fallback vers RPC");
    const rpcItems = await fetchEssentialServicesViaRpc(point.lat, point.lon, essentialServicesRadius, debug);
    if (rpcItems.length > 0) essentialServicesRawResult = { items: rpcItems, type_codes_sent: essentialServicesRawResult.type_codes_sent };
  }
  const essentialServices = buildEssentialServicesBlock(essentialServicesRawResult.items, essentialServicesRadius, isRural, debug);
  let servicesRuraux: ServicesRuraux | null = buildServicesRurauxFromEssentialServices(essentialServices);
  let servicesProximiteDebug: any = null; let residencesSeniors: ResidenceSenior[] = [];
  if (inc.bpe || inc.sante) {
    console.log("[Standard] services_ruraux construit depuis essential_services");
    try {
      const sp = await (servicesProximiteV1 as any)({ supabase: supabase!, lat: point.lat, lon: point.lon, zone_type: zoneType });
      if (debug) servicesProximiteDebug = (sp as any)?.debug;
      const spServices = buildServicesRurauxFromProvider(sp);
      if (!servicesRuraux.pharmacie_proche && spServices.pharmacie_proche) servicesRuraux.pharmacie_proche = spServices.pharmacie_proche;
      if (!servicesRuraux.supermarche_proche && spServices.supermarche_proche) servicesRuraux.supermarche_proche = spServices.supermarche_proche;
      if (!servicesRuraux.hypermarche_proche && spServices.hypermarche_proche) servicesRuraux.hypermarche_proche = spServices.hypermarche_proche;
      if (!servicesRuraux.superette_proche && spServices.superette_proche) servicesRuraux.superette_proche = spServices.superette_proche;
      if (!servicesRuraux.station_service_proche && spServices.station_service_proche) servicesRuraux.station_service_proche = spServices.station_service_proche;
      if (!servicesRuraux.poste_proche && spServices.poste_proche) servicesRuraux.poste_proche = spServices.poste_proche;
      if (!servicesRuraux.banque_proche && spServices.banque_proche) servicesRuraux.banque_proche = spServices.banque_proche;
      if (!servicesRuraux.commissariat_proche && spServices.commissariat_proche) servicesRuraux.commissariat_proche = spServices.commissariat_proche;
      if (!servicesRuraux.gendarmerie_proche && spServices.gendarmerie_proche) servicesRuraux.gendarmerie_proche = spServices.gendarmerie_proche;
      if (!servicesRuraux.medecin_proche && spServices.medecin_proche) servicesRuraux.medecin_proche = spServices.medecin_proche;
    } catch (e) { console.warn("[Standard] servicesProximiteV1 error (non-blocking):"); }
    if (!servicesRuraux.pharmacie_proche) {
      const osmPharmacy = await fetchNearestPharmacyOverpass(point.lat, point.lon, RAYON_RURAL_MAX_M, debug);
      if (osmPharmacy) servicesRuraux.pharmacie_proche = osmPharmacy;
    }
    if (isRural) residencesSeniors = await fetchResidencesSeniors(point.lat, point.lon, 20, debug);
  } else {
    // Sources demandées sans services de proximité : on neutralise pour ne pas renvoyer un bloc trompeur
    servicesRuraux = null;
  }
  let healthResult: { data: HealthFicheEnriched | null; coverage: Coverage } = { data: null, coverage: "not_covered" };
  if (communeInseeFinal) { const rawHealth = await fetchHealthFicheForCommune(communeInseeFinal); const enrichedHealth = await enrichHealthData(point.lat, point.lon, rawHealth.data, bpeResult.details?.sante_details ?? null, bpeResult.details?.medecins_proches ?? undefined); healthResult = { data: enrichedHealth, coverage: rawHealth.coverage }; }
  const dvfTypeLocal = normalizeStandardTypeLocal(type_local);
  let dvfCoverage: Coverage = "not_covered", dvfReason: string | null = null, dvfStats: DvfMarketStats | null = null, comps: MarketComp[] = [], dvfSource = "csv";
  if (inc.dvf) {
    const dvfApi = await dvfMarketKpis({ lat: point.lat, lon: point.lon, radius_m: Math.round(radius_km * 1000), horizon_months, type_local: dvfTypeLocal, commune_insee: communeInseeFinal, ttl_seconds: 86400, debug });
    dvfCoverage = dvfApi.coverage; dvfReason = dvfApi.reason ?? null; dvfSource = dvfApi.source;
    if (dvfApi.coverage === "ok" || dvfApi.coverage === "no_data") { dvfStats = { transactions_count: dvfApi.kpis.n, transactions_count_previous: 0, price_median_eur_m2: dvfApi.kpis.median_price_m2, price_mean_eur_m2: dvfApi.kpis.avg_price_m2, price_q1_eur_m2: dvfApi.kpis.q1_price_m2, price_q3_eur_m2: dvfApi.kpis.q3_price_m2, evolution_pct: null, volume_total_eur: null, surface_mean_m2: null }; comps = dvfApi.comps; }
    if ((dvfApi.coverage === "not_covered" || dvfApi.coverage === "error" || dvfApi.coverage === "no_data") && dvfApi.kpis.n === 0) { const r = await fetchDvfMarketStatsRpc(point, radius_km, horizon_months, dvfTypeLocal); if (r.stats && r.stats.transactions_count > 0) { dvfStats = r.stats; comps = r.comps; dvfCoverage = "ok"; dvfReason = "RPC fallback OK"; dvfSource = "rpc"; } else if (r.error) { dvfCoverage = dvfApi.coverage === "no_data" ? "no_data" : "error"; dvfReason = r.error; } }
  }
  // v4.6 : rayon gradué sur le niveau INSEE (cf. RAYONS_PAR_NIVEAU_7).
  const ehpadRadius = zone.ehpadRadius;
  const ehpad = inc.sante
    ? await finessEhpadNearby(supabase, { lat: point.lat, lon: point.lon, radius_m: ehpadRadius, ttl_seconds: 86400, debug })
    : { coverage: "not_covered" as Coverage, source: "skipped", count: 0, radius_m: ehpadRadius, nearest: null, reason: "non demandé" };
  let marcheScore: number | null = null; if (dvfCoverage === "ok" && dvfStats) marcheScore = computeIndex(dvfStats.transactions_count, 0, 100, false);
  let santeScore: number | null = null;
  if (healthResult.data?.desert_medical_score != null) santeScore = Math.round(100 - (healthResult.data.desert_medical_score ?? 0));
  else if (healthResult.data?.densite_medecins_10000 != null) santeScore = computeIndex(healthResult.data.densite_medecins_10000, 0, 15, false);
  const components: SmartScoreComponents = { transport_score: transportResult.applicable ? transportResult.score : null, ecoles_score: ecolesResult.data?.scoreEcoles ?? null, commodites_score: bpeResult.coverage === "ok" ? bpeResult.scoreCommodites : null, marche_score: marcheScore, sante_score: santeScore };
  const smartScore = computeStandardSmartScore(components, transportResult.applicable);
  const effectiveSurface = surface ?? point.surface_m2 ?? null;
  const smartscoreV4Block = await computeSmartScoreV4Block({ essentialServices, servicesRuraux, isRural, dvfStats, communeInsee: communeInseeFinal, inseeData: inseeResult.data, transportScore: transportResult.score, transportApplicable: transportResult.applicable, commoditesScore: bpeResult.scoreCommodites, ecolesScore: ecolesResult.data?.scoreEcoles ?? null, santeScore, healthSummary: healthResult.data, projectNature: type_local ?? "logement", horizonMonths: horizon_months, lat: point.lat, lon: point.lon, prix_m2_bien: (prix && effectiveSurface && effectiveSurface > 0) ? Math.round(prix / effectiveSurface) : null, dpe_label: dpe_label ?? null, surface_m2_bien: effectiveSurface ?? null, prix_bien: prix ?? null, monthly_rent_target: null, nightly_rate_target: null, debug });
  const coverage: CoverageMap = { dvf: dvfCoverage, transport: transportResult.coverage, ecoles: ecolesResult.coverage, bpe: bpeResult.coverage, sante: healthResult.coverage, insee: inseeResult.coverage, ehpad: ehpad.coverage };
  const verdictStd = generateStandardVerdict(smartScore, coverage, transportResult.applicable);
  const fullOutput: any = {
    success: true, version: "v4.7", orchestrator: "smartscore-enriched-v3", mode: "standard", zone_type: zoneType,
    input: { address: address ?? null, cp: cp ?? null, ville: ville ?? null, surface: surface ?? null, prix: prix ?? null, travaux: travaux ?? null, type_local: type_local ?? null, dep_code: dep_code ?? null, commune_code: commune_code ?? null, parcel_id: parcel_id ?? null, commune_insee: commune_insee?.toString() ?? commune_code ?? null, meloId: meloId ?? null, radius_km, horizon_months, transports_provided: transports != null, userCriteria: userCriteria ?? null, dpe_label: dpe_label ?? null },
    resolved_point: point,
    smartscore: { score: smartScore, verdict: verdictStd, components: { transport: components.transport_score, ecoles: components.ecoles_score, commodites: components.commodites_score, marche: components.marche_score, sante: components.sante_score }, coverage, transport_applicable: transportResult.applicable },
    smartscore_v4: smartscoreV4Block,
    market_like: {
      dvf: { coverage: dvfCoverage, reason: dvfReason, source: dvfSource, kpis: dvfStats ? { transactions_count: dvfStats.transactions_count, price_median_eur_m2: dvfStats.price_median_eur_m2, price_mean_eur_m2: dvfStats.price_mean_eur_m2, price_q1_eur_m2: dvfStats.price_q1_eur_m2, price_q3_eur_m2: dvfStats.price_q3_eur_m2 } : null, comps },
      transport: { coverage: transportResult.coverage, score: transportResult.score, label: transportResult.label, summary: transportResult.summary, applicable: transportResult.applicable, mobility_gtfs: transportResult.mobility ?? null },
      ecoles: { coverage: ecolesResult.coverage, data: ecolesResult.data },
      bpe: { coverage: bpeResult.coverage, scoreCommodites: bpeResult.scoreCommodites, totalEquipements: bpeResult.totalEquipements, details: bpeResult.details, commerces_proches: bpeResult.details?.commerces_proches ?? [], medecins_proches: bpeResult.details?.medecins_proches ?? [] },
      essential_services: essentialServices, services_ruraux: servicesRuraux, residences_seniors: residencesSeniors,
      healthSummary: { coverage: healthResult.coverage, data: healthResult.data },
      insee: { coverage: inseeResult.coverage, data: inseeResult.data },
      ehpad: { coverage: ehpad.coverage, source: ehpad.source, count: ehpad.count, radius_m: ehpad.radius_m, nearest: ehpad.nearest ?? null, reason: ehpad.reason ?? null },
    },
  };

  console.info("[smartscore-enriched-v3] standard completed", { version: "v4.7", zone_type: zoneType, dvf_source: dvfSource, score_v3: smartScore, score_v4: smartscoreV4Block.score, include_full: includeFull });

  if (includeFull) {
    return json(fullOutput, 200);
  }

  const targeted: any = {
    success: true, version: "v4.7", orchestrator: "smartscore-enriched-v3", mode: "standard", zone_type: zoneType,
    resolved_point: point,
    included: ALL_INCLUDE_KEYS.filter((k) => inc[k]),
  };
  if (inc.dvf) { targeted.dvf = fullOutput.market_like.dvf; }
  if (inc.bpe) { targeted.bpe = fullOutput.market_like.bpe; targeted.essential_services = essentialServices; targeted.services_ruraux = servicesRuraux; }
  if (inc.transport) { targeted.transport = fullOutput.market_like.transport; }
  if (inc.ecoles) { targeted.ecoles = fullOutput.market_like.ecoles; }
  if (inc.insee) { targeted.insee = fullOutput.market_like.insee; }
  if (inc.sante) { targeted.sante = fullOutput.market_like.healthSummary; targeted.ehpad = fullOutput.market_like.ehpad; targeted.residences_seniors = residencesSeniors; }
  if (inc.risques) {
    targeted.risks = {
      environment: smartscoreV4Block.environment ?? null,
      dpe: smartscoreV4Block.dpe ?? null,
      energy_renovation: smartscoreV4Block.energy_renovation ?? null,
      energy_business_impact: smartscoreV4Block.energy_business_impact ?? null,
    };
  }
  return json(targeted, 200);
}

// ============================================================================
// HELPER JSON avec CORS
// ============================================================================
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ============================================================================
// MAIN HANDLER
// ============================================================================
serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const contentLength = Number(req.headers.get("content-length") ?? "0");

    if (Number.isFinite(contentLength) && contentLength > MAX_PAYLOAD_BYTES) {
      return json({ success: false, error: "Payload too large" }, 413);
    }

    const rawBody = await req.text();

    if (rawBody.length > MAX_PAYLOAD_BYTES) {
      return json({ success: false, error: "Payload too large" }, 413);
    }

    let payload: any = null;

    try {
      payload = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      payload = null;
    }

    if (!payload) {
      return json({ success: false, error: "Invalid JSON" }, 400);
    }

    if (payload?.debug === true) {
      console.log("[enriched-v3 v4.4] Received request", { mode: payload?.mode ?? null });
    }

    if ((payload as any).mode === "market_study") {
      console.log("[enriched-v3] Mode market_study detected -> routing enrichi v4.4");
      return await handleMarketStudy(payload as MarketStudyPayload);
    }

    console.log("[enriched-v3] Mode standard detected -> routing standard v4.4");
    return await handleStandard(payload as StandardPayload);
  } catch (err) {
    console.error("[enriched-v3 v4.4] Internal error");
    return json({ success: false, error: "Internal error", version: "v4.7" }, 500);
  }
});