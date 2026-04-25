import jwt from 'jsonwebtoken';
import { config } from '../config';
import { generateToken } from '../lib/crypto';

interface AccessTokenInput {
  sub: string;
  tid: string;
  role: string;
  permissions: string[];
  is_owner: boolean;
  is_platform_admin: boolean;
  has_admin?: boolean;
  has_billing?: boolean;
  has_replay?: boolean;
  // Step 10: present only when the platform admin has clicked
  // "Impersonate owner" on a tenant. Carries the original admin's
  // identity so the SPA can render the persistent red banner and
  // surface a "Stop impersonating" CTA without an extra round-trip.
  imp?: { admin_id: string; admin_email: string };
}

export function signAccessToken(payload: AccessTokenInput): string {
  return jwt.sign({ ...payload } as object, config.jwtSecret, {
    expiresIn: config.jwt.accessTokenExpiry as string,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, config.jwtSecret);
}

export function signRefreshToken(): string {
  return generateToken(48);
}
