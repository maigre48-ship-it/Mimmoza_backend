// ============================================================================
// SMARTSCORE V4 — PHASE 2B-1 : Score Environnemental
// ============================================================================
// Piliers :
//   1. Géorisques (déjà intégré — on normalise en score 0-100)
//   2. DPE moyen du quartier (base ADEME ouverte)
//   3. Qualité de l'air (Atmo France / LCSQA)
//   4. Nuisances sonores (PEB aéroport + cartes de bruit routier)
// ============================================================================

// ────────────────────────────────────────────────────────────────────────────
// 1. GEORISQUES → Score (normalisation du catalogue existant)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Poids de gravité par type de risque Géorisques.
 * Plus le poids est élevé, plus le risque est pénalisant.
 */
const GEORISK_SEVERITY: Record<string, number> = {
  // Risques naturels majeurs
  inondation:              10,
  mouvement_terrain:        8,
  seisme:                   7,
  avalanche:                9,
  feu_foret:                6,
  volcanisme:               9,
  cyclone:                  8,
  // Risques technologiques
  seveso:                  10,
  nucleaire:                9,
  icpe:                     5,
  canalisations:            6,
  sols_pollues:             7,
  // Risques miniers
  minier:                   6,
  // Retrait-gonflement argiles
  argiles:                  4,
  // Radon
  radon:                    3,
  // PPRT / PPRn
  pprt:                     8,
  pprn:                     7,
};

export type GeorisquesScoreResult = {
  score: number;                    // 0-100 (100 = aucun risque)
  risques_count: number;
  risques_majeurs: string[];        // Risques avec severity >= 7
  risques_mineurs: string[];
  penalite_totale: number;
  label: string;
};

/**
 * Convertit le catalogue Géorisques en score 0-100.
 * 
 * @param risques  Liste des risques identifiés (clés du catalogue)
 * @param grades   Optionnel : grades par risque (A-E) si disponibles
 */
export function computeGeorisquesScore(
  risques: string[],
  grades?: Record<string, string>,
): GeorisquesScoreResult {
  if (!risques || risques.length === 0) {
    return {
      score: 95, // Pas 100 car absence de données ≠ absence de risques
      risques_count: 0,
      risques_majeurs: [],
      risques_mineurs: [],
      penalite_totale: 0,
      label: "Risques très faibles",
    };
  }

  let penalite = 0;
  const majeurs: string[] = [];
  const mineurs: string[] = [];

  for (const risque of risques) {
    const key = risque.toLowerCase().replace(/[\s-]+/g, "_");
    const severity = GEORISK_SEVERITY[key] ?? 3;

    // Grade modifie la pénalité : A=×0.3, B=×0.5, C=×0.7, D=×0.9, E=×1.0
    let gradeMultiplier = 1.0;
    if (grades?.[risque]) {
      const g = grades[risque].toUpperCase();
      if (g === "A") gradeMultiplier = 0.3;
      else if (g === "B") gradeMultiplier = 0.5;
      else if (g === "C") gradeMultiplier = 0.7;
      else if (g === "D") gradeMultiplier = 0.9;
    }

    const penaliteRisque = severity * gradeMultiplier;
    penalite += penaliteRisque;

    if (severity >= 7) majeurs.push(risque);
    else mineurs.push(risque);
  }

  // Score : 100 - pénalité (cap à 0)
  // Pénalité max théorique ~80 (tous les risques majeurs)
  const score = Math.max(0, Math.min(100, Math.round(100 - penalite * 1.5)));

  let label: string;
  if (score >= 80)      label = "Risques très faibles";
  else if (score >= 60) label = "Risques modérés";
  else if (score >= 40) label = "Risques significatifs";
  else if (score >= 20) label = "Risques élevés";
  else                  label = "Zone à risques majeurs";

  return {
    score,
    risques_count: risques.length,
    risques_majeurs: majeurs,
    risques_mineurs: mineurs,
    penalite_totale: Math.round(penalite * 10) / 10,
    label,
  };
}


