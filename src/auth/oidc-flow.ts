import * as client from 'openid-client';
import { getAuthCode } from 'oauth-callback';
import open from 'open';

import { saveTokens, type StoredTokens } from './token-store.js';
import { JMAPError } from '../errors.js';
import { loopbackRedirectProblem } from './redirect-uri.js';

/**
 * Options for performing OIDC authorization code flow with PKCE
 */
export interface OIDCFlowOptions {
  /** OIDC issuer URL (e.g., https://auth.example.com) */
  issuerUrl: string;
  /** OAuth client ID registered with the OIDC provider */
  clientId: string;
  /** OAuth scopes to request (space-separated) */
  scope: string;
  /** Loopback redirect URI with an explicit port, registered with the OIDC provider (RFC 8252) */
  redirectUri: string;
}

/**
 * Perform OIDC authorization code flow with PKCE (S256)
 *
 * This function:
 * 1. Discovers OIDC provider configuration
 * 2. Generates PKCE code verifier and challenge (S256)
 * 3. Builds authorization URL with PKCE
 * 4. Opens browser for user authentication
 * 5. Captures authorization code on the loopback redirect URI (RFC 8252)
 * 6. Exchanges code for tokens
 * 7. Saves tokens to secure storage
 *
 * @param options - OIDC flow configuration
 * @returns Stored tokens after successful authentication
 * @throws JMAPError on OIDC flow failures
 */
export async function performOIDCFlow(options: OIDCFlowOptions): Promise<StoredTokens> {
  const { issuerUrl, clientId, scope, redirectUri } = options;

  const problem = loopbackRedirectProblem(redirectUri);
  if (problem) throw JMAPError.oidcFlowError('configuration', problem);

  // Step 1: OIDC Discovery
  let config: client.Configuration;
  try {
    config = await client.discovery(
      new URL(issuerUrl),
      clientId,
      undefined, // No client secret (public client with PKCE)
      client.None() // Public client authentication
    );
  } catch (error) {
    throw JMAPError.oidcFlowError(
      'discovery',
      error instanceof Error ? error.message : String(error)
    );
  }

  // Step 2: Generate PKCE values (S256 - NEVER use plain)
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  // Step 4: Build authorization URL with PKCE S256
  const authParams = {
    redirect_uri: redirectUri,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256', // CRITICAL: Always S256, never plain (AUTH-04)
    state,
  };

  const authorizationUrl = client.buildAuthorizationUrl(config, authParams);

  // Step 5: Launch browser and capture callback
  // oauth-callback listens on the redirect_uri carried by the URL and checks its state
  let authCode: string;
  let returnedState: string | null;
  let boundRedirectUri: string;
  try {
    const result = await getAuthCode(authorizationUrl.toString(), {
      launch: (url: URL) => open(url.href),
      timeout: 120000, // 2 minutes for user to complete auth
    });
    authCode = result.code;
    returnedState = result.params.get('state');
    boundRedirectUri = result.redirectUri;
  } catch (error) {
    throw JMAPError.oidcFlowError(
      'callback',
      error instanceof Error ? error.message : String(error)
    );
  }

  // Step 6: Validate state to prevent CSRF attacks
  if (returnedState !== state) {
    throw JMAPError.oidcFlowError(
      'state validation',
      'State parameter mismatch. Possible CSRF attack.'
    );
  }

  // Step 7: Exchange code for tokens
  let tokenResponse: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    // Build callback URL with the authorization code for authorizationCodeGrant
    const callbackUrl = new URL(boundRedirectUri);
    callbackUrl.searchParams.set('code', authCode);
    callbackUrl.searchParams.set('state', state);

    tokenResponse = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
    });
  } catch (error) {
    if (error instanceof client.AuthorizationResponseError) {
      throw JMAPError.oidcFlowError('authorization', error.error_description || error.error);
    }
    if (error instanceof client.ResponseBodyError) {
      throw JMAPError.oidcFlowError('token exchange', error.message);
    }
    throw JMAPError.oidcFlowError(
      'token exchange',
      error instanceof Error ? error.message : String(error)
    );
  }

  // Step 8: Build and save StoredTokens
  const tokens: StoredTokens = {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    idToken: tokenResponse.id_token,
    expiresAt: tokenResponse.expires_in
      ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
      : undefined,
  };

  await saveTokens(tokens);

  return tokens;
}

/**
 * Helper to extract OIDC flow options from environment config
 *
 * @param config - Config object with OIDC fields
 * @returns OIDCFlowOptions or null if OIDC is not configured
 */
export function getOIDCOptionsFromConfig(config: {
  JMAP_AUTH_METHOD: string;
  JMAP_OIDC_ISSUER?: string;
  JMAP_OIDC_CLIENT_ID?: string;
  JMAP_OIDC_SCOPE: string;
  JMAP_OIDC_REDIRECT_URI: string;
}): OIDCFlowOptions | null {
  if (config.JMAP_AUTH_METHOD !== 'oidc') {
    return null;
  }

  if (!config.JMAP_OIDC_ISSUER || !config.JMAP_OIDC_CLIENT_ID) {
    return null;
  }

  return {
    issuerUrl: config.JMAP_OIDC_ISSUER,
    clientId: config.JMAP_OIDC_CLIENT_ID,
    scope: config.JMAP_OIDC_SCOPE,
    redirectUri: config.JMAP_OIDC_REDIRECT_URI,
  };
}
