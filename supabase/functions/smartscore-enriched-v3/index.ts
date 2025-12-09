// supabase/functions/smartscore-enriched-v3/index.ts
import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

console.log("🚀 smartscore-enriched-v3 – orchestrator loaded");

// ----------------------------------------------------
// SUPABASE CLIENT (pour RPC écoles + BPE + santé)
// ----------------------------------------------------

const supabaseUrl = Deno.env.get("SUPABASE_URL") ??
  Deno.env.get("REST_URL") ?? "";
const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase =
  supabaseUrl && serviceKey
    ? createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    })
    : null;

// ----------------------------------------------------
// HELPERS TYPES
// ----------------------------------------------------

type IrcomRow = {
  tranche_label: string;
  foyers_fiscaux: number | null;
  retraites_foyers: number | null;
  rfr_total_milliers: number | null;
};

type EcolesStats = {
  nearestDistanceM: number | null;
  nearestName: string | null;
  nearestType: string | null;
  count300m: number;
  count500m: number;
  count1000m: number;
  scoreEcoles: number | null; // 0-100
};

// 👇 détail des pros de santé
type BpeHealthDetail = {
  type: string; // code interne (ex: "medecin_generaliste")
  label: string; // label lisible (ex: "Médecins généralistes")
  count: number; // nombre de points dans le rayon
  min_distance_m: number | null; // distance du plus proche en mètres
};

type BpeStats = {
  nb_commerces_proximite: number;
  nb_sante_proximite: number;
  nb_services_proximite: number;
  total_equipements_proximite: number;
  rayon_m: number;
  score_commerces: number;
  score_sante: number;
  score_services: number;
  scoreCommodites: number;
  // détails santé structurés
  sante_details?: BpeHealthDetail[] | null;
  medical_details?: BpeHealthDetail[] | null;
} | null;

// fiche santé commune (RPC get_fiche_sante_commune)
type HealthFiche = {
  code_commune: string;
  commune: string;
  population: number | null;
  densite_medecins_10000: number | null;
  densite_label: string;
  desert_medical_score: number | null;
  resume: string;
  kpi: {
    medecins_total: number | null;
    generalistes_total: number | null;
    generalistes_densite_10000: number | null;
    infirmiers_total: number | null;
    pharmacies_total: number | null;
    dentistes_total: number | null;
    autres_professionnels: number | null;
    etablissements_sante: number | null;
  };
};

// ----------------------------------------------------
// HELPERS GÉNÉRIQUES
// ----------------------------------------------------