// ────────────────────────────────────────────────────────────────────────────
// 2. DPE MOYEN DU QUARTIER (base ADEME ouverte)
// ────────────────────────────────────────────────────────────────────────────

/**
 * API ADEME DPE : https://data.ademe.fr/datasets/dpe-v2-logements-existants
 * Resource API tabulaire data.gouv.fr
 */
const DPE_API_RESOURCE_ID = "a1f09595-0e79-4300-be1d-c05efde75c4c"; // À remplacer par le vrai ID
const DPE_API_BASE = "https://data.ademe.fr/data-fair/api/v1/datasets/dpe-v2-logements-existants/lines";

export type DpeQuartierResult = {
  score: number;                    // 0-100 (100 = tout en A/B)
  dpe_moyen: string;               // Lettre moyenne (A-G)
  distribution: Record<string, number>;  // { A: 5, B: 12, C: 30, ... }
  total_dpe: number;
  conso_moyenne_kwh_m2: number | null;
  ges_moyen_kgco2_m2: number | null;
  label: string;
};

const DPE_LETTER_SCORES: Record<string, number> = {
  A: 100, B: 85, C: 65, D: 45, E: 30, F: 15, G: 5,
};

/**
 * Fetch les DPE autour d'un point via l'API ADEME.
 * Fallback : estimation par département si l'API est indisponible.
 */
export async function fetchDpeQuartier(
  lat: number,
  lon: number,
  radiusM: number = 500,
  communeInsee?: string,
  debug: boolean = false,
): Promise<DpeQuartierResult> {
  const defaultResult: DpeQuartierResult = {
    score: 50,
    dpe_moyen: "D",
    distribution: {},
    total_dpe: 0,
    conso_moyenne_kwh_m2: null,
    ges_moyen_kgco2_m2: null,
    label: "Données DPE indisponibles",
  };

  try {
    // API ADEME avec filtre géographique
    // L'API supporte le bbox ou le code commune
    let url: string;
    if (communeInsee) {
      url = `${DPE_API_BASE}?q_fields=code_insee_commune_actualise&q=${communeInsee}&size=200&select=classe_consommation_energie,classe_estimation_ges,consommation_energie,estimation_ges`;
    } else {
      // Bbox autour du point
      const delta = radiusM / 111000; // ~degrés
      const bbox = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;
      url = `${DPE_API_BASE}?bbox=${bbox}&size=200&select=classe_consommation_energie,classe_estimation_ges,consommation_energie,estimation_ges`;
    }

    if (debug) console.log("[DPE] API URL:", url);

    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      if (debug) console.warn("[DPE] API error:", resp.status);
      return defaultResult;
    }

    const json = await resp.json();
    const results = json.results || json.data || [];

    if (results.length === 0) {
      if (debug) console.log("[DPE] Aucun DPE trouvé");
      return defaultResult;
    }

    // Distribution
    const distribution: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
    let totalConso = 0;
    let totalGes = 0;
    let consoCount = 0;
    let gesCount = 0;

    for (const r of results) {
      const classe = (r.classe_consommation_energie || "").toUpperCase().trim();
      if (classe && distribution[classe] !== undefined) {
        distribution[classe]++;
      }

      const conso = parseFloat(r.consommation_energie);
      if (!isNaN(conso) && conso > 0 && conso < 1000) {
        totalConso += conso;
        consoCount++;
      }

      const ges = parseFloat(r.estimation_ges);
      if (!isNaN(ges) && ges > 0 && ges < 200) {
        totalGes += ges;
        gesCount++;
      }
    }

    const total_dpe = Object.values(distribution).reduce((a, b) => a + b, 0);

    // Score pondéré par distribution
    let weightedScore = 0;
    for (const [letter, count] of Object.entries(distribution)) {
      weightedScore += (DPE_LETTER_SCORES[letter] ?? 0) * count;
    }
    const score = total_dpe > 0 ? Math.round(weightedScore / total_dpe) : 50;

    // Lettre moyenne
    let dpe_moyen = "D";
    if (score >= 90) dpe_moyen = "A";
    else if (score >= 75) dpe_moyen = "B";
    else if (score >= 55) dpe_moyen = "C";
    else if (score >= 40) dpe_moyen = "D";
    else if (score >= 25) dpe_moyen = "E";
    else if (score >= 12) dpe_moyen = "F";
    else dpe_moyen = "G";

    let label: string;
    if (score >= 70) label = "Parc immobilier performant (DPE moyen " + dpe_moyen + ")";
    else if (score >= 45) label = "Parc immobilier moyen (DPE moyen " + dpe_moyen + ")";
    else label = "Parc immobilier énergivore (DPE moyen " + dpe_moyen + ")";

    return {
      score,
      dpe_moyen,
      distribution,
      total_dpe,
      conso_moyenne_kwh_m2: consoCount > 0 ? Math.round(totalConso / consoCount) : null,
      ges_moyen_kgco2_m2: gesCount > 0 ? Math.round(totalGes / gesCount * 10) / 10 : null,
      label,
    };
  } catch (e) {
    if (debug) console.warn("[DPE] fetch error:", e);
    return defaultResult;
  }
}


