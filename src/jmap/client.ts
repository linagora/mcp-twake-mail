/**
 * JMAP client with session management, authentication, and request handling.
 * Implements JMAP Core (RFC 8620) patterns.
 */
import type { Config } from '../config/schema.js';
import type { Logger } from '../config/logger.js';
import type {
  JMAPCapabilities,
  JMAPSessionResponse,
  JMAPMethodCall,
  JMAPMethodResponse,
  JMAPRequest,
  JMAPResponse,
  JMAPErrorResponse,
} from '../types/jmap.js';
import { JMAPError } from '../errors.js';
import { TokenRefresher, createTokenRefresher } from '../auth/token-refresh.js';
import { CommandTokenProvider } from '../auth/token-command.js';

/** Extracted session data from JMAP session response */
export interface JMAPSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  accountId: string;
  capabilities: JMAPCapabilities;
  state: string;
}

/** Default JMAP capabilities for mail operations */
const DEFAULT_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];

/** Session fetch timeout (quick check) */
const SESSION_TIMEOUT = 5000;

/**
 * JMAP client for interacting with JMAP mail servers.
 * Handles authentication, session management, and request batching.
 */
export class JMAPClient {
  private session: JMAPSession | null = null;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly stateTracker: Map<string, string> = new Map();
  private readonly tokenRefresher: TokenRefresher | null = null;
  private readonly commandTokens: CommandTokenProvider | null = null;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;

