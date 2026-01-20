import { PluRuleset, PluRulesetRule } from "../types/PluRuleset";
import { UnprocessableEntityError } from "../utils/errors";

/**
 * Clés racines attendues dans le JSON
 */
const REQUIRED_ROOT_KEYS = ["metadata", "completeness"];

/**
 * Valide la structure et le contenu de la réponse LLM
 * Lance une erreur 422 si la validation échoue
 */
export function validateRuleset(rawJson: string, expectedZoneCode: string): PluRuleset {
  // 1. Parser le JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new UnprocessableEntityError("La réponse OpenAI n'est pas un JSON valide");
  }

  // Vérifier que c'est un objet
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UnprocessableEntityError("La réponse doit être un objet JSON");
  }

  const ruleset = parsed as Record<string, unknown>;

  // 2. Vérifier la présence des clés racines obligatoires
  for (const key of REQUIRED_ROOT_KEYS) {
    if (!(key in ruleset)) {
      throw new UnprocessableEntityError(`Clé racine manquante: ${key}`);
    }
  }

  // 3. Valider metadata
  const metadata = ruleset.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== "object") {
    throw new UnprocessableEntityError("metadata doit être un objet");
  }

  // 4. Vérifier metadata.zoneCode === zone_code attendu
  if (metadata.zoneCode !== expectedZoneCode) {
    throw new UnprocessableEntityError(
      `metadata.zoneCode (${metadata.zoneCode}) ne correspond pas à la zone demandée (${expectedZoneCode})`
    );
  }

  // 5. Valider completeness
  const completeness = ruleset.completeness as Record<string, unknown> | undefined;
  if (!completeness || typeof completeness !== "object") {
    throw new UnprocessableEntityError("completeness doit être un objet");
  }

  if (!("score" in completeness)) {
    throw new UnprocessableEntityError("completeness.score est requis");
  }

  // 6. Vérifier l'absence de source = "MANUAL"
  if (containsManualSource(ruleset)) {
    throw new UnprocessableEntityError('source "MANUAL" détectée, non autorisée');
  }

  return ruleset as unknown as PluRuleset;
}

/**
 * Parcourt récursivement l'objet pour détecter source: "MANUAL"
 */
function containsManualSource(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  if (Array.isArray(obj)) {
    return obj.some((item) => containsManualSource(item));
  }

  const record = obj as Record<string, unknown>;

  // Vérifier si c'est une règle avec source: "MANUAL"
  if ("source" in record && record.source === "MANUAL") {
    return true;
  }

  // Parcourir récursivement les propriétés
  for (const value of Object.values(record)) {
    if (containsManualSource(value)) {
      return true;
    }
  }

  return false;
}

/**
 * Normalise le ruleset sans modifier le fond
 * - Force metadata.zoneCode
 * - Ajoute metadata.extractionDate
 */
export function normalizeRuleset(ruleset: PluRuleset, zoneCode: string): PluRuleset {
  const normalized: PluRuleset = {
    ...ruleset,
    metadata: {
      ...ruleset.metadata,
      zoneCode: zoneCode, // Force le code zone
      extractionDate: new Date().toISOString(), // Ajoute la date d'extraction
      schemaVersion: "1.0.1",
    },
  };

  return normalized;
}

/**
 * Détermine si le completeness est OK (score >= 50)
 */
export function isCompletenessOk(ruleset: PluRuleset): boolean {
  const score = ruleset.completeness?.score;
  if (typeof score !== "number") {
    return false;
  }
  return score >= 50;
}
