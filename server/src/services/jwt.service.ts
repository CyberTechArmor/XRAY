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
