// ============================================================================
// dossier-terrain-v1 — Agrégateur "dossier terrain" MimmozIA
// ----------------------------------------------------------------------------
// Rôle : appeler EN PARALLÈLE toutes les Edge Functions sources déjà déployées
// et renvoyer un payload consolidé { status, summary, localisation, sections, meta }.
// N'implémente AUCUNE logique métier source — il empaquette.
//
// Déploiement : Supabase Dashboard, nom STRICTEMENT "dossier-terrain-v1"
// (⚠ vérifier le champ nom : pas de suffixe -index — piège déjà vu 2x).
// Secret à créer : COPILOT_FN_DOSSIER=dossier-terrain-v1
//
// SLUGS DE REPLI VÉRIFIÉS le 04/08/2026 contre la liste des fonctions déployées :
//   - PLU     : plu-parser          existe
//   - RISQUES : risk-study-v1       (l'ancien repli "risk-study" n'existe pas)
//   - DVF     : dvf-comparables-v1  (l'ancien repli "dvf-analysis" n'existe pas)
// Les autres slugs sont lus depuis les secrets COPILOT_FN_* existants.
//
// HTTP 200 TOUJOURS (même en error), aligné sur les autres fonctions.
// ============================================================================

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const env = (k: string) => Deno.env.get(k) ?? "";

const SUPABASE_URL = env("SUPABASE_URL");
// Auth interne fonction→fonction : service role si dispo, sinon anon.
const FN_AUTH = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_ANON_KEY");

// --- Slugs des sources (secrets COPILOT_FN_* + replis vérifiés) -------------
const SLUGS = {
  plu: env("COPILOT_FN_PLU") || "plu-parser",
  risques: env("COPILOT_FN_RISKS") || "risk-study-v1",
  dvf: env("COPILOT_FN_DVF") || "dvf-comparables-v1",
  loyers: env("COPILOT_FN_LOYERS") || "loyers-reference-v1",
  servitudes: env("COPILOT_FN_SERVITUDES") || "servitudes-gpu-v1",
  solaire: env("COPILOT_FN_SOLAIRE") || "potentiel-solaire-v1",
  zonage_abc: env("COPILOT_FN_ZONAGE") || "zonage-abc-v1",
  taxes: env("COPILOT_FN_TAXES") || "taxes-locales-v1",
  assainissement:
    env("COPILOT_FN_ASSAINISSEMENT") || "assainissement-commune-v1",
  altimetrie: env("COPILOT_FN_ALTIMETRIE") || "altimetrie-v1",
  bruit: env("COPILOT_FN_BRUIT") || "bruit-classement-v1",
} as const;

type SourceKey = keyof typeof SLUGS;

// Groupes de sections (filtrables via input.sections)
const GROUPS: Record<string, SourceKey[]> = {
  urbanisme: ["plu", "servitudes"],
  risques: ["risques"],
  marche: ["dvf", "loyers"],
  fiscal: ["zonage_abc", "taxes"],
  technique: ["altimetrie", "assainissement", "solaire", "bruit"],
};

// --- Helpers ----------------------------------------------------------------
const str = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};

