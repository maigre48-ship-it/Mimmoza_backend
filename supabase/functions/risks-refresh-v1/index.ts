import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * risks-refresh-v1 — Option 1 (audit strict)
 * - Persiste lat/lng + risks_data (jsonb)
 * - Utilise les endpoints GeoRisques qui existent (comme banque-risques-v1):
 *   - https://georisques.gouv.fr/api/v1/gaspar/catnat?latlon=lon,lat&rayon=m
 *   - https://georisques.gouv.fr/api/v1/gaspar/risques?latlon=lon,lat&rayon=m
 *   - https://georisques.gouv.fr/api/v1/ppr?latlon=lon,lat&rayon=m (+ code_insee)
 *   - https://georisques.gouv.fr/api/v1/radon?code_insee=xxxxx
 *   - https://georisques.gouv.fr/api/v1/installations_classees?lat=..&lon=..&rayon=..
 * - Flags "inondations/mvt_terrain/sismicite" sont déduits depuis gaspar/risques & ppr.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ✅ IMPORTANT: pas de "www." (c’est ce qui marchait dans banque-risques-v1)
const GEORISQUES_BASE = "https://georisques.gouv.fr/api/v1";
const BAN_BASE = "https://api-adresse.data.gouv.fr";

// Robustesse
const GEORISQUES_TIMEOUT_MS = 6000;
const GEORISQUES_RETRIES = 3;

type Input = {
  dossierId: string;
  adresse?: string;
  lat?: number;
  lng?: number;
  rayon_m?: number; // défaut 500
  debug?: boolean;
};

type RiskLevel = "faible" | "moyen" | "fort" | "inconnu" | "non_concerne";

type RiskItem = {
  key: string;
  label: string;
  level: RiskLevel;
  scoreImpact?: number;
  source?: string;
};

type RisksScoring = {
  score: number;
  grade: string;
  level_label: string;
  confidence?: number;
  rationale: string[];
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

// -------------------------
// Geocoding BAN (search + reverse)
// -------------------------
async function geocodeBan(adresse: string) {
  const url = new URL(`${BAN_BASE}/search/`);
  url.searchParams.set("q", adresse);
  url.searchParams.set("limit", "1");

  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`BAN geocode failed: ${r.status}`);
  const j = await r.json();

  const f = j?.features?.[0];
  const coords = f?.geometry?.coordinates; // [lng, lat]
  if (!coords || typeof coords[0] !== "number" || typeof coords[1] !== "number") {
    throw new Error("BAN: no result");
  }

  return {
    lng: coords[0],
    lat: coords[1],
    label: f?.properties?.label ?? adresse,
    citycode: f?.properties?.citycode ?? null,
    score: f?.properties?.score ?? null,
  };
}

async function reverseBan(lat: number, lng: number) {
  const url = new URL(`${BAN_BASE}/reverse/`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("limit", "1");

  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`BAN reverse failed: ${r.status}`);
  const j = await r.json();

  const f = j?.features?.[0];
  const citycode = f?.properties?.citycode ?? null;

  return {
    citycode: typeof citycode === "string" ? citycode : null,
    label: f?.properties?.label ?? null,
  };
}

// -------------------------
// Robust fetch (timeout + retry + debug body)
// -------------------------
async function fetchWithTimeout(url: string, timeoutMs: number) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal, headers: { Accept: "application/json" } });
  } finally {
    clearTimeout(t);
  }
}

async function safeReadText(r: Response) {
  try {
    return await r.text();
  } catch {
    return null;
  }
}

async function fetchJsonWithRetryDetailed(
  url: string,
  tries: number,
  timeoutMs: number,
): Promise<{ ok: true; data: any } | { ok: false; error: any }> {
  let lastErr: any = null;

  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchWithTimeout(url, timeoutMs);

      if (r.ok) {
        const data = await r.json();
        return { ok: true, data };
      }

      const bodyText = await safeReadText(r);
      const errObj = {
        kind: "http",
        status: r.status,
        statusText: r.statusText,
        body: bodyText,
      };
      lastErr = errObj;

      // retry only on 429/5xx
      if (!(r.status === 429 || (r.status >= 500 && r.status <= 599))) {
        return { ok: false, error: errObj };
      }
    } catch (e) {
      lastErr = {
        kind: "network",
        message: (e as Error)?.message ?? String(e),
      };
    }

    await new Promise((res) => setTimeout(res, 250 * (i + 1)));
  }

  return { ok: false, error: lastErr ?? { kind: "unknown", message: "fetch failed" } };
}

