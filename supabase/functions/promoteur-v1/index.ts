// supabase/functions/promoteur-v1/index.ts
// Version : promoteur-v1 (avec DVF + fallback résiduel)

// -------------------------------------------------
// Imports & Supabase client
// -------------------------------------------------
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -------------------------------------------------
// CONFIG DVF
// -------------------------------------------------

const DVF_TABLE = "dvf_2025_s1_typed";
const DVF_COL_CODE_COMMUNE = "code_commune";
const DVF_COL_VALEUR_FONCIERE = "valeur_fonciere";
const DVF_COL_SURFACE_TERRAIN = "surface_terrain";

const BIG_METRO_DEP_PREFIXES = new Set([
  "75",
  "92",
  "93",
  "94",
  "69",
  "13",
  "31",
  "33",
  "44",
  "59",
  "67",
  "34",
  "35",
]);

// -------------------------------------------------
// Types
// -------------------------------------------------

interface ParcelInput {
  parcel_id?: string;
  lat?: number;
  lon?: number;
  surface_terrain_m2?: number | null;
}

interface PluInput {
  commune_insee: string;
  commune_nom?: string;
  zone_code: string;
}

interface ProjetInput {
  destination_principale: string;
  scenario?: string;
}

interface FinancementInput {
  profile_code?: string | null;
  overrides?: Record<string, unknown> | null;
}

type FoncierMode = "saisi" | "residuel" | "none" | "dvf";

interface FoncierInput {
  mode?: FoncierMode;
  valeur_terrain_saisi?: number | null;
}

interface PluRuleset {
  implantation?: {
    retrait_rue_m?: number | null;
    retrait_fond_parcelle_m?: number | null;
    retrait_lateraux_m?: number | null;
  };
  emprise_sol?: {
    max_ratio?: number | null;
    max_m2?: number | null;
  };
  hauteur?: {
    hauteur_max_m?: number | null;
    hauteur_min_m?: number | null;
    commentaire?: string | null;
  };
  densite?: {
    cos_existe?: boolean | null;
    max_sdp_m2_par_m2_terrain?: number | null;
  };
}

interface PluOverrides {
  source?: Record<string, unknown>;
  ruleset: PluRuleset;
}

interface PromoteurInput {
  parcel: ParcelInput;
  plu: PluInput;
  projet: ProjetInput;
  financement?: FinancementInput;
  foncier?: FoncierInput;
  plu_overrides?: PluOverrides | null;
}

interface PromoteurParams {
  ventes?: any;
  couts?: any;
  objectif?: any;
}

// -------------------------------------------------
// Helpers
// -------------------------------------------------

function safeNumber(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: number | null, decimals = 0): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

function deepMerge<T>(base: T, override: any): T {
  if (!override || typeof override !== "object") return base;
  const result: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const key of Object.keys(override)) {
    const b = (base as any)[key];
    const o = override[key];
    if (
      b &&
      typeof b === "object" &&
      !Array.isArray(b) &&
      o &&
      typeof o === "object" &&
      !Array.isArray(o)
    ) {
      result[key] = deepMerge(b, o);
    } else result[key] = o;
  }
  return result as T;
}

// -------------------------------------------------
// Chargement du PLU normalisé
// -------------------------------------------------

async function fetchPluRuleset(input: PluInput): Promise<{
  ruleset: PluRuleset | null;
  meta: Record<string, unknown> | null;
}> {
  const { commune_insee, zone_code } = input;

  const { data, error } = await supabase
    .from("plu_ruleset_normalized")
    .select(
      "id, commune_insee, commune_nom, zone_code, plu_version_label, plu_source_type, plu_source_url, plu_source_page_range, ruleset",
    )
    .eq("commune_insee", commune_insee)
    .eq("zone_code", zone_code)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("Erreur fetchPluRuleset:", error);
    throw new Error("Erreur PLU normalisé");
  }

  if (!data) return { ruleset: null, meta: null };

  const meta = {
    id: data.id,
    commune_insee: data.commune_insee,
    commune_nom: data.commune_nom,
    zone_code: data.zone_code,
    plu_version_label: data.plu_version_label,
    plu_source_type: data.plu_source_type,
    plu_source_url: data.plu_source_url,
    plu_source_page_range: data.plu_source_page_range,
  };

  return { ruleset: (data.ruleset || {}) as PluRuleset, meta };
}

// -------------------------------------------------
// Profil Promoteur
// -------------------------------------------------

