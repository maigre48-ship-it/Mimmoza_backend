import type { MarketStudyRequest, SeniorCompetition } from "../types/market.types.ts";

/**
 * v1 STUB
 * Branche ici FINESS / OSM Healthcare / OpenDataSoft, etc.
 */
export async function fetchCompetitionSenior(req: MarketStudyRequest): Promise<SeniorCompetition | null> {
  if (req.project_type !== "RSS" && req.project_type !== "EHPAD") return null;

  return {
    count: null,
    capacite_totale: null,
    densite_lits_1000_seniors: null,
    verdict: null,
    liste: [],
    source: { provider: "stub", dataset: "finess/osm", last_updated: null as unknown as string },
  };
}
