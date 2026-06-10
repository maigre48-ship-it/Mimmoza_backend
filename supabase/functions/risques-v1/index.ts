import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

type Niveau = "faible" | "modere" | "eleve" | "tres_eleve";

type RisquesOutput = {
  score_global: number;
  niveau_risque: Niveau;

  // ✅ AJOUT: commune (geo.api.gouv.fr renvoie déjà nom + code)
  commune?: {
    insee?: string;
    nom?: string;
    code_postal?: string;
  };

  risques: Array<{
    categorie: "Naturel" | "Technologique";
    nom: string;
    niveau: Niveau;
    description?: string;
    source?: string;
  }>;
  zonages: {
    pprn?: boolean;
    pprt?: boolean;
    zone_inondable?: boolean;
    zone_sismique?: number; // 1..5
    radon?: number; // 1..3
    cavites?: boolean;
    argiles?: "faible" | "moyen" | "fort";
  };
  environnement: {
    sites_pollues?: number;
    icpe?: number;
    seveso?: boolean;
    distance_seveso_km?: number;
  };
  coverage: Record<string, "ok" | "missing" | "error">;
};

type Payload = {
  parcel_id?: string;
  commune_insee?: string;
  radius_m?: number;
  ttl_seconds?: number;
  force_refresh?: boolean;
};

const supabaseUrl =
  Deno.env.get("SUPABASE_URL") ?? Deno.env.get("REST_URL") ?? "";
const serviceKey =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

const supabase =
  supabaseUrl && serviceKey
    ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
    : null;

// Cache mémoire best-effort
const memCache = new Map<string, { expires: number; payload: any }>();

function nowMs() {
  return Date.now();
}

function memGet(key: string) {
  const it = memCache.get(key);
  if (!it) return null;
  if (it.expires <= nowMs()) {
    memCache.delete(key);
    return null;
  }
  return it.payload;
}

function memSet(key: string, payload: any, ttlSec: number) {
  memCache.set(key, { payload, expires: nowMs() + ttlSec * 1000 });
}

function niveauFromScore(score: number): Niveau {
  if (score >= 80) return "faible";
  if (score >= 60) return "modere";
  if (score >= 35) return "eleve";
  return "tres_eleve";
}

function computeScore(
  z: RisquesOutput["zonages"],
  e: RisquesOutput["environnement"],
) {
  let penalty = 0;

  if (z.pprt) penalty += 25;
  if (z.pprn) penalty += 15;
  if (z.zone_inondable) penalty += 18;
  if (z.cavites) penalty += 10;

  if (typeof z.zone_sismique === "number") {
    penalty += Math.max(0, z.zone_sismique - 1) * 3;
  }
  if (typeof z.radon === "number") {
    penalty += z.radon === 3 ? 10 : z.radon === 2 ? 5 : 0;
  }

  if (z.argiles === "fort") penalty += 12;
  else if (z.argiles === "moyen") penalty += 6;

  const icpe = e.icpe ?? 0;
  penalty += Math.min(12, icpe * 2);

  if (e.seveso) penalty += 20;

  const sp = e.sites_pollues ?? 0;
  penalty += Math.min(12, sp * 3);

  return Math.max(0, Math.min(100, 100 - penalty));
}

async function cacheGet(key: string) {
  const m = memGet(key);
  if (m) return m;

  if (!supabase) return null;
  const { data, error } = await supabase.rpc("api_cache_get", { p_key: key });
  if (!error && data) return data;
  return null;
}

async function cacheSet(key: string, payload: any, ttlSec: number) {
  memSet(key, payload, Math.min(ttlSec, 3600));
  if (!supabase) return;
  await supabase.rpc("api_cache_upsert", {
    p_key: key,
    p_payload: payload,
    p_ttl_seconds: ttlSec,
  });
}

