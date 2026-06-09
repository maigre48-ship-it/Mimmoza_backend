// ============================================================================
// Tests — SmartScore × Risk Engine
// Exécutable avec: deno test smartscore-risk.test.ts
// ou via n'importe quel runner compatible TypeScript
// ============================================================================

import {
  computeRiskScore,
  computeSmartScoreWithRisk,
  RISK_LEVEL_PENALTY,
  RISK_WEIGHTS,
  EXPECTED_RISK_COUNT,
  type RiskItem,
  type SmartScoreBase,
} from "./smartscore-risk.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Génère les 16 risques avec un niveau uniforme */
function makeRisks(
  level: RiskItem["level"] = "faible",
  overrides: Partial<Record<string, RiskItem["level"]>> = {}
): RiskItem[] {
  const keys = Object.keys(RISK_WEIGHTS);
  return keys.map((key) => ({
    key,
    label: key,
    level: overrides[key] ?? level,
  }));
}

const BASE_SCORE: SmartScoreBase = {
  totalScore: 75,
  breakdown: {
    market: 80,
    faisabilite: 70,
    localisation: 75,
    finance: 65,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Test 1 : Tous les risques faibles → riskScore = 100, aucune pénalité
{
  const risks = makeRisks("faible");
  const result = computeRiskScore(risks);

  console.assert(result.riskScore === 100, "T1: riskScore should be 100");
  console.assert(result.riskPenaltyRaw === 0, "T1: no penalty");
  console.assert(result.riskDetails.length === EXPECTED_RISK_COUNT, "T1: 16 details");
  console.log("✅ Test 1 passed — all faible → riskScore 100");
}

// Test 2 : Un seul risque fort (poids 3) → pénalité = -45
{
  const risks = makeRisks("faible", { flood: "fort" });
  const result = computeRiskScore(risks);

  console.assert(result.riskPenaltyRaw === -45, `T2: penalty should be -45, got ${result.riskPenaltyRaw}`);
  console.assert(result.riskScore === 55, `T2: riskScore should be 55, got ${result.riskScore}`);
  console.log("✅ Test 2 passed — 1 fort (w3) → riskScore 55");
}

// Test 3 : Tous inconnus → pénalité prudentielle
{
  const risks = makeRisks("inconnu");
  const result = computeRiskScore(risks);

  // Sum of all weights × -3
  const expectedPenalty = Object.values(RISK_WEIGHTS).reduce((s, w) => s + w * -3, 0);
  console.assert(
    result.riskPenaltyRaw === expectedPenalty,
    `T3: penalty should be ${expectedPenalty}, got ${result.riskPenaltyRaw}`
  );
  console.log(`✅ Test 3 passed — all inconnu → penalty ${expectedPenalty}`);
}

// Test 4 : Tous forts → riskScore plancher à 0
{
  const risks = makeRisks("fort");
  const result = computeRiskScore(risks);

  console.assert(result.riskScore === 0, `T4: riskScore should be 0, got ${result.riskScore}`);
  console.log("✅ Test 4 passed — all fort → riskScore 0 (clamped)");
}

// Test 5 : SmartScore final avec risques faibles = pondération standard
{
  const risks = makeRisks("faible");
  const result = computeSmartScoreWithRisk(BASE_SCORE, risks);

  // 80×0.30 + 70×0.30 + 75×0.20 + 65×0.10 + 100×0.10
  // = 24 + 21 + 15 + 6.5 + 10 = 76.5 → 77
  console.assert(result.totalScore === 77, `T5: totalScore should be 77, got ${result.totalScore}`);
  console.assert(result.breakdown.risques === 100, "T5: risques breakdown = 100");
  console.log("✅ Test 5 passed — SmartScore final = 77 (no risk penalty)");
}

// Test 6 : SmartScore final avec flood fort
{
  const risks = makeRisks("faible", { flood: "fort" });
  const result = computeSmartScoreWithRisk(BASE_SCORE, risks);

  // riskScore = 55
  // 80×0.30 + 70×0.30 + 75×0.20 + 65×0.10 + 55×0.10
  // = 24 + 21 + 15 + 6.5 + 5.5 = 72 → 72
  console.assert(result.totalScore === 72, `T6: totalScore should be 72, got ${result.totalScore}`);
  console.assert(result.riskScore === 55, `T6: riskScore should be 55, got ${result.riskScore}`);
  console.log("✅ Test 6 passed — flood fort → SmartScore 72 (-5 pts vs baseline)");
}

// Test 7 : Les scores existants ne sont jamais modifiés
{
  const risks = makeRisks("fort");
  const result = computeSmartScoreWithRisk(BASE_SCORE, risks);

  console.assert(result.breakdown.market === 80, "T7: market unchanged");
  console.assert(result.breakdown.faisabilite === 70, "T7: faisabilite unchanged");
  console.assert(result.breakdown.localisation === 75, "T7: localisation unchanged");
  console.assert(result.breakdown.finance === 65, "T7: finance unchanged");
  console.log("✅ Test 7 passed — existing scores never modified");
}

// Test 8 : Structure riskDetails complète
{
  const risks = makeRisks("moyen", { pollution: "fort" });
  const result = computeRiskScore(risks);

  const pollutionDetail = result.riskDetails.find((d) => d.key === "pollution");
  console.assert(pollutionDetail !== undefined, "T8: pollution detail exists");
  console.assert(pollutionDetail!.level === "fort", "T8: level = fort");
  console.assert(pollutionDetail!.weight === 3, "T8: weight = 3");
  console.assert(pollutionDetail!.penalty === -15, "T8: penalty = -15");
  console.assert(pollutionDetail!.impact === -45, "T8: impact = -45");
  console.log("✅ Test 8 passed — riskDetails structure correct");
}

console.log("\n🎉 All tests passed!");