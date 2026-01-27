// FILE: supabase/functions/market-study-v1/lib/dvf.ts

import type { CompsData, DvfTransaction } from "./types.ts";
import { haversine } from "./geo.ts";

/**
 * Récupère les transactions DVF à proximité d'un point.
 *
 * L'API DVF officielle (data.gouv.fr) permet des requêtes par commune ou bbox.
 * Endpoint: https://api.cquest.org/dvf?lat=...&lon=...&dist=... (API communautaire)
 * Ou: https://app.dvf.etalab.gouv.fr/api/... (mais pas de recherche par coords directe)
 *
 * On utilise l'API DVF de Christian Quest (cquest) qui permet une recherche par rayon.
 */
export async function fetchDvfComps(
  lat: number,
  lon: number,
  radiusKm: number,
  codeInsee: string | undefined,
  warnings: string[]
): Promise<CompsData> {
  const result: CompsData = {
    dvf_available: false,
    items: [],
  };

  try {
    // Méthode 1: API cquest (non officielle mais pratique)
    const cquestData = await fetchFromCquest(lat, lon, radiusKm);

    if (cquestData && cquestData.length > 0) {
      result.dvf_available = true;
      result.items = cquestData;
      return result;
    }

    // Méthode 2: Si on a un code INSEE, essayer l'API officielle DVF
    if (codeInsee) {
      const dvfData = await fetchFromOfficialDvf(codeInsee, lat, lon, radiusKm);

      if (dvfData && dvfData.length > 0) {
        result.dvf_available = true;
        result.items = dvfData;
        return result;
      }
    }

    // Aucune donnée disponible
    warnings.push(
      "DVF: Aucune transaction trouvée à proximité. " +
      "Les données DVF peuvent ne pas couvrir cette zone ou période."
    );
  } catch (err) {
    warnings.push(`DVF: Erreur lors de la récupération: ${String(err)}`);
  }

  return result;
}

/**
 * Récupère les transactions via l'API cquest (api.cquest.org/dvf)
 */
async function fetchFromCquest(
  lat: number,
  lon: number,
  radiusKm: number
): Promise<DvfTransaction[] | null> {
  try {
    // L'API cquest accepte un rayon en mètres
    const radiusM = Math.min(radiusKm * 1000, 5000); // Max 5km pour éviter trop de données
    const url = `https://api.cquest.org/dvf?lat=${lat}&lon=${lon}&dist=${radiusM}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!data.features || !Array.isArray(data.features)) {
      return null;
    }

    const transactions: DvfTransaction[] = [];

    for (const feature of data.features.slice(0, 50)) {
      // Limite à 50 transactions
      const props = feature.properties || {};
      const coords = feature.geometry?.coordinates;

      const txLat = coords?.[1];
      const txLon = coords?.[0];

      const distance = txLat && txLon ? haversine(lat, lon, txLat, txLon) : undefined;

      const surface = props.surface_reelle_bati || props.surface_terrain;
      const prixM2 =
        surface && props.valeur_fonciere
          ? Math.round(props.valeur_fonciere / surface)
          : undefined;

      transactions.push({
        id: props.id_mutation || `dvf-${Date.now()}-${Math.random()}`,
        date_mutation: props.date_mutation || "",
        nature_mutation: props.nature_mutation || "",
        valeur_fonciere: props.valeur_fonciere || 0,
        adresse: props.adresse_nom_voie
          ? `${props.adresse_numero || ""} ${props.adresse_nom_voie}`.trim()
          : undefined,
        code_postal: props.code_postal,
        commune: props.nom_commune,
        type_local: props.type_local,
        surface_reelle_bati: props.surface_reelle_bati,
        nombre_pieces_principales: props.nombre_pieces_principales,
        surface_terrain: props.surface_terrain,
        lat: txLat,
        lon: txLon,
        distance_km: distance ? Math.round(distance * 100) / 100 : undefined,
        prix_m2: prixM2,
      });
    }

    // Trier par date (plus récent en premier)
    transactions.sort((a, b) => {
      if (!a.date_mutation) return 1;
      if (!b.date_mutation) return -1;
      return b.date_mutation.localeCompare(a.date_mutation);
    });

    return transactions;
  } catch {
    return null;
  }
}

/**
 * Récupère les transactions via l'API DVF officielle (data.gouv.fr)
 * Endpoint: https://app.dvf.etalab.gouv.fr/api/transactions
 */
async function fetchFromOfficialDvf(
  codeInsee: string,
  lat: number,
  lon: number,
  radiusKm: number
): Promise<DvfTransaction[] | null> {
  try {
    // L'API officielle permet de filtrer par code commune
    // On récupère les 2 dernières années
    const currentYear = new Date().getFullYear();
    const years = [currentYear - 1, currentYear - 2];

    const transactions: DvfTransaction[] = [];

    for (const year of years) {
      const url = `https://app.dvf.etalab.gouv.fr/api/mutations/${codeInsee}?annee=${year}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) continue;

      const data = await response.json();

      if (!Array.isArray(data)) continue;

      for (const tx of data.slice(0, 30)) {
        // Limite par année
        const txLat = tx.lat || tx.latitude;
        const txLon = tx.lon || tx.longitude;

        let distance: number | undefined;
        if (txLat && txLon) {
          distance = haversine(lat, lon, txLat, txLon);
          // Filtrer par distance
          if (distance > radiusKm) continue;
        }

        const surface = tx.surface_reelle_bati || tx.surface_terrain;
        const prixM2 =
          surface && tx.valeur_fonciere
            ? Math.round(tx.valeur_fonciere / surface)
            : undefined;

        transactions.push({
          id: tx.id_mutation || `dvf-${year}-${Math.random()}`,
          date_mutation: tx.date_mutation || "",
          nature_mutation: tx.nature_mutation || "",
          valeur_fonciere: tx.valeur_fonciere || 0,
          adresse: tx.adresse,
          code_postal: tx.code_postal,
          commune: tx.commune || tx.nom_commune,
          type_local: tx.type_local,
          surface_reelle_bati: tx.surface_reelle_bati,
          nombre_pieces_principales: tx.nombre_pieces_principales,
          surface_terrain: tx.surface_terrain,
          lat: txLat,
          lon: txLon,
          distance_km: distance ? Math.round(distance * 100) / 100 : undefined,
          prix_m2: prixM2,
        });
      }
    }

    // Trier par date
    transactions.sort((a, b) => {
      if (!a.date_mutation) return 1;
      if (!b.date_mutation) return -1;
      return b.date_mutation.localeCompare(a.date_mutation);
    });

    return transactions.slice(0, 50);
  } catch {
    return null;
  }
}