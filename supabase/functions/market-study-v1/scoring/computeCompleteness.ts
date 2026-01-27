import type {
  ProjectType,
  Completeness,
  InseeData,
  BpeData,
  TransportData,
  PricesData,
  SeniorCompetition,
  SubscoreKey,
} from "../types/market.types.ts";

function isNil(v: unknown) {
  return v === null || v === undefined;
}

function hasNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

export function computeCompleteness(args: {
  project_type: ProjectType;
  subscores: Partial<Record<SubscoreKey, number | null>>;
  insee: InseeData | null;
  bpe: BpeData | null;
  transport: TransportData | null;
  prices: PricesData | null;
  seniorCompetition: SeniorCompetition | null;
  blocking_missing: string[];
}): Completeness {
  const expected: string[] = [];

  // Common expected (light)
  expected.push("insee.population");
  expected.push("insee.densite");
  expected.push("prices.median_eur_m2");

  // Project-specific expectations
  if (args.project_type === "ETUDIANT") {
    expected.push("insee.pct_15_29");
    expected.push("transport.score");
    expected.push("bpe.nb_enseignement");
  }

  if (args.project_type === "BUREAUX") {
    expected.push("transport.score");
    expected.push("insee.taux_chomage");
    expected.push("bpe.nb_services");
  }

  if (args.project_type === "COMMERCE") {
    expected.push("bpe.nb_commerces");
  }

  if (args.project_type === "LOGEMENT") {
    expected.push("bpe.nb_commerces");
    expected.push("insee.revenu_median");
  }

  if (args.project_type === "HOTEL") {
    expected.push("transport.score");
    expected.push("bpe.nb_sport_culture");
    // tourisme absent v1 -> still expected to drive completeness warning
    expected.push("market.tourisme");
  }

  if (args.project_type === "RSS" || args.project_type === "EHPAD") {
    expected.push("insee.pct_plus_75");
    expected.push("market.concurrence");
    expected.push("market.health");
  }

  // Detect missing
  const missing: string[] = [];

  for (const key of expected) {
    switch (key) {
      case "insee.population":
        if (!hasNumber(args.insee?.population)) missing.push(key);
        break;
      case "insee.densite":
        if (!hasNumber(args.insee?.densite)) missing.push(key);
        break;
      case "insee.taux_chomage":
        if (!hasNumber(args.insee?.taux_chomage)) missing.push(key);
        break;
      case "insee.revenu_median":
        if (!hasNumber(args.insee?.revenu_median)) missing.push(key);
        break;
      case "insee.pct_15_29":
        if (!hasNumber(args.insee?.pct_15_29)) missing.push(key);
        break;
      case "insee.pct_plus_75":
        if (!hasNumber(args.insee?.pct_plus_75)) missing.push(key);
        break;

      case "prices.median_eur_m2":
        if (!hasNumber(args.prices?.median_eur_m2)) missing.push(key);
        break;

      case "transport.score":
        if (!hasNumber(args.transport?.score)) missing.push(key);
        break;

      case "bpe.nb_enseignement":
        if (!hasNumber(args.bpe?.nb_enseignement)) missing.push(key);
        break;
      case "bpe.nb_services":
        if (!hasNumber(args.bpe?.nb_services)) missing.push(key);
        break;
      case "bpe.nb_commerces":
        if (!hasNumber(args.bpe?.nb_commerces)) missing.push(key);
        break;
      case "bpe.nb_sport_culture":
        if (!hasNumber(args.bpe?.nb_sport_culture)) missing.push(key);
        break;

      case "market.tourisme":
        if (isNil(args.subscores.tourisme)) missing.push(key);
        break;
      case "market.concurrence":
        if (isNil(args.subscores.concurrence)) missing.push(key);
        break;
      case "market.health":
        if (isNil(args.subscores.health)) missing.push(key);
        break;

      default:
        // if unknown key, ignore for now
        break;
    }
  }

  const expectedCount = expected.length;
  const missingCount = missing.length;
  const pct =
    expectedCount === 0 ? 100 : Math.max(0, Math.min(100, Math.round(100 * (1 - missingCount / expectedCount))));

  // Blocking
  const blocking: string[] = [];
  for (const b of args.blocking_missing) {
    // map blocking keys to the same missing markers
    // ex: "transport.score" should match "transport.score"
    if (missing.includes(b)) blocking.push(b);
    // also allow "insee.pct_15_29" etc.
    if (missing.includes(`insee.${b}`)) blocking.push(b);
  }

  // Special-case: if blocking list references paths like "transport.score" already, above is enough.
  // Ensure unique
  const uniqBlocking = Array.from(new Set(blocking));

  return { pct, missing, blocking: uniqBlocking };
}
