// ============================================================================
// MARKET STUDY PROMOTEUR V1 - HOTEL PROVIDER
// ============================================================================
// Données spécifiques aux projets Hôtellerie:
// - Tourisme (sites touristiques, fréquentation)
// - Concurrence hôtelière
// - Événementiel et affaires
// ============================================================================

import type {
  HotelSpecificData,
  TourismeData,
  ConcurrenceHotelData,
  Coverage,
  InseeBaseData,
  TransportData,
} from "../types.ts";

// ----------------------------------------------------------------------------
// CONSTANTS
// ----------------------------------------------------------------------------

const OVERPASS_API_URL = "https://overpass-api.de/api/interpreter";

// ----------------------------------------------------------------------------
// UTILITY FUNCTIONS
// ----------------------------------------------------------------------------

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function safeNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return isNaN(val) ? null : val;
  if (typeof val === "string") {
    const parsed = parseFloat(val.replace(",", ".").replace(/\s/g, ""));
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

// ----------------------------------------------------------------------------
// TOURISME
// ----------------------------------------------------------------------------

export async function fetchTourisme(
  lat: number,
  lon: number,
  radiusKm: number
): Promise<TourismeData> {
  const empty: TourismeData = {
    sites_touristiques_count: 0,
    monuments_historiques: 0,
    musees: 0,
    parcs_attractions: 0,
    zone_touristique: false,
    frequentation_annuelle_estimee: null,
    coverage: "no_data",
  };

  try {
    const radiusM = Math.round(radiusKm * 1000);
    
    const query = `
      [out:json][timeout:25];
      (
        // Tourist attractions
        node["tourism"~"attraction|museum|gallery|theme_park|zoo|aquarium|viewpoint"](around:${radiusM},${lat},${lon});
        way["tourism"~"attraction|museum|gallery|theme_park|zoo"](around:${radiusM},${lat},${lon});
        
        // Historic monuments
        node["historic"~"monument|castle|ruins|memorial|archaeological_site"](around:${radiusM},${lat},${lon});
        way["historic"~"monument|castle|ruins|memorial"](around:${radiusM},${lat},${lon});
        
        // Cultural venues
        node["amenity"~"theatre|cinema|arts_centre|conference_centre"](around:${radiusM},${lat},${lon});
        way["amenity"~"theatre|cinema|arts_centre|conference_centre"](around:${radiusM},${lat},${lon});
        
        // Sports venues
        node["leisure"~"stadium|sports_centre"](around:${radiusM},${lat},${lon});
        way["leisure"~"stadium|sports_centre"](around:${radiusM},${lat},${lon});
        
        // Beach resorts
        node["natural"="beach"](around:${radiusM},${lat},${lon});
        way["natural"="beach"](around:${radiusM},${lat},${lon});
        
        // Ski resorts
        node["landuse"="winter_sports"](around:${radiusM},${lat},${lon});
        way["landuse"="winter_sports"](around:${radiusM},${lat},${lon});
      );
      out center tags;
    `;
    
    const res = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(25000),
    });
    
    if (!res.ok) {
      console.warn("[fetchTourisme] Overpass error:", res.status);
      return { ...empty, coverage: "error" };
    }
    
    const data = await res.json();
    const elements = data.elements || [];
    
    let sitesTouristiques = 0;
    let monumentsHistoriques = 0;
    let musees = 0;
    let parcsAttractions = 0;
    let hasBeach = false;
    let hasSki = false;
    let hasMajorVenue = false;
    
    for (const el of elements) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;
      
      const dist = haversineDistance(lat, lon, elLat, elLon);
      if (dist > radiusM) continue;
      
      const tags = el.tags || {};
      const tourism = tags.tourism || "";
      const historic = tags.historic || "";
      const amenity = tags.amenity || "";
      const leisure = tags.leisure || "";
      const natural = tags.natural || "";
      const landuse = tags.landuse || "";
      
      // Count by type
      if (tourism === "museum" || tourism === "gallery") {
        musees++;
        sitesTouristiques++;
      } else if (tourism === "theme_park" || tourism === "zoo" || tourism === "aquarium") {
        parcsAttractions++;
        sitesTouristiques++;
      } else if (tourism === "attraction" || tourism === "viewpoint") {
        sitesTouristiques++;
      }
      
      if (historic) {
        monumentsHistoriques++;
        sitesTouristiques++;
      }
      
      if (amenity === "theatre" || amenity === "conference_centre") {
        hasMajorVenue = true;
      }
      
      if (leisure === "stadium") {
        hasMajorVenue = true;
      }
      
      if (natural === "beach") {
        hasBeach = true;
      }
      
      if (landuse === "winter_sports") {
        hasSki = true;
      }
    }
    
    // Determine if tourist zone
    const zoneTouristique = sitesTouristiques >= 5 || hasBeach || hasSki || parcsAttractions > 0;
    
    // Estimate annual visitors (very rough estimate)
    let frequentationEstimee: number | null = null;
    if (zoneTouristique) {
      let baseVisitors = sitesTouristiques * 50000;
      if (hasBeach) baseVisitors += 500000;
      if (hasSki) baseVisitors += 300000;
      if (parcsAttractions > 0) baseVisitors += parcsAttractions * 200000;
      if (hasMajorVenue) baseVisitors += 200000;
      frequentationEstimee = baseVisitors;
    }
    
    return {
      sites_touristiques_count: sitesTouristiques,
      monuments_historiques: monumentsHistoriques,
      musees,
      parcs_attractions: parcsAttractions,
      zone_touristique: zoneTouristique,
      frequentation_annuelle_estimee: frequentationEstimee,
      coverage: "ok",
    };
    
  } catch (err) {
    console.error("[fetchTourisme] Error:", err);
    return { ...empty, coverage: "error" };
  }
}