// -------------------------
// GeoRisques fetch — endpoints existants
// -------------------------
async function fetchGeoRisques(opts: {
  lat: number;
  lng: number;
  rayon_m: number;
  code_insee: string | null;
}) {
  const { lat, lng, rayon_m, code_insee } = opts;
  const latlon = `${lng},${lat}`;

  const candidates: Array<{ key: string; url: string }> = [
    {
      key: "catnat",
      url: `${GEORISQUES_BASE}/gaspar/catnat?latlon=${encodeURIComponent(latlon)}&rayon=${encodeURIComponent(
        String(rayon_m),
      )}`,
    },
    {
      key: "risques",
      url: `${GEORISQUES_BASE}/gaspar/risques?latlon=${encodeURIComponent(latlon)}&rayon=${encodeURIComponent(
        String(rayon_m),
      )}`,
    },
    {
      key: "ppr_latlon",
      url: `${GEORISQUES_BASE}/ppr?latlon=${encodeURIComponent(latlon)}&rayon=${encodeURIComponent(
        String(rayon_m),
      )}`,
    },
    {
      key: "installations_classees",
      // ⚠️ cet endpoint accepte lat/lon/rayon (comme tu l’as vu)
      url: `${GEORISQUES_BASE}/installations_classees?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(
        String(lng),
      )}&rayon=${encodeURIComponent(String(rayon_m))}`,
    },
  ];

  if (code_insee) {
    candidates.push({
      key: "radon",
      url: `${GEORISQUES_BASE}/radon?code_insee=${encodeURIComponent(code_insee)}`,
    });
    candidates.push({
      key: "ppr_code_insee",
      url: `${GEORISQUES_BASE}/ppr?code_insee=${encodeURIComponent(code_insee)}`,
    });
  } else {
    candidates.push({
      key: "radon",
      url: `${GEORISQUES_BASE}/radon`, // pour debug (répondra 400)
    });
  }

  const out: Record<string, unknown> = {};

  for (const c of candidates) {
    const res = await fetchJsonWithRetryDetailed(c.url, GEORISQUES_RETRIES, GEORISQUES_TIMEOUT_MS);
    if (res.ok) {
      out[c.key] = res.data;
      continue;
    }
    out[c.key] = { error: true, url: c.url, detail: res.error };
  }

  return out;
}

