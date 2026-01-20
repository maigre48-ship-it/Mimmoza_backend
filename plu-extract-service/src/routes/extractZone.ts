import { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  ExtractZoneRequestBody,
  ExtractZoneSuccessResponse,
  PluRulesetAiInsert,
} from "../types/PluRuleset";
import {
  getPluDocument,
  downloadPdfFromStorage,
  insertRulesetAi,
} from "../services/supabase";
import { extractTextFromPdf } from "../services/pdf";
import { extractPluRulesWithOpenAI, getModelName } from "../services/openai";
import {
  validateRuleset,
  normalizeRuleset,
  isCompletenessOk,
} from "../services/validateRuleset";
import { BadRequestError } from "../utils/errors";

const router = Router();

/**
 * Extrait les lignes pertinentes du texte PDF pour réduire les tokens envoyés à OpenAI
 */
function extractRelevantText(
  pdfText: string,
  zoneCode?: string | null,
  maxChars = 12000
): string {
  const normalized = pdfText.replace(/\r/g, "");

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const patterns: RegExp[] = [
    /article/i,
    /art\./i,
    /implantation/i,
    /recul/i,
    /voirie/i,
    /voie/i,
    /alignement/i,
    /limites?\s+séparatives?/i,
    /fond/i,
    /hauteur/i,
    /gabarit/i,
    /emprise/i,
    /\bces\b/i,
    /\bcos\b/i,
    /\bsdp\b/i,
    /surface\s+de\s+plancher/i,
    /stationnement/i,
    /parking/i,
    /places/i,
  ];

  if (zoneCode && zoneCode.trim()) {
    patterns.push(new RegExp(`\\b${zoneCode.trim()}\\b`, "i"));
  }

  const relevantLines: string[] = [];
  let totalChars = 0;

  for (const line of lines) {
    const matches = patterns.some((pattern) => pattern.test(line));
    if (matches) {
      if (totalChars + line.length + 1 > maxChars) break;
      relevantLines.push(line);
      totalChars += line.length + 1;
    }
  }

  const result = relevantLines.join("\n");

  if (result.length < 500) {
    return normalized.slice(0, maxChars);
  }

  return result;
}

/**
 * Valide le corps de la requête
 */
function validateRequestBody(body: unknown): ExtractZoneRequestBody {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Corps de requête invalide");
  }

  const { document_id, zone_code } = body as Record<string, unknown>;

  if (!document_id || typeof document_id !== "string") {
    throw new BadRequestError("document_id est requis et doit être une chaîne");
  }

  if (!zone_code || typeof zone_code !== "string") {
    throw new BadRequestError("zone_code est requis et doit être une chaîne");
  }

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(document_id)) {
    throw new BadRequestError("document_id doit être un UUID valide");
  }

  const zoneCodeRegex = /^[A-Za-z0-9\-]{1,20}$/;
  if (!zoneCodeRegex.test(zone_code)) {
    throw new BadRequestError(
      "zone_code doit être alphanumérique (max 20 caractères)"
    );
  }

  return { document_id, zone_code };
}

/**
 * V2 response: on renvoie aussi `data` (payload IA structuré) pour remplir le front.
 * On garde le shape existant, et on l'étend sans casser.
 */
type ExtractZoneSuccessResponseV2 = ExtractZoneSuccessResponse & {
  data?: {
    completeness_ok: boolean;
    missing: string[];
    confidence_score: number | null;
    error: string | null;
    source?: string | null;

    reculs?: any;
    ces?: any;
    hauteur?: any;
    stationnement?: any;
    notes?: string[];
    zone_libelle?: string | null;
  };
};

/**
 * POST /api/plu-ai-extract-zone
 * Extrait les règles PLU d'une zone unique via OpenAI
 */
router.post(
  "/plu-ai-extract-zone",
  async (
    req: Request,
    res: Response<ExtractZoneSuccessResponseV2>,
    next: NextFunction
  ) => {
    try {
      // Étape 0: Validation de l'input
      const { document_id, zone_code } = validateRequestBody(req.body);

      // Étape 1: Lecture du document PLU depuis la base
      const pluDocument = await getPluDocument(document_id);

      const communeInsee = (pluDocument.commune_insee || "").trim();
      if (!communeInsee) {
        throw new BadRequestError(
          `Le document PLU ${document_id} ne contient pas commune_insee (requis)`
        );
      }

      // Étape 2: Téléchargement du PDF depuis Supabase Storage
      const pdfBuffer = await downloadPdfFromStorage(pluDocument.storage_path);

      // Étape 3: Extraction du texte avec pdf-parse
      const pluText = await extractTextFromPdf(pdfBuffer);

      // Étape 4: Filtrage du texte pour réduire les tokens
      const filteredText = extractRelevantText(pluText, zone_code, 12000);

      // Étape 5: Appel OpenAI pour extraire les règles
      const rawJsonResponse = await extractPluRulesWithOpenAI(zone_code, filteredText);

      // Étape 6: Validation stricte de la réponse LLM
      const validatedRuleset = validateRuleset(rawJsonResponse, zone_code);

      // Étape 7: Normalisation minimale
      const normalizedRuleset = normalizeRuleset(validatedRuleset, zone_code);

      // completeness_ok + missing
      const completenessOk = isCompletenessOk(normalizedRuleset);

      const missingFields = Array.isArray(
        (normalizedRuleset as any)?.completeness?.missingFields
      )
        ? (((normalizedRuleset as any).completeness.missingFields as unknown[]) || [])
            .filter((x) => typeof x === "string")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      // Étape 8: Persistance en base
      const now = new Date().toISOString();
      const rulesetId = uuidv4();

      const row: PluRulesetAiInsert = {
        id: rulesetId,
        document_id,
        commune_insee: communeInsee,
        zone_code,

        engine: "plu-extract-service",

        model: getModelName(),
        prompt_version: "prompt-02-v2",
        source_pdf_storage_path: pluDocument.storage_path,

        ruleset: normalizedRuleset,

        completeness_ok: completenessOk,
        missing: missingFields,

        created_at: now,
        updated_at: now,
      };

      // UPSERT en base (via services/supabase.ts)
      const insertedId = await insertRulesetAi(row);

      // ---- NOUVEAU: data complet pour le front ----
      // On renvoie le ruleset structuré (celui stocké en DB) afin que le front remplisse la grille.
      const confidenceScore =
        typeof (normalizedRuleset as any)?.confidence_score === "number"
          ? ((normalizedRuleset as any).confidence_score as number)
          : null;

      const dataPayload = {
        completeness_ok: completenessOk,
        missing: missingFields,
        confidence_score: confidenceScore,
        error: null as string | null,
        source: "plu-extract-service" as string,

        // Ces champs sont ceux attendus par ton front (AiExtractResultData)
        reculs: (normalizedRuleset as any)?.reculs,
        ces: (normalizedRuleset as any)?.ces,
        hauteur: (normalizedRuleset as any)?.hauteur,
        stationnement: (normalizedRuleset as any)?.stationnement,
        notes: Array.isArray((normalizedRuleset as any)?.notes)
          ? ((normalizedRuleset as any).notes as string[])
          : [],
        zone_libelle:
          typeof (normalizedRuleset as any)?.zone_libelle === "string"
            ? ((normalizedRuleset as any).zone_libelle as string)
            : null,
      };

      // Réponse succès (compat + data)
      const response: ExtractZoneSuccessResponseV2 = {
        success: true,
        document_id,
        zone_code,
        ruleset_id: insertedId,
        completeness_ok: completenessOk,
        data: dataPayload,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