    // Initialize TokenRefresher for OIDC authentication
    if (config.JMAP_AUTH_METHOD === 'command' && config.JMAP_TOKEN_COMMAND) {
      this.commandTokens = new CommandTokenProvider(config.JMAP_TOKEN_COMMAND);
    }
    if (config.JMAP_AUTH_METHOD === 'oidc' && config.JMAP_OIDC_ISSUER && config.JMAP_OIDC_CLIENT_ID) {
      this.tokenRefresher = createTokenRefresher(config.JMAP_OIDC_ISSUER, config.JMAP_OIDC_CLIENT_ID);
    }
  }

  /**
   * Generate authentication headers based on configured auth method.
   * For OIDC, automatically refreshes tokens if needed via TokenRefresher.
   * @returns Headers object with Authorization and Content-Type
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.JMAP_AUTH_METHOD === 'basic') {
      const credentials = `${this.config.JMAP_USERNAME}:${this.config.JMAP_PASSWORD}`;
      const token = Buffer.from(credentials).toString('base64');
      headers['Authorization'] = `Basic ${token}`;
    } else if (this.config.JMAP_AUTH_METHOD === 'command') {
      if (!this.commandTokens) {
        throw new JMAPError(
          'Command auth configuration incomplete',
          'commandConfigError',
          'Ensure JMAP_TOKEN_COMMAND is configured.'
        );
      }
      headers['Authorization'] = 'Bearer ' + (await this.commandTokens.getToken());
    } else if (this.config.JMAP_AUTH_METHOD === 'oidc') {
      // OIDC: use TokenRefresher to get valid token (auto-refreshes if needed)
      if (!this.tokenRefresher) {
        throw new JMAPError(
          'OIDC configuration incomplete',
          'oidcConfigError',
          'Ensure OIDC_ISSUER and OIDC_CLIENT_ID are configured.'
        );
      }
      const tokens = await this.tokenRefresher.ensureValidToken();
      headers['Authorization'] = `Bearer ${tokens.accessToken}`;
    } else {
      // Bearer: use static token from config
      headers['Authorization'] = `Bearer ${this.config.JMAP_TOKEN}`;
    }

    return headers;
  }

  /**
   * Fetch JMAP session from the server.
   * Discovers apiUrl, accountId, and capabilities.
   * @returns JMAPSession with extracted session data
   * @throws JMAPError if session fetch fails or no mail account found
   */
  async fetchSession(): Promise<JMAPSession> {
    this.logger.info({ url: this.config.JMAP_SESSION_URL }, 'Fetching JMAP session...');

    let response: Response;
    try {
      response = await fetch(this.config.JMAP_SESSION_URL, {
        method: 'GET',
        headers: await this.getAuthHeaders(),
        signal: AbortSignal.timeout(SESSION_TIMEOUT),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw JMAPError.timeout('session fetch');
      }
      throw error;
    }

    if (!response.ok) {
      throw JMAPError.httpError(response.status, response.statusText);
    }

    const sessionData = (await response.json()) as JMAPSessionResponse;

    // Extract primary account for mail capability
    const accountId = sessionData.primaryAccounts['urn:ietf:params:jmap:mail'];
    if (!accountId) {
      throw JMAPError.methodError(
        'noMailAccount',
        'No mail account found in JMAP session. The server may not support JMAP Mail.'
      );
    }

    // Validate downloadUrl exists (required for blob downloads)
    if (!sessionData.downloadUrl) {
      this.logger.warn('No downloadUrl in JMAP session - attachment downloads will not work');
    }
    if (!sessionData.uploadUrl) {
      this.logger.warn('No uploadUrl in JMAP session - attachments cannot be added to drafts');
    }

    this.session = {
      apiUrl: sessionData.apiUrl,
      downloadUrl: sessionData.downloadUrl || '',
      uploadUrl: sessionData.uploadUrl || '',
      accountId,
      capabilities: sessionData.capabilities,
      state: sessionData.state,
    };

    this.logger.info(
      { accountId, apiUrl: sessionData.apiUrl },
      'JMAP session established'
    );

    return this.session;
  }

  /**
   * Get the current session.
   * @returns JMAPSession
   * @throws JMAPError if session not initialized
   */
  getSession(): JMAPSession {
    if (!this.session) {
      throw new JMAPError(
        'Session not initialized',
        'sessionNotInitialized',
        'Call fetchSession() before making requests.'
      );
    }
    return this.session;
  }

  /**
   * Make a batched JMAP request with multiple method calls.
   * @param methodCalls Array of method calls to execute
   * @param using Optional array of capability URIs (defaults to core + mail)
   * @returns JMAPResponse with method responses
   * @throws JMAPError on HTTP errors or timeouts
   */
  async request(
    methodCalls: JMAPMethodCall[],
    using: string[] = DEFAULT_USING
  ): Promise<JMAPResponse> {
    const session = this.getSession();

    const requestBody: JMAPRequest = {
      using,
      methodCalls,
    };

    this.logger.debug(
      { methodCount: methodCalls.length, methods: methodCalls.map((mc) => mc[0]) },
      'Sending JMAP request'
    );

    let response: Response;
    try {
      response = await fetch(session.apiUrl, {
        method: 'POST',
        headers: await this.getAuthHeaders(),
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.config.JMAP_REQUEST_TIMEOUT),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw JMAPError.timeout('JMAP request');
      }
      throw error;
    }

    if (!response.ok) {
      throw JMAPError.httpError(response.status, response.statusText);
    }

    const jmapResponse = (await response.json()) as JMAPResponse;

    // Check for session state changes
    if (jmapResponse.sessionState && jmapResponse.sessionState !== this.session?.state) {
      this.logger.warn(
        { oldState: this.session?.state, newState: jmapResponse.sessionState },
        'Session state changed - session refresh may be needed'
      );
    }

    // Update state tracking from method responses
    for (const methodResponse of jmapResponse.methodResponses) {
      this.extractAndUpdateState(methodResponse);
    }

    return jmapResponse;
  }

  /**
   * Parse a method response and extract success/error status.
   * @param response The method response tuple
   * @returns Object with success flag and data or error
   */
  parseMethodResponse(response: JMAPMethodResponse): {
    success: boolean;
    data?: Record<string, unknown>;
    error?: JMAPErrorResponse;
  } {
    const [methodName, responseData] = response;

    // Check if this is an error response
    if (methodName === 'error') {
      const errorResponse: JMAPErrorResponse = {
        type: (responseData.type as string) || 'unknownError',
        description: responseData.description as string | undefined,
      };

      this.logger.debug({ error: errorResponse }, 'JMAP method error');

      return {
        success: false,
        error: errorResponse,
      };
    }

    return {
      success: true,
      data: responseData,
    };
  }

  /**
   * Extract state from method response and update tracker.
   * @param response The method response tuple
   */
  private extractAndUpdateState(response: JMAPMethodResponse): void {
    const [methodName, responseData] = response;

    // Skip error responses
    if (methodName === 'error') {
      return;
    }

    // Extract object type from method name (e.g., 'Email/get' -> 'Email')
    const objectType = methodName.split('/')[0];

    // Check for state or newState in response
    const state = (responseData.newState as string) || (responseData.state as string);
    if (state && objectType) {
      this.updateState(objectType, state);
    }
  }

  /**
   * Update tracked state for an object type.
   * @param type Object type (e.g., 'Email', 'Mailbox')
   * @param state New state string
   */
  updateState(type: string, state: string): void {
    this.stateTracker.set(type, state);
    this.logger.debug({ type, state }, 'State updated');
  }

  /**
   * Get tracked state for an object type.
   * @param type Object type (e.g., 'Email', 'Mailbox')
   * @returns State string or undefined if not tracked
   */
  getState(type: string): string | undefined {
    return this.stateTracker.get(type);
  }

  /**
   * Clear tracked state.
   * @param type Optional object type to clear. If not provided, clears all state.
   */
  clearState(type?: string): void {
    if (type) {
      this.stateTracker.delete(type);
      this.logger.debug({ type }, 'State cleared');
    } else {
      this.stateTracker.clear();
      this.logger.debug('All state cleared');
    }
  }

  /**
   * Download a blob (attachment) from the JMAP server.
   * Uses the downloadUrl template from the session.
   * @param blobId The blob ID to download
   * @param name Optional filename for the download
   * @param type Optional MIME type
   * @returns ArrayBuffer containing the blob data
   * @throws JMAPError if download fails
   */
  async downloadBlob(blobId: string, name?: string, type?: string): Promise<ArrayBuffer> {
    const session = this.getSession();

    if (!session.downloadUrl) {
      throw new JMAPError(
        'Download URL not available',
        'downloadUrlMissing',
        'The JMAP server did not provide a download URL in the session.'
      );
    }

    // Build download URL from template
    // Template format: {downloadUrl}/{accountId}/{blobId}/{name}?type={type}
    const url = session.downloadUrl
      .replace('{accountId}', encodeURIComponent(session.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name || 'attachment'))
      .replace('{type}', encodeURIComponent(type || 'application/octet-stream'));

    this.logger.debug({ blobId, name, type, url }, 'Downloading blob');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: await this.getAuthHeaders(),
        signal: AbortSignal.timeout(this.config.JMAP_REQUEST_TIMEOUT),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw JMAPError.timeout('blob download');
      }
      throw error;
    }

    if (!response.ok) {
      throw JMAPError.httpError(response.status, response.statusText);
    }

    return response.arrayBuffer();
  }

  /**
   * Upload a blob (a file to attach) to the JMAP server (RFC 8620 §6.1).
   * @param data The file content
   * @param type Its MIME type
   * @returns The blob reference to put in an Email's attachments
   * @throws JMAPError if the server has no upload URL or refuses the upload
   */
  async uploadBlob(data: Uint8Array, type: string): Promise<{ blobId: string; type: string; size: number }> {
    const session = this.getSession();
    if (!session.uploadUrl) {
      throw new JMAPError(
        'Upload URL not available',
        'uploadUrlMissing',
        'The JMAP server did not provide an upload URL in the session: attachments cannot be added.'
      );
    }
    const url = session.uploadUrl.replace('{accountId}', encodeURIComponent(session.accountId));
    this.logger.debug({ type, size: data.byteLength }, 'Uploading blob');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { ...(await this.getAuthHeaders()), 'Content-Type': type },
        body: new Blob([data as Uint8Array<ArrayBuffer>]),
        signal: AbortSignal.timeout(this.config.JMAP_REQUEST_TIMEOUT),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw JMAPError.timeout('blob upload');
      }
      throw error;
    }

    if (!response.ok) {
      throw JMAPError.httpError(response.status, response.statusText);
    }

    return (await response.json()) as { blobId: string; type: string; size: number };
  }
}
