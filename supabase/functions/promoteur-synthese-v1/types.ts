// supabase/functions/promoteur-synthese-v1/types.ts

export type Niveau = "faible" | "modere" | "eleve" | "tres_eleve" | "inconnu";

export type SyntheseContext = {
  project?: {
    project_nature?: string;
    address?: string;
    commune?: string;
    commune_insee?: string;
    parcel_ids?: string[];
    surface_fonciere_m2?: number;
  };

  plu?: {
    zone?: string;
    regles?: Record<string, unknown>;
    faisabilite?: Record<string, unknown>;
  };

  implantation?: {
    scenario?: string;
    metrics?: Record<string, unknown>;
    buildings?: Array<Record<string, unknown>>;
  };

  market?: Record<string, unknown>;
  risks?: Record<string, unknown>;
  terrain3d?: Record<string, unknown>;
};

export type SyntheseGenerateRequest = {
  lang?: "fr" | "en";
  format?: "markdown";
  tone?: "cabinet" | "neutre";
  context: SyntheseContext;
};

export type SyntheseGenerateResponse = {
  success: boolean;
  version: string;
  title: string;
  markdown: string;
  meta?: {
    generated_at: string;
    warnings?: string[];
  };
};