/** Petit helper numérique local (indépendant de l'agent) */
function numOrNull(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Nettoyage des lignes brutes IRCOM */
function sanitizeIrcomRows(raw: any[]): IrcomRow[] {
  return raw.map((r) => ({
    tranche_label: (r.tranche_label ?? "").toString().trim(),
    foyers_fiscaux:
      r.foyers_fiscaux != null && r.foyers_fiscaux !== ""
        ? Number(r.foyers_fiscaux)
        : null,
    retraites_foyers:
      r.retraites_foyers != null && r.retraites_foyers !== ""
        ? Number(r.retraites_foyers)
        : null,
    rfr_total_milliers:
      r.rfr_total_milliers != null && r.rfr_total_milliers !== ""
        ? Number(r.rfr_total_milliers)
        : null,
  }));
}

/** Parse "0 à 10 000", "10 001 à 12 000", "+ de 100 000", "Total" */
function parseTranche(label: string): { min: number; max: number | null } {
  const raw = label.trim().toLowerCase();

  if (raw === "total") {
    return { min: 0, max: null };
  }

  if (raw.startsWith("+ de")) {
    const min = parseInt(raw.replace(/[^\d]/g, ""), 10);
    return { min, max: min + 50_000 }; // approx pour fermer la tranche haute
  }

  const parts = raw.split("à");
  if (parts.length === 2) {
    const min = parseInt(parts[0].replace(/[^\d]/g, ""), 10);
    const max = parseInt(parts[1].replace(/[^\d]/g, ""), 10);
    return { min, max };
  }

  return { min: 0, max: null };
}

/** Calcule la médiane brute à partir de tranches IRCOM */
function computeMedianFromGrouped(
  rows: IrcomRow[],
  field: "foyers_fiscaux" | "retraites_foyers",
): number | null {
  const cleaned = rows
    .filter(
      (r) =>
        r.tranche_label &&
        r.tranche_label.trim().toLowerCase() !== "total" &&
        r[field] != null &&
        r[field]! > 0,
    )
    .map((r) => {
      const { min, max } = parseTranche(r.tranche_label);
      return {
        min,
        max,
        count: r[field] as number,
      };
    })
    .sort((a, b) => a.min - b.min);

  if (!cleaned.length) return null;

  const total = cleaned.reduce((acc, r) => acc + r.count, 0);
  if (total === 0) return null;

  const medianPos = (total + 1) / 2;
  let cumulative = 0;

  for (const tranche of cleaned) {
    cumulative += tranche.count;
    if (cumulative >= medianPos) {
      if (!tranche.max) return tranche.min;
      return (tranche.min + tranche.max) / 2;
    }
  }

  return null;
}

// ----------------------------------------------------
// HELPERS ECOLES (RPC get_ecoles_proximite)
// ----------------------------------------------------

async function fetchEcolesStats(
  lat: number,
  lng: number,
): Promise<EcolesStats | null> {
  if (!supabase) {
    console.warn("⚠️ Supabase client not initialized, skip ecoles");
    return null;
  }

  try {
    const { data, error } = await supabase.rpc("get_ecoles_proximite", {
      lat,
      lng,
      rayon_m: 1000,
    });

    if (error) {
      console.error("❌ Erreur RPC get_ecoles_proximite:", error);
      return null;
    }

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      return {
        nearestDistanceM: null,
        nearestName: null,
        nearestType: null,
        count300m: 0,
        count500m: 0,
        count1000m: 0,
        scoreEcoles: null,
      };
    }

    // déjà trié par distance dans la fonction SQL
    const nearest = rows[0] as any;

    const count300m = rows.filter((r: any) => r.distance_m <= 300).length;
    const count500m = rows.filter((r: any) => r.distance_m <= 500).length;
    const count1000m = rows.length;

    const nearestDistance = nearest.distance_m as number;

    // --- Scoring simple 0-100 basé sur distance + densité ---
    let baseScore: number;
    if (nearestDistance <= 200) baseScore = 95;
    else if (nearestDistance <= 300) baseScore = 90;
    else if (nearestDistance <= 500) baseScore = 80;
    else if (nearestDistance <= 800) baseScore = 70;
    else if (nearestDistance <= 1200) baseScore = 60;
    else baseScore = 50;

    const densityBonus =
      (count300m >= 2 ? 5 : 0) +
      (count500m >= 4 ? 5 : 0) +
      (count1000m >= 8 ? 5 : 0);

    let scoreEcoles = Math.min(100, baseScore + densityBonus);
    if (!Number.isFinite(scoreEcoles)) scoreEcoles = baseScore;

    return {
      nearestDistanceM: nearestDistance,
      nearestName: nearest.nom ?? null,
      nearestType: nearest.type_etablissement ?? null,
      count300m,
      count500m,
      count1000m,
      scoreEcoles,
    };
  } catch (e) {
    console.error("❌ fetchEcolesStats error:", e);
    return null;
  }
}

// ----------------------------------------------------
// HELPERS SANTÉ (RPC get_fiche_sante_commune)
// ----------------------------------------------------

async function fetchHealthFicheForCommune(
  codeCommune: string,
): Promise<HealthFiche | null> {
  if (!supabase) {
    console.warn("⚠️ Supabase client not initialized, skip health fiche");
    return null;
  }
  if (!codeCommune) return null;

  try {
    const { data, error } = await supabase.rpc("get_fiche_sante_commune", {
      p_code_commune: codeCommune,
    });

    if (error) {
      console.error("❌ Erreur RPC get_fiche_sante_commune:", error);
      return null;
    }

    if (!data) return null;

    return data as HealthFiche;
  } catch (e) {
    console.error("❌ fetchHealthFicheForCommune error:", e);
    return null;
  }
}

