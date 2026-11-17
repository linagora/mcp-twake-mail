import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import createFetchMock from 'vitest-fetch-mock';
import { JMAPClient } from '../../src/jmap/client.js';
import { JMAPError } from '../../src/errors.js';
import type { Config } from '../../src/config/schema.js';
import type { Logger } from '../../src/config/logger.js';

// Mock the token-refresh module
vi.mock('../../src/auth/token-refresh.js', () => ({
  createTokenRefresher: vi.fn(),
  TokenRefresher: vi.fn(),
}));

import { createTokenRefresher } from '../../src/auth/token-refresh.js';
const mockCreateTokenRefresher = vi.mocked(createTokenRefresher);

// Setup fetch mock
const fetchMocker = createFetchMock(vi);

// Mock config
const mockConfig: Config = {
  JMAP_SESSION_URL: 'https://jmap.example.com/session',
  JMAP_AUTH_METHOD: 'basic',
  JMAP_USERNAME: 'testuser',
  JMAP_PASSWORD: 'testpass',
  JMAP_TOKEN: undefined,
  JMAP_REQUEST_TIMEOUT: 30000,
  LOG_LEVEL: 'info',
  JMAP_OIDC_SCOPE: 'openid email offline_access',
  JMAP_OIDC_REDIRECT_URI: 'http://localhost:3000/callback',
};

// OIDC config for OIDC tests
const mockOidcConfig: Config = {
  JMAP_SESSION_URL: 'https://jmap.example.com/session',
  JMAP_AUTH_METHOD: 'oidc',
  JMAP_OIDC_ISSUER: 'https://auth.example.com',
  JMAP_OIDC_CLIENT_ID: 'test-client-id',
  JMAP_OIDC_SCOPE: 'openid email offline_access',
  JMAP_OIDC_REDIRECT_URI: 'http://localhost:3000/callback',
  JMAP_REQUEST_TIMEOUT: 30000,
  LOG_LEVEL: 'info',
};

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: 'info',
} as unknown as Logger;

// Valid session response
const validSessionResponse = {
  capabilities: {
    'urn:ietf:params:jmap:core': {},
    'urn:ietf:params:jmap:mail': {},
  },
  accounts: {
    'account-123': {
      name: 'Test User',
      isPersonal: true,
      accountCapabilities: {},
    },
  },
  primaryAccounts: {
    'urn:ietf:params:jmap:mail': 'account-123',
  },
  apiUrl: 'https://jmap.example.com/api',
  state: 'session-state-1',
};

