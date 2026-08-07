import type { MarketStudyRequest, ProjectType } from "../types/market.types.ts";
import { DEFAULT_RADIUS_BY_PROJECT } from "../scoring/scoringConfig.ts";

const PROJECT_TYPES: ProjectType[] = [
  "LOGEMENT",
  "COMMERCE",
  "BUREAUX",
  "HOTEL",
  "ETUDIANT",
  "RSS",
  "EHPAD",
];

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function validateRequest(raw: unknown): { ok: true; value: MarketStudyRequest } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "Body must be a JSON object." };

  const project_type = raw.project_type;
  const lat = raw.lat;
  const lon = raw.lon;

  if (typeof project_type !== "string" || !PROJECT_TYPES.includes(project_type as ProjectType)) {
    return { ok: false, error: `Invalid project_type. Allowed: ${PROJECT_TYPES.join(", ")}` };
  }
  if (!isFiniteNumber(lat) || lat < -90 || lat > 90) return { ok: false, error: "Invalid lat." };
  if (!isFiniteNumber(lon) || lon < -180 || lon > 180) return { ok: false, error: "Invalid lon." };

  const radius_km = raw.radius_km;
  if (radius_km !== undefined && radius_km !== null) {
    if (!isFiniteNumber(radius_km) || radius_km <= 0 || radius_km > 50) {
      return { ok: false, error: "Invalid radius_km (expected 0 < radius_km <= 50)." };
    }
  }

  const commune_insee = raw.commune_insee;
  if (commune_insee !== undefined && commune_insee !== null && typeof commune_insee !== "string") {
    return { ok: false, error: "Invalid commune_insee." };
  }

  const zone_type = raw.zone_type;
  if (zone_type !== undefined && zone_type !== null) {
    if (zone_type !== "commune" && zone_type !== "iris" && zone_type !== "custom") {
      return { ok: false, error: "Invalid zone_type." };
    }
  }

  return {
    ok: true,
    value: {
      project_type: project_type as ProjectType,
      lat,
      lon,
      radius_km: radius_km as number | undefined,
      commune_insee: (commune_insee as string | null | undefined) ?? undefined,
      zone_type: zone_type as any,
    },
  };
}

export function applyDefaults(req: MarketStudyRequest): MarketStudyRequest & { radius_km: number } {
  const defaultRadius = DEFAULT_RADIUS_BY_PROJECT[req.project_type];
  return {
    ...req,
    radius_km: req.radius_km ?? defaultRadius,
  };
}
