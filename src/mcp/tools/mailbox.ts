/**
 * Mailbox MCP tools for retrieving and listing mailboxes.
 * Provides get_mailbox (MBOX-01) and list_mailboxes (MBOX-02) tools.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { JMAPClient } from '../../jmap/client.js';
import type { Logger } from '../../config/logger.js';
import { transformMailbox } from '../../transformers/mailbox.js';
import type { SimplifiedMailbox } from '../../types/dto.js';
import type { MailboxSetResponse } from '../../types/jmap.js';
import { approverFor } from '../approval.js';

/** Properties to fetch for mailbox operations */
const MAILBOX_PROPERTIES = [
  'id',
  'name',
  'parentId',
  'role',
  'sortOrder',
  'totalEmails',
  'unreadEmails',
  'totalThreads',
  'unreadThreads',
  'myRights',
  'isSubscribed',
];

/** Common tool annotations for read-only mailbox operations */
const MAILBOX_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Register mailbox tools with the MCP server.
 * @param server MCP server instance
 * @param jmapClient JMAP client for server communication
 * @param logger Logger instance
 */
export function registerMailboxTools(
  server: McpServer,
  jmapClient: JMAPClient,
  logger: Logger
): void {
  // get_mailbox tool (MBOX-01)
  server.tool(
    'get_mailbox',
    'Retrieve a mailbox by its ID with metadata including email counts and permissions.',
    {
      mailboxId: z.string().describe('The unique identifier of the mailbox to retrieve'),
    },
    {
      ...MAILBOX_TOOL_ANNOTATIONS,
      title: 'Get Mailbox',
    },
    async ({ mailboxId }) => {
      logger.debug({ mailboxId }, 'get_mailbox called');

      try {
        const session = jmapClient.getSession();
        const response = await jmapClient.request([
          [
            'Mailbox/get',
            {
              accountId: session.accountId,
              ids: [mailboxId],
              properties: MAILBOX_PROPERTIES,
            },
            'get-mailbox',
          ],
        ]);

        const result = jmapClient.parseMethodResponse(response.methodResponses[0]);

        if (!result.success) {
          logger.error({ error: result.error }, 'JMAP error in get_mailbox');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error retrieving mailbox: ${result.error?.description || result.error?.type || 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }

        const list = result.data?.list as Record<string, unknown>[] | undefined;
        const notFound = result.data?.notFound as string[] | undefined;

        if (notFound && notFound.includes(mailboxId)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Mailbox not found: ${mailboxId}`,
              },
            ],
            isError: true,
          };
        }

        if (!list || list.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Mailbox not found: ${mailboxId}`,
              },
            ],
            isError: true,
          };
        }

        const mailbox = transformMailbox(list[0] as unknown as Parameters<typeof transformMailbox>[0]);

        logger.debug({ mailboxId: mailbox.id, name: mailbox.name }, 'get_mailbox success');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(mailbox, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, mailboxId }, 'Exception in get_mailbox');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error retrieving mailbox: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // list_mailboxes tool (MBOX-02)
  server.tool(
    'list_mailboxes',
    'List all mailboxes with optional filtering by role (inbox, drafts, sent, trash, archive, spam, junk, important, all).',
    {
      role: z
        .enum(['inbox', 'drafts', 'sent', 'trash', 'archive', 'junk', 'important', 'all', 'subscribed'])
        .optional()
        .describe('Filter mailboxes by role (e.g., inbox, drafts, sent, trash)'),
    },
    {
      ...MAILBOX_TOOL_ANNOTATIONS,
      title: 'List Mailboxes',
    },
    async ({ role }) => {
      logger.debug({ role }, 'list_mailboxes called');

      try {
        const session = jmapClient.getSession();
        const response = await jmapClient.request([
          [
            'Mailbox/get',
            {
              accountId: session.accountId,
              properties: MAILBOX_PROPERTIES,
            },
            'list-mailboxes',
          ],
        ]);

        const result = jmapClient.parseMethodResponse(response.methodResponses[0]);

        if (!result.success) {
          logger.error({ error: result.error }, 'JMAP error in list_mailboxes');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error listing mailboxes: ${result.error?.description || result.error?.type || 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }

        const list = result.data?.list as Record<string, unknown>[] | undefined;

        if (!list) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify([], null, 2),
              },
            ],
          };
        }

        // Transform all mailboxes
        let mailboxes: SimplifiedMailbox[] = list.map((item) =>
          transformMailbox(item as unknown as Parameters<typeof transformMailbox>[0])
        );

        // Filter by role if specified (client-side filtering)
        if (role) {
          mailboxes = mailboxes.filter((mailbox) => mailbox.role === role);
        }

        logger.debug(
          { count: mailboxes.length, filtered: !!role, role },
          'list_mailboxes success'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(mailboxes, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, role }, 'Exception in list_mailboxes');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing mailboxes: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // create_mailbox tool (MBOX-01 create)
  server.tool(
    'create_mailbox',
    'Create a new mailbox (folder) for organizing emails.',
    {
      name: z
        .string()
        .min(1, 'Mailbox name cannot be empty')
        .max(100, 'Mailbox name too long')
        .describe('Name for the new mailbox'),
      parentId: z
        .string()
        .optional()
        .describe('Parent mailbox ID for nested folders (omit for top-level)'),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Create Mailbox',
    },
    async ({ name, parentId }) => {
      logger.debug({ name, parentId }, 'create_mailbox called');
      const refused = await approverFor(server).gate('create_mailbox', async () => ({ action: 'create_mailbox', details: [['name', name], ['parent', parentId ? await approverFor(server).mailbox(jmapClient, parentId) : undefined]] }));
      if (refused) return refused;

      try {
        const session = jmapClient.getSession();

        const response = await jmapClient.request([
          [
            'Mailbox/set',
            {
              accountId: session.accountId,
              create: {
                new: {
                  name: name.trim(),
                  parentId: parentId || null,
                  isSubscribed: true,
                },
              },
            },
            'createMailbox',
          ],
        ]);

        const result = jmapClient.parseMethodResponse(response.methodResponses[0]);

        if (!result.success) {
          logger.error({ error: result.error }, 'JMAP error in create_mailbox');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error creating mailbox: ${result.error?.description || result.error?.type || 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }

        const setResponse = result.data as unknown as MailboxSetResponse;

        // Check for creation errors
        if (setResponse.notCreated?.['new']) {
          const error = setResponse.notCreated['new'];
          logger.error({ error }, 'Mailbox creation failed');

          // Provide user-friendly error messages
          let errorMessage = `Failed to create mailbox: ${error.type}`;
          if (error.type === 'invalidProperties' && error.description?.includes('name')) {
            errorMessage = 'A mailbox with this name already exists at this level';
          } else if (error.description) {
            errorMessage = `Failed to create mailbox: ${error.description}`;
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: errorMessage,
              },
            ],
            isError: true,
          };
        }

        const created = setResponse.created?.['new'];
        if (!created) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Mailbox creation failed: no mailbox returned',
              },
            ],
            isError: true,
          };
        }

        logger.debug({ mailboxId: created.id, name }, 'create_mailbox success');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  mailboxId: created.id,
                  name: name.trim(),
                  parentId: parentId || null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, name, parentId }, 'Exception in create_mailbox');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error creating mailbox: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // rename_mailbox tool (MBOX-02)
  server.tool(
    'rename_mailbox',
    'Rename an existing mailbox. Cannot rename system mailboxes (Inbox, Sent, Drafts, Trash, etc.).',
    {
      mailboxId: z.string().describe('ID of the mailbox to rename'),
      newName: z
        .string()
        .min(1, 'Mailbox name cannot be empty')
        .max(100, 'Mailbox name too long')
        .describe('New name for the mailbox'),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      title: 'Rename Mailbox',
    },
    async ({ mailboxId, newName }) => {
      logger.debug({ mailboxId, newName }, 'rename_mailbox called');
      const refused = await approverFor(server).gate('rename_mailbox', async () => ({ action: 'rename_mailbox', details: [['mailbox', `${await approverFor(server).mailbox(jmapClient, mailboxId)} → ${newName}`]] }));
      if (refused) return refused;

      try {
        const session = jmapClient.getSession();

        // Step 1: Fetch mailbox to check permissions and role
        const getResponse = await jmapClient.request([
          [
            'Mailbox/get',
            {
              accountId: session.accountId,
              ids: [mailboxId],
              properties: ['id', 'name', 'role', 'myRights'],
            },
            'getMailbox',
          ],
        ]);

        const getResult = jmapClient.parseMethodResponse(getResponse.methodResponses[0]);

        if (!getResult.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error checking mailbox: ${getResult.error?.description || getResult.error?.type || 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }

        const mailboxList = getResult.data?.list as
          | Array<{
              id: string;
              name: string;
              role: string | null;
              myRights?: { mayRename?: boolean };
            }>
          | undefined;
        const notFound = getResult.data?.notFound as string[] | undefined;

        if (notFound?.includes(mailboxId) || !mailboxList || mailboxList.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Mailbox not found: ${mailboxId}`,
              },
            ],
            isError: true,
          };
        }

        const mailbox = mailboxList[0];

        // Check for system mailbox
        if (mailbox.role !== null) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Cannot rename system mailbox: ${mailbox.role}. System folders (Inbox, Sent, Drafts, Trash, etc.) cannot be renamed.`,
              },
            ],
            isError: true,
          };
        }

        // Check rename permission
        if (mailbox.myRights && !mailbox.myRights.mayRename) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'You do not have permission to rename this mailbox',
              },
            ],
            isError: true,
          };
        }

        // Step 2: Perform rename
        const setResponse = await jmapClient.request([
          [
            'Mailbox/set',
            {
              accountId: session.accountId,
              update: {
                [mailboxId]: { name: newName.trim() },
              },
            },
            'renameMailbox',
          ],
        ]);

        const setResult = jmapClient.parseMethodResponse(setResponse.methodResponses[0]);

        if (!setResult.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error renaming mailbox: ${setResult.error?.description || setResult.error?.type || 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }

        const response = setResult.data as unknown as MailboxSetResponse;

        if (response.notUpdated?.[mailboxId]) {
          const error = response.notUpdated[mailboxId];
          let errorMessage = `Failed to rename mailbox: ${error.type}`;
          if (error.type === 'invalidProperties' && error.description?.includes('name')) {
            errorMessage = 'A mailbox with this name already exists at this level';
          } else if (error.description) {
            errorMessage = `Failed to rename mailbox: ${error.description}`;
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: errorMessage,
              },
            ],
            isError: true,
          };
        }

        logger.debug({ mailboxId, newName }, 'rename_mailbox success');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  mailboxId,
                  oldName: mailbox.name,
                  newName: newName.trim(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, mailboxId, newName }, 'Exception in rename_mailbox');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error renaming mailbox: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // delete_mailbox tool (MBOX-03)
  server.tool(
    'delete_mailbox',
    'Delete a custom mailbox. Cannot delete system mailboxes or mailboxes containing emails (unless force=true).',
    {
      mailboxId: z.string().describe('ID of the mailbox to delete'),
      force: z
        .boolean()
        .default(false)
        .describe(
          'If true, delete mailbox even if it contains emails (emails will be permanently deleted)'
        ),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Delete Mailbox',
    },
    async ({ mailboxId, force }) => {
      logger.debug({ mailboxId, force }, 'delete_mailbox called');
      const refused = await approverFor(server).gate('delete_mailbox', async () => ({ action: 'delete_mailbox', details: [['mailbox', await approverFor(server).mailbox(jmapClient, mailboxId)], ['contents', force ? 'force' : undefined]] }));
      if (refused) return refused;

      try {
        const session = jmapClient.getSession();

        // Step 1: Fetch mailbox to check permissions and role
        const getResponse = await jmapClient.request([
          [
            'Mailbox/get',
            {
              accountId: session.accountId,
              ids: [mailboxId],
              properties: ['id', 'name', 'role', 'myRights'],
            },
            'getMailbox',
          ],
        ]);

        const getResult = jmapClient.parseMethodResponse(getResponse.methodResponses[0]);

        if (!getResult.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error checking mailbox: ${getResult.error?.description || getResult.error?.type || 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }

        const mailboxList = getResult.data?.list as
          | Array<{
              id: string;
              name: string;
              role: string | null;
              myRights?: { mayDelete?: boolean };
            }>
          | undefined;
        const notFound = getResult.data?.notFound as string[] | undefined;

        if (notFound?.includes(mailboxId) || !mailboxList || mailboxList.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Mailbox not found: ${mailboxId}`,
              },
            ],
            isError: true,
          };
        }

        const mailbox = mailboxList[0];

        // Check for system mailbox
        if (mailbox.role !== null) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Cannot delete system mailbox: ${mailbox.role}. System folders (Inbox, Sent, Drafts, Trash, etc.) are protected and cannot be deleted.`,
              },
            ],
            isError: true,
          };
        }

        // Check delete permission
        if (mailbox.myRights && !mailbox.myRights.mayDelete) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'You do not have permission to delete this mailbox',
              },
            ],
            isError: true,
          };
        }

        // Step 2: Attempt delete with onDestroyRemoveEmails based on force
        const setResponse = await jmapClient.request([
          [
            'Mailbox/set',
            {
              accountId: session.accountId,
              destroy: [mailboxId],
              onDestroyRemoveEmails: force,
            },
            'deleteMailbox',
          ],
        ]);

        const setResult = jmapClient.parseMethodResponse(setResponse.methodResponses[0]);

        if (!setResult.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error deleting mailbox: ${setResult.error?.description || setResult.error?.type || 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }

        const response = setResult.data as unknown as MailboxSetResponse;

        // Handle specific destroy errors
        if (response.notDestroyed?.[mailboxId]) {
          const error = response.notDestroyed[mailboxId];

          if (error.type === 'mailboxHasEmail') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Cannot delete mailbox: it contains emails. Move or delete the emails first, or use force=true to delete the mailbox and all its emails permanently.',
                },
              ],
              isError: true,
            };
          }

          if (error.type === 'mailboxHasChild') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Cannot delete mailbox: it has child mailboxes. Delete the child mailboxes first.',
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to delete mailbox: ${error.type}${error.description ? ' - ' + error.description : ''}`,
              },
            ],
            isError: true,
          };
        }

        logger.debug({ mailboxId, name: mailbox.name }, 'delete_mailbox success');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  deletedMailboxId: mailboxId,
                  deletedMailboxName: mailbox.name,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, mailboxId, force }, 'Exception in delete_mailbox');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error deleting mailbox: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  logger.info(
    'Mailbox tools registered: get_mailbox, list_mailboxes, create_mailbox, rename_mailbox, delete_mailbox'
  );
}
