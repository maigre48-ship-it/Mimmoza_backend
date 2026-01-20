import pdfParse from "pdf-parse";
import { BadGatewayError } from "../utils/errors";

/**
 * Extrait le texte brut d'un PDF
 * Utilise pdf-parse, sans OCR ni post-traitement avancé
 */
export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  try {
    const result = await pdfParse(pdfBuffer, {
      // Options minimales pour pdf-parse
      max: 0, // Pas de limite de pages
    });

    // Retourne le texte brut sans modification
    return result.text;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    throw new BadGatewayError(`Échec de l'extraction du texte PDF: ${message}`);
  }
}
