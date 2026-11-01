/**
 * MCP server for JMAP mail operations.
 * Uses stdio transport for AI assistant communication.
 */
import { VERSION } from '../version.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type Config } from '../config/schema.js';
import { createLogger, type Logger } from '../config/logger.js';
import { JMAPClient } from '../jmap/client.js';
import { formatStartupError } from '../errors.js';
import { registerAllTools } from './tools/index.js';
import { setApprover } from './approval.js';
import { loadSignature, type SignatureContent } from '../signature/index.js';

/** Server version (matches package.json) */
const SERVER_VERSION = VERSION;

/** Server name for MCP identification */
const SERVER_NAME = 'mcp-twake-mail';

/**
 * Create MCP server instance with JMAP client.
 * @param config Validated configuration
 * @param logger Pino logger (stderr only)
 * @returns Object with server, jmapClient, and signatureContent
 */
export async function createMCPServer(
  config: Config,
  logger: Logger
): Promise<{ server: McpServer; jmapClient: JMAPClient; signatureContent?: SignatureContent }> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const jmapClient = new JMAPClient(config, logger);

  // Load signature if configured
  const signatureContent = await loadSignature(config.JMAP_SIGNATURE_PATH, logger);

  return { server, jmapClient, signatureContent };
}

/**
 * Start the MCP server with JMAP validation.
 * Validates JMAP connection before accepting MCP requests.
 * Exits with code 1 on startup failure.
 */
export async function startServer(): Promise<void> {
  let sessionUrl: string | undefined;
  let logger: Logger | undefined;

  try {
    // Step 1: Load and validate configuration
    const config = loadConfig();
    sessionUrl = config.JMAP_SESSION_URL;

    // Step 2: Initialize logger (stderr only - stdout reserved for MCP)
    logger = createLogger(config.LOG_LEVEL);
    logger.info({ version: SERVER_VERSION }, 'Starting mcp-twake-mail server');

    // Step 3: Create MCP server and JMAP client
    const { server, jmapClient, signatureContent } = await createMCPServer(config, logger);

    // Step 4: Validate JMAP connection BEFORE accepting MCP requests
    const session = await jmapClient.fetchSession();
    logger.info({ accountId: session.accountId }, 'JMAP connection validated');

    // Step 5: Prior approval of every write (MCP elicitation), then register all MCP tools
    setApprover(server, {
      mode: config.JMAP_APPROVAL,
      language: (config.USER_LANGUAGE ?? '').toLowerCase().startsWith('fr') ? 'fr' : 'en',
      timeoutMs: config.JMAP_APPROVAL_TIMEOUT_MS,
      as: config.JMAP_DEFAULT_FROM ?? (session as { username?: string }).username,
      timeZone: config.USER_TIMEZONE,
      exempt: (config.JMAP_APPROVAL_EXEMPT ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    });
    registerAllTools(server, jmapClient, logger, {
      signatureContent,
      defaultFrom: config.JMAP_DEFAULT_FROM,
    });

    // Step 6: Connect MCP server via stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('MCP server running on stdio');
  } catch (error) {
    // Format error with AI-friendly message
    const errorMessage = formatStartupError(
      error instanceof Error ? error : new Error(String(error)),
      sessionUrl
    );

    // Log to stderr (NEVER stdout - reserved for MCP JSON-RPC)
    if (logger) {
      logger.fatal({ error }, 'Startup failed');
    }
    process.stderr.write(`\n${errorMessage}\n`);
    process.exit(1);
  }
}
