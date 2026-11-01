import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Create test directory for token storage
const testDir = join(
  tmpdir(),
  `mcp-twake-mail-oidc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

// Mock homedir before importing modules that use it
vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => testDir,
  };
});

// Mock the openid-client module
const mockDiscovery = vi.fn();
const mockBuildAuthorizationUrl = vi.fn();
const mockAuthorizationCodeGrant = vi.fn();
const mockRandomPKCECodeVerifier = vi.fn();
const mockCalculatePKCECodeChallenge = vi.fn();
const mockRandomState = vi.fn();

vi.mock('openid-client', () => ({
  discovery: mockDiscovery,
  buildAuthorizationUrl: mockBuildAuthorizationUrl,
  authorizationCodeGrant: mockAuthorizationCodeGrant,
  randomPKCECodeVerifier: mockRandomPKCECodeVerifier,
  calculatePKCECodeChallenge: mockCalculatePKCECodeChallenge,
  randomState: mockRandomState,
  None: vi.fn(() => 'none-auth'),
  AuthorizationResponseError: class AuthorizationResponseError extends Error {
    error: string;
    error_description?: string;
    constructor(error: string, description?: string) {
      super(description || error);
      this.error = error;
      this.error_description = description;
    }
  },
  ResponseBodyError: class ResponseBodyError extends Error {},
}));

// Mock oauth-callback
const mockGetAuthCode = vi.fn();

vi.mock('oauth-callback', () => ({
  getAuthCode: mockGetAuthCode,
}));

// Mock open
const mockOpen = vi.fn();
vi.mock('open', () => ({
  default: mockOpen,
}));

// Import after mocking
const { performOIDCFlow, getOIDCOptionsFromConfig } = await import(
  '../../src/auth/oidc-flow.js'
);
const { loadTokens, clearTokens } = await import('../../src/auth/token-store.js');

describe('oidc-flow', () => {
  beforeEach(async () => {
    // Create test directory
    await mkdir(testDir, { recursive: true });

    // Reset all mocks
    vi.clearAllMocks();

    // Setup default mock implementations
    mockRandomPKCECodeVerifier.mockReturnValue('test-code-verifier');
    mockCalculatePKCECodeChallenge.mockResolvedValue('test-code-challenge');
    mockRandomState.mockReturnValue('test-state');
    mockBuildAuthorizationUrl.mockReturnValue(
      new URL('https://auth.example.com/authorize?client_id=test')
    );
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
      // Cleanup failed, that's okay
    }
  });

  describe('performOIDCFlow', () => {
    const defaultOptions = {
      issuerUrl: 'https://auth.example.com',
      clientId: 'test-client-id',
      scope: 'openid email offline_access',
      redirectUri: 'http://localhost:3000/callback',
    };

    it('performs full OIDC flow with PKCE S256', async () => {
      // Setup mocks for successful flow
      const mockConfig = { serverMetadata: () => ({}) };
      mockDiscovery.mockResolvedValue(mockConfig);

      mockGetAuthCode.mockResolvedValue({
        code: 'authorization-code',
        redirectUri: 'http://localhost:3000/callback',
        params: new URLSearchParams({ state: 'test-state' }),
      });

      mockAuthorizationCodeGrant.mockResolvedValue({
        access_token: 'access-token-123',
        refresh_token: 'refresh-token-456',
        id_token: 'id-token-789',
        expires_in: 3600,
      });

      const result = await performOIDCFlow(defaultOptions);

      // Verify discovery was called with correct issuer
      expect(mockDiscovery).toHaveBeenCalledWith(
        new URL('https://auth.example.com'),
        'test-client-id',
        undefined,
        'none-auth'
      );

      // Verify PKCE code verifier was generated
      expect(mockRandomPKCECodeVerifier).toHaveBeenCalled();

      // Verify PKCE code challenge was calculated
      expect(mockCalculatePKCECodeChallenge).toHaveBeenCalledWith('test-code-verifier');

      // Verify authorization URL was built with S256
      expect(mockBuildAuthorizationUrl).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          redirect_uri: 'http://localhost:3000/callback',
          scope: 'openid email offline_access',
          code_challenge: 'test-code-challenge',
          code_challenge_method: 'S256', // CRITICAL: Must be S256
          state: 'test-state',
        })
      );

      // Verify browser was launched
      expect(mockGetAuthCode).toHaveBeenCalledWith(
        'https://auth.example.com/authorize?client_id=test',
        expect.objectContaining({
          launch: expect.any(Function),
          timeout: 120000,
        })
      );

      // Verify token exchange
      expect(mockAuthorizationCodeGrant).toHaveBeenCalledWith(
        mockConfig,
        expect.any(URL),
        expect.objectContaining({
          pkceCodeVerifier: 'test-code-verifier',
          expectedState: 'test-state',
        })
      );

      // Verify result
      expect(result).toEqual({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-456',
        idToken: 'id-token-789',
        expiresAt: expect.any(Number),
      });

      // Verify tokens were saved
      const savedTokens = await loadTokens();
      expect(savedTokens).toEqual(result);
    });

    it('uses S256 code_challenge_method (never plain)', async () => {
      const mockConfig = { serverMetadata: () => ({}) };
      mockDiscovery.mockResolvedValue(mockConfig);

      mockGetAuthCode.mockResolvedValue({
        code: 'authorization-code',
        redirectUri: 'http://localhost:3000/callback',
        params: new URLSearchParams({ state: 'test-state' }),
      });

      mockAuthorizationCodeGrant.mockResolvedValue({
        access_token: 'access-token',
        expires_in: 3600,
      });

      await performOIDCFlow(defaultOptions);

      // Extract the parameters passed to buildAuthorizationUrl
      const buildUrlCall = mockBuildAuthorizationUrl.mock.calls[0];
      const params = buildUrlCall[1];

      // CRITICAL SECURITY CHECK: code_challenge_method must be S256
      expect(params.code_challenge_method).toBe('S256');
      expect(params.code_challenge_method).not.toBe('plain');
    });

    it('throws on discovery failure', async () => {
      mockDiscovery.mockRejectedValue(new Error('Discovery failed'));

      await expect(performOIDCFlow(defaultOptions)).rejects.toMatchObject({
        type: 'oidcError',
        message: expect.stringContaining('discovery'),
      });
    });

    it('throws on callback error', async () => {
      const mockConfig = { serverMetadata: () => ({}) };
      mockDiscovery.mockResolvedValue(mockConfig);

      mockGetAuthCode.mockRejectedValue(new Error('User cancelled'));

      await expect(performOIDCFlow(defaultOptions)).rejects.toMatchObject({
        type: 'oidcError',
        message: expect.stringContaining('callback'),
      });
    });

    it('throws on state mismatch (CSRF protection)', async () => {
      const mockConfig = { serverMetadata: () => ({}) };
      mockDiscovery.mockResolvedValue(mockConfig);

      // Return a different state than expected
      mockGetAuthCode.mockResolvedValue({
        code: 'authorization-code',
        redirectUri: 'http://localhost:3000/callback',
        params: new URLSearchParams({ state: 'wrong-state' }),
      });

      await expect(performOIDCFlow(defaultOptions)).rejects.toMatchObject({
        type: 'oidcError',
        message: expect.stringContaining('state validation'),
      });
    });

    it('throws on token exchange failure', async () => {
      const mockConfig = { serverMetadata: () => ({}) };
      mockDiscovery.mockResolvedValue(mockConfig);

      mockGetAuthCode.mockResolvedValue({
        code: 'authorization-code',
        redirectUri: 'http://localhost:3000/callback',
        params: new URLSearchParams({ state: 'test-state' }),
      });

      mockAuthorizationCodeGrant.mockRejectedValue(new Error('Token exchange failed'));

      await expect(performOIDCFlow(defaultOptions)).rejects.toMatchObject({
        type: 'oidcError',
        message: expect.stringContaining('token exchange'),
      });
    });

    it('handles tokens without optional fields', async () => {
      const mockConfig = { serverMetadata: () => ({}) };
      mockDiscovery.mockResolvedValue(mockConfig);

      mockGetAuthCode.mockResolvedValue({
        code: 'authorization-code',
        redirectUri: 'http://localhost:3000/callback',
        params: new URLSearchParams({ state: 'test-state' }),
      });

      // Response without refresh_token, id_token, or expires_in
      mockAuthorizationCodeGrant.mockResolvedValue({
        access_token: 'access-token-only',
      });

      const result = await performOIDCFlow(defaultOptions);

      expect(result).toEqual({
        accessToken: 'access-token-only',
        refreshToken: undefined,
        idToken: undefined,
        expiresAt: undefined,
      });
    });

    it('refuses a remote redirect URI (loopback only, RFC 8252)', async () => {
      await expect(
        performOIDCFlow({ ...defaultOptions, redirectUri: 'https://pretty-vaguely-beagle.ngrok-free.app/callback' })
      ).rejects.toThrow(/loopback/);
      expect(mockDiscovery).not.toHaveBeenCalled();
      expect(mockGetAuthCode).not.toHaveBeenCalled();
    });

    it('refuses a loopback redirect URI without an explicit port', async () => {
      await expect(performOIDCFlow({ ...defaultOptions, redirectUri: 'http://localhost/callback' })).rejects.toThrow(/port/);
      expect(mockGetAuthCode).not.toHaveBeenCalled();
    });

    it('accepts 127.0.0.1 and [::1] with a port, and exchanges the code on the exact redirect URI', async () => {
      mockDiscovery.mockResolvedValue({ serverMetadata: () => ({}) });
      mockGetAuthCode.mockResolvedValue({
        code: 'authorization-code',
        redirectUri: 'http://127.0.0.1:8080/callback',
        params: new URLSearchParams({ state: 'test-state' }),
      });
      mockAuthorizationCodeGrant.mockResolvedValue({ access_token: 'access-token', expires_in: 3600 });

      await performOIDCFlow({ ...defaultOptions, redirectUri: 'http://127.0.0.1:8080/callback' });
      const callbackUrl = mockAuthorizationCodeGrant.mock.calls[0][1] as URL;
      expect(callbackUrl.origin + callbackUrl.pathname).toBe('http://127.0.0.1:8080/callback');
      expect(callbackUrl.searchParams.get('code')).toBe('authorization-code');

      mockGetAuthCode.mockResolvedValue({
        code: 'authorization-code',
        redirectUri: 'http://[::1]:8080/callback',
        params: new URLSearchParams({ state: 'test-state' }),
      });
      await expect(performOIDCFlow({ ...defaultOptions, redirectUri: 'http://[::1]:8080/callback' })).resolves.toBeDefined();
    });
  });

  describe('getOIDCOptionsFromConfig', () => {
    it('returns options for OIDC auth method', () => {
      const config = {
        JMAP_AUTH_METHOD: 'oidc',
        JMAP_OIDC_ISSUER: 'https://auth.example.com',
        JMAP_OIDC_CLIENT_ID: 'my-client',
        JMAP_OIDC_SCOPE: 'openid email',
        JMAP_OIDC_REDIRECT_URI: 'http://localhost:8080/callback',
      };

      const result = getOIDCOptionsFromConfig(config);

      expect(result).toEqual({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-client',
        scope: 'openid email',
        redirectUri: 'http://localhost:8080/callback',
      });
    });

    it('returns null for non-OIDC auth method', () => {
      const config = {
        JMAP_AUTH_METHOD: 'basic',
        JMAP_OIDC_ISSUER: 'https://auth.example.com',
        JMAP_OIDC_CLIENT_ID: 'my-client',
        JMAP_OIDC_SCOPE: 'openid email',
        JMAP_OIDC_REDIRECT_URI: 'http://localhost:3000/callback',
      };

      const result = getOIDCOptionsFromConfig(config);

      expect(result).toBeNull();
    });

    it('returns null when OIDC issuer is missing', () => {
      const config = {
        JMAP_AUTH_METHOD: 'oidc',
        JMAP_OIDC_ISSUER: undefined,
        JMAP_OIDC_CLIENT_ID: 'my-client',
        JMAP_OIDC_SCOPE: 'openid email',
        JMAP_OIDC_REDIRECT_URI: 'http://localhost:3000/callback',
      };

      const result = getOIDCOptionsFromConfig(config);

      expect(result).toBeNull();
    });

    it('returns null when OIDC client ID is missing', () => {
      const config = {
        JMAP_AUTH_METHOD: 'oidc',
        JMAP_OIDC_ISSUER: 'https://auth.example.com',
        JMAP_OIDC_CLIENT_ID: undefined,
        JMAP_OIDC_SCOPE: 'openid email',
        JMAP_OIDC_REDIRECT_URI: 'http://localhost:3000/callback',
      };

      const result = getOIDCOptionsFromConfig(config);

      expect(result).toBeNull();
    });
  });
});
