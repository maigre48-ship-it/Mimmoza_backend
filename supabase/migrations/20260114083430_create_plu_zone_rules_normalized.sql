-- Create table: plu_zone_rules_normalized
-- Purpose: store normalized, numeric PLU rules by zone for a given document

create table if not exists public.plu_zone_rules_normalized (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  commune_insee text not null,
  zone_code text not null,
  zone_libelle text,
  rules jsonb not null,
  confidence_score integer not null check (confidence_score >= 0 and confidence_score <= 100),
  source text not null default 'heuristic_v1',
  created_at timestamptz not null default now()
);

-- helpful index for lookups by commune + zone
create index if not exists idx_plu_zone_rules_norm_commune_zone
  on public.plu_zone_rules_normalized (commune_insee, zone_code);

-- helpful index for lookups by document
create index if not exists idx_plu_zone_rules_norm_document
  on public.plu_zone_rules_normalized (document_id);

-- unique: one row per document + zone (enforced when overwriting)
create unique index if not exists ux_plu_zone_rules_norm_document_zone
  on public.plu_zone_rules_normalized (document_id, zone_code);
