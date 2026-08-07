import type { MarketStudyRequest, PricesData } from "../types/market.types.ts";

/**
 * v1 STUB
 * Branche ici DVF/MeilleursAgents/Notaires (selon ton pipeline).
 */
export async function fetchPrices(_req: MarketStudyRequest): Promise<PricesData | null> {
  return {
    // return null values; scoring will handle missing
    median_eur_m2: null,
    min_eur_m2: null,
    q1_eur_m2: null,
    q3_eur_m2: null,
    max_eur_m2: null,
    evolution_1an: null,
    transactions: { count: null },
    source: { provider: "stub", dataset: "prices", last_updated: null as unknown as string },
  };
}