// ---------------------------------------------------------------------------
// ✅ Verrouillage mapping RGA: extraction robuste + mapping déterministe
// ---------------------------------------------------------------------------
function normalizeFr(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function coalesceString(...vals: any[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Retourne:
 * - argiles: "faible|moyen|fort" (pour zonages)
 * - niveau: "faible|modere|eleve|tres_eleve" (pour item risques)
 */
function mapRgaToArgilesAndNiveau(rgaRaw: any): {
  argiles?: "faible" | "moyen" | "fort";
  niveau?: Niveau;
  raw_label?: string;
} {
  if (!rgaRaw) return {};

  const candidate = coalesceString(
    rgaRaw?.alea,
    rgaRaw?.niveau,
    rgaRaw?.classe,
    rgaRaw?.niveau_alea,
    rgaRaw?.niveauAlea,
    rgaRaw?.niveau_risque,
    rgaRaw?.data?.alea,
    rgaRaw?.data?.niveau,
    rgaRaw?.data?.classe,
    rgaRaw?.properties?.alea,
    rgaRaw?.properties?.niveau,
    rgaRaw?.properties?.classe,
    rgaRaw?.data?.[0]?.alea,
    rgaRaw?.data?.[0]?.niveau,
    rgaRaw?.data?.[0]?.classe,
    rgaRaw?.features?.[0]?.properties?.alea,
    rgaRaw?.features?.[0]?.properties?.niveau,
    rgaRaw?.features?.[0]?.properties?.classe,
  );

  if (!candidate) return {};

  const n = normalizeFr(candidate);
  if (n.includes("tres") && (n.includes("fort") || n.includes("eleve"))) {
    return { argiles: "fort", niveau: "tres_eleve", raw_label: candidate };
  }
  if (n.includes("fort") || n.includes("eleve")) {
    return { argiles: "fort", niveau: "eleve", raw_label: candidate };
  }
  if (n.includes("moyen") || n.includes("modere") || n.includes("moder")) {
    return { argiles: "moyen", niveau: "modere", raw_label: candidate };
  }
  if (n.includes("faible")) {
    return { argiles: "faible", niveau: "faible", raw_label: candidate };
  }

  return { argiles: undefined, niveau: "modere", raw_label: candidate };
}

// ---------------------------------------------------------------------------
// Geocode commune via geo.api.gouv.fr (robuste par code INSEE)
// ---------------------------------------------------------------------------
async function geocodeCommuneViaGeoApiGouv(
  commune_insee: string,
): Promise<
  | { ok: true; lat: number; lon: number; commune: { insee: string; nom?: string }; debug: any }
  | { ok: false; debug: any }
> {
  const debug: any = { kind: "geo.api.gouv.fr" };

  const url =
    `https://geo.api.gouv.fr/communes/${encodeURIComponent(commune_insee)}?fields=centre,nom,code,codesPostaux`;

  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    debug.http = r.status;
    return { ok: false, debug };
  }

  const j = await r.json().catch(() => null);

  const coords = j?.centre?.coordinates;
  if (Array.isArray(coords) && coords.length === 2) {
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return {
        ok: true,
        lat,
        lon,
        commune: { insee: String(j?.code ?? commune_insee), nom: j?.nom },
        debug,
      };
    }
  }

  return { ok: false, debug };
}

// ---------------------------------------------------------------------------
// BAN fallback (si geo.api.gouv.fr ne renvoie pas centre)
// ---------------------------------------------------------------------------
async function geocodeCommuneViaBAN(
  commune_insee: string,
): Promise<
  | { ok: true; lat: number; lon: number; debug: any }
  | { ok: false; debug: any }
> {
  const debug: any = { kind: "BAN" };

  const tryBan = async (q: string) => {
    const url =
      `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1&citycode=${encodeURIComponent(commune_insee)}`;

    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) {
      return null;
    }
    const j = await r.json().catch(() => null);
    const coords = j?.features?.[0]?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length === 2) {
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return { lat, lon };
      }
    }
    return null;
  };

  const candidates = [
    "mairie",
    "hotel de ville",
    "centre ville",
    "place de la mairie",
  ];

  for (const q of candidates) {
    const found = await tryBan(q);
    if (found) return { ok: true, ...found, debug };
  }

  return { ok: false, debug };
}