describe('JMAPClient', () => {
  beforeEach(() => {
    fetchMocker.enableMocks();
    fetchMocker.resetMocks();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fetchMocker.disableMocks();
  });

  describe('fetchSession', () => {
    it('should fetch and parse session correctly', async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));

      const client = new JMAPClient(mockConfig, mockLogger);
      const session = await client.fetchSession();

      expect(session.apiUrl).toBe('https://jmap.example.com/api');
      expect(session.accountId).toBe('account-123');
      expect(session.state).toBe('session-state-1');
      expect(session.capabilities).toHaveProperty('urn:ietf:params:jmap:core');

      // Verify fetch was called with correct params
      expect(fetchMocker).toHaveBeenCalledOnce();
      const [url, options] = fetchMocker.mock.calls[0];
      expect(url).toBe('https://jmap.example.com/session');
      expect(options?.method).toBe('GET');
      expect(options?.headers).toHaveProperty('Authorization');
    });

    it('should throw JMAPError when no mail account found', async () => {
      const noMailSession = {
        ...validSessionResponse,
        primaryAccounts: {}, // No mail account
      };
      fetchMocker.mockResponseOnce(JSON.stringify(noMailSession));

      const client = new JMAPClient(mockConfig, mockLogger);

      try {
        await client.fetchSession();
        expect.fail('Expected JMAPError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(JMAPError);
        expect((error as JMAPError).type).toBe('noMailAccount');
      }
    });

    it('should throw JMAPError on HTTP 401', async () => {
      fetchMocker.mockResponseOnce('Unauthorized', { status: 401, statusText: 'Unauthorized' });

      const client = new JMAPClient(mockConfig, mockLogger);

      try {
        await client.fetchSession();
        expect.fail('Expected JMAPError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(JMAPError);
        expect((error as JMAPError).type).toBe('unauthorized');
      }
    });

    it('should throw JMAPError on HTTP 500', async () => {
      fetchMocker.mockResponseOnce('Server Error', { status: 500, statusText: 'Internal Server Error' });

      const client = new JMAPClient(mockConfig, mockLogger);

      try {
        await client.fetchSession();
        expect.fail('Expected JMAPError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(JMAPError);
        expect((error as JMAPError).type).toBe('serverError');
      }
    });

    it('should use Basic auth header for basic auth method', async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));

      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      const [, options] = fetchMocker.mock.calls[0];
      const expectedToken = Buffer.from('testuser:testpass').toString('base64');
      expect(options?.headers?.['Authorization']).toBe(`Basic ${expectedToken}`);
    });

    it('should use Bearer auth header for bearer auth method', async () => {
      const bearerConfig: Config = {
        ...mockConfig,
        JMAP_AUTH_METHOD: 'bearer',
        JMAP_TOKEN: 'test-bearer-token',
      };
      fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));

      const client = new JMAPClient(bearerConfig, mockLogger);
      await client.fetchSession();

      const [, options] = fetchMocker.mock.calls[0];
      expect(options?.headers?.['Authorization']).toBe('Bearer test-bearer-token');
    });
  });

  describe('getSession', () => {
    it('should throw error if session not initialized', () => {
      const client = new JMAPClient(mockConfig, mockLogger);

      expect(() => client.getSession()).toThrow(JMAPError);
      expect(() => client.getSession()).toThrow('Session not initialized');
    });

    it('should return session after fetchSession', async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));

      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();
      const session = client.getSession();

      expect(session.accountId).toBe('account-123');
    });
  });

  describe('request', () => {
    beforeEach(async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));
    });

    it('should send batched request with multiple methodCalls', async () => {
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      const batchedResponse = {
        methodResponses: [
          ['Email/get', { accountId: 'account-123', list: [], state: 'email-state-1' }, 'c1'],
          ['Mailbox/get', { accountId: 'account-123', list: [], state: 'mailbox-state-1' }, 'c2'],
        ],
        sessionState: 'session-state-1',
      };
      fetchMocker.mockResponseOnce(JSON.stringify(batchedResponse));

      const response = await client.request([
        ['Email/get', { accountId: 'account-123', ids: null }, 'c1'],
        ['Mailbox/get', { accountId: 'account-123', ids: null }, 'c2'],
      ]);

      expect(response.methodResponses).toHaveLength(2);
      expect(response.methodResponses[0][0]).toBe('Email/get');
      expect(response.methodResponses[1][0]).toBe('Mailbox/get');

      // Verify single HTTP call with both methods
      expect(fetchMocker).toHaveBeenCalledTimes(2); // 1 session + 1 request
      const [, options] = fetchMocker.mock.calls[1];
      const requestBody = JSON.parse(options?.body as string);
      expect(requestBody.methodCalls).toHaveLength(2);
    });

    it('should use default capabilities if not provided', async () => {
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      const response = {
        methodResponses: [['Email/get', { list: [] }, 'c1']],
      };
      fetchMocker.mockResponseOnce(JSON.stringify(response));

      await client.request([['Email/get', { accountId: 'account-123' }, 'c1']]);

      const [, options] = fetchMocker.mock.calls[1];
      const requestBody = JSON.parse(options?.body as string);
      expect(requestBody.using).toContain('urn:ietf:params:jmap:core');
      expect(requestBody.using).toContain('urn:ietf:params:jmap:mail');
    });

    it('should throw error if session not initialized', async () => {
      const client = new JMAPClient(mockConfig, mockLogger);

      await expect(
        client.request([['Email/get', {}, 'c1']])
      ).rejects.toThrow('Session not initialized');
    });

    it('should throw JMAPError on HTTP error during request', async () => {
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      fetchMocker.mockResponseOnce('Forbidden', { status: 403, statusText: 'Forbidden' });

      await expect(
        client.request([['Email/get', {}, 'c1']])
      ).rejects.toMatchObject({
        type: 'forbidden',
      });
    });

    it('should warn when session state changes', async () => {
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      const response = {
        methodResponses: [['Email/get', { list: [] }, 'c1']],
        sessionState: 'session-state-2', // Changed state
      };
      fetchMocker.mockResponseOnce(JSON.stringify(response));

      await client.request([['Email/get', {}, 'c1']]);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ oldState: 'session-state-1', newState: 'session-state-2' }),
        expect.any(String)
      );
    });
  });

  describe('parseMethodResponse', () => {
    it('should parse successful response', async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      const result = client.parseMethodResponse([
        'Email/get',
        { accountId: 'account-123', list: [{ id: 'email-1' }], state: 'state-1' },
        'c1',
      ]);

      expect(result.success).toBe(true);
      expect(result.data?.list).toEqual([{ id: 'email-1' }]);
    });

    it('should parse error response', async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      const result = client.parseMethodResponse([
        'error',
        { type: 'stateMismatch', description: 'State is stale' },
        'c1',
      ]);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('stateMismatch');
      expect(result.error?.description).toBe('State is stale');
    });
  });

  describe('state tracking', () => {
    beforeEach(async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));
    });

    it('should track state from response', async () => {
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      const response = {
        methodResponses: [
          ['Email/get', { list: [], state: 'email-state-1' }, 'c1'],
        ],
      };
      fetchMocker.mockResponseOnce(JSON.stringify(response));

      await client.request([['Email/get', {}, 'c1']]);

      expect(client.getState('Email')).toBe('email-state-1');
    });

    it('should track newState from response', async () => {
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      const response = {
        methodResponses: [
          ['Email/set', { newState: 'email-state-2' }, 'c1'],
        ],
      };
      fetchMocker.mockResponseOnce(JSON.stringify(response));

      await client.request([['Email/set', {}, 'c1']]);

      expect(client.getState('Email')).toBe('email-state-2');
    });

    it('should return undefined for untracked state', async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      expect(client.getState('Thread')).toBeUndefined();
    });

    it('should clear specific state', async () => {
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      client.updateState('Email', 'state-1');
      client.updateState('Mailbox', 'state-2');
      client.clearState('Email');

      expect(client.getState('Email')).toBeUndefined();
      expect(client.getState('Mailbox')).toBe('state-2');
    });

    it('should clear all state', async () => {
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      client.updateState('Email', 'state-1');
      client.updateState('Mailbox', 'state-2');
      client.clearState();

      expect(client.getState('Email')).toBeUndefined();
      expect(client.getState('Mailbox')).toBeUndefined();
    });
  });

  describe('uploadBlob', () => {
    const withUpload = { ...validSessionResponse, uploadUrl: 'https://jmap.example.com/upload/{accountId}/' };

    it('posts the bytes to the upload URL with their type and returns the blob', async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(withUpload));
      fetchMocker.mockResponseOnce(JSON.stringify({ accountId: 'account-123', blobId: 'blob-9', type: 'application/pdf', size: 3 }));
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      const blob = await client.uploadBlob(new Uint8Array([1, 2, 3]), 'application/pdf');

      expect(blob).toMatchObject({ blobId: 'blob-9', type: 'application/pdf', size: 3 });
      const [url, options] = fetchMocker.mock.calls[1];
      expect(url).toBe('https://jmap.example.com/upload/account-123/');
      expect(options?.method).toBe('POST');
      expect((options?.headers as Record<string, string>)['Content-Type']).toBe('application/pdf');
      expect(options?.headers).toHaveProperty('Authorization');
    });

    it('reports an HTTP refusal', async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(withUpload));
      fetchMocker.mockResponseOnce('too large', { status: 413, statusText: 'Payload Too Large' });
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      await expect(client.uploadBlob(new Uint8Array([1]), 'application/pdf')).rejects.toBeInstanceOf(JMAPError);
    });

    it('says when the server gives no upload URL', async () => {
      fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));
      const client = new JMAPClient(mockConfig, mockLogger);
      await client.fetchSession();

      await expect(client.uploadBlob(new Uint8Array([1]), 'application/pdf')).rejects.toMatchObject({ type: 'uploadUrlMissing' });
    });
  });
});

