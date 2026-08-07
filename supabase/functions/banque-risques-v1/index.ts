// supabase/functions/banque-risques-v1/index.ts
//
// ✅ Banque Risques V1 (GeoRisques) + Scoring INLINE (Dashboard-proof)
// - No extra files/imports => no bundling "module not found"
// - GeoRisques base: https://georisques.gouv.fr/api/v1
// - GASPAR catnat/risques: latlon=lon,lat + rayon=meters
// - PPR: /api/v1/ppr (latlon/rayon OR code_insee)
// - Radon: /api/v1/radon (requires code_insee)
// - Address geocoding: IGN Géoplateforme (data.geopf.fr)
// - Cache via api_cache_get/api_cache_put
// - Persist in banque_dossiers.risks_data
// - Adds risks.scoring computed by scoreRisksV1()

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const GEORISQUES_BASE = "https://georisques.gouv.fr/api/v1";
const GEOCODE_BASE = "https://data.geopf.fr/geocodage";
const CADASTRE_BASE =
  "https://cadastre.data.gouv.fr/bundler/cadastre-etalab/communes";

type Input = {
  dossierId: string;
  adresse?: string;
  parcel_id?: string;
  lat?: number;
  lng?: number;
  rayon_m?: number;     // default 1000
  persist?: boolean;    // default true
  ttl_seconds?: number; // default 86400
  debug?: boolean;      // default false
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cacheKey(parts: Record<string, unknown>) {
  return JSON.stringify(parts);
}

async function cacheGet(provider: string, key: string) {
  const { data, error } = await supabase.rpc("api_cache_get", {
    p_provider: provider,
    p_cache_key: key,
  });
  if (error) throw new Error(`api_cache_get failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row?.response) return null;
  if (row?.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.response;
}

async function cachePut(
  provider: string,
  key: string,
  request: unknown,
  response: unknown,
  status: number,
  ttlSeconds: number,
) {
  const { error } = await supabase.rpc("api_cache_put", {
    p_provider: provider,
    p_cache_key: key,
    p_request: request,
    p_response: response,
    p_status: status,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new Error(`api_cache_put failed: ${error.message}`);
}

async function fetchJson(url: string) {
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await resp.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  return { ok: resp.ok, status: resp.status, json: parsed, raw: text };
}

function normalizeParcelId(input: string) {
  return input.replace(/[-\s]/g, "").toUpperCase();
}

function centroidFromRing(ring: number[][]) {
  const n = ring.length;
  const sum = ring.reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1]], [0, 0]);
  return { lon: sum[0] / n, lat: sum[1] / n };
}

function safeInsee(code: unknown): string | null {
  const s = typeof code === "string" ? code.trim() : "";
  if (!s) return null;
  return /^\d{5}$/.test(s) ? s : null;
}

async function resolveLatLngFromAddress(adresse: string) {
  const url = `${GEOCODE_BASE}/search/?q=${encodeURIComponent(adresse)}&limit=1&index=address`;
  const r = await fetchJson(url);
  const f = r.json?.features?.[0];
  if (!f) return { ok: false as const, url, status: r.status, error: "No result" };

  const lon = f.geometry.coordinates[0];
  const lat = f.geometry.coordinates[1];

  return {
    ok: true as const,
    url,
    status: r.status,
    lat,
    lon,
    postcode: f.properties?.postcode ?? null,
    citycode: f.properties?.citycode ?? null,
    label: f.properties?.label ?? adresse,
    raw_top_feature: f,
  };
}

async function resolveInseeFromLatLng(lat: number, lon: number) {
  const url = `${GEOCODE_BASE}/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&limit=1&index=address`;
  const r = await fetchJson(url);
  const f = r.json?.features?.[0];
  const citycode = f?.properties?.citycode ?? null;

  if (!f || !citycode) {
    return {
      ok: false as const,
      url,
      status: r.status,
      error: "No reverse result or missing citycode",
      raw_top_feature: f ?? null,
    };
  }

  return {
    ok: true as const,
    url,
    status: r.status,
    citycode: String(citycode),
    postcode: f.properties?.postcode ?? null,
    city: f.properties?.city ?? null,
    label: f.properties?.label ?? null,
    raw_top_feature: f,
  };
}

async function resolveLatLngFromParcel(parcelId: string) {
  const cleanId = normalizeParcelId(parcelId);
  if (cleanId.length < 12) return { ok: false as const, error: "Invalid parcel_id (too short)" };

  const communeInsee = cleanId.slice(0, 5);
  const section = cleanId.slice(8, 10);
  const numero = cleanId.slice(10);

  const url = `${CADASTRE_BASE}/${encodeURIComponent(communeInsee)}/geojson/parcelles`;
  const r = await fetchJson(url);
  if (!r.ok || !r.json?.features) {
    return { ok: false as const, url, status: r.status, error: "Cadastre fetch failed" };
  }

  const parcel = r.json.features.find((f: any) => {
    const props = f.properties;
    return props.commune === communeInsee && props.section === section && props.numero === numero;
  });

  if (!parcel) {
    return { ok: false as const, url, status: r.status, error: "Parcel not found in commune geojson" };
  }

  const ring = parcel.geometry?.coordinates?.[0]?.[0];
  if (!Array.isArray(ring) || ring.length < 3) {
    return { ok: false as const, url, status: r.status, error: "Invalid parcel geometry" };
  }

  const c = centroidFromRing(ring);
  return {
    ok: true as const,
    url,
    status: r.status,
    lat: c.lat,
    lon: c.lon,
    commune_insee: communeInsee,
    section,
    numero,
    surface: parcel.properties?.contenance ?? null,
    raw_top_feature: parcel,
  };
}

function buildCandidates(opts: {
  lat: number;
  lng: number;
  rayon_m: number;
  code_insee: string | null;
  debug: boolean;
}) {
  const { lat, lng, rayon_m, code_insee, debug } = opts;

  const latlon = `${lng},${lat}`;
  const rayon = String(rayon_m);

  const candidates: Array<{ key: string; url: string }> = [];

  candidates.push({
    key: "catnat",
    url: `${GEORISQUES_BASE}/gaspar/catnat?latlon=${encodeURIComponent(latlon)}&rayon=${encodeURIComponent(rayon)}`,
  });

  candidates.push({
    key: "risques",
    url: `${GEORISQUES_BASE}/gaspar/risques?latlon=${encodeURIComponent(latlon)}&rayon=${encodeURIComponent(rayon)}`,
  });

  if (code_insee) {
    candidates.push({
      key: "radon",
      url: `${GEORISQUES_BASE}/radon?code_insee=${encodeURIComponent(code_insee)}`,
    });
  } else {
    candidates.push({ key: "radon_missing_insee", url: `${GEORISQUES_BASE}/radon` });
  }

  if (code_insee) {
    candidates.push({
      key: "ppr_code_insee",
      url: `${GEORISQUES_BASE}/ppr?code_insee=${encodeURIComponent(code_insee)}`,
    });
  }
  candidates.push({
    key: "ppr_latlon",
    url: `${GEORISQUES_BASE}/ppr?latlon=${encodeURIComponent(latlon)}&rayon=${encodeURIComponent(rayon)}`,
  });

  if (debug && code_insee) {
    candidates.push({
      key: "catnat_code_insee_probe",
      url: `${GEORISQUES_BASE}/gaspar/catnat?code_insee=${encodeURIComponent(code_insee)}`,
    });
    candidates.push({
      key: "risques_code_insee_probe",
      url: `${GEORISQUES_BASE}/gaspar/risques?code_insee=${encodeURIComponent(code_insee)}`,
    });
    candidates.push({
      key: "ppr_code_insee_probe",
      url: `${GEORISQUES_BASE}/ppr?code_insee=${encodeURIComponent(code_insee)}&rayon=${encodeURIComponent(rayon)}`,
    });
  }

  return candidates;
}

// ==============================
// SCORING INLINE (no imports)
// ==============================
type RiskSeverity = "low" | "moderate" | "high" | "critical" | "unknown";

type RiskItem = {
  key: string;
  label: string;
  severity: RiskSeverity;
  score_impact: number; // penalty 0..100
  confidence: number;   // 0..1
  source: "georisques";
  evidence?: string[];
  raw?: unknown;
};

type RisksScore = {
  score: number; // 0..100 (100 best)
  grade: "A" | "B" | "C" | "D" | "E";
  level_label: string;
  items: RiskItem[];
  missing: string[];
  confidence: number; // 0..1
  rationale: string[];
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function gradeFromScore(score: number): { grade: RisksScore["grade"]; label: string } {
  if (score >= 85) return { grade: "A", label: "Faible" };
  if (score >= 70) return { grade: "B", label: "Modéré" };
  if (score >= 55) return { grade: "C", label: "Moyen" };
  if (score >= 40) return { grade: "D", label: "Élevé" };
  return { grade: "E", label: "Critique" };
}

function scoreRisksV1(risks: any): RisksScore {
  const items: RiskItem[] = [];
  const missing: string[] = [];

  const status = risks?.status ?? {};
  const results = risks?.results ?? {};

  const ensure = (k: string) => {
    const st = status?.[k];
    if (typeof st !== "number" || st < 200 || st >= 300) {
      missing.push(k);
      return false;
    }
    return true;
  };

  // RADON
  if (ensure("radon")) {
    const data0 = results?.radon?.data?.[0];
    const classe = String(data0?.classe_potentiel ?? "");
    let penalty = 4;
    let sev: RiskSeverity = "unknown";
    let conf = 0.5;

    if (classe === "1") { penalty = 2; sev = "low"; conf = 0.95; }
    else if (classe === "2") { penalty = 6; sev = "moderate"; conf = 0.95; }
    else if (classe === "3") { penalty = 12; sev = "high"; conf = 0.95; }

    items.push({
      key: "radon",
      label: "Potentiel radon",
      severity: sev,
      score_impact: penalty,
      confidence: conf,
      source: "georisques",
      evidence: [classe ? `Classe radon: ${classe}` : "Classe radon non disponible"],
      raw: results?.radon,
    });
  } else {
    items.push({
      key: "radon",
      label: "Potentiel radon",
      severity: "unknown",
      score_impact: 4,
      confidence: 0.3,
      source: "georisques",
      evidence: ["Donnée radon indisponible (API)"],
    });
  }

  // CATNAT
  if (ensure("catnat")) {
    const arr = results?.catnat?.data ?? results?.catnat?.results ?? results?.catnat ?? [];
    const count = Array.isArray(arr) ? arr.length : (typeof arr?.results === "number" ? arr.results : 0);

    let penalty = 0;
    let sev: RiskSeverity = "low";
    if (count === 0) { penalty = 0; sev = "low"; }
    else if (count <= 2) { penalty = 6; sev = "moderate"; }
    else if (count <= 5) { penalty = 12; sev = "moderate"; }
    else if (count <= 10) { penalty = 20; sev = "high"; }
    else { penalty = 30; sev = "high"; }

    items.push({
      key: "catnat",
      label: "Historique CatNat",
      severity: sev,
      score_impact: penalty,
      confidence: 0.8,
      source: "georisques",
      evidence: [`Arrêtés CatNat (rayon): ${count}`],
      raw: results?.catnat,
    });
  } else {
    items.push({
      key: "catnat",
      label: "Historique CatNat",
      severity: "unknown",
      score_impact: 3,
      confidence: 0.3,
      source: "georisques",
      evidence: ["Donnée CatNat indisponible (API)"],
    });
  }

  // RISQUES
  if (ensure("risques")) {
    const payload = results?.risques;
    const list =
      payload?.data ??
      payload?.risques ??
      payload?.results ??
      (Array.isArray(payload) ? payload : []);

    const labels: string[] = [];
    if (Array.isArray(list)) {
      for (const it of list) {
        const label = it?.libelle ?? it?.label ?? it?.nom ?? it?.type ?? null;
        if (label) labels.push(String(label).toLowerCase());
      }
    }

    let penalty = 0;
    const add = (p: number) => { penalty += p; };
    const has = (needle: string) => labels.some((x) => x.includes(needle));

    if (has("inond")) add(18);
    if (has("argile") || has("retrait") || has("gonf")) add(12);
    if (has("cavit")) add(14);
    if (has("mouvement") || has("glissement") || has("eboulement")) add(16);
    if (has("sism")) add(6);
    if (has("feu") || has("incendie")) add(10);
    if (has("submersion") || has("littoral")) add(20);
    if (has("avalan")) add(20);

    penalty = Math.min(penalty, 45);

    let sev: RiskSeverity = "low";
    if (penalty >= 30) sev = "high";
    else if (penalty >= 15) sev = "moderate";

    items.push({
      key: "risques",
      label: "Exposition aux risques",
      severity: sev,
      score_impact: penalty,
      confidence: 0.75,
      source: "georisques",
      evidence: [
        labels.length
          ? `Risques détectés: ${[...new Set(labels)].slice(0, 6).join(", ")}`
          : "Aucun risque typé détecté",
      ],
      raw: results?.risques,
    });
  } else {
    items.push({
      key: "risques",
      label: "Exposition aux risques",
      severity: "unknown",
      score_impact: 3,
      confidence: 0.3,
      source: "georisques",
      evidence: ["Donnée risques indisponible (API)"],
    });
  }

  // PPR (accept either ppr_latlon or ppr_code_insee)
  const pprOk =
    (typeof status?.ppr_latlon === "number" && status.ppr_latlon >= 200 && status.ppr_latlon < 300) ||
    (typeof status?.ppr_code_insee === "number" && status.ppr_code_insee >= 200 && status.ppr_code_insee < 300);

  if (pprOk) {
    const pprPayload = results?.ppr_latlon ?? results?.ppr_code_insee;
    const pprList =
      pprPayload?.data ??
      pprPayload?.results ??
      (Array.isArray(pprPayload) ? pprPayload : []);

    const count = Array.isArray(pprList) ? pprList.length : 0;
    const text = JSON.stringify(pprList).toLowerCase();

    let penalty = 0;
    let sev: RiskSeverity = "low";
    let ev = "Aucun PPR identifié";

    if (count > 0) {
      ev = `PPR identifié (${count})`;
      if (text.includes("inond")) penalty = 30;
      else if (text.includes("techno")) penalty = 30;
      else if (text.includes("mouvement") || text.includes("glissement")) penalty = 25;
      else if (text.includes("multi")) penalty = 35;
      else penalty = 22;

      sev = penalty >= 30 ? "high" : "moderate";
    }

    items.push({
      key: "ppr",
      label: "PPR (réglementaire)",
      severity: sev,
      score_impact: penalty,
      confidence: 0.85,
      source: "georisques",
      evidence: [ev],
      raw: pprPayload,
    });
  } else {
    missing.push("ppr");
    items.push({
      key: "ppr",
      label: "PPR (réglementaire)",
      severity: "unknown",
      score_impact: 3,
      confidence: 0.3,
      source: "georisques",
      evidence: ["Donnée PPR indisponible (API)"],
    });
  }

  const base = 100;
  const penalties = items.reduce((s, it) => s + (Number.isFinite(it.score_impact) ? it.score_impact : 0), 0);

  const missingMajor = ["catnat", "risques", "ppr"].filter((k) => missing.includes(k)).length;
  const prudencePenalty = Math.min(10, missingMajor * 3);

  const score = clamp(base - penalties - prudencePenalty, 0, 100);
  const { grade, label: level_label } = gradeFromScore(score);

  const avgConf = items.reduce((s, it) => s + it.confidence, 0) / Math.max(1, items.length);
  const confidence = clamp(avgConf - missingMajor * 0.12, 0.1, 1);

  const rationale: string[] = [];
  const top = [...items].sort((a, b) => b.score_impact - a.score_impact).slice(0, 3);
  for (const it of top) {
    if (it.score_impact > 0) {
      rationale.push(`${it.label} : impact ${it.score_impact}/100 (${it.severity}).`);
    }
  }
  if (missingMajor > 0) {
    rationale.push(
      `Certaines données sont indisponibles (${["catnat", "risques", "ppr"].filter((k) => missing.includes(k)).join(", ")}), score appliqué de manière prudente.`,
    );
  }

  return {
    score,
    grade,
    level_label,
    items,
    missing: [...new Set(missing)],
    confidence,
    rationale,
  };
}

serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const input = (await req.json()) as Input;
    const dossierId = (input?.dossierId ?? "").trim();
    if (!dossierId) return json({ error: "Missing dossierId" }, 400);

    const persist = input.persist !== false;
    const rayon_m = typeof input.rayon_m === "number" ? input.rayon_m : 1000;
    const ttlSeconds = typeof input.ttl_seconds === "number" ? input.ttl_seconds : 86400;
    const debug = input.debug === true;

    const { data: dossier, error: dossierErr } = await supabase
      .from("banque_dossiers")
      .select("id, lat, lng, adresse, commune_insee, parcelle_id")
      .eq("id", dossierId)
      .single();

    if (dossierErr || !dossier) {
      return json({ error: "Dossier not found", details: dossierErr }, 404);
    }

    let lat: number | null = (typeof input.lat === "number" ? input.lat : dossier.lat) ?? null;
    let lng: number | null = (typeof input.lng === "number" ? input.lng : dossier.lng) ?? null;

    const adresse = (input.adresse ?? dossier.adresse ?? "").trim();
    const parcel_id = (input.parcel_id ?? dossier.parcelle_id ?? "").trim();

    const resolution: any = { mode: null };
    let code_insee: string | null = null;

    const dossierInsee = safeInsee(dossier.commune_insee);
    if (dossierInsee) {
      resolution.insee_dossier = { source: "dossier", code_insee: dossierInsee };
    }

    if ((lat == null || lng == null || !code_insee) && adresse) {
      const geo = await resolveLatLngFromAddress(adresse);
      resolution.mode = "geopf_search";
      resolution.geocode = geo;

      if (geo.ok) {
        lat = lat ?? geo.lat;
        lng = lng ?? geo.lon;

        const inseeFromGeo = safeInsee(geo.citycode);
        if (inseeFromGeo) {
          code_insee = inseeFromGeo;
          resolution.insee = {
            source: "geopf_search",
            code_insee,
            citycode: geo.citycode ?? null,
            postcode: geo.postcode ?? null,
            label: geo.label ?? null,
          };
        }
      }
    }

    if ((lat == null || lng == null || !code_insee) && parcel_id) {
      const par = await resolveLatLngFromParcel(parcel_id);
      resolution.mode = "cadastre";
      resolution.cadastre = par;

      if (par.ok) {
        lat = lat ?? par.lat;
        lng = lng ?? par.lon;

        const inseeFromParcel = safeInsee(par.commune_insee);
        if (inseeFromParcel) {
          code_insee = inseeFromParcel;
          resolution.insee = { source: "parcel_id", code_insee };
        }
      }
    }

    if (lat != null && lng != null && !code_insee) {
      const rev = await resolveInseeFromLatLng(lat, lng);
      resolution.reverse = rev;

      if (rev.ok) {
        const inseeFromRev = safeInsee(rev.citycode);
        if (inseeFromRev) {
          code_insee = inseeFromRev;
          resolution.insee = {
            source: "geopf_reverse",
            code_insee,
            citycode: rev.citycode ?? null,
            postcode: rev.postcode ?? null,
            label: rev.label ?? null,
          };
        }
      }
    }

    if (!code_insee && dossierInsee) {
      code_insee = dossierInsee;
      resolution.insee = { source: "dossier_fallback", code_insee };
    }

    if (lat == null || lng == null) {
      return json(
        { error: "Missing lat/lng. Provide lat/lng, or set adresse/parcel_id, or store them on dossier.", resolution },
        400,
      );
    }

    const requestObj = { dossierId, lat, lng, rayon_m, code_insee };
    const key = cacheKey({ v: 8, lat, lng, rayon_m, code_insee });

    const cached = await cacheGet("georisques", key);
    if (cached) {
      return json({ dossierId, risks: cached, cached: true, persisted: false });
    }

    const candidates = buildCandidates({ lat, lng, rayon_m, code_insee, debug });

    const results: Record<string, unknown> = {};
    const statusByKey: Record<string, number> = {};
    const debugRaw: Record<string, string | null> = {};

    for (const c of candidates) {
      const r = await fetchJson(c.url);
      results[c.key] = r.json ?? null;
      statusByKey[c.key] = r.status;
      debugRaw[c.key] = r.raw ? r.raw.slice(0, 3000) : null;
    }

    const risks = {
      provider: "georisques",
      mode: "resolved",
      input: { lat, lng, rayon_m, adresse: adresse || null, parcel_id: parcel_id || null, code_insee },
      resolution,
      endpoints: Object.fromEntries(candidates.map((c) => [c.key, c.url])),
      results,
      status: statusByKey,
      debug_raw: debugRaw,
      computed_at: new Date().toISOString(),
    };

    const scoring = scoreRisksV1(risks);
    const risksWithScore = { ...risks, scoring };

    await cachePut("georisques", key, requestObj, risksWithScore, 200, ttlSeconds);

    if (persist) {
      const { error: upErr } = await supabase
        .from("banque_dossiers")
        .update({
          risks_data: risksWithScore,
          commune_insee: code_insee ?? dossier.commune_insee,
          updated_at: new Date().toISOString(),
        })
        .eq("id", dossierId);

      if (upErr) return json({ error: "Persist failed", details: upErr }, 500);
    }

    return json({ dossierId, risks: risksWithScore, cached: false, persisted: persist });
  } catch (e) {
    return json({ error: "Unhandled error", details: String(e) }, 500);
  }
});
