import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

type OpportunityEngineInput = {
  price_eur?: number;
  surface_m2?: number;
  market_price_m2?: number;

  days_on_market?: number;
  price_drop_pct?: number;
  portal_count?: number;
  relist_count?: number;

  city_match?: boolean;
  zip_match?: boolean;
  property_type_match?: boolean;
  budget_match?: boolean;
  surface_match?: boolean;

  local_liquidity?: number;
  market_momentum?: number;

  comparables_count?: number;
  dvf_recency_months?: number;
  geo_confidence?: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number) {
  return Math.round(value);
}

function computeDiscountPct(input: OpportunityEngineInput): number {
  const price = input.price_eur ?? 0;
  const surface = input.surface_m2 ?? 0;
  const marketPriceM2 = input.market_price_m2 ?? 0;

  if (price <= 0 || surface <= 0 || marketPriceM2 <= 0) return 0;

  const askPriceM2 = price / surface;
  return ((marketPriceM2 - askPriceM2) / marketPriceM2) * 100;
}

function computeDiscountScore(discountPct: number): number {
  if (discountPct <= 0) return 0;
  if (discountPct >= 15) return 30;
  return round((discountPct / 15) * 30);
}

function computeSellerPressureScore(input: OpportunityEngineInput): number {
  let score = 0;

  const daysOnMarket = input.days_on_market ?? 0;
  const priceDropPct = input.price_drop_pct ?? 0;
  const portalCount = input.portal_count ?? 1;
  const relistCount = input.relist_count ?? 0;

  if (daysOnMarket >= 30) score += 3;
  if (daysOnMarket >= 60) score += 3;
  if (daysOnMarket >= 90) score += 2;

  if (priceDropPct >= 3) score += 3;
  if (priceDropPct >= 6) score += 3;
  if (priceDropPct >= 10) score += 2;

  if (portalCount >= 2) score += 2;
  if (relistCount >= 1) score += 2;

  return clamp(score, 0, 20);
}

function computeLiquidityScore(input: OpportunityEngineInput): number {
  const localLiquidity = clamp(input.local_liquidity ?? 0.5, 0, 1);
  const marketMomentum = clamp(input.market_momentum ?? 0.5, 0, 1);

  return clamp(round(localLiquidity * 10 + marketMomentum * 5), 0, 15);
}

function computeWatchlistFitScore(input: OpportunityEngineInput): number {
  let score = 0;

  if (input.city_match) score += 4;
  if (input.zip_match) score += 3;
  if (input.property_type_match) score += 3;
  if (input.budget_match) score += 3;
  if (input.surface_match) score += 2;

  return clamp(score, 0, 15);
}

function computeMomentumScore(input: OpportunityEngineInput): number {
  let score = 0;

  const priceDropPct = input.price_drop_pct ?? 0;
  const daysOnMarket = input.days_on_market ?? 0;

  if (priceDropPct >= 3) score += 3;
  if (priceDropPct >= 6) score += 2;
  if (daysOnMarket <= 14 && priceDropPct > 0) score += 3;
  if ((input.market_momentum ?? 0) >= 0.7) score += 2;

  return clamp(score, 0, 10);
}

function computeDataConfidenceScore(input: OpportunityEngineInput): number {
  let score = 0;

  const comparablesCount = input.comparables_count ?? 0;
  const dvfRecencyMonths = input.dvf_recency_months ?? 24;
  const geoConfidence = clamp(input.geo_confidence ?? 0.7, 0, 1);

  if (comparablesCount >= 3) score += 2;
  if (comparablesCount >= 5) score += 2;
  if (comparablesCount >= 8) score += 1;

  if (dvfRecencyMonths <= 12) score += 2;
  if (dvfRecencyMonths <= 6) score += 1;

  score += round(geoConfidence * 2);

  return clamp(score, 0, 10);
}

// V2.1 — seuils recalibrés
function getOpportunityLabel(score: number): string {
  if (score >= 70) return "PRIORITAIRE";
  if (score >= 50) return "FORTE";
  if (score >= 25) return "INTERESSANTE";
  return "FAIBLE";
}

// V2.1 — décision plus fine
function getDecisionHint(score: number): string {
  if (score >= 70) return "Préparer offre";
  if (score >= 50) return "Contacter rapidement";
  if (score >= 25) return "Analyser";
  return "Surveiller";
}

