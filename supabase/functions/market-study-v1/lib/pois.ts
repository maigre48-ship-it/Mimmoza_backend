// FILE: supabase/functions/market-study-v1/lib/pois.ts

import type {
  Poi,
  PoiCategory,
  PoisData,
  Kpis,
  OverpassResponse,
  OverpassElement,
} from "./types.ts";
import { haversine, getBbox } from "./geo.ts";

const OVERPASS_API = "https://overpass-api.de/api/interpreter";
const OVERPASS_TIMEOUT = 25; // secondes

/**
 * Configuration des catégories de POI avec leurs tags OSM
 */
const POI_CATEGORIES: Record<
  PoiCategory,
  { query: string; label: string }
> = {
  commerces: {
    query: `node["shop"]["shop"!="vacant"];way["shop"]["shop"!="vacant"];`,
    label: "Commerces",
  },
  medecins: {
    query: `node["amenity"="doctors"];node["healthcare"="doctor"];`,
    label: "Médecins généralistes",
  },
  infirmiers: {
    query: `node["healthcare"="nurse"];node["amenity"="nursing_home"];`,
    label: "Infirmiers",
  },
  specialistes: {
    query: `node["healthcare"="centre"];node["healthcare"="clinic"];node["healthcare:speciality"];`,
    label: "Spécialistes",
  },
  pharmacies: {
    query: `node["amenity"="pharmacy"];way["amenity"="pharmacy"];`,
    label: "Pharmacies",
  },
  hopitaux: {
    query: `node["amenity"="hospital"];way["amenity"="hospital"];node["amenity"="clinic"];way["amenity"="clinic"];`,
    label: "Hôpitaux / Cliniques",
  },
  gendarmerie_police: {
    query: `node["amenity"="police"];way["amenity"="police"];`,
    label: "Gendarmerie / Police",
  },
  ecoles: {
    query: `node["amenity"="school"];way["amenity"="school"];node["amenity"="college"];way["amenity"="college"];node["amenity"="university"];way["amenity"="university"];`,
    label: "Écoles / Collèges / Lycées",
  },
  creches: {
    query: `node["amenity"="kindergarten"];way["amenity"="kindergarten"];node["amenity"="childcare"];`,
    label: "Crèches / Garderies",
  },
  stations_service: {
    query: `node["amenity"="fuel"];way["amenity"="fuel"];`,
    label: "Stations-service",
  },
  banques: {
    query: `node["amenity"="bank"];way["amenity"="bank"];node["amenity"="atm"];`,
    label: "Banques / DAB",
  },
};

/**
 * Construit une requête Overpass optimisée pour une bounding box
 */
function buildOverpassQuery(
  bbox: { south: number; west: number; north: number; east: number },
  categories: PoiCategory[]
): string {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;

  let query = `[out:json][timeout:${OVERPASS_TIMEOUT}];(\n`;

  for (const cat of categories) {
    const conf = POI_CATEGORIES[cat];
    if (conf) {
      // Ajouter le filtre bbox à chaque élément
      const lines = conf.query
        .split(";")
        .filter((l) => l.trim())
        .map((l) => `${l}(${bboxStr});`)
        .join("\n");
      query += lines + "\n";
    }
  }

  query += `);out center ${500};\n`; // Limite à 500 résultats max

  return query;
}

/**
 * Catégorise un élément OSM selon ses tags
 */
function categorizeElement(element: OverpassElement): PoiCategory | null {
  const tags = element.tags || {};

  // Ordre de priorité pour la catégorisation
  if (tags.amenity === "pharmacy") return "pharmacies";
  if (tags.amenity === "hospital" || tags.amenity === "clinic") return "hopitaux";
  if (tags.amenity === "police") return "gendarmerie_police";
  if (tags.amenity === "school" || tags.amenity === "college" || tags.amenity === "university") return "ecoles";
  if (tags.amenity === "kindergarten" || tags.amenity === "childcare") return "creches";
  if (tags.amenity === "fuel") return "stations_service";
  if (tags.amenity === "bank" || tags.amenity === "atm") return "banques";
  if (tags.amenity === "doctors" || tags.healthcare === "doctor") return "medecins";
  if (tags.healthcare === "nurse" || tags.amenity === "nursing_home") return "infirmiers";
  if (tags.healthcare === "centre" || tags.healthcare === "clinic" || tags["healthcare:speciality"]) return "specialistes";
  if (tags.shop && tags.shop !== "vacant") return "commerces";

  return null;
}