// ----------------------------------------------------------------------------
// CONCURRENCE HOTELIERE
// ----------------------------------------------------------------------------

export async function fetchConcurrenceHotels(
  lat: number,
  lon: number,
  radiusKm: number
): Promise<ConcurrenceHotelData> {
  const empty: ConcurrenceHotelData = {
    hotels_zone: 0,
    chambres_total: 0,
    etoiles_moyenne: null,
    taux_occupation_moyen_pct: null,
    prix_moyen_nuitee: null,
    coverage: "no_data",
  };

  try {
    const radiusM = Math.round(radiusKm * 1000);
    
    const query = `
      [out:json][timeout:20];
      (
        node["tourism"="hotel"](around:${radiusM},${lat},${lon});
        way["tourism"="hotel"](around:${radiusM},${lat},${lon});
        node["tourism"="motel"](around:${radiusM},${lat},${lon});
        way["tourism"="motel"](around:${radiusM},${lat},${lon});
        node["tourism"="guest_house"](around:${radiusM},${lat},${lon});
        way["tourism"="guest_house"](around:${radiusM},${lat},${lon});
        node["tourism"="hostel"](around:${radiusM},${lat},${lon});
        way["tourism"="hostel"](around:${radiusM},${lat},${lon});
      );
      out center tags;
    `;
    
    const res = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(20000),
    });
    
    if (!res.ok) {
      console.warn("[fetchConcurrenceHotels] Overpass error:", res.status);
      return { ...empty, coverage: "error" };
    }
    
    const data = await res.json();
    const elements = data.elements || [];
    
    let hotelCount = 0;
    let totalChambres = 0;
    const etoilesList: number[] = [];
    
    for (const el of elements) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;
      
      const dist = haversineDistance(lat, lon, elLat, elLon);
      if (dist > radiusM) continue;
      
      const tags = el.tags || {};
      const tourism = tags.tourism || "";
      
      if (tourism === "hotel" || tourism === "motel") {
        hotelCount++;
        
        // Get room count if available
        const rooms = safeNumber(tags.rooms || tags.capacity);
        if (rooms) {
          totalChambres += rooms;
        } else {
          // Estimate based on typical hotel size
          totalChambres += 50;
        }
        
        // Get star rating
        const stars = safeNumber(tags.stars);
        if (stars && stars >= 1 && stars <= 5) {
          etoilesList.push(stars);
        }
      } else if (tourism === "guest_house" || tourism === "hostel") {
        hotelCount++;
        const rooms = safeNumber(tags.rooms || tags.beds);
        totalChambres += rooms || 15;
      }
    }
    
    // Calculate average stars
    const etoilesMoyenne = etoilesList.length > 0
      ? Math.round((etoilesList.reduce((a, b) => a + b, 0) / etoilesList.length) * 10) / 10
      : null;
    
    // Estimate average nightly rate based on stars and location
    let prixMoyenNuitee: number | null = null;
    if (etoilesMoyenne !== null) {
      // Base price by star rating
      const basePrix: Record<number, number> = { 1: 50, 2: 70, 3: 100, 4: 150, 5: 250 };
      prixMoyenNuitee = basePrix[Math.round(etoilesMoyenne)] || 100;
    } else if (hotelCount > 0) {
      prixMoyenNuitee = 90; // Default estimate
    }
    
    // Estimate occupancy based on competition density
    let tauxOccupation: number | null = null;
    if (hotelCount > 0) {
      const areaKm2 = Math.PI * radiusKm * radiusKm;
      const densiteHotels = hotelCount / areaKm2;
      
      if (densiteHotels > 5) {
        tauxOccupation = 75; // Competitive market, good occupancy
      } else if (densiteHotels > 2) {
        tauxOccupation = 65;
      } else {
        tauxOccupation = 55; // Less developed market
      }
    }
    
    return {
      hotels_zone: hotelCount,
      chambres_total: totalChambres,
      etoiles_moyenne: etoilesMoyenne,
      taux_occupation_moyen_pct: tauxOccupation,
      prix_moyen_nuitee: prixMoyenNuitee,
      coverage: "ok",
    };
    
  } catch (err) {
    console.error("[fetchConcurrenceHotels] Error:", err);
    return { ...empty, coverage: "error" };
  }
}

