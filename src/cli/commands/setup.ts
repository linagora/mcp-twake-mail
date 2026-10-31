/**
 * Setup wizard command - interactive configuration for mcp-twake-mail.
 * Generates Claude Desktop config JSON.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

import {
  promptJmapUrl,
  promptAuthMethod,
  promptBasicAuth,
  promptBearerToken,
  promptOidcAuth,
  promptWriteConfig,
  promptServerName,
  promptSetupMode,
  promptEmail,
  promptConfirmDiscovery,
  promptDefaultFrom,
  promptSignaturePath,
} from '../prompts/setup-wizard.js';

/**
 * Get Claude Desktop config file path based on platform.
 */
function getClaudeConfigPath(): string {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  // Linux fallback (unofficial)
  return join(home, '.config', 'claude', 'claude_desktop_config.json');
}

/**
 * Generate Claude Desktop config for this MCP server.
 */
function generateClaudeConfig(
  serverName: string,
  env: Record<string, string>
): { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } {
  return {
    mcpServers: {
      [serverName]: {
        command: 'npx',
        args: ['-y', 'mcp-twake-mail'],
        env,
      },
    },
  };
}

/**
 * Test JMAP connection with provided config.
 * Returns true if connection successful, false otherwise.
 */
async function testConnection(env: Record<string, string>): Promise<{ success: boolean; error?: string }> {
  // Dynamically import to avoid loading JMAP client in CLI context unnecessarily
  try {
    const { createJmapClient, loadAccountId } = await import('../../jmap/client.js');
    const { createLogger } = await import('../../config/logger.js');

    // Build minimal config object for the JMAP client
    const config = {
      JMAP_SESSION_URL: env.JMAP_SESSION_URL,
      JMAP_AUTH_METHOD: env.JMAP_AUTH_METHOD as 'basic' | 'bearer' | 'oidc',
      JMAP_USERNAME: env.JMAP_USERNAME,
      JMAP_PASSWORD: env.JMAP_PASSWORD,
      JMAP_TOKEN: env.JMAP_BEARER_TOKEN,
      JMAP_OIDC_ISSUER: env.JMAP_OIDC_ISSUER,
      JMAP_OIDC_CLIENT_ID: env.JMAP_OIDC_CLIENT_ID,
      JMAP_OIDC_SCOPE: env.JMAP_OIDC_SCOPE || 'openid profile email offline_access',
      JMAP_OIDC_REDIRECT_URI: env.JMAP_OIDC_REDIRECT_URI || 'http://localhost:3000/callback',
      JMAP_REQUEST_TIMEOUT: 30000,
      LOG_LEVEL: 'error' as const,
      JMAP_APPROVAL: 'elicit' as const,
      JMAP_APPROVAL_TIMEOUT_MS: 600000,
    };

    const logger = createLogger('error');
    const client = createJmapClient(config, logger);

    // For OIDC, we need to run the auth flow first
    if (config.JMAP_AUTH_METHOD === 'oidc') {
      const { performOIDCFlow } = await import('../../auth/oidc-flow.js');
      console.log('\nOpening browser for authentication...');
      await performOIDCFlow({
        issuerUrl: config.JMAP_OIDC_ISSUER!,
        clientId: config.JMAP_OIDC_CLIENT_ID!,
        scope: config.JMAP_OIDC_SCOPE,
        redirectUri: config.JMAP_OIDC_REDIRECT_URI,
      });
      console.log('Authentication successful!\n');
    }

    const accountId = await loadAccountId(client, logger);
    console.log(`Connected! Account ID: ${accountId}`);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run the interactive setup wizard.
 */
export async function runSetup(): Promise<void> {
  console.log('\n=== MCP Twake Mail Setup Wizard ===\n');

  // Step 1: Choose setup mode
  const mode = await promptSetupMode();

  let jmapUrl: string;
  const discoveredOidc: { issuer?: string } = {};

  if (mode === 'auto') {
    // Auto-discovery flow
    const email = await promptEmail();
    console.log('\nDiscovering settings...');

    try {
      // Dynamic import to avoid loading discovery in non-auto mode
      const { discoverFromEmail } = await import('../../discovery/index.js');
      const result = await discoverFromEmail(email);

      const confirmed = await promptConfirmDiscovery({
        jmapUrl: result.jmap.sessionUrl,
        oidcIssuer: result.oidc?.issuer,
      });

      jmapUrl = confirmed.jmapUrl;
      if (confirmed.oidcIssuer) {
        discoveredOidc.issuer = confirmed.oidcIssuer;
      }

      console.log(`\nUsing discovered settings for ${result.domain}\n`);
    } catch (error) {
      console.error(`\nAuto-discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      console.log('Falling back to manual configuration...\n');

      // Fall back to manual mode
      jmapUrl = await promptJmapUrl();
    }
  } else {
    // Manual mode - existing flow
    jmapUrl = await promptJmapUrl();
  }

  // Step 2: Auth method
  const authMethod = await promptAuthMethod();

  // Step 3: Auth-specific prompts
  const env: Record<string, string> = {
    JMAP_SESSION_URL: jmapUrl,
    JMAP_AUTH_METHOD: authMethod,
  };

  if (authMethod === 'basic') {
    const { username, password } = await promptBasicAuth();
    env.JMAP_USERNAME = username;
    env.JMAP_PASSWORD = password;
  } else if (authMethod === 'bearer') {
    env.JMAP_BEARER_TOKEN = await promptBearerToken();
  } else if (authMethod === 'oidc') {
    // Pre-fill discovered OIDC issuer if available
    const oidcConfig = await promptOidcAuth(discoveredOidc.issuer);
    env.JMAP_OIDC_ISSUER = oidcConfig.issuer;
    env.JMAP_OIDC_CLIENT_ID = oidcConfig.clientId;
    env.JMAP_OIDC_SCOPE = oidcConfig.scope;
    env.JMAP_OIDC_REDIRECT_URI = oidcConfig.redirectUri;
  }

  // Step 4: Identity configuration (optional)
  console.log('\n--- Identity Configuration ---');
  const defaultFrom = await promptDefaultFrom();
  if (defaultFrom) {
    env.JMAP_DEFAULT_FROM = defaultFrom;
  }

  const signaturePath = await promptSignaturePath();
  if (signaturePath) {
    env.JMAP_SIGNATURE_PATH = signaturePath;
  }

  // Step 5: Test connection
  console.log('\nTesting connection...');
  const testResult = await testConnection(env);

  if (!testResult.success) {
    console.error(`\nConnection failed: ${testResult.error}`);
    console.error('Please check your configuration and try again.\n');
    process.exit(1);
  }

  console.log('\nConnection successful!\n');

  // Step 6: Server name for Claude config
  const serverName = await promptServerName();

  // Step 7: Generate config
  const config = generateClaudeConfig(serverName, env);
  const configJson = JSON.stringify(config, null, 2);

  console.log('\n--- Generated Claude Desktop Config ---');
  console.log(configJson);
  console.log('---------------------------------------\n');

  // Step 8: Optionally write to Claude Desktop config
  const shouldWrite = await promptWriteConfig();

  if (shouldWrite) {
    const configPath = getClaudeConfigPath();
    console.log(`\nWriting to: ${configPath}`);

    try {
      // Read existing config if it exists
      let existingConfig: Record<string, unknown> = {};
      try {
        const existingContent = await readFile(configPath, 'utf-8');
        existingConfig = JSON.parse(existingContent);
      } catch {
        // File doesn't exist or is invalid, start fresh
      }

      // Merge mcpServers
      const mergedConfig = {
        ...existingConfig,
        mcpServers: {
          ...(existingConfig.mcpServers as Record<string, unknown> || {}),
          ...config.mcpServers,
        },
      };

      // Ensure directory exists
      await mkdir(join(configPath, '..'), { recursive: true });

      // Write merged config
      await writeFile(configPath, JSON.stringify(mergedConfig, null, 2), 'utf-8');
      console.log('Config written successfully!');
      console.log('\nRestart Claude Desktop to load the new configuration.\n');
    } catch (error) {
      console.error(`Failed to write config: ${error instanceof Error ? error.message : String(error)}`);
      console.error('\nYou can manually add the config above to your Claude Desktop configuration.\n');
      process.exit(1);
    }
  } else {
    console.log('\nTo use this configuration, add it to your Claude Desktop config file:');
    console.log(`  ${getClaudeConfigPath()}\n`);
  }
}
