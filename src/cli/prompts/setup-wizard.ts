/**
 * Interactive prompts for setup wizard.
 * Uses @inquirer/prompts for modern, TypeScript-first prompts.
 */
import { loopbackRedirectProblem } from '../../auth/redirect-uri.js';
import { input, select, password, confirm } from '@inquirer/prompts';
import { homedir } from 'node:os';
import { access, constants } from 'node:fs/promises';

/** Auth method choices for the wizard */
export type AuthMethod = 'oidc' | 'basic' | 'bearer';

/** Setup mode: auto-discover or manual configuration */
export type SetupMode = 'auto' | 'manual';

/**
 * Prompt for setup mode: auto-discover or manual configuration.
 */
export async function promptSetupMode(): Promise<SetupMode> {
  return select({
    message: 'Setup mode:',
    choices: [
      { value: 'auto' as const, name: 'Auto-discover from email address (recommended)' },
      { value: 'manual' as const, name: 'Manual configuration' },
    ],
  });
}

/**
 * Prompt for email address for auto-discovery.
 */
export async function promptEmail(): Promise<string> {
  return input({
    message: 'Email address:',
    validate: (value) => {
      // Basic email validation
      if (!value.includes('@') || !value.split('@')[1]?.includes('.')) {
        return 'Please enter a valid email address';
      }
      return true;
    },
  });
}

/**
 * Prompt to confirm or edit discovered settings.
 */
export async function promptConfirmDiscovery(settings: {
  jmapUrl: string;
  oidcIssuer?: string;
}): Promise<{ confirmed: boolean; jmapUrl: string; oidcIssuer?: string }> {
  console.log('\nDiscovered settings:');
  console.log(`  JMAP URL: ${settings.jmapUrl}`);
  if (settings.oidcIssuer) {
    console.log(`  OIDC Issuer: ${settings.oidcIssuer}`);
  } else {
    console.log('  OIDC Issuer: Not discovered (will need manual entry)');
  }
  console.log('');

  const useDiscovered = await confirm({
    message: 'Use these settings?',
    default: true,
  });

  if (useDiscovered) {
    return { confirmed: true, ...settings };
  }

  // Allow editing
  const jmapUrl = await input({
    message: 'JMAP Session URL:',
    default: settings.jmapUrl,
    validate: (value) => loopbackRedirectProblem(value) ?? true,
  });

  const oidcIssuer = settings.oidcIssuer
    ? await input({
        message: 'OIDC Issuer URL:',
        default: settings.oidcIssuer,
        validate: (value) => {
          if (!value) return true; // Optional
          try {
            new URL(value);
            return true;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      })
    : undefined;

  return { confirmed: true, jmapUrl, oidcIssuer };
}

/**
 * Prompt for JMAP session URL with validation.
 */
export async function promptJmapUrl(): Promise<string> {
  return input({
    message: 'JMAP Session URL:',
    default: 'https://jmap.linagora.com/jmap/session',
    validate: (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return 'Please enter a valid URL';
      }
    },
  });
}

/**
 * Prompt for authentication method selection.
 */
export async function promptAuthMethod(): Promise<AuthMethod> {
  return select({
    message: 'Authentication method:',
    choices: [
      { value: 'oidc' as const, name: 'OIDC (recommended for Twake Mail)' },
      { value: 'basic' as const, name: 'Basic Auth (username/password)' },
      { value: 'bearer' as const, name: 'Bearer Token' },
    ],
  });
}

/**
 * Prompt for Basic auth credentials.
 */
export async function promptBasicAuth(): Promise<{ username: string; password: string }> {
  const username = await input({
    message: 'Username (email):',
    validate: (value) => value.length > 0 || 'Username is required',
  });

  const pwd = await password({
    message: 'Password:',
    mask: '*',
  });

  return { username, password: pwd };
}

/**
 * Prompt for Bearer token.
 */
export async function promptBearerToken(): Promise<string> {
  return password({
    message: 'Bearer token:',
    mask: '*',
    validate: (value) => value.length > 0 || 'Token is required',
  });
}

/**
 * Prompt for OIDC configuration.
 */
export async function promptOidcAuth(defaultIssuer?: string): Promise<{
  issuer: string;
  clientId: string;
  scope: string;
  redirectUri: string;
}> {
  const issuer = await input({
    message: 'OIDC Issuer URL:',
    default: defaultIssuer || 'https://sso.linagora.com',
    validate: (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return 'Please enter a valid URL';
      }
    },
  });

  const clientId = await input({
    message: 'OAuth Client ID:',
    default: 'twake-mail',
    validate: (value) => value.length > 0 || 'Client ID is required',
  });

  const scope = await input({
    message: 'OAuth Scopes:',
    default: 'openid profile email offline_access',
  });

  const redirectUri = await input({
    message: 'OAuth Redirect URI (loopback with a port, registered with the OIDC provider):',
    default: 'http://localhost:3000/callback',
    validate: (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return 'Please enter a valid URL';
      }
    },
  });

  return { issuer, clientId, scope, redirectUri };
}

/**
 * Prompt to confirm writing config to file.
 */
export async function promptWriteConfig(): Promise<boolean> {
  return confirm({
    message: 'Write config to Claude Desktop config file?',
    default: true,
  });
}

/**
 * Prompt for custom server name in Claude config.
 */
export async function promptServerName(): Promise<string> {
  return input({
    message: 'Server name in Claude Desktop:',
    default: 'twake-mail',
    validate: (value) => /^[a-z0-9-]+$/.test(value) || 'Use lowercase letters, numbers, and hyphens only',
  });
}

/**
 * Prompt for default sender email address.
 * Returns undefined if user skips configuration.
 */
export async function promptDefaultFrom(): Promise<string | undefined> {
  const shouldConfigure = await confirm({
    message: 'Configure default sender email address?',
    default: true,
  });

  if (!shouldConfigure) return undefined;

  return input({
    message: 'Default "from" email address:',
    validate: (value) => {
      // Simple email regex - Zod will do full validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(value) || 'Please enter a valid email address';
    },
  });
}

/**
 * Prompt for signature file path.
 * Validates file exists and is readable.
 * Returns undefined if user skips configuration.
 */
export async function promptSignaturePath(): Promise<string | undefined> {
  const shouldConfigure = await confirm({
    message: 'Configure email signature file?',
    default: false,
  });

  if (!shouldConfigure) return undefined;

  return input({
    message: 'Path to signature file (Markdown format):',
    default: '~/.mcp-twake-mail/signature.md',
    validate: async (value) => {
      if (!value) return 'Signature path cannot be empty';

      // Expand ~ to home directory for validation
      const expandedPath = value.replace(/^~/, homedir());
      try {
        await access(expandedPath, constants.R_OK);
        return true;
      } catch {
        return `File not found or not readable: ${expandedPath}`;
      }
    },
  });
}
