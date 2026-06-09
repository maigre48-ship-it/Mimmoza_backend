// ============================================================================
// decision-engine.test.ts — Tests du moteur de décision GO / NO GO (Deno)
// ✅ Deno.test + std/assert (pas de Vitest)
// ✅ Imports avec extension .ts
// ✅ Types explicites (pas de implicit any)
// ============================================================================

import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  computeDecision,
  type DecisionInput,
  type RiskDetail,
  type DecisionReason,
} from "./decision-engine.ts";

// ---------------------------------------------------------------------------
// HELPERS POUR CONSTRUIRE LES INPUTS DE TEST
// ---------------------------------------------------------------------------

function makeRisk(
  key: string,
  level: RiskDetail["level"],
  weight: number,
  penalty = 0,
  impact = 0,
): RiskDetail {
  return { key, level, weight, penalty, impact };
}

function makeInput(overrides: {
  totalScore?: number;
  riskScore?: number;
  riskPenaltyRaw?: number;
  breakdown?: Partial<DecisionInput["smartScore"]["breakdown"]>;
  riskDetails?: RiskDetail[];
}): DecisionInput {
  return {
    smartScore: {
      totalScore: overrides.totalScore ?? 80,
      riskScore: overrides.riskScore ?? 75,
      riskPenaltyRaw: overrides.riskPenaltyRaw ?? 5,
      breakdown: {
        market: overrides.breakdown?.market ?? 70,
        faisabilite: overrides.breakdown?.faisabilite ?? 70,
        localisation: overrides.breakdown?.localisation ?? 75,
        finance: overrides.breakdown?.finance ?? 70,
        risques: overrides.breakdown?.risques ?? 65,
      },
      riskDetails: overrides.riskDetails ?? [
        makeRisk("flood", "faible", 2),
        makeRisk("pollution", "faible", 1),
      ],
    },
  };
}

function hasReason(result: ReturnType<typeof computeDecision>, code: string): boolean {
  return result.reasons.some((r: DecisionReason) => r.code === code);
}

