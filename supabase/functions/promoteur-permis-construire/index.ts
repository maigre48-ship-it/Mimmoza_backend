// supabase/functions/promoteur-permis-construire/index.ts
// Mimmoza — Edge Function Promoteur / Permis de construire
// -----------------------------------------------------------------------------
// Sources : 3 datasets Koumoul (Data Fair) exposant la base Sitadel :
//   • sitadel-logements : PC + DP de logements (~1,87 M enregistrements)
//   • sitadel-pa        : permis d'aménager (type implicite = PA)
//   • sitadel-pd        : permis de démolir (type implicite = PD)
//
// Les 3 datasets sont interrogés en parallèle selon le filtre utilisateur :
//   - PC ou DP cochés → sitadel-logements
//   - PA cochée        → sitadel-pa
//   - PD cochée        → sitadel-pd
//   - Tous             → les 3
//
// Un échec partiel (ex. sitadel-pd indisponible) n'empêche pas les autres
// datasets de renvoyer leurs résultats ; l'échec est remonté via `notices`.
// -----------------------------------------------------------------------------
// Pipeline :
//   1. Sélection des datasets selon typeAutorisationFilter
//   2. Fetch parallèle (Promise.allSettled) — pagination curseur par dataset
//   3. Normalisation avec impliedType forcé pour sitadel-pa/sitadel-pd
//   4. Déduplication globale par clé `{datasetId}:{recordId}`
//   5. Filtrage local (distance, type, typologie, commune, période, …)
//   6. Tri + pagination
// -----------------------------------------------------------------------------

type SortBy = "distance" | "date" | "logements" | "surface";
type SortOrder = "asc" | "desc";
type TypeAutorisation = "PC" | "DP" | "PA" | "PD";
type Typologie =
  | "all"
  | "logement"
  | "individuel"
  | "collectif"
  | "mixte"
  | "activite";

type TypeAutorisationFilter = Set<TypeAutorisation> | "all";

interface SearchRequestBody {
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  periodMonths?: number;
  typeAutorisation?:
    | TypeAutorisation
    | "all"
    | TypeAutorisation[]
    | string
    | string[];
  typologie?: Typologie;
  logementsMin?: number | null;
  logementsMax?: number | null;
  surfaceMin?: number | null;
  surfaceMax?: number | null;
  commune?: string | null;
  limit?: number;
  offset?: number;
  sortBy?: SortBy;
  sortOrder?: SortOrder;
}

interface ValidatedSearchParams {
  latitude: number;
  longitude: number;
  radiusKm: number;
  periodMonths: number;
  typeAutorisationFilter: TypeAutorisationFilter;
  typologie: Typologie;
  logementsMin: number | null;
  logementsMax: number | null;
  surfaceMin: number | null;
  surfaceMax: number | null;
  commune: string | null;
  limit: number;
  offset: number;
  sortBy: SortBy;
  sortOrder: SortOrder;
}

interface PermisConstruireItem {
  id: string;
  distanceKm: number | null;
  commune: string | null;
  codePostal: string | null;
  dateDepot: string | null;
  typeAutorisation: string | null;
  natureProjet: string | null;
  typologie: string | null;
  nombreLogements: number | null;
  surface: number | null;
  statut: string | null;
  adresse: string | null;
  referenceDossier: string | null;
  latitude: number | null;
  longitude: number | null;
  source: string;
  raw?: Record<string, unknown> | null;
}

interface SearchResponse {
  items: PermisConstruireItem[];
  total: number;
  limit: number;
  offset: number;
  source: string;
  fetchedAt: string;
  notices?: string[];
  debug?: Record<string, unknown>;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const DEFAULTS = {
  radiusKm: 10,
  periodMonths: 24,
  defaultTypeAutorisationFilter: new Set<TypeAutorisation>(["PC"]),
  typologie: "all" as Typologie,
  limit: 20,
  offset: 0,
  sortBy: "distance" as SortBy,
  sortOrder: "asc" as SortOrder,
  maxLimit: 100,
  maxRadiusKm: 25,
  minRadiusKm: 0,
  minPeriodMonths: 1,
  maxPeriodMonths: 120,
};

// ---------------------------------------------------------------------------
// Datasets Koumoul
// ---------------------------------------------------------------------------

interface DatasetConfig {
  id: string;
  endpoint: string;
  // Si non-null : tout record de ce dataset est réputé de ce type.
  // Évite de chercher Type_DAU dans sitadel-pa / sitadel-pd.
  impliedType: TypeAutorisation | null;
  // Types que ce dataset peut produire (utile pour la sélection).
  providedTypes: Set<TypeAutorisation>;
  label: string;
}

const DATASETS: readonly DatasetConfig[] = [
  {
    id: "sitadel-logements",
    endpoint:
      "https://koumoul.com/data-fair/api/v1/datasets/sitadel-logements/lines",
    impliedType: null,
    providedTypes: new Set<TypeAutorisation>(["PC", "DP"]),
    label: "PC/DP logements",
  },
  {
    id: "sitadel-pa",
    endpoint: "https://koumoul.com/data-fair/api/v1/datasets/sitadel-pa/lines",
    impliedType: "PA",
    providedTypes: new Set<TypeAutorisation>(["PA"]),
    label: "PA (permis d'aménager)",
  },
  {
    id: "sitadel-pd",
    endpoint: "https://koumoul.com/data-fair/api/v1/datasets/sitadel-pd/lines",
    impliedType: "PD",
    providedTypes: new Set<TypeAutorisation>(["PD"]),
    label: "PD (permis de démolir)",
  },
] as const;

function selectDatasetsForFilter(
  filter: TypeAutorisationFilter,
): DatasetConfig[] {
  if (filter === "all") return [...DATASETS];
  const picked: DatasetConfig[] = [];
  for (const ds of DATASETS) {
    for (const t of filter) {
      if (ds.providedTypes.has(t)) {
        picked.push(ds);
        break;
      }
    }
  }
  return picked;
}

const KOUMOUL_PAGE_SIZE = 500;
const KOUMOUL_HARD_CAP = 3000;
const KOUMOUL_MAX_PAGES = KOUMOUL_HARD_CAP / KOUMOUL_PAGE_SIZE;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS_HEADERS,
  });
}

