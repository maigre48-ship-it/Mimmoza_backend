// supabase/functions/recherche-contacts-mairies-v1/index.ts
//
// Sources :
//   1. etablissements-publics.api.gouv.fr  → email, tél, adresse mairie
//   2. api-lannuaire.service-public.gouv.fr → fallback
//   3. geo.api.gouv.fr                     → communes + géographie

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type MairieContactRow = {
  codeInsee: string | null;
  commune: string;
  codePostal: string | null;
  civiliteMaire: string | null;
  prenomMaire: string | null;
  nomMaire: string | null;
  emailMairie: string | null;
  telephoneMairie: string | null;
  adresseMairie: string | null;
  source: string | null;
  distanceKm: number | null;
};

type ResponsePayload = {
  rows: MairieContactRow[];
  total: number;
  source: string | null;
  centerCommune: string | null;
  radiusKm: number | null;
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_RESULTS_DEFAULT = 50;
const MAX_RESULTS_RADIUS = 200;
const CONCURRENCY = 5;

type GeoCommune = {
  code?: string;
  nom?: string;
  codesPostaux?: string[];
  codeDepartement?: string;
  centre?: { type?: string; coordinates?: [number, number] };
  __distanceKm?: number;
};

function safe(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

function isDepartementCode(q: string): boolean {
  return /^(2A|2B|\d{2,3})$/i.test(q);
}

function isCodePostal(q: string): boolean {
  return /^\d{5}$/.test(q);
}

async function fetchJson<T>(
  url: string,
  timeoutMs = 10000,
  label = "",
): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Mimmoza/1.0",
      },
    });

    if (!resp.ok) {
      console.warn(`[${label}] HTTP ${resp.status} - ${url}`);
      return null;
    }

    return (await resp.json()) as T;
  } catch (e) {
    console.warn(`[${label}] fetch error`, (e as Error).message, url);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ─────────────────────────────────────────────────────────────
// GEO.API.GOUV.FR
// ─────────────────────────────────────────────────────────────

async function searchCommunes(query: string, includeCentre: boolean): Promise<GeoCommune[]> {
  const q = query.trim();
  if (!q) return [];

  const fieldsBase = "nom,code,codesPostaux,codeDepartement";
  const fields = includeCentre ? `${fieldsBase},centre` : fieldsBase;

  let url: string;

  if (isCodePostal(q)) {
    url =
      `https://geo.api.gouv.fr/communes?codePostal=${encodeURIComponent(q)}` +
      `&fields=${fields}&format=json&limit=${MAX_RESULTS_DEFAULT}`;
  } else if (isDepartementCode(q)) {
    url =
      `https://geo.api.gouv.fr/departements/${encodeURIComponent(q.toUpperCase())}/communes` +
      `?fields=${fields}&format=json`;
  } else {
    url =
      `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(q)}` +
      `&fields=${fields}&format=json&boost=population&limit=${MAX_RESULTS_DEFAULT}`;
  }

  console.log(`[searchCommunes] q="${q}" url=${url}`);

  const json = await fetchJson<GeoCommune[]>(url, 10000, "searchCommunes");

  if (!Array.isArray(json)) return [];

  console.log(`[searchCommunes] ${json.length} commune(s)`);

  return json.slice(0, MAX_RESULTS_DEFAULT);
}

async function searchCommunesInRadius(
  lat: number,
  lon: number,
  radiusKm: number,
): Promise<GeoCommune[]> {
  const fields = "nom,code,codesPostaux,codeDepartement,centre";

  const pivotArr = await fetchJson<GeoCommune[]>(
    `https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=${fields}&format=json&limit=1`,
    10000,
    "pivotByLatLon",
  );

  const pivotDep =
    Array.isArray(pivotArr) && pivotArr.length > 0
      ? safe(pivotArr[0].codeDepartement)
      : null;

  const depsToScan = new Set<string>();

  if (pivotDep) depsToScan.add(pivotDep);

  if (radiusKm > 15) {
    const deltaDeg = radiusKm / 111;

    const probes: Array<[number, number]> = [
      [lat + deltaDeg, lon],
      [lat - deltaDeg, lon],
      [lat, lon + deltaDeg],
      [lat, lon - deltaDeg],
    ];

    const probeResults = await Promise.all(
      probes.map((p) =>
        fetchJson<GeoCommune[]>(
          `https://geo.api.gouv.fr/communes?lat=${p[0]}&lon=${p[1]}&fields=codeDepartement&format=json&limit=1`,
          8000,
          "probe",
        ),
      ),
    );

    for (const pr of probeResults) {
      const dep =
        Array.isArray(pr) && pr.length > 0
          ? safe(pr[0].codeDepartement)
          : null;

      if (dep) depsToScan.add(dep);
    }
  }

  console.log(`[searchCommunesInRadius] depts:`, Array.from(depsToScan));

  const all: GeoCommune[] = [];

  for (const dep of depsToScan) {
    const list = await fetchJson<GeoCommune[]>(
      `https://geo.api.gouv.fr/departements/${encodeURIComponent(dep)}/communes?fields=${fields}&format=json`,
      10000,
      `dep-${dep}`,
    );

    if (Array.isArray(list)) all.push(...list);
  }

  const filtered: Array<{ c: GeoCommune; d: number }> = [];

  for (const c of all) {
    const coords = c.centre?.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2) continue;

    const [cLon, cLat] = coords;

    if (typeof cLat !== "number" || typeof cLon !== "number") continue;

    const d = haversineKm(lat, lon, cLat, cLon);

    if (d <= radiusKm) filtered.push({ c, d });
  }

  filtered.sort((a, b) => a.d - b.d);

  return filtered.slice(0, MAX_RESULTS_RADIUS).map((x) => ({
    ...x.c,
    __distanceKm: x.d,
  }));
}

