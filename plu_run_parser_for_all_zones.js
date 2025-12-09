// plu_run_parser_for_all_zones.js
// --------------------------------------------------
// Usage : node plu_run_parser_for_all_zones.js <commune_insee> <commune_nom> <source_id>
// Exemple :
// node plu_run_parser_for_all_zones.js 75056 "Paris" 0829-...
// --------------------------------------------------

const { Pool } = require("pg");
const fetch = require("node-fetch");

// 👉 Connection string (la même que dans tes autres scripts qui marchent)
const connectionString =
  "postgresql://postgres.fwvrqngbafqdaekbdfnm:kJVsLJSakXQrN7Cy@aws-1-eu-north-1.pooler.supabase.com:5432/postgres";

// 👉 URL de ta Edge Function
const FUNCTION_URL =
  "https://fwvrqngbafqdaekbdfnm.functions.supabase.co/plu-universal-parser";

const pool = new Pool({ connectionString });

async function main() {
  const [commune_insee, commune_nom, source_id] = process.argv.slice(2);

  if (!commune_insee || !commune_nom || !source_id) {
    console.error(
      "Usage: node plu_run_parser_for_all_zones.js <commune_insee> <commune_nom> <source_id>",
    );
    process.exit(1);
  }

  const client = await pool.connect();

  try {
    console.log("🔍 Récupération des zones distinctes pour la source :", source_id);

    const { rows } = await client.query(
      `
      select distinct zone_code
      from plu_text_chunks
      where source_id = $1
        and zone_code is not null
        and zone_code <> ''
      order by zone_code
      `,
      [source_id],
    );

    if (!rows.length) {
      console.log("⚠️ Aucune zone trouvée dans plu_text_chunks pour cette source.");
      return;
    }

    console.log(
      "Zones détectées :",
      rows.map((r) => r.zone_code).join(", "),
    );

    for (const row of rows) {
      const zone_code = row.zone_code;
      console.log(`\n🚀 Lancement du parser pour la zone ${zone_code}...`);

      const body = {
        commune_insee,
        commune_nom,
        zone_code,
        source_id,
        mode: "auto",
      };

      const response = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const status = response.status;
      const text = await response.text();

      console.log(`  → Status ${status}`);
      console.log(`  → Réponse : ${text}`);
    }

    console.log("\n🎉 Parsing terminé pour toutes les zones.");
  } catch (err) {
    console.error("❌ Erreur orchestrateur :", err);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Erreur globale :", err);
  process.exit(1);
});
