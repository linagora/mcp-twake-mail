/**
 * Email write operation MCP tools for managing emails via JMAP.
 * Tools: mark_as_read, mark_as_unread, delete_email, move_email, add_label, remove_label, create_draft.
 * These tools enable AI assistants to modify email status, organize emails, and create drafts.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Email, EmailAddress, EmailBodyPart, EmailCreate, JmapClient, PatchObject } from 'jmap-client-ts';
import type { Logger } from '../../config/logger.js';
import type { SignatureContent } from '../../signature/index.js';
import { buildDraftBody } from './draft-body.js';
import { approverFor } from '../approval.js';

/**
 * Common annotations for non-destructive write operations.
 */
const EMAIL_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Annotations for destructive operations (delete).
 */
const EMAIL_DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Annotations for create operations (not idempotent - each call creates new item).
 */
const EMAIL_CREATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Annotations for send operations (not idempotent - sends email).
 */
const EMAIL_SEND_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const toAddress = (email: string): EmailAddress => ({ email }) as EmailAddress;

/**
 * Register email operation MCP tools with the server.
 * @param server MCP server instance
 * @param jmapClient JMAP client for API calls
 * @param logger Pino logger
 */
export function registerEmailOperationTools(
  server: McpServer,
  jmapClient: JmapClient,
  logger: Logger,
  signatureContent?: SignatureContent
): void {
  // mark_as_read - set $seen keyword (EMAIL-06)
  server.registerTool(
    'mark_as_read',
    {
      title: 'Mark Email as Read',
      description: 'Mark an email as read by setting the $seen keyword.',
      inputSchema: {
        emailId: z.string().describe('The unique identifier of the email to mark as read'),
      },
      annotations: EMAIL_WRITE_ANNOTATIONS,
    },
    async ({ emailId }) => {
      logger.debug({ emailId }, 'mark_as_read called');
      const refused = await approverFor(server).gate('mark_as_read', async () => ({ action: 'mark_as_read', details: [['email', await approverFor(server).emails(jmapClient, [emailId])]] }));
      if (refused) return refused;

      try {
        const accountId = jmapClient.getPrimaryAccountId();
        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', {
            accountId,
            update: {
              [emailId]: {
                'keywords/$seen': true,
              },
            },
          }),
        ]);

        if (!result.ok) {
          logger.error({ error: result.error, emailId }, 'JMAP error in mark_as_read');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to mark email as read: ${result.error.description || result.error.type}`,
              },
            ],
          };
        }

        const setResponse = result.value;
        if (setResponse.notUpdated?.[emailId]) {
          const error = setResponse.notUpdated[emailId];
          logger.error({ error, emailId }, 'Email/set notUpdated in mark_as_read');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to mark email as read: ${error.type} - ${error.description || ''}`,
              },
            ],
          };
        }

        logger.debug({ emailId }, 'mark_as_read success');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, emailId, marked: 'read' }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailId }, 'Exception in mark_as_read');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error marking email as read: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // mark_as_unread - remove $seen keyword (EMAIL-07)
  server.registerTool(
    'mark_as_unread',
    {
      title: 'Mark Email as Unread',
      description: 'Mark an email as unread by removing the $seen keyword.',
      inputSchema: {
        emailId: z.string().describe('The unique identifier of the email to mark as unread'),
      },
      annotations: EMAIL_WRITE_ANNOTATIONS,
    },
    async ({ emailId }) => {
      logger.debug({ emailId }, 'mark_as_unread called');
      const refused = await approverFor(server).gate('mark_as_unread', async () => ({ action: 'mark_as_unread', details: [['email', await approverFor(server).emails(jmapClient, [emailId])]] }));
      if (refused) return refused;

      try {
        const accountId = jmapClient.getPrimaryAccountId();
        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', {
            accountId,
            update: {
              [emailId]: {
                'keywords/$seen': null,
              },
            },
          }),
        ]);

        if (!result.ok) {
          logger.error({ error: result.error, emailId }, 'JMAP error in mark_as_unread');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to mark email as unread: ${result.error.description || result.error.type}`,
              },
            ],
          };
        }

        const setResponse = result.value;
        if (setResponse.notUpdated?.[emailId]) {
          const error = setResponse.notUpdated[emailId];
          logger.error({ error, emailId }, 'Email/set notUpdated in mark_as_unread');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to mark email as unread: ${error.type} - ${error.description || ''}`,
              },
            ],
          };
        }

        logger.debug({ emailId }, 'mark_as_unread success');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, emailId, marked: 'unread' }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailId }, 'Exception in mark_as_unread');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error marking email as unread: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // delete_email - move to Trash or permanently destroy (EMAIL-05)
  server.registerTool(
    'delete_email',
    {
      title: 'Delete Email',
      description:
        'Delete an email. By default moves to Trash. Use permanent=true to permanently destroy.',
      inputSchema: {
        emailId: z.string().describe('The unique identifier of the email to delete'),
        permanent: z
          .boolean()
          .default(false)
          .describe('If true, permanently destroy the email. Default: false (move to Trash)'),
      },
      annotations: EMAIL_DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ emailId, permanent }) => {
      logger.debug({ emailId, permanent }, 'delete_email called');
      const refused = await approverFor(server).gate('delete_email', async () => ({ action: permanent ? 'delete_email_permanently' : 'delete_email', details: [['email', await approverFor(server).emails(jmapClient, [emailId])]] }));
      if (refused) return refused;

      try {
        const accountId = jmapClient.getPrimaryAccountId();

        if (permanent) {
          // Permanent delete using destroy
          const [result] = await jmapClient.requestSettled((b) => [
            b.call('Email/set', { accountId, destroy: [emailId] }),
          ]);

          if (!result.ok) {
            logger.error({ error: result.error, emailId }, 'JMAP error in delete_email (permanent)');
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to delete email: ${result.error.description || result.error.type}`,
                },
              ],
            };
          }

          const setResponse = result.value;
          if (setResponse.notDestroyed?.[emailId]) {
            const error = setResponse.notDestroyed[emailId];
            logger.error({ error, emailId }, 'Email/set notDestroyed in delete_email');
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to delete email: ${error.type} - ${error.description || ''}`,
                },
              ],
            };
          }

          logger.debug({ emailId }, 'delete_email (permanent) success');
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ success: true, emailId, action: 'permanently_deleted' }),
              },
            ],
          };
        } else {
          // Move to Trash
          // First find Trash mailbox
          const [queryResult] = await jmapClient.requestSettled((b) => [
            b.call('Mailbox/query', { accountId, filter: { role: 'trash' } }),
          ]);

          if (!queryResult.ok) {
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

          const trashIds = queryResult.value.ids;
          if (!trashIds || trashIds.length === 0) {
            // No Trash mailbox, fall back to permanent delete
            logger.warn({ emailId }, 'No Trash mailbox found, performing permanent delete');

            const [destroyResult] = await jmapClient.requestSettled((b) => [
              b.call('Email/set', { accountId, destroy: [emailId] }),
            ]);

            if (!destroyResult.ok) {
              logger.error(
                { error: destroyResult.error, emailId },
                'JMAP error in delete_email (fallback)'
              );
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to delete email: ${destroyResult.error.description || destroyResult.error.type}`,
                  },
                ],
              };
            }

            const destroySetResponse = destroyResult.value;
            if (destroySetResponse.notDestroyed?.[emailId]) {
              const error = destroySetResponse.notDestroyed[emailId];
              logger.error({ error, emailId }, 'Email/set notDestroyed in delete_email (fallback)');
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to delete email: ${error.type} - ${error.description || ''}`,
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ success: true, emailId, action: 'permanently_deleted' }),
                },
              ],
            };
          }

          const trashMailboxId = trashIds[0];

          // Move to Trash (replace all mailboxIds with just Trash)
          const [moveResult] = await jmapClient.requestSettled((b) => [
            b.call('Email/set', {
              accountId,
              update: {
                [emailId]: {
                  mailboxIds: { [trashMailboxId]: true },
                },
              },
            }),
          ]);

          if (!moveResult.ok) {
            logger.error({ error: moveResult.error, emailId }, 'JMAP error in delete_email (move)');
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to move email to Trash: ${moveResult.error.description || moveResult.error.type}`,
                },
              ],
            };
          }

          const moveSetResponse = moveResult.value;
          if (moveSetResponse.notUpdated?.[emailId]) {
            const error = moveSetResponse.notUpdated[emailId];
            logger.error({ error, emailId }, 'Email/set notUpdated in delete_email (move)');
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to move email to Trash: ${error.type} - ${error.description || ''}`,
                },
              ],
            };
          }

          logger.debug({ emailId, trashMailboxId }, 'delete_email (move to Trash) success');
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ success: true, emailId, action: 'moved_to_trash' }),
              },
            ],
          };
        }
      } catch (error) {
        logger.error({ error, emailId }, 'Exception in delete_email');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error deleting email: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // move_email - move email to a different mailbox (EMAIL-08)
  server.registerTool(
    'move_email',
    {
      title: 'Move Email',
      description: 'Move an email to a different mailbox. This replaces all current mailbox associations.',
      inputSchema: {
        emailId: z.string().describe('The unique identifier of the email to move'),
        targetMailboxId: z.string().describe('The ID of the mailbox to move the email to'),
      },
      annotations: EMAIL_WRITE_ANNOTATIONS,
    },
    async ({ emailId, targetMailboxId }) => {
      logger.debug({ emailId, targetMailboxId }, 'move_email called');
      const refused = await approverFor(server).gate('move_email', async () => ({ action: 'move_email', details: [['email', await approverFor(server).emails(jmapClient, [emailId])], ['destination', await approverFor(server).mailbox(jmapClient, targetMailboxId)]] }));
      if (refused) return refused;

      try {
        const accountId = jmapClient.getPrimaryAccountId();
        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', {
            accountId,
            update: {
              [emailId]: {
                mailboxIds: { [targetMailboxId]: true },
              },
            },
          }),
        ]);

        if (!result.ok) {
          logger.error({ error: result.error, emailId }, 'JMAP error in move_email');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to move email: ${result.error.description || result.error.type}`,
              },
            ],
          };
        }

        const setResponse = result.value;
        if (setResponse.notUpdated?.[emailId]) {
          const error = setResponse.notUpdated[emailId];
          logger.error({ error, emailId }, 'Email/set notUpdated in move_email');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to move email: ${error.type} - ${error.description || ''}`,
              },
            ],
          };
        }

        logger.debug({ emailId, targetMailboxId }, 'move_email success');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, emailId, targetMailboxId }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailId }, 'Exception in move_email');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error moving email: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // add_label - add a mailbox to an email without removing existing ones (EMAIL-09)
  server.registerTool(
    'add_label',
    {
      title: 'Add Label to Email',
      description: 'Add a label (mailbox) to an email without removing existing labels.',
      inputSchema: {
        emailId: z.string().describe('The unique identifier of the email'),
        mailboxId: z.string().describe('The ID of the mailbox (label) to add'),
      },
      annotations: EMAIL_WRITE_ANNOTATIONS,
    },
    async ({ emailId, mailboxId }) => {
      logger.debug({ emailId, mailboxId }, 'add_label called');
      const refused = await approverFor(server).gate('add_label', async () => ({ action: 'add_label', details: [['email', await approverFor(server).emails(jmapClient, [emailId])], ['label', await approverFor(server).mailbox(jmapClient, mailboxId)]] }));
      if (refused) return refused;

      try {
        const accountId = jmapClient.getPrimaryAccountId();
        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', {
            accountId,
            update: {
              [emailId]: {
                [`mailboxIds/${mailboxId}`]: true,
              },
            },
          }),
        ]);

        if (!result.ok) {
          logger.error({ error: result.error, emailId }, 'JMAP error in add_label');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to add label: ${result.error.description || result.error.type}`,
              },
            ],
          };
        }

        const setResponse = result.value;
        if (setResponse.notUpdated?.[emailId]) {
          const error = setResponse.notUpdated[emailId];
          logger.error({ error, emailId }, 'Email/set notUpdated in add_label');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to add label: ${error.type} - ${error.description || ''}`,
              },
            ],
          };
        }

        logger.debug({ emailId, mailboxId }, 'add_label success');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, emailId, addedMailboxId: mailboxId }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailId }, 'Exception in add_label');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error adding label: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // remove_label - remove a mailbox from an email (EMAIL-10)
  server.registerTool(
    'remove_label',
    {
      title: 'Remove Label from Email',
      description: 'Remove a label (mailbox) from an email. Email must belong to at least one mailbox.',
      inputSchema: {
        emailId: z.string().describe('The unique identifier of the email'),
        mailboxId: z.string().describe('The ID of the mailbox (label) to remove'),
      },
      annotations: EMAIL_WRITE_ANNOTATIONS,
    },
    async ({ emailId, mailboxId }) => {
      logger.debug({ emailId, mailboxId }, 'remove_label called');
      const refused = await approverFor(server).gate('remove_label', async () => ({ action: 'remove_label', details: [['email', await approverFor(server).emails(jmapClient, [emailId])], ['label', await approverFor(server).mailbox(jmapClient, mailboxId)]] }));
      if (refused) return refused;

      try {
        const accountId = jmapClient.getPrimaryAccountId();
        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', {
            accountId,
            update: {
              [emailId]: {
                [`mailboxIds/${mailboxId}`]: null,
              },
            },
          }),
        ]);

        if (!result.ok) {
          logger.error({ error: result.error, emailId }, 'JMAP error in remove_label');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to remove label: ${result.error.description || result.error.type}`,
              },
            ],
          };
        }

        const setResponse = result.value;
        if (setResponse.notUpdated?.[emailId]) {
          const error = setResponse.notUpdated[emailId];
          logger.error({ error, emailId }, 'Email/set notUpdated in remove_label');
          // Handle the case where email only has one mailbox
          if (error.type === 'invalidProperties') {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: 'Cannot remove label: email must belong to at least one mailbox',
                },
              ],
            };
          }
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to remove label: ${error.type} - ${error.description || ''}`,
              },
            ],
          };
        }

        logger.debug({ emailId, mailboxId }, 'remove_label success');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, emailId, removedMailboxId: mailboxId }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailId }, 'Exception in remove_label');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error removing label: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // create_draft - create a new draft email (EMAIL-12)
  server.registerTool(
    'create_draft',
    {
      title: 'Create Draft Email',
      description:
        'Create a new draft email in the Drafts mailbox for later editing or sending. ' +
        'The draft is multipart (text + HTML): pass htmlBody for rich formatting, otherwise HTML is generated from body. ' +
        'The configured signature is appended automatically (set signature=false to omit it): do not add it yourself.',
      inputSchema: {
        to: z.array(z.string().email()).optional().describe('Recipient email addresses'),
        cc: z.array(z.string().email()).optional().describe('CC email addresses'),
        bcc: z.array(z.string().email()).optional().describe('BCC email addresses'),
        subject: z.string().optional().describe('Email subject'),
        body: z.string().optional().describe('Plain text email body (without signature)'),
        htmlBody: z.string().optional().describe('HTML email body fragment (without signature, no <html>/<body> wrapper)'),
        signature: z.boolean().optional().describe('Append the configured signature (default true)'),
        inReplyTo: z.string().optional().describe('Message-ID of the email being replied to (with or without angle brackets)'),
      },
      annotations: EMAIL_CREATE_ANNOTATIONS,
    },
    async ({ to, cc, bcc, subject, body, htmlBody, signature, inReplyTo }) => {
      logger.debug(
        { to, cc, bcc, subject, hasBody: !!body, hasHtmlBody: !!htmlBody, signature, inReplyTo },
        'create_draft called'
      );

      try {
        const accountId = jmapClient.getPrimaryAccountId();

        // Get Drafts mailbox first (doesn't need submission capability)
        const [getResult] = await jmapClient.requestSettled((b) => [
          b.call('Mailbox/get', {
            accountId,
            properties: ['id', 'role'],
          }),
        ]);

        // Try to get identity separately (needs submission capability)
        let identity: { id: string; email: string; name: string } | undefined;
        try {
          const [identityResult] = await jmapClient.requestSettled((b) => [
            b.call('Identity/get', { accountId }),
          ]);
          if (identityResult.ok) {
            identity = identityResult.value.list?.[0];
          }
        } catch {
          // Identity fetch failed - draft will be created without from field
          logger.debug('Could not fetch identity for draft - will create without from field');
        }
        if (!getResult.ok) {
          logger.error({ error: getResult.error }, 'JMAP error getting mailboxes');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Failed to get mailboxes',
              },
            ],
          };
        }

        const mailboxes = getResult.value.list;
        const draftsMailbox = mailboxes.find((mb) => mb.role === 'drafts');
        if (!draftsMailbox) {
          logger.error({}, 'No Drafts mailbox found');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'No Drafts mailbox found. Cannot create draft.',
              },
            ],
          };
        }

        const draftsMailboxId = draftsMailbox.id;

        // Build email create object
        // Use textBody instead of bodyStructure for better server compatibility
        const emailCreate: EmailCreate = {
          mailboxIds: { [draftsMailboxId]: true },
          keywords: { '$draft': true, '$seen': true },
          subject: subject || '',
          ...buildDraftBody({
            body,
            htmlBody,
            signature: signatureContent,
            includeSignature: signature !== false,
          }),
        };

        // Set from field using identity (if available)
        if (identity) {
          emailCreate.from = [{ email: identity.email, name: identity.name }];
        }

        // Add optional address fields
        if (to && to.length > 0) {
          emailCreate.to = to.map(toAddress);
        }
        if (cc && cc.length > 0) {
          emailCreate.cc = cc.map(toAddress);
        }
        if (bcc && bcc.length > 0) {
          emailCreate.bcc = bcc.map(toAddress);
        }
        if (inReplyTo) {
          const msgId = inReplyTo.trim().replace(/^<|>$/g, '');
          emailCreate.inReplyTo = [msgId];
          emailCreate.references = [msgId];
        }

        // Create the draft
        const refused = await approverFor(server).gate('create_draft', async () => ({ action: 'create_draft', details: [...approverFor(server).message(emailCreate), ['in_reply_to', inReplyTo]] }));
        if (refused) return refused;
        const [createResult] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', {
            accountId,
            create: {
              draft: emailCreate,
            },
          }),
        ]);

        if (!createResult.ok) {
          logger.error({ error: createResult.error }, 'JMAP error in create_draft');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to create draft: ${createResult.error.description || createResult.error.type}`,
              },
            ],
          };
        }

        const setResponse = createResult.value;
        if (setResponse.notCreated?.draft) {
          const error = setResponse.notCreated.draft;
          logger.error({ error }, 'Email/set notCreated in create_draft');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to create draft: ${error.type} - ${error.description || ''}`,
              },
            ],
          };
        }

        const created = setResponse.created?.draft;
        if (!created) {
          logger.error({}, 'No created draft in response');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Failed to create draft: no created email in response',
              },
            ],
          };
        }

        logger.debug({ draftId: created.id, threadId: created.threadId }, 'create_draft success');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, draftId: created.id, threadId: created.threadId }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error }, 'Exception in create_draft');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error creating draft: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // update_draft - modify an existing draft email (DRAFT-01)
  server.registerTool(
    'update_draft',
    {
      title: 'Update Draft Email',
      description: 'Update an existing draft email: subject, body (plain text, without signature: the configured signature is added) or recipients. The draft is replaced by a new one (JMAP e-mails are immutable): use the returned draftId afterwards. Supports optimistic concurrency control via ifInState.',
      inputSchema: {
        draftId: z.string().describe('The unique identifier of the draft email to update'),
        subject: z.string().optional().describe('New subject line'),
        body: z.string().optional().describe('New plain text body'),
        to: z.array(z.string().email()).optional().describe('New recipient list'),
        cc: z.array(z.string().email()).optional().describe('New CC list'),
        bcc: z.array(z.string().email()).optional().describe('New BCC list'),
        ifInState: z.string().optional().describe('Optional state for optimistic concurrency control (prevents overwriting concurrent edits)'),
      },
      annotations: EMAIL_WRITE_ANNOTATIONS,
    },
    async ({ draftId, subject, body, to, cc, bcc, ifInState }) => {
      logger.debug({ draftId, subject, hasBody: !!body, to, cc, bcc, ifInState }, 'update_draft called');

      try {
        const changed = [
          subject !== undefined && 'subject',
          body !== undefined && 'body',
          to !== undefined && 'to',
          cc !== undefined && 'cc',
          bcc !== undefined && 'bcc',
        ].filter(Boolean) as string[];
        if (changed.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'No fields to update. Please provide at least one field: subject, body, to, cc, or bcc.',
              },
            ],
          };
        }

        // JMAP e-mails are immutable except keywords and mailboxes (RFC 8621 §4.6): a draft is changed
        // by creating its new version and destroying the old one, in one request.
        const accountId = jmapClient.getPrimaryAccountId();
        const [got] = await jmapClient.requestSettled((b) => [
          b.call('Email/get', {
            accountId,
            ids: [draftId],
            properties: ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'inReplyTo', 'references', 'mailboxIds', 'keywords', 'textBody', 'htmlBody', 'bodyValues', 'attachments'],
            fetchAllBodyValues: true,
          }),
        ]);
        const draft = got.ok ? (got.value.list ?? [])[0] : undefined;
        if (!draft) {
          return { isError: true, content: [{ type: 'text' as const, text: 'Draft not found. It may have been deleted or sent.' }] };
        }
        if (draft.keywords?.$draft !== true) {
          return { isError: true, content: [{ type: 'text' as const, text: 'This e-mail is not a draft: only drafts can be updated.' }] };
        }

        const part = (p: EmailBodyPart) => ({ partId: p.partId ?? undefined, type: p.type });
        const replacement: EmailCreate = {
          mailboxIds: draft.mailboxIds,
          keywords: draft.keywords,
          from: draft.from,
          subject: subject ?? draft.subject ?? '',
        };
        const recipients = (list: string[] | undefined, current: EmailAddress[] | null) => (list !== undefined ? list.map(toAddress) : current);
        for (const [key, value] of [
          ['to', recipients(to, draft.to)],
          ['cc', recipients(cc, draft.cc)],
          ['bcc', recipients(bcc, draft.bcc)],
          ['replyTo', draft.replyTo],
        ] as const) {
          if (value?.length) replacement[key] = value;
        }
        if (draft.inReplyTo?.length) replacement.inReplyTo = draft.inReplyTo;
        if (draft.references?.length) replacement.references = draft.references;
        if (body !== undefined) {
          Object.assign(replacement, buildDraftBody({ body, signature: signatureContent, includeSignature: true }));
        } else {
          const values = draft.bodyValues;
          const parts = [...(draft.textBody ?? []), ...(draft.htmlBody ?? [])];
          replacement.bodyValues = Object.fromEntries(parts.filter((p) => p.partId && values?.[p.partId]).map((p) => [p.partId, { value: values[p.partId!].value }]));
          if (draft.textBody?.length) replacement.textBody = draft.textBody.map(part);
          if (draft.htmlBody?.length) replacement.htmlBody = draft.htmlBody.map(part);
        }
        if (draft.attachments?.length) {
          replacement.attachments = draft.attachments.map((a) => ({
            blobId: a.blobId as string,
            type: a.type,
            name: a.name,
            disposition: a.disposition ?? 'attachment',
          }));
        }

        const refused = await approverFor(server).gate('update_draft', async () => ({
          action: 'update_draft',
          details: [['draft', await approverFor(server).emails(jmapClient, [draftId])], ['changes', changed.join(', ')], ...approverFor(server).message(replacement)],
        }));
        if (refused) return refused;

        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', {
            accountId,
            create: { draft: replacement },
            destroy: [draftId],
            ifInState: ifInState || undefined,
          }),
        ]);

        // Level 1: method error check
        if (!result.ok) {
          logger.error({ error: result.error, draftId }, 'JMAP error in update_draft');
          if (result.error?.type === 'stateMismatch') {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: 'Draft was modified by another client. Please refresh and try again.' }],
            };
          }
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to update draft: ${result.error.description || result.error.type}`,
              },
            ],
          };
        }

        // Level 2: notCreated / notDestroyed checks
        const setResponse = result.value;
        const notCreated = setResponse.notCreated?.draft;
        if (notCreated) {
          logger.error({ error: notCreated, draftId }, 'Email/set notCreated in update_draft');
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Failed to update draft: ${notCreated.type} - ${notCreated.description || ''}` }],
          };
        }
        const newId = setResponse.created?.draft?.id;
        const kept = setResponse.notDestroyed?.[draftId];
        logger.debug({ draftId, newId, updatedFields: changed }, 'update_draft success');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                draftId: newId,
                previousDraftId: draftId,
                updated: changed,
                note: kept
                  ? `New draft created, but the previous one could not be deleted (${kept.type}): delete it from Drafts.`
                  : 'Drafts cannot be edited in place: the draft was replaced, use the new draftId.',
              }),
            },
          ],
        };
      } catch (error) {
        // Level 3: try/catch wrapper
        logger.error({ error, draftId }, 'Exception in update_draft');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error updating draft: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // send_draft - send a previously saved draft email (DRAFT-02)
  server.registerTool(
    'send_draft',
    {
      title: 'Send Draft Email',
      description: 'Send a previously saved draft email. Draft will be moved to Sent folder and $draft keyword removed.',
      inputSchema: {
        draftId: z.string().describe('The unique identifier of the draft email to send'),
      },
      annotations: EMAIL_SEND_ANNOTATIONS,
    },
    async ({ draftId }) => {
      logger.debug({ draftId }, 'send_draft called');
      const refused = await approverFor(server).gate('send_draft', async () => ({ action: 'send_draft', details: await approverFor(server).stored(jmapClient, draftId) }));
      if (refused) return refused;

      try {
        const accountId = jmapClient.getPrimaryAccountId();

        // Step 1: Get identity and mailboxes in a single batch
        const [identityResult, mailboxResult] = await jmapClient.requestSettled((b) => [
          b.call('Identity/get', { accountId }),
          b.call('Mailbox/get', { accountId, properties: ['id', 'role'] }),
        ]);

        // Parse Identity response
        if (!identityResult.ok) {
          logger.error({ error: identityResult.error }, 'Failed to get identity');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Failed to get sending identity. Contact your administrator.',
              },
            ],
          };
        }

        const identities = identityResult.value.list;
        if (!identities || identities.length === 0) {
          logger.error({}, 'No sending identity available');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'No sending identity available. Contact your administrator.',
              },
            ],
          };
        }
        const identity = identities[0];

        // Parse Mailbox response and find Sent/Drafts by role
        if (!mailboxResult.ok) {
          logger.error({ error: mailboxResult.error }, 'Failed to get mailboxes');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Failed to get mailboxes. Cannot send draft.',
              },
            ],
          };
        }

        const mailboxes = mailboxResult.value.list;
        const sentMailbox = mailboxes.find((mb) => mb.role === 'sent');
        const draftsMailbox = mailboxes.find((mb) => mb.role === 'drafts');

        // Step 2: Build onSuccessUpdateEmail for atomic draft-to-sent transition
        const onSuccessUpdate: PatchObject<Email> = {
          'keywords/$draft': null,
        };

        if (sentMailbox && draftsMailbox) {
          onSuccessUpdate[`mailboxIds/${draftsMailbox.id}`] = null;
          onSuccessUpdate[`mailboxIds/${sentMailbox.id}`] = true;
        }

        // Step 3: Submit the draft via EmailSubmission/set
        const [submissionResult] = await jmapClient.requestSettled((b) => [
          b.call('EmailSubmission/set', {
            accountId,
            create: {
              submission: {
                identityId: identity.id,
                emailId: draftId,
              },
            },
            onSuccessUpdateEmail: { '#submission': onSuccessUpdate },
          }),
        ]);

        // Step 4: Check EmailSubmission/set response
        if (!submissionResult.ok) {
          logger.error({ error: submissionResult.error, draftId }, 'JMAP error in send_draft');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to send draft: ${submissionResult.error.description || submissionResult.error.type}`,
              },
            ],
          };
        }

        const submissionSetResponse = submissionResult.value;
        if (submissionSetResponse.notCreated?.submission) {
          const error = submissionSetResponse.notCreated.submission;
          logger.error({ error, draftId }, 'EmailSubmission/set notCreated in send_draft');

          // User-friendly error messages
          if (error.type === 'forbiddenFrom') {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: 'Not authorized to send from this address.',
                },
              ],
            };
          } else if (error.type === 'forbiddenToSend') {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: 'No permission to send emails.',
                },
              ],
            };
          } else if (error.type === 'tooManyRecipients') {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: 'Too many recipients.',
                },
              ],
            };
          } else if (error.type === 'invalidEmail') {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: 'Draft is invalid or missing required fields.',
                },
              ],
            };
          }

          // Generic fallback
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to send draft: ${error.type}`,
              },
            ],
          };
        }

        const createdSubmission = submissionSetResponse.created?.submission;
        if (!createdSubmission) {
          logger.error({}, 'No created submission in response');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Failed to send draft: no submission created in response',
              },
            ],
          };
        }

        logger.debug({ draftId, submissionId: createdSubmission.id, movedToSent: !!sentMailbox }, 'send_draft success');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                draftId,
                submissionId: createdSubmission.id,
                movedToSent: !!sentMailbox,
              }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, draftId }, 'Exception in send_draft');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error sending draft: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  logger.debug('Email operation tools registered: mark_as_read, mark_as_unread, delete_email, move_email, add_label, remove_label, create_draft, update_draft, send_draft');
}
