import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/schema.js';
import type { Logger } from '../config/logger.js';
import { JMAPError } from '../errors.js';
import { createTokenRefresher } from '../auth/token-refresh.js';
import { createJmapClient, loadAccountId } from './client.js';

const MAIL = 'urn:ietf:params:jmap:mail';
const SESSION_URL = 'https://jmap.example.com/session';
const API_URL = 'https://jmap.example.com/api';

vi.mock('../auth/token-refresh.js', () => ({ createTokenRefresher: vi.fn() }));

const session = {
  capabilities: { [MAIL]: {} },
  accounts: { 'account-1': { name: 'a', isPersonal: true, accountCapabilities: { [MAIL]: {} } } },
  primaryAccounts: { [MAIL]: 'account-1' } as Record<string, string>,
  username: 'a',
  apiUrl: API_URL,
  downloadUrl: 'https://jmap.example.com/download/{accountId}/{blobId}/{name}?type={type}',
  uploadUrl: 'https://jmap.example.com/upload/{accountId}',
  eventSourceUrl: '',
  state: 's1',
};

const emptyGet = { methodResponses: [['Mailbox/get', { accountId: 'account-1', state: 's', list: [], notFound: [] }, 'c0']], sessionState: 's1' };

function makeConfig(overrides: Partial<Config>): Config {
  return {
    JMAP_SESSION_URL: SESSION_URL,
    JMAP_AUTH_METHOD: 'bearer',
    JMAP_TOKEN: 'static-token',
    JMAP_REQUEST_TIMEOUT: 30000,
    ...overrides,
  } as Config;
}

function makeLogger(debugEnabled = false) {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    isLevelEnabled: () => debugEnabled,
  };
}

const oidcConfig = makeConfig({
  JMAP_AUTH_METHOD: 'oidc',
  JMAP_OIDC_ISSUER: 'https://sso.example.com',
  JMAP_OIDC_CLIENT_ID: 'client',
});

