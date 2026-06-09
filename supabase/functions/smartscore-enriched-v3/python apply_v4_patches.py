"""
apply_v4_patches.py — Version pour index.ts v3.27
===================================================
Applique les modifications SmartScore V4 sur la version v3.27 réelle.

Usage:
  cd supabase/functions/smartscore-enriched-v3
  python apply_v4_patches.py

Lit index.ts, écrit index_v4.ts. Vérifier puis remplacer.
"""

import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
INPUT_FILE = SCRIPT_DIR / "index.ts"
OUTPUT_FILE = SCRIPT_DIR / "index_v4.ts"


def apply_patches(content: str) -> str:

    patches_applied = []

    # ═══════════════════════════════════════════════════════════
    # PATCH 1: Imports V4
    # ═══════════════════════════════════════════════════════════
    ANCHOR_IMPORT = 'import type { Coverage } from "../_shared/providers/types.ts";'

    V4_IMPORTS = '''
// ══════ SmartScore V4 imports ══════
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

    if ANCHOR_IMPORT in content:
        content = content.replace(ANCHOR_IMPORT, ANCHOR_IMPORT + "\n" + V4_IMPORTS)
        patches_applied.append("PATCH 1: V4 imports")
    else:
        print("  PATCH 1 ECHOUE: anchor import Coverage non trouve")

    # ═══════════════════════════════════════════════════════════
    # PATCH 2: Version string
    # ═══════════════════════════════════════════════════════════
    if 'orchestrator loaded (v3.27' in content:
        content = content.replace('orchestrator loaded (v3.27', 'orchestrator loaded (v4.0')
        patches_applied.append("PATCH 2: version string")
    else:
        print("  PATCH 2 ECHOUE: version string non trouve")

    # ═══════════════════════════════════════════════════════════
    # PATCH 3: handleMarketStudy — V4 scoring
    # ═══════════════════════════════════════════════════════════
    ANCHOR_MARKET = '  const demande: MarketStudyDemand = {'

    V4_MARKET_SCORING = '''  // ══════ SMARTSCORE V4 (Market Study) ══════
  const v4ProjectNature = (payload.project_nature as string) ?? "logement";
  const v4Departement = communeInfo.departement ?? (communeInfo.code_insee ? communeInfo.code_insee.slice(0, 2) : null);

  const essServicesResult = computeEssentialServicesScore({} as any);
  const priceTrend = computePriceTrend([]);
  const liquidity = computeLiquidityScore(
    dvf?.nb_transactions ?? 0, null,
    dvf?.prix_m2_median ?? null, null, null,
    config.dvf.horizon_months, isRural,
  );
  const rentalTension = computeRentalTension(
    dvf?.prix_m2_median ?? null, v4Departement, null,
  );
  const marketComposite = computeMarketComposite({
    dvfTransactionsCount: dvf?.nb_transactions ?? 0,
    dvfMedianM2: dvf?.prix_m2_median ?? null,
    dvfQ1M2: null, dvfQ3M2: null, dvfPreviousCount: null,
    priceTrend, liquidity, rentalTension,
    projectNature: v4ProjectNature, isRural,
    periodMonths: config.dvf.horizon_months,
  });
  const georisquesScore = computeGeorisquesScore([]);
  const dpeResult = await fetchDpeQuartier(lat, lon, 500, communeInfo.code_insee ?? undefined, false);
  const airResult = await fetchAirQuality(communeInfo.code_insee ?? "", false);
  const noiseResult = estimateNoiseScore(isRural, insee?.population ?? null, insee?.densite ?? null);
  const environmentResult = computeEnvironmentScore(georisquesScore, dpeResult, airResult, noiseResult);
  let popTrendResult: PopulationTrendResult | null = null;
  if (insee) {
    popTrendResult = computeDemographicScore(
      insee.population ?? null, null, null, null, null, null, v4ProjectNature,
    );
  }
  let competitionResult: CompetitionScoreResult | null = null;
  if (supabase && communeInfo.code_insee) {
    try {
      const permis = await fetchPermisProches(lat, lon, communeInfo.code_insee, 2000, supabase, false);
      competitionResult = computeCompetitionScore(permis, v4ProjectNature, 2000, isRural);
    } catch (e) { console.warn("[V4 Sitadel] error:", e); }
  }
  const smartScoreV4 = computeSmartScoreV4({
    projectNature: v4ProjectNature, isRural,
    transportScore: transport?.score ?? null,
    transportApplicable: transport ? transport.coverage === "ok" : false,
    commoditesScore: bpe?.score ?? null,
    ecolesScore: null,
    marcheScore: marketComposite.score,
    santeScore: sante?.score ?? null,
    essentialServicesScore: essServicesResult.score,
    ruralAccessibilityScore: null,
    environnementScore: environmentResult.score,
    concurrenceScore: competitionResult?.score ?? null,
    demographieScore: popTrendResult?.score ?? null,
  });
  if (supabase && communeInfo.code_insee) {
    supabase.rpc("save_smartscore_history", {
      p_commune_insee: communeInfo.code_insee,
      p_departement: v4Departement ?? communeInfo.code_insee.slice(0, 2),
      p_lat: lat, p_lon: lon,
      p_project_nature: v4ProjectNature,
      p_zone_type: isRural ? "rural" : "urbain",
      p_score_global: smartScoreV4.score,
      p_pillar_scores: smartScoreV4.pillarScores,
      p_weights_used: smartScoreV4.activeWeights,
      p_essential_services_score: essServicesResult.score,
      p_rural_accessibility_score: null,
      p_dvf_median_m2: dvf?.prix_m2_median ?? null,
      p_dvf_transactions_count: dvf?.nb_transactions ?? null,
      p_population: insee?.population ?? null,
    }).then(() => {}).catch(() => {});
  }

