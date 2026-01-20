create table if not exists public.plu_zones_rulesets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  document_id uuid not null references public.plu_documents(id) on delete cascade,
  commune_insee text not null,
  zone_code text not null,
  zone_libelle text,
  ruleset jsonb not null
);

create index if not exists idx_plu_zones_rulesets_document
  on public.plu_zones_rulesets (document_id);

create index if not exists idx_plu_zones_rulesets_commune_zone
  on public.plu_zones_rulesets (commune_insee, zone_code);
