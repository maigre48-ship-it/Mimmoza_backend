-- 1) Index pour accélérer les requêtes sur latitude / longitude
create index if not exists idx_ecoles_fr_lat_lon
    on public.ecoles_fr (latitude, longitude);

-- 2) Fonction pour récupérer les écoles à proximité d'un point
create or replace function public.get_ecoles_proximite(
    lat double precision,
    lng double precision,
    rayon_m integer default 1000
)
returns table (
    uai text,
    nom text,
    type_etablissement text,
    distance_m double precision
)
language sql
as $$
    select
        s.uai,
        s.nom,
        s.type_etablissement,
        s.distance_m
    from (
        select
            e.uai,
            e.nom,
            e.type_etablissement,
            (
                2 * 6371000 * asin(
                    sqrt(
                        sin(radians((e.latitude - lat) / 2))^2 +
                        cos(radians(lat)) * cos(radians(e.latitude)) *
                        sin(radians((e.longitude - lng) / 2))^2
                    )
                )
            ) as distance_m
        from public.ecoles_fr e
        where e.latitude is not null
          and e.longitude is not null
    ) as s
    where s.distance_m <= rayon_m
    order by s.distance_m;
$$;
