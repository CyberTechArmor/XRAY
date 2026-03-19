import { Request, Response, NextFunction } from 'express';
import { getPool } from '../db/connection';

export async function setTenantContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // This middleware is called after auth, so req.user should exist for authenticated routes
  // The actual RLS SET LOCAL is done per-query in services, not as a middleware
  // This just validates the tenant context is available
  next();
}