function badRequest(message: string, details?: unknown): Response {
  return jsonResponse(
    { error: "BAD_REQUEST", message, details: details ?? null },
    400,
  );
}

function internalError(message: string, details?: unknown): Response {
  return jsonResponse(
    { error: "INTERNAL_ERROR", message, details: details ?? null },
    500,
  );
}

// ---------------------------------------------------------------------------
// Helpers de parsing
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const cleaned = value.replace(",", ".").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toNullableTrimmedString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value : String(value);
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeString(value: unknown): string | null {
  const s = toNullableTrimmedString(value);
  return s ? s.replace(/\s+/g, " ").trim() : null;
}

function sanitizeAddressPiece(value: unknown): string | null {
  const s = sanitizeString(value);
  if (!s) return null;
  return s.replace(/^_+/, "").trim() || null;
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  let parsed: number = fallback;
  if (typeof value === "number" && Number.isFinite(value)) {
    parsed = Math.trunc(value);
  } else if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) parsed = Math.trunc(n);
  }
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function isValidLat(lat: unknown): lat is number {
  return isFiniteNumber(lat) && lat >= -90 && lat <= 90;
}

function isValidLon(lon: unknown): lon is number {
  return isFiniteNumber(lon) && lon >= -180 && lon <= 180;
}

function parseIsoDateSafe(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateSafe(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = parseIsoDateSafe(value);
  if (!d) return null;
  return d.toISOString();
}

function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

function normalizeTypologie(value: unknown): Typologie {
  const v = String(value ?? "").trim().toLowerCase();
  if (
    v === "all" ||
    v === "logement" ||
    v === "individuel" ||
    v === "collectif" ||
    v === "mixte" ||
    v === "activite"
  ) {
    return v;
  }
  return DEFAULTS.typologie;
}

function normalizeSortBy(value: unknown): SortBy {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "distance" || v === "date" || v === "logements" || v === "surface") {
    return v;
  }
  return DEFAULTS.sortBy;
}

function normalizeSortOrder(value: unknown): SortOrder {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "asc" || v === "desc") return v;
  return DEFAULTS.sortOrder;
}

function normalizeTypeAutorisationFilter(
  value: unknown,
): TypeAutorisationFilter {
  if (value === undefined || value === null) {
    return new Set(DEFAULTS.defaultTypeAutorisationFilter);
  }

  const candidates: string[] = [];
  const pushFrom = (raw: unknown) => {
    if (Array.isArray(raw)) {
      for (const v of raw) pushFrom(v);
      return;
    }
    if (raw === null || raw === undefined) return;
    const s = String(raw).trim();
    if (!s) return;
    if (s.includes(",")) {
      for (const part of s.split(",")) {
        const p = part.trim();
        if (p) candidates.push(p);
      }
    } else {
      candidates.push(s);
    }
  };

  pushFrom(value);

  const set = new Set<TypeAutorisation>();
  for (const c of candidates) {
    const up = c.toUpperCase();
    if (up === "ALL") return "all";
    if (up === "PC" || up === "DP" || up === "PA" || up === "PD") {
      set.add(up);
    }
  }

  if (set.size === 0) {
    return new Set(DEFAULTS.defaultTypeAutorisationFilter);
  }

  if (set.size === 4) return "all";
  return set;
}

function stripAccents(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(3));
}

// Cache (par record) de la table clé-lowercase → clé-originale,
// pour une résolution totalement case-insensitive.
const keyMapCache = new WeakMap<object, Map<string, string>>();

function readFirstDefined(
  row: Record<string, unknown>,
  candidates: string[],
): unknown {
  let lowerToOriginal = keyMapCache.get(row);
  if (!lowerToOriginal) {
    lowerToOriginal = new Map<string, string>();
    for (const k of Object.keys(row)) {
      lowerToOriginal.set(k.toLowerCase(), k);
    }
    keyMapCache.set(row, lowerToOriginal);
  }
  for (const base of candidates) {
    const origKey = lowerToOriginal.get(base.toLowerCase());
    if (origKey === undefined) continue;
    const v = row[origKey];
    if (v !== null && v !== undefined && v !== "") {
      return v;
    }
  }
  return undefined;
}

function mapNatureProjet(value: unknown): string | null {
  const n = toNullableNumber(value);
  if (n === null) return sanitizeString(value);

  switch (n) {
    case 1:
      return "Nouvelle construction";
    case 2:
      return "Transformation";
    case 3:
      return "Extension";
    case 4:
      return "Surélévation";
    case 5:
      return "Annexe";
    default:
      return String(n);
  }
}

function mapEtatDau(value: unknown): string | null {
  const n = toNullableNumber(value);
  if (n === null) return sanitizeString(value);

  switch (n) {
    case 1:
      return "Déposé";
    case 2:
      return "Autorisé";
    case 3:
      return "Refusé";
    case 4:
      return "Annulé";
    case 5:
      return "En cours";
    case 6:
      return "Déclaré achevé";
    default:
      return String(n);
  }
}

