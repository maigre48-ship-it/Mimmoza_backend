// supabase/functions/besoin-logements-sociaux/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

interface CommuneGeo {
  nom: string;
  code: string;
  codesPostaux: string[];
}

type DeficitMode = "officiel" | "calcule" | "indisponible";
type RplsMode = "reel" | "estime" | "indisponible";

interface SruIndicators {
  tauxLLS?: number;
  objectifSRU?: number;
  deficitEstime?: number | null;
  deficitMode?: DeficitMode;
  statutSRU?: string;
  logementsSociaux?: number | null;
  residencesPrincipales?: number | null;
}

interface SneIndicators {
  demandesEnAttente?: number;
  attributionsAnnuelles?: number;
  tensionTheorique?: number;
  sourceTable?: "logements_sociaux_sne" | "logements_sociaux_sne_commune";
  sourceLabel?: string;
  annee?: number | null;
}

interface RplsIndicators {
  logementsRpls: number | null;
  logementsLocatifsSociaux: number | null;
  rplsAnnee: number | null;
  rplsSource: string | null;
}

interface SruRow {
  taux_lls: number | null;
  objectif_sru: number | null;
  logements_sociaux: number | null;
  logements_manquants: number | null;
  residences_principales: number | null;
  statut_sru: string | null;
}

interface SneRow {
  demandes_en_attente: number | null;
  attributions_annuelles: number | null;
  tension_demande?: number | null;
}

interface SneCommuneRow {
  demandes_en_attente: number | null;
  attributions_annuelles: number | null;
  annee: number | null;
  source: string | null;
}

interface RplsRow {
  logements_locatifs_sociaux: number | null;
  logements_rpls: number | null;
  annee: number | null;
  source: string | null;
}

interface AnalyseResult {
  commune: string;
  codePostal: string;
  codeInsee: string;
  statutSRU: string | null;
  tauxLLS: number | null;
  objectifSRU: number | null;
  deficitEstime: number | null;
  deficitMode: DeficitMode | null;
  logementsSociaux: number | null;
  residencesPrincipales: number | null;
  demandesEnAttente: number | null;
  attributionsAnnuelles: number | null;
  tensionTheorique: number | null;
  logementsRpls: number | null;
  logementsLocatifsSociaux: number | null;
  rplsAnnee: number | null;
  rplsSource: string | null;
  rplsMode: RplsMode;
  scoreLabel: "Élevé" | "Modéré" | "Faible" | "Indisponible";
  scorePartiel: boolean;
  dataStatus: "real" | "partial" | "unavailable";
  sources: string[];
  warnings: string[];
}

function buildSupabaseClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("Variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes.");
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

const GEO_API = "https://geo.api.gouv.fr/communes";
const GEO_FIELDS = "fields=nom,code,codesPostaux&format=json";

