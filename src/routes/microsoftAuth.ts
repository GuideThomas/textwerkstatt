import { Router, Request, Response } from 'express';
import { config } from '../config';
import { pool } from '../db/connection';

const router = Router();

function getRedirectUri(req: Request): string {
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${protocol}://${host}/api/auth/microsoft/callback`;
}

// GET /api/auth/microsoft/status — Check if Microsoft auth is configured
router.get('/status', (_req: Request, res: Response) => {
  res.json({ enabled: config.auth.microsoftEnabled });
});

// GET /api/auth/microsoft — Redirect to Microsoft login
router.get('/', (req: Request, res: Response) => {
  if (!config.auth.microsoftEnabled) {
    res.status(503).json({ error: 'Microsoft auth not configured' });
    return;
  }

  const { clientId, tenantId } = config.auth.azure;
  const redirectUri = getRedirectUri(req);
  const state = Math.random().toString(36).substring(2) + Date.now().toString(36);
  req.session.oauthState = state;

  const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('state', state);

  // Erst speichern, dann weiterleiten — der Store ist Postgres, und der Rückweg
  // von Microsoft darf den State nicht vor dem Schreiben abfragen.
  req.session.save(() => res.redirect(authUrl.toString()));
});

// GET /api/auth/microsoft/callback — Handle OAuth2 callback
router.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Microsoft auth error:', error, req.query.error_description);
    res.redirect('/login?auth_error=microsoft_denied');
    return;
  }

  // CSRF check
  if (!state || state !== req.session.oauthState) {
    res.redirect('/login?auth_error=invalid_state');
    return;
  }
  delete req.session.oauthState;

  if (!code) {
    res.redirect('/login?auth_error=no_code');
    return;
  }

  try {
    const { clientId, clientSecret, tenantId } = config.auth.azure;
    const redirectUri = getRedirectUri(req);

    // Exchange code for tokens
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: code as string,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: 'openid profile email',
        }),
      }
    );

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      console.error('Token exchange failed:', errBody);
      res.redirect('/login?auth_error=token_exchange');
      return;
    }

    const tokens = await tokenResponse.json() as { id_token?: string };
    const idToken = tokens.id_token;
    if (!idToken) {
      res.redirect('/login?auth_error=no_id_token');
      return;
    }

    // Parse ID token payload (JWT)
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString('utf-8')
    );

    const email: string = payload.email || payload.preferred_username;
    const displayName: string = payload.name || email;
    const microsoftId: string = payload.oid;

    if (!email || !microsoftId) {
      res.redirect('/login?auth_error=missing_claims');
      return;
    }

    // Lookup or create user
    let userResult = await pool.query(
      'SELECT id, email, name, role, active FROM users WHERE microsoft_id = $1',
      [microsoftId]
    );

    if (userResult.rows.length === 0) {
      // Check if email already exists (link accounts)
      const emailResult = await pool.query(
        'SELECT id, email, name, role, active FROM users WHERE email = $1',
        [email]
      );

      if (emailResult.rows.length > 0) {
        // Link Microsoft ID to existing account
        await pool.query(
          'UPDATE users SET microsoft_id = $1, display_name = $2, updated_at = NOW() WHERE id = $3',
          [microsoftId, displayName, emailResult.rows[0].id]
        );
        userResult = emailResult;
      } else {
        // Create new user
        userResult = await pool.query(
          `INSERT INTO users (email, name, display_name, microsoft_id, role)
           VALUES ($1, $2, $2, $3, 'user')
           RETURNING id, email, name, role, active`,
          [email, displayName, microsoftId]
        );
      }
    }

    const user = userResult.rows[0];
    if (!user.active) {
      res.redirect('/login?auth_error=account_inactive');
      return;
    }

    // Set session
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.role = user.role;

    req.session.save(() => res.redirect('/'));
  } catch (err) {
    console.error('Microsoft auth callback error:', err);
    res.redirect('/login?auth_error=internal_error');
  }
});

export default router;
