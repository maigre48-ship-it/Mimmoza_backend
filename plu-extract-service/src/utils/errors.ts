/**
 * Classe d'erreur personnalisée avec code HTTP
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Erreur 400 - Input invalide
 */
export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

/**
 * Erreur 404 - Ressource introuvable
 */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
  }
}

/**
 * Erreur 422 - Données non conformes
 */
export class UnprocessableEntityError extends AppError {
  constructor(message: string) {
    super(message, 422);
  }
}

/**
 * Erreur 500 - Erreur interne
 */
export class InternalError extends AppError {
  constructor(message: string) {
    super(message, 500);
  }
}

/**
 * Erreur 502 - Service externe indisponible
 */
export class BadGatewayError extends AppError {
  constructor(message: string) {
    super(message, 502);
  }
}
