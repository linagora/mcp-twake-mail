import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JmapHttpError, JmapMethodError, JmapRequestError } from '@linagora/jmap-client-ts';
import {
  connect,
  createJmapClient,
  downloadBlob,
  errorText,
  SESSION_TIMEOUT,
  toJMAPError,
  uploadBlob,
} from '../../src/jmap/client.js';
import { JMAPError } from '../../src/errors.js';
import type { Config } from '../../src/config/schema.js';
import { sessionDocument, testConfig, testLogger } from '../../src/jmap/__tests__/fake-jmap.js';

// Mock the token-refresh module
vi.mock('../../src/auth/token-refresh.js', () => ({
  createTokenRefresher: vi.fn(),
  TokenRefresher: vi.fn(),
}));

import { createTokenRefresher } from '../../src/auth/token-refresh.js';
const mockCreateTokenRefresher = vi.mocked(createTokenRefresher);

const SESSION_URL = 'https://jmap.example.com/session';
const API_URL = 'https://jmap.example.com/api';

const mockConfig: Config = testConfig({
  JMAP_SESSION_URL: SESSION_URL,
  JMAP_AUTH_METHOD: 'basic',
  JMAP_USERNAME: 'testuser',
  JMAP_PASSWORD: 'testpass',
});

const mockOidcConfig: Config = testConfig({
  JMAP_SESSION_URL: SESSION_URL,
  JMAP_AUTH_METHOD: 'oidc',
  JMAP_USERNAME: undefined,
  JMAP_PASSWORD: undefined,
  JMAP_OIDC_ISSUER: 'https://auth.example.com',
  JMAP_OIDC_CLIENT_ID: 'test-client-id',
});

const validSession = sessionDocument('account-123');

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init });

const apiAnswer = (methodResponses: unknown[]) => json({ methodResponses, sessionState: validSession.state });

/** A fetch answering each request with the next response of the list. */
function scriptedFetch(...responses: Array<Response | ((url: string, init?: RequestInit) => Response | Promise<Response>)>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  });
}

const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);

/** A fetch that sends the headers at once, then a body that ends only when aborted. */
const stallingBodyFetch = () =>
  vi.fn(
    async (_url: string, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }
      )
  );

/** A fetch that answers only when aborted, as a server that never answers. */
const hangingFetch = () =>
  vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })
  );

