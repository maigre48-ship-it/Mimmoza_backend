// ─────────────────────────────────────────────────────────────────────────────
// analyze-rehab-plan/index.ts  v5 — Lecture architecturale complète
// + spatialMetrics.totalSurface (bug surface totale corrigé)
// Supabase Edge Function — Analyse IA Vision d'un plan architectural
// Modèle : gpt-4o (vision)   Runtime : Deno — pas de Buffer / FileReader Node
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Base64 Deno-safe (chunked — évite le stack overflow sur >30 Ko) ─────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ─── Helpers réponses ─────────────────────────────────────────────────────────

function jsonOk(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function jsonError(
  code: string,
  message: string,
  debug?: Record<string, unknown>,
  status = 400,
) {
  return new Response(
    JSON.stringify({ success: false, error: { code, message, ...(debug ? { debug } : {}) } }),
    { status, headers: { ...CORS, "Content-Type": "application/json" } },
  );
}

// ─── Prompt système v5 ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es un architecte expert en lecture de plans français et en réglementation ERP / PMR / sécurité incendie.

══════════════════════════════════════════
RÈGLES ABSOLUES — NE JAMAIS ENFREINDRE
══════════════════════════════════════════
1. Tu ne dois JAMAIS inventer des cotes, dimensions ou distances non cotées.
2. Si une mesure n'est pas clairement lisible, indique "non lisible".
3. Respecte rigoureusement les niveaux de preuve :
   • "detected"             : élément clairement visible sur le plan (nom, symbole, cote)
   • "to_confirm"           : élément supposé, visible mais non confirmé par légende ou cote
   • "not_verifiable"       : impossible à vérifier sur image (matériaux, résistance au feu…)
   • "regulatory_assumption": conclusion fondée sur les paramètres ERP fournis, pas sur le plan
4. SIGNALISATION DES ISSUES : evidenceLevel="detected" UNIQUEMENT si un pictogramme de sortie
   de secours ou la mention textuelle exacte "sortie de secours" est visible sur le plan.
   Dans tous les autres cas → evidenceLevel="to_confirm".
   Ne jamais écrire "issue de secours visible" sans preuve directe ; préférer :
   "Accès / dégagement apparent — conformité issue de secours à confirmer".
5. SANITAIRES PMR : n'affirmer "conforme PMR" que si un symbole PMR, une cote de manœuvre
   (≥ 1,50 m) ou la mention "PMR" est visible.
   Si WC présents mais aucune mention PMR → description : "Sanitaires identifiés — conformité PMR
   non vérifiable sur le plan" avec evidenceLevel="to_confirm" ou "not_verifiable".
6. Pour chaque issue, attribuer un niveau de confiance :
   • "forte"  : preuve directe visible sur le plan
   • "moyenne": déduction fondée sur la configuration visible
   • "faible" : hypothèse réglementaire sans preuve directe
7. TABLEAUX JSON — RÈGLE CRITIQUE :
   • Si aucun élément n'est détecté pour une catégorie, retourner un tableau VIDE : []
   • INTERDIT : ["vide"], ["aucun"], ["non identifié"], ["-"] ou tout autre placeholder textuel.
   • Un tableau doit contenir soit des descriptions réelles, soit être vide : [].
8. ESCALIERS : si un symbole escalier (flèche montante, ligne de marches, hachures) est visible,
   retourner : "Escalier détecté — usage et continuité à confirmer".
   Ne jamais retourner "vide" pour les escaliers ; si aucun symbole visible → [].
9. VESTIAIRES vs SANITAIRES — SÉPARATION STRICTE :
   • lockerRooms : contient UNIQUEMENT les espaces nommés ou symbolisés comme "Vestiaires H",
     "Vestiaires F", "vestiaire", "Vestiaires Hommes", "Vestiaires Femmes", "changing room",
     ou tout local dédié au changement de vêtements. Les nommer tels qu'ils apparaissent sur
     le plan (ex : "Vestiaires H — localisation : aile nord").
   • sanitarySpaces : contient UNIQUEMENT les WC, sanitaires, douches, lavabos, blocs sanitaires,
     locaux d'hygiène explicitement nommés comme tels.
   • Un même espace NE PEUT PAS apparaître dans les deux tableaux.
   • Si un vestiaire comporte des sanitaires intégrés, citer chaque fonction séparément dans
     son tableau respectif, en précisant la liaison (ex : "WC intégré aux vestiaires H").
10. OPPORTUNITÉS DE TRANSFORMATION — RÈGLE DE PRUDENCE :
    • N'affirmer une opportunité que si elle repose sur un élément visible sur le plan
      (espace nommé "réserve" ou "stockage", dégagement manifeste avec cote lisible).
    • Formuler systématiquement au conditionnel ou avec une réserve :
      "Pourrait permettre…", "Semble offrir…", "À confirmer en visite terrain".
    • INTERDIT : toute formulation assertive sans preuve directe
      ("permet", "offre", "garantit" sans réserve).
    • Si aucune opportunité réelle n'est identifiable → retourner [] plutôt qu'une liste
      d'hypothèses non étayées.
11. TERMES AFFIRMATIFS INTERDITS SANS COTE VISIBLE :
    Les termes suivants sont STRICTEMENT INTERDITS sauf si une cote ou une surface libre
    est explicitement lisible sur le plan :
      ✗ "surlargeur"
      ✗ "extension possible"
      ✗ "agrandissement possible"
      ✗ "gain de surface"
      ✗ "création possible de surface"
      ✗ "potentiel d'extension"
      ✗ "potentiel de division"
      ✗ "optimisation certaine"
    Remplacer systématiquement par des formulations prudentes :
      ✓ "zone de circulation potentiellement exploitable"
      ✓ "espace pouvant être étudié"
      ✓ "potentiel à confirmer"
      ✓ "possibilité à étudier après relevé"
    Si une cote est lisible et justifie le constat → mentionner la cote explicitement
    et utiliser le conditionnel : "La cote apparente de X m pourrait permettre…"
12. MODULARITÉ — EXPLICATION OBLIGATOIRE :
    Le champ "modularity" ("bonne" | "moyenne" | "faible") doit toujours être accompagné
    d'un champ "modularityReason" expliquant la conclusion.
    Exemples attendus :
      • "bonne"  → "Cloisonnement léger apparent sans noyau technique central identifié —
                    reconfiguration a priori envisageable, à confirmer en visite."
      • "moyenne"→ "Présence probable de noyaux techniques centraux limitant certaines
                    reconfigurations."
      • "faible" → "Structure porteuse dense ou noyaux fixes multiples détectés — marges
                    de reconfiguration réduites, à vérifier en visite terrain."
    Si la modularité n'est pas évaluable → "modularityReason": "Non évaluable sur ce plan."
13. SURFACE TOTALE — RÈGLE PRIORITAIRE (CRITIQUE) :
    • Cherche EN PRIORITÉ une annotation de SYNTHÈSE type "Surface totale : X m²",
      "Surface : X m²", "SHON X m²", "SDP X m²". Elle se trouve le plus souvent dans un
      cartouche "Informations générales", un tableau de synthèse ou le bandeau du plan,
      SÉPARÉE des pièces. Si trouvée → spatialMetrics.totalSurface = X (nombre),
      spatialMetrics.surfaceSource = "annotation-plan".
    • INTERDIT ABSOLU : ne JAMAIS utiliser la surface d'UNE pièce comme surface totale.
      Une valeur en m² collée à un nom de pièce (ex : "Espace thérapie 80 m²",
      "Salle de rééducation 36 m²") est une surface DE PIÈCE, jamais la surface totale.
      La surface totale est TOUJOURS strictement supérieure à la plus grande pièce.
    • Contrôle de cohérence : si ta valeur candidate est ≤ à la plus grande surface de pièce
      détectée, c'est une ERREUR → repasse en revue le plan pour trouver l'annotation globale ;
      si tu ne la trouves pas → totalSurface: null.
    • Ne jamais additionner les pièces toi-même.
    • Si aucune annotation globale lisible → totalSurface: null,
      surfaceSource: "non-determinable".

══════════════════════════════════════════
MÉTHODE D'ANALYSE EN 3 LECTURES
══════════════════════════════════════════
Effectue impérativement les 3 étapes dans cet ordre :

ÉTAPE 1 — LECTURE GÉOMÉTRIQUE
Décris objectivement ce que tu vois :
  - Pièces nommées et leurs surfaces affichées (si cotées)
  - Organisation générale (linéaire, centralisée, en L, en U…)
  - Circulations principales identifiables
  - Accès extérieurs visibles
  - Escaliers, rampes, monte-charges (si symbole visible → "Escalier détecté — usage et continuité à confirmer" ; sinon → [])
  - Vestiaires (H/F ou mixtes) → lockerRooms (nommer selon légende du plan)
  - Sanitaires / WC / douches / blocs hygiènes → sanitarySpaces uniquement
    (ne jamais y inclure les vestiaires, même s'ils sont contigus)
  - Locaux techniques nommés
  - Issues de secours (respecter strictement la règle 4)
  - SURFACE TOTALE : appliquer strictement la règle 13 (annotation globale, jamais une pièce)

ÉTAPE 2 — LECTURE FONCTIONNELLE
Analyse l'organisation fonctionnelle :
  - Flux de circulation : logique, continuité, goulots d'étranglement
  - Séparation des zones (accueil / soins / thérapie / technique / stockage)
  - Présence d'un hall ou espace d'attente structurant
  - Localisation des sanitaires par rapport aux zones d'activité
  - Localisation des vestiaires par rapport aux zones d'activité (flux propre/sale, proximité douches)
  - Lisibilité de la distribution intérieure
  - Qualité du zoning : zones bien délimitées ou zones mixtes mal définies
  - Modularité du cloisonnement : potentiel de reconfiguration du plan
  - Contraintes spatiales identifiables (noyaux fixes, porteurs, escaliers)
  - Opportunités de transformation (seulement si étayées par un élément visible avec cote — règles 10 et 11)

ÉTAPE 3 — LECTURE RÉGLEMENTAIRE
Seulement après les deux premières lectures, analyse :
  - Accessibilité PMR (circulations, portes, sanitaires, rampes)
  - Sécurité incendie (issues, dégagements, cloisonnements supposés)
  - Conformité ERP selon type et catégorie fournis
  - Points à vérifier impérativement en visite terrain

══════════════════════════════════════════
SORTIE
══════════════════════════════════════════
Tu retournes UNIQUEMENT un JSON valide, sans markdown, sans texte avant ou après.`;

// ─── Prompt utilisateur v5 ────────────────────────────────────────────────────

function buildUserPrompt(params: {
  buildingType?: string;
  targetUsage?: string;
  isErp?: boolean;
  erpType?: string | null;
  erpCategory?: number | null;
  floorCount?: string;
  estimatedSurface?: number | null;
  capacity?: number | null;
}): string {
  const erpInfo = params.isErp
    ? `ERP Type ${params.erpType ?? "non précisé"}, Catégorie ${params.erpCategory ?? "non précisée"}`
    : "Non ERP";

  return `Analyse ce plan architectural selon la méthode en 3 lectures définie dans tes instructions.

PARAMÈTRES DU BÂTIMENT :
- Type : ${params.buildingType ?? "non précisé"}
- Usage cible : ${params.targetUsage ?? "non précisé"}
- Niveaux : ${params.floorCount ?? "non précisé"}
- Surface estimée : ${params.estimatedSurface ? params.estimatedSurface + " m²" : "non précisée"}
- Capacité : ${params.capacity ? params.capacity + " personnes" : "non précisée"}
- Classement : ${erpInfo}

RAPPELS CRITIQUES AVANT DE GÉNÉRER LE JSON :
• Tableaux vides : si aucun élément détecté dans une catégorie → [] (jamais ["vide"] ou ["aucun"])
• Escaliers : si symbole visible → "Escalier détecté — usage et continuité à confirmer" ; sinon → []
• Issues de secours : ne jamais écrire "issue de secours visible" sans pictogramme ou mention
  explicite. Préférer : "Accès / dégagement apparent — conformité issue de secours à confirmer"
  avec evidenceLevel="to_confirm"
• Sanitaires PMR : si WC présents sans mention PMR → "Sanitaires identifiés — conformité PMR non
  vérifiable sur le plan" avec evidenceLevel="to_confirm" ou "not_verifiable"
• evidenceLevel="detected" pour la signalisation UNIQUEMENT si pictogramme ou texte "sortie de secours" visible
• lockerRooms vs sanitarySpaces : SÉPARATION STRICTE — vestiaires (H/F/mixtes, changing room)
  → lockerRooms UNIQUEMENT. WC, douches, lavabos, blocs sanitaires → sanitarySpaces UNIQUEMENT.
  Ne jamais placer un vestiaire dans sanitarySpaces, même s'il contient des douches.
• Opportunités : formuler au conditionnel ("pourrait permettre", "semble offrir") et uniquement
  si un élément visible le justifie. Si rien n'est identifiable → [].
• Termes interdits sans cote : "surlargeur", "extension possible", "agrandissement possible",
  "gain de surface", "création possible de surface", "potentiel d'extension",
  "potentiel de division", "optimisation certaine" → remplacer par "potentiel à confirmer",
  "possibilité à étudier après relevé", "zone de circulation potentiellement exploitable".
• modularityReason : champ OBLIGATOIRE — toujours expliquer ce qui justifie le niveau
  de modularité choisi (noyaux fixes, cloisonnement léger, structure porteuse visible, etc.).
• SURFACE TOTALE (règle 13) : spatialMetrics.totalSurface DOIT venir d'une annotation globale
  de synthèse ("Surface totale : X m²"), jamais d'une surface de pièce. Si la valeur candidate
  est ≤ à la plus grande pièce détectée → c'est une pièce, pas la surface totale → mets null.

Retourne UNIQUEMENT ce JSON (zéro markdown, zéro texte hors JSON) :

{
  "summary": "Synthèse globale prudente en 2-3 phrases",

  "spatialMetrics": {
    "totalSurface": null,
    "surfaceSource": "annotation-plan" | "piece-labels" | "non-determinable"
  },

  "reliability": "faible" | "moyenne" | "forte",
  "riskLevel": "faible" | "modere" | "eleve" | "critique",
  "pmrLevel": "conforme" | "partiel" | "non_conforme" | "non_evalue",
  "fireSafetyLevel": "conforme" | "partiel" | "non_conforme" | "non_evalue",

  "architecturalReading": {
    "geometry": "bonne" | "moyenne" | "faible",
    "functional": "bonne" | "moyenne" | "faible",
    "regulatory": "bonne" | "partielle" | "faible",
    "summary": "Description narrative des 3 lectures en 4-6 phrases. D'abord ce qui est vu géométriquement, puis l'organisation fonctionnelle, puis les enjeux réglementaires."
  },

  "detectedSpatialElements": {
    "halls": [],
    "corridors": [],
    "rooms": [],
    "sanitarySpaces": [],
    "lockerRooms": [],
    "technicalRooms": [],
    "stairs": [],
    "exits": [],
    "receptionAreas": [],
    "therapyAreas": [],
    "careRooms": []
  },

  "functionalObservations": [
    "Observation fonctionnelle 1 (ex: hall central structurant)",
    "Observation fonctionnelle 2 (ex: distribution lisible)"
  ],

  "spatialIntelligence": {
    "flowQuality": "bonne" | "moyenne" | "faible",
    "zoningQuality": "bonne" | "moyenne" | "faible",
    "modularity": "bonne" | "moyenne" | "faible",
    "modularityReason": "Explication obligatoire du niveau de modularité — ce qui est vu sur le plan qui justifie cette évaluation (noyaux fixes, cloisonnement léger, structure porteuse, etc.).",
    "constraints": [
      "Contrainte spatiale identifiée 1 (ex: noyau porteur central — reconfiguration limitée, à confirmer en visite)",
      "..."
    ],
    "opportunities": [
      "Opportunité conditionnelle 1 (ex: espace nommé 'réserve' côté nord — possibilité à étudier après relevé)",
      "..."
    ],
    "summary": "Synthèse narrative de l'intelligence spatiale : qualité des flux, cohérence du zoning, potentiel de modularité, principales contraintes et opportunités de transformation. 3-5 phrases. Formuler les opportunités au conditionnel."
  },

  "issues": [
    {
      "id": "ISS-001",
      "category": "Accessibilité PMR | Sécurité incendie | Circulations | Sanitaires | Vestiaires | Signalisation | ...",
      "severity": "non_conforme" | "a_verifier" | "conforme",
      "evidenceLevel": "detected" | "to_confirm" | "not_verifiable" | "regulatory_assumption",
      "confidence": "forte" | "moyenne" | "faible",
      "title": "Titre court",
      "description": "Description prudente, sans inventer de cotes. Indiquer ce qui est vu vs ce qui est supposé.",
      "planZone": "Zone du plan concernée (optionnel)",
      "regulatoryRef": "Référence réglementaire (optionnel, ex: Art. R4 Arr. 1er août 2006)"
    }
  ],

  "recommendations": [
    {
      "id": "REC-001",
      "priority": "urgente" | "importante" | "recommandee",
      "title": "Titre",
      "description": "Description actionnable",
      "estimatedCost": { "min": 0, "max": 0, "unit": "€" }
    }
  ]
}`;
}

// ─── Handler principal ────────────────────────────────────────────────────────

serve(async (req) => {
  const method = req.method;
  const contentType = req.headers.get("content-type") ?? "(absent)";
  const hasAuth = req.headers.has("authorization");

  console.log("[analyze-rehab-plan] ── Requête entrante ──");
  console.log("[analyze-rehab-plan] method      :", method);
  console.log("[analyze-rehab-plan] content-type:", contentType);
  console.log("[analyze-rehab-plan] auth présent:", hasAuth);

  if (method === "OPTIONS") {
    console.log("[analyze-rehab-plan] OPTIONS → 204");
    return new Response(null, { status: 204, headers: CORS });
  }

  if (method !== "POST") {
    return jsonError("METHOD_NOT_ALLOWED", "POST requis.", undefined, 405);
  }

  // ── FormData ──────────────────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
    console.log("[analyze-rehab-plan] FormData parsé OK");
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[analyze-rehab-plan] FORMDATA_PARSE_FAILED:", errorMessage);
    return jsonError("FORMDATA_PARSE_FAILED", "Impossible de lire le corps multipart/form-data.", {
      contentType,
      errorMessage,
    });
  }

  const receivedKeys = Array.from(formData.keys());
  console.log("[analyze-rehab-plan] Clés FormData:", JSON.stringify(receivedKeys));

  // ── Fichier ───────────────────────────────────────────────────────────────
  const fileRaw = formData.get("file");

  if (fileRaw === null || fileRaw === undefined) {
    return jsonError("FILE_MISSING", 'Aucun champ "file" trouvé dans le FormData.', { receivedKeys });
  }

  const constructorName =
    (fileRaw as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";
  const hasArrayBuffer =
    typeof (fileRaw as { arrayBuffer?: unknown }).arrayBuffer === "function";
  const fileType = (fileRaw as Blob).type ?? "(absent)";
  const fileSize = (fileRaw as Blob).size ?? -1;
  const fileName = fileRaw instanceof File ? fileRaw.name : "(blob sans nom)";

  console.log("[analyze-rehab-plan] file.name        :", fileName);
  console.log("[analyze-rehab-plan] file.type        :", fileType);
  console.log("[analyze-rehab-plan] file.size        :", fileSize, "octets");
  console.log("[analyze-rehab-plan] typeof fileRaw   :", typeof fileRaw);
  console.log("[analyze-rehab-plan] constructor.name :", constructorName);
  console.log("[analyze-rehab-plan] hasArrayBuffer   :", hasArrayBuffer);

  if (!hasArrayBuffer) {
    return jsonError("INVALID_FILE_OBJECT", 'Le champ "file" n\'est pas un Blob lisible.', {
      typeof: typeof fileRaw,
      constructorName,
      hasArrayBuffer,
      receivedKeys,
    });
  }

  const file = fileRaw as Blob;

  const ALL_ALLOWED = ["image/png", "image/jpeg", "application/pdf"];
  if (!ALL_ALLOWED.includes(fileType)) {
    return jsonError("UNSUPPORTED_FORMAT", `Format "${fileType}" non supporté.`, {
      receivedType: fileType,
      allowedTypes: ALL_ALLOWED,
    });
  }

  if (fileType === "application/pdf") {
    return jsonError(
      "PDF_NOT_SUPPORTED_YET",
      "L'analyse PDF n'est pas encore activée. Utilisez une image PNG ou JPEG.",
    );
  }

  // ── Lecture base64 (Deno-safe, chunked) ──────────────────────────────────
  let base64: string;
  try {
    console.log("[analyze-rehab-plan] Lecture arrayBuffer...");
    const bytes = new Uint8Array(await file.arrayBuffer());
    console.log("[analyze-rehab-plan] arrayBuffer OK —", bytes.length, "octets");
    base64 = bytesToBase64(bytes);
    console.log("[analyze-rehab-plan] base64 OK — longueur:", base64.length);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[analyze-rehab-plan] FILE_READ_ERROR:", errorMessage);
    return jsonError(
      "FILE_READ_ERROR",
      "Impossible de lire le contenu du fichier.",
      { fileName, fileType, fileSize, constructorName, errorMessage },
      500,
    );
  }

  const dataUrl = `data:${fileType};base64,${base64}`;
  console.log("[analyze-rehab-plan] dataUrl prêt —", dataUrl.substring(0, 40) + "...");

  // ── Clé OpenAI ────────────────────────────────────────────────────────────
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) {
    return jsonError("OPENAI_KEY_MISSING", "Variable OPENAI_API_KEY manquante.", undefined, 500);
  }

  // ── Paramètres bâtiment ───────────────────────────────────────────────────
  const paramsRaw = formData.get("params") as string | null;
  let buildingParams: Record<string, unknown> = {};
  if (paramsRaw) {
    try {
      buildingParams = JSON.parse(paramsRaw);
      console.log("[analyze-rehab-plan] params:", JSON.stringify(buildingParams));
    } catch {
      console.warn("[analyze-rehab-plan] params non parsables — valeurs par défaut.");
    }
  }

  // ── Appel OpenAI Vision ───────────────────────────────────────────────────
  const userPrompt = buildUserPrompt(buildingParams as Parameters<typeof buildUserPrompt>[0]);
  console.log("[analyze-rehab-plan] Appel OpenAI gpt-4o vision...");

  let openAIResponse: Response;
  try {
    openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 4096,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[analyze-rehab-plan] OPENAI_NETWORK_ERROR:", errorMessage);
    return jsonError("OPENAI_NETWORK_ERROR", "Impossible de joindre l'API OpenAI.", { errorMessage }, 502);
  }

  console.log("[analyze-rehab-plan] OpenAI status:", openAIResponse.status);

  if (!openAIResponse.ok) {
    const errBody = await openAIResponse.text().catch(() => "(illisible)");
    console.error("[analyze-rehab-plan] OPENAI_ERROR:", openAIResponse.status, errBody.substring(0, 400));
    if (openAIResponse.status === 429) {
      return jsonError("OPENAI_RATE_LIMIT", "Limite OpenAI atteinte. Réessayez dans quelques secondes.", undefined, 429);
    }
    return jsonError(
      "OPENAI_ERROR",
      `Erreur OpenAI HTTP ${openAIResponse.status}.`,
      { httpStatus: openAIResponse.status, body: errBody.substring(0, 300) },
      502,
    );
  }

  let openAIData: { choices?: { message?: { content?: string } }[] };
  try {
    openAIData = await openAIResponse.json();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return jsonError("OPENAI_PARSE_ERROR", "Réponse OpenAI non parsable.", { errorMessage }, 502);
  }

  const rawContent = openAIData.choices?.[0]?.message?.content ?? "";
  if (!rawContent) {
    return jsonError("EMPTY_RESPONSE", "L'IA a retourné une réponse vide.", undefined, 502);
  }

  // ── Parser le JSON de l'IA ────────────────────────────────────────────────
  let analysisData: Record<string, unknown>;
  try {
    const cleaned = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    analysisData = JSON.parse(cleaned);
    console.log("[analyze-rehab-plan] JSON IA OK — reliability:", analysisData.reliability);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[analyze-rehab-plan] AI_JSON_PARSE_ERROR:", errorMessage);
    return jsonError(
      "AI_JSON_PARSE_ERROR",
      "L'IA n'a pas retourné un JSON valide.",
      { errorMessage, rawPreview: rawContent.substring(0, 300) },
      502,
    );
  }

  // ── Validation minimale ───────────────────────────────────────────────────
  if (!analysisData.summary || !analysisData.reliability) {
    return jsonError(
      "INVALID_AI_STRUCTURE",
      "JSON IA incomplet (summary ou reliability manquant).",
      { receivedKeys: Object.keys(analysisData) },
      502,
    );
  }

  // ── Garde-fou serveur : surface totale jamais ≤ plus grande pièce ─────────
  // Si l'IA a malgré tout mis une surface de pièce dans totalSurface, on la rejette.
  try {
    const sm = analysisData.spatialMetrics as
      { totalSurface?: unknown; surfaceSource?: unknown } | undefined;
    const total = typeof sm?.totalSurface === "number" ? sm.totalSurface : null;

    // Plus grande surface de pièce détectée dans le discours (labels "... 80 m²")
    const corpus = JSON.stringify(analysisData.detectedSpatialElements ?? {});
    let maxRoom = 0;
    for (const m of corpus.matchAll(/(\d+(?:[.,]\d+)?)\s*m\s*[²2]/gi)) {
      const v = parseFloat(m[1].replace(",", "."));
      if (Number.isFinite(v) && v > maxRoom) maxRoom = v;
    }

    if (total !== null && maxRoom > 0 && total <= maxRoom) {
      console.warn(
        "[analyze-rehab-plan] totalSurface (", total,
        ") ≤ plus grande pièce (", maxRoom, ") → rejetée (surface de pièce, pas totale).",
      );
      analysisData.spatialMetrics = { totalSurface: null, surfaceSource: "non-determinable" };
    }
  } catch (e) {
    console.warn("[analyze-rehab-plan] garde-fou surface: échec silencieux", e);
  }

  // ── Succès ────────────────────────────────────────────────────────────────
  console.log(
    "[analyze-rehab-plan] ✅ Analyse terminée — riskLevel:", analysisData.riskLevel,
    "| totalSurface:", (analysisData.spatialMetrics as { totalSurface?: unknown })?.totalSurface,
  );

  return jsonOk({
    success: true,
    data: {
      ...analysisData,
      analyzedAt: new Date().toISOString(),
      engineMeta: {
        version: "v5-spatial-intelligence",
        mode: "real",
        model: "gpt-4o",
      },
    },
  });
});