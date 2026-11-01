/**
 * CLI entry point using Commander.js.
 * Routes between MCP server (default) and interactive commands.
 */
import { VERSION } from '../version.js';
import { Command } from 'commander';
import { startServer } from '../mcp/server.js';

// Read version from package.json at runtime to stay in sync

/**
 * Create and configure the CLI program.
 * @returns Configured Commander program
 */
export function createCLI(): Command {
  const program = new Command();

  program
    .name('mcp-twake-mail')
    .description('MCP server for JMAP mail operations via Twake Mail')
    .version(VERSION);

  // Default action: start MCP server (no subcommand)
  program
    .action(async () => {
      await startServer();
    });

  // Setup wizard command
  program
    .command('setup')
    .description('Interactive configuration wizard')
    .action(async () => {
      const { runSetup } = await import('./commands/setup.js');
      await runSetup();
    });

  program
    .command('auth')
    .description('Re-run OIDC authentication')
    .action(async () => {
      const { runAuth } = await import('./commands/auth.js');
      await runAuth();
    });

  program
    .command('check')
    .description('Verify configuration and test connection')
    .action(async () => {
      const { runCheck } = await import('./commands/check.js');
      await runCheck();
    });

  return program;
}

/**
 * Run the CLI program.
 * Uses parseAsync for proper async action handling.
 */
export async function runCLI(): Promise<void> {
  const program = createCLI();
  await program.parseAsync(process.argv);
}
