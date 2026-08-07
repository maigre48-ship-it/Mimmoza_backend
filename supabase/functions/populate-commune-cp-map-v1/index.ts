// supabase/functions/populate-commune-cp-map-v1/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEO_API = "https://geo.api.gouv.fr";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

function sb() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

function canonDepcom(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 5 ? s : null;
}

function pickCp(codesPostaux: unknown, depcom: string): string {
  const dept = depcom.slice(0, 2);
  const arr = Array.isArray(codesPostaux) ? codesPostaux : [];
  const cps = arr
    .map((x) => String(x || "").trim())
    .filter((x) => /^\d{5}$/.test(x));
  if (cps.length) return cps[0];
  return `${dept}000`; // fallback rare
}

async function fetchCodesPostaux(depcom: string): Promise<string[] | null> {
  const url =
    `${GEO_API}/communes/${encodeURIComponent(depcom)}?fields=codesPostaux&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = await res.json();
  const cps = data?.codesPostaux;
  if (!Array.isArray(cps)) return [];
  return cps.map((x: any) => String(x || "").trim());
}

type Payload = { limit?: number; dryRun?: boolean };

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);

  const t0 = Date.now();

  try {
    const payload = (await req.json().catch(() => ({}))) as Payload;
    const limit = Math.max(1, Math.min(Number(payload.limit ?? 300), 2000));
    const dryRun = !!payload.dryRun;

    const client = sb();

    // 1) depcom sources
    const depResp = await client
      .from("bpe_depcom_aggregates")
      .select("depcom")
      .order("depcom", { ascending: true })
      .limit(50000);

    const depErr = depResp?.error;
    if (depErr) return jsonResponse({ success: false, error: depErr.message }, 500);

    const depcoms = (depResp?.data ?? [])
      .map((r: any) => canonDepcom(r.depcom))
      .filter((x): x is string => !!x);

    // 2) existing map
    const mapResp = await client
      .from("commune_cp_map")
      .select("depcom, cp")
      .limit(200000);

    const mapErr = mapResp?.error;
    if (mapErr) return jsonResponse({ success: false, error: mapErr.message }, 500);

    const existing = new Map<string, string>();
    for (const r of mapResp?.data ?? []) {
      const d = canonDepcom((r as any).depcom);
      const cp = String((r as any).cp ?? "").trim();
      if (d) existing.set(d, cp);
    }

    const toProcess: string[] = [];
    for (const d of depcoms) {
      const cp = existing.get(d);
      if (!cp || cp.trim().length !== 5) toProcess.push(d);
      if (toProcess.length >= limit) break;
    }

    // 3) loop geo_api + upsert
    const results: { depcom: string; cp: string; ok: boolean; error?: string }[] = [];
    let okCount = 0;
    let failCount = 0;

    for (const depcom of toProcess) {
      try {
        const cps = await fetchCodesPostaux(depcom);
        const cp = pickCp(cps, depcom);

        if (!dryRun) {
          const upResp = await client
            .from("commune_cp_map")
            .upsert(
              {
                depcom,
                cp,
                source: "geo_api",
                computed_at: new Date().toISOString(),
              },
              { onConflict: "depcom" },
            );

          const upErr = upResp?.error;
          if (upErr) throw new Error(upErr.message);
        }

        results.push({ depcom, cp, ok: true });
        okCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ depcom, cp: "", ok: false, error: msg });
        failCount++;
      }
    }

    return jsonResponse({
      success: true,
      function: "populate-commune-cp-map-v1",
      processed: toProcess.length,
      ok: okCount,
      failed: failCount,
      dryRun,
      limit,
      elapsed_ms: Date.now() - t0,
      sample: results.slice(0, 25),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ success: false, error: msg }, 500);
  }
});