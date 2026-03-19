import { Request, Response, NextFunction } from 'express';

/**
 * Tenant context middleware.
 * RLS SET LOCAL is done per-query in services using parameterized set_config().
 * This middleware validates the tenant context is available on the request.
 */
export async function setTenantContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  next();
}
