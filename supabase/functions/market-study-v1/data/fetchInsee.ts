// supabase/functions/market-study-v1/data/fetchInsee.ts
import type { MarketStudyRequest, InseeData } from "../types/market.types.ts";

function pickFirstString(...vals: any[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length) return v.trim();
  }
  return null;
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(",", ".").trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toIntOrNull(v: any): number | null {
  const n = toNumberOrNull(v);
  if (n === null) return null;
  const i = Math.trunc(n);
  return Number.isFinite(i) ? i : null;
}

function supabaseFunctionsBaseUrl(): string {
  const base = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  if (!base) throw new Error("Missing SUPABASE_URL env");
  return `${base}/functions/v1`;
}

/**
 * IMPORTANT:
 * On autorise un override de clé via req._supabase_key (forward depuis market-study-v1),
 * car c’est le moyen le plus fiable d’appeler market-context-v1 depuis une Edge Function.
 */
function supabaseKeyFromReq(req: any): string {
  const forwarded = typeof req?._supabase_key === "string" ? req._supabase_key.trim() : "";
  if (forwarded) return forwarded;

  const key =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY") ??
    "";
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY env");
  return key;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; status: number; data: any | null; text?: string | null }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });

    const contentType = r.headers.get("content-type") ?? "";
    let data: any | null = null;
    let text: string | null = null;

    if (contentType.includes("application/json")) {
      data = await r.json().catch(() => null);
    } else {
      text = await r.text().catch(() => null);
      if (text && text.trim().startsWith("{")) {
        try {
          data = JSON.parse(text);
        } catch {
          // ignore
        }
      }
    }

    return { ok: r.ok, status: r.status, data, text };
  } catch {
    return { ok: false, status: 0, data: null, text: null };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Politique INSEE (fix):
 * - reverse renvoie parfois un code d'arrondissement (ex: 75114).
 * - market-context-v1 renvoie la commune (ex: 75056) dans:
 *     - data.insee.code_commune
 *     - et/ou data.marketContext.location.inseeCode
 *
 * Stratégie:
 * 1) Reverse -> zip/city + citycodeReverse (arr)
 * 2) market-context-v1 -> commune (prioritaire)
 * 3) si market-context échoue -> fallback reverse
 *
 * NOTE IMPORTANTE:
 * Appel Edge Function -> Edge Function:
 * - Authorization: Bearer <key>
 * - apikey: <key>
 * Ici, <key> = req._supabase_key (si fourni) sinon env service_role/anon.
 */
