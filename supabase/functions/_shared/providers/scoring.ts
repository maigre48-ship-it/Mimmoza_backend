type Weighted = { w: number; v: number | null | undefined };

export function weightedAverage(items: Weighted[]): number | null {
  let sw = 0;
  let sv = 0;

  for (const it of items) {
    const v = it.v;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;

    const w = Number(it.w);
    if (!Number.isFinite(w) || w <= 0) continue;

    sw += w;
    sv += w * v;
  }

  if (sw <= 0) return null;
  return sv / sw;
}
