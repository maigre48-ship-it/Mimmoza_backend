// ============================================================================
// SMARTSCORE V4 — PHASE 2B-3 : Concurrence Projet (Sitadel)
// ============================================================================
// Source : base Sitadel2 (permis de construire) — data.gouv.fr
// https://www.data.gouv.fr/fr/datasets/base-des-permis-de-construire-et-autres-autorisations-durbanisme-sitadel/
//
// Objectif : détecter les projets concurrents autorisés ou en cours
// dans un rayon donné, et scorer le niveau de concurrence.
// ============================================================================

/**
 * API Sitadel via data.gouv.fr (API tabulaire)
 * Resource : permis autorisés des 3 dernières années
 */
const SITADEL_API_BASE = "https://tabular-api.data.gouv.fr/api/resources";
// Sitadel2 resource ID (permis autorisés) — À confirmer avec le bon ID
const SITADEL_RESOURCE_ID = "sitadel_autorisations"; // Placeholder

export type PermisProche = {
  numero: string;
  date_autorisation: string;
  commune: string;
  commune_insee: string;
  type_projet: string;         // "logement", "commerce", "bureau", etc.
  nb_logements: number | null;
  surface_plancher_m2: number | null;
  distance_m: number;
  statut: string;              // "autorisé", "commencé", "terminé"
};

export type CompetitionScoreResult = {
  score: number;                    // 0-100 (100 = aucune concurrence)
  label: string;
  permis_count: number;
  logements_en_projet: number;      // Total logements autorisés dans le rayon
  surface_en_projet_m2: number;     // Total surface plancher
  permis_proches: PermisProche[];   // Top 10 les plus proches
  pression_label: string;           // "Faible", "Modérée", "Forte", "Très forte"
  interpretation: string;
};

/**
 * Mapping nature de permis Sitadel → type Mimmoza
 */
function mapSitadelNature(nature: string | null): string {
  if (!nature) return "autre";
  const n = nature.toLowerCase();
  if (n.includes("logement") || n.includes("habitation") || n.includes("résidentiel")) return "logement";
  if (n.includes("bureau")) return "bureaux";
  if (n.includes("commerce") || n.includes("artisan")) return "commerce";
  if (n.includes("héberg") || n.includes("hotel") || n.includes("hôtel")) return "hotel";
  if (n.includes("santé") || n.includes("médic") || n.includes("ehpad")) return "sante";
  if (n.includes("enseignement") || n.includes("étudiant")) return "enseignement";
  return "autre";
}

/**
 * Fetch les permis de construire autour d'un point.
 *
 * Stratégie :
 *  1. Filtrer par commune INSEE (API tabulaire)
 *  2. Si géolocalisation dispo → filtrer par distance
 *  3. Sinon → prendre tous les permis de la commune
 *
 * En attendant l'API Sitadel, on peut importer les CSV dans Supabase.
 */
