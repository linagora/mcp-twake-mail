/**
 * The JMAP client of the server: @linagora/jmap-client-ts with this server's authentication
 * (basic, bearer, token command, OIDC), timeouts and error messages.
 */
import {
  createClient,
  JmapHttpError,
  JmapInvalidResponseError,
  JmapMethodError,
  JmapRequestError,
  type FetchFunction,
  type JmapClient,
  type Session,
} from '@linagora/jmap-client-ts';
import type { Config } from '../config/schema.js';
import type { Logger } from '../config/logger.js';
import { JMAPError } from '../errors.js';
import { createTokenRefresher } from '../auth/token-refresh.js';
import { CommandTokenProvider } from '../auth/token-command.js';

export type { JmapClient };

/** Session fetch timeout (quick check) */
export const SESSION_TIMEOUT = 5000;

/** The account the server works on, once the session is loaded. */
export interface JmapAccount {
  accountId: string;
  username: string;
  session: Session;
}

/** Value of the Authorization header, and what to do when the server answers 401. */
function makeAuth(config: Config, logger: Logger) {
  if (config.JMAP_AUTH_METHOD === 'command') {
    const tokens = config.JMAP_TOKEN_COMMAND ? new CommandTokenProvider(config.JMAP_TOKEN_COMMAND) : null;
    return {
      getAuthorizationHeader: async () => {
        if (!tokens) {
          throw new JMAPError(
            'Command auth configuration incomplete',
            'commandConfigError',
            'Ensure JMAP_TOKEN_COMMAND is configured.'
          );
        }
        return `Bearer ${await tokens.getToken()}`;
      },
      // The broker may have rotated the token: run the command again, once
      onUnauthorized: () => {
        if (!tokens) return false;
        tokens.invalidate();
        return true;
      },
    };
  }
  if (config.JMAP_AUTH_METHOD === 'oidc') {
    const refresher =
      config.JMAP_OIDC_ISSUER && config.JMAP_OIDC_CLIENT_ID
        ? createTokenRefresher(config.JMAP_OIDC_ISSUER, config.JMAP_OIDC_CLIENT_ID)
        : null;
    return {
      getAuthorizationHeader: async () => {
        if (!refresher) {
          throw new JMAPError(
            'OIDC configuration incomplete',
            'oidcConfigError',
            'Ensure OIDC_ISSUER and OIDC_CLIENT_ID are configured.'
          );
        }
        // Refreshes the token when it is about to expire
        const tokens = await refresher.ensureValidToken();
        return `Bearer ${tokens.accessToken}`;
      },
      // The token was revoked or expired early: refresh it, then the request is sent again once
      onUnauthorized: async () => {
        if (!refresher) return false;
        try {
          return await refresher.forceRefresh();
        } catch (error) {
          logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Token refresh after 401 failed');
          return false;
        }
      },
    };
  }
  if (config.JMAP_AUTH_METHOD === 'basic') {
    const token = Buffer.from(`${config.JMAP_USERNAME}:${config.JMAP_PASSWORD}`).toString('base64');
    return { getAuthorizationHeader: () => `Basic ${token}`, onUnauthorized: () => false };
  }
  // Bearer: static token from config
  return { getAuthorizationHeader: () => `Bearer ${config.JMAP_TOKEN}`, onUnauthorized: () => false };
}

/** What timed out, as the user is told. */
function operation(url: string, init: RequestInit | undefined, sessionUrl: string): string {
  if (url === sessionUrl) return 'session fetch';
  if (!init?.method || init.method === 'GET') return 'blob download';
  // API requests are JSON text; uploads are the file's bytes
  return typeof init.body === 'string' ? 'JMAP request' : 'blob upload';
}

/**
 * fetch with this server's timeouts: 5 s for the session, JMAP_REQUEST_TIMEOUT for the rest
 * (API calls, uploads and downloads). A timeout is reported as a JMAPError.
 */
function timedFetch(config: Config, base: FetchFunction | undefined): FetchFunction {
  const sessionUrl = config.JMAP_SESSION_URL;
  return async (url, init) => {
    const timeout = AbortSignal.timeout(url === sessionUrl ? SESSION_TIMEOUT : config.JMAP_REQUEST_TIMEOUT);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      // globalThis.fetch is read at call time (tests replace it)
      return await (base ?? globalThis.fetch)(url, { ...init, signal });
    } catch (error) {
      if (timeout.aborted && error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw JMAPError.timeout(operation(url, init, sessionUrl));
      }
      throw error;
    }
  };
}

