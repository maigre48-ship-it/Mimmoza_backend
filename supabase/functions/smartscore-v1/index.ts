// Active l'environnement Supabase Edge (types Deno + helpers)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req) => {
  // CORS pour pouvoir appeler depuis Mimmoza / Base44
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // 1️⃣ On récupère les données du bien (GET ou POST JSON)
  let payload: any = {};
  if (req.method === "GET") {
    const url = new URL(req.url);
    const p = url.searchParams;
    payload = {
      property_id: p.get("property_id"),
      address: p.get("address"),
      city: p.get("city"),
      postal_code: p.get("postal_code"),
      price: p.get("price"),
      surface: p.get("surface"),
      rooms: p.get("rooms"),
      bedrooms: p.get("bedrooms"),
      latitude: p.get("latitude"),
      longitude: p.get("longitude"),
    };
  } else if (req.method === "POST") {
    try {
      payload = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  } else {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // 2️⃣ Clé OpenAI (on la mettra dans les secrets Supabase)
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY is not set in Supabase secrets" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // 3️⃣ Prompt système SmartScore Mimmoza
  const systemPrompt = `
Tu es le moteur SmartScore de Mimmoza, un système d’analyse immobilière avancé.
Ta mission : produire un SmartScore v1.0 structuré pour un bien immobilier.
Le score global et les sous-scores doivent être entre 0 et 100.
Tu dois renvoyer exclusivement le JSON strict demandé, sans texte avant, après ou autour.

Format JSON OBLIGATOIRE :
{
  "smartscore_v1": {
    "total": 0,
    "subscores": {
      "prix_surface": 0,
      "urbanisme": 0,
      "environnement": 0,
      "marche": 0,
      "qualite_intrinseque": 0
    },
    "explanation": "..."
  }
}

Rappels :
- UNIQUEMENT du JSON.
- PAS de texte hors JSON.
- “explanation” = maximum 6 phrases.
- Utilise toutes les données disponibles, mais si certaines manquent, agrège prudemment.
`.trim();

  // 4️⃣ Prompt utilisateur avec les données du bien
  const userPrompt = `
Voici les données du bien immobilier reçues depuis Mimmoza :

${JSON.stringify(payload, null, 2)}

Utilise ces données pour calculer un SmartScore v1.0 complet.
Réponds STRICTEMENT avec le JSON final demandé, sans texte autour.
`.trim();

  // 5️⃣ Appel à l'API OpenAI
  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini", // tu pourras changer ce modèle si tu veux
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!openaiRes.ok) {
    const errorText = await openaiRes.text();
    return new Response(
      JSON.stringify({ error: "OpenAI error", details: errorText }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const completion = await openaiRes.json();
  const content = completion.choices?.[0]?.message?.content ?? "{}";

  // 6️⃣ On renvoie tel quel le JSON produit par l'IA
  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
