// supabase/functions/transcribe-rehab-plan/index.ts
// v2 — Retranscription vectorielle prudente d'un plan architectural
// Correctif : max_tokens 6000 → 16000 (les plans à ~16 pièces tronquaient la
// sortie → une seule pièce survivait). + logs finish_reason / compteurs.
// Runtime Supabase Edge Function / Deno

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

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
    JSON.stringify({
      success: false,
      error: {
        code,
        message,
        ...(debug ? { debug } : {}),
      },
    }),
    {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    },
  );
}

const SYSTEM_PROMPT = `
Tu es un moteur de retranscription vectorielle de plans architecturaux.

Ta mission est STRICTEMENT limitée :
- recopier le plan source visible ;
- extraire les éléments géométriques visibles ;
- produire un JSON vectoriel éditable ;
- préparer la validation humaine.

Tu n'es PAS un décorateur.
Tu n'es PAS un générateur de variantes.
Tu n'es PAS un auditeur réglementaire.
Tu ne dois PAS proposer de nouveau plan.

RÈGLES ABSOLUES :
1. Ne jamais inventer une pièce.
2. Ne jamais déplacer une pièce.
3. Ne jamais créer une cloison qui n'existe pas.
4. Ne jamais créer une porte ou fenêtre non visible.
5. Ne jamais affirmer qu'un mur est porteur sans légende explicite.
6. Un mur épais peut seulement être classé "candidate_load_bearing".
7. Toute incertitude doit être marquée "to_confirm".
8. Si une surface est écrite dans le plan, recopier la valeur texte.
9. Ne pas recalculer une surface affichée.
10. Si une surface totale visible existe, la retourner dans spatialMetrics.totalSurface.
11. Ne jamais fusionner deux pièces distinctes.
12. Ne jamais couper une pièce existante pour créer une nouvelle pièce.
13. Les coordonnées doivent être exprimées dans un repère image normalisé 0 à 1000.
14. L'origine est en haut à gauche.
15. x augmente vers la droite.
16. y augmente vers le bas.
17. Les éléments doivent être assez simples pour être corrigés dans un éditeur SVG.
18. Retourner uniquement un JSON valide.

EXHAUSTIVITÉ — RÈGLE CRITIQUE :
19. Tu dois retranscrire TOUTES les pièces nommées visibles sur le plan, sans exception
    et sans en omettre aucune. Si le plan comporte 16 pièces, le tableau "rooms" doit
    contenir 16 entrées. Ne t'arrête jamais après quelques pièces.
20. Pour rester dans le budget de sortie, garde les polygones SIMPLES : un rectangle
    de pièce = 4 sommets (coins), pas davantage. Ne subdivise pas inutilement.
    Priorité ABSOLUE à la complétude du nombre de pièces sur la finesse des contours.
`.trim();

