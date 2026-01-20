export type Coverage = "ok" | "no_data" | "not_covered" | "error";

export type ProviderMeta = {
  provider: string;
  source: "api" | "supabase" | "mixed";
  coverage: Coverage;
  reason?: string;
  cached?: boolean;
  fetched_at?: string;
};

export type DvfKpis = {
  n: number;
  median_price_m2: number | null;
  avg_price_m2: number | null;
  q1_price_m2: number | null;
  q3_price_m2: number | null;
};

export type DvfResult = ProviderMeta & {
  kpis: DvfKpis;
  comps?: any[];
};

export type FinessEhpad = {
  name: string;
  finess?: string;
  lat?: number;
  lon?: number;
  address?: string;
  city?: string;
  distance_m?: number;
};

export type FinessResult = ProviderMeta & {
  radius_m: number;
  count: number;
  nearest?: FinessEhpad | null;
  items?: FinessEhpad[];
};
