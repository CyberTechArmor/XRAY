import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  // `details` is an opt-in escape hatch for structured payload that the
  // client needs alongside the error code. Step 9 uses it for
  // `attempts_remaining` on magic-link verify failures so the auth modal
  // can render the "N attempts left" banner without a separate endpoint.
  // Keep payloads minimal and unlikely to leak — never PII / secrets.
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.headers['x-request-id'] || '';
  const timestamp = new Date().toISOString();

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
      meta: { request_id: requestId, timestamp },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
      meta: { request_id: requestId, timestamp },
    });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    meta: { request_id: requestId, timestamp },
  });
}