export async function fetchPermisProches(
  lat: number,
  lon: number,
  communeInsee: string,
  radiusM: number = 2000,
  supabase: any | null = null,
  debug: boolean = false,
): Promise<PermisProche[]> {
  if (!supabase) return [];

  try {
    // Option 1 : Table Supabase `sitadel_permis` (importée depuis CSV)
    const { data, error } = await supabase
      .from("sitadel_permis")
      .select("*")
      .eq("commune_insee", communeInsee)
      .gte("date_autorisation", new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000).toISOString().split("T")[0])
      .limit(200);

    if (error) {
      if (debug) console.warn("[Sitadel] Supabase error:", error.message);
      return [];
    }

    if (!data || data.length === 0) {
      if (debug) console.log("[Sitadel] Aucun permis trouvé pour", communeInsee);
      return [];
    }

    // Calculer distances et filtrer
    const permis: PermisProche[] = [];

    for (const row of data) {
      const pLat = parseFloat(row.latitude);
      const pLon = parseFloat(row.longitude);

      let distance_m = 0;
      if (!isNaN(pLat) && !isNaN(pLon) && pLat !== 0 && pLon !== 0) {
        distance_m = haversineDistance(lat, lon, pLat, pLon);
        if (distance_m > radiusM) continue;
      }
      // Si pas de coordonnées, on garde (même commune)

      permis.push({
        numero: row.numero_permis || row.id || "",
        date_autorisation: row.date_autorisation || "",
        commune: row.commune || "",
        commune_insee: row.commune_insee || communeInsee,
        type_projet: mapSitadelNature(row.nature_projet || row.destination),
        nb_logements: parseInt(row.nb_logements) || null,
        surface_plancher_m2: parseFloat(row.surface_plancher) || null,
        distance_m: Math.round(distance_m),
        statut: row.statut || "autorisé",
      });
    }

    permis.sort((a, b) => a.distance_m - b.distance_m);
    return permis;
  } catch (e) {
    if (debug) console.warn("[Sitadel] fetch error:", e);
    return [];
  }
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Score de concurrence.
 *
 * Logique :
 *  - Beaucoup de permis dans le rayon → concurrence forte → score bas
 *  - Filtre par type de projet similaire pour plus de pertinence
 *  - Pondère par distance (un projet à 100m est plus concurrent qu'à 2km)
 *
 * @param permis         Liste des permis proches
 * @param projectNature  Nature du projet Mimmoza
 * @param radiusM        Rayon de recherche
 * @param isRural        Zone rurale (seuils différents)
 */
export function computeCompetitionScore(
  permis: PermisProche[],
  projectNature: string = "logement",
  radiusM: number = 2000,
  isRural: boolean = false,
): CompetitionScoreResult {

  if (permis.length === 0) {
    return {
      score: 90, // Pas de concurrence détectée (pas 100 car données potentiellement manquantes)
      label: "Concurrence non détectée",
      permis_count: 0,
      logements_en_projet: 0,
      surface_en_projet_m2: 0,
      permis_proches: [],
      pression_label: "Faible",
      interpretation: "Aucun permis de construire détecté dans le rayon — données Sitadel à vérifier.",
    };
  }

  const nature = projectNature.toLowerCase();

  // Filtrer les permis du même type (concurrence directe)
  const memeType = permis.filter(p => {
    if (nature === "logement" || nature === "coliving") return p.type_projet === "logement";
    if (nature === "ehpad" || nature === "residence_senior") return p.type_projet === "sante" || p.type_projet === "logement";
    if (nature === "bureaux") return p.type_projet === "bureaux";
    if (nature === "commerce") return p.type_projet === "commerce";
    if (nature === "hotel") return p.type_projet === "hotel";
    return true; // Tous les types
  });

  // Métriques
  let totalLogements = 0;
  let totalSurface = 0;
  let pressionPonderee = 0;

  for (const p of permis) {
    totalLogements += p.nb_logements ?? 0;
    totalSurface += p.surface_plancher_m2 ?? 0;

    // Pondération par distance (plus c'est proche, plus ça pèse)
    const distFactor = Math.max(0.1, 1 - (p.distance_m / radiusM));
    const sizeFactor = Math.min(3, (p.nb_logements ?? 10) / 30); // Normaliser taille
    pressionPonderee += distFactor * sizeFactor;
  }

  // Score : inverse de la pression
  // Seuils adaptés rural/urbain
  const seuilFort = isRural ? 3 : 8;
  const seuilModere = isRural ? 1.5 : 4;

  let score: number;
  if (pressionPonderee <= seuilModere * 0.3) score = 90;
  else if (pressionPonderee <= seuilModere) score = 70;
  else if (pressionPonderee <= seuilFort) score = 45;
  else score = Math.max(5, Math.round(45 - (pressionPonderee - seuilFort) * 5));

  score = Math.min(100, Math.max(0, score));

  // Labels
  let pression_label: string;
  if (score >= 75)      pression_label = "Faible";
  else if (score >= 50) pression_label = "Modérée";
  else if (score >= 25) pression_label = "Forte";
  else                  pression_label = "Très forte";

  let label: string;
  if (score >= 75)      label = "Concurrence faible";
  else if (score >= 50) label = "Concurrence modérée";
  else                  label = "Concurrence significative";

  // Interprétation
  let interpretation: string;
  const nbMemeType = memeType.length;
  const logementsMemeType = memeType.reduce((sum, p) => sum + (p.nb_logements ?? 0), 0);

  if (nbMemeType === 0) {
    interpretation = permis.length + " permis détectés dans le rayon mais aucun projet concurrent direct de type " + projectNature + ".";
  } else if (nbMemeType <= 2 && logementsMemeType <= 50) {
    interpretation = nbMemeType + " projet(s) concurrent(s) directs pour " + logementsMemeType + " logements — pression limitée.";
  } else {
    interpretation = nbMemeType + " projets concurrents directs totalisant " + logementsMemeType +
      " logements dans un rayon de " + Math.round(radiusM / 1000) + " km — analyser le risque de sur-offre.";
  }

  return {
    score,
    label,
    permis_count: permis.length,
    logements_en_projet: totalLogements,
    surface_en_projet_m2: Math.round(totalSurface),
    permis_proches: permis.slice(0, 10),
    pression_label,
    interpretation,
  };
}


// ============================================================================
// MIGRATION SQL POUR SITADEL
// ============================================================================
// À exécuter dans Supabase pour importer les données Sitadel.
// Le CSV Sitadel est téléchargeable sur data.gouv.fr et importable via
// psql COPY ou l'interface Supabase.
//
// CREATE TABLE IF NOT EXISTS sitadel_permis (
//   id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//   numero_permis     VARCHAR(30),
//   date_autorisation  DATE,
//   commune_insee     VARCHAR(5) NOT NULL,
//   commune           VARCHAR(100),
//   departement       VARCHAR(3),
//   nature_projet     VARCHAR(100),       -- "Logement", "Bureau", etc.
//   destination       VARCHAR(100),       -- Destination principale
//   nb_logements      INTEGER,
//   surface_plancher  NUMERIC,            -- m²
//   latitude          DOUBLE PRECISION,
//   longitude         DOUBLE PRECISION,
//   statut            VARCHAR(20) DEFAULT 'autorisé',
//   created_at        TIMESTAMPTZ DEFAULT NOW()
// );
//
// CREATE INDEX idx_sitadel_commune ON sitadel_permis (commune_insee);
// CREATE INDEX idx_sitadel_date ON sitadel_permis (date_autorisation DESC);
// CREATE INDEX idx_sitadel_geo ON sitadel_permis (latitude, longitude);
// ============================================================================