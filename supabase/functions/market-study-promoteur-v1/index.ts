// ============================================================================
// MARKET STUDY PROMOTEUR V1 - EDGE FUNCTION
// ============================================================================
// Version: 1.0.0
// Description: Étude de marché adaptée au type de projet promoteur
//              Orchestre les différents providers selon le type de projet
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

import type {
  ProjectType,
  MarketStudyRequest,
  MarketStudyResponse,
  CoreMarketData,
  MarketScores,
  MarketInsight,
  EhpadSpecificData,
  EtudiantSpecificData,
  CommerceSpecificData,
  BureauxSpecificData,
  HotelSpecificData,
  LogementSpecificData,
  Coverage,
} from "./types.ts";

import { fetchCoreMarketData, CommuneInfo } from "./providers/core.ts";
import { fetchEhpadSpecificData } from "./providers/ehpad.ts";
import { fetchEtudiantSpecificData } from "./providers/etudiant.ts";
import { fetchCommerceSpecificData } from "./providers/commerce.ts";
import { fetchBureauxSpecificData } from "./providers/bureaux.ts";
import { fetchHotelSpecificData } from "./providers/hotel.ts";
import { fetchLogementSpecificData } from "./providers/logement.ts";

const VERSION = "1.0.0";

// ============================================================================
// CORS HEADERS
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============================================================================
// PROJECT TYPE CONFIGURATION
// ============================================================================

const PROJECT_TYPE_CONFIG: Record<ProjectType, {
  label: string;
  defaultRadiusKm: number;
  maxRadiusKm: number;
}> = {
  logement: { label: "Logement", defaultRadiusKm: 5, maxRadiusKm: 10 },
  commerce: { label: "Commerce", defaultRadiusKm: 3, maxRadiusKm: 5 },
  bureaux: { label: "Bureaux", defaultRadiusKm: 3, maxRadiusKm: 5 },
  hotel: { label: "Hôtel", defaultRadiusKm: 5, maxRadiusKm: 10 },
  etudiant: { label: "Résidence étudiante", defaultRadiusKm: 5, maxRadiusKm: 10 },
  rss: { label: "Résidence seniors", defaultRadiusKm: 15, maxRadiusKm: 25 },
  ehpad: { label: "EHPAD", defaultRadiusKm: 20, maxRadiusKm: 30 },
};

// ============================================================================
// NORMALIZE PROJECT TYPE
// ============================================================================

function normalizeProjectType(input: string | null | undefined): ProjectType {
  if (!input) return "logement";
  
  const n = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  
  if (n === "logement" || n === "habitation" || n === "residential" || n === "appartement") return "logement";
  if (n === "commerce" || n === "retail" || n === "boutique" || n === "local commercial") return "commerce";
  if (n === "bureaux" || n === "bureau" || n === "office") return "bureaux";
  if (n === "hotel" || n === "hotellerie") return "hotel";
  if (n.includes("etudiant") || n.includes("student") || n === "residence etudiante") return "etudiant";
  if (n.includes("senior") || n === "rss" || n === "residence senior" || n === "residence autonomie") return "rss";
  if (n === "ehpad" || n.includes("retraite") || n.includes("dependant")) return "ehpad";
  
  // Partial matches
  if (n.includes("etudiant")) return "etudiant";
  if (n.includes("senior") || n.includes("rss")) return "rss";
  if (n.includes("ehpad")) return "ehpad";
  if (n.includes("hotel")) return "hotel";
  if (n.includes("bureau") || n.includes("office")) return "bureaux";
  if (n.includes("commerce") || n.includes("boutique")) return "commerce";
  
  return "logement";
}

// ============================================================================
// SCORE CALCULATION
// ============================================================================

