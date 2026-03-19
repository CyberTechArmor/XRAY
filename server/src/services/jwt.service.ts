import jwt from 'jsonwebtoken';
import { config } from '../config';
import { generateToken } from '../lib/crypto';
import type { JWTPayload } from '../middleware/auth';

interface AccessTokenInput {
  sub: string;
  tid: string;
  role: string;
  permissions: string[];
  is_owner: boolean;
  is_platform_admin: boolean;
}

export function signAccessToken(payload: AccessTokenInput): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwt.accessTokenExpiry,
  });
}

export function verifyAccessToken(token: string): JWTPayload {
  return jwt.verify(token, config.jwtSecret) as JWTPayload;
}

export function signRefreshToken(): string {
  return generateToken(48);
}