describe('createJmapClient and connect', () => {
  const logger = testLogger();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('connect', () => {
    it('fetches the session and returns the mail account', async () => {
      const fetch = scriptedFetch(json(validSession));
      const client = createJmapClient(mockConfig, logger, { fetch });

      const account = await connect(client, logger, SESSION_URL);

      expect(account.accountId).toBe('account-123');
      expect(account.username).toBe('user@example.com');
      expect(account.session.apiUrl).toBe(API_URL);
      expect(account.session.capabilities).toHaveProperty('urn:ietf:params:jmap:core');
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe(SESSION_URL);
      expect(init?.method ?? 'GET').toBe('GET');
      expect(header(init, 'Authorization')).toBeTruthy();
    });

    it('throws JMAPError when no mail account is found', async () => {
      const fetch = scriptedFetch(json({ ...validSession, primaryAccounts: {} }));
      const client = createJmapClient(mockConfig, logger, { fetch });

      await expect(connect(client, logger)).rejects.toSatisfy(
        (error) => error instanceof JMAPError && error.type === 'noMailAccount'
      );
    });

    it('throws JMAPError on HTTP 401', async () => {
      const fetch = scriptedFetch(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));
      const client = createJmapClient(mockConfig, logger, { fetch });

      const error = await connect(client, logger).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JMAPError);
      expect((error as JMAPError).type).toBe('unauthorized');
      expect((error as JMAPError).message).toBe('HTTP 401: Unauthorized');
      // basic auth cannot be refreshed: no second try
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('throws JMAPError on HTTP 500', async () => {
      const fetch = scriptedFetch(new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }));
      const client = createJmapClient(mockConfig, logger, { fetch });

      await expect(connect(client, logger)).rejects.toMatchObject({ type: 'serverError' });
    });

    it('throws JMAPError when the session is not JMAP', async () => {
      const fetch = scriptedFetch(json({ hello: 'world' }));
      const client = createJmapClient(mockConfig, logger, { fetch });

      await expect(connect(client, logger)).rejects.toMatchObject({ type: 'invalidResponse' });
    });

    it('warns when the session has no upload or download URL', async () => {
      const warn = testLogger();
      const fetch = scriptedFetch(json({ ...validSession, uploadUrl: '', downloadUrl: '' }));
      const client = createJmapClient(mockConfig, warn, { fetch });

      await connect(client, warn);

      expect(warn.warn).toHaveBeenCalledWith(expect.stringContaining('No downloadUrl'));
      expect(warn.warn).toHaveBeenCalledWith(expect.stringContaining('No uploadUrl'));
    });

    it('uses a Basic auth header for basic auth', async () => {
      const fetch = scriptedFetch(json(validSession));
      await connect(createJmapClient(mockConfig, logger, { fetch }), logger);

      const expectedToken = Buffer.from('testuser:testpass').toString('base64');
      expect(header(fetch.mock.calls[0][1], 'Authorization')).toBe(`Basic ${expectedToken}`);
    });

    it('uses a Bearer auth header for bearer auth', async () => {
      const fetch = scriptedFetch(json(validSession));
      const bearerConfig = testConfig({ JMAP_AUTH_METHOD: 'bearer', JMAP_TOKEN: 'test-bearer-token' });
      await connect(createJmapClient(bearerConfig, logger, { fetch }), logger);

      expect(header(fetch.mock.calls[0][1], 'Authorization')).toBe('Bearer test-bearer-token');
    });
  });

  describe('timeouts', () => {
    it('gives the session 5 seconds and API calls JMAP_REQUEST_TIMEOUT', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const fetch = scriptedFetch(json(validSession), apiAnswer([['Mailbox/get', { list: [], notFound: [] }, 'c0']]));
      const client = createJmapClient(testConfig({ JMAP_REQUEST_TIMEOUT: 12345 }), logger, { fetch });

      await connect(client, logger);
      await client.call('Mailbox/get', { accountId: 'account-1' });

      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([SESSION_TIMEOUT, 12345]);
      expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetch.mock.calls[1][1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it('reports a session that does not answer in time', async () => {
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), 5);
        return controller.signal;
      });
      const client = createJmapClient(mockConfig, logger, { fetch: hangingFetch() });

      const error = await connect(client, logger).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JMAPError);
      expect((error as JMAPError).type).toBe('timeout');
      expect((error as JMAPError).message).toBe('session fetch timed out');
    });

    it('reports an API request that does not answer in time', async () => {
      const hanging = hangingFetch();
      const fetch = scriptedFetch(json(validSession), (url, init) => hanging(url, init));
      const client = createJmapClient(testConfig({ JMAP_REQUEST_TIMEOUT: 10 }), logger, { fetch });
      await connect(client, logger);

      const error = await client.call('Mailbox/get', { accountId: 'account-1' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JMAPError);
      expect((error as JMAPError).message).toBe('JMAP request timed out');
      expect(errorText(error)).toBe('JMAP request timed out');
    });

    it('reports a download that does not answer in time', async () => {
      const hanging = hangingFetch();
      const fetch = scriptedFetch(json(validSession), (url, init) => hanging(url, init));
      const client = createJmapClient(testConfig({ JMAP_REQUEST_TIMEOUT: 10 }), logger, { fetch });
      await connect(client, logger);

      await expect(downloadBlob(client, 'blob-1')).rejects.toThrow('blob download timed out');
    });

    it('reports a download whose body does not arrive in time', async () => {
      const stalling = stallingBodyFetch();
      const fetch = scriptedFetch(json(validSession), (url, init) => stalling(url, init));
      const client = createJmapClient(testConfig({ JMAP_REQUEST_TIMEOUT: 10 }), logger, { fetch });
      await connect(client, logger);

      await expect(downloadBlob(client, 'blob-1')).rejects.toThrow('blob download timed out');
    });

    it('reports an upload that does not answer in time', async () => {
      const hanging = hangingFetch();
      const fetch = scriptedFetch(json(validSession), (url, init) => hanging(url, init));
      const client = createJmapClient(testConfig({ JMAP_REQUEST_TIMEOUT: 10 }), logger, { fetch });
      await connect(client, logger);

      await expect(uploadBlob(client, new Uint8Array([1]), 'application/pdf')).rejects.toThrow('blob upload timed out');
    });

    it('lets a network error through unchanged', async () => {
      const fetch = scriptedFetch(() => {
        throw new TypeError('fetch failed');
      });
      const client = createJmapClient(mockConfig, logger, { fetch });

      await expect(connect(client, logger)).rejects.toThrow('fetch failed');
    });
  });

  describe('method calls', () => {
    it('sends the calls with the capabilities they need', async () => {
      const fetch = scriptedFetch(
        json(validSession),
        apiAnswer([
          ['Email/query', { ids: ['e1'], position: 0, queryState: 'q', canCalculateChanges: false }, 'c0'],
          ['Email/get', { list: [{ id: 'e1', subject: 'Hello' }], notFound: [], state: 's' }, 'c1'],
        ])
      );
      const client = createJmapClient(mockConfig, logger, { fetch });
      await connect(client, logger);

      const [, emails] = await client.request((b) => {
        const q = b.call('Email/query', { accountId: 'account-123', limit: 1 });
        return [q, b.call('Email/get', { accountId: 'account-123', '#ids': q.ref('/ids'), properties: ['subject'] })];
      });

      expect(emails.list[0].subject).toBe('Hello');
      const [url, init] = fetch.mock.calls[1];
      expect(url).toBe(API_URL);
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body.using).toEqual(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']);
      expect(body.methodCalls[1][1]['#ids']).toEqual({ resultOf: 'c0', name: 'Email/query', path: '/ids' });
    });

    it('reports a method error with its description', async () => {
      const fetch = scriptedFetch(
        json(validSession),
        apiAnswer([['error', { type: 'serverError', description: 'Internal server error' }, 'c0']])
      );
      const client = createJmapClient(mockConfig, logger, { fetch });
      await connect(client, logger);

      const error = await client.call('Mailbox/get', { accountId: 'account-123' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JmapMethodError);
      expect(errorText(error)).toBe('Internal server error');
    });

    it('reports an HTTP error as before', async () => {
      const fetch = scriptedFetch(json(validSession), new Response('', { status: 503, statusText: 'Service Unavailable' }));
      const client = createJmapClient(mockConfig, logger, { fetch });
      await connect(client, logger);

      const error = await client.call('Mailbox/get', { accountId: 'account-123' }).catch((e: unknown) => e);
      expect(errorText(error)).toBe('HTTP 503: Service Unavailable');
    });
  });

  describe('uploadBlob', () => {
    it('posts the bytes to the upload URL with their type and returns the blob', async () => {
      const fetch = scriptedFetch(
        json({ ...validSession, uploadUrl: 'https://jmap.example.com/upload/{accountId}/' }),
        json({ accountId: 'account-123', blobId: 'blob-9', type: 'application/pdf', size: 3 }, { status: 201 })
      );
      const client = createJmapClient(mockConfig, logger, { fetch });
      await connect(client, logger);

      const blob = await uploadBlob(client, new Uint8Array([1, 2, 3]), 'application/pdf');

      expect(blob).toMatchObject({ blobId: 'blob-9', type: 'application/pdf', size: 3 });
      const [url, init] = fetch.mock.calls[1];
      expect(url).toBe('https://jmap.example.com/upload/account-123/');
      expect(init?.method).toBe('POST');
      expect(header(init, 'Content-Type')).toBe('application/pdf');
      expect(header(init, 'Authorization')).toBeTruthy();
    });

    it('reports an HTTP refusal', async () => {
      const fetch = scriptedFetch(json(validSession), new Response('too large', { status: 413, statusText: 'Payload Too Large' }));
      const client = createJmapClient(mockConfig, logger, { fetch });
      await connect(client, logger);

      const error = await uploadBlob(client, new Uint8Array([1]), 'application/pdf').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JMAPError);
      expect((error as JMAPError).message).toBe('HTTP 413: Payload Too Large');
    });

    it('says when the server gives no upload URL', async () => {
      const fetch = scriptedFetch(json({ ...validSession, uploadUrl: '' }));
      const client = createJmapClient(mockConfig, logger, { fetch });
      await connect(client, logger);

      await expect(uploadBlob(client, new Uint8Array([1]), 'application/pdf')).rejects.toMatchObject({ type: 'uploadUrlMissing' });
      expect(fetch).toHaveBeenCalledOnce();
    });
  });

  describe('downloadBlob', () => {
    it('gets the blob from the download URL with authentication', async () => {
      const fetch = scriptedFetch(json(validSession), new Response(new Uint8Array([1, 2, 3])));
      const client = createJmapClient(mockConfig, logger, { fetch });
      await connect(client, logger);

      const data = await downloadBlob(client, 'blob-1', 'devis.pdf', 'application/pdf');

      expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3]));
      const [url, init] = fetch.mock.calls[1];
      expect(url).toBe('https://jmap.example.com/download/account-123/blob-1/devis.pdf?type=application%2Fpdf');
      expect(header(init, 'Authorization')).toBeTruthy();
    });

    it('names an unnamed blob "attachment"', async () => {
      const fetch = scriptedFetch(json(validSession), new Response('x'));
      const client = createJmapClient(mockConfig, logger, { fetch });
      await connect(client, logger);

      await downloadBlob(client, 'blob-1');

      expect(fetch.mock.calls[1][0]).toBe(
        'https://jmap.example.com/download/account-123/blob-1/attachment?type=application%2Foctet-stream'
      );
    });

    it('reports an HTTP refusal', async () => {
      const fetch = scriptedFetch(json(validSession), new Response('', { status: 404, statusText: 'Not Found' }));
      const client = createJmapClient(mockConfig, logger, { fetch });
      await connect(client, logger);

      await expect(downloadBlob(client, 'blob-1')).rejects.toMatchObject({ type: 'notFound', message: 'HTTP 404: Not Found' });
    });

    it('says when the server gives no download URL', async () => {
      const fetch = scriptedFetch(json({ ...validSession, downloadUrl: '' }));
      const client = createJmapClient(mockConfig, logger, { fetch });
      await connect(client, logger);

      await expect(downloadBlob(client, 'blob-1')).rejects.toMatchObject({ type: 'downloadUrlMissing' });
    });
  });
});