'''

    if ANCHOR_MARKET in content:
        content = content.replace(ANCHOR_MARKET, V4_MARKET_SCORING + ANCHOR_MARKET)
        patches_applied.append("PATCH 3: V4 scoring in handleMarketStudy")
    else:
        print("  PATCH 3 ECHOUE: anchor MarketStudyDemand non trouve")

    # ═══════════════════════════════════════════════════════════
    # PATCH 4: handleMarketStudy — smartscore_v4 dans le return
    # ═══════════════════════════════════════════════════════════
    ANCHOR_MKT_DEBUG = '    debug: {\n      envDebug: envDebugInfo,'

    V4_MARKET_OUTPUT = '''    smartscore_v4: {
      score: smartScoreV4.score, verdict: smartScoreV4.verdict,
      project_nature: smartScoreV4.projectNature, is_rural: smartScoreV4.isRural,
      pillar_scores: smartScoreV4.pillarScores, weights: smartScoreV4.weights, active_weights: smartScoreV4.activeWeights,
      essential_services_score: { score: essServicesResult.score, coverage_pct: essServicesResult.coverage_pct, missing: essServicesResult.missing },
      environment: { score: environmentResult.score, label: environmentResult.label, components: environmentResult.components },
      demographie: popTrendResult ? { score: popTrendResult.score, trend_label: popTrendResult.trend_label, interpretation: popTrendResult.interpretation } : null,
      competition: competitionResult ? { score: competitionResult.score, label: competitionResult.label, permis_count: competitionResult.permis_count } : null,
      market_intelligence: {
        price_trend: priceTrend ? { current_estimated_m2: priceTrend.current_estimated_m2, projected_12m_m2: priceTrend.projected_12m_m2, slope_pct_per_year: priceTrend.slope_pct_per_year, trend_label: priceTrend.trend_label, confidence: priceTrend.confidence } : null,
        liquidity: { score: liquidity.score, label: liquidity.label, estimated_days_to_sell: liquidity.metrics.estimated_days_to_sell },
        rental_tension: { score: rentalTension.score, label: rentalTension.label, rendement_brut_pct: rentalTension.rendement_brut_pct, loyer_estime_m2_mois: rentalTension.loyer_estime_m2_mois },
      },
    },