// ---------------------------------------------------------------------------
// Résolution point (parcelle -> RPC, commune -> geo.api.gouv.fr, puis BAN)
// ---------------------------------------------------------------------------
async function resolvePointWithDebug(payload: Payload): Promise<
  | {
    ok: true;
    lat: number;
    lon: number;
    source: "parcel" | "commune";
    commune?: { insee?: string; nom?: string; code_postal?: string };
    debug: any;
  }
  | { ok: false; debug: any }
> {
  const debug: any = {
    input: {
      parcel_id: payload.parcel_id ?? null,
      commune_insee: payload.commune_insee ?? null,
    },
    steps: [],
  };

  // 1) Parcelle via RPC
  if (payload.parcel_id) {
    if (!supabase) {
      debug.steps.push({
        step: "rpc_get_parcelle_centroid",
        ok: false,
        error: "SUPABASE_CLIENT_UNAVAILABLE",
      });
    } else {
      try {
        const { data, error } = await supabase.rpc("get_parcelle_centroid", {
          p_parcel_id: payload.parcel_id,
          p_commune_insee: payload.commune_insee ?? null,
        });

        debug.steps.push({
          step: "rpc_get_parcelle_centroid",
          ok: !error && Number.isFinite(Number(data?.lat)) && Number.isFinite(Number(data?.lon)),
          error: error?.message ?? null,
        });

        if (
          !error &&
          Number.isFinite(Number(data?.lat)) &&
          Number.isFinite(Number(data?.lon))
        ) {
          return {
            ok: true,
            lat: Number(data.lat),
            lon: Number(data.lon),
            source: "parcel",
            commune: payload.commune_insee ? { insee: payload.commune_insee } : undefined,
            debug,
          };
        }
      } catch (e) {
        debug.steps.push({
          step: "rpc_get_parcelle_centroid",
          ok: false,
          error: String((e as any)?.message ?? e),
        });
      }
    }
  }

  // 2) Commune via geo.api.gouv.fr (prioritaire)
  if (payload.commune_insee) {
    try {
      const g = await geocodeCommuneViaGeoApiGouv(payload.commune_insee);
      debug.steps.push({
        step: "geo_api_gouv_commune",
        ok: g.ok,
      });

      if (g.ok) {
        return {
          ok: true,
          lat: g.lat,
          lon: g.lon,
          source: "commune",
          commune: {
            insee: g.commune.insee,
            nom: g.commune.nom,
          },
          debug,
        };
      }
    } catch (e) {
      debug.steps.push({
        step: "geo_api_gouv_commune",
        ok: false,
        error: String((e as any)?.message ?? e),
      });
    }

    // 3) BAN fallback
    try {
      const b = await geocodeCommuneViaBAN(payload.commune_insee);
      debug.steps.push({
        step: "ban_geocode",
        ok: b.ok,
      });

      if (b.ok) {
        return {
          ok: true,
          lat: b.lat,
          lon: b.lon,
          source: "commune",
          commune: { insee: payload.commune_insee },
          debug,
        };
      }
    } catch (e) {
      debug.steps.push({
        step: "ban_geocode",
        ok: false,
        error: String((e as any)?.message ?? e),
      });
    }
  }

  return { ok: false, debug };
}

// ---------------------------------------------------------------------------
// ✅ Fetch robuste JSON (gère body vide / non-JSON / tronqué)
// ---------------------------------------------------------------------------
async function fetchJson(url: string, retries = 2): Promise<any> {
  let lastErr: any = null;

  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });

      const text = await r.text().catch(() => "");

      if (!r.ok) {
        throw new Error(`HTTP ${r.status} ${r.statusText} ${text}`.trim());
      }

      const trimmed = (text || "").trim();
      if (!trimmed) {
        throw new Error("EMPTY_BODY");
      }

      if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
        const snippet = trimmed.slice(0, 180).replace(/\s+/g, " ");
        throw new Error(`NON_JSON_BODY: ${snippet}`);
      }

      try {
        return JSON.parse(trimmed);
      } catch (e) {
        throw new Error(`JSON_PARSE_ERROR: ${String((e as any)?.message ?? e)}`);
      }
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await new Promise((res) => setTimeout(res, i === 0 ? 250 : 700));
      }
    }
  }

  throw lastErr;
}

