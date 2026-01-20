import OpenAI from "openai";
import { BadGatewayError, InternalError } from "../utils/errors";

/**
 * Schéma JSON v1.0.1 pour les rulesets PLU
 */
const SCHEMA_V1_0_1 = `{
  "metadata": {
    "zoneCode": "string (code de la zone analysée)",
    "extractionDate": "string (date ISO)",
    "schemaVersion": "1.0.1",
    "sourceDocument": "string (optionnel)"
  },
  "completeness": {
    "score": "number (0-100)",
    "missingFields": ["string"],
    "confidence": "string (LOW|MEDIUM|HIGH)"
  },
  "implantation": {
    "recul_limite_separative": {
      "value": "number|null",
      "unit": "m",
      "source": "EXTRACTED|INFERRED|DEFAULT",
      "confidence": "number (0-1)",
      "rawText": "string (extrait du document)"
    },
    "recul_voie_publique": { ... },
    "recul_fond_parcelle": { ... }
  },
  "hauteur": {
    "hauteur_max": { ... },
    "hauteur_egout": { ... },
    "hauteur_faitage": { ... },
    "nombre_niveaux_max": { ... }
  },
  "emprise": {
    "ces_max": {
      "value": "number|null (coefficient 0-1)",
      "source": "EXTRACTED|INFERRED|DEFAULT"
    },
    "cos_max": { ... }
  },
  "stationnement": {
    "places_par_logement": { ... },
    "places_par_m2_commerce": { ... },
    "places_velo": { ... }
  },
  "espaces_verts": {
    "pourcentage_min": { ... },
    "arbre_par_place": { ... }
  },
  "destinations": {
    "habitation": { "value": "boolean", "source": "..." },
    "commerce": { ... },
    "bureau": { ... },
    "industrie": { ... },
    "equipement_public": { ... }
  }
}`;

/**
 * Prompt d'extraction PLU zone-only (PROMPT 02 v2)
 */
function buildExtractionPrompt(zoneCode: string, pluTextExcerpts: string): string {
  return `Tu es un expert en urbanisme français, spécialisé dans l'analyse des Plans Locaux d'Urbanisme (PLU).

## MISSION
Extraire les règles d'urbanisme de la zone **${zoneCode}** à partir du document PLU fourni.
Produire un JSON structuré conforme au schéma ci-dessous.

## ZONE À ANALYSER
Code zone: ${zoneCode}

## SCHÉMA JSON ATTENDU (v1.0.1)
${SCHEMA_V1_0_1}

## RÈGLES D'EXTRACTION

### Sources autorisées
- **EXTRACTED**: valeur trouvée explicitement dans le texte
- **INFERRED**: valeur déduite logiquement du contexte
- **DEFAULT**: valeur par défaut quand aucune règle n'existe

### Contraintes impératives
1. Ne JAMAIS utiliser "MANUAL" comme source
2. Toujours inclure le champ "rawText" avec l'extrait exact pour les valeurs EXTRACTED
3. Le score de completeness doit refléter le pourcentage de champs remplis
4. Les valeurs numériques doivent être des nombres, pas des chaînes
5. Si une règle ne s'applique pas à la zone, mettre value: null avec source: "DEFAULT"

### Format de sortie
- JSON valide uniquement
- Pas de commentaires
- Pas de texte avant ou après le JSON
- Encodage UTF-8

## DOCUMENT PLU À ANALYSER
<PLU_TEXT>
${pluTextExcerpts}
</PLU_TEXT>

## RÉPONSE
Génère uniquement le JSON structuré conforme au schéma, sans aucun texte additionnel.`;
}

/**
 * Client OpenAI singleton
 */
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new InternalError("Configuration OpenAI manquante (OPENAI_API_KEY)");
    }

    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Appelle l'API OpenAI pour extraire les règles PLU
 */
export async function extractPluRulesWithOpenAI(
  zoneCode: string,
  pluText: string
): Promise<string> {
  const client = getOpenAIClient();
  const model = process.env.OPENAI_MODEL || "gpt-4.1";

  const prompt = buildExtractionPrompt(zoneCode, pluText);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "Tu es un assistant spécialisé dans l'extraction de données structurées depuis des documents d'urbanisme. Tu réponds uniquement en JSON valide.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.1, // Basse température pour des résultats cohérents
      max_tokens: 2500,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new BadGatewayError("Réponse OpenAI vide");
    }

    return content;
  } catch (error) {
    if (error instanceof BadGatewayError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    throw new BadGatewayError(`Erreur OpenAI: ${message}`);
  }
}

/**
 * Retourne le nom du modèle configuré
 */
export function getModelName(): string {
  return process.env.OPENAI_MODEL || "gpt-4.1";
}