const USER_PROMPT = `
Retranscris ce plan architectural en JSON vectoriel.

Tu dois extraire uniquement les éléments visibles :
- enveloppe extérieure ;
- murs ;
- pièces (TOUTES, sans exception) ;
- portes ;
- fenêtres ;
- zones humides ;
- annotations de surface ;
- échelle graphique ou cotes si visibles.

IMPORTANT :
- Les coordonnées doivent être normalisées entre 0 et 1000.
- Ne génère pas de nouveau plan.
- Ne propose aucune optimisation.
- Ne fais aucune analyse réglementaire.
- Les murs porteurs doivent rester à confirmer par l'utilisateur sauf preuve explicite.
- Si tu n'es pas certain, utilise status="to_confirm".
- Si un élément n'est pas visible, retourne un tableau vide [].
- EXHAUSTIVITÉ : retranscris TOUTES les pièces nommées. N'en omets aucune. Polygones
  simples (rectangles à 4 coins) pour tenir dans le budget, mais liste complète.

Retourne uniquement ce JSON :

{
  "version": "1.0",
  "coordinateSystem": {
    "type": "normalized_image",
    "width": 1000,
    "height": 1000,
    "origin": "top_left",
    "unit": "normalized"
  },
  "reliability": "faible" | "moyenne" | "forte",
  "scale": {
    "status": "detected" | "to_confirm" | "missing",
    "pixelsPerMeter": null,
    "metersPerUnit": null,
    "source": null,
    "label": null
  },
  "spatialMetrics": {
    "totalSurface": null,
    "totalSurfaceLabel": null,
    "surfaceSource": "annotation-plan" | "piece-labels" | "non-determinable"
  },
  "envelope": {
    "id": "env-001",
    "status": "detected" | "to_confirm",
    "confidence": 0,
    "polygon": [
      { "x": 0, "y": 0 }
    ],
    "notes": []
  },
  "walls": [
    {
      "id": "wall-001",
      "status": "detected" | "to_confirm",
      "kind": "unknown" | "partition" | "candidate_load_bearing",
      "confidence": 0,
      "thickness": "thin" | "medium" | "thick" | "unknown",
      "start": { "x": 0, "y": 0 },
      "end": { "x": 0, "y": 0 },
      "polyline": [
        { "x": 0, "y": 0 }
      ],
      "notes": []
    }
  ],
  "rooms": [
    {
      "id": "room-001",
      "status": "detected" | "to_confirm",
      "confidence": 0,
      "label": "Nom exact visible ou null",
      "type": "bedroom" | "living" | "kitchen" | "bathroom" | "wc" | "corridor" | "technical" | "storage" | "unknown",
      "surfaceLabel": "Surface exacte visible ou null",
      "surfaceM2": null,
      "polygon": [
        { "x": 0, "y": 0 }
      ],
      "notes": []
    }
  ],
  "openings": [
    {
      "id": "opening-001",
      "status": "detected" | "to_confirm",
      "confidence": 0,
      "type": "door" | "window" | "unknown",
      "wallId": null,
      "position": { "x": 0, "y": 0 },
      "widthLabel": null,
      "swing": "left" | "right" | "sliding" | "unknown",
      "notes": []
    }
  ],
  "wetZones": [
    {
      "id": "wet-001",
      "status": "detected" | "to_confirm",
      "confidence": 0,
      "roomId": null,
      "type": "bathroom" | "wc" | "kitchen" | "technical" | "unknown",
      "polygon": [
        { "x": 0, "y": 0 }
      ],
      "evidence": "Texte ou symbole visible",
      "notes": []
    }
  ],
  "annotations": [
    {
      "id": "ann-001",
      "status": "detected" | "to_confirm",
      "kind": "room_label" | "surface" | "dimension" | "scale" | "legend" | "north" | "other",
      "text": "Texte exact visible",
      "position": { "x": 0, "y": 0 },
      "confidence": 0
    }
  ],
  "userValidation": {
    "requiresHumanReview": true,
    "mustConfirmLoadBearingWalls": true,
    "mustConfirmScale": true,
    "mustConfirmWetZones": true,
    "lockedForGeneration": true
  },
  "warnings": []
}
`.trim();

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== "POST") {
    return jsonError("METHOD_NOT_ALLOWED", "POST requis.", undefined, 405);
  }

  const contentType = req.headers.get("content-type") ?? "";

  let formData: FormData;

  try {
    formData = await req.formData();
  } catch (err) {
    return jsonError(
      "FORMDATA_PARSE_FAILED",
      "Impossible de lire le corps multipart/form-data.",
      {
        contentType,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    );
  }

  const fileRaw = formData.get("file");

  if (!fileRaw) {
    return jsonError("FILE_MISSING", 'Aucun champ "file" trouvé dans le FormData.');
  }

  const hasArrayBuffer =
    typeof (fileRaw as { arrayBuffer?: unknown }).arrayBuffer === "function";

  if (!hasArrayBuffer) {
    return jsonError("INVALID_FILE_OBJECT", 'Le champ "file" n’est pas un Blob lisible.');
  }

  const file = fileRaw as Blob;
  const fileType = file.type;
  const fileSize = file.size;
  const fileName = fileRaw instanceof File ? fileRaw.name : "(blob sans nom)";

  const allowedTypes = ["image/png", "image/jpeg", "image/webp", "application/pdf"];

  if (!allowedTypes.includes(fileType)) {
    return jsonError("UNSUPPORTED_FORMAT", `Format "${fileType}" non supporté.`, {
      fileType,
      allowedTypes,
    });
  }

  if (fileType === "application/pdf") {
    return jsonError(
      "PDF_NOT_SUPPORTED_YET",
      "La retranscription PDF n'est pas encore activée. Utilisez une image PNG, JPEG ou WEBP.",
    );
  }

  if (fileSize > 15 * 1024 * 1024) {
    return jsonError("FILE_TOO_LARGE", "Fichier trop volumineux. Limite actuelle : 15 Mo.", {
      fileName,
      fileType,
      fileSize,
    });
  }

  let base64: string;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    base64 = bytesToBase64(bytes);
  } catch (err) {
    return jsonError(
      "FILE_READ_ERROR",
      "Impossible de lire le fichier.",
      {
        fileName,
        fileType,
        fileSize,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }

  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

  if (!OPENAI_API_KEY) {
    return jsonError("OPENAI_KEY_MISSING", "Variable OPENAI_API_KEY manquante.", undefined, 500);
  }

  const dataUrl = `data:${fileType};base64,${base64}`;

  let openAIResponse: Response;

  try {
    openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0,
        max_tokens: 16000, // ← débridé (était 6000 : tronquait les plans à ~16 pièces)
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: USER_PROMPT,
              },
              {
                type: "image_url",
                image_url: {
                  url: dataUrl,
                  detail: "high",
                },
              },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    return jsonError(
      "OPENAI_NETWORK_ERROR",
      "Impossible de joindre l'API OpenAI.",
      {
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }

  if (!openAIResponse.ok) {
    const body = await openAIResponse.text().catch(() => "(illisible)");

    return jsonError(
      "OPENAI_ERROR",
      `Erreur OpenAI HTTP ${openAIResponse.status}.`,
      {
        status: openAIResponse.status,
        body: body.substring(0, 500),
      },
      openAIResponse.status === 429 ? 429 : 502,
    );
  }

  let openAIData: {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string;
      };
    }>;
  };

  try {
    openAIData = await openAIResponse.json();
  } catch (err) {
    return jsonError(
      "OPENAI_PARSE_ERROR",
      "Réponse OpenAI non parsable.",
      {
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }

  const finishReason = openAIData.choices?.[0]?.finish_reason ?? "(absent)";
  console.log("[transcribe-rehab-plan] finish_reason:", finishReason);

  const rawContent = openAIData.choices?.[0]?.message?.content ?? "";

  if (!rawContent.trim()) {
    return jsonError("EMPTY_RESPONSE", "L'IA a retourné une réponse vide.", undefined, 502);
  }

  let transcription: Record<string, unknown>;

  try {
    const cleaned = rawContent
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    transcription = JSON.parse(cleaned);
  } catch (err) {
    // Si le JSON est cassé ET que la sortie a été tronquée, on le dit clairement.
    if (finishReason === "length") {
      return jsonError(
        "OUTPUT_TRUNCATED",
        "La sortie IA a été tronquée (plan trop dense). Réessayez ou simplifiez le plan.",
        { finishReason, rawPreview: rawContent.substring(0, 500) },
        502,
      );
    }
    return jsonError(
      "AI_JSON_PARSE_ERROR",
      "L'IA n'a pas retourné un JSON valide.",
      {
        errorMessage: err instanceof Error ? err.message : String(err),
        rawPreview: rawContent.substring(0, 500),
      },
      502,
    );
  }

  if (!transcription.envelope || !Array.isArray(transcription.walls)) {
    return jsonError(
      "INVALID_TRANSCRIPTION_STRUCTURE",
      "JSON de retranscription incomplet.",
      {
        receivedKeys: Object.keys(transcription),
      },
      502,
    );
  }

  // Diagnostic : combien d'éléments extraits ?
  const roomsCount    = Array.isArray(transcription.rooms) ? transcription.rooms.length : 0;
  const wallsCount    = Array.isArray(transcription.walls) ? transcription.walls.length : 0;
  const openingsCount = Array.isArray(transcription.openings) ? transcription.openings.length : 0;
  console.log(
    "[transcribe-rehab-plan] extraits — rooms:", roomsCount,
    "| walls:", wallsCount,
    "| openings:", openingsCount,
    "| finish_reason:", finishReason,
  );

  return jsonOk({
    success: true,
    data: {
      ...transcription,
      transcribedAt: new Date().toISOString(),
      sourceMeta: {
        fileName,
        fileType,
        fileSize,
      },
      engineMeta: {
        version: "v2-plan-transcription",
        mode: "real",
        model: "gpt-4o",
        coordinateSystem: "normalized_image_1000",
        finishReason,
        roomsCount,
      },
    },
  });
});