function buildV1Endpoints(input: {
  lat: number;
  lon: number;
  commune_insee?: string;
  radius_m: number;
}) {
  const { lat, lon, commune_insee, radius_m } = input;
  const latlon = `${lon},${lat}`;

  return {
    radon: commune_insee
      ? `https://georisques.gouv.fr/api/v1/radon?code_insee=${commune_insee}`
      : `https://georisques.gouv.fr/api/v1/radon?latlon=${latlon}`,

    zonage_sismique:
      `https://georisques.gouv.fr/api/v1/zonage_sismique?latlon=${latlon}`,

    // ✅ RGA: candidates (latlon + code_insee fallback)
    rga_candidates: [
      `https://georisques.gouv.fr/api/v1/rga?latlon=${latlon}`,
      ...(commune_insee ? [`https://georisques.gouv.fr/api/v1/rga?code_insee=${commune_insee}`] : []),
    ],

    cavites:
      `https://georisques.gouv.fr/api/v1/cavites?latlon=${latlon}&rayon=${radius_m}`,

    ppr: commune_insee
      ? `https://georisques.gouv.fr/api/v1/ppr?code_insee=${commune_insee}`
      : `https://georisques.gouv.fr/api/v1/ppr?latlon=${latlon}`,

    icpe:
      `https://georisques.gouv.fr/api/v1/installations_classees?latlon=${latlon}&rayon=${radius_m}`,

    // ⚠️ SIS: endpoint v1 non exposé sous /sis dans ton cas (404).
    sis_candidates: [
      `https://georisques.gouv.fr/api/v1/sis?latlon=${latlon}&rayon=${radius_m}`,
      `https://georisques.gouv.fr/api/v1/infosols?latlon=${latlon}&rayon=${radius_m}`,
      `https://georisques.gouv.fr/api/v1/sites_sols_pollues?latlon=${latlon}&rayon=${radius_m}`,
    ],
  } as const;
}

// Mappers permissifs (MVP)
function mapRadon(json: any): number | undefined {
  const v = Number(json?.categorie ?? json?.classe ?? json?.radon ?? NaN);
  return Number.isFinite(v) ? v : undefined;
}
function mapSismique(json: any): number | undefined {
  const v = Number(json?.zone ?? json?.niveau ?? json?.zonage ?? NaN);
  return Number.isFinite(v) ? v : undefined;
}