function buildAdresse(record: Record<string, unknown>): string | null {
  const num = sanitizeAddressPiece(readFirstDefined(record, ["ADR_NUM_TER"]));
  const voie = sanitizeAddressPiece(readFirstDefined(record, ["ADR_LIBVOIE_TER"]));
  const localite = sanitizeAddressPiece(
    readFirstDefined(record, ["ADR_LOCALITE_TER"]),
  );

  const parts = [num, voie, localite].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(" ") : null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateRequestBody(input: SearchRequestBody): ValidatedSearchParams {
  const latitude = input.latitude;
  const longitude = input.longitude;

  if (!isValidLat(latitude)) throw new Error("Latitude invalide ou absente.");
  if (!isValidLon(longitude)) throw new Error("Longitude invalide ou absente.");

  const radiusKmRaw =
    typeof input.radiusKm === "number" ? input.radiusKm : DEFAULTS.radiusKm;

  if (
    !Number.isFinite(radiusKmRaw) ||
    radiusKmRaw < DEFAULTS.minRadiusKm ||
    radiusKmRaw > DEFAULTS.maxRadiusKm
  ) {
    throw new Error(
      `radiusKm doit être compris entre ${DEFAULTS.minRadiusKm} et ${DEFAULTS.maxRadiusKm}.`,
    );
  }

  const periodMonths = clampInt(
    input.periodMonths,
    DEFAULTS.periodMonths,
    DEFAULTS.minPeriodMonths,
    DEFAULTS.maxPeriodMonths,
  );
  const limit = clampInt(input.limit, DEFAULTS.limit, 1, DEFAULTS.maxLimit);
  const offset = clampInt(input.offset, DEFAULTS.offset, 0, 100000);

  const logementsMin = toNullableNumber(input.logementsMin);
  const logementsMax = toNullableNumber(input.logementsMax);
  const surfaceMin = toNullableNumber(input.surfaceMin);
  const surfaceMax = toNullableNumber(input.surfaceMax);

  if (
    logementsMin !== null &&
    logementsMax !== null &&
    logementsMin > logementsMax
  ) {
    throw new Error("logementsMin ne peut pas être supérieur à logementsMax.");
  }

  if (surfaceMin !== null && surfaceMax !== null && surfaceMin > surfaceMax) {
    throw new Error("surfaceMin ne peut pas être supérieure à surfaceMax.");
  }

  return {
    latitude,
    longitude,
    radiusKm: radiusKmRaw,
    periodMonths,
    typeAutorisationFilter: normalizeTypeAutorisationFilter(input.typeAutorisation),
    typologie: normalizeTypologie(input.typologie),
    logementsMin,
    logementsMax,
    surfaceMin,
    surfaceMax,
    commune: sanitizeString(input.commune),
    limit,
    offset,
    sortBy: normalizeSortBy(input.sortBy),
    sortOrder: normalizeSortOrder(input.sortOrder),
  };
}

// ---------------------------------------------------------------------------
// Koumoul / Data Fair — fetch par dataset
// ---------------------------------------------------------------------------

interface KoumoulLinesResponse {
  total?: number;
  results?: unknown[];
  next?: string;
}

interface KoumoulFetchResult {
  records: unknown[];
  totalReported: number | null;
  reachedCap: boolean;
  duplicatesRemoved: number;
  totalReceivedFromSource: number;
}

interface DatasetFetchResult extends KoumoulFetchResult {
  datasetId: string;
  datasetLabel: string;
  impliedType: TypeAutorisation | null;
  ok: boolean;
  errorMessage?: string;
}

function parseGeopoint(value: unknown): { lat: number; lon: number } | null {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function readCommuneName(record: Record<string, unknown>): string | null {
  return sanitizeString(
    readFirstDefined(record, [
      "ADR_LOCALITE_TER",
      "libelle_commune",
      "lib_commune",
      "nom_commune",
      "NOM_COMM",
      "LIBCOM",
    ]),
  );
}

function readCommuneCodeInsee(record: Record<string, unknown>): string | null {
  return sanitizeString(readFirstDefined(record, ["COMM", "code_commune_insee"]));
}

function readCodePostal(record: Record<string, unknown>): string | null {
  return sanitizeString(
    readFirstDefined(record, [
      "ADR_CODPOST_TER",
      "code_postal",
      "CP",
      "CODE_POSTAL",
    ]),
  );
}

function inferTypologieFromSitadel(
  record: Record<string, unknown>,
): string | null {
  const nbCol = toNullableNumber(
    readFirstDefined(record, [
      "NB_LGT_COL_CREES",
      "NB_LGT_COLLECTIFS_CREES",
    ]),
  );

  const nbInd = toNullableNumber(
    readFirstDefined(record, ["NB_LGT_IND_CREES", "NB_LGT_INDIVIDUELS_CREES"]),
  );

  const nbIndPurs = toNullableNumber(
    readFirstDefined(record, ["NB_LGT_INDIV_PURS"]),
  );

  const nbIndGroupes = toNullableNumber(
    readFirstDefined(record, ["NB_LGT_INDIV_GROUPES"]),
  );

  const hasCol = nbCol !== null && nbCol > 0;
  const hasInd =
    (nbInd !== null && nbInd > 0) ||
    (nbIndPurs !== null && nbIndPurs > 0) ||
    (nbIndGroupes !== null && nbIndGroupes > 0);

  if (hasCol && hasInd) return "mixte";
  if (hasCol) return "collectif";
  if (hasInd) return "individuel";

  const typePrincip = toNullableNumber(
    readFirstDefined(record, ["TYPE_PRINCIP_LOGTS_CREES"]),
  );

  if (typePrincip === 1) return "individuel";
  if (typePrincip === 2) return "mixte";
  if (typePrincip === 3) return "collectif";

  const total = toNullableNumber(
    readFirstDefined(record, ["NB_LGT_TOT_CREES"]),
  );
  if (total !== null && total > 0) return "logement";

  return null;
}

interface NormalizedWithMeta {
  item: PermisConstruireItem;
  communeCodeInsee: string | null;
  codePostal: string | null;
  datasetId: string;
}

function normalizeKoumoulRecord(
  record: Record<string, unknown>,
  searchLat: number,
  searchLon: number,
  ds: DatasetConfig,
): NormalizedWithMeta | null {
  const geopoint = parseGeopoint(record._geopoint);
  const latFallback = toNullableNumber(readFirstDefined(record, ["latitude", "lat"]));
  const lonFallback = toNullableNumber(readFirstDefined(record, ["longitude", "lon", "lng"]));
  const lat = geopoint ? geopoint.lat : latFallback;
  const lon = geopoint ? geopoint.lon : lonFallback;

  if (lat === null || lon === null) return null;

  const distanceKm = haversineDistanceKm(searchLat, searchLon, lat, lon);

  const commune = readCommuneName(record);
  const communeCodeInsee = readCommuneCodeInsee(record);
  const codePostal = readCodePostal(record);

  const dateRaw = readFirstDefined(record, [
    "DATE_REELLE_AUTORISATION",
    "DR_DEPOT",
    "DPC_AUT",
    "DPC_DERN",
  ]);

  let dateDepot: string | null = null;
  if (typeof dateRaw === "string") {
    if (/^\d{4}-\d{2}$/.test(dateRaw.trim())) {
      dateDepot = formatDateSafe(`${dateRaw.trim()}-01`);
    } else {
      dateDepot = formatDateSafe(dateRaw);
    }
  }

  if (!dateDepot) {
    const annee = toNullableNumber(
      readFirstDefined(record, ["AN_DEPOT", "ANNEE_DEPOT_DAU"]),
    );
    if (annee !== null && annee >= 2013 && annee <= 2100) {
      dateDepot = formatDateSafe(`${Math.trunc(annee)}-07-01`);
    }
  }

  // Type d'autorisation :
  //   - Si le dataset force un type (sitadel-pa → "PA", sitadel-pd → "PD"),
  //     on l'utilise directement.
  //   - Sinon (sitadel-logements), on détecte via Type_DAU / label / préfixe.
  let typeAutorisation: string | null = ds.impliedType;

  if (!typeAutorisation) {
    const typeDau = sanitizeString(
      readFirstDefined(record, ["TYPE_DAU", "CIBLE_DAU", "DAU", "categorie_dau"]),
    );

    const typeDauLabel = sanitizeString(
      readFirstDefined(record, ["type_dau_label"]),
    );

    if (typeDau) {
      const up = typeDau.toUpperCase();
      if (up === "PC" || up === "DP" || up === "PA" || up === "PD") {
        typeAutorisation = up;
      }
    }

    if (!typeAutorisation && typeDauLabel) {
      const low = stripAccents(typeDauLabel);
      if (low.includes("permis de construire")) typeAutorisation = "PC";
      else if (low.includes("declaration prealable")) typeAutorisation = "DP";
      else if (low.includes("permis d'amenager") || low.includes("permis damenager")) typeAutorisation = "PA";
      else if (low.includes("permis de demolir")) typeAutorisation = "PD";
    }

    if (!typeAutorisation) {
      const numeroDauEarly = sanitizeString(
        readFirstDefined(record, ["NUM_DAU", "TYPE_NUMERO_DAU"]),
      );
      if (numeroDauEarly) {
        const prefix = numeroDauEarly.trim().slice(0, 2).toUpperCase();
        if (prefix === "PC" || prefix === "DP" || prefix === "PA" || prefix === "PD") {
          typeAutorisation = prefix;
        }
      }
    }
  }

  const natureProjet = mapNatureProjet(
    readFirstDefined(record, [
      "NATURE_PROJET_DECLAREE",
      "NATURE_PROJET_COMPLETEE",
      "NATURE_PROJET",
    ]),
  );

  const typologie = inferTypologieFromSitadel(record);

  const nombreLogements = toNullableNumber(
    readFirstDefined(record, ["NB_LGT_TOT_CREES", "NB_LOG_TOT_CREES"]),
  );

  let surface = toNullableNumber(
    readFirstDefined(record, [
      "SURF_HAB_CREEE",
      "SURF_HAB_ISSUE_TRANSFO",
      "surf_hab_projet",
      "S_HAB_CREEE",
    ]),
  );

  if (surface === null) {
    surface = toNullableNumber(
      readFirstDefined(record, ["SUPERFICIE_TERRAIN"]),
    );
  }

  const statut = mapEtatDau(
    readFirstDefined(record, ["ETAT_DAU", "etat_avancement_projet"]),
  );

  const adresse = buildAdresse(record);
  const numeroDau = sanitizeString(
    readFirstDefined(record, ["NUM_DAU", "TYPE_NUMERO_DAU"]),
  );
  const referenceDossier = numeroDau;

  const rawId = sanitizeString(record._id) ?? referenceDossier;

  // Déduplication multi-datasets : on préfixe par datasetId pour éviter les
  // collisions d'IDs numériques identiques entre datasets.
  const id = rawId
    ? `${ds.id}:${rawId}`
    : `${ds.id}:${communeCodeInsee ?? "NA"}-${lat}-${lon}-${dateDepot ?? "NA"}`;

  return {
    item: {
      id,
      distanceKm,
      commune,
      codePostal,
      dateDepot,
      typeAutorisation,
      natureProjet,
      typologie,
      nombreLogements,
      surface,
      statut,
      adresse,
      referenceDossier,
      latitude: lat,
      longitude: lon,
      source: ds.id,
      raw: record,
    },
    communeCodeInsee,
    codePostal,
    datasetId: ds.id,
  };
}

function extractInseeCodes(commune: string | null): string[] {
  if (!commune) return [];
  const parts = commune
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^\d{5}$/.test(x));

  const segs = commune.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length === segs.length && parts.length > 0) return parts;
  return [];
}

