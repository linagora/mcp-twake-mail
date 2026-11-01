/**
 * Batch email operation MCP tools for managing multiple emails via JMAP.
 * Tools: batch_mark_read, batch_mark_unread, batch_move, batch_delete, batch_add_label, batch_remove_label.
 * These tools enable AI assistants to perform bulk email operations efficiently.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { JMAPClient } from '../../jmap/client.js';
import type { Logger } from '../../config/logger.js';
import type { EmailSetResponse } from '../../types/jmap.js';
import { approverFor } from '../approval.js';

/**
 * Result format for batch operations with per-email success/failure reporting.
 */
interface BatchOperationResult {
  success: boolean; // true if ALL succeeded
  total: number;
  succeeded: number;
  failed: number;
  results: {
    succeeded: string[];
    failed: Array<{ emailId: string; error: string }>;
  };
}

/**
 * Common annotations for non-destructive batch write operations.
 */
const BATCH_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Annotations for destructive batch operations (delete).
 */
const BATCH_DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false, // NOT idempotent - permanent delete cannot be undone
  openWorldHint: true,
};

/**
 * Build a BatchOperationResult from JMAP Email/set response.
 * @param emailIds Original array of email IDs in the request
 * @param updated Record of successfully updated email IDs
 * @param notUpdated Record of failed email IDs with error details
 */
function buildBatchResult(
  emailIds: string[],
  updated: Record<string, unknown> | undefined,
  notUpdated: Record<string, { type: string; description?: string }> | undefined
): BatchOperationResult {
  const succeededIds = Object.keys(updated || {});
  const failedEntries: Array<{ emailId: string; error: string }> = [];

  for (const [emailId, error] of Object.entries(notUpdated || {})) {
    failedEntries.push({
      emailId,
      error: `${error.type}${error.description ? `: ${error.description}` : ''}`,
    });
  }

  return {
    success: failedEntries.length === 0,
    total: emailIds.length,
    succeeded: succeededIds.length,
    failed: failedEntries.length,
    results: {
      succeeded: succeededIds,
      failed: failedEntries,
    },
  };
}

/**
 * Build a BatchOperationResult from JMAP Email/set destroy response.
 * @param emailIds Original array of email IDs in the request
 * @param destroyed Array of successfully destroyed email IDs
 * @param notDestroyed Record of failed email IDs with error details
 */
function buildBatchDestroyResult(
  emailIds: string[],
  destroyed: string[] | undefined,
  notDestroyed: Record<string, { type: string; description?: string }> | undefined
): BatchOperationResult {
  const succeededIds = destroyed || [];
  const failedEntries: Array<{ emailId: string; error: string }> = [];

  for (const [emailId, error] of Object.entries(notDestroyed || {})) {
    failedEntries.push({
      emailId,
      error: `${error.type}${error.description ? `: ${error.description}` : ''}`,
    });
  }

  return {
    success: failedEntries.length === 0,
    total: emailIds.length,
    succeeded: succeededIds.length,
    failed: failedEntries.length,
    results: {
      succeeded: succeededIds,
      failed: failedEntries,
    },
  };
}

/**
 * Register batch email operation MCP tools with the server.
 * @param server MCP server instance
 * @param jmapClient JMAP client for API calls
 * @param logger Pino logger
 */
