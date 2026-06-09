// supabase/functions/synthese-promoteur-v1/types.ts

export type Snapshot = {
  updatedAt?: string;
  project?: {
    name?: string;
    address?: string;
    city?: string;
    zipCode?: string;
    lat?: number;
    lon?: number;
    parcelId?: string;
    surfaceM2?: number;
  };
  plu?: {
    ok?: boolean;
    score?: number;
    summary?: string;
    updatedAt?: string;
  };
  market?: {
    ok?: boolean;
    score?: number;
    verdict?: string;
    summary?: string;
    updatedAt?: string;
  };
  risques?: {
    ok?: boolean;
    score?: number;
    level?: string;
    summary?: string;
    updatedAt?: string;
  };
  massing?: {
    ok?: boolean;
    sdp_estimee?: number;
    nb_lots?: number;
    updatedAt?: string;
  };
  bilan?: {
    ok?: boolean;
    marge_pct?: number;
    tri_pct?: number;
    ca?: number;
    updatedAt?: string;
  };
};

export type AiSyntheseRequest = {
  snapshot: Snapshot;
  generatedFor?: "banque" | "comite";
  tone?: "banque" | "invest";
  projectType?: string; // LOGEMENT / EHPAD / BUREAUX / etc.
};

export type AiSyntheseResponse = {
  ok: boolean;
  markdown?: string;
  updatedAt?: string;
  model?: string;
  warnings?: string[];
  error?: string;
};
