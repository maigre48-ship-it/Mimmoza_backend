-- supabase/migrations/20251228_create_promoteur_terrain3d_runs.sql
-- V1: table de persistance des runs terrain 3D (optionnelle)
-- Tu peux la garder en attente tant que le back n'est pas branchÃ©.

create table if not exists public.promoteur_terrain3d_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  parcel_id text,
  commune_insee text,

  params jsonb,
  stats jsonb,
  volumes jsonb,
  costs jsonb,
  coverage jsonb
);

create index if not exists idx_promoteur_terrain3d_runs_parcel
on public.promoteur_terrain3d_runs (parcel_id);
