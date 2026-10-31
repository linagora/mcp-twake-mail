/**
 * Tool registration aggregator.
 * Centralizes all MCP tool registrations.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JmapClient } from 'jmap-client-ts';
import type { Logger } from '../../config/logger.js';
import type { SignatureContent } from '../../signature/index.js';
import { registerEmailTools } from './email.js';
import { registerMailboxTools } from './mailbox.js';
import { registerEmailOperationTools } from './email-operations.js';
import { registerEmailSendingTools } from './email-sending.js';
import { registerAttachmentTools } from './attachment.js';
import { registerThreadTools } from './thread.js';
import { registerBatchOperationTools } from './batch-operations.js';

/**
 * Options for email sending tools.
 */
export interface EmailSendingOptions {
  signatureContent?: SignatureContent;
  defaultFrom?: string;
}

/**
 * Register all MCP tools with the server.
 * @param server MCP server instance
 * @param jmapClient JMAP client for API calls
 * @param logger Pino logger
 * @param emailSendingOptions Optional signature and defaultFrom for email sending
 */
export function registerAllTools(
  server: McpServer,
  jmapClient: JmapClient,
  logger: Logger,
  emailSendingOptions?: EmailSendingOptions
): void {
  logger.debug('Registering MCP tools...');

  // Register email tools (get_email, search_emails, get_email_labels)
  registerEmailTools(server, jmapClient, logger);

  // Register mailbox tools (get_mailbox, list_mailboxes)
  registerMailboxTools(server, jmapClient, logger);

  // Register email operation tools (mark_as_read, mark_as_unread, delete_email)
  registerEmailOperationTools(server, jmapClient, logger, emailSendingOptions?.signatureContent);

  // Register email sending tools (send_email, reply_email) with signature and defaultFrom
  registerEmailSendingTools(server, jmapClient, logger, emailSendingOptions);

  // Register attachment tools (get_attachments)
  registerAttachmentTools(server, jmapClient, logger);

  // Register thread tools (get_thread, get_thread_emails)
  registerThreadTools(server, jmapClient, logger);

  // Register batch operation tools (batch_mark_read, batch_mark_unread, batch_move, batch_delete, batch_add_label, batch_remove_label)
  registerBatchOperationTools(server, jmapClient, logger);

  logger.info('All MCP tools registered');
}
