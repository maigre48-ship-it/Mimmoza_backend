// supabase/functions/market-study-v1/data/fetchTransport.ts
import type { MarketStudyRequest, TransportData } from "../types/market.types.ts";

/**
 * fetchTransport
 *
 * - Appelle la function interne `transport-nearby-v1` si disponible
 * - Utilise SUPABASE_URL (prod) ou localhost (dev)
 * - Authentification via service_role si présent
 * - Retourne null si non disponible / non couvert / erreur
 * - Fournit un source.provider explicite (utile pour debug & UI)
 */
export async function fetchTransport(
  req: MarketStudyRequest,
): Promise<TransportData | null> {
  try {
    // ------------------------------------------------------------
    // 1) Résolution de l'URL de la function transport
    // ------------------------------------------------------------
    const baseUrl =
      (Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "")) ||
      "http://127.0.0.1:54321";

    const url = `${baseUrl}/functions/v1/transport-nearby-v1`;

    // ------------------------------------------------------------
    // 2) Auth serveur (service role prioritaire)
    // ------------------------------------------------------------
    const serviceRole = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (serviceRole && serviceRole.length > 20) {
      headers["apikey"] = serviceRole;
      headers["Authorization"] = `Bearer ${serviceRole}`;
    }

    // ------------------------------------------------------------
    // 3) Payload (radius_km cohérent avec ton modèle)
    // ------------------------------------------------------------
    const body = {
      lat: Number(req.lat),
      lon: Number(req.lon),
      radius_km: req.radius_km ?? 5,
      limit: 20,
    };

    // Hard-guard
    if (!Number.isFinite(body.lat) || !Number.isFinite(body.lon)) {
      return null;
    }

    // ------------------------------------------------------------
    // 4) Appel
    // ------------------------------------------------------------
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      return null;
    }

    const data = await r.json().catch(() => null);
    if (!data || typeof data !== "object") return null;

    // ------------------------------------------------------------
    // 5) Extraction robuste du score (⚠️ 0 est un score valide)
    // ------------------------------------------------------------
    const scoreCandidate =
      (data as any)?.transport?.score ??
      (data as any)?.score ??
      (data as any)?.market?.transport?.score ??
      null;

    const score = typeof scoreCandidate === "number" ? scoreCandidate : null;

    // ------------------------------------------------------------
    // 6) Normalisation TransportData
    // ------------------------------------------------------------
    const details = data as any;

    const rpcProvider =
      details?.source?.provider ? String(details.source.provider) : "unknown";

    return {
      score,
      details,
      source: {
        provider: `transport-nearby-v1/${rpcProvider}`,
        dataset: "transport-nearby-v1",
      },
    };
  } catch {
    return null;
  }
}