export function registerBatchOperationTools(
  server: McpServer,
  jmapClient: JMAPClient,
  logger: Logger
): void {
  // batch_mark_read - set $seen keyword on multiple emails
  server.registerTool(
    'batch_mark_read',
    {
      title: 'Batch Mark Emails as Read',
      description: 'Mark multiple emails as read in a single operation.',
      inputSchema: {
        emailIds: z
          .array(z.string())
          .min(1, 'At least one email ID required')
          .max(50, 'Maximum 50 emails per batch operation')
          .describe('Array of email IDs to mark as read (max 50)'),
      },
      annotations: BATCH_WRITE_ANNOTATIONS,
    },
    async ({ emailIds }) => {
      logger.debug({ emailIds, count: emailIds.length }, 'batch_mark_read called');
      const refused = await approverFor(server).gate('batch_mark_read', async () => ({ action: 'batch_mark_read', details: [['emails', await approverFor(server).emails(jmapClient, emailIds)]] }));
      if (refused) return refused;

      try {
        const session = jmapClient.getSession();

        // Build update map for all emails
        const updateMap: Record<string, Record<string, unknown>> = {};
        for (const emailId of emailIds) {
          updateMap[emailId] = { 'keywords/$seen': true };
        }

        const response = await jmapClient.request([
          [
            'Email/set',
            {
              accountId: session.accountId,
              update: updateMap,
            },
            'batchMarkRead',
          ],
        ]);

        const result = jmapClient.parseMethodResponse(response.methodResponses[0]);
        if (!result.success) {
          logger.error({ error: result.error, emailIds }, 'JMAP error in batch_mark_read');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to batch mark emails as read: ${result.error?.description || result.error?.type || 'Unknown error'}`,
              },
            ],
          };
        }

        const setResponse = result.data as unknown as EmailSetResponse;
        const batchResult = buildBatchResult(emailIds, setResponse.updated, setResponse.notUpdated);

        logger.debug(
          { succeeded: batchResult.succeeded, failed: batchResult.failed },
          'batch_mark_read complete'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(batchResult),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailIds }, 'Exception in batch_mark_read');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error batch marking emails as read: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // batch_mark_unread - remove $seen keyword from multiple emails
  server.registerTool(
    'batch_mark_unread',
    {
      title: 'Batch Mark Emails as Unread',
      description: 'Mark multiple emails as unread in a single operation.',
      inputSchema: {
        emailIds: z
          .array(z.string())
          .min(1, 'At least one email ID required')
          .max(50, 'Maximum 50 emails per batch operation')
          .describe('Array of email IDs to mark as unread (max 50)'),
      },
      annotations: BATCH_WRITE_ANNOTATIONS,
    },
    async ({ emailIds }) => {
      logger.debug({ emailIds, count: emailIds.length }, 'batch_mark_unread called');
      const refused = await approverFor(server).gate('batch_mark_unread', async () => ({ action: 'batch_mark_unread', details: [['emails', await approverFor(server).emails(jmapClient, emailIds)]] }));
      if (refused) return refused;

      try {
        const session = jmapClient.getSession();

        // Build update map for all emails
        const updateMap: Record<string, Record<string, unknown>> = {};
        for (const emailId of emailIds) {
          updateMap[emailId] = { 'keywords/$seen': null };
        }

        const response = await jmapClient.request([
          [
            'Email/set',
            {
              accountId: session.accountId,
              update: updateMap,
            },
            'batchMarkUnread',
          ],
        ]);

        const result = jmapClient.parseMethodResponse(response.methodResponses[0]);
        if (!result.success) {
          logger.error({ error: result.error, emailIds }, 'JMAP error in batch_mark_unread');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to batch mark emails as unread: ${result.error?.description || result.error?.type || 'Unknown error'}`,
              },
            ],
          };
        }

        const setResponse = result.data as unknown as EmailSetResponse;
        const batchResult = buildBatchResult(emailIds, setResponse.updated, setResponse.notUpdated);

        logger.debug(
          { succeeded: batchResult.succeeded, failed: batchResult.failed },
          'batch_mark_unread complete'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(batchResult),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailIds }, 'Exception in batch_mark_unread');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error batch marking emails as unread: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // batch_move - move multiple emails to a different mailbox
  server.registerTool(
    'batch_move',
    {
      title: 'Batch Move Emails',
      description:
        'Move multiple emails to a different mailbox in a single operation. This replaces all current mailbox associations for each email.',
      inputSchema: {
        emailIds: z
          .array(z.string())
          .min(1, 'At least one email ID required')
          .max(50, 'Maximum 50 emails per batch operation')
          .describe('Array of email IDs to move (max 50)'),
        targetMailboxId: z.string().describe('The ID of the mailbox to move the emails to'),
      },
      annotations: BATCH_WRITE_ANNOTATIONS,
    },
    async ({ emailIds, targetMailboxId }) => {
      logger.debug(
        { emailIds, count: emailIds.length, targetMailboxId },
        'batch_move called'
      );
      const refused = await approverFor(server).gate('batch_move', async () => ({ action: 'batch_move', details: [['emails', await approverFor(server).emails(jmapClient, emailIds)], ['destination', await approverFor(server).mailbox(jmapClient, targetMailboxId)]] }));
      if (refused) return refused;

      try {
        const session = jmapClient.getSession();

        // Build update map for all emails
        const updateMap: Record<string, Record<string, unknown>> = {};
        for (const emailId of emailIds) {
          updateMap[emailId] = { mailboxIds: { [targetMailboxId]: true } };
        }

        const response = await jmapClient.request([
          [
            'Email/set',
            {
              accountId: session.accountId,
              update: updateMap,
            },
            'batchMove',
          ],
        ]);

        const result = jmapClient.parseMethodResponse(response.methodResponses[0]);
        if (!result.success) {
          logger.error({ error: result.error, emailIds }, 'JMAP error in batch_move');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to batch move emails: ${result.error?.description || result.error?.type || 'Unknown error'}`,
              },
            ],
          };
        }

        const setResponse = result.data as unknown as EmailSetResponse;
        const batchResult = buildBatchResult(emailIds, setResponse.updated, setResponse.notUpdated);

        logger.debug(
          { succeeded: batchResult.succeeded, failed: batchResult.failed, targetMailboxId },
          'batch_move complete'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...batchResult, targetMailboxId }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailIds }, 'Exception in batch_move');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error batch moving emails: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // batch_delete - permanently destroy or move to Trash multiple emails
  server.registerTool(
    'batch_delete',
    {
      title: 'Batch Delete Emails',
      description:
        'Delete multiple emails in a single operation. By default moves to Trash. Use permanent=true to permanently destroy.',
      inputSchema: {
        emailIds: z
          .array(z.string())
          .min(1, 'At least one email ID required')
          .max(50, 'Maximum 50 emails per batch operation')
          .describe('Array of email IDs to delete (max 50)'),
        permanent: z
          .boolean()
          .default(false)
          .describe('If true, permanently destroy the emails. Default: false (move to Trash)'),
      },
      annotations: BATCH_DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ emailIds, permanent }) => {
      logger.debug(
        { emailIds, count: emailIds.length, permanent },
        'batch_delete called'
      );
      const refused = await approverFor(server).gate('batch_delete', async () => ({ action: permanent ? 'batch_delete_permanently' : 'batch_delete', details: [['emails', await approverFor(server).emails(jmapClient, emailIds)]] }));
      if (refused) return refused;

      try {
        const session = jmapClient.getSession();

        if (permanent) {
          // Permanent delete using destroy
          const response = await jmapClient.request([
            [
              'Email/set',
              {
                accountId: session.accountId,
                destroy: emailIds,
              },
              'batchDestroy',
            ],
          ]);

          const result = jmapClient.parseMethodResponse(response.methodResponses[0]);
          if (!result.success) {
            logger.error({ error: result.error, emailIds }, 'JMAP error in batch_delete (permanent)');
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to batch delete emails: ${result.error?.description || result.error?.type || 'Unknown error'}`,
                },
              ],
            };
          }

          const setResponse = result.data as unknown as EmailSetResponse & {
            destroyed?: string[];
            notDestroyed?: Record<string, { type: string; description?: string }>;
          };
          const batchResult = buildBatchDestroyResult(
            emailIds,
            setResponse.destroyed,
            setResponse.notDestroyed
          );

          logger.debug(
            { succeeded: batchResult.succeeded, failed: batchResult.failed },
            'batch_delete (permanent) complete'
          );

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ ...batchResult, action: 'permanently_deleted' }),
              },
            ],
          };
        } else {
          // Move to Trash - query Trash mailbox ONCE
          const mailboxResponse = await jmapClient.request([
            [
              'Mailbox/query',
              {
                accountId: session.accountId,
                filter: { role: 'trash' },
              },
              'findTrash',
            ],
          ]);

          const queryResult = jmapClient.parseMethodResponse(mailboxResponse.methodResponses[0]);
          if (!queryResult.success) {
            logger.error({ error: queryResult.error }, 'JMAP error finding Trash mailbox');
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: 'Failed to find Trash mailbox',
                },
              ],
            };
          }

          const trashIds = (queryResult.data as { ids: string[] }).ids;
          if (!trashIds || trashIds.length === 0) {
            // No Trash mailbox found - fall back to permanent delete
            logger.warn({ emailIds }, 'No Trash mailbox found, performing permanent delete');

            const destroyResponse = await jmapClient.request([
              [
                'Email/set',
                {
                  accountId: session.accountId,
                  destroy: emailIds,
                },
                'batchDestroyFallback',
              ],
            ]);

            const destroyResult = jmapClient.parseMethodResponse(destroyResponse.methodResponses[0]);
            if (!destroyResult.success) {
              logger.error(
                { error: destroyResult.error, emailIds },
                'JMAP error in batch_delete (fallback)'
              );
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to batch delete emails: ${destroyResult.error?.description || destroyResult.error?.type || 'Unknown error'}`,
                  },
                ],
              };
            }

            const destroySetResponse = destroyResult.data as unknown as EmailSetResponse & {
              destroyed?: string[];
              notDestroyed?: Record<string, { type: string; description?: string }>;
            };
            const batchResult = buildBatchDestroyResult(
              emailIds,
              destroySetResponse.destroyed,
              destroySetResponse.notDestroyed
            );

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ ...batchResult, action: 'permanently_deleted' }),
                },
              ],
            };
          }

          const trashMailboxId = trashIds[0];

          // Build update map to move all emails to Trash
          const updateMap: Record<string, Record<string, unknown>> = {};
          for (const emailId of emailIds) {
            updateMap[emailId] = { mailboxIds: { [trashMailboxId]: true } };
          }

          const moveResponse = await jmapClient.request([
            [
              'Email/set',
              {
                accountId: session.accountId,
                update: updateMap,
              },
              'batchMoveToTrash',
            ],
          ]);

          const moveResult = jmapClient.parseMethodResponse(moveResponse.methodResponses[0]);
          if (!moveResult.success) {
            logger.error({ error: moveResult.error, emailIds }, 'JMAP error in batch_delete (move)');
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to batch move emails to Trash: ${moveResult.error?.description || moveResult.error?.type || 'Unknown error'}`,
                },
              ],
            };
          }

          const setResponse = moveResult.data as unknown as EmailSetResponse;
          const batchResult = buildBatchResult(emailIds, setResponse.updated, setResponse.notUpdated);

          logger.debug(
            { succeeded: batchResult.succeeded, failed: batchResult.failed, trashMailboxId },
            'batch_delete (move to Trash) complete'
          );

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ ...batchResult, action: 'moved_to_trash' }),
              },
            ],
          };
        }
      } catch (error) {
        logger.error({ error, emailIds }, 'Exception in batch_delete');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error batch deleting emails: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // batch_add_label - add a mailbox to multiple emails without removing existing ones
  server.registerTool(
    'batch_add_label',
    {
      title: 'Batch Add Label to Emails',
      description:
        'Add a label (mailbox) to multiple emails without removing existing labels.',
      inputSchema: {
        emailIds: z
          .array(z.string())
          .min(1, 'At least one email ID required')
          .max(50, 'Maximum 50 emails per batch operation')
          .describe('Array of email IDs to add the label to (max 50)'),
        mailboxId: z.string().describe('The ID of the mailbox (label) to add'),
      },
      annotations: BATCH_WRITE_ANNOTATIONS,
    },
    async ({ emailIds, mailboxId }) => {
      logger.debug(
        { emailIds, count: emailIds.length, mailboxId },
        'batch_add_label called'
      );
      const refused = await approverFor(server).gate('batch_add_label', async () => ({ action: 'batch_add_label', details: [['emails', await approverFor(server).emails(jmapClient, emailIds)], ['label', await approverFor(server).mailbox(jmapClient, mailboxId)]] }));
      if (refused) return refused;

      try {
        const session = jmapClient.getSession();

        // Build update map using path syntax to add label without removing others
        const updateMap: Record<string, Record<string, unknown>> = {};
        for (const emailId of emailIds) {
          updateMap[emailId] = { [`mailboxIds/${mailboxId}`]: true };
        }

        const response = await jmapClient.request([
          [
            'Email/set',
            {
              accountId: session.accountId,
              update: updateMap,
            },
            'batchAddLabel',
          ],
        ]);

        const result = jmapClient.parseMethodResponse(response.methodResponses[0]);
        if (!result.success) {
          logger.error({ error: result.error, emailIds }, 'JMAP error in batch_add_label');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to batch add label: ${result.error?.description || result.error?.type || 'Unknown error'}`,
              },
            ],
          };
        }

        const setResponse = result.data as unknown as EmailSetResponse;
        const batchResult = buildBatchResult(emailIds, setResponse.updated, setResponse.notUpdated);

        logger.debug(
          { succeeded: batchResult.succeeded, failed: batchResult.failed, mailboxId },
          'batch_add_label complete'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...batchResult, mailboxId }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailIds }, 'Exception in batch_add_label');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error batch adding label: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // batch_remove_label - remove a mailbox from multiple emails
  server.registerTool(
    'batch_remove_label',
    {
      title: 'Batch Remove Label from Emails',
      description:
        'Remove a label (mailbox) from multiple emails. Emails must belong to at least one mailbox.',
      inputSchema: {
        emailIds: z
          .array(z.string())
          .min(1, 'At least one email ID required')
          .max(50, 'Maximum 50 emails per batch operation')
          .describe('Array of email IDs to remove the label from (max 50)'),
        mailboxId: z.string().describe('The ID of the mailbox (label) to remove'),
      },
      annotations: BATCH_WRITE_ANNOTATIONS,
    },
    async ({ emailIds, mailboxId }) => {
      logger.debug(
        { emailIds, count: emailIds.length, mailboxId },
        'batch_remove_label called'
      );
      const refused = await approverFor(server).gate('batch_remove_label', async () => ({ action: 'batch_remove_label', details: [['emails', await approverFor(server).emails(jmapClient, emailIds)], ['label', await approverFor(server).mailbox(jmapClient, mailboxId)]] }));
      if (refused) return refused;

      try {
        const session = jmapClient.getSession();

        // Build update map using path syntax to remove label
        const updateMap: Record<string, Record<string, unknown>> = {};
        for (const emailId of emailIds) {
          updateMap[emailId] = { [`mailboxIds/${mailboxId}`]: null };
        }

        const response = await jmapClient.request([
          [
            'Email/set',
            {
              accountId: session.accountId,
              update: updateMap,
            },
            'batchRemoveLabel',
          ],
        ]);

        const result = jmapClient.parseMethodResponse(response.methodResponses[0]);
        if (!result.success) {
          logger.error({ error: result.error, emailIds }, 'JMAP error in batch_remove_label');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to batch remove label: ${result.error?.description || result.error?.type || 'Unknown error'}`,
              },
            ],
          };
        }

        const setResponse = result.data as unknown as EmailSetResponse;
        const batchResult = buildBatchResult(emailIds, setResponse.updated, setResponse.notUpdated);

        logger.debug(
          { succeeded: batchResult.succeeded, failed: batchResult.failed, mailboxId },
          'batch_remove_label complete'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...batchResult, mailboxId }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailIds }, 'Exception in batch_remove_label');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error batch removing label: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  logger.debug(
    'Batch operation tools registered: batch_mark_read, batch_mark_unread, batch_move, batch_delete, batch_add_label, batch_remove_label'
  );
}
