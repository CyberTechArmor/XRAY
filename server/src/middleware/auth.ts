import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import * as apikeyService from '../services/apikey.service';

export interface JWTPayload {
  sub: string;        // user_id
  tid: string;        // tenant_id
  role: string;       // role slug
  permissions: string[];
  is_owner: boolean;
  is_platform_admin: boolean;
  has_admin: boolean;
  has_billing: boolean;
  // Step 10: when set, the request is running under
  // platform-admin impersonation. `sub`/`tid`/`permissions` are
  // the TARGET user's claims; `imp` carries the originating
  // admin's identity so the SPA renders the banner and so audit
  // helpers can attribute writes to "X on behalf of Y".
  imp?: { admin_id: string; admin_email: string };
  iat: number;
  exp: number;
}

export interface ApiKeyPayload {
  sub: string;        // api_key id
  tid: string;        // tenant_id (or empty for platform-level keys)
  role: string;
  permissions: string[];
  is_owner: boolean;
  is_platform_admin: boolean;
  is_api_key: boolean;
  scopes: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload | ApiKeyPayload;
    }
  }
}

const API_KEY_PREFIX = 'xray_';

/**
 * Authenticate via JWT or API Key bearer token.
 * API keys starting with "xray_" are validated against the api_keys table.
 * All other bearer tokens are validated as JWTs.
 */
export function authenticateJWT(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
    return;
  }

  const token = authHeader.slice(7);

  // API Key authentication
  if (token.startsWith(API_KEY_PREFIX)) {
    apikeyService.validateApiKey(token).then((apiKey) => {
      if (!apiKey) {
        res.status(401).json({
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid or expired API key' },
          meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
        });
        return;
      }

      req.user = {
        sub: apiKey.created_by,
        tid: apiKey.tenant_id || '',
        role: 'api_key',
        permissions: apiKey.scopes,
        is_owner: false,
        is_platform_admin: apiKey.scopes.includes('platform.admin'),
        is_api_key: true,
        scopes: apiKey.scopes,
      } as ApiKeyPayload;
      next();
    }).catch(() => {
      res.status(401).json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'API key validation failed' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
    });
    return;
  }

  // JWT authentication
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JWTPayload;
    req.user = payload;
    next();
  } catch (err) {
    res.status(401).json({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    if (token.startsWith(API_KEY_PREFIX)) {
      apikeyService.validateApiKey(token).then((apiKey) => {
        if (apiKey) {
          req.user = {
            sub: apiKey.created_by,
            tid: apiKey.tenant_id || '',
            role: 'api_key',
            permissions: apiKey.scopes,
            is_owner: false,
            is_platform_admin: apiKey.scopes.includes('platform.admin'),
            is_api_key: true,
            scopes: apiKey.scopes,
          } as ApiKeyPayload;
        }
        next();
      }).catch(() => next());
      return;
    }

    try {
      req.user = jwt.verify(token, config.jwtSecret) as JWTPayload;
    } catch {
      // Token invalid — proceed without user
    }
  }
  next();
}
