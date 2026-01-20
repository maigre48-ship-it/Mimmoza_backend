-- 1) Index pour accélérer les requêtes sur latitude / longitude
DO $$
BEGIN
  IF to_regclass('public.ecoles_fr') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_ecoles_fr_lat_lon ON public.ecoles_fr (latitude, longitude)';
  END IF;
END $$;

-- 2) Fonction pour récupérer les écoles à proximité d'un point
-- Idempotente : si public.ecoles_fr n'existe pas, retourne 0 ligne (et ne casse pas les migrations)
CREATE OR REPLACE FUNCTION public.get_ecoles_proximite(
  lat double precision,
  lng double precision,
  rayon_m integer DEFAULT 1000
)
RETURNS TABLE (
  uai text,
  nom text,
  type_etablissement text,
  distance_m double precision
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_regclass('public.ecoles_fr') IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE $q$
    SELECT
      s.uai,
      s.nom,
      s.type_etablissement,
      s.distance_m
    FROM (
      SELECT
        e.uai,
        e.nom,
        e.type_etablissement,
        (
          2 * 6371000 * asin(
            sqrt(
              sin(radians((e.latitude - $1) / 2))^2 +
              cos(radians($1)) * cos(radians(e.latitude)) *
              sin(radians((e.longitude - $2) / 2))^2
            )
          )
        ) AS distance_m
      FROM public.ecoles_fr e
      WHERE e.latitude IS NOT NULL
        AND e.longitude IS NOT NULL
    ) AS s
    WHERE s.distance_m <= $3
    ORDER BY s.distance_m
  $q$
  USING lat, lng, rayon_m;
END;
$$;