// -------------------------
// Summary + flags (déduits depuis gaspar/risques & ppr)
// -------------------------
function buildStableSummary(raw: Record<string, unknown>) {
  const summary: any = { flags: {}, counts: {}, levels: {} };

  // flags "api ok/err"
  const flagFrom = (v: any) => (v?.error ? "error" : "ok");

  summary.flags.catnat = flagFrom(raw.catnat);
  summary.flags.risques = flagFrom(raw.risques);
  summary.flags.ppr = flagFrom(raw.ppr_latlon) === "ok" || flagFrom(raw.ppr_code_insee) === "ok" ? "ok" : "error";
  summary.flags.radon = flagFrom(raw.radon);
  summary.flags.installations_classees = flagFrom(raw.installations_classees);

  // helper: extract text list from gaspar/risques
  const riskLabels: string[] = [];
  try {
    const payload: any = raw.risques;
    const data0 = payload?.data?.[0];
    const details = data0?.risques_detail ?? [];
    for (const d of details) {
      const lbl =
        d?.libelle_risque_long ??
        d?.libelle ??
        d?.label ??
        d?.nom ??
        null;
      if (lbl) riskLabels.push(String(lbl).toLowerCase());
    }
  } catch {
    // ignore
  }

  const pprText = (() => {
    try {
      const pprPayload: any = (raw.ppr_latlon && !(raw.ppr_latlon as any).error) ? raw.ppr_latlon : raw.ppr_code_insee;
      return JSON.stringify(pprPayload ?? "").toLowerCase();
    } catch {
      return "";
    }
  })();

  // ✅ Flags "métier" attendus par ton mapping (inondations, mvt_terrain, sismicite)
  // - si API risques/ppr en erreur => on marque "error" (audit strict)
  const risquesOk = summary.flags.risques === "ok";
  const pprOk = summary.flags.ppr === "ok";

  const has = (needle: string) => riskLabels.some((x) => x.includes(needle));
  const pprHas = (needle: string) => pprText.includes(needle);

  // Inondations
  if (!risquesOk && !pprOk) summary.flags.inondations = "error";
  else summary.flags.inondations = (has("inond") || pprHas("inond")) ? "present" : "none";

  // Mvt terrain
  if (!risquesOk && !pprOk) summary.flags.mvt_terrain = "error";
  else summary.flags.mvt_terrain = (has("mouvement") || has("glissement") || has("eboul") || pprHas("mouvement") || pprHas("glissement"))
    ? "present"
    : "none";

  // Sismicité
  if (!risquesOk) summary.flags.sismicite = "error";
  else summary.flags.sismicite = (has("sism")) ? "present" : "none";

  // Counts (indicatifs)
  summary.counts.catnat = (() => {
    const v: any = raw.catnat;
    if (v?.error) return null;
    if (Array.isArray(v?.data)) return v.data.length;
    if (typeof v?.results === "number") return v.results;
    return 0;
  })();

  summary.counts.risques = riskLabels.length;

  summary.counts.ppr = (() => {
    const v: any = (raw.ppr_latlon && !(raw.ppr_latlon as any).error) ? raw.ppr_latlon : raw.ppr_code_insee;
    if (!v || v?.error) return null;
    if (Array.isArray(v?.data)) return v.data.length;
    return 0;
  })();

  summary.counts.installations_classees = (() => {
    const v: any = raw.installations_classees;
    if (v?.error) return null;
    if (Array.isArray(v?.data)) return v.data.length;
    if (typeof v?.results === "number") return v.results;
    return 0;
  })();

  // Levels radon si possible
  try {
    const rad: any = raw.radon;
    if (!rad?.error) {
      const classe = rad?.data?.[0]?.classe_potentiel ?? null;
      // conserve string, on transformera plus bas si besoin
      summary.levels.radon = classe != null ? String(classe) : null;
    }
  } catch {
    // ignore
  }

  // risk_score (simple)
  let penalty = 0;
  const flags = summary.flags;
  for (const k of ["inondations", "mvt_terrain", "sismicite", "radon"] as const) {
    if (flags[k] === "present") penalty += 8;
    if (flags[k] === "error") penalty += 2;
  }
  summary.risk_score = Math.max(0, 100 - penalty);

  return summary;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// Option 1: audit strict (error => inconnu)
function riskLevelFromFlagDefaultLow(flag: "present" | "none" | "error" | undefined): RiskLevel {
  if (flag === "present") return "moyen";
  if (flag === "none") return "faible";
  if (flag === "error") return "inconnu";
  return "faible";
}

function buildRisks16(summary: any): { risks: RiskItem[]; unknownKeys: string[] } {
  const base: Record<string, RiskItem> = {
    flood: { key: "flood", label: "Inondation", level: "faible", source: "georisques" },
    pollution: { key: "pollution", label: "Pollution", level: "faible", source: "georisques" },
    coastal_erosion: { key: "coastal_erosion", label: "Erosion cotiere", level: "non_concerne", source: "georisques" },
    mining: { key: "mining", label: "Mines / cavites", level: "faible", source: "georisques" },
    seismic: { key: "seismic", label: "Sismicite", level: "faible", source: "georisques" },
    landslide: { key: "landslide", label: "Mouvement de terrain", level: "faible", source: "georisques" },
    industrial: { key: "industrial", label: "Risque industriel (ICPE)", level: "faible", source: "georisques" },
    clay_shrinkage: { key: "clay_shrinkage", label: "Retrait-gonflement argiles", level: "faible", source: "georisques" },
    wildfire: { key: "wildfire", label: "Feux de foret", level: "faible", source: "georisques" },
    avalanche: { key: "avalanche", label: "Avalanche", level: "non_concerne", source: "georisques" },
    radon: { key: "radon", label: "Radon", level: "faible", source: "georisques" },
    noise: { key: "noise", label: "Bruit", level: "faible", source: "georisques" },
    storm: { key: "storm", label: "Tempete", level: "faible", source: "georisques" },
    technological: { key: "technological", label: "Risque technologique", level: "faible", source: "georisques" },
    dam_failure: { key: "dam_failure", label: "Rupture de barrage", level: "faible", source: "georisques" },
    volcanic: { key: "volcanic", label: "Volcanisme", level: "non_concerne", source: "georisques" },
  };

  base.flood.level = riskLevelFromFlagDefaultLow(summary?.flags?.inondations);
  base.landslide.level = riskLevelFromFlagDefaultLow(summary?.flags?.mvt_terrain);
  base.seismic.level = riskLevelFromFlagDefaultLow(summary?.flags?.sismicite);

  // radon: si niveau connu
  const radonC = summary?.levels?.radon;
  if (typeof radonC === "string") {
    if (radonC === "1") base.radon.level = "faible";
    else if (radonC === "2") base.radon.level = "moyen";
    else if (radonC === "3") base.radon.level = "fort";
  } else {
    base.radon.level = riskLevelFromFlagDefaultLow(summary?.flags?.radon);
  }

  // industrial: si ICPE présent
  base.industrial.level = (summary?.flags?.installations_classees === "ok" && (summary?.counts?.installations_classees ?? 0) > 0)
    ? "moyen"
    : "faible";

  const risks = Object.values(base);

  const impact = (lvl: RiskLevel) => {
    if (lvl === "faible") return 0;
    if (lvl === "moyen") return -6;
    if (lvl === "fort") return -14;
    if (lvl === "inconnu") return -6;
    return 0;
  };
  for (const r of risks) r.scoreImpact = impact(r.level);

  const unknownKeys = risks.filter((r) => r.level === "inconnu").map((r) => r.key);
  return { risks, unknownKeys };
}

function buildRisksScoring(
  risks: RiskItem[],
  summaryRiskScore?: number,
  unknownKeys?: string[],
): RisksScoring {
  let penalty = 0;
  const rationale: string[] = [];

  for (const r of risks) {
    if (r.level === "fort") {
      penalty += 12;
      rationale.push(`${r.label}: niveau fort`);
    } else if (r.level === "moyen") {
      penalty += 6;
      rationale.push(`${r.label}: niveau moyen`);
    } else if (r.level === "inconnu") {
      penalty += 6;
      rationale.push(`${r.label}: niveau inconnu (donnees indisponibles)`);
    }
  }

  const base = typeof summaryRiskScore === "number" ? summaryRiskScore : 100;
  const score = clamp(Math.round(base - penalty), 0, 100);

  let grade = "C";
  let level_label = "Risque modere";
  if (score >= 80) { grade = "A"; level_label = "Risque faible"; }
  else if (score >= 65) { grade = "B"; level_label = "Risque plutot faible"; }
  else if (score >= 45) { grade = "C"; level_label = "Risque modere"; }
  else { grade = "D"; level_label = "Risque eleve"; }

  const unk = Array.isArray(unknownKeys) ? unknownKeys : [];
  if (unk.length) {
    rationale.unshift(`Couverture partielle: ${unk.length} risque(s) indisponible(s): ${unk.join(", ")}`);
  }

  const trimmed = rationale.slice(0, 12);
  if (!trimmed.length) trimmed.push("Aucun signal fort detecte");

  return {
    score,
    grade,
    level_label,
    confidence: 0.75,
    rationale: trimmed,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    const input = (await req.json()) as Input;
    if (!input?.dossierId) return json({ error: "dossierId required" }, 400);

    const rayon_m = input.rayon_m ?? 500;

    // 1) Charger dossier pour récupérer commune_insee (radon) + éventuelle adresse
    const { data: dossier } = await supabase
      .from("banque_dossiers")
      .select("id, commune_insee, adresse")
      .eq("id", input.dossierId)
      .maybeSingle();

    // 2) Résoudre lat/lng
    let lat = input.lat ?? null;
    let lng = input.lng ?? null;
    let adresse_normalisee: string | null = null;

    const adresse = (input.adresse ?? dossier?.adresse ?? "").trim();
    if ((!lat || !lng) && adresse) {
      const g = await geocodeBan(adresse);
      lat = g.lat;
      lng = g.lng;
      adresse_normalisee = g.label;
    }

    if (!lat || !lng) return json({ error: "lat/lng missing (or adresse)" }, 400);

    // 3) Résoudre code_insee (priorité: dossier.commune_insee, sinon BAN reverse)
    let code_insee: string | null =
      typeof dossier?.commune_insee === "string" && dossier.commune_insee.trim()
        ? dossier.commune_insee.trim()
        : null;

    if (!code_insee) {
      try {
        const rev = await reverseBan(lat, lng);
        if (rev.citycode) code_insee = rev.citycode;
      } catch {
        // ignore
      }
    }

    // 4) Fetch GeoRisques (endpoints existants)
    const raw = await fetchGeoRisques({ lat, lng, rayon_m, code_insee });
    const summary = buildStableSummary(raw);

    // 5) Normalisation + scoring
    const { risks, unknownKeys } = buildRisks16(summary);
    const scoring = buildRisksScoring(risks, summary?.risk_score, unknownKeys);

    const risks_data = {
      version: "v1",
      computed_at: new Date().toISOString(),
      location: { lat, lng, rayon_m, adresse_normalisee, code_insee },
      summary,
      risks,
      scoring,
      raw,
      coverage: {
        unknown_keys: unknownKeys,
        known_layers: Object.keys(summary?.flags ?? {}),
      },
    };

    // 6) Persist + pro: détecter si 0 row updated
    const { data: updated, error: upErr } = await supabase
      .from("banque_dossiers")
      .update({
        lat,
        lng,
        adresse_normalisee,
        risks_data,
        risks_updated_at: new Date().toISOString(),
        risks_status: "ok",
      })
      .eq("id", input.dossierId)
      .select("id")
      .maybeSingle();

    if (upErr) throw upErr;
    if (!updated?.id) {
      return json(
        { ok: false, error: "Dossier introuvable (id non trouvé dans banque_dossiers)", dossierId: input.dossierId },
        404,
      );
    }

    return json({
      ok: true,
      dossierId: input.dossierId,
      lat,
      lng,
      scoring,
      summary: risks_data.summary,
      coverage: risks_data.coverage,
      ...(input.debug ? { raw: risks_data.raw, code_insee } : {}),
    });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
