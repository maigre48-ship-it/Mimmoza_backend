import type {
  ProjectType,
  InseeData,
  BpeData,
  TransportData,
  PricesData,
  SeniorCompetition,
  SubscoreKey,
} from "../types/market.types.ts";

// Helpers: clamp + score from thresholds
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}
function to100(x01: number) {
  return Math.round(clamp01(x01) * 100);
}

function scoreFromHigherBetter(value: number, min: number, max: number) {
  // linear: min=>0, max=>1
  if (!Number.isFinite(value)) return null;
  if (max <= min) return null;
  return to100((value - min) / (max - min));
}
function scoreFromLowerBetter(value: number, min: number, max: number) {
  // linear: min=>1, max=>0
  if (!Number.isFinite(value)) return null;
  if (max <= min) return null;
  return to100(1 - (value - min) / (max - min));
}

export function computeSubscores(args: {
  project_type: ProjectType;
  insee: InseeData | null;
  bpe: BpeData | null;
  transport: TransportData | null;
  prices: PricesData | null;
  seniorCompetition: SeniorCompetition | null;
}): Partial<Record<SubscoreKey, number | null>> {
  const s: Partial<Record<SubscoreKey, number | null>> = {};

  // Demography (generic): use evolution_pop_5ans and density as proxy
  // - evolution: -3%..+6% => 0..100
  // - density: 100..20000 => 0..100 (log-ish, but linear for v1)
  const evo = args.insee?.evolution_pop_5ans;
  const dens = args.insee?.densite;

  const evoScore = typeof evo === "number" ? scoreFromHigherBetter(evo, -3, 6) : null;
  const densScore = typeof dens === "number" ? scoreFromHigherBetter(dens, 100, 20000) : null;

  // Default demography: mean of available evo/dens
  const demographyParts = [evoScore, densScore].filter((x): x is number => typeof x === "number");
  s.demographie = demographyParts.length ? Math.round(demographyParts.reduce((a, b) => a + b, 0) / demographyParts.length) : null;

  // Commodities: use BPE counts as proxies (normalized)
  // - commerces: 0..2000 => 0..100
  // - services: 0..1000 => 0..100
  const c = args.bpe?.nb_commerces;
  const svc = args.bpe?.nb_services;
  const ens = args.bpe?.nb_enseignement;
  const sport = args.bpe?.nb_sport_culture;

  // Basic commodities: commerces + services
  const comScore = typeof c === "number" ? scoreFromHigherBetter(c, 0, 2000) : null;
  const svcScore = typeof svc === "number" ? scoreFromHigherBetter(svc, 0, 1000) : null;

  const commodParts = [comScore, svcScore].filter((x): x is number => typeof x === "number");
  s.commodites = commodParts.length ? Math.round(commodParts.reduce((a, b) => a + b, 0) / commodParts.length) : null;

  // Transport: accept transport.score directly if present
  s.transport = typeof args.transport?.score === "number" ? Math.round(args.transport.score) : null;

  // Market/prices: prefer positive evolution and reasonable median
  const evo1 = args.prices?.evolution_1an;
  const med = args.prices?.median_eur_m2;

  const evo1Score = typeof evo1 === "number" ? scoreFromHigherBetter(evo1, -5, 10) : null;
  // For price itself: depends on project; for v1 we score higher as "more liquid/tendu" but cap.
  const medScore = typeof med === "number" ? scoreFromHigherBetter(med, 800, 12000) : null;

  const marketParts = [evo1Score, medScore].filter((x): x is number => typeof x === "number");
  s.marche_prix = marketParts.length ? Math.round(marketParts.reduce((a, b) => a + b, 0) / marketParts.length) : null;

  // Economy: use unemployment (lower better) and income (higher better)
  const ch = args.insee?.taux_chomage;
  const rev = args.insee?.revenu_median;

  const chScore = typeof ch === "number" ? scoreFromLowerBetter(ch, 4, 15) : null; // 4% best, 15% worst
  const revScore = typeof rev === "number" ? scoreFromHigherBetter(rev, 16000, 40000) : null;

  const ecoParts = [chScore, revScore].filter((x): x is number => typeof x === "number");
  s.economie = ecoParts.length ? Math.round(ecoParts.reduce((a, b) => a + b, 0) / ecoParts.length) : null;

  // Health: v1 uses BPE health count as proxy
  const healthCount = args.bpe?.nb_sante;
  s.health = typeof healthCount === "number" ? scoreFromHigherBetter(healthCount, 0, 1200) : null;

  // Concurrence:
  // - For senior projects: use densite_lits_1000_seniors (lower => better for new project)
  // - For commerce: use nb_commerces (higher => more cluster but also more concurrence; v1: mid is best)
  if (args.project_type === "RSS" || args.project_type === "EHPAD") {
    const densLits = args.seniorCompetition?.densite_lits_1000_seniors;
    if (typeof densLits === "number") {
      // 30 => very under-equipped => 90+, 120 => saturated => 10
      // map 30..120 -> 1..0
      const x01 = 1 - (densLits - 30) / (120 - 30);
      s.concurrence = to100(x01);
    } else {
      s.concurrence = null;
    }
  } else if (args.project_type === "COMMERCE") {
    if (typeof c === "number") {
      // mid best: 150 is "cluster ok", very low (0) or very high (400+) less ideal
      const mid = 150;
      const spread = 200; // controls falloff
      const dist = Math.abs(c - mid);
      const x01 = clamp01(1 - dist / spread);
      s.concurrence = to100(x01);
    } else {
      s.concurrence = null;
    }
  } else if (args.project_type === "ETUDIANT") {
    // v1: if young population exists, we treat competition as unknown unless you later add a proper list.
    s.concurrence = null;
  } else {
    s.concurrence = null;
  }

  // Tourisme: not available v1 (keep null; completeness will flag)
  s.tourisme = null;

  // Project-specific overrides
  if (args.project_type === "ETUDIANT") {
    // Demography for students must rely on pct_15_29
    const pct1529 = args.insee?.pct_15_29;
    if (typeof pct1529 === "number") {
      // 10%..30% => 0..100
      s.demographie = scoreFromHigherBetter(pct1529, 10, 30);
    } else {
      s.demographie = null;
    }

    // Commodities for students: include enseignement and sport/culture
    const ensScore2 = typeof ens === "number" ? scoreFromHigherBetter(ens, 0, 120) : null;
    const sportScore2 = typeof sport === "number" ? scoreFromHigherBetter(sport, 0, 120) : null;

    const parts = [ensScore2, sportScore2, svcScore].filter((x): x is number => typeof x === "number");
    s.commodites = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : s.commodites;
  }

  if (args.project_type === "HOTEL") {
    // Economy proxy + sport/culture as proxy for loisirs
    const leisure = typeof sport === "number" ? scoreFromHigherBetter(sport, 0, 100) : null;
    const parts = [s.economie ?? null, leisure].filter((x): x is number => typeof x === "number");
    s.economie = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : s.economie;
  }

  if (args.project_type === "RSS" || args.project_type === "EHPAD") {
    // Demography must rely on pct_plus_75 when available
    const pct75 = args.insee?.pct_plus_75;
    if (typeof pct75 === "number") {
      // 6%..16% => 0..100
      s.demographie = scoreFromHigherBetter(pct75, 6, 16);
    } else {
      s.demographie = null;
    }
  }

  if (args.project_type === "BUREAUX") {
    // Demography less relevant; keep but economy/transport dominate via weights.
  }

  return s;
}