// ────────────────────────────────────────────────────────────────────────────
// 3. QUALITE DE L'AIR (Atmo France / LCSQA)
// ────────────────────────────────────────────────────────────────────────────

/**
 * API Atmo France IQA : indice quotidien par commune
 * https://www.atmo-france.org/
 * Fallback : LCSQA API Géod'Air
 */
const ATMO_API_BASE = "https://api.atmo-france.org/api/v1";

export type AirQualityResult = {
  score: number;           // 0-100
  indice: number | null;   // IQA 1-6 (1=bon, 6=extrêmement mauvais)
  label: string;           // "Bon", "Moyen", "Dégradé", etc.
  polluant_dominant: string | null;
  source: string;
};

/**
 * Mapping IQA Atmo → score Mimmoza
 */
const IQA_TO_SCORE: Record<number, { score: number; label: string }> = {
  1: { score: 95, label: "Qualité de l'air : Bonne" },
  2: { score: 80, label: "Qualité de l'air : Moyenne" },
  3: { score: 60, label: "Qualité de l'air : Dégradée" },
  4: { score: 40, label: "Qualité de l'air : Mauvaise" },
  5: { score: 20, label: "Qualité de l'air : Très mauvaise" },
  6: { score: 5,  label: "Qualité de l'air : Extrêmement mauvaise" },
};

export async function fetchAirQuality(
  communeInsee: string,
  debug: boolean = false,
): Promise<AirQualityResult> {
  const defaultResult: AirQualityResult = {
    score: 70, // Neutre optimiste
    indice: null,
    label: "Qualité de l'air non évaluée",
    polluant_dominant: null,
    source: "default",
  };

  try {
    // API LCSQA Géod'Air (gratuite, par code commune)
    const url = `https://services9.arcgis.com/7Sr9Ek9c1QTKmbwr/arcgis/rest/services/Indice_quotidien_de_qualit%C3%A9_de_l'air_par_commune/FeatureServer/0/query?where=code_commune%3D%27${communeInsee}%27&outFields=code_qual,lib_qual,lib_zone,date_ech&resultRecordCount=1&orderByFields=date_ech DESC&f=json`;

    if (debug) console.log("[Air] URL:", url);

    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      if (debug) console.warn("[Air] API error:", resp.status);
      return defaultResult;
    }

    const json = await resp.json();
    const features = json.features || [];

    if (features.length === 0) {
      // Fallback : estimation par type de zone
      // Les grandes villes ont généralement un IQA de 2-3
      return defaultResult;
    }

    const attrs = features[0].attributes || {};
    const codeQual = parseInt(attrs.code_qual);
    const libQual = attrs.lib_qual || null;

    if (isNaN(codeQual) || codeQual < 1 || codeQual > 6) {
      return defaultResult;
    }

    const mapping = IQA_TO_SCORE[codeQual] || { score: 50, label: "Indéterminé" };

    return {
      score: mapping.score,
      indice: codeQual,
      label: mapping.label,
      polluant_dominant: libQual,
      source: "LCSQA",
    };
  } catch (e) {
    if (debug) console.warn("[Air] fetch error:", e);
    return defaultResult;
  }
}