describe('createJmapClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let logger: ReturnType<typeof makeLogger>;

  const client = (config: Config = makeConfig({})) => createJmapClient(config, logger as unknown as Logger);
  const sentAuthorization = (call = 0) =>
    new Headers(fetchMock.mock.calls[call][1]?.headers).get('Authorization');
  const mockOidcTokens = (ensureValidToken: () => Promise<unknown>) =>
    vi.mocked(createTokenRefresher).mockReturnValue({ ensureValidToken } as never);

  beforeEach(() => {
    logger = makeLogger();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json(session));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('authentication', () => {
    it('sends Basic credentials', async () => {
      await client(makeConfig({ JMAP_AUTH_METHOD: 'basic', JMAP_USERNAME: 'user', JMAP_PASSWORD: 'pass' })).getSession();
      expect(sentAuthorization()).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
    });

    it('sends the static Bearer token', async () => {
      await client().getSession();
      expect(sentAuthorization()).toBe('Bearer static-token');
    });

    it('sends the token printed by the command', async () => {
      await client(makeConfig({ JMAP_AUTH_METHOD: 'command', JMAP_TOKEN_COMMAND: 'echo command-token' })).getSession();
      expect(sentAuthorization()).toBe('Bearer command-token');
    });

    it('asks the OIDC token again for each request', async () => {
      const ensureValidToken = vi
        .fn()
        .mockResolvedValueOnce({ accessToken: 'first-token' })
        .mockResolvedValueOnce({ accessToken: 'second-token' });
      mockOidcTokens(ensureValidToken);
      const jmap = client(oidcConfig);

      await jmap.getSession();
      fetchMock.mockImplementation(async () => Response.json(emptyGet));
      await jmap.call('Mailbox/get', { accountId: 'account-1' });

      expect(ensureValidToken).toHaveBeenCalledTimes(2);
      expect(sentAuthorization(0)).toBe('Bearer first-token');
      expect(sentAuthorization(1)).toBe('Bearer second-token');
    });

    it.each([
      [JMAPError.noStoredTokens()],
      [JMAPError.refreshFailed('invalid_grant')],
    ])('propagates the OIDC error %s', async (oidcError) => {
      mockOidcTokens(() => Promise.reject(oidcError));

      await expect(client(oidcConfig).getSession()).rejects.toBe(oidcError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails when the OIDC configuration is incomplete', async () => {
      await expect(client(makeConfig({ JMAP_AUTH_METHOD: 'oidc' })).getSession()).rejects.toThrow(
        'OIDC configuration incomplete'
      );
    });

    it('fails when the command configuration is incomplete', async () => {
      await expect(client(makeConfig({ JMAP_AUTH_METHOD: 'command' })).getSession()).rejects.toThrow(
        'Command auth configuration incomplete'
      );
    });
  });

  describe('HTTP errors', () => {
    it('keeps the message without the URL', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 429, statusText: 'Too Many Requests' }));
      await expect(client().getSession()).rejects.toThrow(/^HTTP 429: Too Many Requests$/);
    });

    it('hands a 401 to the library, whose hook reports it', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 401, statusText: 'Seen only by the fetch wrapper' }));

      const error = await client().getSession().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JMAPError);
      expect((error as JMAPError).message).toBe('HTTP 401: Unauthorized');
      expect((error as JMAPError).type).toBe('unauthorized');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeouts', () => {
    const timedOut = () => fetchMock.mockRejectedValue(new DOMException('aborted', 'TimeoutError'));

    it('names the session fetch', async () => {
      timedOut();
      await expect(client().getSession()).rejects.toThrow('session fetch timed out');
    });

    it('names the JMAP request', async () => {
      const jmap = client();
      await jmap.getSession();
      timedOut();
      await expect(jmap.call('Mailbox/get', { accountId: 'account-1' })).rejects.toThrow('JMAP request timed out');
    });

    it('names the blob download', async () => {
      const jmap = client();
      await jmap.getSession();
      timedOut();
      await expect(jmap.download({ accountId: 'account-1', blobId: 'b' })).rejects.toThrow('blob download timed out');
    });

    it('gives the session its short timeout, other requests the configured one', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const jmap = client(makeConfig({ JMAP_REQUEST_TIMEOUT: 1234 }));

      await jmap.getSession();
      expect(timeout).toHaveBeenLastCalledWith(5000);

      fetchMock.mockImplementation(async () => Response.json(emptyGet));
      await jmap.call('Mailbox/get', { accountId: 'account-1' });
      expect(timeout).toHaveBeenLastCalledWith(1234);
      timeout.mockRestore();
    });

    it('gives a POST on the session URL the configured timeout', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      fetchMock.mockImplementation(async () => Response.json({ ...session, apiUrl: SESSION_URL }));
      const jmap = client(makeConfig({ JMAP_REQUEST_TIMEOUT: 1234 }));
      await jmap.getSession();

      fetchMock.mockImplementation(async () => Response.json(emptyGet));
      await jmap.call('Mailbox/get', { accountId: 'account-1' });

      expect(timeout).toHaveBeenLastCalledWith(1234);
      timeout.mockRestore();
    });
  });

  describe('signal', () => {
    it('aborts the request when the caller aborts, without calling it a timeout', async () => {
      const jmap = client();
      await jmap.getSession();
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
      );
      const caller = new AbortController();

      const pending = jmap.call('Mailbox/get', { accountId: 'account-1' }, { signal: caller.signal });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      caller.abort();

      await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    });

    it('still applies the timeout when the caller passes a signal', async () => {
      const jmap = client(makeConfig({ JMAP_REQUEST_TIMEOUT: 5 }));
      await jmap.getSession();
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
      );

      await expect(
        jmap.call('Mailbox/get', { accountId: 'account-1' }, { signal: new AbortController().signal })
      ).rejects.toThrow('JMAP request timed out');
    });
  });

  describe('logs', () => {
    it('logs the methods of a request in debug', async () => {
      logger = makeLogger(true);
      const jmap = client();
      await jmap.getSession();
      fetchMock.mockImplementation(async () => Response.json(emptyGet));

      await jmap.call('Mailbox/get', { accountId: 'account-1' });

      expect(logger.debug).toHaveBeenCalledWith({ methodCount: 1, methods: ['Mailbox/get'] }, 'Sending JMAP request');
    });

    it('logs a download in debug', async () => {
      logger = makeLogger(true);
      const jmap = client();
      await jmap.getSession();
      fetchMock.mockImplementation(async () => new Response('x'));

      await jmap.download({ accountId: 'account-1', blobId: 'b', name: 'n', type: 'text/plain' });

      expect(logger.debug).toHaveBeenCalledWith(
        { url: 'https://jmap.example.com/download/account-1/b/n?type=text%2Fplain' },
        'Downloading blob'
      );
    });

    it('stays silent when debug is off', async () => {
      const jmap = client();
      await jmap.getSession();
      fetchMock.mockImplementation(async () => Response.json(emptyGet));

      await jmap.call('Mailbox/get', { accountId: 'account-1' });

      expect(logger.debug).not.toHaveBeenCalled();
    });

    it('warns when the session state changes', async () => {
      const jmap = client();
      await jmap.getSession();
      fetchMock.mockImplementation(async (url) =>
        url === SESSION_URL
          ? Response.json({ ...session, state: 's2' })
          : Response.json({ ...emptyGet, sessionState: 's2' })
      );

      await jmap.call('Mailbox/get', { accountId: 'account-1' });

      expect(logger.warn).toHaveBeenCalledWith({ newState: 's2' }, expect.stringContaining('Session state changed'));
    });
  });

  // Imposed by the library, stated in the pull request.
  describe('invalid server answers', () => {
    it('refuses a response without sessionState', async () => {
      const jmap = client();
      await jmap.getSession();
      fetchMock.mockImplementation(async () => Response.json({ methodResponses: emptyGet.methodResponses }));

      await expect(jmap.call('Mailbox/get', { accountId: 'account-1' })).rejects.toThrow(
        `Invalid JMAP response from ${API_URL}`
      );
    });

    it('reports a non-JSON response', async () => {
      const jmap = client();
      await jmap.getSession();
      fetchMock.mockImplementation(async () => new Response('<html>'));

      await expect(jmap.call('Mailbox/get', { accountId: 'account-1' })).rejects.toThrow(
        `Invalid JSON from ${API_URL}`
      );
    });

    it.each(['downloadUrl', 'uploadUrl', 'accounts', 'state'])('refuses a session without %s', async (field) => {
      fetchMock.mockImplementation(async () => Response.json({ ...session, [field]: undefined }));

      await expect(client().getSession()).rejects.toThrow(`Invalid JMAP session from ${SESSION_URL}`);
    });
  });
});

describe('loadAccountId', () => {
  const logger = makeLogger() as unknown as Logger;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the primary mail account', async () => {
    vi.stubGlobal('fetch', async () => Response.json(session));
    await expect(loadAccountId(createJmapClient(makeConfig({}), logger), logger)).resolves.toBe('account-1');
  });

  it('fails when the session has no mail account', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ ...session, primaryAccounts: {} }));
    await expect(loadAccountId(createJmapClient(makeConfig({}), logger), logger)).rejects.toThrow(
      'No mail account found in JMAP session'
    );
  });
});