function resolveNextCursor(raw: unknown, baseEndpoint: string): string | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.trim();
  if (!candidate) return null;
  try {
    return new URL(candidate).toString();
  } catch {
    try {
      return new URL(candidate, baseEndpoint).toString();
    } catch {
      return null;
    }
  }
}

async function fetchPermitsFromDataset(
  ds: DatasetConfig,
  params: ValidatedSearchParams,
  serverInseeCodes: string[],
): Promise<KoumoulFetchResult> {
  const allRecords: unknown[] = [];
  const seenIds = new Set<string>();
  let totalReported: number | null = null;
  let reachedCap = false;
  let previousCount = 0;
  let totalReceivedFromSource = 0;
  let nextUrl: string | null = null;

  const initialUrl = new URL(ds.endpoint);
  initialUrl.searchParams.set(
    "geo_distance",
    `${params.longitude},${params.latitude},${Math.round(params.radiusKm * 1000)}`,
  );
  initialUrl.searchParams.set("size", String(KOUMOUL_PAGE_SIZE));
  initialUrl.searchParams.set("format", "json");

  if (serverInseeCodes.length > 0) {
    const quoted = serverInseeCodes.map((c) => `"${c}"`).join(" OR ");
    initialUrl.searchParams.set(
      "qs",
      `COMM:(${quoted}) OR code_commune_insee:(${quoted})`,
    );
  }

  for (let page = 0; page < KOUMOUL_MAX_PAGES; page++) {
    const currentUrl = page === 0 ? initialUrl.toString() : nextUrl;
    if (!currentUrl) break;

    console.log("[MMZ][PermisConstruire][HTTP]", {
      dataset: ds.id,
      page,
      mode: page === 0 ? "initial" : "cursor",
    });

    let resp: Response;
    try {
      resp = await fetch(currentUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      throw new Error(
        `[${ds.id}] Appel à Koumoul impossible (réseau) : ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("[MMZ][PermisConstruire][KOUMOUL_ERROR]", {
        dataset: ds.id,
        status: resp.status,
        statusText: resp.statusText,
        body: text,
      });
      throw new Error(
        `[${ds.id}] Koumoul a renvoyé ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`,
      );
    }

    let payload: KoumoulLinesResponse;
    try {
      payload = (await resp.json()) as KoumoulLinesResponse;
    } catch (error) {
      throw new Error(
        `[${ds.id}] Réponse Koumoul non JSON : ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!payload || !Array.isArray(payload.results)) {
      throw new Error(`[${ds.id}] Format de réponse inattendu (pas de tableau 'results').`);
    }

    if (page === 0 && typeof payload.total === "number" && Number.isFinite(payload.total)) {
      totalReported = payload.total;
    }

    totalReceivedFromSource += payload.results.length;

    for (const r of payload.results) {
      if (!r || typeof r !== "object") continue;

      const rec = r as Record<string, unknown>;
      const id = rec._id ?? rec.NUM_DAU ?? rec.num_dau ?? null;

      if (id && seenIds.has(String(id))) continue;
      if (id) seenIds.add(String(id));

      allRecords.push(r);
    }

    nextUrl = resolveNextCursor(payload.next, ds.endpoint);

    if (!nextUrl) break;
    if (payload.results.length < KOUMOUL_PAGE_SIZE) break;
    if (allRecords.length === previousCount) break;
    previousCount = allRecords.length;
    if (allRecords.length >= KOUMOUL_HARD_CAP) break;
  }

  if (
    totalReported !== null &&
    totalReported > KOUMOUL_HARD_CAP &&
    allRecords.length >= KOUMOUL_HARD_CAP
  ) {
    reachedCap = true;
  }

  const duplicatesRemoved = Math.max(
    0,
    totalReceivedFromSource - allRecords.length,
  );

  return {
    records: allRecords,
    totalReported,
    reachedCap,
    duplicatesRemoved,
    totalReceivedFromSource,
  };
}

/**
 * Interroge tous les datasets en parallèle (Promise.allSettled).
 * Un échec partiel n'empêche pas les autres datasets de renvoyer.
 */
async function fetchAllDatasets(
  datasets: DatasetConfig[],
  params: ValidatedSearchParams,
  serverInseeCodes: string[],
): Promise<DatasetFetchResult[]> {
  const settled = await Promise.allSettled(
    datasets.map((ds) =>
      fetchPermitsFromDataset(ds, params, serverInseeCodes).then((r) => ({
        ds,
        result: r,
      })),
    ),
  );

  return settled.map((s, i) => {
    const ds = datasets[i];
    if (s.status === "fulfilled") {
      return {
        ...s.value.result,
        datasetId: ds.id,
        datasetLabel: ds.label,
        impliedType: ds.impliedType,
        ok: true,
      };
    }
    const reason = s.reason;
    const msg =
      reason instanceof Error ? reason.message : String(reason ?? "inconnue");
    console.error("[MMZ][PermisConstruire][DATASET_ERROR]", {
      dataset: ds.id,
      error: msg,
    });
    return {
      datasetId: ds.id,
      datasetLabel: ds.label,
      impliedType: ds.impliedType,
      ok: false,
      errorMessage: msg,
      records: [],
      totalReported: null,
      reachedCap: false,
      duplicatesRemoved: 0,
      totalReceivedFromSource: 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Filtrage / tri / déduplication
// ---------------------------------------------------------------------------

function communeMatches(meta: NormalizedWithMeta, query: string): boolean {
  const q = query.trim();
  if (!q) return true;

  const codeList = q
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^\d{5}$/.test(x));
  const segs = q.split(",").map((x) => x.trim()).filter(Boolean);

  if (codeList.length > 0 && codeList.length === segs.length) {
    const insee = meta.communeCodeInsee;
    if (insee && codeList.includes(insee)) return true;
    return false;
  }

  const name = meta.item.commune;
  if (!name) return false;
  return stripAccents(name).includes(stripAccents(q));
}

interface FilterCounters {
  start: number;
  keptAfterDistance: number;
  keptAfterType: number;
  keptAfterTypologie: number;
  keptAfterCommune: number;
  keptAfterPeriod: number;
  keptAfterLogements: number;
  keptAfterSurface: number;
}

function filterPermits(
  metas: NormalizedWithMeta[],
  params: ValidatedSearchParams,
): { kept: NormalizedWithMeta[]; counters: FilterCounters } {
  const counters: FilterCounters = {
    start: metas.length,
    keptAfterDistance: 0,
    keptAfterType: 0,
    keptAfterTypologie: 0,
    keptAfterCommune: 0,
    keptAfterPeriod: 0,
    keptAfterLogements: 0,
    keptAfterSurface: 0,
  };

  const minAllowedDate = monthsAgo(params.periodMonths);
  const kept: NormalizedWithMeta[] = [];
  const typeFilter = params.typeAutorisationFilter;

  for (const meta of metas) {
    const it = meta.item;

    if (
      it.distanceKm === null ||
      !Number.isFinite(it.distanceKm) ||
      it.distanceKm > params.radiusKm
    ) {
      continue;
    }
    counters.keptAfterDistance++;

    // Filtre strict sur le type : un record sans type détecté est exclu.
    if (typeFilter !== "all") {
      if (!it.typeAutorisation) continue;
      const up = it.typeAutorisation.trim().toUpperCase() as TypeAutorisation;
      if (!typeFilter.has(up)) continue;
    }
    counters.keptAfterType++;

    if (params.typologie !== "all") {
      const t = (it.typologie ?? "").trim().toLowerCase();

      if (params.typologie === "logement") {
        if (!t || !["logement", "individuel", "collectif", "mixte"].includes(t)) {
          continue;
        }
      } else if (params.typologie === "activite") {
        if (t !== "activite") continue;
      } else {
        if (t !== params.typologie) continue;
      }
    }
    counters.keptAfterTypologie++;

    if (params.commune && !communeMatches(meta, params.commune)) continue;
    counters.keptAfterCommune++;

    const itemDate = parseIsoDateSafe(it.dateDepot);
    if (!itemDate || itemDate < minAllowedDate) continue;
    counters.keptAfterPeriod++;

    if (
      params.logementsMin !== null &&
      it.nombreLogements !== null &&
      it.nombreLogements < params.logementsMin
    ) {
      continue;
    }
    if (
      params.logementsMax !== null &&
      it.nombreLogements !== null &&
      it.nombreLogements > params.logementsMax
    ) {
      continue;
    }
    counters.keptAfterLogements++;

    if (
      params.surfaceMin !== null &&
      it.surface !== null &&
      it.surface < params.surfaceMin
    ) {
      continue;
    }
    if (
      params.surfaceMax !== null &&
      it.surface !== null &&
      it.surface > params.surfaceMax
    ) {
      continue;
    }
    counters.keptAfterSurface++;

    kept.push(meta);
  }

  return { kept, counters };
}

function compareNullableNumbers(
  a: number | null,
  b: number | null,
  order: SortOrder,
): number {
  const mult = order === "asc" ? 1 : -1;
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 * mult : a > b ? 1 * mult : 0;
}

function compareNullableDates(
  a: string | null,
  b: string | null,
  order: SortOrder,
): number {
  const da = parseIsoDateSafe(a);
  const db = parseIsoDateSafe(b);
  const mult = order === "asc" ? 1 : -1;
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  const ta = da.getTime();
  const tb = db.getTime();
  return ta < tb ? -1 * mult : ta > tb ? 1 * mult : 0;
}

function sortItems(
  items: PermisConstruireItem[],
  sortBy: SortBy,
  sortOrder: SortOrder,
): PermisConstruireItem[] {
  const next = [...items];
  next.sort((a, b) => {
    let result = 0;
    switch (sortBy) {
      case "distance":
        result = compareNullableNumbers(a.distanceKm, b.distanceKm, sortOrder);
        break;
      case "date":
        result = compareNullableDates(a.dateDepot, b.dateDepot, sortOrder);
        break;
      case "logements":
        result = compareNullableNumbers(a.nombreLogements, b.nombreLogements, sortOrder);
        break;
      case "surface":
        result = compareNullableNumbers(a.surface, b.surface, sortOrder);
        break;
      default:
        result = 0;
    }
    if (result !== 0) return result;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
  return next;
}

function dedupeItems(items: PermisConstruireItem[]): PermisConstruireItem[] {
  // Les IDs sont déjà préfixés par datasetId ({ds.id}:{rawId}), donc la
  // déduplication par id est suffisante pour éviter les collisions entre
  // datasets. On garde le fallback géographique pour les records sans id.
  const map = new Map<string, PermisConstruireItem>();

  for (const item of items) {
    const key =
      item.id ||
      item.referenceDossier ||
      `${item.latitude ?? "x"}-${item.longitude ?? "y"}-${item.dateDepot ?? "z"}`;

    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
}

function findFirstDropStage(counters: FilterCounters): string | null {
  const stages: { label: string; kept: number }[] = [
    { label: "distance", kept: counters.keptAfterDistance },
    { label: "type d'autorisation", kept: counters.keptAfterType },
    { label: "typologie", kept: counters.keptAfterTypologie },
    { label: "commune", kept: counters.keptAfterCommune },
    { label: "période", kept: counters.keptAfterPeriod },
    { label: "nombre de logements", kept: counters.keptAfterLogements },
    { label: "surface", kept: counters.keptAfterSurface },
  ];
  let prev = counters.start;
  for (const s of stages) {
    if (s.kept === 0 && prev > 0) return s.label;
    prev = s.kept;
  }
  return null;
}

function describeTypeFilter(filter: TypeAutorisationFilter): string {
  if (filter === "all") return "all";
  return Array.from(filter).sort().join(",");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return badRequest("Méthode non supportée. Utiliser POST.");
  }

  try {
    let body: SearchRequestBody;
    try {
      body = await req.json();
    } catch (error) {
      console.error("[MMZ][PermisConstruire][ERROR] JSON invalide", error);
      return badRequest("Le corps de la requête doit être un JSON valide.");
    }

    let params: ValidatedSearchParams;
    try {
      params = validateRequestBody(body);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Paramètres invalides.";
      console.error("[MMZ][PermisConstruire][ERROR] Validation", { message, body });
      return badRequest(message);
    }

    const datasetsToQuery = selectDatasetsForFilter(params.typeAutorisationFilter);

    console.log("[MMZ][PermisConstruire][INPUT]", {
      ...params,
      typeAutorisationFilter: describeTypeFilter(params.typeAutorisationFilter),
      datasetsToQuery: datasetsToQuery.map((d) => d.id),
    });

    if (datasetsToQuery.length === 0) {
      return jsonResponse({
        items: [],
        total: 0,
        limit: params.limit,
        offset: params.offset,
        source: "sitadel-koumoul-multi",
        fetchedAt: new Date().toISOString(),
        notices: ["Aucun dataset à interroger pour ce filtre."],
      } satisfies SearchResponse, 200);
    }

    const serverInseeCodes = extractInseeCodes(params.commune);

    // Fetch parallèle des datasets sélectionnés
    let datasetResults: DatasetFetchResult[];
    try {
      datasetResults = await fetchAllDatasets(datasetsToQuery, params, serverInseeCodes);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[MMZ][PermisConstruire][ERROR] fetchAll", detail);
      return internalError(
        "Impossible de charger les permis de construire depuis les sources Sitadel.",
        detail,
      );
    }

    // Retry sans filtre commune côté serveur si TOUS les datasets ont échoué
    // ET qu'un filtre qs serveur était appliqué (cas rare : Koumoul n'aime
    // pas la syntaxe qs sur certains datasets).
    if (
      serverInseeCodes.length > 0 &&
      datasetResults.every((r) => !r.ok)
    ) {
      console.warn("[MMZ][PermisConstruire] Retry sans filtre qs serveur");
      try {
        datasetResults = await fetchAllDatasets(datasetsToQuery, params, []);
      } catch {
        /* on garde les datasetResults initiaux (tous échoués) */
      }
    }

    // Normalisation par dataset
    const normalized: NormalizedWithMeta[] = [];
    let skippedUngeocoded = 0;
    const perDatasetStats: Record<string, {
      raw: number;
      normalized: number;
      totalReported: number | null;
      duplicatesRemoved: number;
      reachedCap: boolean;
      ok: boolean;
      errorMessage?: string;
    }> = {};

    for (const dsResult of datasetResults) {
      const ds = DATASETS.find((d) => d.id === dsResult.datasetId);
      if (!ds) continue;

      let normalizedCount = 0;
      for (const r of dsResult.records) {
        if (!r || typeof r !== "object") continue;
        const meta = normalizeKoumoulRecord(
          r as Record<string, unknown>,
          params.latitude,
          params.longitude,
          ds,
        );
        if (meta === null) {
          skippedUngeocoded++;
          continue;
        }
        normalized.push(meta);
        normalizedCount++;
      }

      perDatasetStats[dsResult.datasetId] = {
        raw: dsResult.records.length,
        normalized: normalizedCount,
        totalReported: dsResult.totalReported,
        duplicatesRemoved: dsResult.duplicatesRemoved,
        reachedCap: dsResult.reachedCap,
        ok: dsResult.ok,
        errorMessage: dsResult.errorMessage,
      };

      // Log schema d'un échantillon par dataset (utile pour debug)
      if (dsResult.records.length > 0 && dsResult.records[0] && typeof dsResult.records[0] === "object") {
        const firstKeys = Object.keys(dsResult.records[0] as Record<string, unknown>);
        console.log("[MMZ][PermisConstruire][SCHEMA]", {
          dataset: dsResult.datasetId,
          firstKeys,
        });
      }
    }

    // Distribution des types d'autorisation détectés
    const typeDistribution: Record<string, number> = {};
    for (const m of normalized) {
      const t = m.item.typeAutorisation ?? "INCONNU";
      typeDistribution[t] = (typeDistribution[t] ?? 0) + 1;
    }

    const { kept: filtered, counters } = filterPermits(normalized, params);

    const items = filtered.map((m) => m.item);
    const deduped = dedupeItems(items);
    const sorted = sortItems(deduped, params.sortBy, params.sortOrder);
    const paginated = sorted.slice(params.offset, params.offset + params.limit);

    const statsMissing = {
      communeInsee: normalized.filter((m) => !m.communeCodeInsee).length,
      codePostal: normalized.filter((m) => !m.codePostal).length,
      communeName: normalized.filter((m) => !m.item.commune).length,
      date: normalized.filter((m) => !m.item.dateDepot).length,
      typologie: normalized.filter((m) => !m.item.typologie).length,
      statut: normalized.filter((m) => !m.item.statut).length,
      adresse: normalized.filter((m) => !m.item.adresse).length,
      typeAutorisation: normalized.filter((m) => !m.item.typeAutorisation).length,
    };

    console.log("[MMZ][PermisConstruire][FILTER]", {
      datasetsQueried: datasetsToQuery.map((d) => d.id),
      perDatasetStats,
      skippedUngeocoded,
      normalized: normalized.length,
      filtered: filtered.length,
      deduped: deduped.length,
      counters,
      statsMissing,
      typeDistribution,
      serverInseeCodes,
      radiusKm: params.radiusKm,
      periodMonths: params.periodMonths,
      typologie: params.typologie,
      typeAutorisationFilter: describeTypeFilter(params.typeAutorisationFilter),
      commune: params.commune,
    });

    // ---- Notices ----
    const notices: string[] = [];

    if (serverInseeCodes.length > 0) {
      notices.push(
        serverInseeCodes.length === 1
          ? `Filtre commune côté serveur appliqué (INSEE ${serverInseeCodes[0]}).`
          : `Filtre commune côté serveur appliqué (${serverInseeCodes.length} codes INSEE).`,
      );
    }

    // Récapitulatif par dataset (succès / échec / volumétrie)
    const datasetSummaryParts: string[] = [];
    for (const dsResult of datasetResults) {
      const ds = DATASETS.find((d) => d.id === dsResult.datasetId);
      if (!ds) continue;
      if (!dsResult.ok) {
        notices.push(
          `Dataset ${ds.label} indisponible : ${dsResult.errorMessage ?? "erreur inconnue"}.`,
        );
        continue;
      }
      if (dsResult.totalReported !== null) {
        datasetSummaryParts.push(
          `${ds.label} : ${dsResult.totalReported}`,
        );
      }
    }
    if (datasetSummaryParts.length > 0) {
      notices.push(
        `Sources interrogées — ${datasetSummaryParts.join(" · ")} enregistrement(s) dans ce rayon.`,
      );
    }

    // Plafonds atteints
    for (const dsResult of datasetResults) {
      if (
        dsResult.reachedCap &&
        dsResult.totalReported !== null &&
        dsResult.totalReported > KOUMOUL_HARD_CAP
      ) {
        const ds = DATASETS.find((d) => d.id === dsResult.datasetId);
        notices.push(
          `[${ds?.label ?? dsResult.datasetId}] Plafond de ${KOUMOUL_HARD_CAP} enregistrements atteint. Total estimé : ${dsResult.totalReported}. Réduisez le rayon.`,
        );
      }
    }

    if (statsMissing.typeAutorisation > 0) {
      notices.push(
        `${statsMissing.typeAutorisation} enregistrement(s) sans type d'autorisation détectable (champ Type_DAU absent).`,
      );
    }

    if (skippedUngeocoded > 0) {
      notices.push(
        `${skippedUngeocoded} autorisations ignorées car non géocodées par la source Sitadel.`,
      );
    }

    if (params.typologie === "activite") {
      notices.push(
        "Le dataset Sitadel-logements couvre principalement les opérations de logements ; les projets d'activité peuvent être absents.",
      );
    }

    if (items.length !== deduped.length) {
      notices.push(
        `${items.length - deduped.length} doublons supprimés avant pagination.`,
      );
    }

    if (normalized.length > 0 && filtered.length === 0) {
      const firstDrop = findFirstDropStage(counters);
      if (firstDrop) {
        notices.push(
          `Aucun résultat : ${normalized.length} enregistrements trouvés dans le rayon, tous écartés à l'étape « ${firstDrop} ».`,
        );
      }
    } else if (normalized.length === 0 && datasetResults.some((r) => r.records.length > 0)) {
      notices.push(
        "Les sources ont renvoyé des enregistrements, mais aucun n'était exploitable après normalisation.",
      );
    }

    const response: SearchResponse = {
      items: paginated,
      total: sorted.length,
      limit: params.limit,
      offset: params.offset,
      source: "sitadel-koumoul-multi",
      fetchedAt: new Date().toISOString(),
      notices: notices.length > 0 ? notices : undefined,
      debug: {
        counters,
        statsMissing,
        typeDistribution,
        datasetsQueried: datasetsToQuery.map((d) => d.id),
        perDatasetStats,
        normalized: normalized.length,
        filtered: filtered.length,
        deduped: deduped.length,
        serverInseeCodes,
        typeAutorisationFilter: describeTypeFilter(params.typeAutorisationFilter),
      },
    };

    console.log("[MMZ][PermisConstruire][RESULT]", {
      total: response.total,
      returned: response.items.length,
      limit: response.limit,
      offset: response.offset,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
    });

    return jsonResponse(response, 200);
  } catch (error) {
    console.error("[MMZ][PermisConstruire][ERROR] Unhandled", error);
    return internalError("Erreur interne lors de la recherche des permis.");
  }
});