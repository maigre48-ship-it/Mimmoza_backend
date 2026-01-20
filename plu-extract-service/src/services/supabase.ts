import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import { PluDocument, PluRulesetAiInsert } from "../types/PluRuleset";
import { NotFoundError, BadGatewayError, InternalError } from "../utils/errors";

/**
 * Client Supabase singleton avec Service Role Key
 */
let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      throw new InternalError("Configuration Supabase manquante");
    }

    supabaseClient = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return supabaseClient;
}

function newUuid(): string {
  // Node >= 19 a crypto.randomUUID; on fallback proprement sinon.
  const maybeCrypto = (globalThis as any).crypto;
  const rand = maybeCrypto?.randomUUID;
  if (typeof rand === "function") return rand.call(maybeCrypto);
  return uuidv4();
}

/**
 * Récupère un document PLU depuis la table public.plu_documents
 */
export async function getPluDocument(documentId: string): Promise<PluDocument> {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from("plu_documents")
    .select("id, storage_path, commune_insee, created_at")
    .eq("id", documentId)
    .single();

  if (error) {
    // PGRST116 = "Results contain 0 rows" (single() not found)
    if (error.code === "PGRST116") {
      throw new NotFoundError(`Document PLU introuvable: ${documentId}`);
    }
    throw new BadGatewayError(`Erreur Supabase: ${error.message}`);
  }

  if (!data) {
    throw new NotFoundError(`Document PLU introuvable: ${documentId}`);
  }

  return data as PluDocument;
}

/**
 * Télécharge un fichier PDF depuis Supabase Storage (bucket plu_raw)
 */
export async function downloadPdfFromStorage(storagePath: string): Promise<Buffer> {
  const client = getSupabaseClient();
  const bucket = "plu_raw";

  const { data, error } = await client.storage.from(bucket).download(storagePath);

  if (error) {
    throw new BadGatewayError(`Impossible de télécharger le PDF: ${error.message}`);
  }

  if (!data) {
    throw new BadGatewayError("Le fichier PDF est vide ou inaccessible");
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * UPSERT un ruleset AI dans la table public.plu_rulesets_ai
 * - Évite l'erreur duplicate key sur la contrainte unique (document_id, zone_code)
 * - Retourne toujours l'id de la ligne (existante ou nouvellement créée)
 * IMPORTANT: mapping strict sur les colonnes réelles.
 */
export async function insertRulesetAi(row: PluRulesetAiInsert): Promise<string> {
  const client = getSupabaseClient();

  const now = new Date().toISOString();

  // NB: onConflict porte sur (document_id, zone_code).
  // On veut:
  // - created_at: initial (si nouveau)
  // - updated_at: maintenant (toujours)
  // - id: fixé si nouveau, conservé si déjà existant
  const payload: Record<string, any> = {
    // id: si la ligne existe déjà, la DB gardera l'id existant.
    // Côté Supabase, upsert ignore l'id en cas de conflit.
    id: row.id ?? newUuid(),

    document_id: row.document_id,
    commune_insee: row.commune_insee,
    zone_code: row.zone_code,

    engine: row.engine,
    model: row.model ?? null,
    prompt_version: row.prompt_version ?? null,
    source_pdf_storage_path: row.source_pdf_storage_path ?? null,

    ruleset: row.ruleset,

    completeness_ok: row.completeness_ok,
    missing: row.missing ?? [],

    confidence_score: row.confidence_score ?? null,
    citations: row.citations ?? null,
    diagnostics: row.diagnostics ?? null,
    error: row.error ?? null,

    // timestamps
    updated_at: now,
  };

  // created_at: ne pas écraser si update
  // si row.created_at fourni, on le prend, sinon on met now pour création
  payload.created_at = row.created_at ?? now;

  const { data, error } = await client
    .from("plu_rulesets_ai")
    .upsert(payload, { onConflict: "document_id,zone_code" })
    .select("id")
    .single();

  if (error) {
    throw new InternalError(`Échec UPSERT ruleset AI: ${error.message}`);
  }

  if (!data?.id) {
    throw new InternalError("UPSERT OK mais aucun id retourné");
  }

  return String(data.id);
}
