export type ProjectType =
  | "LOGEMENT"
  | "COMMERCE"
  | "BUREAUX"
  | "HOTEL"
  | "ETUDIANT"
  | "RSS"
  | "EHPAD";

export type ZoneType = "commune" | "iris" | "custom";

export type SubscoreKey =
  | "demographie"
  | "commodites"
  | "transport"
  | "health"
  | "economie"
  | "tourisme"
  | "concurrence"
  | "marche_prix";

export type MarketStudyRequest = {
  project_type: ProjectType;
  lat: number;
  lon: number;
  radius_km?: number;
  commune_insee?: string | null;
  zone_type?: ZoneType;
};

export type Insight = {
  type: "positive" | "opportunity" | "warning" | "negative";
  title: string;
  description: string;
  value?: string | number | null;
  evidence?: Array<{ field: string; value: unknown }>;
};

export type Completeness = {
  pct: number; // 0-100
  missing: string[];
  blocking: string[];
};

export type MarketStudyResponse = {
  success: boolean;
  scoring_version: string;
  input: {
    resolved_point: { lat: number; lon: number };
    radius_km: number;
    commune_insee?: string;
    project_type: ProjectType;
  };
  zone_type: ZoneType;
  market: {
    verdict: string;
    score: number | null;

    subscores: Partial<Record<SubscoreKey, number | null>>;

    completeness: Completeness;
    insights: Insight[];

    insee?: unknown;
    prices?: unknown;
    transactions?: unknown;
    bpe?: unknown;
    poi_nearby?: unknown;

    modules?: Record<string, unknown>;

    sources: Array<{ key: string; provider: string; dataset?: string; last_updated?: string }>;
    warnings?: string[];
  };
  error: string | null;
  message: string | null;
};

// Data shapes (stubs friendly but structured)
export type InseeData = {
  code_commune?: string;
  commune?: string;
  departement?: string;
  population?: number;
  densite?: number;
  evolution_pop_5ans?: number;
  revenu_median?: number;
  taux_chomage?: number;

  pct_moins_15?: number | null;
  pct_moins_25?: number | null;
  pct_15_29?: number | null;
  pct_25_39?: number | null;
  pct_30_44?: number | null;
  pct_45_59?: number | null;
  pct_plus_60?: number | null;
  pct_plus_65?: number | null;
  pct_plus_75?: number | null;
  pct_plus_85?: number | null;
  evolution_75_plus_5ans?: number | null;

  source?: { provider: string; dataset?: string; last_updated?: string };
};

export type BpeData = {
  nb_commerces?: number | null;
  nb_sante?: number | null;
  nb_services?: number | null;
  nb_enseignement?: number | null;
  nb_sport_culture?: number | null;
  source?: { provider: string; dataset?: string; last_updated?: string };
};

export type TransportData = {
  score?: number | null; // 0-100
  details?: unknown;
  source?: { provider: string; dataset?: string; last_updated?: string };
};

export type PricesData = {
  median_eur_m2?: number | null;
  min_eur_m2?: number | null;
  q1_eur_m2?: number | null;
  q3_eur_m2?: number | null;
  max_eur_m2?: number | null;
  evolution_1an?: number | null;
  transactions?: { count?: number | null };
  source?: { provider: string; dataset?: string; last_updated?: string };
};

export type SeniorCompetition = {
  count?: number | null;
  capacite_totale?: number | null;
  densite_lits_1000_seniors?: number | null;
  verdict?: string | null;
  liste?: unknown[];
  source?: { provider: string; dataset?: string; last_updated?: string };
};
