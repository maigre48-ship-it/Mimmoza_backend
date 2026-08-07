import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const TOKEN = Deno.env.get("GITHUB_TOKEN")!;
const OWNER = Deno.env.get("GITHUB_OWNER") ?? "maigre48-ship-it";
const REPO  = Deno.env.get("GITHUB_REPO")  ?? "Mimmoza_backend";
const REF   = Deno.env.get("GITHUB_REF")   ?? "main";

function withCORS(h = new Headers()) {
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return h;
}

serve(async (req) => {
  const headers = withCORS(new Headers({ "Content-Type": "application/json" }));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });

  try {
    if (!TOKEN) return new Response(JSON.stringify({ error: "Missing GITHUB_TOKEN" }), { status: 500, headers });

    const { email, password = "", email_confirmed = true } = await req.json();
    if (!email || typeof email !== "string")
      return new Response(JSON.stringify({ error: "email is required" }), { status: 400, headers });

    const ghUrl = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/create-supabase-user.yml/dispatches`;
    const body = { ref: REF, inputs: { email, password, email_confirmed: String(email_confirmed) } };

    const gh = await fetch(ghUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify(body),
    });

    if (!gh.ok) {
      const details = await gh.text();
      return new Response(JSON.stringify({ error: "GitHub API error", details }), { status: 502, headers });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 202, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Unhandled", details: String(e) }), { status: 500, headers });
  }
});
