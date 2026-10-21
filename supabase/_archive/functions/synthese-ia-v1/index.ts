// ============================================================================
// synthese-ia-v1 — Supabase Edge Function (Deno)
// Marchand semi-prédictif : Engine canonique + Calibration IA (estimations p50/p90 + deltas)
//
// FIXES v1.1:
// ✅ Confidence CAP si estimations IA utilisées (anti-survente)
// ✅ Addendum serveur dans la narrative si estimations IA appliquées (cohérence UX)
// ✅ Garde-fou unités charges : si unité inconnue → interdiction cashflow mensuel
// ✅ OpportunityScore : narrative = indicatif, score final = predictif canonique
//
// FIXES v1.2:
// ✅ Prompt: interdiction d'inventer des chiffres d'indicateurs (RiskPressureIndex, etc.)
// ✅ Prompt: si chargesUnit=INCONNU → interdiction de toute soustraction (loyer - charges)
// ✅ Post-traitement narrative: "données manquantes IMPORTANT durées" → "durées estimées via calibration IA"
// ✅ Post-traitement narrative: corrige RiskPressureIndex chiffré si différent du canon serveur
//
// FIXES v1.3:
// ✅ normalizeTableTokens: "DONNÉE ABSENTE" → "NON CALCULABLE" dans le tableau conformité
// ✅ normalizeDurationMentionsAfterCalibration: "durée X absente" → "estimée via calibration IA"
//
// FIXES v1.5:
// ✅ Nouveau prompt template structuré (style mémo comité marchand)
// ✅ Placeholders canoniques remplacés dynamiquement dans buildPrompt
// ✅ Section "Capital at Risk" ajoutée
//
// FIXES v1.6:
// ✅ Règle Prix Max d'Engagement (calcul arithmétique si prixRevente présent)
// ✅ Règle Hypothèses Prudentes (taggées, jamais chiffrées)
// ✅ Anti-Extrapolation renforcée (version compacte)
// ✅ Capital at Risk rewrité (solidité économique)
// ✅ Décision finale enrichie (arbitrage capital + prix max calculé)
//
// FIXES v1.7:
// ✅ Contrainte Marge brute < seuil + discount non sécurisé → GO/GO_AGRESSIF INTERDIT
// ✅ getDecisionConstraintV2 contextuelle (underMarginThreshold + discountSecurise)
// ✅ validateVerdictV2 alignée sur la nouvelle contrainte
// ✅ readMargeBrutePct reader best-effort
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const MODEL = "claude-sonnet-4-20250514";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json; charset=utf-8",
};

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: CORS_HEADERS,
  });
}

// ── Seuils marchand Mimmoza ──────────────────────────────────────────────
const SEUILS_MARCHAND = {
  margeBruteCible: 12, // %
  rendementBrutMinimal: 5, // %
  dureeCibleDetentionMois: 18,
};

