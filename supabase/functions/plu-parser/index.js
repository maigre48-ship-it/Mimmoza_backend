// plu-parser/index.js
// Version : plu-parser-v3 (PDF → texte → IA → zones_rulesets avec reculs & stationnement chiffrés)

const express = require("express");
const fetch = require("node-fetch");
const PDFParser = require("pdf2json");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "50mb" }));

// 🔑 OpenAI – clé à mettre dans OPENAI_API_KEY (env)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🧠 Prompt système : expert PLU
const SYSTEM_PROMPT = `
Tu es un expert en urbanisme français. 
Tu lis un PLU (Plan Local d'Urbanisme) et tu en extrais des règles structurées zone par zone.

FORMAT DE RÉPONSE OBLIGATOIRE (JSON VALIDE UNIQUEMENT) :

{
  "plu_version_label": "string | null",
  "zones_rulesets": [
    {
      "zone_code": "UB",
      "zone_libelle": "zone urbaine dense",
      "ruleset": {
        "densite": {
          "cos_existe": false,
          "cos_max": null,
          "max_sdp_m2_par_m2_terrain": null,
          "commentaire": "string | null"
        },
        "hauteur": {
          "hauteur_max_m": null,
          "hauteur_min_m": null,
          "commentaire": "string | null"
        },
        "emprise": {
          "emprise_max_ratio": null,
          "emprise_sol_max": null,
          "commentaire": "string | null"
        },
        "stationnement": {
          "places_par_logement": null,
          "surface_par_place_m2": null,
          "commentaire": "string | null"
        },
        "reculs": {
          "retrait_min_m": null,
          "retrait_voirie_min_m": null,
          "retrait_limites_separatives_min_m": null,
          "retrait_fond_parcelle_min_m": null,
          "commentaire": "string | null"
        },
        "reculs_alignements": {
          "commentaire": "string | null"
        },
        "autres_regles": {
          "commentaire": "string | null"
        },
        "articles_source": ["Article 1", "Article 2"]
      }
    }
  ]
}

RÈGLES IMPORTANTES :
- Ne renvoie QUE du JSON valide.
- Ne mets PAS de texte en dehors du JSON.
- Ne devine pas : si une info n'est pas dans le texte, mets null ou un commentaire explicite.
- Les zones sont celles du règlement (UC, UD, UE, A, N, etc.).
- Tu peux regrouper les règles par zone en t'appuyant sur les titres (ex: "Règles de la zone UB").
- Pour les RECULS :
  - Essaie toujours de donner les distances en mètres dans "reculs.*_m" quand c'est possible.
  - "retrait_min_m" = recul minimal général à conserver par rapport aux limites, si la règle générale est exprimée clairement.
  - Utilise les champs spécifiques quand le texte distingue la voie / limites séparatives / fond de parcelle.
  - Si plusieurs cas particuliers existent, mets la règle GÉNÉRALE en numérique et détaille les cas particuliers dans "reculs.commentaire".
- Pour le STATIONNEMENT :
  - "places_par_logement" = nombre de places exigées par logement pour le logement ordinaire.
  - "surface_par_place_m2" = surface indicative totale (place + manoeuvres), utilise 25 m² si le texte ne précise rien.
  - Si la règle est différente pour certains cas (commerces, bureaux, équipements), mets la règle la plus générale et les variantes dans "stationnement.commentaire".
`;

// 🧠 Appel IA : transforme le texte brut du PLU en zones_rulesets
async function buildZonesRulesetsFromText(fullText) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `
Voici le texte brut d'un PLU (règlement écrit).
Analyse-le et renvoie STRICTEMENT un JSON du format demandé.

TEXTE PLU :
-------------------------
${fullText}
-------------------------
`,
      },
    ],
  });

  const content = completion.choices[0].message.content;
  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch (e) {
    console.error("❌ Impossible de parser la réponse OpenAI en JSON :", e);
    throw new Error("OPENAI_JSON_PARSE_ERROR");
  }

  if (!parsed || !Array.isArray(parsed.zones_rulesets)) {
    throw new Error("OPENAI_INVALID_SHAPE");
  }

  return parsed;
}

// 🚀 Route principale utilisée par Supabase (PLU_PARSER_API_URL)
app.post("/api/plu-parse", async (req, res) => {
  try {
    const pdf_url = req.body.source_pdf_url || req.body.pdf_url;
    const commune_insee = req.body.commune_insee || null;
    const commune_nom = req.body.commune_nom || null;

    if (!pdf_url) {
      return res.status(400).json({
        success: false,
        error: "MISSING_PDF_URL",
      });
    }

    console.log("📥 Parsing PLU PDF from:", pdf_url);

    // 1) Télécharger le PDF depuis Supabase
    const pdfResponse = await fetch(pdf_url);
    if (!pdfResponse.ok) {
      console.error("❌ PDF download failed:", pdfResponse.status);
      return res.status(500).json({
        success: false,
        error: "PDF_DOWNLOAD_FAILED",
        status: pdfResponse.status,
      });
    }

    const pdfBuffer = await pdfResponse.buffer();

    // 2) Parser PDF via pdf2json
    const pdfParser = new PDFParser(this, 1);

    pdfParser.on("pdfParser_dataError", (errData) => {
      console.error("❌ PDF parse error:", errData.parserError);
      return res.status(500).json({
        success: false,
        error: "PDF_PARSE_FAILED",
        details: String(errData.parserError),
      });
    });

    pdfParser.on("pdfParser_dataReady", async (pdfData) => {
      try {
        console.log("📄 PDF parsed OK");

        // Concatène le texte de toutes les pages
        const pagesText =
          pdfData?.formImage?.Pages?.map((page) =>
            page.Texts.map((t) => decodeURIComponent(t.R[0].T)).join(" "),
          ) || [];

        const fullText = pagesText.join("\n\n");

        console.log("🧠 Appel OpenAI pour extraction des règles PLU…");

        // 3) Appel IA pour construire zones_rulesets
        const aiResult = await buildZonesRulesetsFromText(fullText);

        console.log(
          `✅ IA OK – ${aiResult.zones_rulesets.length} zones_rulesets extraites`,
        );

        // 4) Réponse finale pour Supabase (plu-ingest-from-storage)
        return res.json({
          success: true,
          commune_insee,
          commune_nom,
          pages: pagesText.length,
          text: fullText,
          raw: pdfData,
          plu_version_label: aiResult.plu_version_label ?? null,
          zones_rulesets: aiResult.zones_rulesets,
        });
      } catch (err) {
        console.error("❌ OPENAI / IA ERROR :", err);
        return res.status(500).json({
          success: false,
          error: "PLU_AI_PARSE_FAILED",
          details: String(err),
        });
      }
    });

    pdfParser.parseBuffer(pdfBuffer);
  } catch (err) {
    console.error("❌ Unexpected error:", err);
    res.status(500).json({
      success: false,
      error: "PARSER_INTERNAL_ERROR",
      details: String(err),
    });
  }
});

app.listen(3000, () => {
  console.log(
    "🚀 Local PLU Parser running on http://localhost:3000/api/plu-parse",
  );
});
