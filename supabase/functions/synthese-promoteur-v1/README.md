# synthese-promoteur-v1

Edge Function Supabase qui génère une note d’investissement (banque / comité) via IA.

## Input
POST JSON:
- snapshot: données projet + modules (plu, marché, risques, massing, bilan)
- generatedFor: "banque" | "comite"
- tone: "banque" | "invest"

## Output
- markdown: note complète (Markdown)
- warnings: incohérences / données manquantes
- updatedAt / model

## TODO
Brancher l’appel à Claude (Étape 3).