// ── Garde-fous semi-prédictif ────────────────────────────────────────────
const CALIBRATION_LIMITS = {
  worksMonths: { min: 0, max: 12 },
  holdingMonths: { min: 1, max: 36 },
  marketingMonths: { min: 0, max: 18 },

  maxAbsDeltaSumDefault: 8,
  maxAbsDeltaSumIfMissingCritical: 3,

  confidenceAdjMin: -10,
  confidenceAdjMax: +5,

  // Confidence caps when estimates are used (anti-survente)
  confidenceCapIf1Estimate: 78,
  confidenceCapIf2Estimates: 72,
  confidenceCapIf3PlusEstimates: 68,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers parsing
// ─────────────────────────────────────────────────────────────────────────────

function asNumber(v: any): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;

  let s = v
    .trim()
    .replace(/\u202F/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/[€%]/g, "")
    .replace(/m²|m2/gi, "")
    .replace(/\s+/g, "");

  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    const dotCount = (s.match(/\./g) || []).length;
    if (dotCount > 1) s = s.replace(/\./g, "");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function isEmptyLoose(v: any) {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (!s) return true;
    if (s === "—" || s === "-" || s === "n/a" || s === "na") return true;
    if (s.includes("non calculable")) return true;
    if (s.includes("donnée absente") || s.includes("donnee absente")) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Readers
// ─────────────────────────────────────────────────────────────────────────────

function readSmartScore(data: any): number | null {
  return (
    asNumber(data?.smartScore?.score) ??
    asNumber(data?.smartscore?.score) ??
    asNumber(data?.smart_score?.score) ??
    asNumber(data?.smartScore) ??
    asNumber(data?.smartscore) ??
    asNumber(data?.smart_score) ??
    null
  );
}

function readRendementBrut(data: any): number | null {
  return (
    asNumber(data?.rentabilite?.rendementBrutPct) ??
    asNumber(data?.rentabilite?.rendementBrut) ??
    asNumber(data?.rendementBrutPct) ??
    asNumber(data?.rendementBrut) ??
    null
  );
}

function readVariation5Ans(data: any): number | null {
  return (
    asNumber(data?.marche?.variation5AnsPct) ??
    asNumber(data?.marche?.variation5Ans) ??
    asNumber(data?.marcheRisques?.dvf?.variation5AnsPct) ??
    asNumber(data?.marcheRisques?.dvf?.variation5Ans) ??
    null
  );
}

function readDvfVolume(data: any): number | null {
  return (
    asNumber(data?.marche?.dvfVolume) ??
    asNumber(data?.marcheRisques?.dvf?.transactions) ??
    asNumber(data?.marcheRisques?.dvf?.nbTransactions) ??
    null
  );
}

function readTensionLocative(data: any): number | null {
  const n = asNumber(data?.tensionLocative);
  if (n != null) return n;
  const b = data?.tensionLocative;
  if (typeof b === "boolean") return b ? 75 : 35;
  if (typeof b === "string") {
    const s = b.toLowerCase();
    if (s.includes("fort")) return 80;
    if (s.includes("moy")) return 60;
    if (s.includes("faible")) return 35;
  }
  return null;
}

function readPrix(data: any): number | null {
  return (
    asNumber(data?.prix) ??
    asNumber(data?.price) ??
    asNumber(data?.prixAchat) ??
    asNumber(data?.purchasePrice) ??
    asNumber(data?.deal?.prix) ??
    asNumber(data?.deal?.price) ??
    asNumber(data?.deal?.prixAchat) ??
    asNumber(data?.property?.prix) ??
    asNumber(data?.property?.price) ??
    asNumber(data?.bien?.prix) ??
    asNumber(data?.bien?.price) ??
    null
  );
}

function readSurface(data: any): number | null {
  return (
    asNumber(data?.surface) ??
    asNumber(data?.surfaceM2) ??
    asNumber(data?.surfaceHabitable) ??
    asNumber(data?.area) ??
    asNumber(data?.deal?.surface) ??
    asNumber(data?.deal?.surfaceM2) ??
    asNumber(data?.property?.surface) ??
    asNumber(data?.property?.surfaceHabitable) ??
    asNumber(data?.bien?.surface) ??
    null
  );
}

function readLocalisation(data: any): string | null {
  const v =
    data?.localisation ??
    data?.location ??
    data?.address ??
    data?.adresse ??
    data?.city ??
    data?.ville ??
    data?.zipCode ??
    data?.codePostal ??
    data?.deal?.localisation ??
    data?.deal?.address ??
    data?.property?.address ??
    data?.property?.city ??
    data?.bien?.adresse ??
    null;

  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function readTravauxMois(data: any): number | null {
  return (
    asNumber(data?.travauxMois) ??
    asNumber(data?.worksMonths) ??
    asNumber(data?.workMonths) ??
    asNumber(data?.planning?.worksMonths) ??
    asNumber(data?.calendar?.worksMonths) ??
    asNumber(data?.deal?.calendar?.worksMonths) ??
    asNumber(data?.deal?.planning?.worksMonths) ??
    null
  );
}

function readDureeDetentionMois(data: any): number | null {
  return (
    asNumber(data?.dureeDetentionMois) ??
    asNumber(data?.holdingMonths) ??
    asNumber(data?.detentionMonths) ??
    asNumber(data?.planning?.holdingMonths) ??
    asNumber(data?.calendar?.holdingMonths) ??
    asNumber(data?.deal?.calendar?.holdingMonths) ??
    asNumber(data?.deal?.planning?.holdingMonths) ??
    null
  );
}

function readDelaiCommercialisationMois(data: any): number | null {
  return (
    asNumber(data?.delaiCommercialisationMois) ??
    asNumber(data?.marketingMonths) ??
    asNumber(data?.saleMonths) ??
    asNumber(data?.resaleMonths) ??
    asNumber(data?.planning?.marketingMonths) ??
    asNumber(data?.calendar?.marketingMonths) ??
    asNumber(data?.deal?.calendar?.marketingMonths) ??
    asNumber(data?.deal?.planning?.marketingMonths) ??
    null
  );
}

// ── Reader marge brute (best-effort) ─────────────────────────────────────
function readMargeBrutePct(data: any): number | null {
  return (
    asNumber(data?.margeBrutePct) ??
    asNumber(data?.margeBrute) ??
    asNumber(data?.deal?.margeBrutePct) ??
    asNumber(data?.deal?.margeBrute) ??
    null
  );
}

function readDvfRecentTransactions(data: any): any[] {
  const cands = [
    data?.dvfRecent,
    data?.marche?.dvfRecent,
    data?.marcheRisques?.dvf?.transactions,
    data?.core?.dvf?.transactions,
  ];
  for (const v of cands) {
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

function quantileNearestRank(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const clampedQ = Math.max(0, Math.min(1, q));
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(clampedQ * sorted.length) - 1));
  return sorted[idx];
}

function parseDateSafe(s: any): string | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

function computeDvfRecentAnalysis(args: { dvf: any[]; prixM2Deal?: number | null }) {
  const { dvf, prixM2Deal } = args;
  if (!Array.isArray(dvf) || dvf.length === 0) return null;

  const rows: Array<{ date: string | null; prixM2: number; valeur: number | null; surface: number | null }> = [];

  for (const t of dvf) {
    const valeur =
      asNumber(t?.valeur_fonciere) ??
      asNumber(t?.valeurFonciere) ??
      asNumber(t?.price) ??
      null;

    const surface =
      asNumber(t?.surface_reelle_bati) ??
      asNumber(t?.surface) ??
      asNumber(t?.surfaceM2) ??
      null;

    const prixM2Direct = asNumber(t?.prix_m2) ?? asNumber(t?.prixM2) ?? null;

    const prixM2 =
      prixM2Direct ??
      (valeur != null && surface != null && surface > 0 ? valeur / surface : null);

    if (prixM2 == null || prixM2 <= 0) continue;

    const date = parseDateSafe(t?.date_mutation ?? t?.date ?? t?.mutationDate ?? null);

    rows.push({ date, prixM2, valeur, surface });
  }

  if (!rows.length) return null;

  const prices = rows.map((r) => r.prixM2).sort((a, b) => a - b);
  const count = prices.length;

  const median = quantileNearestRank(prices, 0.5);
  const p25 = quantileNearestRank(prices, 0.25);
  const p75 = quantileNearestRank(prices, 0.75);

  const mean = Math.round((prices.reduce((a, x) => a + x, 0) / count) * 10) / 10;
  const min = prices[0];
  const max = prices[prices.length - 1];

  const spreadPct =
    median != null && p25 != null && p75 != null && median > 0
      ? Math.round((((p75 - p25) / median) * 100) * 10) / 10
      : null;

  const dealPos =
    median != null && prixM2Deal != null && median > 0
      ? Math.round((((prixM2Deal - median) / median) * 100) * 10) / 10
      : null;

  const liquidity = count >= 30 ? "FORTE" : count >= 10 ? "MOYEN" : "FAIBLE";

  const dates = rows.map((r) => r.date).filter(Boolean) as string[];
  dates.sort();
  const dateMin = dates.length ? dates[0] : null;
  const dateMax = dates.length ? dates[dates.length - 1] : null;

  let comps = rows.slice();
  if (prixM2Deal != null) {
    comps.sort((a, b) => Math.abs(a.prixM2 - prixM2Deal) - Math.abs(b.prixM2 - prixM2Deal));
  } else {
    comps.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }
  comps = comps.slice(0, 8);

  return {
    count,
    dateMin,
    dateMax,
    medianPrixM2: median == null ? null : Math.round(median * 10) / 10,
    meanPrixM2: Number.isFinite(mean) ? mean : null,
    p25PrixM2: p25 == null ? null : Math.round(p25 * 10) / 10,
    p75PrixM2: p75 == null ? null : Math.round(p75 * 10) / 10,
    minPrixM2: min == null ? null : Math.round(min * 10) / 10,
    maxPrixM2: max == null ? null : Math.round(max * 10) / 10,
    spreadPct,
    dealPositionPct: dealPos,
    liquidity,
    comps: comps.map((r) => ({
      date: r.date ?? undefined,
      prixM2: Math.round(r.prixM2 * 10) / 10,
      valeur: r.valeur ?? undefined,
      surface: r.surface ?? undefined,
    })),
  };
}

// Charges unit inference (best-effort). If unsure => INCONNU.
type ChargesUnit = "ANNUEL" | "MENSUEL" | "INCONNU";
function inferChargesUnit(data: any): ChargesUnit {
  const raw =
    data?.chargesUnit ??
    data?.chargesPeriod ??
    data?.chargesPeriode ??
    data?.chargesFrequency ??
    data?.chargesFreq ??
    null;

  if (typeof raw === "string") {
    const s = raw.toLowerCase();
    if (s.includes("an") || s.includes("ann")) return "ANNUEL";
    if (s.includes("mois") || s.includes("mens")) return "MENSUEL";
  }

  const c = data?.chargesEstimees;
  if (typeof c === "string") {
    const s = c.toLowerCase();
    if (s.includes("/an") || s.includes("par an") || s.includes("annuel")) return "ANNUEL";
    if (s.includes("/mois") || s.includes("par mois") || s.includes("mensuel")) return "MENSUEL";
  }

  return "INCONNU";
}

// ─────────────────────────────────────────────────────────────────────────────
// Constraint logic V2 (contextuelle : marge brute + discount sécurisé)
// ─────────────────────────────────────────────────────────────────────────────

function getDecisionConstraintV2(args: {
  smartScore: number | null | undefined;
  underMarginThreshold: boolean;
  discountSecurise: boolean;
}): { label: string; allowed: string[]; instruction: string } {
  const { smartScore, underMarginThreshold, discountSecurise } = args;

  // ── Hard rule Marchand ───────────────────────────────
  // IF margeBrute < seuil AND pas de discount sécurisé THEN verdict ≠ GO
  if (underMarginThreshold && !discountSecurise) {
    return {
      label: "MARGE_SOUS_SEUIL_SANS_DISCOUNT",
      allowed: ["NO_GO", "GO_AVEC_SECURITE"],
      instruction:
        "Marge brute sous le seuil Mimmoza ET discount non sécurisé → verdict GO/GO_AGRESSIF INTERDIT. Tu dois choisir NO_GO ou GO_AVEC_SECURITE (avec conditions de renégociation chiffrées si calculables).",
    };
  }

  // ── Fallback sur logique SmartScore ───────────────────
  if (smartScore == null || isNaN(smartScore)) {
    return {
      label: "SCORE_ABSENT",
      allowed: ["NO_GO", "GO_AVEC_SECURITE"],
      instruction:
        "SmartScore absent → tu ne peux émettre que NO_GO ou GO_AVEC_SECURITE. Réduis la confidence de 20 points.",
    };
  }
  if (smartScore < 50) {
    return {
      label: "NO_GO_ONLY",
      allowed: ["NO_GO"],
      instruction:
        "SmartScore < 50 → verdict obligatoire NO_GO. Justifie pourquoi le bien ne passe pas le filtre.",
    };
  }
  if (smartScore < 65) {
    return {
      label: "NO_GO_OR_SECURITE",
      allowed: ["NO_GO", "GO_AVEC_SECURITE"],
      instruction:
        "SmartScore 50–64 → verdict autorisé : NO_GO ou GO_AVEC_SECURITE uniquement. Argumente lequel est le plus pertinent.",
    };
  }
  if (smartScore < 75) {
    return {
      label: "GO_SECURITE_OR_GO",
      allowed: ["GO_AVEC_SECURITE", "GO"],
      instruction:
        "SmartScore 65–74 → verdict autorisé : GO_AVEC_SECURITE ou GO. Identifie les conditions nécessaires pour passer en GO.",
    };
  }
  return {
    label: "GO_OR_AGRESSIF",
    allowed: ["GO", "GO_AGRESSIF"],
    instruction:
      "SmartScore ≥ 75 → verdict autorisé : GO ou GO_AGRESSIF. Évalue si l'agressivité est justifiée par la liquidité et la marge.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Completeness (weighted)
// ─────────────────────────────────────────────────────────────────────────────

type FieldWeight = "critical" | "important" | "optional";
type WeightedField = { key: string; label: string; weight: FieldWeight; read?: (data: any) => any };

function weightValue(w: FieldWeight) {
  if (w === "critical") return 3;
  if (w === "important") return 2;
  return 1;
}

function analyzeDataCompletenessWeighted(data: any) {
  const fields: WeightedField[] = [
    { key: "__prix__", label: "Prix d'acquisition", weight: "critical", read: readPrix },
    { key: "__surface__", label: "Surface", weight: "critical", read: readSurface },
    { key: "__localisation__", label: "Localisation", weight: "critical", read: readLocalisation },

    { key: "__smartScore__", label: "SmartScore", weight: "important", read: readSmartScore },

    { key: "prixM2", label: "Prix au m²", weight: "important" },
    { key: "prixM2Median", label: "Prix m² médian secteur", weight: "important" },
    { key: "typeBien", label: "Type de bien", weight: "important" },

    { key: "etatBien", label: "État du bien", weight: "important" },
    { key: "chargesEstimees", label: "Charges estimées", weight: "important" },
    { key: "travauxEstimes", label: "Travaux estimés", weight: "important" },
    { key: "loyerEstime", label: "Loyer estimé", weight: "important" },

    { key: "__travauxMois__", label: "Durée travaux (mois)", weight: "important", read: readTravauxMois },
    { key: "__dureeDetentionMois__", label: "Durée détention (mois)", weight: "important", read: readDureeDetentionMois },
    { key: "__delaiCommercialisationMois__", label: "Délai commercialisation (mois)", weight: "important", read: readDelaiCommercialisationMois },

    { key: "__rendement__", label: "Rendement brut", weight: "optional", read: readRendementBrut },
    { key: "__var5y__", label: "Variation DVF 5 ans", weight: "optional", read: readVariation5Ans },
    { key: "__dvfVol__", label: "Volume DVF", weight: "optional", read: readDvfVolume },

    { key: "dvfRecent", label: "Transactions DVF récentes", weight: "optional" },
    { key: "tensionLocative", label: "Tension locative", weight: "optional" },
  ];

  const missingCritical: string[] = [];
  const missingImportant: string[] = [];
  const missingOptional: string[] = [];

  let totalW = 0;
  let presentW = 0;

  for (const f of fields) {
    const w = weightValue(f.weight);
    totalW += w;

    let val = f.read ? f.read(data) : data?.[f.key];
    if (f.key === "dvfRecent") {
      val = readDvfRecentTransactions(data);
    }

    if (isEmptyLoose(val)) {
      if (f.weight === "critical") missingCritical.push(f.label);
      else if (f.weight === "important") missingImportant.push(f.label);
      else missingOptional.push(f.label);
    } else {
      presentW += w;
    }
  }

  const completenessPct = Math.round((presentW / totalW) * 100);

  const note =
    completenessPct >= 85
      ? `Complétude élevée (${completenessPct}%). La confidence peut être haute si les données sont cohérentes.`
      : completenessPct >= 60
      ? `Complétude moyenne (${completenessPct}%). Réduis la confidence si des données importantes manquent.`
      : `Complétude faible (${completenessPct}%). L'analyse reste partielle.`;

  const missingAll = [...missingCritical, ...missingImportant, ...missingOptional];

  return {
    completenessPct,
    completenessNote: note,
    missingCritical,
    missingImportant,
    missingOptional,
    missingFields: missingAll,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inconsistency penalty
// ─────────────────────────────────────────────────────────────────────────────

function computeInconsistencyPenalty(data: any): { penalty: number; reasons: string[] } {
  const reasons: string[] = [];
  let p = 0;

  const prix = readPrix(data);
  const surface = readSurface(data);
  const prixM2 = asNumber(data?.prixM2);

  if (prix != null && surface != null && surface > 0 && prixM2 != null && prixM2 > 0) {
    const implied = prix / surface;
    const ratio = implied / prixM2;
    if (ratio < 0.7 || ratio > 1.3) {
      p += 12;
      reasons.push("prixM2 incohérent avec prix/surface");
    }
  }

  const loyer = asNumber(data?.loyerEstime);
  const r = readRendementBrut(data);
  if (prix != null && prix > 0 && loyer != null && loyer > 0 && r != null && r > 0) {
    const impliedRendement = ((loyer * 12) / prix) * 100;
    const ratio = impliedRendement / r;
    if (ratio < 0.7 || ratio > 1.3) {
      p += 10;
      reasons.push("rendementBrut incohérent avec loyer/prix");
    }
  }

  if (surface != null && (surface < 8 || surface > 1000)) {
    p += 8;
    reasons.push("surface atypique/aberrante");
  }
  if (prix != null && prix <= 0) {
    p += 12;
    reasons.push("prix <= 0");
  }

  return { penalty: Math.min(30, p), reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence v2
// ─────────────────────────────────────────────────────────────────────────────

function computeFinalConfidenceV2(args: { llmConfidence: number; data: any }) {
  const { llmConfidence, data } = args;

  const comp = analyzeDataCompletenessWeighted(data);
  const inc = computeInconsistencyPenalty(data);

  const crit = comp.missingCritical.length;
  const imp = comp.missingImportant.length;

  let c = 0.5 * llmConfidence + 0.5 * comp.completenessPct;

  c -= Math.sqrt(crit) * 12;
  c -= Math.sqrt(imp) * 6;

  c -= inc.penalty;

  if (crit >= 1) c = Math.min(c, 62);
  if (crit >= 2) c = Math.min(c, 52);
  if (crit >= 3) c = Math.min(c, 42);

  const missingImpSet = new Set(comp.missingImportant);
  const missHold = missingImpSet.has("Durée détention (mois)");
  const missWorks = missingImpSet.has("Durée travaux (mois)");
  const missMkt = missingImpSet.has("Délai commercialisation (mois)");

  if (missHold) c = Math.min(c, 78);
  if ((missWorks && missMkt) || (missHold && (missWorks || missMkt))) c = Math.min(c, 72);

  if (comp.completenessPct < 40) c = Math.min(c, 55);

  c = clamp(c, 12, 92);

  return {
    finalConfidence: Math.round(c),
    completenessPct: comp.completenessPct,
    missingCritical: comp.missingCritical,
    missingImportant: comp.missingImportant,
    missingOptional: comp.missingOptional,
    inconsistencyReasons: inc.reasons,
    completenessNote: comp.completenessNote,
    missingFields: comp.missingFields,
  };
}

function confidenceLevel(c: number) {
  if (c >= 70) return "FIABLE";
  if (c >= 45) return "MOYEN";
  if (c >= 25) return "FAIBLE";
  return "TRES_FAIBLE";
}

// ─────────────────────────────────────────────────────────────────────────────
// Predictive engine
// ─────────────────────────────────────────────────────────────────────────────

function computeMarketMomentum(variation5yPct: number | null, dvfVolume: number | null) {
  const v = variation5yPct ?? 0;
  const vol = dvfVolume ?? 0;
  if (v > 12 && vol >= 120) return "HAUSSIER_FORT";
  if (v > 6) return "HAUSSIER_MODERE";
  if (v < -6) return "BAISSIER";
  return "NEUTRE";
}

function computeResaleProbabilityPct(smartScore: number | null, tension: number | null) {
  const s = smartScore ?? 60;
  const t = tension ?? 55;
  const p = Math.round(s * 0.6 + t * 0.4);
  return Math.max(5, Math.min(95, p));
}

function computeRiskPressureIndex(missingCount: number, smartScore: number | null, rendementBrut: number | null) {
  let idx = 0;
  idx += Math.min(40, missingCount * 6);
  if ((smartScore ?? 60) < 60) idx += 20;
  if ((rendementBrut ?? 0) > 0 && (rendementBrut ?? 0) < SEUILS_MARCHAND.rendementBrutMinimal) idx += 15;
  return Math.max(0, Math.min(100, idx));
}

function computeDiscountPct(prixM2: number | null, prixM2Median: number | null): number | null {
  if (prixM2 == null || prixM2Median == null || prixM2Median <= 0) return null;
  return ((prixM2Median - prixM2) / prixM2Median) * 100;
}

function scoreDiscount(discountPct: number | null): number | null {
  if (discountPct == null) return null;
  const s = 50 + (discountPct / 15) * 50;
  return clamp(Math.round(s), 0, 100);
}

function scoreYield(rendementBrut: number | null): number | null {
  if (rendementBrut == null || rendementBrut <= 0) return null;
  const s = 10 + (rendementBrut - 2) * 18;
  return clamp(Math.round(s), 0, 100);
}

function scoreMomentum(momentum: string): number {
  if (momentum === "HAUSSIER_FORT") return 85;
  if (momentum === "HAUSSIER_MODERE") return 70;
  if (momentum === "BAISSIER") return 35;
  return 55;
}

function scoreLiquidity(resaleProb: number): number {
  return clamp(Math.round(resaleProb), 0, 100);
}

function scoreValueAdd(travaux: number | null, prix: number | null, etatBien: any): number | null {
  if (travaux == null || prix == null || prix <= 0) return null;

  const ratioPct = (travaux / prix) * 100;

  let base = 55;
  if (ratioPct >= 3 && ratioPct <= 12) base = 80;
  else if (ratioPct > 12 && ratioPct <= 20) base = 65;
  else if (ratioPct > 20) base = 45;

  if (typeof etatBien === "string") {
    const s = etatBien.toLowerCase();
    if (s.includes("bon") || s.includes("neuf")) base += 3;
    if (s.includes("rafraîchir") || s.includes("rafraichir")) base += 6;
    if (s.includes("gros") || s.includes("renover") || s.includes("rénover")) base += 8;
  }

  return clamp(Math.round(base), 0, 100);
}

function computeOpportunityScoreAdvanced(args: {
  smartScore: number | null;
  rendementBrut: number | null;
  momentum: string;
  resaleProbabilityPct: number;
  riskPressureIndex: number;
  confidence: number;
  prixM2: number | null;
  prixM2Median: number | null;
  prix: number | null;
  travaux: number | null;
  etatBien: any;
}) {
  const {
    smartScore,
    rendementBrut,
    momentum,
    resaleProbabilityPct,
    riskPressureIndex,
    confidence,
    prixM2,
    prixM2Median,
    prix,
    travaux,
    etatBien,
  } = args;

  const sSmart = clamp(Math.round(smartScore ?? 60), 0, 100);
  const sMom = scoreMomentum(momentum);
  const sLiq = scoreLiquidity(resaleProbabilityPct);
  const discPct = computeDiscountPct(prixM2, prixM2Median);
  const sDisc = scoreDiscount(discPct);
  const sYield = scoreYield(rendementBrut);
  const sVA = scoreValueAdd(travaux, prix, etatBien);

  const parts: Array<{ v: number; w: number }> = [
    { v: sSmart, w: 0.25 },
    { v: sMom, w: 0.15 },
    { v: sLiq, w: 0.15 },
  ];
  if (sDisc != null) parts.push({ v: sDisc, w: 0.25 });
  if (sYield != null) parts.push({ v: sYield, w: 0.15 });
  if (sVA != null) parts.push({ v: sVA, w: 0.05 });

  const wSum = parts.reduce((a, x) => a + x.w, 0);
  const base = parts.reduce((a, x) => a + x.v * (x.w / wSum), 0);

  const riskPenalty = riskPressureIndex * 0.22;
  const uncertaintyPenalty = (100 - clamp(confidence, 0, 100)) * 0.18;

  const final = clamp(Math.round(base - riskPenalty - uncertaintyPenalty), 0, 100);

  const breakdown: Record<string, number | null> = {
    smart: sSmart,
    momentum: sMom,
    liquidite: sLiq,
    discount: sDisc,
    yield: sYield,
    valueAdd: sVA,
    riskPenalty: Math.round(riskPenalty),
    uncertaintyPenalty: Math.round(uncertaintyPenalty),
  };

  return {
    score: final,
    discountPct: discPct == null ? null : Math.round(discPct * 10) / 10,
    breakdown,
  };
}

function computeDiscountTargetPct(args: { discountPct: number | null; rendementBrut: number | null }) {
  const { discountPct, rendementBrut } = args;

  if (discountPct == null) {
    return {
      discountTargetPct: null as number | null,
      extraDiscountNeededPct: null as number | null,
    };
  }
  if (rendementBrut == null || rendementBrut <= 0) {
    return { discountTargetPct: null, extraDiscountNeededPct: null };
  }

  const deltaYield = SEUILS_MARCHAND.rendementBrutMinimal - rendementBrut;
  const extra = deltaYield > 0 ? clamp(deltaYield * 3, 0, 12) : 0;
  const target = clamp(discountPct + extra, -10, 20);

  return {
    discountTargetPct: Math.round(target * 10) / 10,
    extraDiscountNeededPct: Math.round(extra * 10) / 10,
  };
}

function computeTargetAcquisitionPrice(prix: number | null, extraDiscountNeededPct: number | null) {
  if (prix == null || prix <= 0) return null;
  if (extraDiscountNeededPct == null) return null;
  if (extraDiscountNeededPct <= 0) return prix;
  return Math.round(prix * (1 - extraDiscountNeededPct / 100));
}

// ─────────────────────────────────────────────────────────────────────────────
// Calibration
// ─────────────────────────────────────────────────────────────────────────────

type CalibrationEstimate = { p50?: number; p90?: number; rationale?: string[] };
type CalibrationDelta = {
  target: "resaleProbabilityPct" | "riskPressureIndex" | "opportunityScore";
  delta: number;
  reason?: string;
  evidence?: string[];
};
type CalibrationLLM = {
  estimates?: {
    worksMonths?: CalibrationEstimate;
    holdingMonths?: CalibrationEstimate;
    marketingMonths?: CalibrationEstimate;
  };
  deltas?: CalibrationDelta[];
  confidenceAdjustment?: { delta?: number; reason?: string };
  warnings?: string[];
};

function sanitizeEstimate(n: any, lim: { min: number; max: number }): number | null {
  const v = asNumber(n);
  if (v == null) return null;
  return clamp(Math.round(v), lim.min, lim.max);
}

function computeDeltaBudget(missingCriticalCount: number) {
  return missingCriticalCount >= 1
    ? CALIBRATION_LIMITS.maxAbsDeltaSumIfMissingCritical
    : CALIBRATION_LIMITS.maxAbsDeltaSumDefault;
}

function sanitizeDeltas(deltas: any, deltaBudget: number): CalibrationDelta[] {
  if (!Array.isArray(deltas)) return [];

  const out: CalibrationDelta[] = [];
  let absSum = 0;

  for (const d of deltas) {
    const target = d?.target;
    if (
      target !== "resaleProbabilityPct" &&
      target !== "riskPressureIndex" &&
      target !== "opportunityScore"
    )
      continue;

    const delta0 = asNumber(d?.delta);
    if (delta0 == null) continue;

    const delta = clamp(Math.round(delta0), -6, +6);
    const nextAbsSum = absSum + Math.abs(delta);
    if (nextAbsSum > deltaBudget) continue;

    absSum = nextAbsSum;

    out.push({
      target,
      delta,
      reason: typeof d?.reason === "string" ? d.reason.slice(0, 240) : undefined,
      evidence: Array.isArray(d?.evidence) ? d.evidence.slice(0, 6).map(String) : undefined,
    });
  }

  return out;
}

function applyCalibrationToBody(body: any, calibration: CalibrationLLM | null) {
  const usedEstimates: any = {};
  const usedDeltas: CalibrationDelta[] = [];

  if (!calibration || typeof calibration !== "object") {
    return { bodyAugmented: body, usedEstimates, usedDeltas };
  }

  const bodyAugmented: any = { ...body };
  const est = calibration.estimates ?? {};

  const worksExisting = readTravauxMois(body);
  const holdExisting = readDureeDetentionMois(body);
  const mktExisting = readDelaiCommercialisationMois(body);

  if ((worksExisting ?? 0) <= 0 && est?.worksMonths) {
    const p50 = sanitizeEstimate(est.worksMonths.p50, CALIBRATION_LIMITS.worksMonths);
    const p90 = sanitizeEstimate(est.worksMonths.p90, CALIBRATION_LIMITS.worksMonths);
    if (p50 != null) {
      bodyAugmented.travauxMois = p50;
      usedEstimates.worksMonths = { p50, p90, rationale: est.worksMonths.rationale ?? [] };
    }
  }

  if ((holdExisting ?? 0) <= 0 && est?.holdingMonths) {
    const p50 = sanitizeEstimate(est.holdingMonths.p50, CALIBRATION_LIMITS.holdingMonths);
    const p90 = sanitizeEstimate(est.holdingMonths.p90, CALIBRATION_LIMITS.holdingMonths);
    if (p50 != null) {
      bodyAugmented.dureeDetentionMois = p50;
      usedEstimates.holdingMonths = { p50, p90, rationale: est.holdingMonths.rationale ?? [] };
    }
  }

  if ((mktExisting ?? 0) <= 0 && est?.marketingMonths) {
    const p50 = sanitizeEstimate(est.marketingMonths.p50, CALIBRATION_LIMITS.marketingMonths);
    const p90 = sanitizeEstimate(est.marketingMonths.p90, CALIBRATION_LIMITS.marketingMonths);
    if (p50 != null) {
      bodyAugmented.delaiCommercialisationMois = p50;
      usedEstimates.marketingMonths = { p50, p90, rationale: est.marketingMonths.rationale ?? [] };
    }
  }

  const comp0 = analyzeDataCompletenessWeighted(body);
  const deltaBudget = computeDeltaBudget(comp0.missingCritical.length);
  const deltasSan = sanitizeDeltas(calibration.deltas, deltaBudget);
  usedDeltas.push(...deltasSan);

  return { bodyAugmented, usedEstimates, usedDeltas };
}

function applyConfidenceAdjustment(llmConfidence: number, calibration: CalibrationLLM | null, usedEstimates: any) {
  if (!calibration?.confidenceAdjustment) {
    return { llmConfidenceAdjusted: llmConfidence, deltaApplied: 0, reason: undefined as string | undefined };
  }

  let delta = asNumber(calibration.confidenceAdjustment.delta) ?? 0;

  const usedAnyEstimate = Object.keys(usedEstimates || {}).length > 0;
  if (usedAnyEstimate && delta > 0) delta = 0;

  delta = clamp(Math.round(delta), CALIBRATION_LIMITS.confidenceAdjMin, CALIBRATION_LIMITS.confidenceAdjMax);

  const adjusted = clamp(llmConfidence + delta, 0, 100);

  return {
    llmConfidenceAdjusted: adjusted,
    deltaApplied: delta,
    reason: typeof calibration.confidenceAdjustment.reason === "string"
      ? calibration.confidenceAdjustment.reason.slice(0, 240)
      : undefined,
  };
}

function applyDeltas(
  base: { resaleProbabilityPct: number; riskPressureIndex: number; opportunityScore: number },
  deltas: CalibrationDelta[],
) {
  const out = { ...base };
  const applied: CalibrationDelta[] = [];

  for (const d of deltas) {
    if (d.target === "resaleProbabilityPct") {
      out.resaleProbabilityPct = clamp(out.resaleProbabilityPct + d.delta, 5, 95);
      applied.push(d);
    } else if (d.target === "riskPressureIndex") {
      out.riskPressureIndex = clamp(out.riskPressureIndex + d.delta, 0, 100);
      applied.push(d);
    } else if (d.target === "opportunityScore") {
      out.opportunityScore = clamp(out.opportunityScore + d.delta, 0, 100);
      applied.push(d);
    }
  }

  return { adjusted: out, applied };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder (v1.7 — uses getDecisionConstraintV2)
// ─────────────────────────────────────────────────────────────────────────────

function buildPrompt(data: any) {
  const smartScore = readSmartScore(data);

  const comp = analyzeDataCompletenessWeighted(data);

  const rendementBrut = readRendementBrut(data);
  const var5y = readVariation5Ans(data);
  const dvfVol = readDvfVolume(data);
  const tension = readTensionLocative(data);

  const marketMomentum = computeMarketMomentum(var5y, dvfVol);
  const resaleProbabilityPct = computeResaleProbabilityPct(smartScore, tension);
  const riskPressureIndex = computeRiskPressureIndex(comp.missingFields.length, smartScore, rendementBrut);

  const prix = readPrix(data);
  const travaux = asNumber(data?.travauxEstimes);
  const prixM2 = asNumber(data?.prixM2);
  const prixM2Median = asNumber(data?.prixM2Median);

  const proxyConfidence = clamp(comp.completenessPct, 12, 92);

  const opp = computeOpportunityScoreAdvanced({
    smartScore,
    rendementBrut,
    momentum: marketMomentum,
    resaleProbabilityPct,
    riskPressureIndex,
    confidence: proxyConfidence,
    prixM2,
    prixM2Median,
    prix,
    travaux,
    etatBien: data?.etatBien,
  });

  const target = computeDiscountTargetPct({ discountPct: opp.discountPct, rendementBrut });
  const prixAchatCible = computeTargetAcquisitionPrice(prix, target.extraDiscountNeededPct);

  // ── Calcul underMarginThreshold + discountSecurise ──
  const margeBrutePct = readMargeBrutePct(data);
  const underMarginThreshold =
    margeBrutePct != null && margeBrutePct > 0 && margeBrutePct < SEUILS_MARCHAND.margeBruteCible;

  const discountSecurise =
    prix != null &&
    prixAchatCible != null &&
    prixAchatCible > 0 &&
    prix <= prixAchatCible;

  const constraint = getDecisionConstraintV2({
    smartScore,
    underMarginThreshold,
    discountSecurise,
  });

  const chargesUnit = inferChargesUnit(data);

  const dvfRecent = readDvfRecentTransactions(data);
  const dvfAna = computeDvfRecentAnalysis({ dvf: dvfRecent, prixM2Deal: asNumber(data?.prixM2) ?? null });

  // ── Placeholder values ──
  const allowedVerdicts = constraint.allowed.join(" | ");
  const smartScoreStr = smartScore != null ? String(smartScore) : "ABSENT";
  const discountStr = opp.discountPct == null ? "DONNÉE ABSENTE" : `${opp.discountPct}%`;
  const discountTargetStr = target.discountTargetPct == null ? "DONNÉE ABSENTE" : `${target.discountTargetPct}%`;
  const extraDiscountStr = target.extraDiscountNeededPct == null ? "DONNÉE ABSENTE" : `${target.extraDiscountNeededPct}%`;
  const targetPriceStr = prixAchatCible == null ? "NON CALCULABLE" : `${prixAchatCible}€`;
  const dvfCanonStr = dvfAna ? JSON.stringify(dvfAna, null, 2) : "DONNÉE ABSENTE";
  const missingCriticalStr = comp.missingCritical.length ? comp.missingCritical.join(", ") : "Aucune";
  const missingImportantStr = comp.missingImportant.length ? comp.missingImportant.join(", ") : "Aucune";
  const missingOptionalStr = comp.missingOptional.length ? comp.missingOptional.join(", ") : "Aucune";

  return `Tu es un marchand de biens senior et stratégique.
Ta mission : produire une synthèse décisionnelle PREMIUM (style mémo comité marchand), claire, tranchante, actionnable.

═══════════════════════════════════════════
RÈGLES ABSOLUES (VIOLATION = RÉPONSE INVALIDE)
═══════════════════════════════════════════

1) NE JAMAIS INVENTER DE DONNÉES
- Si une donnée est absente : écrire exactement "DONNÉE ABSENTE" (ou "NON CALCULABLE" si on parle d'un calcul) + expliquer l'impact.
- Interdit d'inventer : prix/m² marché, travaux, portage, baisse marché, loyers, rendements.
- Interdit d'écrire des fourchettes chiffrées non sourcées (ex: "-15k à -30k").

2) INTERDICTIONS DE LOGIQUE
- Marge brute ≠ rendement.
- Sans prix de revente : marge brute = NON CALCULABLE.
- Si rendement brut < ${SEUILS_MARCHAND.rendementBrutMinimal}% : il faut écrire "SOUS-SEUIL" explicitement.
- Durées absentes (travaux/détention/commercialisation) : dans la narrative, elles sont NON CALCULABLE.
  ✅ Les estimations p50/p90 ne doivent apparaître QUE dans le JSON Meta (calibration.estimates).
- CHARGES / CASHFLOW :
  chargesUnit détectée = ${chargesUnit}.
  Si chargesUnit = INCONNU : interdiction de calculer un cashflow mensuel ou de faire une soustraction (loyer - charges). Tu peux seulement demander l'unité et expliquer l'impact.

3) RÈGLE DES INDICATEURS (CANONIQUES)
Si tu cites un chiffre pour :
- SmartScore
- OpportunityScore
- RiskPressureIndex
- Probabilité de revente fluide
- Discount / Discount cible / Discount additionnel
- Prix d'achat cible
Alors tu dois utiliser EXACTEMENT les valeurs fournies dans "INDICATEURS PRÉDICTIFS" ci-dessous.
Interdit d'écrire d'autres chiffres pour ces indicateurs. Sinon, reste qualitatif ("faible / moyen / élevé") sans chiffre.

4) DVF
Si tu cites un chiffre DVF (médiane, p25/p75, nb ventes, dispersion, positionnement), tu dois utiliser UNIQUEMENT la "SYNTHÈSE_DVF_CANON".
Si SYNTHÈSE_DVF_CANON = DONNÉE ABSENTE : tu n'inventes rien, tu restes qualitatif.

- RÈGLE DE PRIORITÉ PRIX/M² :
  Si SYNTHÈSE_DVF_CANON est présente ET medianPrixM2 non null :
    → la "médiane de référence" pour comparer le prix/m² du bien est la MÉDIANE DVF.
    → Tu dois écrire "médiane DVF" explicitement (pas "médiane secteur" générique).
  Sinon (DVF absente) :
    → tu peux utiliser prixM2Median (si présent) et écrire "médiane (source: prixM2Median)".
  Si prixM2Median (autre source) et médiane DVF coexistent avec des valeurs différentes,
  mentionner en une seule phrase :
  "Note: médiane DVF = X€/m², médiane externe = Y€/m² (sources différentes)" sans conclure.

5) CONTRAINTE DE DÉCISION (SmartScore = ${smartScoreStr})
Catégorie : ${constraint.label}
Verdicts autorisés : ${allowedVerdicts}
→ ${constraint.instruction}
⚠️ Tout verdict hors de cette liste est INTERDIT.

═══════════════════════════════════════════
RÈGLE PRIX MAX D'ENGAGEMENT (OBLIGATOIRE)
═══════════════════════════════════════════

- Si un prix de revente (ou prixReventeCible) est présent,
  tu as le droit de calculer un "prix maximum d'engagement"
  UNIQUEMENT via un calcul arithmétique interne
  permettant d'atteindre la marge brute cible (${SEUILS_MARCHAND.margeBruteCible}%).

- Ce calcul ne doit utiliser AUCUNE donnée marché externe (pas de DVF).

- Si prix de revente absent :
  "Prix maximum d'engagement : NON CALCULABLE".

- Si Prix d'achat cible = NON CALCULABLE :
  il est INTERDIT d'écrire un chiffre approximatif ("~540k", "15–20k", etc.).
  Seule mention autorisée : "NON CALCULABLE".

═══════════════════════════════════════════
RÈGLE DES HYPOTHÈSES PRUDENTES
═══════════════════════════════════════════

- Si un champ descriptif est absent (typeBien, etatBien),
  tu peux formuler une HYPOTHÈSE PRUDENTE.

- Toute hypothèse doit être explicitement taggée :
  "HYPOTHÈSE (à confirmer)".

- Interdiction d'utiliser une hypothèse pour produire un chiffre.

═══════════════════════════════════════════
RÈGLE ANTI-EXTRAPOLATION (RENFORCÉE)
═══════════════════════════════════════════

- Interdiction totale d'inventer des montants ou fourchettes chiffrées.
- Pas de "-15 000€ à -30 000€".
- Pas d'estimation chiffrée de baisse marché.
- Pas de coût de portage estimé en euros sans donnée source.
- Si donnée absente : analyse qualitative uniquement.

Toute violation rend la réponse invalide.

═══════════════════════════════════════════
SEUILS MARCHAND (comparaison obligatoire)
═══════════════════════════════════════════
- Marge brute cible : ≥ ${SEUILS_MARCHAND.margeBruteCible}%
- Rendement brut minimal : ≥ ${SEUILS_MARCHAND.rendementBrutMinimal}%
- Durée cible de détention : ≤ ${SEUILS_MARCHAND.dureeCibleDetentionMois} mois

═══════════════════════════════════════════
INDICATEURS PRÉDICTIFS (CANONIQUES — NE PAS RECALCULER)
═══════════════════════════════════════════
- SmartScore: ${smartScoreStr}
- MarketMomentum: ${marketMomentum}
- Probabilité de revente fluide: ${resaleProbabilityPct}%
- RiskPressureIndex: ${riskPressureIndex}/100
- OpportunityScore (indicatif / recalcul serveur): ${opp.score}/100
- Discount vs médiane: ${discountStr}
- Discount cible (si rendement sous-seuil): ${discountTargetStr}
- Discount additionnel requis: ${extraDiscountStr}
- Prix d'achat cible (si calculable): ${targetPriceStr}

═══════════════════════════════════════════
PONDÉRATION DE CONFIDENCE
═══════════════════════════════════════════
Complétude (pondérée): ${comp.completenessPct}%
${comp.completenessNote}
${comp.missingFields.length > 0 ? `Données manquantes détectées : ${comp.missingFields.join(", ")}` : "Toutes les données critiques sont présentes."}

═══════════════════════════════════════════
SYNTHÈSE_DVF_CANON (si présente)
═══════════════════════════════════════════
${dvfCanonStr}

═══════════════════════════════════════════
DONNÉES MANQUANTES (SOURCE DE VÉRITÉ SERVEUR)
═══════════════════════════════════════════
- CRITICAL: ${missingCriticalStr}
- IMPORTANT: ${missingImportantStr}
- OPTIONAL: ${missingOptionalStr}

═══════════════════════════════════════════
DONNÉES DU BIEN (JSON)
═══════════════════════════════════════════
${JSON.stringify(data, null, 2)}

═══════════════════════════════════════════
STRUCTURE DE RÉPONSE OBLIGATOIRE (MARKDOWN)
═══════════════════════════════════════════

## Verdict express
Synthèse stratégique en 5–8 lignes (analytique, tranchante, pas descriptive) :
- lecture risque/rendement
- SmartScore + OpportunityScore (interprétation)
- Momentum marché (qualitatif)
- qualité des données (impact sur décision)
- si c'est "worth your time" ou non pour un marchand

## Analyse financière & création de valeur

### Positionnement prix
- Prix d'acquisition, prix/m² (si calculable)
- Comparaison médiane DVF (si dispo)
- Discount réel ou surcote (si calculable)
- impact direct sur capacité à créer de la marge

### Structure de marge
- Marge brute vs seuil (${SEUILS_MARCHAND.margeBruteCible}%) : CONFORME / SOUS-SEUIL / NON CALCULABLE
- Cushion (buffer) : présent / faible / absent
- Sensibilité aux aléas : prix / travaux / délai (qualitatif si données manquantes)
- impact d'un retard / surcoût travaux sur la robustesse de la marge (sans inventer de montants)

### Lecture d'asymétrie
Analyser systématiquement :
- Upside maximum théorique (marge brute actuelle si calculable)
- Downside plausible (dérive travaux/délai/pression marché) — QUALITATIF si données absentes
- Robustesse de la marge face aux aléas
- Arbitrage capital : attractivité relative vs autres opportunités
Conclure par :
- Opportunité relative vs autres deals potentiels
- Coût d'opportunité du capital immobilisé

Ne pas multiplier les "NON CALCULABLE" : quand une donnée est absente, produire une lecture qualitative stratégique.

### Lecture marché
- DVF : nb ventes, médiane DVF, dispersion, liquidité (si dispo)
- sinon : lecture qualitative (prudence, absence de benchmark)
- typologie acheteur cible (cohérente avec type de bien si connu, sinon indiquer l'incertitude)

## Capital at Risk

Analyse qualitative de l'exposition du capital :

- Niveau réel de protection du capital (buffer ou absence de buffer)
- Robustesse face aux imprévus opérationnels
- Sensibilité à la durée de détention
- Effet d'un ralentissement de marché sur une marge fragile
- Solidité globale de la structure financière

Aucun montant inventé.
Raisonner en logique de solidité économique.

## Risques majeurs & angles morts
- Données manquantes CRITICAL + impact
- Données manquantes IMPORTANT + impact
- risques techniques / juridiques / marché (qualitatif)
- effets domino (travaux → délais → portage → marge)
Toujours expliquer l'impact économique.

## Liquidité & sortie
- Probabilité de revente fluide : ${resaleProbabilityPct}%
- vitesse vs ${SEUILS_MARCHAND.dureeCibleDetentionMois} mois : CONFORME / SOUS-SEUIL / NON CALCULABLE (si durée absente)
- scénario de sortie principal + positionnement pricing (agressif / neutre / premium)

## Stratégie opérationnelle recommandée
- Négociation : cible chiffrée SI ET SEULEMENT SI calculable via prix d'achat cible / discount requis, sinon NON CALCULABLE + quoi demander
- conditions suspensives (liste courte, concrète)
- travaux : ROI NON CALCULABLE si manque données ; sinon lecture qualitative
- priorités 30 / 60 jours (très actionnable)

## Plan B
- location temporaire (si loyer/charges connus, sinon NON CALCULABLE + impact)
- revente en l'état
- arbitrage alternatif

## Lecture stratégique & cycle immobilier (12–24 mois)
Qualitatif, aucune projection chiffrée :
- dynamique secteur (hausse/stagnation/incertitude)
- sensibilité taux
- résilience premium
- compression/expansion des marges
- positionnement du bien dans le cycle
### Lecture cycle
- Marché local :
- Taux :
- Risque macro :
- Niveau d'opportunité : Défensif / Neutre / Opportuniste
Si données marché absentes : indiquer clairement l'incertitude.

## Décision finale

Verdict : [un seul parmi ${allowedVerdicts}]

Justification ferme (max 5 lignes) intégrant :

- Prix maximum d'engagement (calculé si prix de revente présent, sinon NON CALCULABLE)
- Seuil déclencheur (ex : obtention devis travaux, benchmark DVF)
- Lecture finale d'asymétrie (qualitative)
- Arbitrage capital (opportunité relative vs autres deals)

## Conformité seuils Mimmoza
| Métrique | Valeur | Seuil | Statut |
|----------|--------|-------|--------|
| Marge brute | ... | ≥${SEUILS_MARCHAND.margeBruteCible}% | CONFORME/SOUS-SEUIL/NON CALCULABLE |
| Rendement brut | ... | ≥${SEUILS_MARCHAND.rendementBrutMinimal}% | CONFORME/SOUS-SEUIL/NON CALCULABLE |
| Durée détention | ... | ≤${SEUILS_MARCHAND.dureeCibleDetentionMois} mois | CONFORME/SOUS-SEUIL/NON CALCULABLE |

## Meta
À la toute fin, retourne un JSON SUR UNE SEULE LIGNE (et RIEN d'autre sur cette ligne) :
{"verdict":"GO|GO_AGRESSIF|GO_AVEC_SECURITE|NO_GO","confidence":0,"constraintLabel":"${constraint.label}","seuilsConformite":{"margeBrute":"...","rendementBrut":"...","dureeDetention":"..."},"calibration":{"estimates":{"worksMonths":{"p50":null,"p90":null,"rationale":[]},"holdingMonths":{"p50":null,"p90":null,"rationale":[]},"marketingMonths":{"p50":null,"p90":null,"rationale":[]}},"deltas":[],"confidenceAdjustment":{"delta":0,"reason":""},"warnings":[]}}`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractMeta(text: string) {
  const lines = text.trim().split("\n");
  const rawText = text.trim();
  let metaLine = "";
  let metaFound = false;

  // Legacy scan: line starting with "{" and ending with "}"
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith("{") && l.endsWith("}")) {
      metaLine = l;
      break;
    }
  }

  // Robust fallback: find the last JSON object in the entire text
  if (!metaLine) {
    const jsonMatches = rawText.match(/\{[\s\S]*\}/g);
    if (jsonMatches && jsonMatches.length) {
      metaLine = jsonMatches[jsonMatches.length - 1].trim();
    }
  }

  if (metaLine) metaFound = true;

  let verdict = "INCONNU";
  let confidence = 50;
  let constraintLabel = "";
  let seuilsConformite: Record<string, string> | null = null;
  let calibration: CalibrationLLM | null = null;

  if (metaLine) {
    try {
      const parsed = JSON.parse(metaLine);
      if (parsed.verdict) verdict = parsed.verdict;
      if (typeof parsed.confidence === "number") confidence = clamp(parsed.confidence, 0, 100);
      if (parsed.constraintLabel) constraintLabel = parsed.constraintLabel;
      if (parsed.seuilsConformite) seuilsConformite = parsed.seuilsConformite;
      if (parsed.calibration) calibration = parsed.calibration;
    } catch {
      // ignore
    }
  }

  // Remove metaLine from narrative (last occurrence)
  let cleaned0: string;
  if (metaLine) {
    const idx = rawText.lastIndexOf(metaLine);
    cleaned0 = idx >= 0 ? (rawText.slice(0, idx) + rawText.slice(idx + metaLine.length)).trim() : rawText;
  } else {
    cleaned0 = rawText;
  }
  const cleaned = cleaned0.replace(/\n## Meta\s*$/m, "").trim();

  return { cleaned, verdict, confidence, constraintLabel, seuilsConformite, calibration, metaFound };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict validation V2 (aligned with getDecisionConstraintV2)
// ─────────────────────────────────────────────────────────────────────────────

function validateVerdictV2(args: {
  verdict: string;
  smartScore: number | null | undefined;
  underMarginThreshold: boolean;
  discountSecurise: boolean;
}) {
  const constraint = getDecisionConstraintV2({
    smartScore: args.smartScore,
    underMarginThreshold: args.underMarginThreshold,
    discountSecurise: args.discountSecurise,
  });

  const normalizedVerdict = String(args.verdict || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");

  if (constraint.allowed.includes(normalizedVerdict)) {
    return { valid: true, corrected: normalizedVerdict, warning: null as string | null, constraint };
  }

  const fallback =
    constraint.label === "MARGE_SOUS_SEUIL_SANS_DISCOUNT"
      ? "GO_AVEC_SECURITE"
      : constraint.allowed[0];
  return {
    valid: false,
    corrected: fallback,
    warning: `Verdict "${args.verdict}" hors contrainte ${constraint.label}. Corrigé en "${fallback}".`,
    constraint,
  };
}

function computeSeuilsConformiteServer(data: any): { margeBrute: string; rendementBrut: string; dureeDetention: string } {
  const prixRevente =
    asNumber(data?.prixRevente) ??
    asNumber(data?.resalePrice) ??
    asNumber(data?.deal?.prixRevente) ??
    null;
  const margeBrute = (prixRevente != null && prixRevente > 0) ? "CALCULABLE" : "NON CALCULABLE";

  const r = readRendementBrut(data);
  let rendementBrut: string;
  if (r == null || r <= 0) {
    rendementBrut = "NON CALCULABLE";
  } else if (r < SEUILS_MARCHAND.rendementBrutMinimal) {
    rendementBrut = "SOUS-SEUIL";
  } else {
    rendementBrut = "CONFORME";
  }

  const h = readDureeDetentionMois(data);
  let dureeDetention: string;
  if (h == null || h <= 0) {
    dureeDetention = "NON CALCULABLE";
  } else if (h > SEUILS_MARCHAND.dureeCibleDetentionMois) {
    dureeDetention = "SOUS-SEUIL";
  } else {
    dureeDetention = "CONFORME";
  }

  return { margeBrute, rendementBrut, dureeDetention };
}

// ─────────────────────────────────────────────────────────────────────────────
// Narrative addendum & normalization (server-side coherence)
// ─────────────────────────────────────────────────────────────────────────────

function addCalibrationAddendum(narrative: string, usedEstimates: any, predictifFinal?: any) {
  const keys = Object.keys(usedEstimates || {});
  if (keys.length === 0) return narrative;

  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("### Note (calibration IA appliquée)");
  lines.push(
    `Des estimations IA ont été utilisées pour compléter certaines durées : ${keys
      .map((k) => {
        if (k === "worksMonths") return "Durée travaux";
        if (k === "holdingMonths") return "Durée détention";
        if (k === "marketingMonths") return "Délai commercialisation";
        return k;
      })
      .join(", ")}.`,
  );
  lines.push("Ces estimations ont permis de recalculer les indices (risque/opportunité) côté serveur.");
  if (predictifFinal?.opportunityScore != null) {
    lines.push(`OpportunityScore final recalculé : ${predictifFinal.opportunityScore}/100.`);
  }
  lines.push("---");

  return (narrative || "").trim() + "\n" + lines.join("\n");
}

function applyEstimateConfidenceCap(confidence: number, usedEstimates: any) {
  const n = Object.keys(usedEstimates || {}).length;
  if (n <= 0) return confidence;

  if (n === 1) return Math.min(confidence, CALIBRATION_LIMITS.confidenceCapIf1Estimate);
  if (n === 2) return Math.min(confidence, CALIBRATION_LIMITS.confidenceCapIf2Estimates);
  return Math.min(confidence, CALIBRATION_LIMITS.confidenceCapIf3PlusEstimates);
}

function normalizeNarrativeAfterCalibration(narrative: string, usedEstimates: any) {
  const keys = Object.keys(usedEstimates || {});
  if (keys.length === 0) return narrative;

  const hasWorks = !!usedEstimates?.worksMonths;
  const hasHold = !!usedEstimates?.holdingMonths;
  const hasMkt = !!usedEstimates?.marketingMonths;

  const labels: string[] = [];
  if (hasWorks) labels.push("Durée travaux");
  if (hasHold) labels.push("Durée détention");
  if (hasMkt) labels.push("Délai commercialisation");

  const patterns = [
    /-?\s*Données manquantes IMPORTANT\s*:\s*Durée travaux[^.\n]*\n?/gi,
    /-?\s*Données manquantes IMPORTANT\s*:\s*Durée travaux[^.\n]*$/gim,
    /-?\s*Données IMPORTANT manquantes\s*:\s*Durée travaux[^.\n]*\n?/gi,
  ];

  let out = narrative || "";
  for (const p of patterns) {
    out = out.replace(
      p,
      `- Durées : estimées via calibration IA (p50/p90) — ${labels.join(", ")} → incertitude résiduelle sur ROI/planning\n`,
    );
  }

  return out;
}

function normalizeTableTokens(narrative: string) {
  if (!narrative) return narrative;
  return narrative
    .replace(/DONN[ÉE]E\s+ABSENTE/gi, "NON CALCULABLE")
    .replace(/DONNEE\s+ABSENTE/gi, "NON CALCULABLE");
}

function normalizeChargesMentionsWhenUnitUnknown(narrative: string) {
  if (!narrative) return narrative;

  return narrative
    .replace(
      /(Loyer\s*[^\n]*?\b\d[\d\s\u00A0\u202F]*€)\s*(avec|-\s*)\s*(charges\s*[^\n]*?\b\d[\d\s\u00A0\u202F]*€)/gi,
      "$1. $3 (unité à préciser).",
    )
    .replace(
      /(loyer\s*[^\n]*?\b\d[\d\s\u00A0\u202F]*€)\s*(vs|versus)\s*(charges\s*[^\n]*?\b\d[\d\s\u00A0\u202F]*€)/gi,
      "$1. $3 (unité à préciser).",
    )
    .replace(/\b(loyer)\s*-\s*(charges)\b/gi, "$1 et $2");
}

function normalizeChargesSpeculationWhenUnitUnknown(narrative: string) {
  if (!narrative) return narrative;
  return narrative
    .replace(/si\s+annuell?es?[^.\n]*\.\s*/gi, "")
    .replace(/si\s+mensuell?es?[^.\n]*\.\s*/gi, "")
    .replace(/cashflow[^.\n]*\.\s*/gi, "")
    .replace(
      /(Charges[^\n]*?\b\d[\d\s\u00A0\u202F]*€[^\n]*unité\s+INCONNUE)[^\n]*/gi,
      "$1 → impact sur rentabilité non quantifiable (préciser annuel/mensuel).",
    );
}

function normalizePlanBLocationWhenChargesUnitUnknown(narrative: string) {
  if (!narrative) return narrative;
  return narrative.replace(
    /(^|\n)(-?\s*)Location temporaire\s*:[^\n]*/gim,
    (_m, lead, dash) =>
      `${lead}${dash}Location temporaire : NON CALCULABLE (charges estimées 1 500€ — unité à préciser annuel/mensuel)`,
  );
}

function normalizeDurationMentionsAfterCalibration(narrative: string, usedEstimates: any) {
  let out = narrative || "";

  out = out.replace(
    /(^|\n)(-?\s*)Vitesse\s*vs\s*18\s*mois\s*:[^\n]*/gim,
    (_m, lead, dash) =>
      `${lead}${dash}Vitesse vs 18 mois : NON CALCULABLE (durées non confirmées — estimation IA p50/p90 disponible)`,
  );

  out = out.replace(
    /(^|\n)(-?\s*)Horizon\s*:[^\n]*/gim,
    (_m, lead, dash) =>
      `${lead}${dash}Horizon : NON CALCULABLE (durées non confirmées — estimation IA p50/p90 disponible)`,
  );

  if (usedEstimates?.holdingMonths) {
    out = out.replace(
      /NON CALCULABLE\s*\(\s*durée détention absente\s*\)/gi,
      "ESTIMÉ via calibration IA (p50/p90)",
    );
    out = out.replace(
      /durée détention absente/gi,
      "durée détention estimée via calibration IA",
    );
  }

  if (usedEstimates?.worksMonths) {
    out = out.replace(
      /NON CALCULABLE\s*\(\s*durée travaux absente\s*\)/gi,
      "ESTIMÉ via calibration IA (p50/p90)",
    );
    out = out.replace(
      /durée travaux absente/gi,
      "durée travaux estimée via calibration IA",
    );
  }

  if (usedEstimates?.marketingMonths) {
    out = out.replace(
      /commercialisation\s*absente/gi,
      "commercialisation estimée via calibration IA",
    );
  }

  return out;
}

function enforceCanonicalRiskPressureInNarrative(narrative: string, canonicalRisk: number) {
  if (!narrative) return narrative;

  const re = /(RiskPressureIndex[^0-9]{0,20})(\d{1,3})(\s*\/\s*100)/gi;

  return narrative.replace(re, (_m, prefix, num, suffix) => {
    const n = Number(num);
    if (!Number.isFinite(n)) return `${prefix}${canonicalRisk}${suffix}`;
    if (n === canonicalRisk) return `${prefix}${n}${suffix}`;
    return `${prefix}${canonicalRisk}${suffix}`;
  });
}

function enforceCanonicalOpportunityScoreInNarrative(narrative: string, canonicalOpp: number) {
  if (!narrative) return narrative;

  const canon = clamp(Math.round(canonicalOpp), 0, 100);

  const reSlash = /(OpportunityScore[^0-9]{0,40})(\d{1,3})(\s*\/\s*100)/gi;
  let out = narrative.replace(reSlash, (_m, prefix, num, suffix) => {
    const n = Number(num);
    if (!Number.isFinite(n)) return `${prefix}${canon}${suffix}`;
    if (n === canon) return `${prefix}${n}${suffix}`;
    return `${prefix}${canon}${suffix}`;
  });

  const rePlain = /(OpportunityScore[^0-9]{0,40})(\d{1,3})(\b(?!\s*\/\s*100))/gi;
  out = out.replace(rePlain, (_m, prefix, num, _suffix) => {
    const n = Number(num);
    if (!Number.isFinite(n)) return `${prefix}${canon}`;
    if (n === canon) return `${prefix}${n}`;
    return `${prefix}${canon}`;
  });

  out = out.replace(
    /(OpportunityScore[^0-9]{0,40})(\d{1,3})(\b)(?!\s*\/\s*100)/gi,
    (_m, prefix, num) => `${prefix}${num}/100`,
  );

  return out;
}

function enforceConservativeSpeedLine(narrative: string) {
  if (!narrative) return narrative;
  return narrative.replace(
    /(^|\n)(-?\s*)Vitesse\s*vs\s*18\s*mois\s*:[^\n]*/gim,
    (_m, lead, dash) =>
      `${lead}${dash}Vitesse vs 18 mois : NON CALCULABLE (durées non confirmées — estimation IA p50/p90 disponible)`,
  );
}

function enforcePlanBLocationConservative(narrative: string) {
  if (!narrative) return narrative;
  return narrative.replace(
    /(^|\n)(-?\s*)Location temporaire\s*:[^\n]*/gim,
    (_m, lead, dash) =>
      `${lead}${dash}Location temporaire : NON CALCULABLE (charges estimées — unité à préciser annuel/mensuel)`,
  );
}

function normalizeCashflowWordWhenChargesUnitUnknown(narrative: string) {
  if (!narrative) return narrative;
  return narrative.replace(/cashflow/gi, "rentabilité");
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return jsonResponse({ ok: false, error: "ANTHROPIC_API_KEY manquante" }, 500);

    const body = await req.json().catch(() => null);
    if (!body) return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);

    const prompt = buildPrompt(body);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2200,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      return jsonResponse({ ok: false, status: response.status, error: raw }, response.status);
    }

    let data: any = null;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error("[Anthropic] Non-JSON response (first 800 chars):", raw?.slice?.(0, 800));
      return jsonResponse(
        { ok: false, error: "Anthropic response was not valid JSON", raw: raw?.slice?.(0, 800) },
        502,
      );
    }

    const text = Array.isArray(data?.content)
      ? data.content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n")
      : "";

    const { cleaned, verdict, confidence, constraintLabel, seuilsConformite, calibration, metaFound } =
      extractMeta(text);

    // Apply calibration (estimates + sanitized deltas)
    const { bodyAugmented, usedEstimates, usedDeltas } = applyCalibrationToBody(body, calibration);

    // Apply confidence adjustment (bounded)
    const confAdj = applyConfidenceAdjustment(confidence, calibration, usedEstimates);

    // Confidence server computed on augmented data
    const conf = computeFinalConfidenceV2({
      llmConfidence: confAdj.llmConfidenceAdjusted,
      data: bodyAugmented,
    });

    // Confidence cap if estimates used (anti-survente)
    const finalConfidence = applyEstimateConfidenceCap(conf.finalConfidence, usedEstimates);

    const confidenceNextSteps = [
      ...conf.missingCritical.slice(0, 3),
      ...conf.missingImportant.slice(0, Math.max(0, 3 - conf.missingCritical.length)),
    ].slice(0, 3);

    // Recompute predictive on augmented data
    const smartScore = readSmartScore(bodyAugmented);
    const rendementBrut = readRendementBrut(bodyAugmented);
    const var5y = readVariation5Ans(bodyAugmented);
    const dvfVol = readDvfVolume(bodyAugmented);
    const tension = readTensionLocative(bodyAugmented);

    const marketMomentum = computeMarketMomentum(var5y, dvfVol);

    const resaleProbabilityBase = computeResaleProbabilityPct(smartScore, tension);
    const riskPressureBase = computeRiskPressureIndex(conf.missingFields.length, smartScore, rendementBrut);

    const prix = readPrix(bodyAugmented);
    const travaux = asNumber(bodyAugmented?.travauxEstimes);
    const prixM2 = asNumber(bodyAugmented?.prixM2);
    const prixM2Median = asNumber(bodyAugmented?.prixM2Median);

    const oppBase = computeOpportunityScoreAdvanced({
      smartScore,
      rendementBrut,
      momentum: marketMomentum,
      resaleProbabilityPct: resaleProbabilityBase,
      riskPressureIndex: riskPressureBase,
      confidence: finalConfidence,
      prixM2,
      prixM2Median,
      prix,
      travaux,
      etatBien: bodyAugmented?.etatBien,
    });

    const deltasApplied = applyDeltas(
      {
        resaleProbabilityPct: resaleProbabilityBase,
        riskPressureIndex: riskPressureBase,
        opportunityScore: oppBase.score,
      },
      usedDeltas,
    );

    const oppRecalc = computeOpportunityScoreAdvanced({
      smartScore,
      rendementBrut,
      momentum: marketMomentum,
      resaleProbabilityPct: deltasApplied.adjusted.resaleProbabilityPct,
      riskPressureIndex: deltasApplied.adjusted.riskPressureIndex,
      confidence: finalConfidence,
      prixM2,
      prixM2Median,
      prix,
      travaux,
      etatBien: bodyAugmented?.etatBien,
    });

    const hasOppDelta = deltasApplied.applied.some((d) => d.target === "opportunityScore");
    const opportunityScoreFinal = hasOppDelta ? deltasApplied.adjusted.opportunityScore : oppRecalc.score;

    const target = computeDiscountTargetPct({ discountPct: oppRecalc.discountPct, rendementBrut });
    const prixAchatCible = computeTargetAcquisitionPrice(prix, target.extraDiscountNeededPct);

    const predictifFinal = {
      marketMomentum,
      resaleProbabilityPct: deltasApplied.adjusted.resaleProbabilityPct,
      riskPressureIndex: deltasApplied.adjusted.riskPressureIndex,
      opportunityScore: opportunityScoreFinal,
      discountPct: oppRecalc.discountPct,
      discountTargetPct: target.discountTargetPct,
      extraDiscountNeededPct: target.extraDiscountNeededPct,
      prixAchatCible,
      opportunityBreakdown: oppRecalc.breakdown,
    };

    // ── Recalculate margin/discount flags on bodyAugmented for verdict validation ──
    const margeBrutePctAug = readMargeBrutePct(bodyAugmented);
    const underMarginThresholdAug =
      margeBrutePctAug != null && margeBrutePctAug > 0 && margeBrutePctAug < SEUILS_MARCHAND.margeBruteCible;

    const prixAug = readPrix(bodyAugmented);
    const prixAchatCibleAug = predictifFinal.prixAchatCible;

    const discountSecuriseAug =
      prixAug != null &&
      prixAchatCibleAug != null &&
      prixAchatCibleAug > 0 &&
      prixAug <= prixAchatCibleAug;

    const validation = validateVerdictV2({
      verdict,
      smartScore,
      underMarginThreshold: underMarginThresholdAug,
      discountSecurise: discountSecuriseAug,
    });

    const metaMissing = !metaFound || !verdict || String(verdict).trim().toUpperCase() === "INCONNU";
    const verdictOverriddenFinal = metaMissing ? false : !validation.valid;
    const verdictWarningFinal = metaMissing ? null : validation.warning;

    // ── Narrative normalization pipeline ─────────────────────────────────
    let narrativeFinal = cleaned;

    // 1. Replace "données manquantes IMPORTANT durées" blocks
    narrativeFinal = normalizeNarrativeAfterCalibration(narrativeFinal, usedEstimates);

    // 2. Replace individual "durée X absente" mentions
    narrativeFinal = normalizeDurationMentionsAfterCalibration(narrativeFinal, usedEstimates);

    // 3. Replace "DONNÉE ABSENTE" → "NON CALCULABLE" in table tokens
    narrativeFinal = normalizeTableTokens(narrativeFinal);

    // 3b. Reformulate "loyer avec charges" if chargesUnit = INCONNU
    const chargesUnitFinal = inferChargesUnit(bodyAugmented);
    if (chargesUnitFinal === "INCONNU") {
      narrativeFinal = normalizeChargesMentionsWhenUnitUnknown(narrativeFinal);
    }
    if (chargesUnitFinal === "INCONNU") {
      narrativeFinal = normalizeChargesSpeculationWhenUnitUnknown(narrativeFinal);
      narrativeFinal = normalizePlanBLocationWhenChargesUnitUnknown(narrativeFinal);
    }

    // 4. Add calibration addendum
    narrativeFinal = addCalibrationAddendum(narrativeFinal, usedEstimates, predictifFinal);

    // 5. Last-resort numeric guardrail for RiskPressureIndex
    narrativeFinal = enforceCanonicalRiskPressureInNarrative(
      narrativeFinal,
      predictifFinal.riskPressureIndex,
    );

    // 6. Last-resort numeric guardrail for OpportunityScore
    narrativeFinal = enforceCanonicalOpportunityScoreInNarrative(
      narrativeFinal,
      predictifFinal.opportunityScore,
    );

    // Fallback: ensure seuilsConformite is never null
    const seuilsConformiteFinal =
      seuilsConformite && typeof seuilsConformite === "object"
        ? seuilsConformite
        : computeSeuilsConformiteServer(bodyAugmented);

    const dvfRecentFinal = readDvfRecentTransactions(bodyAugmented);
    const dvfAnalysisFinal = computeDvfRecentAnalysis({ dvf: dvfRecentFinal, prixM2Deal: asNumber(bodyAugmented?.prixM2) ?? null });

    // 7. Last-resort guardrails (always applied last)
    narrativeFinal = enforceConservativeSpeedLine(narrativeFinal);
    if (chargesUnitFinal === "INCONNU") {
      narrativeFinal = normalizeCashflowWordWhenChargesUnitUnknown(narrativeFinal);
      narrativeFinal = enforcePlanBLocationConservative(narrativeFinal);
    }

    return jsonResponse({
      ok: true,
      narrative: narrativeFinal,
      verdict: validation.corrected,

      confidence: finalConfidence,
      confidenceLevel: confidenceLevel(finalConfidence),
      confidenceDetails: {
        completenessPct: conf.completenessPct,
        missingCritical: conf.missingCritical,
        missingImportant: conf.missingImportant,
        missingOptional: conf.missingOptional,
        inconsistencyReasons: conf.inconsistencyReasons,
        completenessNote: conf.completenessNote,
      },
      confidenceNextSteps,

      constraintLabel: validation.constraint.label,
      seuilsConformite: seuilsConformiteFinal,

      predictif: predictifFinal,
      dvfAnalysis: dvfAnalysisFinal,

      calibrationLLM: calibration ?? null,
      calibrationUsed: {
        usedEstimates,
        usedDeltas: deltasApplied.applied,
        confidenceAdjustmentApplied: { delta: confAdj.deltaApplied, reason: confAdj.reason },
      },

      verdictOverridden: verdictOverriddenFinal,
      verdictWarning: verdictWarningFinal,
      model: data?.model,
      generatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[synthese-ia-v1] ERROR", error);
    return jsonResponse(
      {
        ok: false,
        error: error?.message || "Erreur inconnue",
        stack: error?.stack ? String(error.stack).slice(0, 1500) : undefined,
      },
      500,
    );
  }
});