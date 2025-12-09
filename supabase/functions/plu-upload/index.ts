// supabase/functions/plu-upload/index.ts
// Version : plu-upload-v1
// Objectif :
// - Recevoir un PDF de PLU (multipart/form-data)
// - Le stocker dans le bucket Storage "plu_raw"
// - Retourner { success, path }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Client service-role pour accéder au Storage
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return new Response(
        JSON.stringify({ success: false, error: "CONTENT_TYPE_MUST_BE_MULTIPART" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const formData = await req.formData();

    const file = formData.get("file");
    const communeInsee = (formData.get("commune_insee") ?? "").toString().trim();

    if (!(file instanceof File)) {
      return new Response(
        JSON.stringify({ success: false, error: "NO_FILE_PROVIDED" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!communeInsee) {
      return new Response(
        JSON.stringify({ success: false, error: "MISSING_COMMUNE_INSEE" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Lecture du fichier en bytes
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Chemin de stockage : 64065/2025-12-06T10-20-30-123Z-PLU-Ascain.pdf
    const now = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const path = `${communeInsee}/${now}-${safeName}`;

    const { error: uploadError } = await supabase
      .storage
      .from("plu_raw")
      .upload(path, bytes, {
        contentType: file.type || "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return new Response(
        JSON.stringify({ success: false, error: "UPLOAD_FAILED" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        version: "plu-upload-v1",
        path,
        commune_insee: communeInsee,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("plu-upload error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "PLU_UPLOAD_FAILED" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
