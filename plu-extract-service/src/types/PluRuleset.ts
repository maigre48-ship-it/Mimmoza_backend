/**
 * Types pour le schéma PLU Ruleset v1.0.1 (contenu JSONB stocké dans public.plu_rulesets_ai.ruleset)
 */

export interface PluRulesetMetadata {
  zoneCode: string;
  extractionDate: string;
  schemaVersion: string;
  sourceDocument?: string;
}

export interface PluRulesetCompleteness {
  score: number;
  missingFields: string[];
  confidence: string;
}

export interface PluRulesetRule {
  value: string | number | boolean | null;
  unit?: string;
  source: "EXTRACTED" | "INFERRED" | "DEFAULT";
  confidence?: number;
  rawText?: string;
}

export interface PluRuleset {
  metadata: PluRulesetMetadata;
  completeness: PluRulesetCompleteness;

  implantation?: Record<string, PluRulesetRule>;
  hauteur?: Record<string, PluRulesetRule>;
  emprise?: Record<string, PluRulesetRule>;
  stationnement?: Record<string, PluRulesetRule>;
  espaces_verts?: Record<string, PluRulesetRule>;
  destinations?: Record<string, PluRulesetRule>;

  [key: string]: unknown;
}

/**
 * Document PLU depuis la base de données
 */
export interface PluDocument {
  id: string;
  storage_path: string;
  commune_insee?: string;
  created_at: string;
}

/**
 * Ligne conforme à la table public.plu_rulesets_ai
 * Colonnes (résumé):
 * id (uuid, NOT NULL)
 * created_at (timestamptz, NOT NULL)
 * updated_at (timestamptz, NOT NULL)
 * document_id (uuid, NOT NULL)
 * commune_insee (text, NOT NULL)
 * zone_code (text, NOT NULL)
 * engine (text, NOT NULL)
 * model (text, NULL)
 * prompt_version (text, NULL)
 * source_pdf_storage_path (text, NULL)
 * ruleset (jsonb, NOT NULL)
 * completeness_ok (bool, NOT NULL)
 * missing (text[], NOT NULL)
 * confidence_score (int, NULL)
 * citations (jsonb, NULL)
 * diagnostics (jsonb, NULL)
 * error (text, NULL)
 */
export interface PluRulesetAiRow {
  id: string;
  created_at: string;
  updated_at: string;

  document_id: string;
  commune_insee: string;
  zone_code: string;

  engine: string;

  model?: string | null;
  prompt_version?: string | null;
  source_pdf_storage_path?: string | null;

  ruleset: PluRuleset;

  completeness_ok: boolean;
  missing: string[];

  confidence_score?: number | null;
  citations?: unknown | null;
  diagnostics?: unknown | null;
  error?: string | null;
}

/**
 * Payload recommandé côté service pour insérer (on laisse la DB gérer id/created_at/updated_at si defaults,
 * mais on les remplit par sécurité si nécessaire).
 */
export type PluRulesetAiInsert = Omit<PluRulesetAiRow, "created_at" | "updated_at"> & {
  created_at?: string;
  updated_at?: string;
};

/**
 * Corps de la requête API
 */
export interface ExtractZoneRequestBody {
  document_id: string;
  zone_code: string;
}

/**
 * Réponse API en cas de succès
 */
export interface ExtractZoneSuccessResponse {
  success: true;
  document_id: string;
  zone_code: string;
  ruleset_id: string;
  completeness_ok: boolean;
}

/**
 * Réponse API en cas d'erreur
 */
export interface ExtractZoneErrorResponse {
  success: false;
  error: string;
  statusCode: number;
}
