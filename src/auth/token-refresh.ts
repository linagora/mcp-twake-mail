import * as client from 'openid-client';
import type { StoredTokens } from './token-store.js';
import { loadTokens, saveTokens } from './token-store.js';
import { JMAPError } from '../errors.js';

/**
 * Refresh tokens 60 seconds before actual expiry
 * This buffer ensures tokens are refreshed before they become invalid
 */
export const TOKEN_EXPIRY_BUFFER = 60;

/**
 * Token refresher with mutex for concurrent access safety
 *
 * When an MCP server handles multiple simultaneous requests, each may try
 * to refresh the token if it's expiring soon. Without coordination, this
 * causes "invalid_grant" errors. This class ensures only one refresh
 * happens at a time and all callers get the fresh token.
 */
export class TokenRefresher {
  private issuerUrl: string;
  private clientId: string;
  private refreshPromise: Promise<StoredTokens> | null = null;
  private cachedConfig: client.Configuration | null = null;

  constructor(issuerUrl: string, clientId: string) {
    this.issuerUrl = issuerUrl;
    this.clientId = clientId;
  }

  /**
   * Get or create cached OIDC issuer configuration
   */
  async getIssuerConfig(): Promise<client.Configuration> {
    if (!this.cachedConfig) {
      this.cachedConfig = await client.discovery(
        new URL(this.issuerUrl),
        this.clientId
      );
    }
    return this.cachedConfig;
  }

  /**
   * Check if token is valid (not expired or expiring soon)
   * Returns false if token will expire within TOKEN_EXPIRY_BUFFER seconds
   */
  isTokenValid(tokens: StoredTokens): boolean {
    if (!tokens.expiresAt) {
      // No expiry info - assume valid (server will reject if not)
      return true;
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = tokens.expiresAt - now;

    // Token is valid if it won't expire within the buffer period
    return expiresIn > TOKEN_EXPIRY_BUFFER;
  }

  /**
   * Ensure we have a valid token, refreshing if necessary
   *
   * Uses a mutex pattern: if a refresh is already in progress,
   * all callers wait for that same promise rather than starting
   * parallel refresh requests.
   */
  async ensureValidToken(): Promise<StoredTokens> {
    // Load stored tokens
    const tokens = await loadTokens();

    if (!tokens) {
      throw JMAPError.noStoredTokens();
    }

    // If token is still valid, return it
    if (this.isTokenValid(tokens)) {
      return tokens;
    }

    // Token needs refresh - check if we have a refresh token
    if (!tokens.refreshToken) {
      throw JMAPError.tokenExpired(false);
    }

    return this.refresh(tokens.refreshToken);
  }

  /**
   * Refresh the access token even though it has not expired (the server answered 401: it was
   * revoked or expired early).
   * @returns false when there is no refresh token to use
   */
  async forceRefresh(): Promise<boolean> {
    const tokens = await loadTokens();
    if (!tokens?.refreshToken) {
      return false;
    }
    await this.refresh(tokens.refreshToken);
    return true;
  }

  /** Refresh once at a time: concurrent callers wait for the same refresh. */
  private async refresh(refreshToken: string): Promise<StoredTokens> {
    // Mutex: if refresh is already in progress, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Start refresh and store the promise for concurrent callers
    this.refreshPromise = this.doRefresh(refreshToken);

    try {
      const newTokens = await this.refreshPromise;
      return newTokens;
    } finally {
      // Clear the mutex when refresh completes (success or failure)
      this.refreshPromise = null;
    }
  }

  /**
   * Perform the actual token refresh
   */
  private async doRefresh(refreshToken: string): Promise<StoredTokens> {
    try {
      const config = await this.getIssuerConfig();

      const tokenResponse = await client.refreshTokenGrant(config, refreshToken);

      // Build new stored tokens
      const newTokens: StoredTokens = {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token ?? refreshToken, // Keep old refresh token if not rotated
        expiresAt: tokenResponse.expires_in
          ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
          : undefined,
        idToken: tokenResponse.id_token,
      };

      // Persist new tokens
      await saveTokens(newTokens);

      return newTokens;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw JMAPError.refreshFailed(message);
    }
  }

  /**
   * Clear cached configuration (useful for testing)
   */
  clearCache(): void {
    this.cachedConfig = null;
    this.refreshPromise = null;
  }
}

/**
 * Factory function to create a TokenRefresher instance
 */
export function createTokenRefresher(
  issuerUrl: string,
  clientId: string
): TokenRefresher {
  return new TokenRefresher(issuerUrl, clientId);
}

/**
 * Convenience function to ensure valid token with a new refresher
 * For simple use cases that don't need to maintain refresher state
 */
export async function ensureValidToken(
  issuerUrl: string,
  clientId: string
): Promise<StoredTokens> {
  const refresher = createTokenRefresher(issuerUrl, clientId);
  return refresher.ensureValidToken();
}
