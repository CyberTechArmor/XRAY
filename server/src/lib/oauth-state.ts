import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from '../config';

// Short-lived signed state parameter for OAuth authorization flows. When a
// tenant user clicks Connect, we mint one of these and hand it to the
// provider via the `state` query param. The provider echoes it back on
// the callback; we verify its signature + expiry + claims before trusting
// any of the values inside.
//
// Why sign instead of storing state in the DB? Stateless keeps the
// callback route's code path simple and avoids a per-flow DB row that
// might outlive its usefulness. HS256 against the existing JWT_SECRET
// is fine here — the state is server-to-server in effect (the provider's
// browser only acts as a courier).

export interface OAuthStateClaims {
  t: string; // tenant_id
  i: string; // integration_id
  u: string; // user_id who initiated
  n: string; // nonce
}

const STATE_ISSUER = 'xray:oauth-state';

export function mintOAuthState(input: {
  tenantId: string;
  integrationId: string;
  userId: string;
}): string {
  const payload: OAuthStateClaims = {
    t: input.tenantId,
    i: input.integrationId,
    u: input.userId,
    n: randomUUID(),
  };
  return jwt.sign(payload, config.jwtSecret, {
    algorithm: 'HS256',
    issuer: STATE_ISSUER,
    expiresIn: config.oauth.stateExpirySeconds,
  });
}

export function verifyOAuthState(token: string): OAuthStateClaims {
  const decoded = jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256'],
    issuer: STATE_ISSUER,
  }) as OAuthStateClaims & jwt.JwtPayload;
  if (!decoded.t || !decoded.i || !decoded.u) {
    throw new Error('oauth-state: claims missing required fields');
  }
  return { t: decoded.t, i: decoded.i, u: decoded.u, n: decoded.n };
}

// Builds the authorize URL for a provider. Merges the standard OAuth 2.0
// params (client_id, redirect_uri, response_type=code, scope, state)
// with any provider-specific extras from integrations.extra_authorize_params.
// Extras win where keys collide — that's the point of the knob, so an
// admin can set e.g. access_type=offline for Google even though we don't
// normally pass it.
export function buildAuthorizeUrl(input: {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string | null;
  state: string;
  extraParams: Record<string, unknown>;
}): string {
  const url = new URL(input.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  if (input.scopes) url.searchParams.set('scope', input.scopes);
  url.searchParams.set('state', input.state);
  for (const [k, v] of Object.entries(input.extraParams || {})) {
    if (v === null || v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}
