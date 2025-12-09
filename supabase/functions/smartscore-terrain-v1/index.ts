// Typings Supabase Edge Runtime (autocomplétion, etc.)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type CriterionKey =
  | "constructibilite"
  | "reseaux"
  | "environnement"
  | "faisabilite_economique"
  | "acces_topographie"
  | "marche_local"
  | "proximite_services"
  | "juridique";

type CriterionInput = {
  // Score attendu entre 0 et 100
  score: number;
  // Optionnel : commentaire ou justification (origine de la donnée)
  comment?: string;
};

type SmartScoreInput = {
  version?: "v1" | "v2";
  criteres: Record<CriterionKey, CriterionInput>;
};

type SmartScoreCriterionDetail = {
  score: number;
  weight: number;
  weightedScore: number;
  comment?: string;
};

type SmartScoreResult = {
  version: "v1" | "v2";
  score: number; // 0-100
  grade: string; // A / B / C / D / E
  label: string; // texte lisible
  criteres: Record<CriterionKey, SmartScoreCriterionDetail>;
  warnings: string[];
};

const WEIGHTS_V1: Record<CriterionKey, number> = {
  constructibilite: 0.25,
  reseaux: 0.20,
  environnement: 0.15,
  faisabilite_economique: 0.10,
  acces_topographie: 0.10,
  marche_local: 0.15,
  proximite_services: 0.03,
  juridique: 0.02,
};

// Pour l’instant, V2 = même pondération mais tu pourras l’ajuster plus tard
const WEIGHTS_V2: Record<CriterionKey, number> = {
  ...WEIGHTS_V1,
};

function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function computeGrade(score: number): { grade: string; label: string } {
  if (score >= 85) return { grade: "A", label: "Excellent potentiel" };
  if (score >= 70) return { grade: "B", label: "Très bon potentiel" };
  if (score >= 55) return { grade: "C", label: "Potentiel correct" };
  if (score >= 40) return { grade: "D", label: "Potentiel limité" };
  return { grade: "E", label: "Risque élevé / faible intérêt" };
}

function computeSmartScore(
  input: SmartScoreInput,
): SmartScoreResult {
  const version: "v1" | "v2" = input.version ?? "v1";
  const weights = version === "v1" ? WEIGHTS_V1 : WEIGHTS_V2;

  const criteresInput = input.criteres;
  const details: Partial<Record<CriterionKey, SmartScoreCriterionDetail>> = {};
  const warnings: string[] = [];

  let totalWeighted = 0;
  let totalWeight = 0;

  (Object.keys(weights) as CriterionKey[]).forEach((key) => {
    const critInput = criteresInput[key];

    if (!critInput) {
      warnings.push(`Critère manquant : ${key}`);
      return;
    }

    const rawScore = critInput.score;
    const score = clampScore(rawScore);
    const weight = weights[key];
    const weightedScore = score * weight * 1.0;

    totalWeighted += weightedScore;
    totalWeight += weight;

    details[key] = {
      score,
      weight,
      weightedScore,
      comment: critInput.comment,
    };
  });

  if (totalWeight === 0) {
    return {
      version,
      score: 0,
      grade: "E",
      label: "Risque élevé / données insuffisantes",
      criteres: details as Record<CriterionKey, SmartScoreCriterionDetail>,
      warnings: [
        "Aucun critère valide reçu pour le calcul du SmartScore. Vérifiez le format de 'criteres'.",
        ...warnings,
      ],
    };
  }

  const finalScore = totalWeighted / totalWeight;
  const { grade, label } = computeGrade(finalScore);

  return {
    version,
    score: Math.round(finalScore * 10) / 10, // ex: 73.2
    grade,
    label,
    criteres: details as Record<CriterionKey, SmartScoreCriterionDetail>,
    warnings,
  };
}

// Point d’entrée HTTP de l’Edge Function
Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          error: "Use POST with a JSON body",
        }),
        {
          status: 405,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid or empty JSON body" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const body = payload as Partial<SmartScoreInput>;

    if (!body.criteres) {
      return new Response(
        JSON.stringify({
          error: "Missing field 'criteres'.",
          expected_format: {
            version: "v1",
            criteres: {
              constructibilite: { score: 0 },
              reseaux: { score: 0 },
              environnement: { score: 0 },
              faisabilite_economique: { score: 0 },
              acces_topographie: { score: 0 },
              marche_local: { score: 0 },
              proximite_services: { score: 0 },
              juridique: { score: 0 },
            },
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const result = computeSmartScore(body as SmartScoreInput);

    return new Response(
      JSON.stringify(result),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error(e);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: String(e),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});
