// plu_auto_chunker_from_txt.js
// --------------------------------------------------
// Usage : node plu_auto_chunker_from_txt.js <commune_insee> <commune_nom> <source_id> <path_txt>
// Exemple :
// node plu_auto_chunker_from_txt.js 75056 "Paris" 0829-... "C:\\...\\plu_paris_reglement.txt"
// --------------------------------------------------

const fs = require("fs");
const { Pool } = require("pg");

// 👉 Connection string (Session Pooler EXACTE Supabase)
const connectionString =
  "postgresql://postgres.fwvrqngbafqdaekbdfnm:kJVsLJSakXQrN7Cy@aws-1-eu-north-1.pooler.supabase.com:5432/postgres";

const pool = new Pool({ connectionString });

async function main() {
  const [commune_insee, commune_nom, source_id, txtPath] = process.argv.slice(2);

  if (!commune_insee || !commune_nom || !source_id || !txtPath) {
    console.error(
      "Usage: node plu_auto_chunker_from_txt.js <commune_insee> <commune_nom> <source_id> <path_txt>",
    );
    process.exit(1);
  }

  if (!fs.existsSync(txtPath)) {
    console.error("Fichier texte introuvable :", txtPath);
    process.exit(1);
  }

  console.log("📄 Lecture du fichier :", txtPath);
  const fullText = fs.readFileSync(txtPath, "utf-8");

  // On découpe par lignes
  const lines = fullText.split(/\r?\n/);

  // Regex typiques :
  // - Titre de zone : "Zone UG" ou "ZONE UG"
  const zoneTitleRegex = /^\s*ZON[Ee]\s+([A-Z]{1,3})\b/;
  // - Article : "ARTICLE UG.6" ou "Article UA.7"
  const articleRegex = /^\s*ARTICLE\s+([A-Z]{1,3})\.(\d+)\b/i;

  let currentZone = null;         // ex: "UG"
  let currentArticle = null;      // ex: "UG.6"
  let currentBuffer = [];
  let chunks = [];

  function flushCurrent() {
    if (currentZone && currentArticle && currentBuffer.length > 0) {
      const raw_text = currentBuffer.join("\n").trim();
      if (raw_text.length > 0) {
        const section_label = `Article ${currentArticle}`;
        chunks.push({
          source_id,
          page_number: null, // inconnu à partir du .txt
          section_label,
          raw_text,
          zone_code: currentZone,
        });
        console.log(
          `  ➕ Chunk créé : zone=${currentZone}, article=${currentArticle}, ~${raw_text.length} caractères`,
        );
      }
    }
    currentArticle = null;
    currentBuffer = [];
  }

  console.log("🔍 Parsing du texte pour détecter zones + articles...");

  for (const line of lines) {
    const zoneMatch = line.match(zoneTitleRegex);
    const articleMatch = line.match(articleRegex);

    if (zoneMatch) {
      // Nouveau titre de zone détecté : on flush l'article en cours
      flushCurrent();
      currentZone = zoneMatch[1]; // ex: "UG"
      console.log(`➡️ Zone détectée : ${currentZone}`);
      continue;
    }

    if (articleMatch) {
      // Nouvel article : flush l'ancien
      const zoneFromArticle = articleMatch[1]; // ex: "UG"
      const numArticle = articleMatch[2];      // ex: "6"
      const articleFull = `${zoneFromArticle}.${numArticle}`;

      // Si on change d'article, on flush le précédent
      flushCurrent();

      // On met à jour la zone à partir de l'article si besoin
      currentZone = zoneFromArticle;
      currentArticle = articleFull;

      console.log(`  ✳ ARTICLE détecté : ${articleFull}`);
      // On garde aussi la ligne d'en-tête d'article dans le buffer
      currentBuffer.push(line);
      continue;
    }

    // Sinon, ligne normale → on la met dans le buffer si on est dans un article
    if (currentArticle) {
      currentBuffer.push(line);
    }
  }

  // Flush final
  flushCurrent();

  console.log(`✅ Nombre de chunks détectés : ${chunks.length}`);

  if (chunks.length === 0) {
    console.log("⚠️ Aucun chunk détecté, vérifie le format du texte / regex.");
    process.exit(0);
  }

  // --------------------------------------------------
  // Insertion en base
  // --------------------------------------------------
  const client = await pool.connect();

  try {
    console.log("💾 Insertion dans plu_text_chunks...");
    const insertText = `
      insert into plu_text_chunks (
        source_id,
        page_number,
        section_label,
        raw_text,
        zone_code
      ) values
      ($1, $2, $3, $4, $5)
      returning id
    `;

    for (const chunk of chunks) {
      const values = [
        chunk.source_id,
        chunk.page_number,
        chunk.section_label,
        chunk.raw_text,
        chunk.zone_code,
      ];
      const res = await client.query(insertText, values);
      console.log("   → Chunk inséré id =", res.rows[0].id);
    }

    console.log("🎉 Import terminé avec succès.");
  } catch (err) {
    console.error("❌ Erreur d'insertion :", err);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Erreur globale :", err);
  process.exit(1);
});