'''

    if ANCHOR_MKT_DEBUG in content:
        content = content.replace(ANCHOR_MKT_DEBUG, V4_MARKET_OUTPUT + ANCHOR_MKT_DEBUG, 1)
        patches_applied.append("PATCH 4: V4 output in handleMarketStudy")
    else:
        print("  PATCH 4 ECHOUE: anchor debug envDebug non trouve")

    # ═══════════════════════════════════════════════════════════
    # PATCH 5: handleStandard — V4 scoring après computeGlobalScore
    # ═══════════════════════════════════════════════════════════
    ANCHOR_STANDARD = '  const { global: globalScore, details: scoreDetails } = computeGlobalScore(dvf, transport, bpe, ecoles, sante, insee, weights);'

    V4_STANDARD_SCORING = '''

  // ══════ SMARTSCORE V4 (Standard) ══════
  const v4ProjectNature = (payload.project_nature as string) ?? "logement";
  const v4Departement = communeInfo.departement ?? (communeInfo.code_insee ? communeInfo.code_insee.slice(0, 2) : null);
  const essServicesResult = computeEssentialServicesScore({} as any);
  const priceTrend = computePriceTrend([]);
  const liquidity = computeLiquidityScore(dvf?.nb_transactions ?? 0, null, dvf?.prix_m2_median ?? null, null, null, config.dvf.horizon_months, isRural);
  const rentalTension = computeRentalTension(dvf?.prix_m2_median ?? null, v4Departement, null);
  const marketComposite = computeMarketComposite({ dvfTransactionsCount: dvf?.nb_transactions ?? 0, dvfMedianM2: dvf?.prix_m2_median ?? null, dvfQ1M2: null, dvfQ3M2: null, dvfPreviousCount: null, priceTrend, liquidity, rentalTension, projectNature: v4ProjectNature, isRural, periodMonths: config.dvf.horizon_months });
  const georisquesScore = computeGeorisquesScore([]);
  const dpeResult = await fetchDpeQuartier(lat, lon, 500, communeInfo.code_insee ?? undefined, false);
  const airResult = await fetchAirQuality(communeInfo.code_insee ?? "", false);
  const noiseResult = estimateNoiseScore(isRural, insee?.population ?? null, insee?.densite ?? null);
  const environmentResult = computeEnvironmentScore(georisquesScore, dpeResult, airResult, noiseResult);
  let popTrendResult: PopulationTrendResult | null = null;
  if (insee) { popTrendResult = computeDemographicScore(insee.population ?? null, null, null, null, null, null, v4ProjectNature); }
  let competitionResult: CompetitionScoreResult | null = null;
  if (supabase && communeInfo.code_insee) { try { const permis = await fetchPermisProches(lat, lon, communeInfo.code_insee, 2000, supabase, false); competitionResult = computeCompetitionScore(permis, v4ProjectNature, 2000, isRural); } catch (e) { console.warn("[V4 Sitadel Standard] error:", e); } }
  const smartScoreV4 = computeSmartScoreV4({ projectNature: v4ProjectNature, isRural, transportScore: transport?.score ?? null, transportApplicable: transport ? transport.coverage === "ok" : false, commoditesScore: bpe?.score ?? null, ecolesScore: ecoles?.score ?? null, marcheScore: marketComposite.score, santeScore: sante?.score ?? null, essentialServicesScore: essServicesResult.score, ruralAccessibilityScore: null, environnementScore: environmentResult.score, concurrenceScore: competitionResult?.score ?? null, demographieScore: popTrendResult?.score ?? null });
  if (supabase && communeInfo.code_insee) {
    supabase.rpc("save_smartscore_history", { p_commune_insee: communeInfo.code_insee, p_departement: v4Departement ?? communeInfo.code_insee.slice(0, 2), p_lat: lat, p_lon: lon, p_project_nature: v4ProjectNature, p_zone_type: isRural ? "rural" : "urbain", p_score_global: smartScoreV4.score, p_pillar_scores: smartScoreV4.pillarScores, p_weights_used: smartScoreV4.activeWeights, p_essential_services_score: essServicesResult.score, p_rural_accessibility_score: null, p_dvf_median_m2: dvf?.prix_m2_median ?? null, p_dvf_transactions_count: dvf?.nb_transactions ?? null, p_population: insee?.population ?? null }).then(() => {}).catch(() => {});
  }