async function fetchPromoteurProfile(
  financement?: FinancementInput,
): Promise<{ code: string; params: PromoteurParams; source: "db" | "default" }> {
  const defaults: PromoteurParams = {
    ventes: {
      logement: { prix_vente_m2: 7000, taux_vacance: 0 },
      commerce: { prix_vente_m2: 8000, taux_vacance: 0 },
    },
    couts: {
      construction: {
        logement_m2: 2300,
        commerce_m2: 2200,
        bureaux_m2: 2400,
      },
      honoraires_pct: 0.05,
      frais_etudes_pct: 0.02,
      frais_commerciaux_pct: 0.03,
      frais_financiers_pct: 0.04,
      taxes_pct: 0.03,
    },
    objectif: { marge_cible_pct_sur_ca: 0.12 }, // 🔹 marge par défaut = 12%
  };

  if (!financement?.profile_code) {
    return {
      code: "DEFAULT",
      params: financement?.overrides
        ? deepMerge(defaults, financement.overrides)
        : defaults,
      source: "default",
    };
  }

  const { data, error } = await supabase
    .from("promoteur_profiles")
    .select("code, params")
    .eq("code", financement.profile_code)
    .eq("is_default", true)
    .maybeSingle();

  if (error || !data) {
    return {
      code: financement.profile_code,
      params: financement.overrides
        ? deepMerge(defaults, financement.overrides)
        : defaults,
      source: "default",
    };
  }

  return {
    code: data.code,
    params: financement.overrides
      ? deepMerge(data.params, financement.overrides)
      : data.params,
    source: "db",
  };
}

// -------------------------------------------------
// Surface depuis le cadastre
// -------------------------------------------------

async function fetchSurfaceFromCadastre(parcel: ParcelInput): Promise<number | null> {
  if (!parcel.parcel_id) return null;

  const { data, error } = await supabase
    .from("cadastre_parcelles")
    .select("*")
    .eq("id", parcel.parcel_id)
    .maybeSingle();

  if (error || !data) return null;

  const props = (data as any).props || {};

  const candidates = [
    safeNumber((data as any).surface_terrain_m2),
    safeNumber((data as any).surface_m2),
    safeNumber((data as any).surface),
    safeNumber((data as any).superficie),
    safeNumber((data as any).contenance),
    safeNumber(props?.contenance),
  ];

  return candidates.find((x) => x && x > 0) ?? null;
}

// -------------------------------------------------
// Estimation foncière via DVF
// -------------------------------------------------

async function estimateFoncierFromDvfByCommune(
  communeInsee: string,
  surfaceTerrainM2: number,
): Promise<{ valeur_terrain: number | null; meta: any }> {
  try {
    const depPrefix =
      communeInsee.startsWith("97") || communeInsee.startsWith("98")
        ? communeInsee.slice(0, 3)
        : communeInsee.slice(0, 2);

    const { data, error } = await supabase
      .from(DVF_TABLE)
      .select(
        `${DVF_COL_VALEUR_FONCIERE}, ${DVF_COL_SURFACE_TERRAIN}, nature_mutation, type_local, surface_reelle_bati`,
      )
      .like(DVF_COL_CODE_COMMUNE, `${depPrefix}%`)
      .eq("nature_mutation", "Vente")
      .is("type_local", null)
      .eq("surface_reelle_bati", 0)
      .gt(DVF_COL_SURFACE_TERRAIN, 0)
      .lte(DVF_COL_SURFACE_TERRAIN, 5000)
      .gt(DVF_COL_VALEUR_FONCIERE, 0)
      .limit(1000);

    if (error || !data) {
      return { valeur_terrain: null, meta: { reason: "dvf_error", depPrefix } };
    }

    const ratios: number[] = [];

    for (const row of data as any[]) {
      const v = safeNumber(row[DVF_COL_VALEUR_FONCIERE]);
      const s = safeNumber(row[DVF_COL_SURFACE_TERRAIN]);
      if (v && s && s > 0) {
        const ratio = v / s;
        if (ratio >= 50 && ratio <= 20000) ratios.push(ratio);
      }
    }

    if (ratios.length < 30) {
      return {
        valeur_terrain: null,
        meta: { reason: "dvf_not_enough_samples", count: ratios.length },
      };
    }

    ratios.sort((a, b) => a - b);
    const mid = Math.floor(ratios.length / 2);
    const median =
      ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;

    return {
      valeur_terrain: median * surfaceTerrainM2,
      meta: { reason: "ok", median, samples: ratios.length },
    };
  } catch (e) {
    return { valeur_terrain: null, meta: { reason: "dvf_exception", error: e } };
  }
}

