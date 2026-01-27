// FILE: supabase/functions/market-study-v1/lib/insee.ts

import type { InseeData } from "./types.ts";
import { getCommuneInfo } from "./geo.ts";

/**
 * Récupère les données INSEE disponibles pour une commune.
 * Mode "best effort" : utilise geo.api.gouv.fr pour population/surface.
 * Les autres indicateurs (chômage, pauvreté, revenus) nécessitent une API INSEE authentifiée.
 * 
 * @param codeInsee - Code INSEE de la commune
 * @param warnings - Array pour collecter les warnings
 */
export async function fetchInseeData(
  codeInsee: string,
  warnings: string[]
): Promise<InseeData> {
  const result: InseeData = {
    insee_partial: true,
  };

  try {
    // 1. Données de base via geo.api.gouv.fr (population, surface)
    const communeInfo = await getCommuneInfo(codeInsee);

    if (communeInfo) {
      result.population = communeInfo.population;
      result.population_year = new Date().getFullYear(); // approximation

      if (communeInfo.surface && communeInfo.population) {
        result.densite_hab_km2 = Math.round(
          communeInfo.population / communeInfo.surface
        );
      }
    } else {
      warnings.push(`INSEE: Impossible de récupérer les données de base pour ${codeInsee}`);
    }

    // 2. Tentative d'appel à l'API publique INSEE (dossier complet commune)
    //    Note: L'API INSEE officielle requiert une authentification OAuth2.
    //    Ici on tente un endpoint public alternatif (peut échouer).
    const additionalData = await fetchInseePublicEndpoint(codeInsee);

    if (additionalData) {
      if (additionalData.taux_chomage !== undefined) {
        result.taux_chomage = additionalData.taux_chomage;
      }
      if (additionalData.taux_pauvrete !== undefined) {
        result.taux_pauvrete = additionalData.taux_pauvrete;
      }
      if (additionalData.pct_proprietaires !== undefined) {
        result.pct_proprietaires = additionalData.pct_proprietaires;
      }
      if (additionalData.revenu_median !== undefined) {
        result.revenu_median = additionalData.revenu_median;
      }
      if (additionalData.pyramide_ages) {
        result.pyramide_ages = additionalData.pyramide_ages;
      }
      // Si on a des données supplémentaires, on est moins partiel
      result.insee_partial = false;
    } else {
      warnings.push(
        "INSEE: Données avancées non disponibles (API INSEE requiert authentification). " +
        "Seules les données de base (population, densité) sont fournies."
      );
    }
  } catch (err) {
    warnings.push(`INSEE: Erreur lors de la récupération: ${String(err)}`);
  }

  return result;
}

/**
 * Tentative d'appel à un endpoint public INSEE.
 * En pratique, l'API INSEE officielle (api.insee.fr) nécessite un token OAuth2.
 * Cette fonction est un placeholder qui retourne null si non disponible.
 */
async function fetchInseePublicEndpoint(
  _codeInsee: string
): Promise<Partial<InseeData> | null> {
  // ────────────────────────────────────────────────────────────────
  // NOTE: Pour une implémentation complète, il faudrait:
  // 1. S'inscrire sur api.insee.fr
  // 2. Obtenir des credentials OAuth2
  // 3. Implémenter le flow d'authentification
  // 4. Appeler les endpoints appropriés (Filosofi, RP, etc.)
  //
  // Exemple d'endpoints utiles (avec auth):
  // - Recensement population: https://api.insee.fr/donnees-locales/V0.1/donnees/geo-POP@GEO2023RP2020/COM-{code}
  // - Filosofi (revenus): https://api.insee.fr/donnees-locales/V0.1/donnees/geo-FILOSOFI@GEO2023FILOSOFI2020/COM-{code}
  // ────────────────────────────────────────────────────────────────

  // Pour l'instant, on retourne null (données non disponibles sans clé)
  // Une amélioration future pourrait:
  // - Utiliser un cache Supabase avec des données pré-chargées
  // - Utiliser un proxy avec authentification côté serveur
  // - Utiliser des données open data téléchargées

  return null;
}

/**
 * Estime la pyramide des âges à partir de données départementales moyennes.
 * Utilisé comme fallback si les données communales ne sont pas disponibles.
 */
export function getDefaultPyramideAges(): InseeData["pyramide_ages"] {
  // Moyennes nationales approximatives (France 2023)
  return {
    "0-14": 17.5,
    "15-29": 17.2,
    "30-44": 19.1,
    "45-59": 19.8,
    "60-74": 15.4,
    "75+": 11.0,
  };
}

/**
 * Recherche le code INSEE d'une commune à partir de ses coordonnées.
 * Utilise l'API geo.api.gouv.fr
 */
export async function findCommuneByCoords(
  lat: number,
  lon: number
): Promise<{ code: string; nom: string } | null> {
  try {
    const url = `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=code,nom`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const data = await res.json();

    if (Array.isArray(data) && data.length > 0) {
      return {
        code: data[0].code,
        nom: data[0].nom,
      };
    }

    return null;
  } catch {
    return null;
  }
}