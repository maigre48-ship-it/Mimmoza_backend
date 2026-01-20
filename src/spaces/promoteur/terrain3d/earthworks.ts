import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";
import type { Feature, Polygon, MultiPolygon } from "geojson";

type BBox = [number, number, number, number]; // [minLng,minLat,maxLng,maxLat]

export type EarthworksParams = {
  profondeurFouilleM: number;     // ex: 3
  prixDeblaiEurM3: number;        // ex: 25
  prixRemblaiEurM3: number;       // ex: 18
  // optionnel : foisonnement, etc.
};

export type EarthworksResult = {
  volumeDeblaisM3: number;
  volumeRemblaisM3: number;
  coutEur: number;
  debug?: {
    cellAreaM2: number;
    samples: number;
    zTarget: number;
  };
};

function metersPerDegree(latDeg: number) {
  const cos = Math.cos((latDeg * Math.PI) / 180) || 1e-6;
  return {
    mPerDegLat: 111_320,
    mPerDegLon: 111_320 * cos,
  };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Calcule deblais/remblais sur une grille terrain (gridZ) dans renderBounds,
 * en masquant par polygon (parcelle ou emprise).
 *
 * - polygonLonLat: Feature Polygon/MultiPolygon en WGS84 lon/lat
 * - zTarget: plateforme à altitude constante = médiane des z dans l’emprise (stable)
 */
export function computeEarthworksFromGrid(opts: {
  gridZ: number[][];
  renderBounds: BBox;
  polygonLonLat: Feature<Polygon | MultiPolygon>;
  params: EarthworksParams;
}): EarthworksResult {
  const { gridZ, renderBounds, polygonLonLat, params } = opts;

  const nY = gridZ.length;
  const nX = gridZ[0]?.length ?? 0;
  if (nX < 2 || nY < 2) {
    return { volumeDeblaisM3: 0, volumeRemblaisM3: 0, coutEur: 0 };
  }

  const [minLng, minLat, maxLng, maxLat] = renderBounds;
  const midLat = (minLat + maxLat) / 2;
  const { mPerDegLon, mPerDegLat } = metersPerDegree(midLat);

  // taille cellule en mètres (approx, suffisant à l’échelle parcelle)
  const dxM = ((maxLng - minLng) / (nX - 1)) * mPerDegLon;
  const dyM = ((maxLat - minLat) / (nY - 1)) * mPerDegLat;
  const cellAreaM2 = Math.abs(dxM * dyM);

  // 1) échantillons z dans le polygone pour zTarget (médiane)
  const samples: number[] = [];
  for (let iy = 0; iy < nY; iy++) {
    const lat = minLat + (iy / (nY - 1)) * (maxLat - minLat);
    for (let ix = 0; ix < nX; ix++) {
      const lng = minLng + (ix / (nX - 1)) * (maxLng - minLng);
      const inside = booleanPointInPolygon(turfPoint([lng, lat]), polygonLonLat);
      if (!inside) continue;
      const z = gridZ[iy][ix];
      if (Number.isFinite(z)) samples.push(z);
    }
  }

  if (samples.length < 6) {
    // pas assez de points, on évite un résultat aberrant
    return { volumeDeblaisM3: 0, volumeRemblaisM3: 0, coutEur: 0, debug: { cellAreaM2, samples: samples.length, zTarget: 0 } };
  }

  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  const zTarget = samples.length % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;

  const zTargetExcav = zTarget - clamp(params.profondeurFouilleM || 0, 0, 50);

  // 2) intégration volumes
  let cut = 0;
  let fill = 0;
  let used = 0;

  for (let iy = 0; iy < nY; iy++) {
    const lat = minLat + (iy / (nY - 1)) * (maxLat - minLat);
    for (let ix = 0; ix < nX; ix++) {
      const lng = minLng + (ix / (nX - 1)) * (maxLng - minLng);
      const inside = booleanPointInPolygon(turfPoint([lng, lat]), polygonLonLat);
      if (!inside) continue;

      const z = gridZ[iy][ix];
      if (!Number.isFinite(z)) continue;

      const d = z - zTargetExcav;
      if (d > 0) cut += d * cellAreaM2;
      else fill += (-d) * cellAreaM2;

      used++;
    }
  }

  const cout = cut * (params.prixDeblaiEurM3 || 0) + fill * (params.prixRemblaiEurM3 || 0);

  return {
    volumeDeblaisM3: cut,
    volumeRemblaisM3: fill,
    coutEur: cout,
    debug: { cellAreaM2, samples: used, zTarget },
  };
}