// ----------------------------------------------------------------------------
// EVENEMENTIEL
// ----------------------------------------------------------------------------

export async function fetchEvenementiel(
  lat: number,
  lon: number,
  radiusKm: number
): Promise<HotelSpecificData["evenementiel"]> {
  const result = {
    salles_conference: 0,
    palais_congres: false,
    stades_salles_spectacle: 0,
  };

  try {
    const radiusM = Math.round(radiusKm * 1000);
    
    const query = `
      [out:json][timeout:15];
      (
        // Conference centers
        node["amenity"="conference_centre"](around:${radiusM},${lat},${lon});
        way["amenity"="conference_centre"](around:${radiusM},${lat},${lon});
        node["amenity"="exhibition_centre"](around:${radiusM},${lat},${lon});
        way["amenity"="exhibition_centre"](around:${radiusM},${lat},${lon});
        
        // Event venues
        node["amenity"="events_venue"](around:${radiusM},${lat},${lon});
        way["amenity"="events_venue"](around:${radiusM},${lat},${lon});
        
        // Stadiums and arenas
        node["leisure"="stadium"](around:${radiusM},${lat},${lon});
        way["leisure"="stadium"](around:${radiusM},${lat},${lon});
        node["building"="stadium"](around:${radiusM},${lat},${lon});
        way["building"="stadium"](around:${radiusM},${lat},${lon});
        
        // Concert halls
        node["amenity"~"theatre|music_venue"](around:${radiusM},${lat},${lon});
        way["amenity"~"theatre|music_venue"](around:${radiusM},${lat},${lon});
      );
      out center tags;
    `;
    
    const res = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15000),
    });
    
    if (!res.ok) {
      return result;
    }
    
    const data = await res.json();
    const elements = data.elements || [];
    
    for (const el of elements) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;
      
      const dist = haversineDistance(lat, lon, elLat, elLon);
      if (dist > radiusM) continue;
      
      const tags = el.tags || {};
      const amenity = tags.amenity || "";
      const leisure = tags.leisure || "";
      const building = tags.building || "";
      
      if (amenity === "conference_centre" || amenity === "events_venue") {
        result.salles_conference++;
        // Check if it's a major congress center
        const name = (tags.name || "").toLowerCase();
        if (name.includes("palais") || name.includes("congrès") || name.includes("congress") || name.includes("convention")) {
          result.palais_congres = true;
        }
      }
      
      if (amenity === "exhibition_centre") {
        result.palais_congres = true;
      }
      
      if (leisure === "stadium" || building === "stadium" || amenity === "theatre" || amenity === "music_venue") {
        result.stades_salles_spectacle++;
      }
    }
    
    return result;
    
  } catch (err) {
    console.error("[fetchEvenementiel] Error:", err);
    return result;
  }
}

