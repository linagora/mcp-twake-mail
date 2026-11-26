import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Create unique test directory per test run
const testDir = join(
  tmpdir(),
  `mcp-twake-mail-refresh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

// Mock homedir before any imports
vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => testDir,
  };
});

// Mock openid-client
const mockRefreshTokenGrant = vi.fn();
const mockDiscovery = vi.fn();

vi.mock('openid-client', () => ({
  discovery: (...args: unknown[]) => mockDiscovery(...args),
  refreshTokenGrant: (...args: unknown[]) => mockRefreshTokenGrant(...args),
}));

// Import modules after mocking
const { saveTokens, loadTokens, clearTokens } = await import(
  '../../src/auth/token-store.js'
);
const { TokenRefresher, createTokenRefresher, TOKEN_EXPIRY_BUFFER } =
  await import('../../src/auth/token-refresh.js');
const { JMAPError } = await import('../../src/errors.js');

describe('token-refresh', () => {
  beforeEach(async () => {
    // Create test directory
    await mkdir(testDir, { recursive: true });

    // Reset mocks
    vi.clearAllMocks();

    // Setup default mock behavior
    mockDiscovery.mockResolvedValue({ issuer: 'https://auth.example.com' });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      const tokenDir = join(testDir, '.mcp-twake-mail');
      const tokenFile = join(tokenDir, 'tokens.json');

      try {
        await unlink(tokenFile);
      } catch {
        // Ignore
      }
      try {
        await rmdir(tokenDir);
      } catch {
        // Ignore
      }
      try {
        await rmdir(testDir);
      } catch {
        // Ignore
      }
    } catch {
      // Cleanup failed, that's okay for tests
    }
  });

  describe('TOKEN_EXPIRY_BUFFER', () => {
    it('is 60 seconds', () => {
      expect(TOKEN_EXPIRY_BUFFER).toBe(60);
    });
  });

  describe('createTokenRefresher', () => {
    it('creates a TokenRefresher instance', () => {
      const refresher = createTokenRefresher(
        'https://auth.example.com',
        'client-id'
      );

      expect(refresher).toBeInstanceOf(TokenRefresher);
    });
  });

  describe('TokenRefresher', () => {
    const issuerUrl = 'https://auth.example.com';
    const clientId = 'test-client-id';

    describe('isTokenValid', () => {
      it('returns true when no expiresAt (assume valid)', () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const tokens = { accessToken: 'test-token' };

        expect(refresher.isTokenValid(tokens)).toBe(true);
      });

      it('returns true when token expires in > 60 seconds', () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'test-token',
          expiresAt: now + 120, // 2 minutes from now
        };

        expect(refresher.isTokenValid(tokens)).toBe(true);
      });

      it('returns false when token expires in < 60 seconds', () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'test-token',
          expiresAt: now + 30, // 30 seconds from now
        };

        expect(refresher.isTokenValid(tokens)).toBe(false);
      });

      it('returns false when token expires exactly at buffer', () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'test-token',
          expiresAt: now + TOKEN_EXPIRY_BUFFER, // Exactly 60 seconds
        };

        expect(refresher.isTokenValid(tokens)).toBe(false);
      });

      it('returns false when token is already expired', () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'test-token',
          expiresAt: now - 10, // 10 seconds ago
        };

        expect(refresher.isTokenValid(tokens)).toBe(false);
      });
    });

    describe('ensureValidToken', () => {
      it('throws noStoredTokens when no tokens exist', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);

        await expect(refresher.ensureValidToken()).rejects.toThrow(JMAPError);

        try {
          await refresher.ensureValidToken();
        } catch (error) {
          expect(error).toBeInstanceOf(JMAPError);
          expect((error as JMAPError).type).toBe('noStoredTokens');
        }
      });

      it('returns existing token if not expired', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'valid-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 300, // 5 minutes from now
        };

        await saveTokens(tokens);

        const result = await refresher.ensureValidToken();

        expect(result).toEqual(tokens);
        expect(mockRefreshTokenGrant).not.toHaveBeenCalled();
      });

      it('refreshes token if expiring in < 60 seconds', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'expiring-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 30, // 30 seconds from now - will trigger refresh
        };

        await saveTokens(tokens);

        mockRefreshTokenGrant.mockResolvedValue({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        });

        const result = await refresher.ensureValidToken();

        expect(result.accessToken).toBe('new-access-token');
        expect(result.refreshToken).toBe('new-refresh-token');
        expect(mockRefreshTokenGrant).toHaveBeenCalledTimes(1);
      });

      it('throws tokenExpired(false) if no refresh token available', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'expiring-token',
          // No refreshToken!
          expiresAt: now + 30, // Needs refresh
        };

        await saveTokens(tokens);

        try {
          await refresher.ensureValidToken();
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(JMAPError);
          expect((error as JMAPError).type).toBe('tokenExpired');
          expect((error as JMAPError).message).toContain('Re-authenticate');
        }
      });

      it('throws refreshFailed on refresh error', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'expiring-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 30,
        };

        await saveTokens(tokens);

        mockRefreshTokenGrant.mockRejectedValue(
          new Error('invalid_grant: Token has been revoked')
        );

        try {
          await refresher.ensureValidToken();
          expect.fail('Should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(JMAPError);
          expect((error as JMAPError).type).toBe('refreshFailed');
          expect((error as JMAPError).message).toContain('invalid_grant');
        }
      });

      it('saves new tokens after successful refresh', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'old-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 30,
        };

        await saveTokens(tokens);

        mockRefreshTokenGrant.mockResolvedValue({
          access_token: 'new-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
          id_token: 'new-id-token',
        });

        await refresher.ensureValidToken();

        // Verify tokens were saved
        const saved = await loadTokens();
        expect(saved?.accessToken).toBe('new-access-token');
        expect(saved?.refreshToken).toBe('rotated-refresh-token');
        expect(saved?.idToken).toBe('new-id-token');
        expect(saved?.expiresAt).toBeDefined();
        expect(saved!.expiresAt! - now).toBeGreaterThanOrEqual(3590); // Allow for test timing
      });

      it('keeps old refresh token if server does not rotate it', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'old-token',
          refreshToken: 'original-refresh-token',
          expiresAt: now + 30,
        };

        await saveTokens(tokens);

        mockRefreshTokenGrant.mockResolvedValue({
          access_token: 'new-access-token',
          // No refresh_token in response - server didn't rotate
          expires_in: 3600,
        });

        const result = await refresher.ensureValidToken();

        expect(result.refreshToken).toBe('original-refresh-token');
      });

      it('mutex: concurrent calls result in single refresh', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        const tokens = {
          accessToken: 'expiring-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 30,
        };

        await saveTokens(tokens);

        // Make refresh take some time to ensure concurrent calls overlap
        mockRefreshTokenGrant.mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    access_token: 'new-token',
                    refresh_token: 'new-refresh',
                    expires_in: 3600,
                  }),
                50
              )
            )
        );

        // Launch 5 concurrent refresh attempts
        const promises = [
          refresher.ensureValidToken(),
          refresher.ensureValidToken(),
          refresher.ensureValidToken(),
          refresher.ensureValidToken(),
          refresher.ensureValidToken(),
        ];

        const results = await Promise.all(promises);

        // All should get the same token
        for (const result of results) {
          expect(result.accessToken).toBe('new-token');
        }

        // But refresh should only have been called once!
        expect(mockRefreshTokenGrant).toHaveBeenCalledTimes(1);
      });

      it('mutex: clears after refresh completes, allowing subsequent refresh', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);

        // First round - token needs refresh
        const tokens1 = {
          accessToken: 'token-1',
          refreshToken: 'refresh-1',
          expiresAt: now + 30,
        };

        await saveTokens(tokens1);

        mockRefreshTokenGrant.mockResolvedValueOnce({
          access_token: 'token-2',
          refresh_token: 'refresh-2',
          expires_in: 60, // Will expire soon
        });

        const result1 = await refresher.ensureValidToken();
        expect(result1.accessToken).toBe('token-2');
        expect(mockRefreshTokenGrant).toHaveBeenCalledTimes(1);

        // Second round - token needs refresh again (simulated by modifying saved tokens)
        // Manually set expiry to trigger refresh again
        await saveTokens({
          accessToken: 'token-2',
          refreshToken: 'refresh-2',
          expiresAt: now + 30, // Expiring soon
        });

        mockRefreshTokenGrant.mockResolvedValueOnce({
          access_token: 'token-3',
          refresh_token: 'refresh-3',
          expires_in: 3600,
        });

        const result2 = await refresher.ensureValidToken();
        expect(result2.accessToken).toBe('token-3');
        expect(mockRefreshTokenGrant).toHaveBeenCalledTimes(2); // Second refresh
      });
    });

    describe('forceRefresh', () => {
      it('refreshes a token that has not expired', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        const now = Math.floor(Date.now() / 1000);
        await saveTokens({ accessToken: 'revoked-token', refreshToken: 'refresh-token', expiresAt: now + 3600 });
        mockRefreshTokenGrant.mockResolvedValue({ access_token: 'new-access-token', expires_in: 3600 });

        expect(await refresher.forceRefresh()).toBe(true);

        expect(mockRefreshTokenGrant).toHaveBeenCalledTimes(1);
        expect((await loadTokens())?.accessToken).toBe('new-access-token');
        expect((await refresher.ensureValidToken()).accessToken).toBe('new-access-token');
      });

      it('returns false without a refresh token', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        await saveTokens({ accessToken: 'revoked-token' });

        expect(await refresher.forceRefresh()).toBe(false);
        expect(mockRefreshTokenGrant).not.toHaveBeenCalled();
      });

      it('throws refreshFailed when the refresh fails', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);
        await saveTokens({ accessToken: 'revoked-token', refreshToken: 'refresh-token' });
        mockRefreshTokenGrant.mockRejectedValue(new Error('invalid_grant'));

        await expect(refresher.forceRefresh()).rejects.toMatchObject({ type: 'refreshFailed' });
      });
    });

    describe('getIssuerConfig', () => {
      it('caches config after first call', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);

        await refresher.getIssuerConfig();
        await refresher.getIssuerConfig();
        await refresher.getIssuerConfig();

        expect(mockDiscovery).toHaveBeenCalledTimes(1);
      });

      it('passes correct parameters to discovery', async () => {
        const refresher = new TokenRefresher(
          'https://custom-issuer.com',
          'my-client'
        );

        await refresher.getIssuerConfig();

        expect(mockDiscovery).toHaveBeenCalledWith(
          new URL('https://custom-issuer.com'),
          'my-client'
        );
      });
    });

    describe('clearCache', () => {
      it('clears cached config', async () => {
        const refresher = new TokenRefresher(issuerUrl, clientId);

        await refresher.getIssuerConfig();
        expect(mockDiscovery).toHaveBeenCalledTimes(1);

        refresher.clearCache();

        await refresher.getIssuerConfig();
        expect(mockDiscovery).toHaveBeenCalledTimes(2);
      });
    });
  });
});