'''

    if ANCHOR_STANDARD in content:
        content = content.replace(ANCHOR_STANDARD, ANCHOR_STANDARD + V4_STANDARD_SCORING)
        patches_applied.append("PATCH 5: V4 scoring in handleStandard")
    else:
        print("  PATCH 5 ECHOUE: anchor computeGlobalScore non trouve")

    # ═══════════════════════════════════════════════════════════
    # PATCH 6: handleStandard — smartscore_v4 dans le return
    # ═══════════════════════════════════════════════════════════
    ANCHOR_STD_SCORE = '    global_score: globalScore,'

    V4_STANDARD_OUTPUT = '''    smartscore_v4: {
      score: smartScoreV4.score, verdict: smartScoreV4.verdict,
      project_nature: smartScoreV4.projectNature, is_rural: smartScoreV4.isRural,
      pillar_scores: smartScoreV4.pillarScores, weights: smartScoreV4.weights, active_weights: smartScoreV4.activeWeights,
      essential_services_score: { score: essServicesResult.score, coverage_pct: essServicesResult.coverage_pct, missing: essServicesResult.missing },
      environment: { score: environmentResult.score, label: environmentResult.label, components: environmentResult.components },
      demographie: popTrendResult ? { score: popTrendResult.score, trend_label: popTrendResult.trend_label, interpretation: popTrendResult.interpretation } : null,
      competition: competitionResult ? { score: competitionResult.score, label: competitionResult.label, permis_count: competitionResult.permis_count } : null,
      market_intelligence: {
        price_trend: priceTrend ? { current_estimated_m2: priceTrend.current_estimated_m2, projected_12m_m2: priceTrend.projected_12m_m2, slope_pct_per_year: priceTrend.slope_pct_per_year, trend_label: priceTrend.trend_label } : null,
        liquidity: { score: liquidity.score, label: liquidity.label },
        rental_tension: { score: rentalTension.score, label: rentalTension.label, rendement_brut_pct: rentalTension.rendement_brut_pct },
      },
    },
'''

    if ANCHOR_STD_SCORE in content:
        content = content.replace(ANCHOR_STD_SCORE, V4_STANDARD_OUTPUT + ANCHOR_STD_SCORE)
        patches_applied.append("PATCH 6: V4 output in handleStandard")
    else:
        print("  PATCH 6 ECHOUE: anchor global_score non trouve")

    # ═══════════════════════════════════════════════════════════
    print(f"\nPatchs appliques ({len(patches_applied)}/6):")
    for p in patches_applied:
        print(f"   {p}")

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
    print("Application des patchs V4 sur v3.27...")

    patched = apply_patches(content)
    patched_lines = patched.count('\n')

    OUTPUT_FILE.write_text(patched, encoding="utf-8")

    print(f"\nFichier patche: {patched_lines} lignes (+{patched_lines - original_lines})")
    print(f"Ecrit dans {OUTPUT_FILE}")
    print()
    print("Verification recommandee:")
    print(f"  fc index.ts index_v4.ts")
    print()
    print("Pour appliquer:")
    print(f"  copy index_v4.ts index.ts")


if __name__ == "__main__":
    main()