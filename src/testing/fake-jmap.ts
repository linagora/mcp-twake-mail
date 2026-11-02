/**
 * The real JMAP client of the server, talking to a scripted server through a
 * stubbed global `fetch`. `request` receives what goes on the wire and answers
 * it by position, each answer naming the method it answers or `error`.
 */
import type { JmapClient } from 'jmap-client-ts';
import { vi } from 'vitest';
import type { Config } from '../config/schema.js';
import type { Logger } from '../config/logger.js';
import { createJmapClient } from '../jmap/client.js';

export type Invocation = [string, Record<string, unknown>, string];

const SESSION_URL = 'https://jmap.example.com/session';
const API_URL = 'https://jmap.example.com/api';
const MAIL = 'urn:ietf:params:jmap:mail';
const SUBMISSION = 'urn:ietf:params:jmap:submission';

export interface FakeJmap {
  client: JmapClient;
  request: ReturnType<typeof vi.fn<(calls: Invocation[], using: string[]) => Promise<{ methodResponses: Invocation[] }>>>;
  serveBlob: ReturnType<typeof vi.fn<(blobId: string, name: string, type: string | null) => Promise<ArrayBuffer>>>;
}

function answer(call: Invocation, response: Invocation | undefined): Invocation {
  if (!response) {
    // The tool stops before reading an answer the test did not script.
    return ['error', { type: 'notScripted' }, call[2]];
  }
  if (response[0] !== call[0] && response[0] !== 'error') {
    throw new Error(`Fake JMAP server: ${call[0]} answered with ${response[0]}`);
  }
  return [response[0], response[1], call[2]];
}

export async function createFakeJmap(accountId = 'account-1'): Promise<FakeJmap> {
  const request: FakeJmap['request'] = vi.fn();
  const serveBlob: FakeJmap['serveBlob'] = vi.fn();

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === SESSION_URL) {
      return Response.json({
        capabilities: { [MAIL]: {}, [SUBMISSION]: {} },
        accounts: { [accountId]: { name: accountId, isPersonal: true, accountCapabilities: { [MAIL]: {} } } },
        primaryAccounts: { [MAIL]: accountId },
        username: accountId,
        apiUrl: API_URL,
        downloadUrl: 'https://jmap.example.com/download/{accountId}/{blobId}/{name}?type={type}',
        uploadUrl: 'https://jmap.example.com/upload/{accountId}',
        eventSourceUrl: '',
        state: 'session-state',
      });
    }
    if (url === API_URL) {
      const { methodCalls, using } = JSON.parse(String(init?.body)) as { methodCalls: Invocation[]; using: string[] };
      const { methodResponses } = await request(methodCalls, using);
      return Response.json({
        methodResponses: methodCalls.map((call, index) => answer(call, methodResponses?.[index])),
        sessionState: 'session-state',
      });
    }
    const { pathname, searchParams } = new URL(url);
    const [, , , blobId, name] = pathname.split('/').map(decodeURIComponent);
    return new Response(await serveBlob(blobId, name, searchParams.get('type')));
  });

  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), isLevelEnabled: () => false } as unknown as Logger;
  const config = {
    JMAP_SESSION_URL: SESSION_URL,
    JMAP_AUTH_METHOD: 'bearer',
    JMAP_TOKEN: 'test-token',
    JMAP_REQUEST_TIMEOUT: 30000,
  } as Config;
  const client = createJmapClient(config, logger);
  await client.getSession();
  return { client, request, serveBlob };
}