// ─────────────────────────────────────────────────────────────
// HELPERS ANNUAIRE
// ─────────────────────────────────────────────────────────────

function firstString(v: unknown): string | null {
  if (typeof v === "string") {
    const s = safe(v);
    if (!s) return null;

    if (s.startsWith("[") || s.startsWith("{")) {
      try {
        return firstString(JSON.parse(s));
      } catch {
        return s;
      }
    }

    return s;
  }

  if (Array.isArray(v)) {
    for (const item of v) {
      const f = firstString(item);
      if (f) return f;
    }
    return null;
  }

  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;

    for (const k of [
      "valeur",
      "numero",
      "adresse",
      "email",
      "mail",
      "telephone",
      "tel",
      "url",
    ]) {
      const f = firstString(o[k]);
      if (f) return f;
    }
  }

  return null;
}

function formatAdresse(raw: unknown): string | null {
  let v: unknown = raw;

  if (typeof v === "string") {
    const s = safe(v);
    if (!s) return null;

    if (s.startsWith("[") || s.startsWith("{")) {
      try {
        v = JSON.parse(s);
      } catch {
        return s;
      }
    } else {
      return s;
    }
  }

  const list: Record<string, unknown>[] = Array.isArray(v)
    ? (v as Record<string, unknown>[])
    : v && typeof v === "object"
      ? [v as Record<string, unknown>]
      : [];

  if (list.length === 0) return null;

  const a = list[0];
  const parts: string[] = [];

  const numero = safe(a.numero_voie) ?? safe(a.numero);
  const typeVoie = safe(a.type_voie);
  const libelleVoie = safe(a.libelle_voie) ?? safe(a.voie);
  const ligne = safe(a.ligne);

  if (ligne) {
    parts.push(ligne);
  } else {
    const voie = [numero, typeVoie, libelleVoie].filter(Boolean).join(" ").trim();
    if (voie) parts.push(voie);
  }

  const c1 = safe(a.complement1);
  const c2 = safe(a.complement2);

  if (c1) parts.push(c1);
  if (c2) parts.push(c2);

  const cpVille = [
    safe(a.code_postal),
    safe(a.nom_commune) ?? safe(a.commune),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (cpVille) parts.push(cpVille);

  return parts.length > 0 ? parts.join(", ") : null;
}

// ─────────────────────────────────────────────────────────────
// SOURCE 1 : ETABLISSEMENTS PUBLICS
// ─────────────────────────────────────────────────────────────

type EtabOrganisme = {
  Adresse?: {
    Ligne?: string | string[];
    CodePostal?: string;
    NomCommune?: string;
  };
  CoordonnéesNum?: {
    Téléphone?: string;
    Email?: string;
    Url?: string;
  };
};

type EtabResponse = {
  features?: Array<{
    properties?: {
      Organisme?: EtabOrganisme;
    };
  }>;
};

function linesToArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

async function fetchMairieContactEtab(
  codeInsee: string,
): Promise<{ email: string | null; tel: string | null; adresse: string | null } | null> {
  const url =
    `https://etablissements-publics.api.gouv.fr/v3/communes/` +
    `${encodeURIComponent(codeInsee)}/mairie`;

  const json = await fetchJson<EtabResponse>(url, 8000, "etab-publics");

  const org = json?.features?.[0]?.properties?.Organisme;

  if (!org) return null;

  const email = safe(org.CoordonnéesNum?.Email ?? null);
  const tel = safe(org.CoordonnéesNum?.Téléphone ?? null);

  const parts: string[] = [];

  for (const l of linesToArray(org.Adresse?.Ligne)) {
    const s = safe(l);
    if (s) parts.push(s);
  }

  const cpVille = [
    safe(org.Adresse?.CodePostal ?? null),
    safe(org.Adresse?.NomCommune ?? null),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (cpVille) parts.push(cpVille);

  const adresse = parts.length > 0 ? parts.join(", ") : null;

  if (!email && !tel && !adresse) return null;

  return { email, tel, adresse };
}

// ─────────────────────────────────────────────────────────────
// SOURCE 2 : ANNUAIRE SERVICE PUBLIC
// ─────────────────────────────────────────────────────────────

async function fetchMairieContactAnnuaire(
  codeInsee: string,
): Promise<{ email: string | null; tel: string | null; adresse: string | null } | null> {
  const BASE =
    "https://api-lannuaire.service-public.gouv.fr/api/explore/v2.1/catalog/datasets/api-lannuaire-administration/records";

  const encodedCode = encodeURIComponent(codeInsee);

  const queries = [
    `${BASE}?where=code_insee_commune%3D%22${encodedCode}%22%20AND%20pivot%20LIKE%20%22%25mairie%25%22&limit=1`,
    `${BASE}?where=code_insee_commune%3D%22${encodedCode}%22&limit=1`,
  ];

  for (const url of queries) {
    const json = await fetchJson<{ results?: Array<Record<string, unknown>> }>(
      url,
      8000,
      "annuaire",
    );

    if (!json?.results?.length) continue;

    const rec = json.results[0];

    console.log(`[annuaire] ${codeInsee} champs: ${Object.keys(rec).join(", ")}`);

    const coordonnee = rec.coordonnee as Record<string, unknown> | undefined;

    const email =
      firstString(rec.adresse_courriel) ??
      firstString(rec.email) ??
      firstString(rec.mail) ??
      firstString(coordonnee?.adresse_courriel) ??
      firstString(coordonnee?.email);

    const tel =
      firstString(rec.telephone) ??
      firstString(rec.tel) ??
      firstString(coordonnee?.telephone) ??
      firstString(coordonnee?.tel);

    const adresse =
      formatAdresse(rec.adresse) ??
      formatAdresse(rec.adresse_postale) ??
      formatAdresse(coordonnee?.adresse);

    if (email || tel || adresse) {
      return { email, tel, adresse };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// ORCHESTRATEUR CONTACT
// ─────────────────────────────────────────────────────────────

async function fetchMairieContact(
  codeInsee: string,
): Promise<{
  email: string | null;
  tel: string | null;
  adresse: string | null;
  source: string;
} | null> {
  try {
    const r1 = await fetchMairieContactEtab(codeInsee);

    if (r1) {
      console.log(
        `[contact] ${codeInsee} ✓ etab-publics email=${r1.email ?? "∅"} tel=${r1.tel ?? "∅"}`,
      );

      return {
        ...r1,
        source: "etablissements-publics.api.gouv.fr",
      };
    }
  } catch (e) {
    console.warn(`[contact] ${codeInsee} etab-publics error:`, (e as Error).message);
  }

  try {
    const r2 = await fetchMairieContactAnnuaire(codeInsee);

    if (r2) {
      console.log(
        `[contact] ${codeInsee} ✓ annuaire email=${r2.email ?? "∅"} tel=${r2.tel ?? "∅"}`,
      );

      return {
        ...r2,
        source: "api-lannuaire.service-public.gouv.fr",
      };
    }
  } catch (e) {
    console.warn(`[contact] ${codeInsee} annuaire error:`, (e as Error).message);
  }

  console.log(`[contact] ${codeInsee} → aucune source n'a retourné de données`);

  return null;
}

// ─────────────────────────────────────────────────────────────
// BUILD ROWS
// ─────────────────────────────────────────────────────────────

async function buildRows(communes: GeoCommune[]): Promise<MairieContactRow[]> {
  const rows: MairieContactRow[] = [];
  let idx = 0;

  async function worker() {
    while (idx < communes.length) {
      const i = idx++;
      const c = communes[i];

      const nomCommune = safe(c.nom);
      if (!nomCommune) continue;

      const codeInsee = safe(c.code);
      const cp = c.codesPostaux?.[0] ? safe(c.codesPostaux[0]) : null;
      const distanceKm = typeof c.__distanceKm === "number" ? c.__distanceKm : null;

      let email: string | null = null;
      let tel: string | null = null;
      let adresse: string | null = null;
      let source = "geo.api.gouv.fr";

      if (codeInsee) {
        const contact = await fetchMairieContact(codeInsee);

        if (contact) {
          email = contact.email;
          tel = contact.tel;
          adresse = contact.adresse;
          source = contact.source;
        }
      }

      rows.push({
        codeInsee,
        commune: nomCommune,
        codePostal: cp,
        civiliteMaire: null,
        prenomMaire: null,
        nomMaire: null,
        emailMairie: email,
        telephoneMairie: tel,
        adresseMairie: adresse,
        source,
        distanceKm: distanceKm !== null ? Math.round(distanceKm * 10) / 10 : null,
      });
    }
  }

  const workers: Promise<void>[] = [];

  for (let k = 0; k < Math.min(CONCURRENCY, communes.length); k++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  rows.sort((a, b) => {
    if (a.distanceKm !== null && b.distanceKm !== null) {
      return a.distanceKm - b.distanceKm;
    }

    if (a.distanceKm !== null) return -1;
    if (b.distanceKm !== null) return 1;

    return a.commune.localeCompare(b.commune, "fr");
  });

  return rows;
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: CORS_HEADERS,
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  }

  let body: { query?: unknown; radiusKm?: unknown } = {};

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";

  const radiusRaw =
    typeof body.radiusKm === "number" && Number.isFinite(body.radiusKm)
      ? body.radiusKm
      : null;

  const radiusKm =
    radiusRaw !== null && radiusRaw > 0
      ? Math.min(radiusRaw, 100)
      : null;

  console.log(`[handler] query="${query}" radiusKm=${radiusKm}`);

  if (!query) {
    return new Response(
      JSON.stringify({
        rows: [],
        total: 0,
        source: null,
        centerCommune: null,
        radiusKm: null,
      }),
      {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
        },
      },
    );
  }

  try {
    let rows: MairieContactRow[] = [];
    let centerCommune: string | null = null;
    let appliedRadius: number | null = null;

    const radiusApplicable = radiusKm !== null && !isDepartementCode(query);

    if (radiusApplicable) {
      const pivots = await searchCommunes(query, true);
      const pivot = pivots[0];
      const coords = pivot?.centre?.coordinates;

      if (pivot && Array.isArray(coords) && coords.length === 2) {
        const [lon, lat] = coords;

        if (typeof lat === "number" && typeof lon === "number") {
          centerCommune = safe(pivot.nom);
          appliedRadius = radiusKm;

          const inRadius = await searchCommunesInRadius(lat, lon, radiusKm);
          rows = await buildRows(inRadius);
        } else {
          rows = await buildRows(pivots);
        }
      } else {
        rows = await buildRows(pivots);
      }
    } else {
      const communes = await searchCommunes(query, false);
      rows = await buildRows(communes);
    }

    const payload: ResponsePayload = {
      rows,
      total: rows.length,
      source: rows.length > 0 ? rows[0].source : "geo.api.gouv.fr",
      centerCommune,
      radiusKm: appliedRadius,
    };

    console.log(`[handler] → ${rows.length} row(s)`);

    return new Response(JSON.stringify(payload), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erreur inattendue";

    console.error("[handler] fatal", msg);

    return new Response(
      JSON.stringify({
        error: "Erreur lors de la recherche des mairies",
        details: msg,
      }),
      {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
        },
      },
    );
  }
});