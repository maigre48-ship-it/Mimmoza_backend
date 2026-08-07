import type { SubscoreKey } from "../types/market.types.ts";

export function computeGlobalScore(args: {
  subscores: Partial<Record<SubscoreKey, number | null>>;
  weights: Partial<Record<SubscoreKey, number>>;
  blocking: string[];
}): number | null {
  // 1) Champs bloquants => pas de score
  if (args.blocking.length > 0) return null;

  const entries = Object.entries(args.weights) as Array<[SubscoreKey, number]>;

  const available = entries
    .map(([k, w]) => {
      const v = args.subscores[k];
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) return null;
      return { k, w, v };
    })
    .filter((x): x is { k: SubscoreKey; w: number; v: number } => !!x);

  // 2) Aucune composante exploitable : score fallback neutre (étude possible, mais faible confiance)
  if (available.length === 0) return 50;

  const sumW = available.reduce((a, b) => a + b.w, 0);
  if (sumW <= 0) return 50;

  const score = available.reduce((acc, it) => acc + it.v * (it.w / sumW), 0);
  const rounded = Math.round(score);

  return Math.max(0, Math.min(100, rounded));
}
