import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.34.0";

function json(res: unknown, s=200) {
  return new Response(JSON.stringify(res), { status: s, headers: { "Content-Type":"application/json" }});
}

console.info('org_api function starting');
Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
  );

  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const path = parts[parts.length-1];

  try {
    if (req.method === "POST" && path === "create_org") {
      const { name, plan_code = "free" } = await req.json();
      const { data: userData } = await supabase.auth.getUser();
      const user = userData.user;
      if (!user) return json({ error: "unauthorized" }, 401);

      const { data: org, error } = await supabase
        .from("organisations").insert({ name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g,'-'), metadata: { plan: plan_code } }).select().single();
      if (error) throw error;
      return json({ org });
    }

    if (req.method === "POST" && path === "add_member") {
      const { organisation_id, user_id, role = "member" } = await req.json();
      // Vérif: caller est owner/admin
      const callerId = (await supabase.auth.getUser()).data.user?.id;
      const { data: me } = await supabase
        .from("organisation_members")
        .select("role")
        .eq("organisation_id", organisation_id)
        .eq("user_id", callerId)
        .single();
      if (!me || !["owner","admin"].includes(me.role)) return json({ error: "forbidden" }, 403);

      const { data, error } = await supabase
        .from("organisation_members").insert({ organisation_id, user_id, role }).select().single();
      if (error) throw error;
      return json({ membership: data });
    }

    if (req.method === "POST" && path === "transfer_owner") {
      const { organisation_id, new_owner_user_id } = await req.json();
      const callerId = (await supabase.auth.getUser()).data.user?.id;
      const { data: me } = await supabase
        .from("organisation_members")
        .select("role,user_id").eq("organisation_id", organisation_id).eq("user_id", callerId).single();
      if (!me || me.role !== "owner") return json({ error: "forbidden" }, 403);

      // Passer l’ancien owner en admin
      await supabase.from("organisation_members")
        .update({ role: "admin" }).eq("organisation_id", organisation_id).eq("user_id", me.user_id);
      const { error } = await supabase.from("organisation_members")
        .upsert({ organisation_id, user_id: new_owner_user_id, role: "owner" });
      if (error) throw error;
      return json({ ok: true });
    }

    if (req.method === "GET" && path === "my_orgs") {
      const { data, error } = await supabase
        .from("organisations")
        .select("id,name,metadata,created_at");
      if (error) throw error;
      return json({ organisations: data });
    }

    return json({ error: "not_found" }, 404);
  } catch (e: any) {
    return json({ error: e.message ?? String(e) }, 500);
  }
});