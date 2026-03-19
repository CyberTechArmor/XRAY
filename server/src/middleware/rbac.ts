import { Request, Response, NextFunction } from 'express';

export function requirePermission(...requiredPermissions: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }

    // Platform admins bypass permission checks
    if (req.user.is_platform_admin) {
      next();
      return;
    }

    const hasPermission = requiredPermissions.every(
      (perm) => req.user!.permissions.includes(perm)
    );

    if (!hasPermission) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }

    next();
  };
}