function hasConditionContains(
  result: ReturnType<typeof computeDecision>,
  needleLower: string,
): boolean {
  return result.conditions.some((c: string) => c.toLowerCase().includes(needleLower));
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

// =========================================================================
// 1. GO PROPRE
// =========================================================================
Deno.test("GO propre — score >= 75 sans red flags => GO", () => {
  const input = makeInput({ totalScore: 82, riskScore: 80 });
  const result = computeDecision(input);

  assertEquals(result.decision, "GO");
  assertEquals(result.redFlags.length, 0);
  assertEquals(result.conditions.length, 0);
  assert(result.summary.toLowerCase().includes("favorable"));
  assert(result.confidence >= 75);
});

Deno.test("GO propre — score = 75 => GO", () => {
  const input = makeInput({ totalScore: 75, riskScore: 70 });
  const result = computeDecision(input);
  assertEquals(result.decision, "GO");
});

Deno.test("GO propre — thresholds exposés", () => {
  const input = makeInput({ totalScore: 80 });
  const result = computeDecision(input);

  assertEquals(result.thresholds, {
    goMinScore: 75,
    noGoMaxScore: 59,
    reserveBand: [60, 74],
  });
});

// =========================================================================
// 2. GO_AVEC_RESERVES PAR SCORE (bande 60–74)
// =========================================================================
Deno.test("GO_AVEC_RESERVES par score — score 70", () => {
  const input = makeInput({ totalScore: 70, riskScore: 75 });
  const result = computeDecision(input);

  assertEquals(result.decision, "GO_AVEC_RESERVES");
  assert(result.summary.toLowerCase().includes("réserves"));
});

Deno.test("GO_AVEC_RESERVES par score — score 60 (borne basse)", () => {
  const input = makeInput({ totalScore: 60, riskScore: 75 });
  const result = computeDecision(input);
  assertEquals(result.decision, "GO_AVEC_RESERVES");
});

Deno.test("GO_AVEC_RESERVES par score — score 74 (borne haute)", () => {
  const input = makeInput({ totalScore: 74, riskScore: 75 });
  const result = computeDecision(input);
  assertEquals(result.decision, "GO_AVEC_RESERVES");
});

Deno.test("GO_AVEC_RESERVES par score — confiance baisse dans bande réserves", () => {
  const inputGo = makeInput({ totalScore: 80, riskScore: 75 });
  const inputReserve = makeInput({ totalScore: 65, riskScore: 75 });

  const goResult = computeDecision(inputGo);
  const reserveResult = computeDecision(inputReserve);

  assert(reserveResult.confidence < goResult.confidence);
});

// =========================================================================
// 3. GO_AVEC_RESERVES PAR RISQUES
// =========================================================================
Deno.test("GO_AVEC_RESERVES — 1 risque fort weight=3 même si score >= 75", () => {
  const input = makeInput({
    totalScore: 78,
    riskScore: 70,
    riskDetails: [
      makeRisk("flood", "fort", 3, 15, 10),
      makeRisk("pollution", "faible", 1),
    ],
  });
  const result = computeDecision(input);

  assertEquals(result.decision, "GO_AVEC_RESERVES");
  assert(result.redFlags.length > 0);
  assert(result.conditions.length > 0);
});

Deno.test("GO_AVEC_RESERVES — ≥3 risques moyens weight>=2", () => {
  const input = makeInput({
    totalScore: 76,
    riskScore: 68,
    riskDetails: [
      makeRisk("flood", "moyen", 2, 5, 5),
      makeRisk("pollution", "moyen", 2, 5, 5),
      makeRisk("bruit", "moyen", 3, 5, 5),
    ],
  });
  const result = computeDecision(input);

  assertEquals(result.decision, "GO_AVEC_RESERVES");
  assert(hasReason(result, "MULTI_MEDIUM_RISKS"));
});

Deno.test("GO_AVEC_RESERVES — finance < 50 => reason + condition", () => {
  const input = makeInput({
    totalScore: 76,
    riskScore: 70,
    breakdown: { finance: 45 },
  });
  const result = computeDecision(input);

  assertEquals(result.decision, "GO_AVEC_RESERVES");
  assert(hasReason(result, "FINANCE_WEAK"));
  assert(hasConditionContains(result, "financement"));
});

Deno.test("GO_AVEC_RESERVES — market < 50 => reason", () => {
  const input = makeInput({
    totalScore: 76,
    riskScore: 70,
    breakdown: { market: 42 },
  });
  const result = computeDecision(input);

  assertEquals(result.decision, "GO_AVEC_RESERVES");
  assert(hasReason(result, "MARKET_WEAK"));
});

// =========================================================================
// 4. NO_GO PAR SCORE < 60
// =========================================================================
Deno.test("NO_GO — score 55", () => {
  const input = makeInput({ totalScore: 55, riskScore: 70 });
  const result = computeDecision(input);

  assertEquals(result.decision, "NO_GO");
  assert(result.summary.toLowerCase().includes("défavorable"));
});

Deno.test("NO_GO — score 59 (limite)", () => {
  const input = makeInput({ totalScore: 59, riskScore: 70 });
  const result = computeDecision(input);
  assertEquals(result.decision, "NO_GO");
});

Deno.test("NO_GO — score 0", () => {
  const input = makeInput({ totalScore: 0, riskScore: 70 });
  const result = computeDecision(input);
  assertEquals(result.decision, "NO_GO");
});

Deno.test("NO_GO — reason SCORE_LOW", () => {
  const input = makeInput({ totalScore: 50, riskScore: 70 });
  const result = computeDecision(input);
  assert(hasReason(result, "SCORE_LOW"));
});

// =========================================================================
// 5. NO_GO PAR 2 RISQUES FORT WEIGHT=3
// =========================================================================
Deno.test("NO_GO — 2 risques fort weight=3 même si score >= 75", () => {
  const input = makeInput({
    totalScore: 80,
    riskScore: 60,
    riskDetails: [
      makeRisk("flood", "fort", 3, 20, 15),
      makeRisk("pollution", "fort", 3, 20, 15),
      makeRisk("bruit", "faible", 1),
    ],
  });
  const result = computeDecision(input);

  assertEquals(result.decision, "NO_GO");
  assert(hasReason(result, "MULTI_HIGH_RISKS"));
  assert(result.redFlags.length > 0);
});

Deno.test("NO_GO — conditions spécifiques risques forts (hydraulique/pollution)", () => {
  const input = makeInput({
    totalScore: 80,
    riskScore: 60,
    riskDetails: [
      makeRisk("flood", "fort", 3, 20, 15),
      makeRisk("pollution", "fort", 3, 20, 15),
    ],
  });
  const result = computeDecision(input);

  assert(hasConditionContains(result, "hydraulique"));
  assert(hasConditionContains(result, "pollution"));
});

// =========================================================================
// 6. NO_GO PAR RISKSCORE < 55
// =========================================================================
Deno.test("NO_GO — riskScore < 55 même si totalScore >= 75", () => {
  const input = makeInput({
    totalScore: 78,
    riskScore: 50,
    riskDetails: [makeRisk("flood", "faible", 1)],
  });
  const result = computeDecision(input);

  assertEquals(result.decision, "NO_GO");
  assert(hasReason(result, "RISK_SCORE_CRITICAL"));
});

Deno.test("NO_GO — riskScore = 54 (limite)", () => {
  const input = makeInput({
    totalScore: 80,
    riskScore: 54,
    riskDetails: [],
  });
  const result = computeDecision(input);
  assertEquals(result.decision, "NO_GO");
});

Deno.test("riskScore = 55 => ne déclenche PAS RISK_SCORE_CRITICAL", () => {
  const input = makeInput({
    totalScore: 80,
    riskScore: 55,
    riskDetails: [],
  });
  const result = computeDecision(input);

  assertNotEquals(result.decision, "NO_GO");
  assert(!hasReason(result, "RISK_SCORE_CRITICAL"));
});

// =========================================================================
// 7. NO_GO PAR FAISABILITÉ < 45
// =========================================================================
Deno.test("NO_GO — faisabilite < 45", () => {
  const input = makeInput({
    totalScore: 78,
    riskScore: 70,
    breakdown: { faisabilite: 40 },
  });
  const result = computeDecision(input);

  assertEquals(result.decision, "NO_GO");
  assert(hasReason(result, "FEASIBILITY_CRITICAL"));
  assert(hasConditionContains(result, "plu"));
});

// =========================================================================
// 8. GESTION DES INCONNUS
// =========================================================================
Deno.test("Inconnus weight>=2 => réserves + reason UNKNOWN_RISKS + 2 conditions", () => {
  const input = makeInput({
    totalScore: 76,
    riskScore: 70,
    riskDetails: [
      makeRisk("flood", "inconnu", 3),
      makeRisk("pollution", "inconnu", 2),
      makeRisk("bruit", "faible", 1),
    ],
  });
  const result = computeDecision(input);

  assertEquals(result.decision, "GO_AVEC_RESERVES");
  assert(hasReason(result, "UNKNOWN_RISKS"));

  const nb = result.conditions.filter((c: string) => c.toLowerCase().includes("inconnu")).length;
  assertEquals(nb, 2);
});

Deno.test("Inconnus => confiance baisse", () => {
  const inputClean = makeInput({ totalScore: 80, riskScore: 75 });
  const inputUnknown = makeInput({
    totalScore: 80,
    riskScore: 75,
    riskDetails: [
      makeRisk("flood", "inconnu", 3),
      makeRisk("pollution", "inconnu", 2),
    ],
  });

  const cleanResult = computeDecision(inputClean);
  const unknownResult = computeDecision(inputUnknown);

  assert(unknownResult.confidence < cleanResult.confidence);
});

Deno.test("Inconnu weight=1 => pas de UNKNOWN_RISKS, décision GO", () => {
  const input = makeInput({
    totalScore: 80,
    riskScore: 75,
    riskDetails: [makeRisk("bruit", "inconnu", 1)],
  });
  const result = computeDecision(input);

  assertEquals(result.decision, "GO");
  assert(!hasReason(result, "UNKNOWN_RISKS"));
});

Deno.test("Inconnus => pénalité confiance capée (>= 50)", () => {
  const input = makeInput({
    totalScore: 80,
    riskScore: 75,
    riskDetails: [
      makeRisk("flood", "inconnu", 3),
      makeRisk("pollution", "inconnu", 2),
      makeRisk("seisme", "inconnu", 2),
      makeRisk("argile", "inconnu", 2),
      makeRisk("radon", "inconnu", 2),
    ],
  });
  const result = computeDecision(input);

  assert(result.confidence >= 50);
});

// =========================================================================
// 9. SCORE DE CONFIANCE
// =========================================================================
Deno.test("Confiance — GO propre => 85 (selon règle)", () => {
  const input = makeInput({ totalScore: 85, riskScore: 80 });
  const result = computeDecision(input);

  assertEquals(result.confidence, 85);
});

Deno.test("Confiance — clamp 0..100", () => {
  const input = makeInput({
    totalScore: 55,
    riskScore: 40,
    riskDetails: [
      makeRisk("flood", "inconnu", 3),
      makeRisk("pollution", "inconnu", 3),
      makeRisk("seisme", "inconnu", 3),
      makeRisk("argile", "inconnu", 3),
      makeRisk("radon", "inconnu", 3),
    ],
  });
  const result = computeDecision(input);

  assert(result.confidence >= 0);
  assert(result.confidence <= 100);
});

// =========================================================================
// 10. TRI DES RAISONS
// =========================================================================
Deno.test("Tri des raisons — critical → warning → info", () => {
  const input = makeInput({
    totalScore: 50,
    riskScore: 50,
    breakdown: { finance: 40, faisabilite: 40 },
    riskDetails: [
      makeRisk("flood", "fort", 3, 20, 15),
      makeRisk("pollution", "fort", 3, 20, 15),
    ],
  });
  const result = computeDecision(input);

  const severities = result.reasons.map((r: DecisionReason) => r.severity);

  const idxFirstWarning = severities.indexOf("warning");
  const idxLastCritical = severities.lastIndexOf("critical");
  const idxFirstInfo = severities.indexOf("info");

  if (idxFirstWarning !== -1 && idxLastCritical !== -1) {
    assert(idxLastCritical < idxFirstWarning);
  }
  if (idxFirstInfo !== -1 && idxFirstWarning !== -1) {
    assert(idxFirstWarning < idxFirstInfo);
  }
});

// =========================================================================
// 11. STABILITÉ (DÉTERMINISME)
// =========================================================================
Deno.test("Déterminisme — mêmes inputs => outputs identiques", () => {
  const input = makeInput({
    totalScore: 68,
    riskScore: 65,
    riskDetails: [
      makeRisk("flood", "moyen", 2, 5, 5),
      makeRisk("pollution", "inconnu", 2),
    ],
  });

  const result1 = computeDecision(input);
  const result2 = computeDecision(input);

  assertEquals(result1, result2);
});
