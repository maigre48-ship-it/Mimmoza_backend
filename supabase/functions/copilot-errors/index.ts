// supabase/functions/_shared/copilot/errors.ts

/**
 * Codes d'erreur métier du Copilot.
 * Mappés sur des status HTTP par ERROR_STATUS_MAP.
 */
export type CopilotErrorCode =
  | 'INSUFFICIENT_CREDITS'
  | 'INVALID_MODE'
  | 'INVALID_AMOUNT'
  | 'CONTEXT_REQUIRED'
  | 'CONTEXT_TOO_LARGE'
  | 'TOOL_ERROR'
  | 'LLM_ERROR'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'RESERVATION_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND';

export const ERROR_STATUS_MAP: Record<CopilotErrorCode, number> = {
  INSUFFICIENT_CREDITS: 402,
  INVALID_MODE: 400,
  INVALID_AMOUNT: 400,
  CONTEXT_REQUIRED: 400,
  CONTEXT_TOO_LARGE: 413,
  TOOL_ERROR: 500,
  LLM_ERROR: 502,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  RESERVATION_NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
};

export class CopilotError extends Error {
  readonly code: CopilotErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CopilotErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CopilotError';
    this.code = code;
    this.statusCode = ERROR_STATUS_MAP[code];
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }

  toResponse(): Response {
    return new Response(JSON.stringify(this.toJSON()), {
      status: this.statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Helper : convertit n'importe quoi en Response d'erreur propre.
 */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof CopilotError) return err.toResponse();
  console.error('[copilot] unexpected error', err);
  return new CopilotError(
    'INTERNAL_ERROR',
    err instanceof Error ? err.message : 'Unknown error',
  ).toResponse();
}