// -------------------------------------------------
// Étude architecturale
// -------------------------------------------------

function computeEtudeArchi(
  surfaceTerrainM2: number,
  ruleset: PluRuleset | null,
  projet: ProjetInput,
) {
  const empriseRatio =
    safeNumber(ruleset?.emprise_sol?.max_ratio, null) ?? 0.6;

  const empriseMaxM2FromRatio = surfaceTerrainM2 * empriseRatio;
  const empriseMaxM2Fixed = safeNumber(ruleset?.emprise_sol?.max_m2, null);

  const empriseAutoriseeM2 =
    empriseMaxM2Fixed != null
      ? Math.min(empriseMaxM2Fixed, empriseMaxM2FromRatio)
      : empriseMaxM2FromRatio;

  const hauteurMaxM =
    safeNumber(ruleset?.hauteur?.hauteur_max_m, null) ?? 15;

  const hauteurNiveauM = 3;
  const nbNiveauxPossibles = Math.max(
    1,
    Math.floor(hauteurMaxM / hauteurNiveauM),
  );

  const tauxEfficiencesPlans = 0.85;
  const surfaceNiveauTypiqueM2 = empriseAutoriseeM2 * tauxEfficiencesPlans;
  const sdpTotalePotentielleM2 =
    surfaceNiveauTypiqueM2 * nbNiveauxPossibles;

  const scenario = projet.scenario || "logement_seul";

  const repartition = {
    rdc: {
      type: "logement",
      m2: sdpTotalePotentielleM2 / nbNiveauxPossibles,
    },
    etages: {
      type: "logement",
      m2:
        sdpTotalePotentielleM2 -
        sdpTotalePotentielleM2 / nbNiveauxPossibles,
    },
  };

  return {
    surface_terrain_m2: round(surfaceTerrainM2, 2),
    emprise_autorisee_m2: round(empriseAutoriseeM2, 2),
    retraits: {
      rue_m: safeNumber(ruleset?.implantation?.retrait_rue_m, 0),
      fond_m: safeNumber(
        ruleset?.implantation?.retrait_fond_parcelle_m,
        null,
      ),
      lateraux_m: safeNumber(
        ruleset?.implantation?.retrait_lateraux_m,
        null,
      ),
    },
    hauteur_max_m: hauteurMaxM,
    hypotheses: {
      hauteur_niveau_m: hauteurNiveauM,
      taux_efficiences_plans: tauxEfficiencesPlans,
      scenario_projet: scenario,
    },
    nb_niveaux_possibles: nbNiveauxPossibles,
    surface_niveau_typique_m2: round(surfaceNiveauTypiqueM2, 2),
    sdp_totale_potentielle_m2: round(sdpTotalePotentielleM2, 2),
    repartition_fonctions: repartition,
  };
}

// -------------------------------------------------
// Revenus & coûts hors foncier
// -------------------------------------------------

