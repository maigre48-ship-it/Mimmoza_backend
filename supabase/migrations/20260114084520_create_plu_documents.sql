create table if not exists public.plu_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  commune_insee text not null,
  commune_nom text,
  plu_version_label text,
  source_document text,
  storage_path text,
  raw_json jsonb
);

create index if not exists idx_plu_documents_commune_insee
  on public.plu_documents (commune_insee);

create index if not exists idx_plu_documents_created_at
  on public.plu_documents (created_at);