async function resolveCommune(query: string): Promise<CommuneGeo | null> {
  const trimmed = query.trim();
  const isFiveDigits = /^\d{5}$/.test(trimmed);

  if (isFiveDigits) {
    const byInsee = await fetch(`${GEO_API}/${encodeURIComponent(trimmed)}?${GEO_FIELDS}`);

    if (byInsee.ok) {
      const commune = (await byInsee.json()) as CommuneGeo;
      if (commune?.code) return commune;
    }

    const byPostal = await fetch(`${GEO_API}?codePostal=${encodeURIComponent(trimmed)}&${GEO_FIELDS}`);

    if (byPostal.ok) {
      const data = (await byPostal.json()) as CommuneGeo[];
      if (Array.isArray(data) && data.length > 0) return data[0];
    }

    return null;
  }

  const res = await fetch(
    `${GEO_API}?nom=${encodeURIComponent(trimmed)}&boost=population&limit=5&${GEO_FIELDS}`,
  );

  if (!res.ok) return null;

  const data = (await res.json()) as CommuneGeo[];
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function computeDeficitSru(input: {
  objectifSRU: number | null | undefined;
  logementsSociaux: number | null | undefined;
  logementsManquants: number | null | undefined;
  residencesPrincipales: number | null | undefined;
  statutSRU?: string | null;
  tauxLLS?: number | null;
}): { deficitEstime: number | null; deficitMode: DeficitMode } {
  const {
    objectifSRU,
    logementsSociaux,
    logementsManquants,
    residencesPrincipales,
    statutSRU,
    tauxLLS,
  } = input;

  if (logementsManquants != null && logementsManquants >= 0) {
    return { deficitEstime: logementsManquants, deficitMode: "officiel" };
  }

  const objectifAtteintParStatut =
    statutSRU != null && statutSRU.toLowerCase().includes("atteint");

  const objectifAtteintParTaux =
    tauxLLS != null && objectifSRU != null && tauxLLS >= objectifSRU;

  if (objectifAtteintParStatut || objectifAtteintParTaux) {
    return { deficitEstime: 0, deficitMode: "calcule" };
  }

  if (
    objectifSRU != null &&
    logementsSociaux != null &&
    residencesPrincipales != null &&
    residencesPrincipales > 0
  ) {
    return {
      deficitEstime: Math.max(
        0,
        Math.round((objectifSRU / 100) * residencesPrincipales - logementsSociaux),
      ),
      deficitMode: "calcule",
    };
  }

  if (
    objectifSRU != null &&
    logementsSociaux != null &&
    tauxLLS != null &&
    tauxLLS > 0
  ) {
    const residencesPrincipalesEstimees = Math.round(logementsSociaux / (tauxLLS / 100));

    return {
      deficitEstime: Math.max(
        0,
        Math.round((objectifSRU / 100) * residencesPrincipalesEstimees - logementsSociaux),
      ),
      deficitMode: "calcule",
    };
  }

  return { deficitEstime: null, deficitMode: "indisponible" };
}

async function fetchSruIndicators(
  client: SupabaseClient,
  codeInsee: string,
): Promise<SruIndicators | null> {
  const { data, error } = await client
    .from("logements_sociaux_sru")
    .select("taux_lls, objectif_sru, logements_sociaux, logements_manquants, residences_principales, statut_sru")
    .eq("code_insee", codeInsee)
    .maybeSingle<SruRow>();

  if (error || !data) return null;

  const objectifSRU = data.objectif_sru != null ? Number(data.objectif_sru) : null;
  const tauxLLS = data.taux_lls != null ? Number(data.taux_lls) : null;
  const logementsSociaux = data.logements_sociaux ?? null;
  const residencesPrincipales = data.residences_principales ?? null;
  const statutSRU = data.statut_sru ?? null;

  const { deficitEstime, deficitMode } = computeDeficitSru({
    objectifSRU,
    logementsSociaux,
    logementsManquants: data.logements_manquants ?? null,
    residencesPrincipales,
    statutSRU,
    tauxLLS,
  });

  return {
    tauxLLS: tauxLLS ?? undefined,
    objectifSRU: objectifSRU ?? undefined,
    statutSRU: statutSRU ?? undefined,
    deficitEstime,
    deficitMode,
    logementsSociaux,
    residencesPrincipales,
  };
}

function normalizeSneIndicators(
  row: {
    demandes_en_attente: number | null;
    attributions_annuelles: number | null;
    tension_demande?: number | null;
    annee?: number | null;
    source?: string | null;
  },
  sourceTable: "logements_sociaux_sne" | "logements_sociaux_sne_commune",
): SneIndicators | null {
  const result: SneIndicators = {
    sourceTable,
    sourceLabel: sourceTable === "logements_sociaux_sne" ? "SNE" : row.source || "SNE commune",
    annee: row.annee ?? null,
  };

  if (row.demandes_en_attente != null) result.demandesEnAttente = Number(row.demandes_en_attente);
  if (row.attributions_annuelles != null) result.attributionsAnnuelles = Number(row.attributions_annuelles);

  if (row.tension_demande != null) {
    result.tensionTheorique = Number(row.tension_demande);
  } else if (
    row.demandes_en_attente != null &&
    row.attributions_annuelles != null &&
    Number(row.attributions_annuelles) > 0
  ) {
    result.tensionTheorique = Number(
      (Number(row.demandes_en_attente) / Number(row.attributions_annuelles)).toFixed(1),
    );
  }

  return result.demandesEnAttente != null ||
    result.attributionsAnnuelles != null ||
    result.tensionTheorique != null
    ? result
    : null;
}

async function fetchSneDemandIndicators(
  client: SupabaseClient,
  codeInsee: string,
): Promise<SneIndicators | null> {
  const primary = await client
    .from("logements_sociaux_sne")
    .select("demandes_en_attente, attributions_annuelles, tension_demande")
    .eq("code_insee", codeInsee)
    .maybeSingle<SneRow>();

  if (!primary.error && primary.data) {
    const normalized = normalizeSneIndicators(primary.data, "logements_sociaux_sne");
    if (normalized) return normalized;
  }

  const fallback = await client
    .from("logements_sociaux_sne_commune")
    .select("demandes_en_attente, attributions_annuelles, annee, source")
    .eq("code_insee", codeInsee)
    .order("annee", { ascending: false })
    .limit(1)
    .maybeSingle<SneCommuneRow>();

  if (fallback.error || !fallback.data) return null;

  return normalizeSneIndicators(fallback.data, "logements_sociaux_sne_commune");
}

async function fetchRplsIndicators(
  client: SupabaseClient,
  codeInsee: string,
): Promise<RplsIndicators | null> {
  const { data, error } = await client
    .from("logements_sociaux_rpls")
    .select("logements_locatifs_sociaux, logements_rpls, annee, source")
    .eq("code_insee", codeInsee)
    .order("annee", { ascending: false })
    .limit(1)
    .maybeSingle<RplsRow>();

  if (error) {
    console.error(`[besoin-logements-sociaux] RPLS error: ${error.message}`);
    return null;
  }

  if (!data) return null;

  const logementsRpls = data.logements_rpls != null ? Number(data.logements_rpls) : null;
  const logementsLocatifsSociaux =
    data.logements_locatifs_sociaux != null ? Number(data.logements_locatifs_sociaux) : null;

  if (logementsRpls == null && logementsLocatifsSociaux == null) return null;

  return {
    logementsRpls,
    logementsLocatifsSociaux,
    rplsAnnee: data.annee ?? null,
    rplsSource: data.source ?? "RPLS",
  };
}

function computeScore(
  tauxLLS: number,
  tensionTheorique: number,
): "Élevé" | "Modéré" | "Faible" {
  if (tensionTheorique >= 8 || tauxLLS < 18) return "Élevé";
  if (tensionTheorique >= 4 || tauxLLS < 23) return "Modéré";
  return "Faible";
}

function computeScoreSruOnly(
  tauxLLS: number | null,
  deficitEstime: number | null,
): "Élevé" | "Modéré" | "Faible" | "Indisponible" {
  if (tauxLLS == null && deficitEstime == null) return "Indisponible";
  if (deficitEstime != null && deficitEstime > 300) return "Élevé";
  if (deficitEstime != null && deficitEstime > 100) return "Modéré";
  if (tauxLLS != null && tauxLLS < 20) return "Modéré";
  return "Faible";
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  try {
    const body = await req.json().catch(() => null);
    const query = typeof body?.query === "string" ? body.query.trim() : "";

    if (!query) return json({ error: "Le paramètre 'query' est requis." }, 400);

    const commune = await resolveCommune(query);
    if (!commune) return json({ error: `Commune introuvable pour la recherche : "${query}".` }, 404);

    const codeInsee = commune.code;
    const codePostal = commune.codesPostaux?.[0] ?? "";
    const supabase = buildSupabaseClient();

    const [sruData, sneData, rplsData] = await Promise.all([
      fetchSruIndicators(supabase, codeInsee),
      fetchSneDemandIndicators(supabase, codeInsee),
      fetchRplsIndicators(supabase, codeInsee),
    ]);

    const hasSru = sruData !== null;
    const hasSne = sneData !== null;
    const hasRpls = rplsData !== null;

    const tauxLLS = sruData?.tauxLLS ?? null;
    const deficitEstime = sruData?.deficitEstime ?? null;
    const tensionTheorique = sneData?.tensionTheorique ?? null;
    const residencesPrincipales = sruData?.residencesPrincipales ?? null;
    const logementsSociaux = sruData?.logementsSociaux ?? null;

    const logementsRplsEstimes =
      tauxLLS != null && logementsSociaux != null
        ? logementsSociaux
        : tauxLLS != null && residencesPrincipales != null
          ? Math.round((tauxLLS / 100) * residencesPrincipales)
          : null;

    const logementsRplsFinal =
      rplsData?.logementsRpls ??
      rplsData?.logementsLocatifsSociaux ??
      logementsRplsEstimes;

    const rplsMode: RplsMode =
      rplsData ? "reel" : logementsRplsEstimes != null ? "estime" : "indisponible";

    if (!hasSru && !hasSne && rplsMode === "indisponible") {
      const result: AnalyseResult = {
        commune: commune.nom,
        codePostal,
        codeInsee,
        statutSRU: null,
        tauxLLS: null,
        objectifSRU: null,
        deficitEstime: null,
        deficitMode: null,
        logementsSociaux: null,
        residencesPrincipales: null,
        demandesEnAttente: null,
        attributionsAnnuelles: null,
        tensionTheorique: null,
        logementsRpls: null,
        logementsLocatifsSociaux: null,
        rplsAnnee: null,
        rplsSource: null,
        rplsMode,
        scoreLabel: "Indisponible",
        scorePartiel: false,
        dataStatus: "unavailable",
        sources: ["geo.api.gouv.fr"],
        warnings: ["Aucune donnée SRU/SNE/RPLS réelle ou estimable trouvée pour cette commune."],
      };

      return json(result);
    }

    let scoreLabel: AnalyseResult["scoreLabel"];
    let scorePartiel: boolean;

    if (hasSru && hasSne && tauxLLS != null && tensionTheorique != null) {
      scoreLabel = computeScore(tauxLLS, tensionTheorique);
      scorePartiel = false;
    } else if (hasSru) {
      scoreLabel = computeScoreSruOnly(tauxLLS, deficitEstime);
      scorePartiel = scoreLabel !== "Indisponible";
    } else {
      scoreLabel = "Indisponible";
      scorePartiel = false;
    }

    const sources: string[] = ["geo.api.gouv.fr"];
    if (hasSru) sources.push("Inventaire SRU");

    if (hasSne) {
      if (sneData.sourceTable === "logements_sociaux_sne_commune") {
        sources.push(
          sneData.annee
            ? `${sneData.sourceLabel || "SNE commune"} ${sneData.annee}`
            : sneData.sourceLabel || "SNE commune",
        );
      } else {
        sources.push("SNE");
      }
    }

    if (hasRpls) {
      sources.push(
        rplsData.rplsAnnee
          ? `${rplsData.rplsSource || "RPLS"} ${rplsData.rplsAnnee}`
          : rplsData.rplsSource || "RPLS",
      );
    } else if (rplsMode === "estime") {
      sources.push("RPLS estimé depuis SRU");
    }

    const warnings: string[] = [];

    if (hasSru && !hasSne) {
      warnings.push("Données SRU disponibles.");
      warnings.push("Données SNE absentes : demandes et attributions indisponibles.");
    }

    if (!hasSru && hasSne) {
      warnings.push("Données SNE disponibles.");
      warnings.push("Données SRU absentes : taux LLS et déficit indisponibles.");
    }

    if (!hasRpls && rplsMode === "estime") {
      warnings.push("RPLS réel absent : estimation calculée depuis les données SRU disponibles.");
    } else if (!hasRpls) {
      warnings.push("Données RPLS absentes pour cette commune.");
    }

    if (sneData?.sourceTable === "logements_sociaux_sne_commune") {
      warnings.push("Données SNE issues du fallback communal logements_sociaux_sne_commune.");
    }

    if (sruData?.deficitMode === "indisponible" && deficitEstime == null) {
      warnings.push(
        "Déficit estimé indisponible : logements manquants, résidences principales et estimation via taux LLS indisponibles.",
      );
    }

    if (scorePartiel) {
      warnings.push("Score calculé sur données SRU uniquement (partiel, sans tension de demande).");
    }

    const dataStatus: AnalyseResult["dataStatus"] =
      hasSru && hasSne ? "real" : "partial";

    const result: AnalyseResult = {
      commune: commune.nom,
      codePostal,
      codeInsee,
      statutSRU: sruData?.statutSRU ?? null,
      tauxLLS,
      objectifSRU: sruData?.objectifSRU ?? null,
      deficitEstime,
      deficitMode: sruData?.deficitMode ?? null,
      logementsSociaux,
      residencesPrincipales,
      demandesEnAttente: sneData?.demandesEnAttente ?? null,
      attributionsAnnuelles: sneData?.attributionsAnnuelles ?? null,
      tensionTheorique,
      logementsRpls: logementsRplsFinal,
      logementsLocatifsSociaux: logementsRplsFinal,
      rplsAnnee: rplsData?.rplsAnnee ?? null,
      rplsSource: rplsData?.rplsSource ?? (rplsMode === "estime" ? "Estimation Mimmoza depuis SRU" : null),
      rplsMode,
      scoreLabel,
      scorePartiel,
      dataStatus,
      sources,
      warnings,
    };

    console.log(
      `[Mimmoza] ${dataStatus} | ${commune.nom} (${codeInsee}) | SRU=${hasSru} SNE=${hasSne} RPLS=${hasRpls} RPLS_MODE=${rplsMode}`,
    );

    return json(result);
  } catch (err) {
    console.error(
      "[besoin-logements-sociaux] erreur non gérée:",
      err instanceof Error ? err.message : err,
    );

    return json({ error: "Erreur interne du serveur." }, 500);
  }
});