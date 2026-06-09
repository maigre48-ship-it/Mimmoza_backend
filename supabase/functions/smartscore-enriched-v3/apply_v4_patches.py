"""
apply_v4_patches.py
====================
Script qui applique automatiquement les 9 patchs SmartScore V4 sur ton index.ts.

Usage:
  python apply_v4_patches.py

Le script lit index.ts dans le même dossier, applique les modifications,
et écrit le résultat dans index_v4.ts.
Tu vérifies le diff puis remplaces.
"""

import re
import sys
from pathlib import Path

# Chemin du fichier
SCRIPT_DIR = Path(__file__).parent
INPUT_FILE = SCRIPT_DIR / "index.ts"
OUTPUT_FILE = SCRIPT_DIR / "index_v4.ts"

def apply_patches(content: str) -> str:
    
    # ═══════════════════════════════════════════════════════════
    # PATCH 1 : Ajouter les imports V4 après les imports existants
    # ═══════════════════════════════════════════════════════════
    
    v4_imports = '''
// V4 imports
import {
  computeEssentialServicesScore,
  computeRuralAccessibilityScore,
  computeSmartScoreV4,
  type EssentialServicesScoreResult,
  type RuralAccessibilityResult,
} from "./smartscore_weights_v4.ts";

import {
  computePriceTrend,
  computeLiquidityScore,
  computeRentalTension,
  computeMarketComposite,
  type PriceTrendResult,
  type LiquidityScoreResult,
  type RentalTensionResult,
} from "./market_intelligence_v4.ts";

import {
  computeGeorisquesScore,
  fetchDpeQuartier,
  fetchAirQuality,
  estimateNoiseScore,
  computeEnvironmentScore,
} from "./environment_score_v4.ts";

import {
  computeDemographicScore,
  type PopulationTrendResult,
} from "./demographic_signal_v4.ts";

import {
  fetchPermisProches,
  computeCompetitionScore,
  type CompetitionScoreResult,
} from "./competition_sitadel_v4.ts";
'''

    # Insérer après la dernière ligne d'import existante
    content = content.replace(
        'import type { Coverage } from "../_shared/providers/types.ts";',
        'import type { Coverage } from "../_shared/providers/types.ts";\n' + v4_imports
    )
    
    # ═══════════════════════════════════════════════════════════
    # PATCH 2 : Version string
    # ═══════════════════════════════════════════════════════════
    
    content = content.replace(
        'console.log("smartscore-enriched-v3 orchestrator loaded (v3.22 INSEE Comparateur API tabulaire)");',
        'console.log("smartscore-enriched-v3 orchestrator loaded (v4.0 SmartScore V4)");'
    )
    
    # ═══════════════════════════════════════════════════════════
    # PATCH 3 : Ajouter raw_transactions au type DvfApiResult
    # ═══════════════════════════════════════════════════════════
    
    content = content.replace(
        '''  comps: MarketComp[];
};

function getDvfCacheKey''',
        '''  comps: MarketComp[];
  raw_transactions?: Array<{ date: string; price_m2: number }>;
};

function getDvfCacheKey'''
    )
    
    # ═══════════════════════════════════════════════════════════
    # PATCH 4 : Exposer raw_transactions dans dvfMarketKpis
    # ═══════════════════════════════════════════════════════════
    
    content = content.replace(
        '''  const result: DvfApiResult = {
    provider: "dvf",
    source: "csv:" + csvSources.join(","),
    coverage: n > 0 ? "ok" : "no_data",
    kpis: { n, median_price_m2, avg_price_m2, q1_price_m2, q3_price_m2 },
    comps,
  };''',
        '''  const raw_transactions = transactions.map(t => ({
    date: t.record.date_mutation ?? "",
    price_m2: t.price_m2,
  }));

  const result: DvfApiResult = {
    provider: "dvf",
    source: "csv:" + csvSources.join(","),
    coverage: n > 0 ? "ok" : "no_data",
    kpis: { n, median_price_m2, avg_price_m2, q1_price_m2, q3_price_m2 },
    comps,
    raw_transactions,
  };'''
    )
    
    # ═══════════════════════════════════════════════════════════
    # PATCH 5 : handleMarketStudy — remplacer le scoring V3 par V4
    # On insère le bloc V4 AVANT computeMarketIndices et on garde
    # l'ancien comme fallback dans indices, mais le score principal
    # vient de smartScoreV4
    # ═══════════════════════════════════════════════════════════
    
    v4_market_study_scoring = '''
  // ══════ SMARTSCORE V4 ══════
  const essServicesResult = computeEssentialServicesScore(essentialServices);

  let ruralAccessResult: RuralAccessibilityResult | null = null;
  if (isRural && servicesRuraux) {
    ruralAccessResult = computeRuralAccessibilityScore(servicesRuraux);
  }

  const priceTrend = computePriceTrend(dvfApi.raw_transactions ?? []);

  const liquidity = computeLiquidityScore(
    dvfStats?.transactions_count ?? 0,
    dvfStats?.transactions_count_previous ?? null,
    dvfStats?.price_median_eur_m2 ?? null,
    dvfStats?.price_q1_eur_m2 ?? null,
    dvfStats?.price_q3_eur_m2 ?? null,
    horizon_months,
    isRural,
  );

  const departement = communeInseeFinal?.slice(0, 2) ?? null;
  const rentalTension = computeRentalTension(
    dvfStats?.price_median_eur_m2 ?? null,
    departement,
    point.surface_m2 ?? null,
    targets?.monthly_rent ? (targets.monthly_rent / (point.surface_m2 ?? 50)) : null,
  );

  const marketComposite = computeMarketComposite({
    dvfTransactionsCount: dvfStats?.transactions_count ?? 0,
    dvfMedianM2: dvfStats?.price_median_eur_m2 ?? null,
    dvfQ1M2: dvfStats?.price_q1_eur_m2 ?? null,
    dvfQ3M2: dvfStats?.price_q3_eur_m2 ?? null,
    dvfPreviousCount: dvfStats?.transactions_count_previous ?? null,
    priceTrend,
    liquidity,
    rentalTension,
    projectNature: project_nature,
    isRural,
    periodMonths: horizon_months,
  });

  const georisquesScore = computeGeorisquesScore([]);
  const dpeResult = await fetchDpeQuartier(point.lat, point.lon, 500, communeInseeFinal ?? undefined, debug);
  const airResult = await fetchAirQuality(communeInseeFinal ?? "", debug);
  const noiseResult = estimateNoiseScore(isRural, inseeResult.data?.population ?? null, inseeResult.data?.densite_pop ?? null);
  const environmentResult = computeEnvironmentScore(georisquesScore, dpeResult, airResult, noiseResult);

  let popTrendResult: PopulationTrendResult | null = null;
  if (supabase && communeInseeFinal) {
    try {
      const { data: trendData } = await supabase.rpc("get_population_trend", { p_commune: communeInseeFinal });
      if (trendData?.found) {
        popTrendResult = computeDemographicScore(
          trendData.population_actuelle, trendData.population_n5, trendData.population_n10,
          inseeResult.data?.pct_plus_65 ?? null, inseeResult.data?.pct_moins_25 ?? null,
          inseeResult.data?.nb_menages ?? null, project_nature,
        );
      }
    } catch (e) { if (debug) console.warn("[Demographie] error:", e); }
  }
  if (!popTrendResult && inseeResult.data) {
    popTrendResult = computeDemographicScore(
      inseeResult.data.population ?? null, null, null,
      inseeResult.data.pct_plus_65 ?? null, inseeResult.data.pct_moins_25 ?? null,
      inseeResult.data.nb_menages ?? null, project_nature,
    );
  }

  let competitionResult: CompetitionScoreResult | null = null;
  if (supabase && communeInseeFinal) {
    try {
      const permis = await fetchPermisProches(point.lat, point.lon, communeInseeFinal, 2000, supabase, debug);
      competitionResult = computeCompetitionScore(permis, project_nature, 2000, isRural);
    } catch (e) { if (debug) console.warn("[Sitadel] error:", e); }
  }

  let santeScore: number | null = null;
  if (healthSummary?.desert_medical_score != null) {
    santeScore = Math.round(100 - (healthSummary.desert_medical_score ?? 0));
  } else if (healthSummary?.densite_medecins_10000 != null) {
    santeScore = computeIndex(healthSummary.densite_medecins_10000, 0, 15, false);
  }

  const smartScoreV4 = computeSmartScoreV4({
    projectNature: project_nature,
    isRural,
    transportScore: transportResult.score,
    transportApplicable: transportResult.applicable,
    commoditesScore: bpeResult.scoreCommodites,
    ecolesScore: ecolesResult.data?.scoreEcoles ?? null,
    marcheScore: marketComposite.score,
    santeScore,
    essentialServicesScore: essServicesResult.score,
    ruralAccessibilityScore: ruralAccessResult?.score ?? null,
    environnementScore: environmentResult.score,
    concurrenceScore: competitionResult?.score ?? null,
    demographieScore: popTrendResult?.score ?? null,
  });

  let benchmark: any = null;
  if (supabase && communeInseeFinal) {
    try {
      const { data: benchData } = await supabase.rpc("get_smartscore_percentile", {
        p_project_nature: project_nature, p_departement: departement,
        p_zone_type: zoneType, p_score: smartScoreV4.score, p_months: 12,
      });
      benchmark = benchData;
    } catch (e) { if (debug) console.warn("[Benchmark] error:", e); }
  }

  if (supabase && communeInseeFinal) {
    supabase.rpc("save_smartscore_history", {
      p_commune_insee: communeInseeFinal,
      p_departement: departement ?? communeInseeFinal.slice(0, 2),
      p_lat: point.lat, p_lon: point.lon,
      p_project_nature: project_nature, p_zone_type: zoneType,
      p_score_global: smartScoreV4.score,
      p_pillar_scores: smartScoreV4.pillarScores,
      p_weights_used: smartScoreV4.activeWeights,
      p_essential_services_score: essServicesResult.score,
      p_rural_accessibility_score: ruralAccessResult?.score ?? null,
      p_dvf_median_m2: dvfStats?.price_median_eur_m2 ?? null,
      p_dvf_transactions_count: dvfStats?.transactions_count ?? null,
      p_population: inseeResult.data?.population ?? null,
    }).then(() => {}).catch(() => {});
  }

  // Indices (compat V3)
'''
    
    content = content.replace(
        '  // Indices\n  const indices = computeMarketIndices(',
        v4_market_study_scoring + '  const indices = computeMarketIndices('
    )
    
    # ═══════════════════════════════════════════════════════════
    # PATCH 6 : handleMarketStudy — remplacer le score global par V4
    # ═══════════════════════════════════════════════════════════
    
    content = content.replace(
        '  kpis.push({ label: "Score global", value: indices.global_score, unit: "/100", description: verdict });',
        '  kpis.push({ label: "Score global", value: smartScoreV4.score, unit: "/100", description: smartScoreV4.verdict });'
    )
    
    # ═══════════════════════════════════════════════════════════
    # PATCH 7 : handleMarketStudy — ajouter smartscore_v4 et market_intelligence dans output
    # ═══════════════════════════════════════════════════════════
    
    v4_output_block = '''    smartscore_v4: {
      score: smartScoreV4.score,
      verdict: smartScoreV4.verdict,
      project_nature: smartScoreV4.projectNature,
      is_rural: smartScoreV4.isRural,
      pillar_scores: smartScoreV4.pillarScores,
      weights: smartScoreV4.weights,
      active_weights: smartScoreV4.activeWeights,
      essential_services_score: { score: essServicesResult.score, coverage_pct: essServicesResult.coverage_pct, missing: essServicesResult.missing, details: essServicesResult.details },
      rural_accessibility: ruralAccessResult ? { score: ruralAccessResult.score, label: ruralAccessResult.label, summary: ruralAccessResult.summary, details: ruralAccessResult.details } : null,
      benchmark,
    },
'''
    
    # Insérer smartscore_v4 dans output du market_study
    content = content.replace(
        '    market: {\n      verdict,\n      score: indices.global_score,',
        v4_output_block + '    market: {\n      verdict: smartScoreV4.verdict,\n      score: smartScoreV4.score,'
    )

    v4_market_intel_output = '''      market_intelligence: {
        price_trend: priceTrend ? { current_estimated_m2: priceTrend.current_estimated_m2, projected_12m_m2: priceTrend.projected_12m_m2, projected_12m_range: priceTrend.projected_12m_range, slope_pct_per_year: priceTrend.slope_pct_per_year, trend_label: priceTrend.trend_label, confidence: priceTrend.confidence, quarterly_prices: priceTrend.quarterly_prices, data_points: priceTrend.data_points_count } : null,
        liquidity: { score: liquidity.score, label: liquidity.label, estimated_days_to_sell: liquidity.metrics.estimated_days_to_sell, transactions_per_year: liquidity.metrics.transactions_per_year },
        rental_tension: { score: rentalTension.score, label: rentalTension.label, rendement_brut_pct: rentalTension.rendement_brut_pct, ratio_prix_loyer: rentalTension.ratio_prix_loyer, loyer_estime_m2_mois: rentalTension.loyer_estime_m2_mois, loyer_source: rentalTension.loyer_source },
        market_composite: { score: marketComposite.score, components: marketComposite.components, weights: marketComposite.weights_used },
      },
      environment: { score: environmentResult.score, label: environmentResult.label, components: environmentResult.components },
      demographie: popTrendResult ? { score: popTrendResult.score, trend_label: popTrendResult.trend_label, trend_annuel_pct: popTrendResult.trend_annuel_pct, interpretation: popTrendResult.interpretation } : null,
      competition: competitionResult ? { score: competitionResult.score, label: competitionResult.label, permis_count: competitionResult.permis_count, logements_en_projet: competitionResult.logements_en_projet, interpretation: competitionResult.interpretation } : null,
'''

    # Insérer market_intelligence après comps dans output.market
    content = content.replace(
        '      comps,\n    },\n  };\n\n  if (debug) {\n    const essentialServicesCounts',
        '      comps,\n' + v4_market_intel_output + '    },\n  };\n\n  if (debug) {\n    const essentialServicesCounts'
    )

    # ═══════════════════════════════════════════════════════════
    # PATCH 8 : handleStandard — ajouter le V4 scoring
    # ═══════════════════════════════════════════════════════════
    
    v4_standard_scoring = '''
  // ══════ SMARTSCORE V4 (Standard) ══════
  const essServicesResult = computeEssentialServicesScore(essentialServices);
  let ruralAccessResult: RuralAccessibilityResult | null = null;
  if (isRural && servicesRuraux) {
    ruralAccessResult = computeRuralAccessibilityScore(servicesRuraux);
  }
  const priceTrend = computePriceTrend(dvfApi.raw_transactions ?? []);
  const departement = communeInseeFinal?.slice(0, 2) ?? null;
  const liquidity = computeLiquidityScore(dvfStats?.transactions_count ?? 0, dvfStats?.transactions_count_previous ?? null, dvfStats?.price_median_eur_m2 ?? null, dvfStats?.price_q1_eur_m2 ?? null, dvfStats?.price_q3_eur_m2 ?? null, horizon_months, isRural);
  const rentalTension = computeRentalTension(dvfStats?.price_median_eur_m2 ?? null, departement, surface ?? null);
  const marketComposite = computeMarketComposite({ dvfTransactionsCount: dvfStats?.transactions_count ?? 0, dvfMedianM2: dvfStats?.price_median_eur_m2 ?? null, dvfQ1M2: dvfStats?.price_q1_eur_m2 ?? null, dvfQ3M2: dvfStats?.price_q3_eur_m2 ?? null, dvfPreviousCount: dvfStats?.transactions_count_previous ?? null, priceTrend, liquidity, rentalTension, projectNature: type_local ?? "logement", isRural, periodMonths: horizon_months });
  const georisquesScore = computeGeorisquesScore([]);
  const dpeResult = await fetchDpeQuartier(point.lat, point.lon, 500, communeInseeFinal ?? undefined, debug);
  const airResult = await fetchAirQuality(communeInseeFinal ?? "", debug);
  const noiseResult = estimateNoiseScore(isRural, inseeResult.data?.population ?? null, inseeResult.data?.densite_pop ?? null);
  const environmentResult = computeEnvironmentScore(georisquesScore, dpeResult, airResult, noiseResult);
  let popTrendResult: PopulationTrendResult | null = null;
  if (inseeResult.data) {
    popTrendResult = computeDemographicScore(inseeResult.data.population ?? null, null, null, inseeResult.data.pct_plus_65 ?? null, inseeResult.data.pct_moins_25 ?? null, inseeResult.data.nb_menages ?? null, type_local ?? "logement");
  }
  let competitionResult: CompetitionScoreResult | null = null;
  if (supabase && communeInseeFinal) {
    try {
      const permis = await fetchPermisProches(point.lat, point.lon, communeInseeFinal, 2000, supabase, debug);
      competitionResult = computeCompetitionScore(permis, type_local ?? "logement", 2000, isRural);
    } catch (e) { if (debug) console.warn("[Standard][Sitadel] error:", e); }
  }
  const smartScoreV4 = computeSmartScoreV4({
    projectNature: type_local ?? "logement", isRural,
    transportScore: transportResult.score, transportApplicable: transportResult.applicable,
    commoditesScore: bpeResult.scoreCommodites, ecolesScore: ecolesResult.data?.scoreEcoles ?? null,
    marcheScore: marketComposite.score, santeScore,
    essentialServicesScore: essServicesResult.score,
    ruralAccessibilityScore: ruralAccessResult?.score ?? null,
    environnementScore: environmentResult.score,
    concurrenceScore: competitionResult?.score ?? null,
    demographieScore: popTrendResult?.score ?? null,
  });
  if (supabase && communeInseeFinal) {
    supabase.rpc("save_smartscore_history", {
      p_commune_insee: communeInseeFinal, p_departement: departement ?? communeInseeFinal.slice(0, 2),
      p_lat: point.lat, p_lon: point.lon, p_project_nature: type_local ?? "standard",
      p_zone_type: zoneType, p_score_global: smartScoreV4.score,
      p_pillar_scores: smartScoreV4.pillarScores, p_weights_used: smartScoreV4.activeWeights,
      p_essential_services_score: essServicesResult.score,
      p_rural_accessibility_score: ruralAccessResult?.score ?? null,
      p_dvf_median_m2: dvfStats?.price_median_eur_m2 ?? null,
      p_dvf_transactions_count: dvfStats?.transactions_count ?? null,
      p_population: inseeResult.data?.population ?? null,
    }).then(() => {}).catch(() => {});
  }

'''

    content = content.replace(
        '  const smartScore = computeStandardSmartScore(components, transportResult.applicable);',
        v4_standard_scoring + '  const smartScore = smartScoreV4.score;'
    )

    # ═══════════════════════════════════════════════════════════
    # PATCH 9 : handleStandard — ajouter smartscore_v4 dans output
    # ═══════════════════════════════════════════════════════════
    
    v4_standard_output = '''    smartscore_v4: {
      score: smartScoreV4.score, verdict: smartScoreV4.verdict,
      project_nature: smartScoreV4.projectNature, is_rural: smartScoreV4.isRural,
      pillar_scores: smartScoreV4.pillarScores,
      weights: smartScoreV4.weights, active_weights: smartScoreV4.activeWeights,
      essential_services_score: { score: essServicesResult.score, coverage_pct: essServicesResult.coverage_pct, missing: essServicesResult.missing },
      rural_accessibility: ruralAccessResult ? { score: ruralAccessResult.score, label: ruralAccessResult.label, summary: ruralAccessResult.summary } : null,
    },
'''
    
    content = content.replace(
        '    market_like: {\n      dvf: {',
        v4_standard_output + '    market_like: {\n      dvf: {'
    )

    v4_standard_market_intel = '''      market_intelligence: {
        price_trend: priceTrend ? { current_estimated_m2: priceTrend.current_estimated_m2, projected_12m_m2: priceTrend.projected_12m_m2, slope_pct_per_year: priceTrend.slope_pct_per_year, trend_label: priceTrend.trend_label, confidence: priceTrend.confidence, quarterly_prices: priceTrend.quarterly_prices } : null,
        liquidity: { score: liquidity.score, label: liquidity.label, estimated_days_to_sell: liquidity.metrics.estimated_days_to_sell },
        rental_tension: { score: rentalTension.score, label: rentalTension.label, rendement_brut_pct: rentalTension.rendement_brut_pct, loyer_estime_m2_mois: rentalTension.loyer_estime_m2_mois },
      },
      environment: { score: environmentResult.score, label: environmentResult.label, components: environmentResult.components },
      demographie: popTrendResult ? { score: popTrendResult.score, trend_label: popTrendResult.trend_label, interpretation: popTrendResult.interpretation } : null,
      competition: competitionResult ? { score: competitionResult.score, label: competitionResult.label, permis_count: competitionResult.permis_count } : null,
'''

    # Insérer dans market_like du standard, avant la fermeture
    content = content.replace(
        '      ehpad: { coverage: ehpad.coverage, source: ehpad.source, count: ehpad.count, radius_m: ehpad.radius_m, nearest: ehpad.nearest ?? null, reason: ehpad.reason ?? null },\n    },\n  };\n\n  if (debug) {\n    const essentialServicesCounts: Record<string, number> = {};\n    for (const bucket of ALL_ESSENTIAL_BUCKETS) {\n      essentialServicesCounts[bucket] = essentialServices[bucket].count;\n    }\n\n    const rawItemsSample = essentialServicesRawResult.items.slice(0, 10)',
        '      ehpad: { coverage: ehpad.coverage, source: ehpad.source, count: ehpad.count, radius_m: ehpad.radius_m, nearest: ehpad.nearest ?? null, reason: ehpad.reason ?? null },\n' + v4_standard_market_intel + '    },\n  };\n\n  if (debug) {\n    const essentialServicesCounts: Record<string, number> = {};\n    for (const bucket of ALL_ESSENTIAL_BUCKETS) {\n      essentialServicesCounts[bucket] = essentialServices[bucket].count;\n    }\n\n    const rawItemsSample = essentialServicesRawResult.items.slice(0, 10)',
        1  # Only replace the SECOND occurrence (standard handler)
    )

    # ═══════════════════════════════════════════════════════════
    # PATCH : Version strings
    # ═══════════════════════════════════════════════════════════
    content = content.replace('version: "v3.23"', 'version: "v4.0"')
    content = content.replace('[enriched-v3 v3.23]', '[enriched-v3 v4.0]')
    content = content.replace('[Market Study v3.23]', '[Market Study v4.0]')
    content = content.replace('[Standard v3.23]', '[Standard v4.0]')

    # Log final
    content = content.replace(
        'console.log("[market_study] response ready, score:", indices.global_score,',
        'console.log("[market_study v4] response ready, score:", smartScoreV4.score,'
    )
    content = content.replace(
        'console.log("[Standard] response ready, smartscore:", smartScore,',
        'console.log("[Standard v4] response ready, score:", smartScoreV4.score,'
    )

    return content


def main():
    if not INPUT_FILE.exists():
        print(f"ERREUR: {INPUT_FILE} introuvable.")
        print(f"Place ce script dans supabase/functions/smartscore-enriched-v3/")
        sys.exit(1)

    print(f"Lecture de {INPUT_FILE}...")
    content = INPUT_FILE.read_text(encoding="utf-8")
    original_lines = content.count('\n')
    
    print(f"Fichier original: {original_lines} lignes")
    print("Application des patchs V4...")
    
    patched = apply_patches(content)
    patched_lines = patched.count('\n')
    
    OUTPUT_FILE.write_text(patched, encoding="utf-8")
    
    print(f"Fichier patché: {patched_lines} lignes (+{patched_lines - original_lines})")
    print(f"Écrit dans {OUTPUT_FILE}")
    print()
    print("Vérification recommandée:")
    print(f"  diff {INPUT_FILE.name} {OUTPUT_FILE.name}")
    print()
    print("Pour appliquer:")
    print(f"  cp {OUTPUT_FILE.name} {INPUT_FILE.name}")


if __name__ == "__main__":
    main()