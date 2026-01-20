export type Terrain3DRequest = {
  parcel_id?: string;
  commune_insee?: string;
  grid_step_m?: number;
  // V2: building footprint, target altitude, margin, etc.
};

export type Terrain3DResponse = {
  success: boolean;
  version: string;
  input: Terrain3DRequest;
  stats: {
    altitude_min?: number;
    altitude_max?: number;
    pente_moyenne?: number;
  };
  volumes?: {
    cut_m3?: number;
    fill_m3?: number;
    net_m3?: number;
  };
  costs?: {
    total_eur?: number;
  };
  coverage?: Record<string, any>;
  error?: string;
};
