// supabase/functions/admin-geocode-stats/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

type Payload = {
  dep?: string; // ex: "02"
  limit?: number; // ex: 50
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseAllowedEmails(envVal: string | undefined): Set<string> {
  const s = String(envVal ?? "").trim();
  if (!s) return new Set();
  return new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const ANON_KEY =
      Deno.env.get("SUPABASE_ANON_KEY") ??
      Deno.env.get("SUPABASE_ANON_PUBLIC_KEY") ??
      "";
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      "";

    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
      return json(
        { success: false, error: "Missing env SUPABASE_URL / SUPABASE_ANON_KEY / SERVICE_ROLE_KEY" },
        500
      );
    }

    // ---- Auth: require user JWT + allowlisted email ----
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ success: false, error: "Missing Authorization Bearer token" }, 401);
    }

    const allowed = parseAllowedEmails(Deno.env.get("ADMIN_GEOCODE_EMAILS"));
    if (allowed.size === 0) {
      return json({ success: false, error: "ADMIN_GEOCODE_EMAILS not configured" }, 500);
    }

    const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabaseUser.auth.getUser();
    if (userErr || !userData?.user?.email) {
      return json({ success: false, error: "Unauthorized user" }, 401);
    }

    const email = userData.user.email.toLowerCase();
    if (!allowed.has(email)) {
      return json({ success: false, error: "Forbidden" }, 403);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    let body: Payload = {};
    if (req.method === "POST") {
      body = (await req.json().catch(() => ({}))) as Payload;
    }

    const dep = (body.dep ?? "").trim();
    const limit = Math.min(Math.max(Number(body.limit ?? 25), 1), 200);
    const depLike = dep ? `${dep}%` : null;

    const statuses = ["done", "skipped", "error", "todo"] as const;
    const counts: Record<string, number> = {};

    for (const s of statuses) {
      let q = supabaseAdmin
        .from("geocode_targets")
        .select("code_postal", { count: "exact", head: true })
        .eq("status", s);
      if (depLike) q = q.like("code_postal", depLike);
      const { count, error } = await q;
      if (error) return json({ success: false, error: `count ${s}: ${error.message}` }, 500);
      counts[s] = count ?? 0;
    }

    let recentQ = supabaseAdmin
      .from("geocode_targets")
      .select("code_postal, commune, status, last_error, last_ban_score, last_ban_label, updated_at")
      .in("status", ["skipped", "error"])
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (depLike) recentQ = recentQ.like("code_postal", depLike);

    const { data: recent, error: recentErr } = await recentQ;
    if (recentErr) return json({ success: false, error: recentErr.message }, 500);

    let geoQ = supabaseAdmin
      .from("dvf_addresses_geocoded")
      .select("code_postal", { count: "exact", head: true });
    if (depLike) geoQ = geoQ.like("code_postal", depLike);

    const { count: geocodedCount, error: gErr } = await geoQ;
    if (gErr) return json({ success: false, error: gErr.message }, 500);

    return json({
      success: true,
      scope: { dep: dep || "ALL" },
      counts,
      geocoded_count: geocodedCount ?? 0,
      recent: recent ?? [],
    });
  } catch (e) {
    return json({ success: false, error: String(e?.message ?? e) }, 500);
  }
});
