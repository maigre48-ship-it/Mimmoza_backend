// ============================================================================
// MARKET STUDY PROMOTEUR V1 - LOGEMENT PROVIDER
// ============================================================================
// Données spécifiques aux projets Logement / Résidentiel:
// - Démographie et structure des ménages
// - Marché immobilier local
// - Cadre de vie (écoles, commerces, santé, espaces verts)
// ============================================================================

import type {
  LogementSpecificData,
  DemographieLogementData,
  MarcheImmobilierData,
  Coverage,
  InseeBaseData,
  DvfData,
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
// DEMOGRAPHIE LOGEMENT
// ----------------------------------------------------------------------------

export async function fetchDemographieLogement(
  codeInsee: string | null,
  inseeBase: InseeBaseData | null
): Promise<DemographieLogementData> {
  const empty: DemographieLogementData = {
    menages_total: null,
    taille_moyenne_menage: null,
    pct_proprietaires: null,
    pct_locataires: null,
    pct_logements_vacants: null,
    pct_residences_principales: null,
    age_moyen_population: null,
    coverage: "no_data",
  };

  try {
    const population = inseeBase?.population ?? null;
    const pctProprietaires = inseeBase?.pct_proprietaires ?? null;
    
    if (!population) {
      return empty;
    }
    
    // Estimate household structure based on national averages
    // France average: 2.2 persons per household
    const tailleMoyenneMenage = 2.2;
    const menagesTotal = Math.round(population / tailleMoyenneMenage);
    
    // National averages for housing tenure
    // ~58% owners, ~40% renters, ~2% other
    const pctProprio = pctProprietaires ?? 58;
    const pctLocataires = 100 - pctProprio - 2;
    
    // Vacancy rates vary by area - use department to estimate
    const dept = (codeInsee || inseeBase?.departement || "").slice(0, 2);
    
    // Departments with high vacancy (rural, declining)
    const deptsHighVacancy = new Set(["23", "03", "15", "43", "48", "12", "46", "32", "65", "09", "19", "87"]);
    // Departments with low vacancy (urban, high demand)
    const deptsLowVacancy = new Set(["75", "92", "94", "93", "69", "31", "33", "34", "13", "06", "78", "91"]);
    
    let pctVacants = 8; // National average
    if (deptsHighVacancy.has(dept)) {
      pctVacants = 15;
    } else if (deptsLowVacancy.has(dept)) {
      pctVacants = 5;
    }
    
    const pctResidencesPrincipales = 100 - pctVacants - 10; // 10% secondary residences
    
    // Estimate average age based on department
    // National average: ~42 years
    let ageMoyen = 42;
    const deptsAges = new Set(["23", "03", "15", "43", "48", "12", "46"]);
    const deptsJeunes = new Set(["93", "95", "77", "91", "78", "59", "69", "31", "33", "34"]);
    
    if (deptsAges.has(dept)) {
      ageMoyen = 48;
    } else if (deptsJeunes.has(dept)) {
      ageMoyen = 38;
    }
    
    return {
      menages_total: menagesTotal,
      taille_moyenne_menage: tailleMoyenneMenage,
      pct_proprietaires: pctProprio,
      pct_locataires: pctLocataires,
      pct_logements_vacants: pctVacants,
      pct_residences_principales: pctResidencesPrincipales,
      age_moyen_population: ageMoyen,
      coverage: "ok",
    };
    
  } catch (err) {
    console.error("[fetchDemographieLogement] Error:", err);
    return { ...empty, coverage: "error" };
  }
}

// ----------------------------------------------------------------------------
// MARCHE IMMOBILIER
// ----------------------------------------------------------------------------

export async function fetchMarcheImmobilier(
  dvfData: DvfData | null,
  codeInsee: string | null
): Promise<MarcheImmobilierData> {
  const empty: MarcheImmobilierData = {
    prix_m2_ancien: null,
    prix_m2_neuf: null,
    evolution_prix_5ans_pct: null,
    delai_vente_moyen_jours: null,
    stock_biens_vente: null,
    coverage: "no_data",
  };

  try {
    if (!dvfData) {
      return empty;
    }
    
    // DVF data is for existing properties
    const prixM2Ancien = dvfData.prix_m2_median;
    
    // Estimate new build price (typically 15-30% higher than existing)
    let prixM2Neuf: number | null = null;
    if (prixM2Ancien) {
      // Premium varies by market tension
      const dept = (codeInsee || "").slice(0, 2);
      const deptsTendus = new Set(["75", "92", "94", "93", "69", "31", "33", "34", "13", "06", "78", "91", "95"]);
      
      const premium = deptsTendus.has(dept) ? 1.20 : 1.25;
      prixM2Neuf = Math.round(prixM2Ancien * premium);
    }
    
    // Use DVF evolution if available
    const evolutionPrix = dvfData.evolution_prix_pct;
    
    // Estimate average sale time based on market activity
    let delaiVenteMoyen: number | null = null;
    if (dvfData.nb_transactions > 0) {
      if (dvfData.nb_transactions >= 20) {
        delaiVenteMoyen = 60; // Active market, quick sales
      } else if (dvfData.nb_transactions >= 10) {
        delaiVenteMoyen = 90;
      } else {
        delaiVenteMoyen = 120; // Slower market
      }
      
      // Adjust for price evolution
      if (evolutionPrix !== null) {
        if (evolutionPrix > 5) delaiVenteMoyen -= 20; // Rising market = faster sales
        else if (evolutionPrix < -5) delaiVenteMoyen += 30; // Declining = slower
      }
      
      delaiVenteMoyen = Math.max(30, Math.min(180, delaiVenteMoyen));
    }
    
    return {
      prix_m2_ancien: prixM2Ancien,
      prix_m2_neuf: prixM2Neuf,
      evolution_prix_5ans_pct: evolutionPrix,
      delai_vente_moyen_jours: delaiVenteMoyen,
      stock_biens_vente: null, // Would need real estate listing API
      coverage: "ok",
    };
    
  } catch (err) {
    console.error("[fetchMarcheImmobilier] Error:", err);
    return { ...empty, coverage: "error" };
  }
}

// ----------------------------------------------------------------------------
// CADRE DE VIE
// ----------------------------------------------------------------------------

export async function fetchCadreVie(
  lat: number,
  lon: number,
  bpeData: BpeData | null
): Promise<LogementSpecificData["cadre_vie"]> {
  const result = {
    score_ecoles: null as number | null,
    score_commerces: null as number | null,
    score_sante: null as number | null,
    score_espaces_verts: null as number | null,
    score_securite: null as number | null,
  };

  try {
    // Use BPE data for education, commerce, health scores
    if (bpeData) {
      result.score_ecoles = bpeData.education?.score ?? null;
      result.score_commerces = bpeData.commerces?.score ?? null;
      result.score_sante = bpeData.sante?.score ?? null;
    }
    
    // Fetch green spaces from Overpass
    const radiusM = 1500; // 1.5km for quality of life amenities
    
    const query = `
      [out:json][timeout:15];
      (
        // Parks and gardens
        node["leisure"~"park|garden|nature_reserve"](around:${radiusM},${lat},${lon});
        way["leisure"~"park|garden|nature_reserve"](around:${radiusM},${lat},${lon});
        
        // Green spaces
        way["landuse"~"forest|grass|meadow"](around:${radiusM},${lat},${lon});
        
        // Sports facilities
        node["leisure"~"sports_centre|swimming_pool|fitness_centre|playground"](around:${radiusM},${lat},${lon});
        way["leisure"~"sports_centre|swimming_pool|playground"](around:${radiusM},${lat},${lon});
        
        // Police stations (for security)
        node["amenity"~"police"](around:${radiusM},${lat},${lon});
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
      
      let parksCount = 0;
      let greenSpacesCount = 0;
      let sportsCount = 0;
      let policeCount = 0;
      
      for (const el of elements) {
        const elLat = el.lat || el.center?.lat;
        const elLon = el.lon || el.center?.lon;
        if (!elLat || !elLon) continue;
        
        const dist = haversineDistance(lat, lon, elLat, elLon);
        if (dist > radiusM) continue;
        
        const tags = el.tags || {};
        const leisure = tags.leisure || "";
        const landuse = tags.landuse || "";
        const amenity = tags.amenity || "";
        
        if (leisure === "park" || leisure === "garden" || leisure === "nature_reserve") {
          parksCount++;
        }
        if (landuse === "forest" || landuse === "grass" || landuse === "meadow") {
          greenSpacesCount++;
        }
        if (leisure === "sports_centre" || leisure === "swimming_pool" || leisure === "fitness_centre" || leisure === "playground") {
          sportsCount++;
        }
        if (amenity === "police") {
          policeCount++;
        }
      }
      
      // Calculate green spaces score
      let scoreVerts = 30; // Base score
      if (parksCount >= 3) scoreVerts += 40;
      else if (parksCount >= 1) scoreVerts += 25;
      if (greenSpacesCount >= 2) scoreVerts += 20;
      if (sportsCount >= 2) scoreVerts += 10;
      result.score_espaces_verts = Math.min(100, scoreVerts);
      
      // Security score (simplified)
      let scoreSecurite = 60; // Base score (neutral)
      if (policeCount >= 1) scoreSecurite += 15;
      // In reality, would use crime statistics
      result.score_securite = Math.min(100, scoreSecurite);
    }
    
    return result;
    
  } catch (err) {
    console.error("[fetchCadreVie] Error:", err);
    return result;
  }
}

// ----------------------------------------------------------------------------
// INDICATEURS MARCHE LOGEMENT
// ----------------------------------------------------------------------------

function computeIndicateursMarche(
  demographie: DemographieLogementData,
  marche: MarcheImmobilierData,
  cadreVie: LogementSpecificData["cadre_vie"]
): LogementSpecificData["indicateurs_marche"] {
  // Determine rental market tension
  let tensionLocative: "forte" | "moyenne" | "faible" | null = null;
  
  const pctVacants = demographie.pct_logements_vacants;
  const evolutionPrix = marche.evolution_prix_5ans_pct;
  
  if (pctVacants !== null && evolutionPrix !== null) {
    if (pctVacants < 6 && evolutionPrix > 3) {
      tensionLocative = "forte";
    } else if (pctVacants > 12 || evolutionPrix < -3) {
      tensionLocative = "faible";
    } else {
      tensionLocative = "moyenne";
    }
  } else if (pctVacants !== null) {
    if (pctVacants < 6) tensionLocative = "forte";
    else if (pctVacants > 12) tensionLocative = "faible";
    else tensionLocative = "moyenne";
  }
  
  // Determine family attractiveness
  let attractiviteFamiliale: "forte" | "moyenne" | "faible" | null = null;
  
  let scoreFamille = 50;
  
  // Schools impact
  if (cadreVie.score_ecoles !== null) {
    if (cadreVie.score_ecoles >= 70) scoreFamille += 20;
    else if (cadreVie.score_ecoles >= 50) scoreFamille += 10;
    else if (cadreVie.score_ecoles < 30) scoreFamille -= 15;
  }
  
  // Green spaces impact
  if (cadreVie.score_espaces_verts !== null) {
    if (cadreVie.score_espaces_verts >= 70) scoreFamille += 15;
    else if (cadreVie.score_espaces_verts < 40) scoreFamille -= 10;
  }
  
  // Safety impact
  if (cadreVie.score_securite !== null) {
    if (cadreVie.score_securite >= 70) scoreFamille += 10;
    else if (cadreVie.score_securite < 40) scoreFamille -= 15;
  }
  
  // Commerce impact
  if (cadreVie.score_commerces !== null) {
    if (cadreVie.score_commerces >= 70) scoreFamille += 10;
    else if (cadreVie.score_commerces < 30) scoreFamille -= 10;
  }
  
  // Age of population
  if (demographie.age_moyen_population !== null) {
    if (demographie.age_moyen_population < 40) scoreFamille += 10; // Younger = more families
    else if (demographie.age_moyen_population > 48) scoreFamille -= 10;
  }
  
  if (scoreFamille >= 70) {
    attractiviteFamiliale = "forte";
  } else if (scoreFamille >= 45) {
    attractiviteFamiliale = "moyenne";
  } else {
    attractiviteFamiliale = "faible";
  }
  
  return {
    tension_locative: tensionLocative,
    attractivite_familiale: attractiviteFamiliale,
  };
}

// ----------------------------------------------------------------------------
// MAIN LOGEMENT DATA FETCH
// ----------------------------------------------------------------------------

export interface FetchLogementDataOptions {
  lat: number;
  lon: number;
  radiusKm: number;
  codeInsee: string | null;
  inseeBase: InseeBaseData | null;
  dvfData: DvfData | null;
  bpeData: BpeData | null;
}

export async function fetchLogementSpecificData(options: FetchLogementDataOptions): Promise<{
  data: LogementSpecificData;
  timings: Record<string, number>;
}> {
  const { lat, lon, codeInsee, inseeBase, dvfData, bpeData } = options;
  const timings: Record<string, number> = {};
  
  // Fetch all specific data in parallel
  const [demographieResult, marcheResult, cadreVieResult] = await Promise.all([
    (async () => {
      const t0 = Date.now();
      const result = await fetchDemographieLogement(codeInsee, inseeBase);
      timings.demographie_logement = Date.now() - t0;
      return result;
    })(),
    (async () => {
      const t0 = Date.now();
      const result = await fetchMarcheImmobilier(dvfData, codeInsee);
      timings.marche_immobilier = Date.now() - t0;
      return result;
    })(),
    (async () => {
      const t0 = Date.now();
      const result = await fetchCadreVie(lat, lon, bpeData);
      timings.cadre_vie = Date.now() - t0;
      return result;
    })(),
  ]);
  
  // Compute market indicators
  const indicateurs = computeIndicateursMarche(demographieResult, marcheResult, cadreVieResult);
  
  return {
    data: {
      demographie: demographieResult,
      marche_immobilier: marcheResult,
      cadre_vie: cadreVieResult,
      indicateurs_marche: indicateurs,
    },
    timings,
  };
}