/**
 * Check command - verify configuration and test connection.
 * Helps users diagnose configuration issues.
 */
import { loadConfig } from '../../config/schema.js';
import { createLogger } from '../../config/logger.js';
import { createJmapClient, loadAccountId } from '../../jmap/client.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
}

/**
 * Format check result with status indicator.
 */
function formatResult(result: CheckResult): string {
  const icons = { ok: '[OK]', warning: '[WARN]', error: '[FAIL]' };
  return `${icons[result.status]} ${result.name}: ${result.message}`;
}

/**
 * Check environment configuration.
 */
function checkEnvironment(): CheckResult[] {
  const results: CheckResult[] = [];

  // Check JMAP URL
  const jmapUrl = process.env.JMAP_SESSION_URL;
  if (jmapUrl) {
    results.push({ name: 'JMAP URL', status: 'ok', message: jmapUrl });
  } else {
    results.push({ name: 'JMAP URL', status: 'error', message: 'JMAP_SESSION_URL not set' });
  }

  // Check auth method
  const authMethod = process.env.JMAP_AUTH_METHOD;
  if (authMethod) {
    results.push({ name: 'Auth Method', status: 'ok', message: authMethod });

    // Check auth-specific vars
    if (authMethod === 'basic') {
      const hasUser = !!process.env.JMAP_USERNAME;
      const hasPass = !!process.env.JMAP_PASSWORD;
      if (hasUser && hasPass) {
        results.push({ name: 'Basic Auth', status: 'ok', message: 'Credentials configured' });
      } else {
        results.push({
          name: 'Basic Auth',
          status: 'error',
          message: `Missing: ${!hasUser ? 'JMAP_USERNAME' : ''} ${!hasPass ? 'JMAP_PASSWORD' : ''}`.trim(),
        });
      }
    } else if (authMethod === 'bearer') {
      if (process.env.JMAP_BEARER_TOKEN) {
        results.push({ name: 'Bearer Token', status: 'ok', message: 'Token configured' });
      } else {
        results.push({ name: 'Bearer Token', status: 'error', message: 'JMAP_BEARER_TOKEN not set' });
      }
    } else if (authMethod === 'oidc') {
      const hasIssuer = !!process.env.JMAP_OIDC_ISSUER;
      const hasClient = !!process.env.JMAP_OIDC_CLIENT_ID;
      if (hasIssuer && hasClient) {
        results.push({ name: 'OIDC Config', status: 'ok', message: `Issuer: ${process.env.JMAP_OIDC_ISSUER}` });
      } else {
        results.push({
          name: 'OIDC Config',
          status: 'error',
          message: `Missing: ${!hasIssuer ? 'JMAP_OIDC_ISSUER' : ''} ${!hasClient ? 'JMAP_OIDC_CLIENT_ID' : ''}`.trim(),
        });
      }
    }
  } else {
    results.push({ name: 'Auth Method', status: 'error', message: 'JMAP_AUTH_METHOD not set' });
  }

  return results;
}

/**
 * Test JMAP connection.
 */
async function checkConnection(): Promise<CheckResult> {
  try {
    const config = loadConfig();
    const logger = createLogger('error');
    const accountId = await loadAccountId(createJmapClient(config, logger), logger);
    return {
      name: 'Connection',
      status: 'ok',
      message: `Connected (Account: ${accountId})`,
    };
  } catch (error) {
    return {
      name: 'Connection',
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run configuration and connection checks.
 */
export async function runCheck(): Promise<void> {
  console.log('\n=== MCP Twake Mail - Configuration Check ===\n');

  // Check environment variables
  console.log('Environment Configuration:');
  const envResults = checkEnvironment();
  for (const result of envResults) {
    console.log(`  ${formatResult(result)}`);
  }

  // Check for configuration errors
  const hasEnvError = envResults.some((r) => r.status === 'error');
  if (hasEnvError) {
    console.log('\nConfiguration incomplete. Run `mcp-twake-mail setup` to configure.\n');
    process.exit(1);
  }

  // Test connection
  console.log('\nConnection Test:');
  const connResult = await checkConnection();
  console.log(`  ${formatResult(connResult)}`);

  if (connResult.status === 'error') {
    console.log('\nConnection failed. Check your configuration and network.\n');
    process.exit(1);
  }

  console.log('\nAll checks passed! mcp-twake-mail is ready to use.\n');
}