// ----------------------------------------------------
// FUNCTION MAIN
// ----------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "Method not allowed" }),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const payload = await req.json().catch(() => null);
    console.log("📥 Reçu enriched-v3:", payload);

    if (!payload) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid JSON" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ----------------------------------------------------
    // Extract + normalisation (city/price alias)
    // ----------------------------------------------------
    const {
      address,
      cp,
      ville,
      surface,
      prix,
      travaux,
      userCriteria,
      meloId,
      type_local,
      dep_code,
      commune_code,
      lat,
      lon,
      transports,
    } = payload as Record<string, unknown>;

    // alias: city -> ville
    const rawVille =
      ville ?? (payload as any).city ?? null;

    // alias: price -> prix
    const rawPrix =
      prix ?? (payload as any).price ?? null;

    // alias: code_commune -> commune_code
    const rawCommuneCode =
      commune_code ?? (payload as any).code_commune ?? null;

    const surfaceNum = Number(surface ?? NaN);
    const prixNum = rawPrix != null ? Number(rawPrix) : NaN;
    const cpStr = cp != null ? cp.toString() : null;
    const typeLocalStr = (type_local ?? "Appartement").toString();
    const villeStr = rawVille != null ? rawVille.toString().trim() : null;

    let depCodeFinal = dep_code != null ? dep_code.toString() : null;
    let communeCodeFinal = rawCommuneCode != null
      ? rawCommuneCode.toString()
      : null;

    // Lat / lon (optionnels)
    const latNum = typeof lat === "number"
      ? lat
      : lat != null
      ? Number(lat)
      : NaN;
    const lonNum = typeof lon === "number"
      ? lon
      : lon != null
      ? Number(lon)
      : NaN;

    // Transports éventuels déjà calculés côté front
    let transportsData: any = transports ?? null;

    // score transports GTFS (transport-score)
    let transportScore: any = null;
    // Version simplifiée pour front / Base44
    let transportScoreSimple: any = null;

    // stats écoles
    let ecolesStats: EcolesStats | null = null;

    // stats BPE / commodités
    let bpeStats: BpeStats = null;
    let commoditesScore: number | null = null;

    // fiche santé commune
    let healthSummary: HealthFiche | null = null;

    // ----------------------------------------------------
    // Configs
    // ----------------------------------------------------
    const functionsUrl = Deno.env.get("FUNCTIONS_URL");
    const restUrl = Deno.env.get("REST_URL");
    const serviceKey = Deno.env.get("SERVICE_ROLE_KEY");

    if (!functionsUrl || !serviceKey) {
      console.error("❌ Missing config");
      return new Response(
        JSON.stringify({ success: false, error: "Missing config" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ----------------------------------------------------
    // Transports : transport-nearby-v1
    // ----------------------------------------------------
    try {
      if (
        !transportsData &&
        functionsUrl &&
        !Number.isNaN(latNum) &&
        !Number.isNaN(lonNum)
      ) {
        console.log("🚌 Appel → transport-nearby-v1");

        const trResp = await fetch(`${functionsUrl}/transport-nearby-v1`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            lat: latNum,
            lon: lonNum,
            maxDistanceKm: 1.0,
            limit: 20,
          }),
        });

        const trJson = await trResp.json().catch(() => null);
        console.log("📦 transport-nearby-v1 replied:", trJson);

        if (trResp.ok && trJson && (trJson as any).success) {
          transportsData = trJson;
        } else {
          console.warn("⚠️ transport-nearby-v1 non OK:", trResp.status, trJson);
        }
      }
    } catch (e) {
      console.error("⚠️ Transports (transport-nearby-v1) error:", e);
    }

    // ----------------------------------------------------
    // Transports – Scoring GTFS (transport-score)
    // ----------------------------------------------------
    try {
      if (functionsUrl && !Number.isNaN(latNum) && !Number.isNaN(lonNum)) {
        console.log("🚌 Appel → transport-score");

        const tsResp = await fetch(`${functionsUrl}/transport-score`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            lat: latNum,
            lng: lonNum,
            radius_m: 800,
          }),
        });

        const tsJson = await tsResp.json().catch(() => null);
        console.log("📦 transport-score replied:", tsJson);

        if (tsResp.ok && tsJson && (tsJson as any).success) {
          transportScore = tsJson;

          const scoring = (tsJson as any).scoring ?? {};
          const rawStats = (tsJson as any).rawTransport?.stats ?? {};

          transportScoreSimple = {
            score: scoring.scoreTransport ?? null,
            label: scoring.label ?? null,
            summary: scoring.summary ?? null,
            nearestStopName: rawStats.nearest_stop_name ?? null,
            nearestStopDistanceM: rawStats.nearest_stop_distance_m ?? null,
            totalStops500m: rawStats.total_stops_500m ?? null,
          };
        } else {
          console.warn("⚠️ transport-score non OK:", tsResp.status, tsJson);
        }
      } else {
        console.log(
          "ℹ️ Pas de lat/lon ou pas de functionsUrl – pas d'appel transport-score.",
        );
      }
    } catch (e) {
      console.error("⚠️ transport-score error:", e);
    }

    // ----------------------------------------------------
    // ECOLES – stats proximité
    // ----------------------------------------------------
    try {
      if (!Number.isNaN(latNum) && !Number.isNaN(lonNum)) {
        console.log("🏫 Appel → get_ecoles_proximite (via RPC)");
        ecolesStats = await fetchEcolesStats(latNum, lonNum);
        console.log("📊 ecolesStats:", ecolesStats);
      } else {
        console.log("ℹ️ Pas de lat/lon – on ne calcule pas ecolesStats.");
      }
    } catch (e) {
      console.error("⚠️ ecolesStats error:", e);
    }

    // ----------------------------------------------------
    // BPE – commodités & services (via RPC get_bpe_proximite)
    // + détails santé (sante_details / medical_details)
    // ----------------------------------------------------
    try {
      if (!Number.isNaN(latNum) && !Number.isNaN(lonNum) && supabase) {
        console.log("🏪 Appel → get_bpe_proximite (via RPC, rayon 400 m)");
        const { data, error } = await supabase.rpc("get_bpe_proximite", {
          p_lat: latNum,
          p_lon: lonNum,
          p_rayon_m: 400, // rayon SmartScore pour commodités
          p_types: null,
        });

        if (error) {
          console.error("❌ Erreur RPC get_bpe_proximite:", error);
        } else if (data) {
          const raw = data as any;

          // mapping des détails santé (optionnels)
          const mapHealthArray = (arr: any): BpeHealthDetail[] | null => {
            if (!Array.isArray(arr)) return null;
            const mapped = arr
              .map((d: any): BpeHealthDetail => {
                const type =
                  typeof d.type === "string"
                    ? d.type
                    : typeof d.categorie === "string"
                    ? d.categorie
                    : "inconnu";

                const label =
                  typeof d.label === "string"
                    ? d.label
                    : typeof d.libelle === "string"
                    ? d.libelle
                    : type;

                const count =
                  numOrNull(d.count) ??
                  numOrNull(d.nb) ??
                  numOrNull(d.n) ??
                  0;

                const min_distance_m =
                  numOrNull(d.min_distance_m) ??
                  numOrNull(d.distance_min_m) ??
                  null;

                return {
                  type,
                  label,
                  count: count ?? 0,
                  min_distance_m,
                };
              })
              .filter((d: BpeHealthDetail) => d.count > 0);

            return mapped.length > 0 ? mapped : null;
          };

          const santeDetails = mapHealthArray(raw.sante_details);
          const medicalDetails = mapHealthArray(raw.medical_details);

          bpeStats = {
            nb_commerces_proximite: raw.nb_commerces_proximite ?? 0,
            nb_sante_proximite: raw.nb_sante_proximite ?? 0,
            nb_services_proximite: raw.nb_services_proximite ?? 0,
            total_equipements_proximite: raw.total_equipements_proximite ?? 0,
            rayon_m: raw.rayon_m ?? 400,
            score_commerces: raw.score_commerces ?? 0,
            score_sante: raw.score_sante ?? 0,
            score_services: raw.score_services ?? 0,
            scoreCommodites: raw.scoreCommodites ?? 0,
            sante_details: santeDetails,
            medical_details: medicalDetails,
          };

          const rawScore = raw.scoreCommodites;
          commoditesScore =
            typeof rawScore === "number" && Number.isFinite(rawScore)
              ? rawScore
              : null;
        }

        console.log("📊 bpeStats:", bpeStats);
      } else {
        console.log(
          "ℹ️ Pas de lat/lon ou pas de client Supabase – pas d'appel BPE.",
        );
      }
    } catch (e) {
      console.error("⚠️ BPE / get_bpe_proximite error:", e);
    }

    // ----------------------------------------------------
    // STEP 2a : INSEE → IRCOM (auto mapping & démographie)
    // ----------------------------------------------------
    let inseeInfo: any = null;

    try {
      if (restUrl && villeStr && (!depCodeFinal || !communeCodeFinal)) {
        const villeClean = villeStr.replace("*", "").replace("%", "");

        // 1) Tentative via INSEE
        try {
          const inseeUrl = new URL(`${restUrl}/insee_communes_stats`);
          inseeUrl.searchParams.set(
            "select",
            "code_commune,commune,population,pct_moins_25,pct_plus_64",
          );
          inseeUrl.searchParams.set("commune", `ilike.*${villeClean}*`);
          inseeUrl.searchParams.set("limit", "1");

          const inseeResp = await fetch(inseeUrl.toString(), {
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
            },
          });

          const inseeJson = await inseeResp.json().catch(() => null);
          console.log("📊 INSEE stats raw:", inseeJson);

          if (inseeResp.ok && Array.isArray(inseeJson) &&
            inseeJson.length > 0) {
            const row = inseeJson[0] as any;

            inseeInfo = {
              code_commune: row.code_commune ?? null,
              commune: row.commune ?? villeStr,
              population: row.population ?? null,
              pct_moins_25: row.pct_moins_25 ?? null,
              pct_plus_64: row.pct_plus_64 ?? null,
            };

            if (row.code_commune) {
              if (!communeCodeFinal) {
                communeCodeFinal = row.code_commune.toString();
              }
              if (!depCodeFinal) {
                depCodeFinal = row.code_commune.toString().slice(0, 2);
              }
            }
          }
        } catch (inner) {
          console.error("⚠️ INSEE lookup error:", inner);
        }

        // 2) Fallback IRCOM direct
        if (!depCodeFinal || !communeCodeFinal) {
          try {
            const irUrlFallback = new URL(
              `${restUrl}/ircom_communes_raw_2023`,
            );
            irUrlFallback.searchParams.set(
              "select",
              "dep_code,commune_code,commune_libelle",
            );
            irUrlFallback.searchParams.set(
              "commune_libelle",
              `ilike.*${villeClean}*`,
            );

            const deptPrefixFromCp = cpStr ? cpStr.toString().slice(0, 2) : null;
            if (deptPrefixFromCp) {
              irUrlFallback.searchParams.set(
                "dep_code",
                `like.${deptPrefixFromCp}%`,
              );
            }

            irUrlFallback.searchParams.set("limit", "1");

            const irFallResp = await fetch(irUrlFallback.toString(), {
              headers: {
                apikey: serviceKey,
                Authorization: `Bearer ${serviceKey}`,
              },
            });

            const irFallJson = await irFallResp.json().catch(() => null);
            console.log("📊 IRCOM fallback mapping raw:", irFallJson);

            if (irFallResp.ok && Array.isArray(irFallJson) &&
              irFallJson.length > 0) {
              const meta = irFallJson[0] as any;

              // ✅ on ne COMPLETE que si vide (on n'écrase pas ce qui vient du payload)
              if (!depCodeFinal && meta.dep_code) {
                depCodeFinal = meta.dep_code.toString();
              }
              if (!communeCodeFinal && meta.commune_code) {
                communeCodeFinal = meta.commune_code.toString();
              }
            }
          } catch (fallbackErr) {
            console.error("⚠️ IRCOM direct lookup error:", fallbackErr);
          }
        }
      }
    } catch (e) {
      console.error("⚠️ INSEE→IRCOM mapping error (global):", e);
    }

    // ----------------------------------------------------
    // DVF
    // ----------------------------------------------------
    let dvfSummary: any = null;

    try {
      if (restUrl && cpStr && prixNum > 0 && surfaceNum > 0) {
        const pricePerM2 = prixNum / surfaceNum;

        const resp = await fetch(
          `${restUrl}/rpc/get_dvf_stats_for_cp_type`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
            },
            body: JSON.stringify({
              p_code_postal: cpStr,
              p_type_local: typeLocalStr,
            }),
          },
        );

        const json = await resp.json().catch(() => null);
        console.log("📊 DVF raw:", json);

        if (resp.ok && json) {
          const row = Array.isArray(json) ? json[0] : json;

          const medianM2 = Number(
            row?.median_price_m2 ?? row?.median_m2 ?? NaN,
          );
          const meanM2 = Number(
            row?.avg_price_m2 ??
              row?.mean_price_m2 ??
              row?.mean_m2 ??
              NaN,
          );
          const txCount = Number(
            row?.total_transactions ?? row?.tx_count ?? NaN,
          );

          let deltaVsMedian: number | null = null;
          if (medianM2 > 0) {
            deltaVsMedian = ((pricePerM2 - medianM2) / medianM2) * 100;
          }

          dvfSummary = {
            pricePerM2,
            medianM2: isNaN(medianM2) ? null : medianM2,
            meanM2: isNaN(meanM2) ? null : meanM2,
            transactions: isNaN(txCount) ? null : txCount,
            deltaVsMedian,
            raw: json,
          };
        }
      }
    } catch (e) {
      console.error("⚠️ DVF error:", e);
    }

    // ----------------------------------------------------
    // Travaux
    // ----------------------------------------------------
    let travauxSummary: any = null;

    try {
      if (travaux && prixNum > 0 && surfaceNum > 0) {
        const t = travaux as { montant_total?: number; description?: string };
        if (typeof t.montant_total === "number") {
          const travauxParM2 = t.montant_total / surfaceNum;
          const ratioTravauxPrix = t.montant_total / prixNum;

          travauxSummary = {
            montant_total: t.montant_total,
            description: t.description ?? null,
            travauxParM2,
            ratioTravauxPrix,
          };
        }
      }
    } catch (e) {
      console.error("⚠️ Travaux error:", e);
    }

    // ----------------------------------------------------
    // IRCOM : socio-fiscal
    // ----------------------------------------------------
    let socioFiscal: any = null;

    try {
      if (restUrl && depCodeFinal && communeCodeFinal) {
        const url = new URL(`${restUrl}/ircom_communes_raw_2023`);
        url.searchParams.set(
          "select",
          "tranche_label,foyers_fiscaux,retraites_foyers,rfr_total_milliers",
        );
        url.searchParams.set("dep_code", `eq.${depCodeFinal}`);
        url.searchParams.set("commune_code", `eq.${communeCodeFinal}`);

        const resp = await fetch(url.toString(), {
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
        });

        const raw = await resp.json().catch(() => null);
        console.log("📊 IRCOM raw:", raw);

        if (resp.ok && Array.isArray(raw) && raw.length > 0) {
          const rows = sanitizeIrcomRows(raw);
          console.log("📊 IRCOM sanitized:", rows);

          const revenuFiscalMedianAnnuel = computeMedianFromGrouped(
            rows,
            "foyers_fiscaux",
          );
          const retraiteMedianAnnuel = computeMedianFromGrouped(
            rows,
            "retraites_foyers",
          );

          const revenuFiscalMedianMensuel = revenuFiscalMedianAnnuel != null
            ? revenuFiscalMedianAnnuel / 12
            : null;
          const retraiteMedianMensuel = retraiteMedianAnnuel != null
            ? retraiteMedianAnnuel / 12
            : null;

          const totalRow = rows.find(
            (r) =>
              r.tranche_label &&
              r.tranche_label.trim().toLowerCase() === "total",
          );

          let revenuMoyenAnnuel: number | null = null;
          let revenuMoyenMensuel: number | null = null;

          if (
            totalRow &&
            totalRow.rfr_total_milliers != null &&
            totalRow.foyers_fiscaux != null &&
            totalRow.foyers_fiscaux > 0
          ) {
            revenuMoyenAnnuel =
              (totalRow.rfr_total_milliers * 1000) /
              totalRow.foyers_fiscaux;
            revenuMoyenMensuel = revenuMoyenAnnuel / 12;
          }

          const trancheRows = rows.filter(
            (r) =>
              r.tranche_label &&
              r.tranche_label.trim().toLowerCase() !== "total",
          );

          let revenuMinTranche: number | null = null;
          let revenuMaxTranche: number | null = null;

          if (trancheRows.length > 0) {
            const bounds = trancheRows.map((r) => parseTranche(r.tranche_label));
            revenuMinTranche = Math.min(...bounds.map((b) => b.min));
            revenuMaxTranche = Math.max(
              ...bounds.map((b) => (b.max ?? b.min)),
            );
          }

          socioFiscal = {
            revenu_fiscal_median_annuel_euros: revenuFiscalMedianAnnuel,
            retraite_median_annuel_euros: retraiteMedianAnnuel,
            revenu_fiscal_moyen_annuel_euros: revenuMoyenAnnuel,

            revenu_fiscal_median_euros: revenuFiscalMedianAnnuel,
            retraite_median_euros: retraiteMedianAnnuel,
            revenu_fiscal_moyen_euros: revenuMoyenAnnuel,

            revenu_fiscal_median_mensuel_euros: revenuFiscalMedianMensuel,
            retraite_median_mensuel_euros: retraiteMedianMensuel,
            revenu_fiscal_moyen_mensuel_euros: revenuMoyenMensuel,

            revenu_min_tranche_annuel_euros: revenuMinTranche,
            revenu_max_tranche_annuel_euros: revenuMaxTranche,
            revenu_min_tranche_mensuel_euros: revenuMinTranche != null
              ? revenuMinTranche / 12
              : null,
            revenu_max_tranche_mensuel_euros: revenuMaxTranche != null
              ? revenuMaxTranche / 12
              : null,

            insee: inseeInfo,
            raw,
          };
        }
      } else {
        if (inseeInfo) {
          socioFiscal = { insee: inseeInfo };
        }
      }
    } catch (e) {
      console.error("⚠️ IRCOM error:", e);
    }

    // ----------------------------------------------------
    // SANTÉ – fiche santé commune (RPC get_fiche_sante_commune)
