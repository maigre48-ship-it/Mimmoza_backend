// ============================================================================
// MARKET STUDY PROMOTEUR V1 - BUREAUX PROVIDER
// ============================================================================
// Données spécifiques aux projets Bureaux / Tertiaire:
// - Bassin d'emploi (emplois, entreprises, secteurs)
// - Offre de bureaux existante
// - Accessibilité professionnelle
// ============================================================================

import type {
  BureauxSpecificData,
  BassinsEmploiData,
  OffreBureauxData,
  Coverage,
  InseeBaseData,
  TransportData,
  BpeData,
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
// BASSIN D'EMPLOI
// ----------------------------------------------------------------------------

export async function fetchBassinEmploi(
  lat: number,
  lon: number,
  radiusKm: number,
  inseeBase: InseeBaseData | null
): Promise<BassinsEmploiData> {
  const empty: BassinsEmploiData = {
    emplois_zone: null,
    entreprises_zone: null,
    taux_chomage_zone: null,
    evolution_emplois_5ans_pct: null,
    secteurs_dominants: [],
    coverage: "no_data",
  };

  try {
    // Estimate employment based on population and department characteristics
    const population = inseeBase?.population ?? null;
    const tauxChomage = inseeBase?.taux_chomage ?? null;
    
    if (!population) {
      return empty;
    }
    
    // Active population ratio (~45% of total population)
    const populationActive = Math.round(population * 0.45);
    
    // Employed = active * (1 - unemployment rate)
    const tauxEmploi = tauxChomage ? (100 - tauxChomage) / 100 : 0.92;
    const emploisEstimes = Math.round(populationActive * tauxEmploi);
    
    // Estimate number of businesses (roughly 1 business per 10 employees on average)
    const entreprisesEstimees = Math.round(emploisEstimes / 10);
    
    // Determine dominant sectors based on department
    const dept = (inseeBase?.departement || "").slice(0, 2);
    let secteursDominants: string[] = [];
    
    // Major business districts
    const deptsServicesFinanciers = new Set(["75", "92", "69", "13", "31", "33"]);
    const deptsIndustrie = new Set(["59", "62", "57", "68", "67", "25", "42", "38"]);
    const deptsTourisme = new Set(["06", "83", "2A", "2B", "73", "74", "64"]);
    const deptsAgricole = new Set(["32", "40", "47", "24", "16", "79", "86", "36", "18", "03"]);
    
    if (deptsServicesFinanciers.has(dept)) {
      secteursDominants = ["Services", "Finance", "Conseil", "Tech"];
    } else if (deptsIndustrie.has(dept)) {
      secteursDominants = ["Industrie", "Logistique", "Services"];
    } else if (deptsTourisme.has(dept)) {
      secteursDominants = ["Tourisme", "Commerce", "Services"];
    } else if (deptsAgricole.has(dept)) {
      secteursDominants = ["Agriculture", "Agroalimentaire", "Services"];
    } else {
      secteursDominants = ["Services", "Commerce", "Administration"];
    }
    
    return {
      emplois_zone: emploisEstimes,
      entreprises_zone: entreprisesEstimees,
      taux_chomage_zone: tauxChomage,
      evolution_emplois_5ans_pct: null, // Would need historical data
      secteurs_dominants: secteursDominants,
      coverage: "ok",
    };
    
  } catch (err) {
    console.error("[fetchBassinEmploi] Error:", err);
    return { ...empty, coverage: "error" };
  }
}

// ----------------------------------------------------------------------------
// OFFRE DE BUREAUX
// ----------------------------------------------------------------------------

export async function fetchOffreBureaux(
  lat: number,
  lon: number,
  radiusKm: number
): Promise<OffreBureauxData> {
  const empty: OffreBureauxData = {
    surfaces_disponibles_m2: null,
    loyer_moyen_m2_an: null,
    taux_vacance_pct: null,
    transactions_recentes: 0,
    coverage: "no_data",
  };

  try {
    const radiusM = Math.round(radiusKm * 1000);
    
    // Query for office buildings
    const query = `
      [out:json][timeout:20];
      (
        node["office"](around:${radiusM},${lat},${lon});
        way["office"](around:${radiusM},${lat},${lon});
        node["building"="office"](around:${radiusM},${lat},${lon});
        way["building"="office"](around:${radiusM},${lat},${lon});
        way["building"="commercial"](around:${radiusM},${lat},${lon});
        node["amenity"="coworking_space"](around:${radiusM},${lat},${lon});
        way["amenity"="coworking_space"](around:${radiusM},${lat},${lon});
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
      console.warn("[fetchOffreBureaux] Overpass error:", res.status);
      return { ...empty, coverage: "error" };
    }
    
    const data = await res.json();
    const elements = data.elements || [];
    
    let officeCount = 0;
    let coworkingCount = 0;
    
    for (const el of elements) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;
      
      const dist = haversineDistance(lat, lon, elLat, elLon);
      if (dist > radiusM) continue;
      
      const tags = el.tags || {};
      
      if (tags.office || tags.building === "office" || tags.building === "commercial") {
        officeCount++;
      }
      if (tags.amenity === "coworking_space") {
        coworkingCount++;
      }
    }
    
    // Estimate market conditions based on office density
    const areaKm2 = Math.PI * radiusKm * radiusKm;
    const densiteBureaux = officeCount / areaKm2;
    
    // Estimate vacancy rate and rent based on density
    let tauxVacance: number | null = null;
    let loyerMoyen: number | null = null;
    
    if (densiteBureaux > 20) {
      // Dense office area - competitive market
      tauxVacance = 8;
      loyerMoyen = 350; // €/m²/year
    } else if (densiteBureaux > 10) {
      // Moderate density
      tauxVacance = 12;
      loyerMoyen = 250;
    } else if (densiteBureaux > 5) {
      // Lower density
      tauxVacance = 15;
      loyerMoyen = 180;
    } else {
      // Sparse office presence
      tauxVacance = 20;
      loyerMoyen = 120;
    }
    
    return {
      surfaces_disponibles_m2: null, // Would need real estate API
      loyer_moyen_m2_an: loyerMoyen,
      taux_vacance_pct: tauxVacance,
      transactions_recentes: officeCount, // Using count as proxy
      coverage: "ok",
    };
    
  } catch (err) {
    console.error("[fetchOffreBureaux] Error:", err);
    return { ...empty, coverage: "error" };
  }
}

// ----------------------------------------------------------------------------
// ACCESSIBILITE PROFESSIONNELLE
// ----------------------------------------------------------------------------

export async function fetchAccessibilitePro(
  lat: number,
  lon: number,
  transportData: TransportData | null
): Promise<BureauxSpecificData["accessibilite_pro"]> {
  const result = {
    temps_centre_ville_min: null as number | null,
    temps_gare_tgv_min: null as number | null,
    temps_aeroport_min: null as number | null,
    parking_proximite: false,
  };

  try {
    const radiusM = 2000; // 2km for accessibility features
    
    // Check for parking and major transport hubs
    const query = `
      [out:json][timeout:15];
      (
        // Parking
        node["amenity"="parking"](around:${radiusM},${lat},${lon});
        way["amenity"="parking"](around:${radiusM},${lat},${lon});
        
        // Major train stations (potential TGV)
        node["railway"="station"]["station"!="subway"](around:10000,${lat},${lon});
        way["railway"="station"]["station"!="subway"](around:10000,${lat},${lon});
        
        // Airports
        node["aeroway"="aerodrome"](around:50000,${lat},${lon});
        way["aeroway"="aerodrome"](around:50000,${lat},${lon});
      );
      out center tags;
    `;
    
    const res = await fetch(OVERPASS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15000),
    });
    
    if (res.ok) {
      const data = await res.json();
      const elements = data.elements || [];
      
      let nearestStation: number | null = null;
      let nearestAirport: number | null = null;
      
      for (const el of elements) {
        const elLat = el.lat || el.center?.lat;
        const elLon = el.lon || el.center?.lon;
        if (!elLat || !elLon) continue;
        
        const dist = haversineDistance(lat, lon, elLat, elLon);
        const tags = el.tags || {};
        
        // Parking within 500m
        if (tags.amenity === "parking" && dist < 500) {
          result.parking_proximite = true;
        }
        
        // Train station
        if (tags.railway === "station") {
          if (nearestStation === null || dist < nearestStation) {
            nearestStation = dist;
          }
        }
        
        // Airport
        if (tags.aeroway === "aerodrome") {
          if (nearestAirport === null || dist < nearestAirport) {
            nearestAirport = dist;
          }
        }
      }
      
      // Convert distances to estimated travel times
      if (nearestStation !== null) {
        // Rough estimate: 2 min per km by car/taxi
        result.temps_gare_tgv_min = Math.round((nearestStation / 1000) * 2);
      }
      
      if (nearestAirport !== null) {
        // Rough estimate: 2.5 min per km by car
        result.temps_aeroport_min = Math.round((nearestAirport / 1000) * 2.5);
      }
    }
    
    // Estimate time to city center based on transport score
    if (transportData?.score) {
      if (transportData.score >= 80) {
        result.temps_centre_ville_min = 10;
      } else if (transportData.score >= 60) {
        result.temps_centre_ville_min = 20;
      } else if (transportData.score >= 40) {
        result.temps_centre_ville_min = 30;
      } else {
        result.temps_centre_ville_min = 45;
      }
    }
    
    return result;
    
  } catch (err) {
    console.error("[fetchAccessibilitePro] Error:", err);
    return result;
  }
}

// ----------------------------------------------------------------------------
// INDICATEURS MARCHE BUREAUX
// ----------------------------------------------------------------------------

function computeIndicateursMarche(
  bassinEmploi: BassinsEmploiData,
  offreBureaux: OffreBureauxData,
  accessibilitePro: BureauxSpecificData["accessibilite_pro"],
  transportScore: number | null
): BureauxSpecificData["indicateurs_marche"] {
  // Determine zone attractiveness
  let attractiviteZone: "forte" | "moyenne" | "faible" | null = null;
  
  let attractiviteScore = 50;
  
  // Transport factor (most important for offices)
  if (transportScore !== null) {
    if (transportScore >= 70) attractiviteScore += 25;
    else if (transportScore >= 50) attractiviteScore += 15;
    else if (transportScore < 30) attractiviteScore -= 20;
  }
  
  // Employment factor
  if (bassinEmploi.emplois_zone && bassinEmploi.emplois_zone > 50000) {
    attractiviteScore += 15;
  } else if (bassinEmploi.emplois_zone && bassinEmploi.emplois_zone < 10000) {
    attractiviteScore -= 10;
  }
  
  // Unemployment factor
  if (bassinEmploi.taux_chomage_zone !== null) {
    if (bassinEmploi.taux_chomage_zone < 7) attractiviteScore += 10;
    else if (bassinEmploi.taux_chomage_zone > 12) attractiviteScore -= 15;
  }
  
  // Accessibility bonus
  if (accessibilitePro.temps_gare_tgv_min && accessibilitePro.temps_gare_tgv_min < 15) {
    attractiviteScore += 10;
  }
  if (accessibilitePro.parking_proximite) {
    attractiviteScore += 5;
  }
  
  if (attractiviteScore >= 70) {
    attractiviteZone = "forte";
  } else if (attractiviteScore >= 45) {
    attractiviteZone = "moyenne";
  } else {
    attractiviteZone = "faible";
  }
  
  // Determine market tension
  let tensionMarche: "tendu" | "equilibre" | "detendu" | null = null;
  
  const tauxVacance = offreBureaux.taux_vacance_pct;
  if (tauxVacance !== null) {
    if (tauxVacance < 8) {
      tensionMarche = "tendu";
    } else if (tauxVacance > 15) {
      tensionMarche = "detendu";
    } else {
      tensionMarche = "equilibre";
    }
  }
  
  return {
    attractivite_zone: attractiviteZone,
    tension_marche: tensionMarche,
  };
}

// ----------------------------------------------------------------------------
// MAIN BUREAUX DATA FETCH
// ----------------------------------------------------------------------------

export interface FetchBureauxDataOptions {
  lat: number;
  lon: number;
  radiusKm: number;
  codeInsee: string | null;
  inseeBase: InseeBaseData | null;
  transportData: TransportData | null;
  bpeData: BpeData | null;
}

export async function fetchBureauxSpecificData(options: FetchBureauxDataOptions): Promise<{
  data: BureauxSpecificData;
  timings: Record<string, number>;
}> {
  const { lat, lon, radiusKm, inseeBase, transportData } = options;
  const timings: Record<string, number> = {};
  
  // Fetch all specific data in parallel
  const [bassinEmploiResult, offreBureauxResult, accessibiliteProResult] = await Promise.all([
    (async () => {
      const t0 = Date.now();
      const result = await fetchBassinEmploi(lat, lon, radiusKm, inseeBase);
      timings.bassin_emploi = Date.now() - t0;
      return result;
    })(),
    (async () => {
      const t0 = Date.now();
      const result = await fetchOffreBureaux(lat, lon, radiusKm);
      timings.offre_bureaux = Date.now() - t0;
      return result;
    })(),
    (async () => {
      const t0 = Date.now();
      const result = await fetchAccessibilitePro(lat, lon, transportData);
      timings.accessibilite_pro = Date.now() - t0;
      return result;
    })(),
  ]);
  
  // Compute market indicators
  const indicateurs = computeIndicateursMarche(
    bassinEmploiResult,
    offreBureauxResult,
    accessibiliteProResult,
    transportData?.score ?? null
  );
  
  return {
    data: {
      bassin_emploi: bassinEmploiResult,
      offre_bureaux: offreBureauxResult,
      accessibilite_pro: accessibiliteProResult,
      indicateurs_marche: indicateurs,
    },
    timings,
  };
}