import express, { Application, Request, Response, NextFunction } from "express";
import cors, { type CorsOptions } from "cors";
import extractZoneRouter from "./routes/extractZone";
import { AppError } from "./utils/errors";

/**
 * Crée et configure l'application Express
 */
export function createApp(): Application {
  const app = express();

  // ───────────────────────────────────────────────────────────────────────────
  // CORS
  // ───────────────────────────────────────────────────────────────────────────
  // En dev : Vite = http://localhost:5173
  // En prod : définir CORS_ORIGINS="https://ton-domaine.com,https://www.ton-domaine.com"
  const corsOriginsEnv = (process.env.CORS_ORIGINS || "").trim();
  const allowedOrigins =
    corsOriginsEnv.length > 0
      ? corsOriginsEnv.split(",").map((s) => s.trim()).filter(Boolean)
      : ["http://localhost:5173"];

  const corsOptions: CorsOptions = {
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    // IMPORTANT: si ton front envoie x-api-key (ou autre), il faut l'autoriser,
    // sinon le preflight échoue et tu retombes sur l'erreur CORS.
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-api-key",
      "x-client-info",
      "apikey",
    ],
    credentials: false, // passe à true uniquement si tu utilises cookies/sessions
    optionsSuccessStatus: 204,
  };

  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));

  // ───────────────────────────────────────────────────────────────────────────
  // Middlewares
  // ───────────────────────────────────────────────────────────────────────────
  app.use(express.json({ limit: "10mb" }));

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Routes API
  app.use("/api", extractZoneRouter);

  // 404 pour routes non trouvées
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: "Route non trouvée",
      statusCode: 404,
    });
  });

  // Middleware de gestion des erreurs
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Log de l'erreur en développement
    if (process.env.NODE_ENV !== "production") {
      console.error("[ERROR]", err);
    }

    // Erreur applicative connue
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        success: false,
        error: err.message,
        statusCode: err.statusCode,
      });
    }

    // Erreur JSON parsing (body parser)
    if (err instanceof SyntaxError && "body" in (err as any)) {
      return res.status(400).json({
        success: false,
        error: "JSON invalide dans le corps de la requête",
        statusCode: 400,
      });
    }

    // Erreur inattendue
    return res.status(500).json({
      success: false,
      error: "Erreur interne du serveur",
      statusCode: 500,
    });
  });

  return app;
}