// ----------------------------------------------------------------------------
// INDICATEURS MARCHE HOTEL
// ----------------------------------------------------------------------------

function computeIndicateursMarche(
  tourisme: TourismeData,
  concurrence: ConcurrenceHotelData,
  evenementiel: HotelSpecificData["evenementiel"],
  transportScore: number | null
): HotelSpecificData["indicateurs_marche"] {
  // Calculate RevPAR estimate (Revenue Per Available Room)
  let revparZone: number | null = null;
  
  if (concurrence.prix_moyen_nuitee && concurrence.taux_occupation_moyen_pct) {
    revparZone = Math.round(concurrence.prix_moyen_nuitee * (concurrence.taux_occupation_moyen_pct / 100));
  }
  
  // Determine business potential
  let potentielAffaires: "fort" | "moyen" | "faible" | null = null;
  
  let scoreAffaires = 0;
  if (evenementiel.palais_congres) scoreAffaires += 30;
  if (evenementiel.salles_conference >= 3) scoreAffaires += 20;
  else if (evenementiel.salles_conference >= 1) scoreAffaires += 10;
  if (transportScore && transportScore >= 70) scoreAffaires += 20;
  if (evenementiel.stades_salles_spectacle >= 2) scoreAffaires += 15;
  
  if (scoreAffaires >= 50) {
    potentielAffaires = "fort";
  } else if (scoreAffaires >= 25) {
    potentielAffaires = "moyen";
  } else {
    potentielAffaires = "faible";
  }
  
  // Determine tourism potential
  let potentielTourisme: "fort" | "moyen" | "faible" | null = null;
  
  let scoreTourisme = 0;
  if (tourisme.zone_touristique) scoreTourisme += 30;
  if (tourisme.sites_touristiques_count >= 10) scoreTourisme += 25;
  else if (tourisme.sites_touristiques_count >= 5) scoreTourisme += 15;
  else if (tourisme.sites_touristiques_count >= 2) scoreTourisme += 10;
  if (tourisme.parcs_attractions > 0) scoreTourisme += 20;
  if (tourisme.musees >= 3) scoreTourisme += 15;
  if (tourisme.monuments_historiques >= 3) scoreTourisme += 10;
  
  if (scoreTourisme >= 50) {
    potentielTourisme = "fort";
  } else if (scoreTourisme >= 25) {
    potentielTourisme = "moyen";
  } else {
    potentielTourisme = "faible";
  }
  
  return {
    revpar_zone: revparZone,
    potentiel_affaires: potentielAffaires,
    potentiel_tourisme: potentielTourisme,
  };
}

// ----------------------------------------------------------------------------
// MAIN HOTEL DATA FETCH
// ----------------------------------------------------------------------------

export interface FetchHotelDataOptions {
  lat: number;
  lon: number;
  radiusKm: number;
  codeInsee: string | null;
  inseeBase: InseeBaseData | null;
  transportData: TransportData | null;
}

export async function fetchHotelSpecificData(options: FetchHotelDataOptions): Promise<{
  data: HotelSpecificData;
  timings: Record<string, number>;
}> {
  const { lat, lon, radiusKm, transportData } = options;
  const timings: Record<string, number> = {};
  
  // Fetch all specific data in parallel
  const [tourismeResult, concurrenceResult, evenementielResult] = await Promise.all([
    (async () => {
      const t0 = Date.now();
      const result = await fetchTourisme(lat, lon, radiusKm);
      timings.tourisme = Date.now() - t0;
      return result;
    })(),
    (async () => {
      const t0 = Date.now();
      const result = await fetchConcurrenceHotels(lat, lon, radiusKm);
      timings.concurrence_hotels = Date.now() - t0;
      return result;
    })(),
    (async () => {
      const t0 = Date.now();
      const result = await fetchEvenementiel(lat, lon, radiusKm);
      timings.evenementiel = Date.now() - t0;
      return result;
    })(),
  ]);
  
  // Compute market indicators
  const indicateurs = computeIndicateursMarche(
    tourismeResult,
    concurrenceResult,
    evenementielResult,
    transportData?.score ?? null
  );
  
  return {
    data: {
      tourisme: tourismeResult,
      concurrence_hotels: concurrenceResult,
      evenementiel: evenementielResult,
      indicateurs_marche: indicateurs,
    },
    timings,
  };
}