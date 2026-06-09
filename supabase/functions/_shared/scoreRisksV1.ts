type RiskSeverity = "low" | "moderate" | "high" | "critical" | "unknown";

type RiskItem = {
  key: string;
  label: string;
  severity: RiskSeverity;
  score_impact: number; // penalty 0..100
  confidence: number;   // 0..1
  source: "georisques";
  evidence?: string[];
  raw?: unknown;
};

type RisksScore = {
  score: number; // 0..100 (100 best)
  grade: "A" | "B" | "C" | "D" | "E";
  level_label: string;
  items: RiskItem[];
  missing: string[];
  confidence: number; // 0..1
  rationale: string[];
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function gradeFromScore(score: number): { grade: RisksScore["grade"]; label: string } {
  if (score >= 85) return { grade: "A", label: "Faible" };
  if (score >= 70) return { grade: "B", label: "Modéré" };
  if (score >= 55) return { grade: "C", label: "Moyen" };
  if (score >= 40) return { grade: "D", label: "Élevé" };
  return { grade: "E", label: "Critique" };
}

/**
 * Expects your risks payload shape:
 * risks.results.radon / catnat / risques / ppr_*
 * risks.status.*
 */
export function scoreRisksV1(risks: any): RisksScore {
  const items: RiskItem[] = [];
  const missing: string[] = [];

  const status = risks?.status ?? {};
  const results = risks?.results ?? {};

  // helper to mark missing
  const ensure = (k: string) => {
    const st = status?.[k];
    if (typeof st !== "number" || st < 200 || st >= 300) {
      missing.push(k);
      return false;
    }
    return true;
  };

  // ----------------
  // RADON
  // ----------------
  if (ensure("radon")) {
    const data0 = results?.radon?.data?.[0];
    const classe = String(data0?.classe_potentiel ?? "");
    let penalty = 4;
    let sev: RiskSeverity = "unknown";

    if (classe === "1") { penalty = 2; sev = "low"; }
    else if (classe === "2") { penalty = 6; sev = "moderate"; }
    else if (classe === "3") { penalty = 12; sev = "high"; }

    items.push({
      key: "radon",
      label: "Potentiel radon",
      severity: sev,
      score_impact: penalty,
      confidence: classe ? 0.95 : 0.5,
      source: "georisques",
      evidence: [classe ? `Classe radon: ${classe}` : "Classe radon non disponible"],
      raw: results?.radon,
    });
  } else {
    items.push({
      key: "radon",
      label: "Potentiel radon",
      severity: "unknown",
      score_impact: 4,
      confidence: 0.3,
      source: "georisques",
      evidence: ["Donnée radon indisponible (API)"],
    });
  }

  // ----------------
  // CATNAT (gaspar/catnat)
  // ----------------
  if (ensure("catnat")) {
    // We try several likely shapes.
    const arr = results?.catnat?.data ?? results?.catnat?.results ?? results?.catnat ?? [];
    const count = Array.isArray(arr) ? arr.length : (typeof arr?.results === "number" ? arr.results : 0);

    let penalty = 0;
    let sev: RiskSeverity = "low";
    if (count === 0) { penalty = 0; sev = "low"; }
    else if (count <= 2) { penalty = 6; sev = "moderate"; }
    else if (count <= 5) { penalty = 12; sev = "moderate"; }
    else if (count <= 10) { penalty = 20; sev = "high"; }
    else { penalty = 30; sev = "high"; }

    items.push({
      key: "catnat",
      label: "Historique CatNat",
      severity: sev,
      score_impact: penalty,
      confidence: 0.8,
      source: "georisques",
      evidence: [`Arrêtés CatNat (rayon): ${count}`],
      raw: results?.catnat,
    });
  } else {
    items.push({
      key: "catnat",
      label: "Historique CatNat",
      severity: "unknown",
      score_impact: 3,
      confidence: 0.3,
      source: "georisques",
      evidence: ["Donnée CatNat indisponible (API)"],
    });
  }

  // ----------------
  // RISQUES (gaspar/risques)
  // ----------------
  if (ensure("risques")) {
    const payload = results?.risques;
    const list =
      payload?.data ??
      payload?.risques ??
      payload?.results ??
      (Array.isArray(payload) ? payload : []);

    // naive extraction of labels
    const labels: string[] = [];
    if (Array.isArray(list)) {
      for (const it of list) {
        const label = it?.libelle ?? it?.label ?? it?.nom ?? it?.type ?? null;
        if (label) labels.push(String(label).toLowerCase());
      }
    }

    let penalty = 0;
    let sev: RiskSeverity = "low";

    const add = (p: number) => { penalty += p; };

    const has = (needle: string) => labels.some((x) => x.includes(needle));

    if (has("inond")) add(18);
    if (has("argile") || has("retrait") || has("gonf")) add(12);
    if (has("cavit")) add(14);
    if (has("mouvement") || has("glissement") || has("eboulement")) add(16);
    if (has("sism")) add(6);
    if (has("feu") || has("incendie")) add(10);
    if (has("submersion") || has("littoral")) add(20);
    if (has("avalan")) add(20);

    penalty = Math.min(penalty, 45);

    if (penalty >= 30) sev = "high";
    else if (penalty >= 15) sev = "moderate";
    else sev = "low";

    items.push({
      key: "risques",
      label: "Exposition aux risques",
      severity: sev,
      score_impact: penalty,
      confidence: 0.75,
      source: "georisques",
      evidence: [
        labels.length ? `Risques détectés: ${[...new Set(labels)].slice(0, 6).join(", ")}` : "Aucun risque typé détecté",
      ],
      raw: results?.risques,
    });
  } else {
    items.push({
      key: "risques",
      label: "Exposition aux risques",
      severity: "unknown",
      score_impact: 3,
      confidence: 0.3,
      source: "georisques",
      evidence: ["Donnée risques indisponible (API)"],
    });
  }

  // ----------------
  // PPR (/ppr)
  // ----------------
  // you may have ppr_latlon or ppr_code_insee; accept either as "ppr"
  const pprOk =
    (typeof status?.ppr_latlon === "number" && status.ppr_latlon >= 200 && status.ppr_latlon < 300) ||
    (typeof status?.ppr_code_insee === "number" && status.ppr_code_insee >= 200 && status.ppr_code_insee < 300);

  if (pprOk) {
    const pprPayload = results?.ppr_latlon ?? results?.ppr_code_insee;
    const pprList =
      pprPayload?.data ??
      pprPayload?.results ??
      (Array.isArray(pprPayload) ? pprPayload : []);

    const count = Array.isArray(pprList) ? pprList.length : 0;

    // Try infer type
    const text = JSON.stringify(pprList).toLowerCase();

    let penalty = 0;
    let sev: RiskSeverity = "low";
    let label = "Aucun PPR identifié";
    if (count > 0) {
      label = `PPR identifié (${count})`;
      if (text.includes("inond")) penalty = 30;
      else if (text.includes("techno")) penalty = 30;
      else if (text.includes("mouvement") || text.includes("glissement")) penalty = 25;
      else if (text.includes("multi")) penalty = 35;
      else penalty = 22;

      sev = penalty >= 30 ? "high" : "moderate";
    }

    items.push({
      key: "ppr",
      label: "PPR (réglementaire)",
      severity: sev,
      score_impact: penalty,
      confidence: 0.85,
      source: "georisques",
      evidence: [label],
      raw: pprPayload,
    });
  } else {
    missing.push("ppr");
    items.push({
      key: "ppr",
      label: "PPR (réglementaire)",
      severity: "unknown",
      score_impact: 3,
      confidence: 0.3,
      source: "georisques",
      evidence: ["Donnée PPR indisponible (API)"],
    });
  }

  // ----------------
  // Global score
  // ----------------
  const base = 100;
  const penalties = items.reduce((s, it) => s + (Number.isFinite(it.score_impact) ? it.score_impact : 0), 0);

  // Missing major sources prudence penalty
  const missingMajor = ["catnat", "risques", "ppr"].filter((k) => missing.includes(k)).length;
  const prudencePenalty = Math.min(10, missingMajor * 3);

  const score = clamp(base - penalties - prudencePenalty, 0, 100);
  const { grade, label: level_label } = gradeFromScore(score);

  // Global confidence = average of item confidence, penalized by missing majors
  const avgConf = items.reduce((s, it) => s + it.confidence, 0) / Math.max(1, items.length);
  const confidence = clamp(avgConf - missingMajor * 0.12, 0.1, 1);

  const rationale: string[] = [];
  // Bank-friendly rationale lines
  const top = [...items].sort((a, b) => b.score_impact - a.score_impact).slice(0, 3);
  for (const it of top) {
    if (it.score_impact > 0) {
      rationale.push(`${it.label} : impact ${it.score_impact}/100 (${it.severity}).`);
    }
  }
  if (missingMajor > 0) {
    rationale.push(`Certaines données sont indisponibles (${["catnat","risques","ppr"].filter((k)=>missing.includes(k)).join(", ")}), score appliqué de manière prudente.`);
  }

  return {
    score,
    grade,
    level_label,
    items,
    missing: [...new Set(missing)],
    confidence,
    rationale,
  };
}