function computeScores(
  core: CoreMarketData,
  specific: EhpadSpecificData | EtudiantSpecificData | CommerceSpecificData | BureauxSpecificData | HotelSpecificData | LogementSpecificData | null,
  projectType: ProjectType
): MarketScores {
  let demande = 50;
  let offre = 50;
  let accessibilite = 50;
  let environnement = 50;
  
  // Accessibilité from transport
  if (core.transport) {
    accessibilite = core.transport.score;
  }
  
  // Environnement from BPE
  if (core.bpe) {
    environnement = core.bpe.score;
  }
  
  // DVF influence on offre
  if (core.dvf) {
    if (core.dvf.nb_transactions >= 20) offre += 15;
    else if (core.dvf.nb_transactions >= 10) offre += 10;
    else if (core.dvf.nb_transactions < 5) offre -= 10;
    
    if (core.dvf.evolution_prix_pct !== null) {
      if (core.dvf.evolution_prix_pct > 5) offre += 10;
      else if (core.dvf.evolution_prix_pct < -5) offre -= 15;
    }
  }
  
  // INSEE influence on demande
  if (core.insee) {
    if (core.insee.revenu_median && core.insee.revenu_median > 25000) demande += 15;
    else if (core.insee.revenu_median && core.insee.revenu_median < 18000) demande -= 10;
    
    if (core.insee.taux_chomage && core.insee.taux_chomage > 12) demande -= 10;
    else if (core.insee.taux_chomage && core.insee.taux_chomage < 7) demande += 5;
  }
  
  // Specific adjustments
  if (specific) {
    if ((projectType === "ehpad" || projectType === "rss") && "indicateurs_marche" in specific) {
      const ehpadSpecific = specific as EhpadSpecificData;
      const potentiel = ehpadSpecific.indicateurs_marche.potentiel_marche;
      
      if (potentiel === "fort") {
        demande += 20;
        offre += 15;
      } else if (potentiel === "moyen") {
        demande += 10;
      } else if (potentiel === "faible") {
        demande -= 10;
        offre -= 15;
      }
      
      // Adjust for senior demographics
      const pctSeniors = ehpadSpecific.demographie_senior.pct_75_plus;
      if (pctSeniors && pctSeniors > 12) demande += 10;
      else if (pctSeniors && pctSeniors < 8) demande -= 5;
      
      // Adjust for healthcare
      if (ehpadSpecific.offre_sante.desert_medical) {
        environnement -= 15;
      }
    }
    
    if (projectType === "etudiant" && "indicateurs_marche" in specific) {
      const etudiantSpecific = specific as EtudiantSpecificData;
      const potentiel = etudiantSpecific.indicateurs_marche.potentiel_marche;
      
      if (potentiel === "fort") {
        demande += 25;
      } else if (potentiel === "moyen") {
        demande += 10;
      } else if (potentiel === "faible") {
        demande -= 20;
      }
      
      // Bonus for universities nearby
      if (etudiantSpecific.etablissements_sup.total_count >= 3) {
        demande += 15;
      } else if (etudiantSpecific.etablissements_sup.total_count === 0) {
        demande -= 30;
      }
    }
    
    if (projectType === "commerce" && "zone_chalandise" in specific) {
      const commerceSpecific = specific as CommerceSpecificData;
      
      // Adjust for purchasing power
      const pouvoirAchat = commerceSpecific.zone_chalandise.pouvoir_achat_indice;
      if (pouvoirAchat && pouvoirAchat > 110) {
        demande += 15;
      } else if (pouvoirAchat && pouvoirAchat < 90) {
        demande -= 10;
      }
      
      // Adjust for competition
      const concurrence = commerceSpecific.concurrence.indice_concurrence;
      if (concurrence === "faible") {
        offre += 20;
      } else if (concurrence === "fort") {
        offre -= 15;
      }
      
      // Adjust for pedestrian flux
      const fluxScore = commerceSpecific.flux_pietons.score_flux;
      if (fluxScore && fluxScore > 70) {
        demande += 15;
        accessibilite += 10;
      } else if (fluxScore && fluxScore < 40) {
        demande -= 10;
      }
      
      // Bonus for dynamism
      const dynamisme = commerceSpecific.indicateurs_marche.dynamisme_zone;
      if (dynamisme === "fort") {
        demande += 10;
      } else if (dynamisme === "faible") {
        demande -= 15;
      }
    }
    
    if (projectType === "bureaux" && "bassin_emploi" in specific) {
      const bureauxSpecific = specific as BureauxSpecificData;
      
      // Adjust for employment
      const emplois = bureauxSpecific.bassin_emploi.emplois_zone;
      if (emplois && emplois > 50000) {
        demande += 20;
      } else if (emplois && emplois < 10000) {
        demande -= 15;
      }
      
      // Adjust for market tension
      const tension = bureauxSpecific.indicateurs_marche.tension_marche;
      if (tension === "tendu") {
        demande += 15;
        offre -= 10;
      } else if (tension === "detendu") {
        demande -= 10;
        offre += 15;
      }
      
      // Adjust for attractiveness
      const attractivite = bureauxSpecific.indicateurs_marche.attractivite_zone;
      if (attractivite === "forte") {
        demande += 15;
      } else if (attractivite === "faible") {
        demande -= 15;
      }
      
      // Accessibility bonus for offices
      if (bureauxSpecific.accessibilite_pro.parking_proximite) {
        accessibilite += 5;
      }
      if (bureauxSpecific.accessibilite_pro.temps_gare_tgv_min && bureauxSpecific.accessibilite_pro.temps_gare_tgv_min < 20) {
        accessibilite += 10;
      }
    }
    
    if (projectType === "hotel" && "tourisme" in specific) {
      const hotelSpecific = specific as HotelSpecificData;
      
      // Adjust for tourism potential
      const potentielTourisme = hotelSpecific.indicateurs_marche.potentiel_tourisme;
      if (potentielTourisme === "fort") {
        demande += 25;
      } else if (potentielTourisme === "moyen") {
        demande += 10;
      } else if (potentielTourisme === "faible") {
        demande -= 10;
      }
      
      // Adjust for business potential
      const potentielAffaires = hotelSpecific.indicateurs_marche.potentiel_affaires;
      if (potentielAffaires === "fort") {
        demande += 20;
      } else if (potentielAffaires === "moyen") {
        demande += 10;
      }
      
      // Adjust for competition
      const hotels = hotelSpecific.concurrence_hotels.hotels_zone;
      if (hotels > 20) {
        offre -= 15;
      } else if (hotels < 5 && hotelSpecific.tourisme.zone_touristique) {
        offre += 15; // Underserved tourist area
      }
      
      // RevPAR bonus
      const revpar = hotelSpecific.indicateurs_marche.revpar_zone;
      if (revpar && revpar > 80) {
        demande += 10;
      }
    }
    
    if (projectType === "logement" && "demographie" in specific) {
      const logementSpecific = specific as LogementSpecificData;
      
      // Adjust for rental tension
      const tension = logementSpecific.indicateurs_marche.tension_locative;
      if (tension === "forte") {
        demande += 20;
      } else if (tension === "faible") {
        demande -= 15;
      }
      
      // Adjust for family attractiveness
      const attractiviteFamille = logementSpecific.indicateurs_marche.attractivite_familiale;
      if (attractiviteFamille === "forte") {
        environnement += 15;
      } else if (attractiviteFamille === "faible") {
        environnement -= 10;
      }
      
      // Adjust for price evolution
      const evolution = logementSpecific.marche_immobilier.evolution_prix_5ans_pct;
      if (evolution !== null) {
        if (evolution > 5) {
          demande += 15;
        } else if (evolution < -5) {
          demande -= 15;
          offre -= 10;
        }
      }
      
      // Cadre de vie bonuses
      const cadre = logementSpecific.cadre_vie;
      if (cadre.score_ecoles && cadre.score_ecoles >= 70) {
        environnement += 10;
      }
      if (cadre.score_espaces_verts && cadre.score_espaces_verts >= 70) {
        environnement += 10;
      }
    }
  }
  
  // Clamp scores
  demande = Math.max(0, Math.min(100, demande));
  offre = Math.max(0, Math.min(100, offre));
  accessibilite = Math.max(0, Math.min(100, accessibilite));
  environnement = Math.max(0, Math.min(100, environnement));
  
  // Calculate global score with project-specific weights
  let weights = { demande: 0.30, offre: 0.25, accessibilite: 0.25, environnement: 0.20 };
  
  if (projectType === "bureaux" || projectType === "commerce") {
    weights = { demande: 0.25, offre: 0.20, accessibilite: 0.35, environnement: 0.20 };
  } else if (projectType === "ehpad" || projectType === "rss") {
    weights = { demande: 0.40, offre: 0.25, accessibilite: 0.10, environnement: 0.25 };
  } else if (projectType === "etudiant") {
    weights = { demande: 0.40, offre: 0.20, accessibilite: 0.30, environnement: 0.10 };
  }
  
  const global = Math.round(
    demande * weights.demande +
    offre * weights.offre +
    accessibilite * weights.accessibilite +
    environnement * weights.environnement
  );
  
  return { demande, offre, accessibilite, environnement, global };
}