function computeRevenusEtCoutsHorsFoncier(
  etudeArchi: any,
  profil: { code: string; params: PromoteurParams },
) {
  const sdpTotale =
    safeNumber(etudeArchi?.sdp_totale_potentielle_m2, 0) ?? 0;

  const m2Logement = sdpTotale;
  const m2Commerce = 0;
  const m2Bureaux = 0;

  const prixLogement =
    safeNumber(profil.params?.ventes?.logement?.prix_vente_m2, 7000) ??
    7000;
  const prixCommerce =
    safeNumber(profil.params?.ventes?.commerce?.prix_vente_m2, 8000) ??
    8000;
  const prixBureaux =
    safeNumber(profil.params?.ventes?.bureaux?.prix_vente_m2, 7500) ??
    7500;

  const caLogement = m2Logement * prixLogement;
  const caCommerce = m2Commerce * prixCommerce;
  const caBureaux = m2Bureaux * prixBureaux;

  const caTotal = caLogement + caCommerce + caBureaux;

  const coutConstructionLogement =
    m2Logement *
    (safeNumber(
      profil.params?.couts?.construction?.logement_m2,
      2300,
    ) ?? 2300);

  const coutConstructionCommerce =
    m2Commerce *
    (safeNumber(
      profil.params?.couts?.construction?.commerce_m2,
      2200,
    ) ?? 2200);

  const coutConstructionBureaux =
    m2Bureaux *
    (safeNumber(
      profil.params?.couts?.construction?.bureaux_m2,
      2400,
    ) ?? 2400);

  const coutConstructionTotal =
    coutConstructionLogement +
    coutConstructionCommerce +
    coutConstructionBureaux;

  const honorairesPct =
    safeNumber(profil.params?.couts?.honoraires_pct, 0.05) ?? 0.05;
  const fraisEtudesPct =
    safeNumber(profil.params?.couts?.frais_etudes_pct, 0.02) ?? 0.02;
  const fraisCommerciauxPct =
    safeNumber(profil.params?.couts?.frais_commerciaux_pct, 0.03) ?? 0.03;
  const fraisFinanciersPct =
    safeNumber(profil.params?.couts?.frais_financiers_pct, 0.04) ?? 0.04;
  const taxesPct =
    safeNumber(profil.params?.couts?.taxes_pct, 0.03) ?? 0.03;

  const honoraires = coutConstructionTotal * honorairesPct;
  const fraisEtudes = coutConstructionTotal * fraisEtudesPct;
  const fraisCommerciaux = caTotal * fraisCommerciauxPct;
  const fraisFinanciers = caTotal * fraisFinanciersPct;
  const taxes = caTotal * taxesPct;

  const coutHorsFoncierTotal =
    coutConstructionTotal +
    honoraires +
    fraisEtudes +
    fraisCommerciaux +
    fraisFinanciers +
    taxes;

  return {
    sdpTotale,
    ventes: {
      logement: {
        m2: round(m2Logement, 2),
        prix_m2: round(prixLogement, 0),
        ca: round(caLogement, 0),
      },
      commerce: {
        m2: round(m2Commerce, 2),
        prix_m2: round(prixCommerce, 0),
        ca: round(caCommerce, 0),
      },
      bureaux: {
        m2: round(m2Bureaux, 2),
        prix_m2: round(prixBureaux, 0),
        ca: round(caBureaux, 0),
      },
      ca_total: round(caTotal, 0),
    },
    couts_hors_foncier: {
      construction: round(coutConstructionTotal, 0),
      honoraires: round(honoraires, 0),
      frais_etudes: round(fraisEtudes, 0),
      frais_commerciaux: round(fraisCommerciaux, 0),
      frais_financiers: round(fraisFinanciers, 0),
      taxes: round(taxes, 0),
      cout_total_hors_foncier: round(coutHorsFoncierTotal, 0),
    },
    ca_total_brut: caTotal,
    cout_total_hors_foncier_brut: coutHorsFoncierTotal,
  };
}

// -------------------------------------------------
// Foncier + marge
// -------------------------------------------------

