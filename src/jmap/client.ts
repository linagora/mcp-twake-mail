/**
 * Builds the jmap-client-ts client from the server configuration:
 * authentication modes, request timeouts, HTTP error messages and logs.
 */
import { CAPABILITIES, createClient } from 'jmap-client-ts';
import type { AuthOptions, FetchFunction, JmapClient } from 'jmap-client-ts';
import type { Config } from '../config/schema.js';
import type { Logger } from '../config/logger.js';
import { JMAPError } from '../errors.js';
import { createTokenRefresher } from '../auth/token-refresh.js';
import { CommandTokenProvider } from '../auth/token-command.js';

/** Session fetch timeout (quick check) */
const SESSION_TIMEOUT = 5000;

/**
 * Authorization header for the configured auth method.
 * For OIDC, automatically refreshes tokens if needed via TokenRefresher.
 */
function makeAuth(config: Config): AuthOptions {
  const commandTokens =
    config.JMAP_AUTH_METHOD === 'command' && config.JMAP_TOKEN_COMMAND
      ? new CommandTokenProvider(config.JMAP_TOKEN_COMMAND)
      : null;
  const tokenRefresher =
    config.JMAP_AUTH_METHOD === 'oidc' && config.JMAP_OIDC_ISSUER && config.JMAP_OIDC_CLIENT_ID
      ? createTokenRefresher(config.JMAP_OIDC_ISSUER, config.JMAP_OIDC_CLIENT_ID)
      : null;

  return {
    getAuthorizationHeader: async () => {
      if (config.JMAP_AUTH_METHOD === 'basic') {
        const credentials = `${config.JMAP_USERNAME}:${config.JMAP_PASSWORD}`;
        return `Basic ${Buffer.from(credentials).toString('base64')}`;
      }
      if (config.JMAP_AUTH_METHOD === 'command') {
        if (!commandTokens) {
          throw new JMAPError(
            'Command auth configuration incomplete',
            'commandConfigError',
            'Ensure JMAP_TOKEN_COMMAND is configured.'
          );
        }
        return `Bearer ${await commandTokens.getToken()}`;
      }
      if (config.JMAP_AUTH_METHOD === 'oidc') {
        if (!tokenRefresher) {
          throw new JMAPError(
            'OIDC configuration incomplete',
            'oidcConfigError',
            'Ensure OIDC_ISSUER and OIDC_CLIENT_ID are configured.'
          );
        }
        const tokens = await tokenRefresher.ensureValidToken();
        return `Bearer ${tokens.accessToken}`;
      }
      return `Bearer ${config.JMAP_TOKEN}`;
    },
    // shortcut: no credential renewal, so a 401 is final; renew here and resolve true to retry.
    onUnauthorized: () => {
      throw JMAPError.httpError(401, 'Unauthorized');
    },
  };
}

function logRequest(logger: Logger, url: string, init: RequestInit): void {
  if (!logger.isLevelEnabled('debug')) {
    return;
  }
  if (init.method === 'POST') {
    const { methodCalls } = JSON.parse(String(init.body)) as { methodCalls: [string][] };
    logger.debug(
      { methodCount: methodCalls.length, methods: methodCalls.map(([method]) => method) },
      'Sending JMAP request'
    );
  } else {
    logger.debug({ url }, 'Downloading blob');
  }
}

/** `fetch` with the configured timeouts, failing with the messages tools return. */
function makeFetch(config: Config, logger: Logger): FetchFunction {
  return async (url, init = {}) => {
    const isSession = url === config.JMAP_SESSION_URL && init.method !== 'POST';
    const timeout = AbortSignal.timeout(isSession ? SESSION_TIMEOUT : config.JMAP_REQUEST_TIMEOUT);
    if (!isSession) {
      logRequest(logger, url, init);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        const operation = isSession ? 'session fetch' : init.method === 'POST' ? 'JMAP request' : 'blob download';
        throw JMAPError.timeout(operation);
      }
      throw error;
    }

    // A 401 goes on to the library, which handles it through auth.onUnauthorized.
    if (!response.ok && response.status !== 401) {
      throw JMAPError.httpError(response.status, response.statusText);
    }
    return response;
  };
}

export function createJmapClient(config: Config, logger: Logger): JmapClient {
  const client = createClient({
    sessionUrl: config.JMAP_SESSION_URL,
    auth: makeAuth(config),
    fetch: makeFetch(config, logger),
  });
  client.onSessionChange((session) => {
    logger.warn({ newState: session.state }, 'Session state changed - session reloaded');
  });
  return client;
}

/**
 * Load the session and return the primary mail account.
 * @throws JMAPError if the session fetch fails or no mail account is found
 */
export async function loadAccountId(client: JmapClient, logger: Logger): Promise<string> {
  const session = await client.getSession();
  const accountId = session.primaryAccounts[CAPABILITIES.mail];
  if (!accountId) {
    throw JMAPError.methodError(
      'noMailAccount',
      'No mail account found in JMAP session. The server may not support JMAP Mail.'
    );
  }
  logger.info({ accountId, apiUrl: session.apiUrl }, 'JMAP session established');
  return accountId;
}
