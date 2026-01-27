// FILE: supabase/functions/market-study-v1/lib/geo.ts

const EARTH_RADIUS_KM = 6371;

/**
 * Calcule la distance haversine entre deux points (en km)
 */
export function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_KM * c;
}

/**
 * Calcule une bounding box autour d'un point (lat, lon) avec un rayon en km
 */
export function getBbox(
  lat: number,
  lon: number,
  radiusKm: number
): { south: number; west: number; north: number; east: number } {
  const latDelta = radiusKm / 111.32;
  const lonDelta = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));

  return {
    south: lat - latDelta,
    west: lon - lonDelta,
    north: lat + latDelta,
    east: lon + lonDelta,
  };
}

/**
 * Reverse geocoding via Nominatim (OpenStreetMap) — retourne commune + code INSEE si possible
 */
export async function reverseGeocode(
  lat: number,
  lon: number
): Promise<{ commune_nom?: string; commune_insee?: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mimmoza-MarketStudy/1.0",
        Accept: "application/json",
      },
    });

    if (!res.ok) return null;

    const data = await res.json();

    const commune_nom =
      data.address?.city ||
      data.address?.town ||
      data.address?.village ||
      data.address?.municipality ||
      data.name;

    // Nominatim ne renvoie pas directement le code INSEE mais parfois le ref:INSEE dans extratags
    const commune_insee = data.extratags?.["ref:INSEE"] || undefined;

    return { commune_nom, commune_insee };
  } catch {
    return null;
  }
}

/**
 * Geocode une commune par code INSEE via data.gouv.fr (geo.api.gouv.fr)
 */
export async function geocodeByInsee(
  codeInsee: string
): Promise<{ lat: number; lon: number; commune_nom?: string } | null> {
  try {
    const url = `https://geo.api.gouv.fr/communes/${codeInsee}?fields=nom,centre,population,surface`;

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) return null;

    const data = await res.json();

    if (!data.centre?.coordinates) return null;

    // GeoJSON: [lon, lat]
    return {
      lat: data.centre.coordinates[1],
      lon: data.centre.coordinates[0],
      commune_nom: data.nom,
    };
  } catch {
    return null;
  }
}

/**
 * Récupère des infos basiques sur une commune via geo.api.gouv.fr
 */
export async function getCommuneInfo(codeInsee: string): Promise<{
  nom?: string;
  population?: number;
  surface?: number; // km²
  departement?: string;
  region?: string;
} | null> {
  try {
    const url = `https://geo.api.gouv.fr/communes/${codeInsee}?fields=nom,population,surface,codeDepartement,codeRegion,departement,region`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const data = await res.json();

    return {
      nom: data.nom,
      population: data.population,
      surface: data.surface ? data.surface / 100 : undefined, // hectares -> km²
      departement: data.departement?.nom,
      region: data.region?.nom,
    };
  } catch {
    return null;
  }
}

/**
 * Infère le contexte "urban" ou "rural" selon densité/population
 */
export function inferContext(
  population?: number,
  surfaceKm2?: number
): "urban" | "rural" {
  if (!population || !surfaceKm2 || surfaceKm2 === 0) {
    return "urban"; // fallback
  }

  const densite = population / surfaceKm2;

  // Seuil INSEE simplifié: > 300 hab/km² = urbain
  return densite > 300 ? "urban" : "rural";
}