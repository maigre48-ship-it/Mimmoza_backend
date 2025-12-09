// scripts/plu-split-ascain-uc.js
// Objectif : lire PLU/plu-ascain-zone-UC.txt et le découper en articles UC1, UC2, ..., UC14

const fs = require("fs");
const path = require("path");

// Chemin vers ton fichier texte UC
const inputPath = path.join(__dirname, "..", "PLU", "plu-ascain-zone-UC.txt");

// Chemin de sortie
const outputPath = path.join(__dirname, "..", "parsed", "ascain-uc-articles.json");

// Lecture du fichier
const raw = fs.readFileSync(inputPath, "utf8");

// On normalise un peu les retours à la ligne
const text = raw.replace(/\r\n/g, "\n");

// On découpe sur les titres d'articles : "ARTICLE UC 1", "ARTICLE UC 2", etc.
const parts = text.split(/ARTICLE UC\s+(\d+)[^\n]*\n/);

// parts[0] = intro "DISPOSITIONS APPLICABLES ..."
// Ensuite : [num1, contenu1, num2, contenu2, num3, contenu3, ...]
let articles = [];

for (let i = 1; i < parts.length; i += 2) {
  const num = parts[i];        // ex "1"
  const content = parts[i + 1] || "";
  const id = `UC${num}`;

  const fullText = `ARTICLE UC ${num}\n${content.trim()}`;

  articles.push({
    article_id: id,
    article_text: fullText,
  });
}

fs.writeFileSync(outputPath, JSON.stringify(articles, null, 2), "utf8");

console.log("Découpage terminé.");
console.log("Articles trouvés :", articles.map(a => a.article_id).join(", "));
console.log("Fichier généré :", outputPath);