function mapCount(json: any): number {
  if (!json) return 0;
  if (Array.isArray(json)) return json.length;
  if (Array.isArray(json?.data)) return json.data.length;
  if (Array.isArray(json?.features)) return json.features.length;
  const n = Number(json?.count ?? json?.total ?? json?.nombre ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ✅ PPR mapping plus robuste (liste-aware)
function mapPprFlags(json: any): { pprn?: boolean; pprt?: boolean; inond?: boolean } {
  if (!json) return { pprn: false, pprt: false, inond: false };

  const arr =
    Array.isArray(json) ? json
      : Array.isArray(json?.data) ? json.data
      : Array.isArray(json?.features) ? json.features
      : null;

  if (!arr) {
    const pprn = Boolean(json?.pprn ?? json?.has_pprn ?? false);
    const pprt = Boolean(json?.pprt ?? json?.has_pprt ?? false);
    const inond = Boolean(json?.inondation ?? json?.zone_inondable ?? false);
    return { pprn, pprt, inond };
  }

  const hasAny = arr.length > 0;
  const text = JSON.stringify(arr).toLowerCase();

  const pprt = hasAny && (text.includes("pprt") || text.includes("technologique"));
  const inond =
    hasAny &&
    (text.includes("inond") || text.includes("inondation") || text.includes("submersion"));
  const pprn = hasAny && !pprt;

  return { pprn, pprt, inond };
}

// ---------------------------------------------------------------------------
// ✅ Couverture "missing" vs "error"
// - missing: EMPTY_BODY, NON_JSON_BODY, HTTP 404, ou HTTP 500 paramètres manquants (cas RGA)
// - error: le reste (timeouts, 429, 500 inconnus, etc.)
// ---------------------------------------------------------------------------
function isCoverageMissing(errMsg: string): boolean {
  const m = (errMsg || "").toLowerCase();
  if (m === "empty_body") return true;
  if (m.startsWith("non_json_body:")) return true;
  if (m.includes("http 404")) return true;
  if (m.includes("http 500") && m.includes("param") && m.includes("manquant")) return true;
  return false;
}

async function tryFetchFallback(
  key: string,
  urls: string[],
  coverage: Record<string, "ok" | "missing" | "error">,
  fetch_debug: Record<string, any>,
) {
  let sawHardError = false;

  for (const url of urls) {
    try {
      const j = await fetchJson(url, 2);
      coverage[key] = "ok";
      fetch_debug[key] = { ok: true };
      return j;
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      const missing = isCoverageMissing(msg);
      if (!missing) sawHardError = true;
    }
  }

  // Si toutes les tentatives sont "missing", on marque missing; sinon error
  coverage[key] = sawHardError ? "error" : "missing";
  fetch_debug[key] = { ok: false };
  return null;
}

// ---------------------------------------------------------------------------
// ✅ Exports (optionnel): CSV / PDF via ?export=csv|pdf
// ---------------------------------------------------------------------------
function buildRisquesCsv(o: RisquesOutput): string {
  const esc = (v: any) => `"${String(v ?? "").replaceAll('"', '""')}"`;

  const lines: string[] = [];
  lines.push(["commune_insee", "commune_nom", "niveau_global", "score_global"].join(","));
  lines.push([
    esc(o.commune?.insee ?? ""),
    esc(o.commune?.nom ?? ""),
    esc(o.niveau_risque),
    esc(o.score_global),
  ].join(","));

  lines.push("");
  lines.push(["categorie", "nom", "niveau", "source"].join(","));
  for (const r of o.risques ?? []) {
    lines.push([esc(r.categorie), esc(r.nom), esc(r.niveau), esc(r.source ?? "")].join(","));
  }

  return lines.join("\n");
}

async function buildRisquesPdf(o: RisquesOutput): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  let y = 800;
  const draw = (txt: string, size = 12) => {
    page.drawText(txt, { x: 40, y, size, font });
    y -= size + 6;
  };

  draw("Résumé des risques", 18);
  y -= 6;

  draw(`Commune : ${o.commune?.nom ?? "-"} (${o.commune?.insee ?? "-"})`, 12);
  draw(`Niveau global : ${o.niveau_risque} | Score : ${o.score_global}`, 12);

  y -= 10;
  draw("Détails :", 14);

  const items = (o.risques ?? []).slice(0, 24);
  for (const r of items) {
    draw(`• [${r.categorie}] ${r.nom} — ${r.niveau}`, 11);
  }

  y -= 10;
  draw("Zonages :", 14);
  draw(`- Argiles (RGA) : ${o.zonages?.argiles ?? "-"}`, 11);
  draw(`- Radon : ${o.zonages?.radon ?? "-"}`, 11);
  draw(`- Sismique : ${o.zonages?.zone_sismique ?? "-"}`, 11);
  draw(`- PPRN : ${o.zonages?.pprn ? "oui" : "non"} | PPRT : ${o.zonages?.pprt ? "oui" : "non"}`, 11);
  draw(
    `- Inondation : ${o.zonages?.zone_inondable ? "oui" : "non"} | Cavités : ${
      o.zonages?.cavites ? "oui" : "non"
    }`,
    11,
  );

  return await pdfDoc.save();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const urlObj = new URL(req.url);
    const exportFmt = (urlObj.searchParams.get("export") || "").toLowerCase(); // csv|pdf

    const body = (await req.json().catch(() => ({}))) as Payload;

    const parcel_id = (body.parcel_id || "").trim() || undefined;
    const commune_insee = (body.commune_insee || "").trim() || undefined;
    const radius_m = Number(body.radius_m || 1500) || 1500;

    const ttl = Number(body.ttl_seconds || 86400) || 86400;
    const force = Boolean(body.force_refresh);

    if (!parcel_id && !commune_insee) {
      return new Response(
        JSON.stringify({ success: false, error: "parcel_id ou commune_insee requis" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        },
      );
    }

    // ✅ cache versionné (évite retomber sur ancien format)
    const cacheKey = parcel_id
      ? `risques:v2:parcel:${parcel_id}:r${radius_m}`
      : `risques:v2:commune:${commune_insee}:r${radius_m}`;

    if (!force && exportFmt === "") {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return new Response(JSON.stringify({ success: true, cached: true, data: cached }), {
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        });
      }
    }

    const resolved = await resolvePointWithDebug({ parcel_id, commune_insee, radius_m });
    if (!resolved.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Impossible de résoudre lat/lon depuis parcelle/commune.",
        }),
        {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        },
      );
    }

    const pt = { lat: resolved.lat, lon: resolved.lon, source: resolved.source };

    const urls = buildV1Endpoints({ lat: pt.lat, lon: pt.lon, commune_insee, radius_m });

    const coverage: Record<string, "ok" | "missing" | "error"> = {};
    const out: RisquesOutput = {
      score_global: 0,
      niveau_risque: "modere",
      commune: resolved.commune
        ? {
          insee: resolved.commune.insee,
          nom: resolved.commune.nom,
          code_postal: resolved.commune.code_postal,
        }
        : (commune_insee ? { insee: commune_insee } : undefined),
      risques: [],
      zonages: {},
      environnement: {},
      coverage,
    };

    const fetch_debug: Record<string, any> = {};

    async function tryFetch(key: string, url: string) {
      try {
        const j = await fetchJson(url, 2);
        coverage[key] = "ok";
        fetch_debug[key] = { ok: true };
        return j;
      } catch (e) {
        const msg = String((e as any)?.message ?? e);
        coverage[key] = isCoverageMissing(msg) ? "missing" : "error";
        fetch_debug[key] = { ok: false };
        return null;
      }
    }

    const [radon, sism, cavites, ppr, icpe] = await Promise.all([
      tryFetch("radon", urls.radon),
      tryFetch("zonage_sismique", urls.zonage_sismique),
      tryFetch("cavites", urls.cavites),
      tryFetch("ppr", urls.ppr),
      tryFetch("icpe", urls.icpe),
    ]);

    // ✅ RGA via fallback candidates (latlon + code_insee)
    const rgaRaw = await tryFetchFallback("rga", [...urls.rga_candidates], coverage, fetch_debug);

    // SIS (fallback endpoints)
    const sis = await tryFetchFallback("sis", [...urls.sis_candidates], coverage, fetch_debug);

    // -----------------------
    // RADON
    // -----------------------
    const r = mapRadon(radon);
    if (typeof r === "number") {
      out.zonages.radon = r;
      out.risques.push({
        categorie: "Naturel",
        nom: "Radon",
        niveau: r === 3 ? "eleve" : r === 2 ? "modere" : "faible",
        description: `Potentiel radon catégorie ${r}`,
        source: "Géorisques",
      });
    }

    // -----------------------
    // SISMIQUE
    // -----------------------
    const zs = mapSismique(sism);
    if (typeof zs === "number") {
      out.zonages.zone_sismique = zs;
      out.risques.push({
        categorie: "Naturel",
        nom: "Sismicité",
        niveau: zs >= 4 ? "eleve" : zs === 3 ? "modere" : "faible",
        description: `Zone de sismicité ${zs}`,
        source: "Géorisques",
      });
    }

    // -----------------------
    // ✅ RGA (argiles) si dispo
    // -----------------------
    const rgaMapped = mapRgaToArgilesAndNiveau(rgaRaw);
    if (rgaMapped.argiles) {
      out.zonages.argiles = rgaMapped.argiles;
    }
    if (rgaMapped.niveau) {
      out.risques.push({
        categorie: "Naturel",
        nom: "Retrait-gonflement des argiles (RGA)",
        niveau: rgaMapped.niveau,
        description: rgaMapped.raw_label
          ? `Aléa RGA: ${rgaMapped.raw_label}`
          : "Sensibilité des sols argileux aux variations hydriques.",
        source: "Géorisques",
      });
    }

    // -----------------------
    // CAVITÉS
    // -----------------------
    const cavCount = mapCount(cavites);
    out.zonages.cavites = cavCount > 0;
    if (cavCount > 0) {
      out.risques.push({
        categorie: "Naturel",
        nom: "Cavités souterraines",
        niveau: "modere",
        description: `${cavCount} occurrence(s) à proximité`,
        source: "Géorisques",
      });
    }

    // -----------------------
    // PPR
    // -----------------------
    const pprFlags = mapPprFlags(ppr);
    out.zonages.pprn = pprFlags.pprn;
    out.zonages.pprt = pprFlags.pprt;
    out.zonages.zone_inondable = pprFlags.inond;

    if (pprFlags.pprn) {
      out.risques.push({
        categorie: "Naturel",
        nom: "PPRN",
        niveau: "modere",
        description: "PPRN détecté",
        source: "Géorisques",
      });
    }
    if (pprFlags.pprt) {
      out.risques.push({
        categorie: "Technologique",
        nom: "PPRT",
        niveau: "eleve",
        description: "PPRT détecté",
        source: "Géorisques",
      });
    }
    if (pprFlags.inond) {
      out.risques.push({
        categorie: "Naturel",
        nom: "Inondation",
        niveau: "modere",
        description: "Zone inondable détectée",
        source: "Géorisques",
      });
    }

    // -----------------------
    // ICPE
    // -----------------------
    const icpeCount = mapCount(icpe);
    out.environnement.icpe = icpeCount;
    if (icpeCount > 0) {
      out.risques.push({
        categorie: "Technologique",
        nom: "ICPE",
        niveau: icpeCount >= 5 ? "modere" : "faible",
        description: `${icpeCount} installation(s) classée(s) à proximité`,
        source: "Géorisques",
      });
    }

    // -----------------------
    // SIS / Sols pollués
    // -----------------------
    const sisCount = mapCount(sis);
    out.environnement.sites_pollues = sisCount;
    if (sisCount > 0) {
      out.risques.push({
        categorie: "Technologique",
        nom: "Sols pollués (SIS)",
        niveau: sisCount >= 3 ? "modere" : "faible",
        description: `${sisCount} site(s) SIS à proximité`,
        source: "Géorisques",
      });
    }

    // -----------------------
    // Score global
    // -----------------------
    out.score_global = computeScore(out.zonages, out.environnement);
    out.niveau_risque = niveauFromScore(out.score_global);

    // -----------------------
    // ✅ Export CSV/PDF (sans cache pour éviter stocker des blobs)
    // -----------------------
    if (exportFmt === "csv") {
      const csv = buildRisquesCsv(out);
      return new Response(csv, {
        headers: {
          ...corsHeaders,
          "content-type": "text/csv; charset=utf-8",
          "content-disposition":
            `attachment; filename="risques_${out.commune?.insee ?? "commune"}.csv"`,
        },
      });
    }

    if (exportFmt === "pdf") {
      const pdfBytes = await buildRisquesPdf(out);
      return new Response(pdfBytes, {
        headers: {
          ...corsHeaders,
          "content-type": "application/pdf",
          "content-disposition":
            `attachment; filename="risques_${out.commune?.insee ?? "commune"}.pdf"`,
        },
      });
    }

    // -----------------------
    // Cache JSON
    // -----------------------
    await cacheSet(cacheKey, out, ttl);

    return new Response(
      JSON.stringify({
        success: true,
        cached: false,
        data: out,
        meta: {
          source: "risques-v1",
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (_e) {
    return new Response(
      JSON.stringify({ success: false, error: "Internal error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }
});