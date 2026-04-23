import { Router, Request, Response } from 'express';
import { withClient } from '../db/connection';
import { encryptSecret } from '../lib/encrypted-column';
import { verifyOAuthState } from '../lib/oauth-state';
import { exchangeAuthorizationCode, OAuthExchangeError } from '../lib/oauth-tokens';
import {
  getIntegrationWithSecret,
  decryptIntegrationClientSecret,
} from '../services/integration.service';
import { config } from '../config';
import * as auditService from '../services/audit.service';

// OAuth callback handler. No auth middleware — the signed state JWT is
// how we trust the incoming request. Provider redirects the tenant's
// browser here after they complete consent.
//
// Contract for success: upsert the tenant's platform.connections row
// for this integration with auth_method='oauth' and the freshly-
// exchanged refresh_token + access_token, then redirect the browser
// back to the app with ?connected=<slug>. The scheduler picks the
// refresh_token up from there on.
//
// Contract for failure: redirect back with ?oauth_error=<code>. The
// frontend toasts the error; no 500 page.

const router = Router();

function redirectBackToApp(res: Response, params: Record<string, string>): void {
  // Callback lives at <origin>/api/oauth/callback; the app itself is
  // served from <origin>/. Strip the callback path off the redirect URI
  // to land on the app.
  const base = config.oauth.redirectUri.replace(/\/api\/oauth\/callback$/, '') || '/';
  const url = new URL('/', base.startsWith('http') ? base : `http://localhost${base}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  res.redirect(url.toString());
}

router.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as {
    code?: string;
    state?: string;
    error?: string;
  };

  // Provider-reported error (user declined, app not approved, etc.).
  if (error) {
    return redirectBackToApp(res, {
      oauth_error: String(error),
      oauth_desc: String(req.query.error_description || ''),
    });
  }
  if (!code || !state) {
    return redirectBackToApp(res, { oauth_error: 'MISSING_PARAMS' });
  }

  // Verify state FIRST — this is the only trust anchor we have.
  let claims;
  try {
    claims = verifyOAuthState(state);
  } catch {
    return redirectBackToApp(res, { oauth_error: 'STATE_INVALID' });
  }

  // Look up integration. The state JWT carries integration_id so this is
  // stable across admin renames (e.g. admin changed the slug between
  // mint and callback — rare but possible).
  const integration = await getIntegrationByIdWithSecret(claims.i);
  if (!integration) {
    return redirectBackToApp(res, { oauth_error: 'INTEGRATION_NOT_FOUND' });
  }
  if (!integration.token_url || !integration.client_id) {
    return redirectBackToApp(res, { oauth_error: 'INTEGRATION_CONFIG_INCOMPLETE' });
  }

  const clientSecret = decryptIntegrationClientSecret(integration);
  if (!clientSecret) {
    return redirectBackToApp(res, { oauth_error: 'INTEGRATION_CONFIG_INCOMPLETE' });
  }

  // Exchange authorization code for tokens. Single attempt (user is
  // waiting interactively; a failure should just show them a retry).
  let pair;
  try {
    pair = await exchangeAuthorizationCode({
      tokenUrl: integration.token_url,
      clientId: integration.client_id,
      clientSecret,
      authorizationCode: code,
      redirectUri: config.oauth.redirectUri,
    });
  } catch (err) {
    const msg = err instanceof OAuthExchangeError ? err.message : 'exchange_failed';
    return redirectBackToApp(res, { oauth_error: 'EXCHANGE_FAILED', oauth_desc: msg });
  }

  // Upsert the tenant's connection row. Prefer updating an existing
  // source_type=slug row (legacy pre-step-4 data) before inserting a
  // new one — avoids leaving orphan rows for tenants who were
  // previously manually provisioned.
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    const existing = await client.query(
      `SELECT id FROM platform.connections
        WHERE tenant_id = $1 AND (integration_id = $2 OR source_type = $3)
        LIMIT 1`,
      [claims.t, integration.id, integration.slug]
    );

    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE platform.connections
            SET integration_id = $2,
                auth_method = 'oauth',
                oauth_refresh_token = $3,
                oauth_access_token = $4,
                oauth_access_token_expires_at = $5,
                oauth_last_refreshed_at = now(),
                oauth_refresh_failed_count = 0,
                oauth_last_error = NULL,
                api_key = NULL,
                status = 'active',
                updated_at = now()
          WHERE id = $1`,
        [
          existing.rows[0].id,
          integration.id,
          encryptSecret(pair.refreshToken || ''),
          encryptSecret(pair.accessToken),
          new Date(Date.now() + pair.expiresIn * 1000).toISOString(),
        ]
      );
    } else {
      await client.query(
        `INSERT INTO platform.connections
           (tenant_id, name, source_type, integration_id, auth_method,
            oauth_refresh_token, oauth_access_token,
            oauth_access_token_expires_at, oauth_last_refreshed_at,
            status)
         VALUES ($1, $2, $3, $4, 'oauth', $5, $6, $7, now(), 'active')`,
        [
          claims.t,
          integration.display_name,
          integration.slug,
          integration.id,
          encryptSecret(pair.refreshToken || ''),
          encryptSecret(pair.accessToken),
          new Date(Date.now() + pair.expiresIn * 1000).toISOString(),
        ]
      );
    }
  });

  auditService.log({
    tenantId: claims.t,
    userId: claims.u,
    action: 'connection.oauth_connected',
    resourceType: 'connection',
    resourceId: integration.id,
    metadata: { integration_slug: integration.slug },
  });

  // Real-time fan-out to every open tab on this tenant so dashboard
  // lists + My-Integrations strips flip to "Connected" without a manual
  // reload. Mirrors the broadcastToTenant pattern used by the share-
  // toggle routes in dashboard.routes.ts.
  try {
    const { broadcastToTenant } = await import('../ws');
    broadcastToTenant(claims.t, 'integration:connected', { slug: integration.slug });
  } catch {}

  return redirectBackToApp(res, { connected: integration.slug });
});

// Internal helper — looks up by id (not slug) because the state JWT
// carries integration_id. Returns the row with client_secret still
// encrypted so the caller owns the decrypt decision.
async function getIntegrationByIdWithSecret(id: string) {
  // Thin wrapper that exists so the oauth-state claim->row path is
  // explicit in greps. Under the hood it hits the same SELECT path as
  // getIntegrationWithSecret (which keys on slug). We accept the small
  // duplication because the callback's auth model is "state JWT says
  // integration_id is X; trust that and look up by id."
  const { withClient } = await import('../db/connection');
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      'SELECT * FROM platform.integrations WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  });
}

// getIntegrationWithSecret is imported to keep the service surface tidy
// for the slug-keyed path used by the authorize route; not used here.
void getIntegrationWithSecret;

export default router;
