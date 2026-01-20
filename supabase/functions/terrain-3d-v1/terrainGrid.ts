export type GridPoint = { x: number; y: number };

export function buildGrid(bounds: {
  minX: number; maxX: number; minY: number; maxY: number; step: number;
}): GridPoint[] {
  const { minX, maxX, minY, maxY, step } = bounds;
  const pts: GridPoint[] = [];
  if (step <= 0) return pts;

  for (let x = minX; x <= maxX; x += step) {
    for (let y = minY; y <= maxY; y += step) {
      pts.push({ x, y });
    }
  }
  return pts;
}
