import "dotenv/config";
import { createApp } from "./server";

/**
 * Variables d'environnement requises
 */
const REQUIRED_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
] as const;

type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/**
 * Vérifie la présence des variables d'environnement requises
 */
function checkEnvironment(): void {
  const missing: RequiredEnvVar[] = REQUIRED_ENV_VARS.filter(
    (key) => !process.env[key] || String(process.env[key]).trim() === ""
  );

  if (missing.length > 0) {
    console.error(
      `[FATAL] Variables d'environnement manquantes: ${missing.join(", ")}`
    );
    process.exit(1);
  }
}

/**
 * Démarre le serveur Express
 */
function startServer(): void {
  checkEnvironment();

  const app = createApp();

  const portRaw = process.env.PORT?.trim() || "3000";
  const port = Number.parseInt(portRaw, 10);

  if (!Number.isFinite(port) || port <= 0) {
    console.error(`[FATAL] PORT invalide: "${portRaw}"`);
    process.exit(1);
  }

  const server = app.listen(port, () => {
    console.log(`[INFO] Serveur PLU AI Extract démarré sur le port ${port}`);
    console.log(
      `[INFO] Modèle OpenAI: ${process.env.OPENAI_MODEL?.trim() || "gpt-4.1"}`
    );
    console.log(
      `[INFO] Environnement: ${process.env.NODE_ENV?.trim() || "development"}`
    );
  });

  server.on("error", (err) => {
    console.error("[FATAL] Erreur serveur (listen)", err);
    process.exit(1);
  });
}

// Démarrage
startServer();