describe('OIDC auth', () => {
  const logger = testLogger();
  let mockTokenRefresher: {
    ensureValidToken: ReturnType<typeof vi.fn>;
    forceRefresh: ReturnType<typeof vi.fn>;
  };
  const tokens = (accessToken: string) => ({
    accessToken,
    refreshToken: 'refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockTokenRefresher = { ensureValidToken: vi.fn(), forceRefresh: vi.fn() };
    mockCreateTokenRefresher.mockReturnValue(mockTokenRefresher as never);
  });

  it('uses the stored token from TokenRefresher', async () => {
    mockTokenRefresher.ensureValidToken.mockResolvedValue(tokens('oidc-access-token-123'));
    const fetch = scriptedFetch(json(validSession));

    await connect(createJmapClient(mockOidcConfig, logger, { fetch }), logger);

    expect(mockCreateTokenRefresher).toHaveBeenCalledWith('https://auth.example.com', 'test-client-id');
    expect(mockTokenRefresher.ensureValidToken).toHaveBeenCalled();
    expect(header(fetch.mock.calls[0][1], 'Authorization')).toBe('Bearer oidc-access-token-123');
  });

  it('propagates noStoredTokens with re-auth instructions', async () => {
    mockTokenRefresher.ensureValidToken.mockRejectedValue(
      new JMAPError('No stored tokens found', 'noStoredTokens', 'Run the auth command: npx mcp-twake-mail-auth')
    );
    const fetch = scriptedFetch();

    const error = await connect(createJmapClient(mockOidcConfig, logger, { fetch }), logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JMAPError);
    expect((error as JMAPError).type).toBe('noStoredTokens');
    expect((error as JMAPError).fix).toContain('auth command');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('propagates refreshFailed with re-auth instructions', async () => {
    mockTokenRefresher.ensureValidToken.mockRejectedValue(
      new JMAPError('Token refresh failed: invalid_grant', 'refreshFailed', 'Re-authenticate: npx mcp-twake-mail-auth')
    );

    const error = await connect(createJmapClient(mockOidcConfig, logger, { fetch: scriptedFetch() }), logger).catch(
      (e: unknown) => e
    );
    expect((error as JMAPError).type).toBe('refreshFailed');
    expect((error as JMAPError).fix).toContain('Re-authenticate');
  });

  it('asks TokenRefresher for a token before each request', async () => {
    mockTokenRefresher.ensureValidToken
      .mockResolvedValueOnce(tokens('first-token'))
      .mockResolvedValueOnce(tokens('refreshed-token'));
    const fetch = scriptedFetch(json(validSession), apiAnswer([['Email/get', { list: [], notFound: [], state: 's' }, 'c0']]));
    const client = createJmapClient(mockOidcConfig, logger, { fetch });

    await connect(client, logger);
    await client.call('Email/get', { accountId: 'account-123' });

    expect(mockTokenRefresher.ensureValidToken).toHaveBeenCalledTimes(2);
    expect(header(fetch.mock.calls[0][1], 'Authorization')).toBe('Bearer first-token');
    expect(header(fetch.mock.calls[1][1], 'Authorization')).toBe('Bearer refreshed-token');
  });

  it('refreshes the token once when the server answers 401, then sends the request again', async () => {
    mockTokenRefresher.ensureValidToken
      .mockResolvedValueOnce(tokens('revoked-token'))
      .mockResolvedValueOnce(tokens('new-token'));
    mockTokenRefresher.forceRefresh.mockResolvedValue(true);
    const fetch = scriptedFetch(new Response('', { status: 401, statusText: 'Unauthorized' }), json(validSession));

    const account = await connect(createJmapClient(mockOidcConfig, logger, { fetch }), logger);

    expect(account.accountId).toBe('account-123');
    expect(mockTokenRefresher.forceRefresh).toHaveBeenCalledOnce();
    expect(header(fetch.mock.calls[1][1], 'Authorization')).toBe('Bearer new-token');
  });

  it('reports the 401 when the token cannot be refreshed', async () => {
    mockTokenRefresher.ensureValidToken.mockResolvedValue(tokens('revoked-token'));
    mockTokenRefresher.forceRefresh.mockRejectedValue(new JMAPError('Token refresh failed', 'refreshFailed', 'x'));
    const fetch = scriptedFetch(new Response('', { status: 401, statusText: 'Unauthorized' }));

    await expect(connect(createJmapClient(mockOidcConfig, logger, { fetch }), logger)).rejects.toMatchObject({
      type: 'unauthorized',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('throws oidcConfigError when OIDC config is incomplete', async () => {
    const incomplete = testConfig({ JMAP_AUTH_METHOD: 'oidc' });

    const error = await connect(createJmapClient(incomplete, logger, { fetch: scriptedFetch() }), logger).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(JMAPError);
    expect((error as JMAPError).type).toBe('oidcConfigError');
    expect((error as JMAPError).fix).toContain('OIDC_ISSUER');
    expect(mockCreateTokenRefresher).not.toHaveBeenCalled();
  });
});

describe('command auth', () => {
  const logger = testLogger();

  it('runs the token command again once when the server answers 401', async () => {
    const config = testConfig({
      JMAP_AUTH_METHOD: 'command',
      JMAP_TOKEN_COMMAND: `node -e "process.stdout.write('token-' + Date.now() + Math.random())"`,
    });
    const fetch = scriptedFetch(new Response('', { status: 401, statusText: 'Unauthorized' }), json(validSession));

    await connect(createJmapClient(config, logger, { fetch }), logger);

    const first = header(fetch.mock.calls[0][1], 'Authorization');
    const second = header(fetch.mock.calls[1][1], 'Authorization');
    expect(first).toMatch(/^Bearer token-/);
    expect(second).toMatch(/^Bearer token-/);
    expect(second).not.toBe(first);
  });

  it('throws commandConfigError without a command', async () => {
    const config = testConfig({ JMAP_AUTH_METHOD: 'command' });

    await expect(connect(createJmapClient(config, logger, { fetch: scriptedFetch() }), logger)).rejects.toMatchObject({
      type: 'commandConfigError',
    });
  });
});

describe('errorText and toJMAPError', () => {
  it('shows a method error by its description, else its type', () => {
    const described = new JmapMethodError({ arguments: { type: 'notFound', description: 'No such e-mail' }, methodName: 'Email/get', callId: 'c0' });
    const bare = new JmapMethodError({ arguments: { type: 'stateMismatch' }, methodName: 'Email/set', callId: 'c0' });
    expect(errorText(described)).toBe('No such e-mail');
    expect(errorText(bare)).toBe('stateMismatch');
    expect(toJMAPError(bare)).toMatchObject({ type: 'stateMismatch', fix: expect.stringContaining('Refetch') });
  });

  it('shows an HTTP error as "HTTP status: text"', () => {
    const error = new JmapHttpError({ status: 403, statusText: 'Forbidden', body: '', url: API_URL });
    expect(errorText(error)).toBe('HTTP 403: Forbidden');
    expect(toJMAPError(error)).toMatchObject({ type: 'forbidden' });
  });

  it('shows a request-level error with its detail', () => {
    const error = new JmapRequestError({ type: 'urn:ietf:params:jmap:error:limit', status: 400, detail: 'Too many calls', limit: 'maxCallsInRequest' }, 400);
    expect(errorText(error)).toBe('HTTP 400: Too many calls');
  });

  it('shows other errors by their message', () => {
    expect(errorText(new Error('Network error'))).toBe('Network error');
    expect(errorText('plain')).toBe('plain');
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
