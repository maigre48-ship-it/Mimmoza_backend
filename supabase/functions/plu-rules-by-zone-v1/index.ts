import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface RequestBody {
  document_id: string;
  zone_code: string;
}

interface SuccessResponse {
  success: true;
  document_id: string;
  zone_code: string;
  zone_libelle: string | null;
  confidence_score: number | null;
  rules: Record<string, unknown>;
}

interface ErrorResponse {
  success: false;
  error: string;
  message: string;
}

serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Vérifier la méthode HTTP
  if (req.method !== "POST") {
    const errorResponse: ErrorResponse = {
      success: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Seule la méthode POST est autorisée",
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Vérifier les variables d'environnement (avec fallback MIMMOZA_*)
  const supabaseUrl =
    Deno.env.get("SUPABASE_URL") ??
    Deno.env.get("MIMMOZA_SUPABASE_URL");
  const supabaseServiceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("MIMMOZA_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    const errorResponse: ErrorResponse = {
      success: false,
      error: "MISSING_ENV",
      message: "Variables d'environnement manquantes",
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Parser le body
    let body: RequestBody;
    try {
      body = await req.json();
    } catch {
      const errorResponse: ErrorResponse = {
        success: false,
        error: "INVALID_INPUT",
        message: "Le body JSON est invalide",
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Vérifier les champs obligatoires (avec normalisation)
    const document_id = String(body.document_id ?? "").trim();
    const zone_code = String(body.zone_code ?? "").trim().toUpperCase();

    if (!document_id) {
      const errorResponse: ErrorResponse = {
        success: false,
        error: "INVALID_INPUT",
        message: "Le champ 'document_id' est obligatoire et doit être une chaîne",
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!zone_code) {
      const errorResponse: ErrorResponse = {
        success: false,
        error: "INVALID_INPUT",
        message: "Le champ 'zone_code' est obligatoire et doit être une chaîne",
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Créer le client Supabase avec SERVICE ROLE
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Requêter la table plu_zone_rules_normalized
    const { data, error } = await supabase
      .from("plu_zone_rules_normalized")
      .select("zone_libelle, rules, confidence_score")
      .eq("document_id", document_id)
      .eq("zone_code", zone_code)
      .single();

    if (error) {
      // Cas où aucune ligne n'est trouvée (code PostgREST)
      if (error.code === "PGRST116") {
        const errorResponse: ErrorResponse = {
          success: false,
          error: "NOT_FOUND",
          message: `Aucune règle trouvée pour document_id='${document_id}' et zone_code='${zone_code}'`,
        };
        return new Response(JSON.stringify(errorResponse), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Autre erreur Supabase
      console.error("Erreur Supabase:", error);
      const errorResponse: ErrorResponse = {
        success: false,
        error: "INTERNAL_ERROR",
        message: "Erreur lors de la requête en base de données",
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fallback : si data est null/undefined sans erreur explicite
    if (data === null || data === undefined) {
      const errorResponse: ErrorResponse = {
        success: false,
        error: "NOT_FOUND",
        message: `Aucune règle trouvée pour document_id='${document_id}' et zone_code='${zone_code}'`,
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Succès
    const successResponse: SuccessResponse = {
      success: true,
      document_id,
      zone_code,
      zone_libelle: data.zone_libelle,
      confidence_score: data.confidence_score,
      rules: data.rules || {},
    };

    return new Response(JSON.stringify(successResponse), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Erreur inattendue:", err);
    const errorResponse: ErrorResponse = {
      success: false,
      error: "INTERNAL_ERROR",
      message: "Une erreur inattendue s'est produite",
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});