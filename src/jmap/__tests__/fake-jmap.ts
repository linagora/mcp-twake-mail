/**
 * A fake JMAP server for tests, at the fetch boundary: the real client (jmap-client-ts with this
 * server's timeouts and auth) talks to it over a fake fetch.
 *
 *   const jmap = await fakeJmap();
 *   jmap.request.mockResolvedValueOnce({ methodResponses: [['Mailbox/get', { list: [] }, 'any-id']] });
 *   registerMailboxTools(server, jmap.client, logger);
 *
 * `request` receives the method calls of each API request (call ids `c0`, `c1`… as sent) and returns
 * `{ methodResponses }`. The call ids of the responses are replaced, in order of first appearance, by
 * those of the request, so canned responses need not know them (an EmailSubmission/set followed by
 * its implicit Email/set keeps a shared id). It may also return a `Response` (an HTTP error, say) or
 * throw (a network error). `upload` and `download` work the same for blobs.
 */
import { vi, type Mock } from 'vitest';
import type { JmapClient } from '@linagora/jmap-client-ts';
import { createJmapClient } from '../client.js';
import type { Config } from '../../config/schema.js';
import type { Logger } from '../../config/logger.js';

export type MethodCall = [string, Record<string, unknown>, string];
export interface ApiAnswer {
  methodResponses: Array<[string, Record<string, unknown>, string]>;
  sessionState?: string;
}

export const SESSION_URL = 'https://jmap.example.com/session';
export const API_URL = 'https://jmap.example.com/api';
export const UPLOAD_URL = 'https://jmap.example.com/upload/{accountId}';
export const DOWNLOAD_URL = 'https://jmap.example.com/download/{accountId}/{blobId}/{name}?type={type}';

export interface FakeJmap {
  /** A real client, session loaded, talking to this fake. */
  client: JmapClient;
  accountId: string;
  /** Answers each API request: (methodCalls, using) => { methodResponses }. */
  request: Mock<(methodCalls: MethodCall[], using: string[]) => ApiAnswer | Response | Promise<ApiAnswer | Response>>;
  /** Answers each upload: (bytes, contentType, url) => { blobId, type, size }. */
  upload: Mock<(body: Uint8Array, contentType: string, url: string) => unknown>;
  /** Answers each download: (url) => body (bytes, text or Response). */
  download: Mock<(url: string) => BodyInit | Response | Promise<BodyInit | Response>>;
  /** Records every fetch made, session included. */
  fetch: Mock<(url: string, init?: RequestInit) => void>;
  /** Method calls of the n-th API request (0 = first). */
  calls(n?: number): MethodCall[];
}

export const testLogger = (): Logger =>
  ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  }) as unknown as Logger;

export const testConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    JMAP_SESSION_URL: SESSION_URL,
    JMAP_AUTH_METHOD: 'basic',
    JMAP_USERNAME: 'user@example.com',
    JMAP_PASSWORD: 'secret',
    JMAP_REQUEST_TIMEOUT: 30000,
    LOG_LEVEL: 'error',
    JMAP_OIDC_SCOPE: 'openid email offline_access',
    JMAP_OIDC_REDIRECT_URI: 'http://localhost:3000/callback',
    JMAP_APPROVAL: 'client',
    JMAP_APPROVAL_TIMEOUT_MS: 600000,
    ...overrides,
  }) as Config;

export function sessionDocument(accountId = 'account-1', extra: Record<string, unknown> = {}) {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': { maxSizeUpload: 50000000 },
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:submission': {},
    },
    accounts: { [accountId]: { name: 'user@example.com', isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': accountId, 'urn:ietf:params:jmap:submission': accountId },
    username: 'user@example.com',
    apiUrl: API_URL,
    downloadUrl: DOWNLOAD_URL,
    uploadUrl: UPLOAD_URL,
    eventSourceUrl: '',
    state: 'session-state',
    ...extra,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** An HTTP error answer, for `request`, `upload` or `download`. */
export const httpError = (status: number, statusText = '') => new Response('', { status, statusText });

/** Give the canned responses the call ids of the request, in order of first appearance. */
function withCallIds(answer: ApiAnswer, methodCalls: MethodCall[]): ApiAnswer {
  const ids = new Map<string, string>();
  const methodResponses = (answer.methodResponses ?? []).map(([name, args, id]) => {
    if (!ids.has(id)) ids.set(id, methodCalls[ids.size]?.[2] ?? id);
    return [name, args, ids.get(id)!] as [string, Record<string, unknown>, string];
  });
  return { ...answer, methodResponses };
}

export async function fakeJmap(
  options: { accountId?: string; session?: Record<string, unknown>; config?: Partial<Config> } = {}
): Promise<FakeJmap> {
  const accountId = options.accountId ?? 'account-1';
  const session = { ...sessionDocument(accountId), ...options.session };
  const requests: MethodCall[][] = [];

  // Mocks without an implementation: each test says what the server answers. When it says nothing
  // (or after vi.resetAllMocks), the server answers no method response, a new blob, an empty file.
  const request: FakeJmap['request'] = vi.fn();
  const upload: FakeJmap['upload'] = vi.fn();
  const download: FakeJmap['download'] = vi.fn();
  const fetchCalls: FakeJmap['fetch'] = vi.fn();

  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    fetchCalls(url, init);
    if (url === SESSION_URL) return json(session);
    if (url === API_URL) {
      const body = JSON.parse(String(init?.body)) as { using: string[]; methodCalls: MethodCall[] };
      requests.push(body.methodCalls);
      const answer = (await request(body.methodCalls, body.using)) ?? { methodResponses: [] };
      if (answer instanceof Response) return answer;
      return json({ sessionState: session.state, ...withCallIds(answer, body.methodCalls) });
    }
    if (init?.method === 'POST') {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      const type = new Headers(init.headers).get('Content-Type') ?? '';
      const answer = (await upload(bytes, type, url)) ?? {
        accountId,
        blobId: `blob-${upload.mock.calls.length}`,
        type,
        size: bytes.byteLength,
      };
      return answer instanceof Response ? answer : json(answer, 201);
    }
    const answer = (await download(url)) ?? new Uint8Array();
    return answer instanceof Response ? answer : new Response(answer);
  };

  const client = createJmapClient(testConfig({ JMAP_SESSION_URL: SESSION_URL, ...options.config }), testLogger(), { fetch });
  await client.getSession();

  return {
    client,
    accountId,
    request,
    upload,
    download,
    fetch: fetchCalls,
    calls: (n = 0) => requests[n] ?? [],
  };
}
