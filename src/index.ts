#!/usr/bin/env node
/**
 * Entry point for mcp-twake-mail.
 * Routes to CLI commands or MCP server based on arguments.
 */
import { fileURLToPath } from 'node:url';
import { runCLI } from './cli/index.js';
import { isCliCommand, runCliCommand } from './cli-call/index.js';

const args = process.argv.slice(2);
if (isCliCommand(args)) {
  // `call`, `tools` and `allow-unattended`: the server's tools from the command line.
  // exitCode, not exit(): what was written on a piped stdout is flushed first
  process.exitCode = await runCliCommand(args, { entry: fileURLToPath(import.meta.url) });
} else {
  runCLI().catch((error) => {
    // Log to stderr (NEVER stdout - may be reserved for MCP JSON-RPC)
    process.stderr.write(`Fatal error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