function computeFoncierEtMarge(
  caTotal: number,
  coutHorsFoncierTotal: number,
  sdpTotale: number,
  surfaceTerrainM2: number,
  profil: { code: string; params: PromoteurParams },
  foncier?: FoncierInput,
) {
  const margeCible =
    safeNumber(
      profil.params?.objectif?.marge_cible_pct_sur_ca,
      0.12, // 🔹 fallback 12 %
    ) ?? 0.12;

  const valeurTerrainResiduelle =
    caTotal * (1 - margeCible) - coutHorsFoncierTotal;

  let mode: FoncierMode = foncier?.mode ?? "none";
  if (!["saisi", "residuel", "none", "dvf"].includes(mode)) {
    mode = "none";
  }

  const valeurTerrainSaisi = safeNumber(
    foncier?.valeur_terrain_saisi,
    null,
  );

  let coutFoncierEffectif = 0;
  if (mode === "saisi" && valeurTerrainSaisi && valeurTerrainSaisi > 0) {
    coutFoncierEffectif = valeurTerrainSaisi;
  }

  const coutTotalEffectif = coutHorsFoncierTotal + coutFoncierEffectif;

  const margeMontant = caTotal - coutTotalEffectif;
  const margeTaux = caTotal > 0 ? margeMontant / caTotal : 0;

  let appreciation = "inconnu";
  if (margeTaux >= margeCible + 0.05) appreciation = "très confortable";
  else if (margeTaux >= margeCible) appreciation = "confortable";
  else if (margeTaux >= margeCible - 0.03) appreciation = "tendue";
  else appreciation = "faible";

  const sdp = sdpTotale > 0 ? sdpTotale : 1;
  const terrainM2 = surfaceTerrainM2 > 0 ? surfaceTerrainM2 : 1;

  const foncierResiduelParM2Sdp = valeurTerrainResiduelle / sdp;
  const foncierResiduelParM2Terrain = valeurTerrainResiduelle / terrainM2;

  const foncierSaisiParM2Sdp = coutFoncierEffectif / sdp;
  const foncierSaisiParM2Terrain = coutFoncierEffectif / terrainM2;

  const deltaVsResiduel = coutFoncierEffectif - valeurTerrainResiduelle;
  const deltaVsResiduelPct =
    valeurTerrainResiduelle !== 0
      ? deltaVsResiduel / valeurTerrainResiduelle
      : null;

  return {
    cout_foncier_effectif: round(coutFoncierEffectif, 0),
    cout_total_effectif: round(coutTotalEffectif, 0),
    valeur_terrain_residuelle: round(valeurTerrainResiduelle, 0),
    marge: {
      montant: round(margeMontant, 0),
      taux_sur_ca: round(margeTaux * 100, 1),
      marge_cible_pct_sur_ca: round(margeCible * 100, 1),
      appreciation,
    },
    foncier_detail: {
      mode,
      valeur_terrain_saisi: round(valeurTerrainSaisi, 0),
      valeur_terrain_residuelle: round(valeurTerrainResiduelle, 0),
      delta_vs_residuel: round(deltaVsResiduel, 0),
      delta_vs_residuel_pct:
        deltaVsResiduelPct != null
          ? round(deltaVsResiduelPct * 100, 1)
          : null,
      par_m2_sdp: {
        residuel: round(foncierResiduelParM2Sdp, 0),
        saisi:
          coutFoncierEffectif > 0
            ? round(foncierSaisiParM2Sdp, 0)
            : null,
      },
      par_m2_terrain: {
        residuel: round(foncierResiduelParM2Terrain, 0),
        saisi:
          coutFoncierEffectif > 0
            ? round(foncierSaisiParM2Terrain, 0)
            : null,
      },
    },
  };
}