/**
 * Récupère tous les POIs dans un rayon donné
 */
export async function fetchPois(
  lat: number,
  lon: number,
  radiusKm: number,
  topN: number,
  warnings: string[]
): Promise<{ pois: PoisData; kpis: Kpis }> {
  const categories = Object.keys(POI_CATEGORIES) as PoiCategory[];

  // Initialisation
  const poisByCategory: Record<PoiCategory, Poi[]> = {} as Record<PoiCategory, Poi[]>;
  const counts: Record<PoiCategory, number> = {} as Record<PoiCategory, number>;
  const nearest: Record<PoiCategory, number | null> = {} as Record<PoiCategory, number | null>;

  for (const cat of categories) {
    poisByCategory[cat] = [];
    counts[cat] = 0;
    nearest[cat] = null;
  }

  try {
    const bbox = getBbox(lat, lon, radiusKm);
    const query = buildOverpassQuery(bbox, categories);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const response = await fetch(OVERPASS_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Overpass API error: ${response.status}`);
    }

    const data: OverpassResponse = await response.json();

    // Traiter les éléments
    for (const element of data.elements) {
      const category = categorizeElement(element);
      if (!category) continue;

      // Obtenir les coordonnées
      let elLat: number | undefined;
      let elLon: number | undefined;

      if (element.lat !== undefined && element.lon !== undefined) {
        elLat = element.lat;
        elLon = element.lon;
      } else if (element.center) {
        elLat = element.center.lat;
        elLon = element.center.lon;
      }

      if (elLat === undefined || elLon === undefined) continue;

      // Calculer la distance
      const distance = haversine(lat, lon, elLat, elLon);

      // Vérifier que c'est dans le rayon (la bbox peut déborder)
      if (distance > radiusKm) continue;

      const poi: Poi = {
        id: `${element.type}-${element.id}`,
        category,
        name: element.tags?.name || element.tags?.brand || undefined,
        lat: elLat,
        lon: elLon,
        distance_km: Math.round(distance * 100) / 100,
        tags: element.tags,
      };

      poisByCategory[category].push(poi);
    }

    // Trier par distance et limiter à topN
    for (const cat of categories) {
      poisByCategory[cat].sort((a, b) => a.distance_km - b.distance_km);
      counts[cat] = poisByCategory[cat].length;
      nearest[cat] = poisByCategory[cat][0]?.distance_km ?? null;
      poisByCategory[cat] = poisByCategory[cat].slice(0, topN);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      warnings.push("Overpass: Timeout lors de la requête. Résultats partiels.");
    } else {
      warnings.push(`Overpass: Erreur lors de la requête: ${String(err)}`);
    }
  }

  // Construire la liste "all"
  const allPois: Poi[] = [];
  for (const cat of categories) {
    allPois.push(...poisByCategory[cat]);
  }
  allPois.sort((a, b) => a.distance_km - b.distance_km);

  return {
    pois: {
      categories: poisByCategory,
      all: allPois,
    },
    kpis: {
      counts,
      nearest,
    },
  };
}

/**
 * Retourne les labels des catégories
 */
export function getCategoryLabels(): Record<PoiCategory, string> {
  const labels: Record<PoiCategory, string> = {} as Record<PoiCategory, string>;
  for (const [key, val] of Object.entries(POI_CATEGORIES)) {
    labels[key as PoiCategory] = val.label;
  }
  return labels;
}