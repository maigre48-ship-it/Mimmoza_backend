// supabase/functions/market-study-v1/data/fetchBpe.ts
import type { MarketStudyRequest, BpeData } from "../types/market.types.ts";

type BpeProxyItem = {
  type_code: string;
  nom: string;
  commune: string;
  code_commune: string;
  category?: string | null; // ✅ ajouté (v4.4 bpe-proxy renvoie category)
  latitude: number;
  longitude: number;
  distance_m: number;
};

type BpeProxyResponse = {
  success: boolean;
  items: BpeProxyItem[];
  error?: string;
  debug?: unknown;
  source?: unknown;
};

export type ForwardAuth = {
  apikey?: string;
  /** optional: some clients/gateways use x-api-key instead of apikey */
  x_api_key?: string;
  Authorization?: string;
};

/**
 * Corrige les textes “mojibake” les plus fréquents (UTF-8 décodé en Latin-1).
 */
function fixText(input: string): string {
  if (!input) return input;

  const looksBroken =
    /Ã.|Â.|â€™|â€œ|â€|â€“|â€”|â€¦|œ|”|€™/.test(input) || input.includes("Ã");
  if (!looksBroken) return input;

  try {
    const bytes = Uint8Array.from(input, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return input;
  }
}

/**
 * Bucket basé d’abord sur "category" (dataset ODS actuel),
 * puis fallback sur le préfixe de type_code.
 */
function bucketFromItem(
  it: BpeProxyItem,
):
  | "sante"
  | "commerces"
  | "services"
  | "enseignement"
  | "sport_culture"
  | "ignore" {
  const cat = fixText(String(it.category ?? "")).trim().toLowerCase();

  // ✅ mapping le plus fiable sur ton dataset ODS actuel
  if (cat) {
    if (cat.includes("sant")) return "sante";
    if (cat.includes("commerce")) return "commerces";
    if (cat.includes("service")) return "services";
    if (cat.includes("enseignement") || cat.includes("éducation") || cat.includes("education")) return "enseignement";
    if (cat.includes("sport") || cat.includes("culture")) return "sport_culture";
  }

  // fallback historique par code
  const tc = (it.type_code || "").toUpperCase().trim();
  if (tc === "A203") return "services"; // banque agence
  if (tc.startsWith("D")) return "sante";
  if (tc.startsWith("B")) return "commerces";
  if (tc.startsWith("A")) return "services";
  if (tc.startsWith("C")) return "enseignement";
  if (tc.startsWith("G") || tc.startsWith("H") || tc.startsWith("L")) return "sport_culture";

  return "ignore";
}

function makeDedupKey(it: BpeProxyItem): string {
  const type = String(it.type_code || "").trim().toUpperCase();
  const nom = fixText(String(it.nom || "").trim()).toUpperCase();
  const cc = String(it.code_commune || "").trim();
  const lat = Number(it.latitude);
  const lon = Number(it.longitude);
  return `${type}|${nom}|${cc}|${lat.toFixed(6)}|${lon.toFixed(6)}`;
}

/**
 * Base URL pour appeler des Edge Functions depuis une Edge Function.
 * - PROD: SUPABASE_URL (https://<ref>.supabase.co)
 * - LOCAL: http://127.0.0.1:54321
 */
function getFunctionsBaseUrl(): string {
  const envUrl = Deno.env.get("SUPABASE_URL");
  if (envUrl && envUrl.startsWith("http")) return envUrl.replace(/\/+$/, "");
  return "http://127.0.0.1:54321";
}

function getServerServiceRole(): string {
  return (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
}

/**
 * Résolution finale de l’auth :
 * 1) Service role (prioritaire)
 * 2) Auth entrante forwardée (fallback)
 */
function resolveAuth(forward?: ForwardAuth): { apikey?: string; Authorization?: string } {
  const service = getServerServiceRole();
  if (service && service.length > 20) {
    return { apikey: service, Authorization: `Bearer ${service}` };
  }
  const fwdApi = (forward?.apikey ?? forward?.x_api_key)?.trim();
  const fwdAuth = forward?.Authorization?.trim();
  return {
    apikey: fwdApi || undefined,
    Authorization: fwdAuth || undefined,
  };
}

function debugBpeData(provider: string): BpeData {
  return {
    nb_commerces: 0,
    nb_sante: 0,
    nb_services: 0,
    nb_enseignement: 0,
    nb_sport_culture: 0,
    source: {
      provider,
      dataset: "bpe",
      last_updated: null as unknown as string,
    },
  };
}

function toFiniteNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * fetchBpe:
 * - appelle /functions/v1/bpe-proxy
 * - convertit radius_km -> radius_m
 * - force service_role si dispo
 * - bucket par "category" si présent (meilleur sur ce dataset)
 */
export async function fetchBpe(
  req: MarketStudyRequest,
  opts?: { debug?: boolean; forwardAuth?: ForwardAuth },
): Promise<BpeData | null> {
  const debug = Boolean(opts?.debug);

  try {
    const baseUrl = getFunctionsBaseUrl();
    const url = `${baseUrl}/functions/v1/bpe-proxy`;

    const lat = toFiniteNumber((req as any)?.lat);
    const lon = toFiniteNumber((req as any)?.lon ?? (req as any)?.lng);
    const radiusKm = toFiniteNumber((req as any)?.radius_km);
    const radius_m = Math.round((radiusKm ?? 5) * 1000);

    if (lat == null || lon == null) {
      console.warn("[fetchBpe] invalid lat/lon", { lat, lon });
      return debug ? debugBpeData("bpe-proxy-bad-payload") : null;
    }

    // ✅ limite abaissée: bpe-proxy fait déjà early-stop; on évite des payloads énormes
    const body = {
      lat,
      lon,
      radius_m,
      limit: 200,
      ...(debug ? { debug: true } : {}),
    };

    const auth = resolveAuth(opts?.forwardAuth);

    if (debug) {
      console.warn("[fetchBpe] auth", {
        baseUrl,
        url,
        serviceLen: getServerServiceRole().length,
        fwd_apikey_len: opts?.forwardAuth?.apikey?.length ?? 0,
        fwd_x_api_key_len: opts?.forwardAuth?.x_api_key?.length ?? 0,
        fwd_auth_len: opts?.forwardAuth?.Authorization?.length ?? 0,
        use_apikey_len: auth.apikey?.length ?? 0,
        use_auth_len: auth.Authorization?.length ?? 0,
        radius_m,
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (auth.apikey) headers["apikey"] = auth.apikey;
    if (auth.Authorization) headers["Authorization"] = auth.Authorization;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const txt = await res.text().catch(() => "");

    if (!res.ok) {
      console.warn("[fetchBpe] HTTP error", res.status, txt.slice(0, 500));
      return debug ? debugBpeData(`bpe-proxy-http-${res.status}`) : null;
    }

    let payload: BpeProxyResponse | null = null;
    try {
      payload = JSON.parse(txt) as BpeProxyResponse;
    } catch (e) {
      console.warn("[fetchBpe] JSON parse error", String(e).slice(0, 120), txt.slice(0, 300));
      return debug ? debugBpeData("bpe-proxy-bad-json") : null;
    }

    if (!payload?.success || !Array.isArray(payload.items)) {
      console.warn("[fetchBpe] bad payload", payload);
      return debug ? debugBpeData("bpe-proxy-bad-payload") : null;
    }

    // Dédup + normalisation
    const seen = new Set<string>();
    const dedup: BpeProxyItem[] = [];

    for (const it of payload.items) {
      const key = makeDedupKey(it);
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push({
        ...it,
        nom: fixText(it.nom),
        commune: fixText(it.commune),
        category: it.category ? fixText(it.category) : it.category,
      });
    }

    let nb_commerces = 0;
    let nb_sante = 0;
    let nb_services = 0;
    let nb_enseignement = 0;
    let nb_sport_culture = 0;

    for (const it of dedup) {
      const bucket = bucketFromItem(it);
      if (bucket === "commerces") nb_commerces++;
      else if (bucket === "sante") nb_sante++;
      else if (bucket === "services") nb_services++;
      else if (bucket === "enseignement") nb_enseignement++;
      else if (bucket === "sport_culture") nb_sport_culture++;
    }

    return {
      nb_commerces,
      nb_sante,
      nb_services,
      nb_enseignement,
      nb_sport_culture,
      source: {
        provider: "supabase-function",
        dataset: "bpe",
        last_updated: null as unknown as string,
      },
    };
  } catch (e) {
    console.warn("[fetchBpe] exception", e);
    return debug ? debugBpeData(`bpe-exception:${String(e).slice(0, 80)}`) : null;
  }
}