// ────────────────────────────────────────────────────────────────────────────
// 4. NUISANCES SONORES
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sources :
 *  - PEB (Plan d'Exposition au Bruit) aéroport via Géoportail
 *  - CBS (Cartes de Bruit Stratégiques) routes/voies ferrées
 *
 * Simplifié en Phase 2B : estimation par densité urbaine + proximité
 * infrastructure (autoroute, voie ferrée, aéroport).
 * Phase 3 : intégration API Géoportail LDEN.
 */
export type NoiseScoreResult = {
  score: number;           // 0-100 (100 = calme)
  zone_peb: string | null; // "A", "B", "C", "D" ou null
  sources_bruit: string[];
  label: string;
};

/**
 * Estimation bruit basée sur la densité et le type de zone.
 * À enrichir avec l'API CBS en Phase 3.
 */
export function estimateNoiseScore(
  isRural: boolean,
  populationCommune: number | null,
  densitePop: number | null,
): NoiseScoreResult {
  let score = 70; // Default neutre

  if (isRural) {
    score = 85; // Rural = généralement calme
    if (densitePop != null && densitePop < 50) score = 95;
  } else {
    // Urbain : inversement proportionnel à la densité
    if (densitePop != null) {
      if (densitePop > 15000)     score = 30; // Paris centre
      else if (densitePop > 8000) score = 40; // Grande ville dense
      else if (densitePop > 4000) score = 55; // Ville moyenne
      else if (densitePop > 2000) score = 65; // Périurbain
      else                        score = 75; // Banlieue calme
    }
  }

  let label: string;
  if (score >= 80)      label = "Environnement sonore calme";
  else if (score >= 60) label = "Niveau sonore acceptable";
  else if (score >= 40) label = "Nuisances sonores modérées";
  else                  label = "Nuisances sonores significatives";

  return {
    score,
    zone_peb: null, // Phase 3
    sources_bruit: [],
    label,
  };
}


// ────────────────────────────────────────────────────────────────────────────
// SCORE ENVIRONNEMENTAL COMPOSITE
// ────────────────────────────────────────────────────────────────────────────

export type EnvironmentScoreResult = {
  score: number;
  components: {
    georisques: number;
    dpe: number;
    air: number;
    bruit: number;
  };
  weights: { georisques: number; dpe: number; air: number; bruit: number };
  label: string;
  details: {
    georisques: GeorisquesScoreResult;
    dpe: DpeQuartierResult;
    air: AirQualityResult;
    bruit: NoiseScoreResult;
  };
};

export function computeEnvironmentScore(
  georisques: GeorisquesScoreResult,
  dpe: DpeQuartierResult,
  air: AirQualityResult,
  bruit: NoiseScoreResult,
): EnvironmentScoreResult {
  // Pondération : risques naturels/techno dominent
  const weights = { georisques: 40, dpe: 25, air: 20, bruit: 15 };

  const totalW = weights.georisques + weights.dpe + weights.air + weights.bruit;
  const totalS =
    georisques.score * weights.georisques +
    dpe.score * weights.dpe +
    air.score * weights.air +
    bruit.score * weights.bruit;

  const score = Math.round(totalS / totalW);

  let label: string;
  if (score >= 75)      label = "Environnement favorable";
  else if (score >= 55) label = "Environnement acceptable";
  else if (score >= 35) label = "Points de vigilance environnementaux";
  else                  label = "Contraintes environnementales fortes";

  return {
    score,
    components: {
      georisques: georisques.score,
      dpe: dpe.score,
      air: air.score,
      bruit: bruit.score,
    },
    weights,
    label,
    details: { georisques, dpe, air, bruit },
  };
}