// ============================================================================
// INSIGHTS GENERATION
// ============================================================================

function generateInsights(
  core: CoreMarketData,
  specific: EhpadSpecificData | EtudiantSpecificData | CommerceSpecificData | BureauxSpecificData | HotelSpecificData | LogementSpecificData | null,
  scores: MarketScores,
  projectType: ProjectType
): MarketInsight[] {
  const insights: MarketInsight[] = [];
  
  // General insights
  if (core.dvf && core.dvf.evolution_prix_pct !== null) {
    if (core.dvf.evolution_prix_pct > 5) {
      insights.push({
        type: "positive",
        category: "dvf",
        message: `Marché immobilier dynamique (+${core.dvf.evolution_prix_pct.toFixed(1)}% d'évolution)`,
        data: { evolution_pct: core.dvf.evolution_prix_pct },
      });
    } else if (core.dvf.evolution_prix_pct < -5) {
      insights.push({
        type: "warning",
        category: "dvf",
        message: `Marché immobilier en baisse (${core.dvf.evolution_prix_pct.toFixed(1)}%)`,
        data: { evolution_pct: core.dvf.evolution_prix_pct },
      });
    }
  }
  
  if (core.transport) {
    if (core.transport.has_metro_train) {
      insights.push({
        type: "positive",
        category: "transport",
        message: "Excellente desserte transport (métro/train à proximité)",
      });
    } else if (core.transport.score < 40) {
      insights.push({
        type: "warning",
        category: "transport",
        message: "Accessibilité transport limitée",
      });
    }
  }
  
  if (core.insee) {
    if (core.insee.revenu_median && core.insee.revenu_median > 28000) {
      insights.push({
        type: "positive",
        category: "insee",
        message: `Zone à revenus élevés (médiane ${Math.round(core.insee.revenu_median).toLocaleString()}€)`,
      });
    } else if (core.insee.revenu_median && core.insee.revenu_median < 18000) {
      insights.push({
        type: "warning",
        category: "insee",
        message: `Zone à revenus modestes (médiane ${Math.round(core.insee.revenu_median).toLocaleString()}€)`,
      });
    }
  }
  
  // Project-specific insights
  if (specific) {
    if ((projectType === "ehpad" || projectType === "rss") && "indicateurs_marche" in specific) {
      const ehpadSpecific = specific as EhpadSpecificData;
      
      if (ehpadSpecific.indicateurs_marche.taux_equipement_zone === "sous_equipe") {
        insights.push({
          type: "positive",
          category: "concurrence",
          message: `Zone sous-équipée en ${projectType === "ehpad" ? "EHPAD" : "résidences seniors"} - Fort potentiel`,
          data: { densite_lits: ehpadSpecific.indicateurs_marche.densite_lits_1000_seniors },
        });
      } else if (ehpadSpecific.indicateurs_marche.taux_equipement_zone === "sur_equipe") {
        insights.push({
          type: "warning",
          category: "concurrence",
          message: `Zone déjà bien équipée en ${projectType === "ehpad" ? "EHPAD" : "résidences seniors"}`,
          data: { densite_lits: ehpadSpecific.indicateurs_marche.densite_lits_1000_seniors },
        });
      }
      
      if (ehpadSpecific.demographie_senior.pct_75_plus && ehpadSpecific.demographie_senior.pct_75_plus > 12) {
        insights.push({
          type: "positive",
          category: "demographie",
          message: `Population senior importante (${ehpadSpecific.demographie_senior.pct_75_plus.toFixed(1)}% de 75+)`,
        });
      }
      
      if (ehpadSpecific.offre_sante.desert_medical) {
        insights.push({
          type: "warning",
          category: "sante",
          message: "Zone identifiée comme désert médical",
        });
      }
      
      if (ehpadSpecific.concurrence.count > 0 && ehpadSpecific.concurrence.etablissement_plus_proche_m) {
        insights.push({
          type: "neutral",
          category: "concurrence",
          message: `${ehpadSpecific.concurrence.count} établissement(s) dans la zone, le plus proche à ${Math.round(ehpadSpecific.concurrence.etablissement_plus_proche_m / 100) / 10} km`,
        });
      }
    }
    
    if (projectType === "etudiant" && "etablissements_sup" in specific) {
      const etudiantSpecific = specific as EtudiantSpecificData;
      
      if (etudiantSpecific.etablissements_sup.total_count >= 3) {
        insights.push({
          type: "positive",
          category: "etablissements",
          message: `${etudiantSpecific.etablissements_sup.total_count} établissements d'enseignement supérieur à proximité (~${etudiantSpecific.etablissements_sup.total_etudiants_estimes.toLocaleString()} étudiants)`,
        });
      } else if (etudiantSpecific.etablissements_sup.total_count === 0) {
        insights.push({
          type: "warning",
          category: "etablissements",
          message: "Aucun établissement d'enseignement supérieur identifié à proximité",
        });
      }
      
      if (etudiantSpecific.indicateurs_marche.taux_equipement === "sous_equipe") {
        insights.push({
          type: "positive",
          category: "concurrence",
          message: "Offre de logements étudiants insuffisante - Fort potentiel",
        });
      }
    }
    
    if (projectType === "commerce" && "zone_chalandise" in specific) {
      const commerceSpecific = specific as CommerceSpecificData;
      
      // Purchasing power insight
      const pouvoirAchat = commerceSpecific.zone_chalandise.pouvoir_achat_indice;
      if (pouvoirAchat && pouvoirAchat > 115) {
        insights.push({
          type: "positive",
          category: "chalandise",
          message: `Zone à fort pouvoir d'achat (indice ${pouvoirAchat})`,
        });
      } else if (pouvoirAchat && pouvoirAchat < 85) {
        insights.push({
          type: "warning",
          category: "chalandise",
          message: `Zone à pouvoir d'achat modeste (indice ${pouvoirAchat})`,
        });
      }
      
      // Competition insight
      const concurrence = commerceSpecific.concurrence;
      if (concurrence.indice_concurrence === "faible") {
        insights.push({
          type: "positive",
          category: "concurrence",
          message: `Faible concurrence (${concurrence.commerces_total_zone} commerces dans la zone)`,
        });
      } else if (concurrence.indice_concurrence === "fort") {
        insights.push({
          type: "warning",
          category: "concurrence",
          message: `Forte concurrence (${concurrence.commerces_total_zone} commerces, ${concurrence.grandes_surfaces} grandes surfaces)`,
        });
      }
      
      // Pedestrian flux insight
      const flux = commerceSpecific.flux_pietons;
      if (flux.score_flux && flux.score_flux > 70) {
        const reasons = [];
        if (flux.proximite_metro) reasons.push("métro");
        if (flux.proximite_gare) reasons.push("gare");
        if (flux.rue_pietonne) reasons.push("rue piétonne");
        if (flux.zone_touristique) reasons.push("zone touristique");
        
        insights.push({
          type: "positive",
          category: "flux",
          message: `Fort potentiel de flux piétons${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}`,
        });
      } else if (flux.score_flux && flux.score_flux < 40) {
        insights.push({
          type: "warning",
          category: "flux",
          message: "Flux piétons limité - Zone peu passante",
        });
      }
      
      // Potential revenue insight
      const potentielCa = commerceSpecific.indicateurs_marche.potentiel_ca_m2;
      if (potentielCa && potentielCa > 4000) {
        insights.push({
          type: "positive",
          category: "potentiel",
          message: `Potentiel de CA estimé élevé (~${potentielCa.toLocaleString()}€/m²/an)`,
        });
      }
    }
    
    if (projectType === "bureaux" && "bassin_emploi" in specific) {
      const bureauxSpecific = specific as BureauxSpecificData;
      
      // Employment insight
      const emplois = bureauxSpecific.bassin_emploi.emplois_zone;
      if (emplois && emplois > 50000) {
        insights.push({
          type: "positive",
          category: "emploi",
          message: `Bassin d'emploi important (~${emplois.toLocaleString()} emplois)`,
        });
      } else if (emplois && emplois < 10000) {
        insights.push({
          type: "warning",
          category: "emploi",
          message: "Bassin d'emploi restreint",
        });
      }
      
      // Attractiveness insight
      const attractivite = bureauxSpecific.indicateurs_marche.attractivite_zone;
      if (attractivite === "forte") {
        insights.push({
          type: "positive",
          category: "attractivite",
          message: "Zone très attractive pour les entreprises",
        });
      } else if (attractivite === "faible") {
        insights.push({
          type: "warning",
          category: "attractivite",
          message: "Attractivité limitée pour les entreprises",
        });
      }
      
      // Market tension insight
      const tension = bureauxSpecific.indicateurs_marche.tension_marche;
      if (tension === "tendu") {
        insights.push({
          type: "positive",
          category: "marche",
          message: "Marché tertiaire tendu - Forte demande",
        });
      } else if (tension === "detendu") {
        insights.push({
          type: "warning",
          category: "marche",
          message: "Marché tertiaire détendu - Offre abondante",
        });
      }
      
      // Rent insight
      const loyer = bureauxSpecific.offre_bureaux.loyer_moyen_m2_an;
      if (loyer) {
        insights.push({
          type: "neutral",
          category: "loyer",
          message: `Loyer moyen estimé: ${loyer}€/m²/an`,
        });
      }
      
      // Accessibility insight
      if (bureauxSpecific.accessibilite_pro.temps_gare_tgv_min && bureauxSpecific.accessibilite_pro.temps_gare_tgv_min < 15) {
        insights.push({
          type: "positive",
          category: "accessibilite",
          message: `Gare TGV à ${bureauxSpecific.accessibilite_pro.temps_gare_tgv_min} min`,
        });
      }
    }
    
    if (projectType === "hotel" && "tourisme" in specific) {
      const hotelSpecific = specific as HotelSpecificData;
      
      // Tourism insight
      if (hotelSpecific.tourisme.zone_touristique) {
        insights.push({
          type: "positive",
          category: "tourisme",
          message: `Zone touristique (${hotelSpecific.tourisme.sites_touristiques_count} sites)`,
        });
      } else if (hotelSpecific.tourisme.sites_touristiques_count < 3) {
        insights.push({
          type: "warning",
          category: "tourisme",
          message: "Peu d'attractions touristiques à proximité",
        });
      }
      
      // Business potential insight
      const potentielAffaires = hotelSpecific.indicateurs_marche.potentiel_affaires;
      if (potentielAffaires === "fort") {
        insights.push({
          type: "positive",
          category: "affaires",
          message: "Fort potentiel clientèle affaires" + (hotelSpecific.evenementiel.palais_congres ? " (palais des congrès)" : ""),
        });
      }
      
      // Competition insight
      const hotels = hotelSpecific.concurrence_hotels.hotels_zone;
      const chambres = hotelSpecific.concurrence_hotels.chambres_total;
      if (hotels > 0) {
        insights.push({
          type: "neutral",
          category: "concurrence",
          message: `${hotels} hôtels dans la zone (~${chambres} chambres)`,
        });
      }
      
      // RevPAR insight
      const revpar = hotelSpecific.indicateurs_marche.revpar_zone;
      if (revpar && revpar > 70) {
        insights.push({
          type: "positive",
          category: "revpar",
          message: `RevPAR zone estimé: ${revpar}€`,
        });
      }
      
      // Star rating insight
      const etoiles = hotelSpecific.concurrence_hotels.etoiles_moyenne;
      if (etoiles) {
        insights.push({
          type: "neutral",
          category: "positionnement",
          message: `Positionnement moyen zone: ${etoiles.toFixed(1)} étoiles`,
        });
      }
    }
    
    if (projectType === "logement" && "demographie" in specific) {
      const logementSpecific = specific as LogementSpecificData;
      
      // Rental tension insight
      const tension = logementSpecific.indicateurs_marche.tension_locative;
      if (tension === "forte") {
        insights.push({
          type: "positive",
          category: "marche",
          message: "Marché locatif tendu - Forte demande",
        });
      } else if (tension === "faible") {
        insights.push({
          type: "warning",
          category: "marche",
          message: "Marché locatif détendu - Attention à la vacance",
        });
      }
      
      // Family attractiveness insight
      const attractiviteFamille = logementSpecific.indicateurs_marche.attractivite_familiale;
      if (attractiviteFamille === "forte") {
        insights.push({
          type: "positive",
          category: "cadre_vie",
          message: "Zone attractive pour les familles",
        });
      }
      
      // Price insight
      const prixNeuf = logementSpecific.marche_immobilier.prix_m2_neuf;
      const prixAncien = logementSpecific.marche_immobilier.prix_m2_ancien;
      if (prixNeuf && prixAncien) {
        insights.push({
          type: "neutral",
          category: "prix",
          message: `Prix: ${prixAncien.toLocaleString()}€/m² ancien, ~${prixNeuf.toLocaleString()}€/m² neuf`,
        });
      }
      
      // Evolution insight
      const evolution = logementSpecific.marche_immobilier.evolution_prix_5ans_pct;
      if (evolution !== null && evolution > 10) {
        insights.push({
          type: "positive",
          category: "evolution",
          message: `Forte appréciation des prix (+${evolution.toFixed(1)}%)`,
        });
      } else if (evolution !== null && evolution < -5) {
        insights.push({
          type: "warning",
          category: "evolution",
          message: `Prix en baisse (${evolution.toFixed(1)}%)`,
        });
      }
      
      // Vacancy insight
      const vacance = logementSpecific.demographie.pct_logements_vacants;
      if (vacance && vacance > 12) {
        insights.push({
          type: "warning",
          category: "vacance",
          message: `Taux de vacance élevé (${vacance}%)`,
        });
      } else if (vacance && vacance < 5) {
        insights.push({
          type: "positive",
          category: "vacance",
          message: `Faible vacance (${vacance}%) - Marché tendu`,
        });
      }
    }
  }
  
  // Score-based insights
  if (scores.global >= 75) {
    insights.unshift({
      type: "positive",
      category: "global",
      message: "Contexte de marché très favorable pour ce type de projet",
    });
  } else if (scores.global < 40) {
    insights.unshift({
      type: "warning",
      category: "global",
      message: "Contexte de marché nécessitant une analyse approfondie",
    });
  }
  
  // Limit to 8 insights
  return insights.slice(0, 8);
}