export async function fetchInsee(req: MarketStudyRequest): Promise<InseeData | null> {
  try {
    const lat = toNumberOrNull((req as any)?.lat);
    const lon = toNumberOrNull((req as any)?.lon);
    if (lat === null || lon === null) return null;

    const debug = (req as any)?.debug === true;

    // 1) Reverse (pour zip/city + arrondissement fallback)
    const revUrl =
      `https://api-adresse.data.gouv.fr/reverse/?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lon))}&limit=1`;

    const rev = await fetchJson(
      revUrl,
      { method: "GET", headers: { accept: "application/json" } },
      10_000,
    );

    const feat = rev.data?.features?.[0];
    const props = feat?.properties ?? {};

    const zipCode = pickFirstString(props.postcode, props.postalcode);
    const city = pickFirstString(props.city, props.name, props.municipality, props.label);
    const citycodeReverse = pickFirstString(props.citycode); // ex: 75114

    if (!zipCode || !city) {
      if (debug) console.warn("[fetchInsee] reverse missing zip/city", { status: rev.status, props });
      return null;
    }

    // Minimal fallback reverse
    const minimal: InseeData = {
      code_commune: citycodeReverse ?? null,
      commune: city,
      departement: citycodeReverse?.slice(0, 2) ?? null,

      population: null,
      densite: null,
      evolution_pop_5ans: null,

      revenu_median: null,
      taux_chomage: null,

      pct_moins_15: null,
      pct_moins_25: null,
      pct_15_29: null,
      pct_25_39: null,
      pct_30_44: null,
      pct_45_59: null,
      pct_plus_60: null,
      pct_plus_65: null,
      pct_plus_75: null,
      pct_plus_85: null,

      evolution_75_plus_5ans: null,

      source: { provider: "api-adresse", dataset: "reverse" },
    };

    // 2) Appel market-context-v1 (commune)
    const mcUrl = `${supabaseFunctionsBaseUrl()}/market-context-v1`;
    const key = supabaseKeyFromReq(req as any);

    const mc = await fetchJson(
      mcUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${key}`,
          apikey: key,
        },
        body: JSON.stringify({ zipCode, city, lat, lon, debug }),
      },
      15_000,
    );

    if (!mc.ok || !mc.data) {
      if (debug) console.warn("[fetchInsee] market-context-v1 failed", { status: mc.status, text: mc.text ?? null });
      return minimal;
    }

    // ✅ Chemins corrects depuis market-context-v1
    const mcInsee = mc.data?.insee ?? null;

    const codeCommuneFromObj = pickFirstString(
      mcInsee?.code_commune,
      mcInsee?.commune_insee,
      mcInsee?.code,
    );

    const codeCommuneFromLocation = pickFirstString(
      mc.data?.marketContext?.location?.inseeCode,
      mc.data?.marketContext?.location?.insee_code,
    );

    const codeCommune = codeCommuneFromObj ?? codeCommuneFromLocation ?? null;

    if (!codeCommune) {
      if (debug) console.warn("[fetchInsee] market-context-v1 returned no commune code", { keys: Object.keys(mc.data ?? {}) });
      return minimal;
    }

    const communeName = pickFirstString(
      mcInsee?.commune,
      mcInsee?.nom_commune,
      mc.data?.marketContext?.location?.city,
      city,
    );

    const departement = pickFirstString(
      mcInsee?.departement,
      mcInsee?.nom_departement,
      codeCommune.slice(0, 2),
    );

    const out: InseeData = {
      code_commune: codeCommune,
      commune: communeName,
      departement: departement,

      population: toIntOrNull(mcInsee?.population ?? mcInsee?.pop),
      densite: toNumberOrNull(mcInsee?.densite),
      evolution_pop_5ans: toNumberOrNull(mcInsee?.evolution_pop_5ans ?? mcInsee?.evo_pop_5ans),

      revenu_median: toNumberOrNull(mcInsee?.revenu_median ?? mcInsee?.rev_median),
      taux_chomage: toNumberOrNull(mcInsee?.taux_chomage ?? mcInsee?.chomage),

      pct_moins_15: toNumberOrNull(mcInsee?.pct_moins_15),
      pct_moins_25: toNumberOrNull(mcInsee?.pct_moins_25),
      pct_15_29: toNumberOrNull(mcInsee?.pct_15_29),
      pct_25_39: toNumberOrNull(mcInsee?.pct_25_39),
      pct_30_44: toNumberOrNull(mcInsee?.pct_30_44),
      pct_45_59: toNumberOrNull(mcInsee?.pct_45_59),
      pct_plus_60: toNumberOrNull(mcInsee?.pct_plus_60),
      pct_plus_65: toNumberOrNull(mcInsee?.pct_plus_65),
      pct_plus_75: toNumberOrNull(mcInsee?.pct_plus_75),
      pct_plus_85: toNumberOrNull(mcInsee?.pct_plus_85),

      evolution_75_plus_5ans: toNumberOrNull(mcInsee?.evolution_75_plus_5ans),

      source: {
        provider: "market-context-v1",
        dataset: "insee",
        note: `FETCHINSEE_V5_FORWARD_KEY; reverse=${citycodeReverse ?? "null"}; commune=${codeCommune}`,
      } as any,
    };

    return out;
  } catch {
    return null;
  }
}