describe('JMAPClient OIDC auth', () => {
  let mockTokenRefresher: {
    ensureValidToken: ReturnType<typeof vi.fn>;
    isTokenValid: ReturnType<typeof vi.fn>;
    clearCache: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    fetchMocker.enableMocks();
    fetchMocker.resetMocks();
    vi.clearAllMocks();

    // Setup mock token refresher
    mockTokenRefresher = {
      ensureValidToken: vi.fn(),
      isTokenValid: vi.fn(),
      clearCache: vi.fn(),
    };
    mockCreateTokenRefresher.mockReturnValue(mockTokenRefresher as any);
  });

  afterEach(() => {
    fetchMocker.disableMocks();
  });

  it('should use stored token from TokenRefresher for OIDC auth', async () => {
    mockTokenRefresher.ensureValidToken.mockResolvedValue({
      accessToken: 'oidc-access-token-123',
      refreshToken: 'oidc-refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));

    const client = new JMAPClient(mockOidcConfig, mockLogger);
    await client.fetchSession();

    // Verify TokenRefresher was created with correct params
    expect(mockCreateTokenRefresher).toHaveBeenCalledWith(
      'https://auth.example.com',
      'test-client-id'
    );

    // Verify ensureValidToken was called
    expect(mockTokenRefresher.ensureValidToken).toHaveBeenCalled();

    // Verify Authorization header uses the stored token
    const [, options] = fetchMocker.mock.calls[0];
    expect(options?.headers?.['Authorization']).toBe('Bearer oidc-access-token-123');
  });

  it('should propagate noStoredTokens error with re-auth instructions', async () => {
    const noTokensError = new JMAPError(
      'No stored tokens found',
      'noStoredTokens',
      'Run the auth command: npx mcp-twake-mail-auth'
    );
    mockTokenRefresher.ensureValidToken.mockRejectedValue(noTokensError);

    const client = new JMAPClient(mockOidcConfig, mockLogger);

    try {
      await client.fetchSession();
      expect.fail('Expected JMAPError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(JMAPError);
      expect((error as JMAPError).type).toBe('noStoredTokens');
      expect((error as JMAPError).fix).toContain('auth command');
    }
  });

  it('should propagate refreshFailed error with re-auth instructions', async () => {
    const refreshFailedError = new JMAPError(
      'Token refresh failed: invalid_grant',
      'refreshFailed',
      'Re-authenticate: npx mcp-twake-mail-auth'
    );
    mockTokenRefresher.ensureValidToken.mockRejectedValue(refreshFailedError);

    const client = new JMAPClient(mockOidcConfig, mockLogger);

    try {
      await client.fetchSession();
      expect.fail('Expected JMAPError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(JMAPError);
      expect((error as JMAPError).type).toBe('refreshFailed');
      expect((error as JMAPError).fix).toContain('Re-authenticate');
    }
  });

  it('should use fresh token for each request via TokenRefresher', async () => {
    // First call returns one token, second call returns a different token (simulating refresh)
    mockTokenRefresher.ensureValidToken
      .mockResolvedValueOnce({
        accessToken: 'first-token',
        refreshToken: 'refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      })
      .mockResolvedValueOnce({
        accessToken: 'refreshed-token',
        refreshToken: 'refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

    fetchMocker.mockResponseOnce(JSON.stringify(validSessionResponse));
    fetchMocker.mockResponseOnce(JSON.stringify({
      methodResponses: [['Email/get', { list: [] }, 'c1']],
    }));

    const client = new JMAPClient(mockOidcConfig, mockLogger);
    await client.fetchSession();
    await client.request([['Email/get', {}, 'c1']]);

    // Verify ensureValidToken was called twice (once for session, once for request)
    expect(mockTokenRefresher.ensureValidToken).toHaveBeenCalledTimes(2);

    // Check first call used first token
    const [, sessionOptions] = fetchMocker.mock.calls[0];
    expect(sessionOptions?.headers?.['Authorization']).toBe('Bearer first-token');

    // Check second call used refreshed token
    const [, requestOptions] = fetchMocker.mock.calls[1];
    expect(requestOptions?.headers?.['Authorization']).toBe('Bearer refreshed-token');
  });

  it('should throw oidcConfigError when OIDC config is incomplete', async () => {
    // Create config missing OIDC settings but with auth method set to oidc
    const incompleteOidcConfig: Config = {
      ...mockConfig,
      JMAP_AUTH_METHOD: 'oidc',
      // JMAP_OIDC_ISSUER and JMAP_OIDC_CLIENT_ID are missing
    };

    // Mock returns null since config is incomplete
    mockCreateTokenRefresher.mockReturnValue(null as any);

    const client = new JMAPClient(incompleteOidcConfig, mockLogger);

    try {
      await client.fetchSession();
      expect.fail('Expected JMAPError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(JMAPError);
      expect((error as JMAPError).type).toBe('oidcConfigError');
      expect((error as JMAPError).fix).toContain('OIDC_ISSUER');
    }
  });
});

describe('JMAPError', () => {
  describe('httpError', () => {
    it('should create unauthorized error for 401', () => {
      const error = JMAPError.httpError(401, 'Unauthorized');
      expect(error.type).toBe('unauthorized');
      expect(error.message).toBe('HTTP 401: Unauthorized');
    });

    it('should create forbidden error for 403', () => {
      const error = JMAPError.httpError(403, 'Forbidden');
      expect(error.type).toBe('forbidden');
    });

    it('should create notFound error for 404', () => {
      const error = JMAPError.httpError(404, 'Not Found');
      expect(error.type).toBe('notFound');
    });

    it('should create serverError for 5xx', () => {
      const error = JMAPError.httpError(500, 'Internal Server Error');
      expect(error.type).toBe('serverError');
    });
  });

  describe('methodError', () => {
    it('should create error with known type', () => {
      const error = JMAPError.methodError('stateMismatch', 'State is stale');
      expect(error.type).toBe('stateMismatch');
      expect(error.message).toBe('State is stale');
      expect(error.fix).toContain('Refetch');
    });

    it('should create error with unknown type', () => {
      const error = JMAPError.methodError('unknownType');
      expect(error.type).toBe('unknownType');
      expect(error.fix).toContain('JMAP error occurred');
    });
  });

  describe('timeout', () => {
    it('should create timeout error', () => {
      const error = JMAPError.timeout('JMAP request');
      expect(error.type).toBe('timeout');
      expect(error.message).toBe('JMAP request timed out');
      expect(error.fix).toContain('JMAP_REQUEST_TIMEOUT');
    });
  });
});
