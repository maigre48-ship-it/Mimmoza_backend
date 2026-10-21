// supabase/functions/analyse-property-from-url/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const supabase = createClient(supabaseUrl, serviceKey);

// =========== OPENAI CALLER ===========
async function callOpenAI(prompt: string) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    console.error("OpenAI error", await res.text());
    throw new Error("OpenAI failed");
  }

  const json = await res.json();
  return json.choices[0].message.content;
}

// =========== SIMPLE SMARTSCORE ===========
function computeSmartScore(data: any) {
  let score = 0;

  const surface = Number(data.surface) || 0;
  const pricePerM2 =
    Number(data.price_per_m2) ||
    (data.price && data.surface ? Number(data.price) / Number(data.surface) : 0);
  const rooms = Number(data.rooms) || 0;
  const locationQuality = Number(data.location_quality) || 0;
  const conditionQuality = Number(data.condition_quality) || 0;

  if (surface > 0) score += Math.min(20, (surface / 200) * 20);
  if (pricePerM2 > 0) score += Math.min(20, (4000 / pricePerM2) * 20);
  if (rooms > 0) score += Math.min(15, (rooms / 6) * 15);
  if (locationQuality > 0) score += (locationQuality / 10) * 20;
  if (conditionQuality > 0) score += (conditionQuality / 10) * 15;

  return Math.round(Math.max(0, Math.min(100, score)));
}

// =========== MAIN EDGE FUNCTION ===========
serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 🔓 Auth "souple"
    let userId: string | null = null;

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "").trim();

    if (jwt.length > 30) {
      const { data } = await supabase.auth.getUser(jwt);
      if (data?.user) {
        userId = data.user.id;
      }
    }

    // 📥 Lecture du body
    const { url } = await req.json();
    if (!url) {
      return new Response("Missing url", { status: 400 });
    }

    // Déduire le site source depuis l'URL
    let sourceSite: string | null = null;
    try {
      const u = new URL(url);
      sourceSite = u.hostname.replace("www.", "");
    } catch {
      sourceSite = null;
    }

    // 🌐 Récupérer la page HTML
    const fetchRes = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; MimmozaBot/1.0; +https://mimmoza.fr)",
      },
    });

    if (!fetchRes.ok) {
      return new Response(
        JSON.stringify({
          error: "Cannot fetch URL",
          status: fetchRes.status,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    const html = await fetchRes.text();

    // 🧠 Extraction avec OpenAI
    const extractionPrompt = `
Tu es un extracteur robuste d'annonces immobilières.
Voici le HTML d’une annonce immobilière.
EXTRAIS STRICTEMENT un JSON respectant ce schéma EXACT :

{
  "title": "",
  "description": "",
  "address": "",
  "city": "",
  "zipcode": "",
  "latitude": null,
  "longitude": null,
  "price": null,
  "surface": null,
  "rooms": null,
  "bedrooms": null,
  "property_type": "",
  "photos": [],
  "energy_class": "",
  "ges_class": "",
  "price_per_m2": null,
  "location_quality": 0,
  "condition_quality": 0
}

RÈGLES :
- RENVOIE UNIQUEMENT LE JSON, SANS TEXTE AUTRE.
- Si une info est introuvable, mets null ou "".
- Déduis les classes énergétiques si visibles.
- Déduis la qualité de l’emplacement (0-10) à partir du contexte (proximité transports, commerces, centre-ville, etc.).
- Déduis la qualité de l’état du bien (0-10) à partir du texte (rénové, travaux, état neuf, à rafraîchir, etc.).

HTML :
${html.substring(0, 200000)}
    `;

    const extractedText = await callOpenAI(extractionPrompt);

    let extractedData: any;
    try {
      extractedData = JSON.parse(extractedText);
    } catch (err) {
      console.error("JSON parse error", extractedText);
      return new Response("Invalid JSON from OpenAI", { status: 500 });
    }

    // 🧩 Résumé pour colonnes dédiées
    const summary = {
      property_type: extractedData.property_type || null,
      city: extractedData.city || null,
      zipcode: extractedData.zipcode || null,
      price: extractedData.price != null ? Number(extractedData.price) : null,
      surface:
        extractedData.surface != null ? Number(extractedData.surface) : null,
      rooms: extractedData.rooms != null ? Number(extractedData.rooms) : null,
    };

    // 🧮 SmartScore
    const smartscore = computeSmartScore(extractedData);

    // 🗄 Insertion dans analyses
    const { data: inserted, error: insertError } = await supabase
      .from("analyses")
      .insert({
        user_id: userId,
        listing_id: null,
        source_url: url,
        source_site: sourceSite,
        type: "url_analysis",

        property_type: summary.property_type,
        city: summary.city,
        zipcode: summary.zipcode,
        price: summary.price,
        surface: summary.surface,
        rooms: summary.rooms,

        smartscore,
        extracted_data: extractedData,
        status: "completed",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error("DB error", insertError);
      return new Response("DB insert error", { status: 500 });
    }

    // 📤 Réponse
    return new Response(
      JSON.stringify({
        analysis_id: inserted.id,
        smartscore,
        extracted: extractedData,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("GLOBAL ERROR", err);
    return new Response("Internal Server Error", { status: 500 });
  }
});