// -------------------------------------------------
// Handler principal HTTP
// -------------------------------------------------

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Méthode non autorisée (POST uniquement).",
        }),
        {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const body = (await req.json()) as PromoteurInput;

    if (!body?.parcel || !body?.plu || !body?.projet) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "Champs requis manquants : parcel, plu, projet sont obligatoires.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const parcel = body.parcel;
    const plu = body.plu;
    const projet = body.projet;
    const financement = body.financement;
    const foncierInput = body.foncier;
    const pluOverrides = body.plu_overrides ?? null;

    // 1) Surface terrain
    let surfaceTerrain = safeNumber(parcel.surface_terrain_m2, null);

    if (surfaceTerrain == null && parcel.parcel_id) {
      surfaceTerrain = await fetchSurfaceFromCadastre(parcel);
    }

    if (surfaceTerrain == null) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "Impossible de déterminer la surface du terrain : fournissez surface_terrain_m2 ou assurez-vous que parcel_id existe dans cadastre_parcelles avec une surface.",
          details: { parcel_id: parcel.parcel_id ?? null },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 2) Chargement PLU (DB + overrides éventuels)
    const { ruleset: rulesetFromDb, meta: pluMetaFromDb } =
      await fetchPluRuleset(plu);

    const hasOverrides = !!pluOverrides?.ruleset;

    if (!rulesetFromDb && !hasOverrides) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "Aucun PLU normalisé trouvé pour cette commune / zone (plu_ruleset_normalized vide) et aucun plu_overrides fourni.",
          details: {
            commune_insee: plu.commune_insee,
            zone_code: plu.zone_code,
          },
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const finalRuleset: PluRuleset =
      (pluOverrides?.ruleset as PluRuleset | undefined) ??
      (rulesetFromDb as PluRuleset);

    const finalPluSource: Record<string, unknown> | null = (() => {
      if (!pluMetaFromDb && !pluOverrides?.source) return null;
      const base = (pluMetaFromDb ?? {}) as Record<string, unknown>;
      const over = (pluOverrides?.source ?? {}) as Record<string, unknown>;
      const merged = { ...base, ...over };
      if (!merged["plu_source_type"]) merged["plu_source_type"] = "override";
      return merged;
    })();

    // 3) Profil promoteur
    const profil = await fetchPromoteurProfile(financement);

    // 4) Étude archi
    const etudeArchi = computeEtudeArchi(
      surfaceTerrain,
      finalRuleset,
      projet,
    );

    // 5) Revenus & coûts hors foncier
    const revenusCouts = computeRevenusEtCoutsHorsFoncier(etudeArchi, profil);

    // 6) DVF / foncier
    let foncierEffective: FoncierInput = foncierInput
      ? { ...foncierInput }
      : { mode: "none" };
    let dvfInfo: any = null;

    if (foncierEffective.mode === "dvf") {
      const dvf = await estimateFoncierFromDvfByCommune(
        plu.commune_insee,
        surfaceTerrain,
      );

      if (dvf.valeur_terrain != null) {
        foncierEffective = {
          mode: "saisi",
          valeur_terrain_saisi: dvf.valeur_terrain,
        };

        dvfInfo = {
          source: "dvf_commune",
          ...dvf.meta,
          valeur_terrain_estimee: dvf.valeur_terrain,
          used_for_foncier: true,
        };
      } else {
        dvfInfo = {
          source: "dvf_commune",
          ...dvf.meta,
          used_for_foncier: false,
          human_message:
            "DVF n'a pas trouvé de transactions de terrains nus suffisamment comparables pour estimer un prix de terrain. Mimmoza utilisera la valeur de terrain résiduelle (calculée avec la marge cible) comme estimation du foncier.",
        };
        // On garde foncierEffective.mode = "dvf" pour activer le fallback plus bas
      }
    }

    // 7) Foncier + marge – 1er passage (sans fallback)
    let foncierEtMarge = computeFoncierEtMarge(
      revenusCouts.ca_total_brut ?? 0,
      revenusCouts.cout_total_hors_foncier_brut ?? 0,
      revenusCouts.sdpTotale,
      surfaceTerrain,
      profil,
      foncierEffective,
    );

    // 🎯 Fallback automatique : mode = "dvf" mais DVF inutilisable
    if (
      foncierEffective.mode === "dvf" &&
      dvfInfo &&
      dvfInfo.used_for_foncier === false
    ) {
      const valeurResiduelle = foncierEtMarge.valeur_terrain_residuelle ?? 0;

      foncierEffective = {
        mode: "saisi",
        valeur_terrain_saisi: valeurResiduelle > 0 ? valeurResiduelle : 0,
      };

      if (dvfInfo) {
        dvfInfo.human_message =
          "DVF n'a pas trouvé de transactions de terrains nus suffisamment comparables. Mimmoza utilise donc la valeur de terrain résiduelle comme estimation du foncier, calculée avec la marge cible (par défaut 12 %).";
        dvfInfo.used_for_foncier = true;
        dvfInfo.fallback_mode = "residuel_from_marge";
        dvfInfo.valeur_terrain_residuelle_utilisee = valeurResiduelle;
      }

      foncierEtMarge = computeFoncierEtMarge(
        revenusCouts.ca_total_brut ?? 0,
        revenusCouts.cout_total_hors_foncier_brut ?? 0,
        revenusCouts.sdpTotale,
        surfaceTerrain,
        profil,
        foncierEffective,
      );
    }

    const coutsFinal = {
      foncier: foncierEtMarge.cout_foncier_effectif,
      construction: revenusCouts.couts_hors_foncier.construction,
      honoraires: revenusCouts.couts_hors_foncier.honoraires,
      frais_etudes: revenusCouts.couts_hors_foncier.frais_etudes,
      frais_commerciaux: revenusCouts.couts_hors_foncier.frais_commerciaux,
      frais_financiers: revenusCouts.couts_hors_foncier.frais_financiers,
      taxes: revenusCouts.couts_hors_foncier.taxes,
      cout_total: foncierEtMarge.cout_total_effectif,
    };

    const responsePayload = {
      success: true,
      version: "promoteur-v1",
      inputs: {
        parcel,
        plu,
        projet,
        foncier: foncierInput ?? null,
        plu_overrides: pluOverrides ?? null,
      },
      plu_ruleset: {
        source: finalPluSource,
        ruleset: finalRuleset,
      },
      etude_archi: etudeArchi,
      bilan_promoteur: {
        ventes: revenusCouts.ventes,
        couts: coutsFinal,
        marge: foncierEtMarge.marge,
        indicateurs: {
          valeur_residuelle_terrain_theorique:
            foncierEtMarge.valeur_terrain_residuelle,
          marge_developpeur: foncierEtMarge.marge.appreciation,
        },
        foncier_detail: foncierEtMarge.foncier_detail,
        dvf_info: dvfInfo,
      },
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Erreur promoteur-v1:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Erreur interne promoteur-v1",
        details: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
