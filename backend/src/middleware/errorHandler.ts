import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
}

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('Error:', err.message);
  if (err.stack) console.error('Stack:', err.stack);

  const statusCode = err.statusCode || 500;
  const isClientError = statusCode >= 400 && statusCode < 500;
  const isDevelopment = process.env.NODE_ENV === 'development';
  // Show the actual message for deliberately-set status codes (e.g. 503 setup hints)
  const hasExplicitStatus = err.statusCode !== undefined && err.statusCode !== 500;
  const message = isClientError || isDevelopment || hasExplicitStatus
    ? err.message || 'Request failed'
    : 'Internal server error';

  res.status(statusCode).json({
    error: message,
    ...(isDevelopment && { stack: err.stack }),
  });
}