// ============================================================================
// FETCH SPECIFIC DATA BY PROJECT TYPE
// ============================================================================

type SpecificData = EhpadSpecificData | EtudiantSpecificData | CommerceSpecificData | BureauxSpecificData | HotelSpecificData | LogementSpecificData | null;

async function fetchSpecificData(
  projectType: ProjectType,
  lat: number,
  lon: number,
  radiusKm: number,
  codeInsee: string | null,
  core: CoreMarketData
): Promise<{ data: SpecificData; timings: Record<string, number> }> {
  
  switch (projectType) {
    case "ehpad":
      return fetchEhpadSpecificData({
        lat,
        lon,
        radiusKm,
        codeInsee,
        inseeBase: core.insee,
        bpeData: core.bpe,
        isEhpad: true,
      });
    
    case "rss":
      return fetchEhpadSpecificData({
        lat,
        lon,
        radiusKm,
        codeInsee,
        inseeBase: core.insee,
        bpeData: core.bpe,
        isEhpad: false,
      });
    
    case "etudiant":
      return fetchEtudiantSpecificData({
        lat,
        lon,
        radiusKm,
        codeInsee,
        inseeBase: core.insee,
      });
    
    case "commerce":
      return fetchCommerceSpecificData({
        lat,
        lon,
        radiusKm,
        codeInsee,
        inseeBase: core.insee,
        transportData: core.transport,
        bpeData: core.bpe,
      });
    
    case "bureaux":
      return fetchBureauxSpecificData({
        lat,
        lon,
        radiusKm,
        codeInsee,
        inseeBase: core.insee,
        transportData: core.transport,
        bpeData: core.bpe,
      });
    
    case "hotel":
      return fetchHotelSpecificData({
        lat,
        lon,
        radiusKm,
        codeInsee,
        inseeBase: core.insee,
        transportData: core.transport,
      });
    
    case "logement":
    default:
      return fetchLogementSpecificData({
        lat,
        lon,
        radiusKm,
        codeInsee,
        inseeBase: core.insee,
        dvfData: core.dvf,
        bpeData: core.bpe,
      });
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
  const startTime = Date.now();
  
  try {
    // Only accept POST
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ success: false, version: VERSION, error: "Method not allowed" }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    // Parse request
    const payload: MarketStudyRequest = await req.json();
    
    // Validate required fields
    if (typeof payload.lat !== "number" || typeof payload.lon !== "number") {
      return new Response(
        JSON.stringify({ success: false, version: VERSION, error: "lat and lon are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    // Normalize project type
    const projectType = normalizeProjectType(payload.project_type);
    const config = PROJECT_TYPE_CONFIG[projectType];
    
    // Determine radius
    let radiusKm = payload.radius_km ?? config.defaultRadiusKm;
    radiusKm = Math.min(radiusKm, config.maxRadiusKm);
    radiusKm = Math.max(radiusKm, 1);
    
    const timings: Record<string, number> = {};
    
    // Fetch core data
    const t0 = Date.now();
    const { data: coreData, commune, timings: coreTimings } = await fetchCoreMarketData({
      lat: payload.lat,
      lon: payload.lon,
      radiusKm,
      codeInsee: payload.commune_insee ?? null,
    });
    timings.core_total = Date.now() - t0;
    Object.assign(timings, coreTimings);
    
    const codeInsee = commune?.code_insee ?? payload.commune_insee ?? null;
    
    // Fetch specific data
    const t1 = Date.now();
    const { data: specificData, timings: specificTimings } = await fetchSpecificData(
      projectType,
      payload.lat,
      payload.lon,
      radiusKm,
      codeInsee,
      coreData
    );
    timings.specific_total = Date.now() - t1;
    Object.assign(timings, specificTimings);
    
    // Compute scores
    const scores = computeScores(coreData, specificData, projectType);
    
    // Generate insights
    const insights = generateInsights(coreData, specificData, scores, projectType);
    
    // Build coverage summary
    const coverageSummary: Record<string, Coverage> = {
      dvf: coreData.dvf?.coverage ?? "no_data",
      insee: coreData.insee?.coverage ?? "no_data",
      transport: coreData.transport?.coverage ?? "no_data",
      bpe: coreData.bpe?.coverage ?? "no_data",
    };
    
    if (specificData) {
      if ("concurrence" in specificData) {
        coverageSummary.concurrence = (specificData as EhpadSpecificData).concurrence.coverage;
        coverageSummary.demographie_senior = (specificData as EhpadSpecificData).demographie_senior.coverage;
        coverageSummary.offre_sante = (specificData as EhpadSpecificData).offre_sante.coverage;
      }
      if ("etablissements_sup" in specificData) {
        coverageSummary.etablissements_sup = (specificData as EtudiantSpecificData).etablissements_sup.coverage;
        coverageSummary.demographie_jeunes = (specificData as EtudiantSpecificData).demographie_jeunes.coverage;
        coverageSummary.residences_etudiantes = (specificData as EtudiantSpecificData).concurrence_residences.coverage;
      }
      if ("zone_chalandise" in specificData) {
        coverageSummary.zone_chalandise = (specificData as CommerceSpecificData).zone_chalandise.coverage;
        coverageSummary.concurrence_commerce = (specificData as CommerceSpecificData).concurrence.coverage;
        coverageSummary.flux_pietons = (specificData as CommerceSpecificData).flux_pietons.coverage;
      }
      if ("bassin_emploi" in specificData) {
        coverageSummary.bassin_emploi = (specificData as BureauxSpecificData).bassin_emploi.coverage;
        coverageSummary.offre_bureaux = (specificData as BureauxSpecificData).offre_bureaux.coverage;
      }
      if ("tourisme" in specificData) {
        coverageSummary.tourisme = (specificData as HotelSpecificData).tourisme.coverage;
        coverageSummary.concurrence_hotels = (specificData as HotelSpecificData).concurrence_hotels.coverage;
      }
      if ("marche_immobilier" in specificData) {
        coverageSummary.demographie_logement = (specificData as LogementSpecificData).demographie.coverage;
        coverageSummary.marche_immobilier = (specificData as LogementSpecificData).marche_immobilier.coverage;
      }
    }
    
    timings.total = Date.now() - startTime;
    
    // Build response
    const response: MarketStudyResponse = {
      success: true,
      version: VERSION,
      meta: {
        lat: payload.lat,
        lon: payload.lon,
        commune_insee: codeInsee,
        commune_nom: commune?.nom ?? null,
        departement: commune?.departement ?? null,
        project_type: projectType,
        project_type_label: config.label,
        radius_km: radiusKm,
        generated_at: new Date().toISOString(),
      },
      core: coreData,
      specific: specificData,
      scores,
      insights,
    };
    
    // Add debug info if requested
    if (payload.debug) {
      response.debug = {
        timings,
        coverage: coverageSummary,
      };
    }
    
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
    
  } catch (err) {
    console.error("[market-study-promoteur-v1] Error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ success: false, version: VERSION, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});