function buildReasons(input: OpportunityEngineInput, discountPct: number): string[] {
  const reasons: string[] = [];

  if (discountPct >= 8) {
    reasons.push(`Prix affiché estimé ${round(discountPct)}% sous le marché local`);
  }

  if ((input.days_on_market ?? 0) >= 60) {
    reasons.push("Annonce ancienne, suggérant une marge de négociation potentielle");
  }

  if ((input.price_drop_pct ?? 0) >= 5) {
    reasons.push("Baisse de prix déjà détectée sur l'annonce");
  }

  if ((input.local_liquidity ?? 0) >= 0.65) {
    reasons.push("Marché local suffisamment liquide");
  }

  if (input.city_match && input.property_type_match) {
    reasons.push("Bien cohérent avec la zone et la typologie ciblées");
  }

  return reasons;
}

// V2.1 — risk flags métier enrichis
function buildRiskFlags(input: OpportunityEngineInput, discountPct: number): string[] {
  const flags: string[] = [];

  if ((input.comparables_count ?? 0) < 3) {
    flags.push("Comparables marché limités");
  }

  if ((input.dvf_recency_months ?? 24) > 12) {
    flags.push("Références DVF possiblement anciennes");
  }

  if ((input.geo_confidence ?? 0.7) < 0.6) {
    flags.push("Confiance géographique modérée");
  }

  if (discountPct <= 0) {
    flags.push("Décote marché non démontrée");
  } else if (discountPct < 5) {
    flags.push("Décote faible par rapport au marché");
  }

  if ((input.price_drop_pct ?? 0) === 0) {
    flags.push("Baisse de prix non détectée");
  }

  if ((input.days_on_market ?? 0) < 30) {
    flags.push("Pression vendeur encore limitée");
  }

  if ((input.local_liquidity ?? 0) < 0.5) {
    flags.push("Liquidité locale modérée");
  }

  return flags.slice(0, 4);
}

// V2.1 — trigger summary
function buildTriggerSummary(input: OpportunityEngineInput, discountPct: number): string {
  const parts: string[] = [];

  if (discountPct >= 8) {
    parts.push("prix sous marché");
  }

  if ((input.days_on_market ?? 0) >= 60) {
    parts.push("annonce ancienne");
  }

  if ((input.price_drop_pct ?? 0) >= 5) {
    parts.push("baisse de prix");
  }

  if (input.city_match && input.property_type_match) {
    parts.push("bon alignement watchlist");
  }

  if (parts.length === 0) {
    return "signal faible à ce stade";
  }

  return parts.join(" + ");
}

function computeOpportunity(input: OpportunityEngineInput) {
  const discountPct = computeDiscountPct(input);

  const discountScore = computeDiscountScore(discountPct);
  const sellerPressureScore = computeSellerPressureScore(input);
  const liquidityScore = computeLiquidityScore(input);
  const watchlistFitScore = computeWatchlistFitScore(input);
  const momentumScore = computeMomentumScore(input);
  const dataConfidenceScore = computeDataConfidenceScore(input);

  const rawScore =
    discountScore +
    sellerPressureScore +
    liquidityScore +
    watchlistFitScore +
    momentumScore;

  const opportunityScore = clamp(round(rawScore), 0, 90);
  const confidenceScore = round((dataConfidenceScore / 10) * 100);

  return {
    opportunity_score: opportunityScore,
    opportunity_label: getOpportunityLabel(opportunityScore),
    confidence_score: confidenceScore,
    pillar_scores: {
      discount: discountScore,
      seller_pressure: sellerPressureScore,
      liquidity: liquidityScore,
      watchlist_fit: watchlistFitScore,
      momentum: momentumScore,
      data_confidence: dataConfidenceScore,
    },
    computed: {
      discount_pct: round(discountPct * 10) / 10,
    },
    reasons: buildReasons(input, discountPct),
    risk_flags: buildRiskFlags(input, discountPct),
    decision_hint: getDecisionHint(opportunityScore),
    trigger_summary: buildTriggerSummary(input, discountPct),
  };
}

serve(async (req) => {
  try {
    const body = await req.json();
    const result = computeOpportunity(body);

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 400,
      }
    );
  }
});