// ----------------------------------------------------
    try {
      // normalisation éventuelle du code commune si on a un découpage dep+commune
      // ex: dep_code = "922", commune_code = "64" -> "92064"
      let healthCommuneCode = communeCodeFinal;

      if (
        healthCommuneCode &&
        depCodeFinal &&
        healthCommuneCode.length <= 3 &&       // ex: "64" ou "064"
        depCodeFinal.length >= 2
      ) {
        const dep2 = depCodeFinal.slice(0, 2);  // "92" dans "922"
        healthCommuneCode = `${dep2}${healthCommuneCode.padStart(3, "0")}`;
      }

      if (healthCommuneCode) {
        console.log("🩺 Appel → get_fiche_sante_commune (via RPC)", {
          healthCommuneCode,
        });
        healthSummary = await fetchHealthFicheForCommune(healthCommuneCode);
        console.log("📊 healthSummary:", healthSummary);
      } else {
        console.log("ℹ️ Pas de commune_code – pas de fiche santé commune.");
      }
    } catch (e) {
      console.error("⚠️ healthSummary / get_fiche_sante_commune error:", e);
    }

    // ----------------------------------------------------
    // Appel agent interne (v2)
    // ----------------------------------------------------
    console.log("🤖 Appel → smartscore-agent-v2");

    const agentResp = await fetch(`${functionsUrl}/smartscore-agent-v2`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        mode: "standard",
        source: "enriched-v3",
        context: {
          address,
          cp: cpStr,
          ville: villeStr,
          surface: surfaceNum,
          prix: prixNum,
          type_local: typeLocalStr,
          lat: Number.isNaN(latNum) ? null : latNum,
          lon: Number.isNaN(lonNum) ? null : lonNum,
          travaux,
          travauxSummary,
          userCriteria,
          meloId,
          dvfSummary,
          socioFiscal,
          transports: transportsData,
          transportScore: transportScoreSimple,
          dep_code: depCodeFinal,
          commune_code: communeCodeFinal,
          ecolesStats,
          ecolesScore: ecolesStats?.scoreEcoles ?? null,
          bpeStats,
          commoditesScore,
          // santé : on pousse aussi côté agent (pour usage futur)
          healthSummary,
          densiteMedecins10000: healthSummary?.densite_medecins_10000 ?? null,
          desertMedicalScore: healthSummary?.desert_medical_score ?? null,
          desertMedicalLabel: healthSummary?.densite_label ?? null,
        },
      }),
    });

    const agentJson = await agentResp.json().catch(() => null);
    console.log("📦 Agent replied:", agentJson);

    if (!agentResp.ok || !agentJson) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Agent error",
          agentStatus: agentResp.status,
          agentBody: agentJson,
          dvfSummary,
          travauxSummary,
          socioFiscal,
          transports: transportsData,
          transportScore: transportScoreSimple,
          ecolesStats,
          bpeStats,
          healthSummary,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ----------------------------------------------------
    // Intégration TransportScore dans les piliers / global (IDF)
    // ----------------------------------------------------
    let globalScore =
      (agentJson as any).globalScore ??
      (agentJson as any).smartscore ??
      null;
    let pillarScores: any = (agentJson as any).pillarScores ?? {};

    const tsScore =
      transportScoreSimple && typeof transportScoreSimple.score === "number"
        ? transportScoreSimple.score
        : null;

    const depForRegion = depCodeFinal ??
      (cpStr ? cpStr.toString().slice(0, 2) : null);
    const idfDeps = ["75", "77", "78", "91", "92", "93", "94", "95"];
    const isIDF =
      depForRegion != null &&
      idfDeps.some((d) => depForRegion.startsWith(d));

    if (isIDF && tsScore != null && globalScore != null) {
      const oldEmpl =
        typeof pillarScores.emplacement_env === "number"
          ? pillarScores.emplacement_env
          : null;

      let newEmpl: number;
      if (oldEmpl == null) {
        newEmpl = tsScore;
      } else {
        newEmpl = Math.round(0.7 * oldEmpl + 0.3 * tsScore);
      }
      pillarScores.emplacement_env = newEmpl;

      const keys = [
        "emplacement_env",
        "marche_liquidite",
        "qualite_bien",
        "rentabilite_prix",
        "risques_complexite",
      ];
      const vals: number[] = [];
      for (const k of keys) {
        const v = pillarScores[k];
        if (typeof v === "number") vals.push(v);
      }
      if (vals.length > 0) {
        globalScore = Math.round(
          vals.reduce((a, b) => a + b, 0) / vals.length,
        );
      }
    }

    // ----------------------------------------------------
    // OUTPUT FINAL
    // ----------------------------------------------------
    const output = {
      success: true,
      version: "v3",
      orchestrator: "smartscore-enriched-v3",
      smartscore: {
        globalScore,
        pillarScores,
        usedCriteriaCount: (agentJson as any).usedCriteriaCount ?? null,
        activePillars: (agentJson as any).activePillars ?? [],
      },
      input: {
        address,
        cp: cpStr,
        ville: villeStr,
        surface: surfaceNum,
        prix: prixNum,
        type_local: typeLocalStr,
        lat: Number.isNaN(latNum) ? null : latNum,
        lon: Number.isNaN(lonNum) ? null : lonNum,
        travaux,
        userCriteria,
        meloId,
        dep_code: depCodeFinal,
        commune_code: communeCodeFinal,
      },
      dvfSummary,
      travauxSummary,
      socioFiscal,
      transports: transportsData,
      transportScore: transportScoreSimple,
      ecolesStats,
      bpeStats,        // contient sante_details / medical_details
      commoditesScore,
      healthSummary,   // fiche santé commune exposée ici
      rawAgent: agentJson,
    };

    return new Response(JSON.stringify(output), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Internal error enriched-v3:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Internal error",
        details: String(err),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
