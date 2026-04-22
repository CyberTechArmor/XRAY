// OAuth 2.0 refresh-token exchange. Exchanges a tenant's refresh_token
// for a fresh access_token at the provider's token endpoint. Used by
// oauth-scheduler.ts (periodic refresh) and by oauth-callback.ts (initial
// authorization-code exchange).
//
// The exchange is a pure function of (token_url, client_id, client_secret,
// refresh_token). It does not read or write the database — that's the
// scheduler / callback's job. Separating concerns keeps this lib easily
// testable (mock fetch, no DB setup) and lets the scheduler decide
// retry-persistence semantics.
//
// Retry policy per spec: 5 attempts with delays [0s, 30s, 60s, 120s, 240s].
// Immediate first retry handles transient network blips; the doubling
// backoff from 30s gives the provider time to recover before giving up.
// Total worst-case wall clock across all 5 attempts: ~450s (7.5 min).
//
// RFC 6749 defaults baked in:
//   - POST application/x-www-form-urlencoded body
//   - client_id + client_secret in body (not Basic header — broader
//     compatibility; providers that require Basic will need a code branch)
//   - Accept: application/json response
//   - grant_type=refresh_token on refresh; grant_type=authorization_code
//     on initial callback exchange
//
// Providers that rotate refresh_tokens on each exchange (newer OAuth 2.1
// behavior) return a new refresh_token in the response; callers update
// their stored value. Providers that don't rotate return no refresh_token
// on re-exchange; callers must NOT overwrite with null — the returned
// TokenPair carries refresh_token=null to signal "don't touch".

export interface TokenExchangeInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  // One of these is set based on the exchange type.
  refreshToken?: string;
  authorizationCode?: string;
  redirectUri?: string; // required for authorization_code grant per RFC
}

export interface TokenPair {
  accessToken: string;
  // Null when the provider didn't return a new refresh_token. Callers
  // should preserve the existing stored refresh_token in that case.
  refreshToken: string | null;
  // Seconds until the access token expires. Defaulted to 3600 if the
  // provider omits `expires_in` (spec says MAY omit, in which case the
  // server should document the default — we pick 1h).
  expiresIn: number;
  // Raw token type from the provider (usually "Bearer"). Stored verbatim
  // so downstream workflows can present the access token with the correct
  // header scheme.
  tokenType: string;
  // Any extra fields the provider returned (e.g. QBO's realmId). Kept
  // opaque so per-provider handling can pull from it without this lib
  // knowing the shape.
  extras: Record<string, unknown>;
}

export class OAuthExchangeError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly providerBody: string | null
  ) {
    super(message);
    this.name = 'OAuthExchangeError';
  }
}

export class OAuthNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthNotConnectedError';
  }
}

// Retry delays per the committed policy. Exported so tests can verify
// without hardcoding.
export const REFRESH_RETRY_DELAYS_MS = [0, 30_000, 60_000, 120_000, 240_000];

// Seam for tests: we inject a mock fetcher so specs don't stand up an
// HTTP server. Default is global fetch (Node 18+).
type Fetcher = typeof fetch;
let fetcherImpl: Fetcher = (...args) => fetch(...args);
export function __setFetcherForTest(f: Fetcher | null): void {
  fetcherImpl = f || ((...args) => fetch(...args));
}
// Seam for tests: sleep implementation. Overridden in scheduler tests to
// use fake timers.
type Sleeper = (ms: number) => Promise<void>;
let sleeperImpl: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms));
export function __setSleeperForTest(s: Sleeper | null): void {
  sleeperImpl = s || ((ms) => new Promise((r) => setTimeout(r, ms)));
}

async function postOnce(input: TokenExchangeInput): Promise<TokenPair> {
  const body = new URLSearchParams();
  if (input.refreshToken) {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', input.refreshToken);
  } else if (input.authorizationCode) {
    body.set('grant_type', 'authorization_code');
    body.set('code', input.authorizationCode);
    if (input.redirectUri) body.set('redirect_uri', input.redirectUri);
  } else {
    throw new Error('postOnce: refreshToken or authorizationCode required');
  }
  body.set('client_id', input.clientId);
  body.set('client_secret', input.clientSecret);

  const response = await fetcherImpl(input.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new OAuthExchangeError(
      `Token exchange failed with HTTP ${response.status}`,
      response.status,
      bodyText.slice(0, 500)
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new OAuthExchangeError(
      'Token exchange response was not valid JSON',
      response.status,
      bodyText.slice(0, 500)
    );
  }
  const accessToken = parsed.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new OAuthExchangeError(
      'Token exchange response missing access_token',
      response.status,
      bodyText.slice(0, 500)
    );
  }
  // Pull known fields; keep the rest as extras for per-provider quirks
  // (e.g., QBO returns realmId alongside the standard fields).
  const { refresh_token, expires_in, token_type, ...extras } = parsed;
  delete (extras as Record<string, unknown>).access_token;

  return {
    accessToken,
    refreshToken:
      typeof refresh_token === 'string' && refresh_token ? refresh_token : null,
    // RFC 6749 says expires_in MAY be omitted. Default to 1h as a safe
    // common-case floor; the scheduler's 30-min refresh window keeps us
    // well clear of accidental expiry even on under-reported tokens.
    expiresIn:
      typeof expires_in === 'number' && expires_in > 0 ? expires_in : 3600,
    tokenType: typeof token_type === 'string' ? token_type : 'Bearer',
    extras,
  };
}

export async function exchangeWithRetry(
  input: TokenExchangeInput
): Promise<TokenPair> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < REFRESH_RETRY_DELAYS_MS.length; attempt++) {
    const delay = REFRESH_RETRY_DELAYS_MS[attempt];
    if (delay > 0) await sleeperImpl(delay);
    try {
      return await postOnce(input);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // AbortError from timeout, network failures, 4xx/5xx all retry.
      // If the provider returned 400 invalid_grant (refresh token revoked),
      // there's no point retrying — but distinguishing that from transient
      // provider issues is per-provider work, so we uniformly retry to
      // simplify. The scheduler caps retries per tick; tenant sees
      // 'Needs reconnect' after 5 consecutive tick failures.
      continue;
    }
  }
  throw (
    lastError ||
    new OAuthExchangeError('Exchange failed after retries', null, null)
  );
}

// Convenience wrapper used by oauth-callback.ts during initial authorization
// code exchange. Single attempt with no retry — the user is waiting
// interactively, and a failure should prompt them to try again.
export async function exchangeAuthorizationCode(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  authorizationCode: string;
  redirectUri: string;
}): Promise<TokenPair> {
  return postOnce(input);
}