async function fetchT(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Centroïde approximatif d'une géométrie GeoJSON (moyenne du 1er anneau)
function centroidOf(
  geom: any,
): { lat: number; lon: number } | null {
  try {
    let ring: number[][] | null = null;
    if (geom?.type === "Polygon") ring = geom.coordinates?.[0];
    else if (geom?.type === "MultiPolygon") ring = geom.coordinates?.[0]?.[0];
    else if (geom?.type === "Point") {
      const [lon, lat] = geom.coordinates ?? [];
      return Number.isFinite(lat) && Number.isFinite(lon)
        ? { lat, lon }
        : null;
    }
    if (!ring || !ring.length) return null;
    let sx = 0, sy = 0, n = 0;
    for (const p of ring) {
      if (Number.isFinite(p?.[0]) && Number.isFinite(p?.[1])) {
        sx += p[0];
        sy += p[1];
        n++;
      }
    }
    if (!n) return null;
    return { lat: sy / n, lon: sx / n };
  } catch {
    return null;
  }
}

// --- Localisation (résolue UNE fois, injectée à toutes les sources) ---------
interface Localisation {
  idu: string | null;
  code_insee: string | null;
  commune: string | null;
  lat: number | null;
  lon: number | null;
  precision: "parcelle" | "centre_commune" | null;
}

async function resolveLocalisation(input: any): Promise<Localisation | null> {
  let idu = str(input.cadastral_ref) ?? str(input.parcel_id);
  let insee = str(input.code_insee);
  let lat = num(input.lat) ?? null;
  let lon = num(input.lon) ?? null;
  let commune = str(input.city) ?? null;
  let precision: Localisation["precision"] = null;

  if (idu) {
    idu = idu.toUpperCase().replace(/\s+/g, "");
    if (!insee) {
      const m = idu.match(/^(2[AB]\d{3}|\d{5})/i);
      if (m) insee = m[1].toUpperCase();
    }
  }

  if (lat !== null && lon !== null) precision = "parcelle"; // coordonnées fournies

  // 1) Centroïde parcelle via API Carto cadastre (IDU 14 car)
  if (precision !== "parcelle" && idu && idu.length === 14 && insee) {
    try {
      const section = idu.slice(8, 10);
      const numero = idu.slice(10, 14);
      const u =
        `https://apicarto.ign.fr/api/cadastre/parcelle?code_insee=${insee}&section=${section}&numero=${numero}`;
      const r = await fetchT(u, 8000);
      if (r.ok) {
        const g = await r.json();
        const feats = g?.features ?? [];
        console.log(
          `[dossier] cadastre insee=${insee} sect=${section} num=${numero} -> ${feats.length} parcelle(s)`,
        );
        const c = feats[0]?.geometry ? centroidOf(feats[0].geometry) : null;
        if (c) {
          lat = c.lat;
          lon = c.lon;
          precision = "parcelle";
        }
      }
    } catch (e) {
      console.log("[dossier] cadastre erreur:", String(e));
    }
  }

  // 2) Nom + centroïde commune via geo.api (repli)
  if (insee && (!commune || lat === null)) {
    try {
      const r = await fetchT(
        `https://geo.api.gouv.fr/communes/${insee}?fields=nom,centre`,
        6000,
      );
      if (r.ok) {
        const c = await r.json();
        commune = commune ?? c?.nom ?? null;
        const coords = c?.centre?.coordinates;
        if (lat === null && Array.isArray(coords)) {
          lon = coords[0];
          lat = coords[1];
          precision = precision ?? "centre_commune";
        }
      }
    } catch (e) {
      console.log("[dossier] geo.api commune erreur:", String(e));
    }
  }

  // 3) Ville seule -> INSEE + centroïde
  if (!insee && commune) {
    try {
      const r = await fetchT(
        `https://geo.api.gouv.fr/communes?nom=${
          encodeURIComponent(commune)
        }&fields=nom,code,centre&boost=population&limit=1`,
        6000,
      );
      if (r.ok) {
        const arr = await r.json();
        const c = Array.isArray(arr) ? arr[0] : null;
        if (c?.code) {
          insee = c.code;
          commune = c.nom ?? commune;
          const coords = c?.centre?.coordinates;
          if (lat === null && Array.isArray(coords)) {
            lon = coords[0];
            lat = coords[1];
            precision = precision ?? "centre_commune";
          }
        }
      }
    } catch (e) {
      console.log("[dossier] geo.api ville erreur:", String(e));
    }
  }

  if (!insee && lat === null) return null;
  return {
    idu: idu ?? null,
    code_insee: insee ?? null,
    commune,
    lat,
    lon,
    precision: precision ?? (lat !== null ? "centre_commune" : null),
  };
}

// --- Appel d'une source -----------------------------------------------------
interface SourceResult {
  status: string; // ok | no_data | error | skipped
  [k: string]: unknown;
}

async function callSource(
  slug: string,
  payload: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<SourceResult> {
  try {
    const r = await fetchT(`${SUPABASE_URL}/functions/v1/${slug}`, timeoutMs, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FN_AUTH}`,
        apikey: FN_AUTH,
      },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => null);
    if (!body) return { status: "error", error: `HTTP ${r.status} (corps illisible)` };
    if (!r.ok) {
      return { status: "error", error: `HTTP ${r.status}`, detail: body };
    }
    // Relayé tel quel ; status par défaut "ok" si la source n'en met pas
    return { ...body, status: (body as any).status ?? "ok" };
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    return {
      status: "error",
      error: msg.includes("abort") ? `timeout ${timeoutMs} ms` : msg,
    };
  }
}

// --- Handler ----------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const t0 = Date.now();
  let input: any = {};
  try {
    input = await req.json();
  } catch {
    /* corps vide toléré */
  }

  // Filtre de sections optionnel
  const wanted: string[] = Array.isArray(input.sections) &&
      input.sections.length
    ? input.sections.filter((s: string) => s in GROUPS)
    : Object.keys(GROUPS);

  const loc = await resolveLocalisation(input);
  if (!loc) {
    return json({
      status: "error",
      summary:
        "Impossible de localiser le terrain : fournir un identifiant cadastral (IDU 14 caractères), un code INSEE, une commune ou des coordonnées.",
      localisation: null,
      sections: {},
      meta: {
        sources_ok: [],
        sources_no_data: [],
        sources_error: [],
        duree_ms: Date.now() - t0,
        genere_le: new Date().toISOString(),
      },
    });
  }

  // Payload commun transmis aux sources (chaque source prend ce qu'elle sait lire)
  const common: Record<string, unknown> = {
    code_insee: loc.code_insee ?? undefined,
    city: loc.commune ?? undefined,
    cadastral_ref: loc.idu ?? undefined,
    parcel_id: loc.idu ?? undefined,
    lat: loc.lat ?? undefined,
    lon: loc.lon ?? undefined,
  };

  // Prérequis par source :
  // - servitudes : lat/lon PRÉCISION PARCELLE uniquement (décision actée, pas de repli commune)
  // - bruit      : IDU ou lat/lon parcelle (pas de repli commune)
  // - les autres : payload commun, elles gèrent leurs propres replis
  const parcelPrecise = loc.precision === "parcelle";
  const tasks: Array<{ key: SourceKey; run: () => Promise<SourceResult> }> = [];
  const skipped: Partial<Record<SourceKey, SourceResult>> = {};

  const activeKeys = new Set<SourceKey>();
  for (const g of wanted) for (const k of GROUPS[g]) activeKeys.add(k);

  for (const key of activeKeys) {
    if (key === "servitudes" && !parcelPrecise) {
      skipped[key] = {
        status: "no_data",
        summary:
          "Servitudes non interrogées : localisation précise de la parcelle indisponible (les servitudes exigent le polygone/point parcelle, pas de repli commune).",
      };
      continue;
    }
    if (key === "bruit" && !parcelPrecise && !loc.idu) {
      skipped[key] = {
        status: "no_data",
        summary:
          "Classement sonore non interrogé : ni identifiant cadastral ni coordonnées parcelle disponibles.",
      };
      continue;
    }
    tasks.push({
      key,
      run: () => callSource(SLUGS[key], common, 8000),
    });
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  const results: Partial<Record<SourceKey, SourceResult>> = { ...skipped };
  settled.forEach((s, i) => {
    const key = tasks[i].key;
    results[key] = s.status === "fulfilled"
      ? s.value
      : { status: "error", error: String((s as any).reason ?? "rejet") };
  });

  // Assemblage sections
  const sections: Record<string, Record<string, SourceResult | undefined>> = {};
  for (const g of wanted) {
    sections[g] = {};
    for (const k of GROUPS[g]) sections[g][k === "risques" ? "georisques" : k] =
      results[k];
  }

  // Meta
  const sources_ok: string[] = [];
  const sources_no_data: string[] = [];
  const sources_error: string[] = [];
  for (const k of activeKeys) {
    const st = results[k]?.status;
    if (st === "ok") sources_ok.push(k);
    else if (st === "error") sources_error.push(k);
    else sources_no_data.push(k);
  }

  const status = sources_ok.length === 0
    ? "error"
    : (sources_error.length || sources_no_data.length)
    ? "partial"
    : "ok";

  const where = [
    loc.commune ?? loc.code_insee ?? "",
    loc.idu ? `parcelle ${loc.idu}` : "",
  ].filter(Boolean).join(" — ");

  const summary =
    `Dossier terrain ${where} (précision : ${
      loc.precision === "parcelle" ? "parcelle" : "centre de commune"
    }). ` +
    `${sources_ok.length} source(s) exploitables, ${sources_no_data.length} sans donnée, ${sources_error.length} en échec. ` +
    (sources_error.length
      ? `Échecs : ${sources_error.join(", ")}. `
      : "") +
    `Rappel : pour les couches GPU (servitudes, bruit), une absence de résultat ne prouve pas l'absence de contrainte.`;

  console.log(
    `[dossier] ${where} -> ok=${sources_ok.length} no_data=${sources_no_data.length} err=${sources_error.length} en ${
      Date.now() - t0
    } ms`,
  );

  return json({
    status,
    summary,
    localisation: loc,
    sections,
    meta: {
      sources_ok,
      sources_no_data,
      sources_error,
      duree_ms: Date.now() - t0,
      genere_le: new Date().toISOString(),
    },
  });
});