/**
 * Create the JMAP client. No request is made until it is used: call {@link connect} first.
 * @param options.fetch fetch implementation (tests), globalThis.fetch by default
 */
export function createJmapClient(config: Config, logger: Logger, options: { fetch?: FetchFunction } = {}): JmapClient {
  return createClient({
    sessionUrl: config.JMAP_SESSION_URL,
    auth: makeAuth(config, logger),
    fetch: timedFetch(config, options.fetch),
  });
}

/**
 * Load the JMAP session and find the mail account.
 * @throws JMAPError if the session cannot be fetched or has no mail account
 */
export async function connect(client: JmapClient, logger: Logger, sessionUrl?: string): Promise<JmapAccount> {
  logger.info({ url: sessionUrl }, 'Fetching JMAP session...');
  let session: Session;
  try {
    session = await client.getSession();
  } catch (error) {
    throw toJMAPError(error);
  }

  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  if (!accountId) {
    throw JMAPError.methodError(
      'noMailAccount',
      'No mail account found in JMAP session. The server may not support JMAP Mail.'
    );
  }
  if (!session.downloadUrl) {
    logger.warn('No downloadUrl in JMAP session - attachment downloads will not work');
  }
  if (!session.uploadUrl) {
    logger.warn('No uploadUrl in JMAP session - attachments cannot be added to drafts');
  }

  logger.info({ accountId, apiUrl: session.apiUrl }, 'JMAP session established');
  return { accountId, username: session.username, session };
}

/**
 * Upload a blob (a file to attach) to the mail account (RFC 8620 §6.1).
 * @returns The blob reference to put in an Email's attachments
 * @throws JMAPError if the server has no upload URL or refuses the upload
 */
export async function uploadBlob(
  client: JmapClient,
  data: Uint8Array,
  type: string
): Promise<{ blobId: string; type: string; size: number }> {
  const session = await client.getSession();
  if (!session.uploadUrl) {
    throw new JMAPError(
      'Upload URL not available',
      'uploadUrlMissing',
      'The JMAP server did not provide an upload URL in the session: attachments cannot be added.'
    );
  }
  try {
    return await client.upload(client.getPrimaryAccountId(), data as Uint8Array<ArrayBuffer>, type);
  } catch (error) {
    throw toJMAPError(error);
  }
}

/**
 * Download a blob (an attachment) of the mail account.
 * @throws JMAPError if the server has no download URL or refuses the download
 */
export async function downloadBlob(client: JmapClient, blobId: string, name?: string, type?: string): Promise<ArrayBuffer> {
  const session = await client.getSession();
  if (!session.downloadUrl) {
    throw new JMAPError(
      'Download URL not available',
      'downloadUrlMissing',
      'The JMAP server did not provide a download URL in the session.'
    );
  }
  try {
    const blob = await client.download({
      accountId: client.getPrimaryAccountId(),
      blobId,
      name: name || 'attachment',
      type: type || 'application/octet-stream',
    });
    return await blob.arrayBuffer();
  } catch (error) {
    throw toJMAPError(error);
  }
}

/**
 * The library's errors as this server reports them (what went wrong, and how to fix it).
 */
export function toJMAPError(error: unknown): unknown {
  if (error instanceof JmapMethodError) {
    return JMAPError.methodError(error.type, error.description ?? undefined);
  }
  if (error instanceof JmapHttpError) {
    return JMAPError.httpError(error.status, error.statusText);
  }
  if (error instanceof JmapRequestError) {
    return JMAPError.httpError(error.status, error.detail ?? error.type);
  }
  if (error instanceof JmapInvalidResponseError) {
    return new JMAPError(
      error.message,
      'invalidResponse',
      'The server did not answer valid JMAP. Verify JMAP_SESSION_URL points to a JMAP server.'
    );
  }
  return error;
}

/**
 * The text a tool shows after "Error …: ". A method error shows its description (or its type), as
 * the server sent it; the other errors their message.
 */
export function errorText(error: unknown): string {
  if (error instanceof JmapMethodError) {
    return error.description || error.type;
  }
  const mapped = toJMAPError(error);
  return mapped instanceof Error ? mapped.message : String(mapped);
}
