/**
 * Email MCP tools - get_email, search_emails, get_email_labels.
 * These tools enable AI assistants to read and search emails.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { errorText, type JmapClient } from '../../jmap/client.js';
import type { Logger } from '../../config/logger.js';
import { transformEmail } from '../../transformers/email.js';
import { buildSearchFilter } from './search-filter.js';

/**
 * Common annotations for read-only email tools.
 */
const EMAIL_READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Properties to fetch for full email content (get_email).
 */
const FULL_EMAIL_PROPERTIES = [
  'id',
  'blobId',
  'threadId',
  'mailboxIds',
  'keywords',
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'messageId',
  'inReplyTo',
  'references',
  'subject',
  'receivedAt',
  'sentAt',
  'preview',
  'hasAttachment',
  'size',
  'bodyValues',
  'textBody',
  'htmlBody',
  'attachments',
] as const;

/**
 * Properties to fetch for email summaries (search_emails).
 */
const SUMMARY_EMAIL_PROPERTIES = [
  'id',
  'blobId',
  'threadId',
  'mailboxIds',
  'keywords',
  'from',
  'to',
  'cc',
  'subject',
  'receivedAt',
  'preview',
  'hasAttachment',
] as const;

/**
 * Register email MCP tools with the server.
 * @param server MCP server instance
 * @param jmapClient JMAP client for API calls
 * @param logger Pino logger
 */
export function registerEmailTools(
  server: McpServer,
  jmapClient: JmapClient,
  logger: Logger
): void {
  // get_email - retrieve single email by ID with full content (EMAIL-03)
  server.registerTool(
    'get_email',
    {
      title: 'Get Email',
      description: 'Retrieve a single email by ID with full content including body text and attachments. Includes messageId, inReplyTo and references for threading.',
      inputSchema: {
        emailId: z.string().describe('The unique identifier of the email to retrieve'),
      },
      annotations: EMAIL_READ_ANNOTATIONS,
    },
    async ({ emailId }) => {
      logger.debug({ emailId }, 'get_email called');

      try {
        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/get', {
            accountId: jmapClient.getPrimaryAccountId(),
            ids: [emailId],
            properties: FULL_EMAIL_PROPERTIES,
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
            bodyProperties: ['partId', 'blobId', 'type', 'name', 'size'],
          }),
        ]);
        if (!result.ok) {
          logger.error({ error: result.error, emailId }, 'JMAP error in get_email');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to retrieve email: ${errorText(result.error)}`,
              },
            ],
          };
        }

        const emails = result.value.list;
        if (!emails || emails.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Email not found: ${emailId}`,
              },
            ],
          };
        }

        // Transform JMAP email to SimplifiedEmail
        const email = transformEmail(emails[0]);

        logger.debug({ emailId, subject: email.subject }, 'get_email success');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(email, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailId }, 'Exception in get_email');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error retrieving email: ${errorText(error)}`,
            },
          ],
        };
      }
    }
  );

  // search_emails - search with filters (EMAIL-04)
  server.registerTool(
    'search_emails',
    {
      title: 'Search Emails',
      description:
        'Search emails with filters. Returns a list of matching emails sorted by date (newest first).',
      inputSchema: {
        mailboxId: z.string().optional().describe('Filter to emails in this mailbox'),
        from: z.string().optional().describe('Filter by sender email address or name'),
        to: z.string().optional().describe('Filter by recipient email address or name'),
        cc: z.string().optional().describe('Filter by Cc address or name'),
        bcc: z.string().optional().describe('Filter by Bcc address or name'),
        participant: z
          .string()
          .optional()
          .describe('An address, name or domain found in From, To, Cc or Bcc: all your exchanges with someone, in every mailbox'),
        subject: z.string().optional().describe('Filter by subject text'),
        text: z.string().optional().describe('Full-text search in email body'),
        before: z.string().optional().describe('Filter to emails received before this date (ISO 8601; a date alone is midnight UTC, a time without offset is UTC)'),
        after: z.string().optional().describe('Filter to emails received after this date (ISO 8601; a date alone is midnight UTC, a time without offset is UTC)'),
        hasAttachment: z.boolean().optional().describe('Filter to emails with attachments'),
        unreadOnly: z.boolean().optional().describe('Filter to unread emails only'),
        flagged: z.boolean().optional().describe('Filter to flagged/starred emails only'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Maximum number of results (1-100, default 20)'),
        position: z.number().int().min(0).default(0).describe('Index of the first result, to page through more than limit'),
      },
      annotations: EMAIL_READ_ANNOTATIONS,
    },
    async (args) => {
      const { limit, position } = args;

      logger.debug({ args }, 'search_emails called');

      let filter: Record<string, unknown> | undefined;
      try {
        filter = buildSearchFilter(args);
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] };
      }

      try {
        const accountId = jmapClient.getPrimaryAccountId();

        // Use back-reference pattern: Email/query -> Email/get with '#ids'
        const [queryResult, getResult, mailboxResult] = await jmapClient.requestSettled((b) => {
          const query = b.call('Email/query', {
            accountId,
            filter,
            sort: [{ property: 'receivedAt', isAscending: false }],
            position,
            limit,
            calculateTotal: true,
          });
          return [
            query,
            b.call('Email/get', { accountId, '#ids': query.ref('/ids'), properties: SUMMARY_EMAIL_PROPERTIES }),
            b.call('Mailbox/get', { accountId, properties: ['id', 'name'] }),
          ];
        });

        // Check query response
        if (!queryResult.ok) {
          logger.error({ error: queryResult.error }, 'JMAP query error in search_emails');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Search failed: ${errorText(queryResult.error)}`,
              },
            ],
          };
        }

        // Check get response
        if (!getResult.ok) {
          logger.error({ error: getResult.error }, 'JMAP get error in search_emails');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to fetch email details: ${errorText(getResult.error)}`,
              },
            ],
          };
        }

        const emails = getResult.value.list || [];
        // Mailbox names help read the results; without them, the ids stay
        const names = new Map(((mailboxResult.ok ? mailboxResult.value.list : undefined) ?? []).map((m) => [m.id, m.name]));
        const transformedEmails = emails.map((email) => {
          const simplified = transformEmail(email);
          return { ...simplified, mailboxNames: simplified.mailboxIds.map((id) => names.get(id) ?? id) };
        });

        const totalFound = queryResult.value.total || emails.length;

        logger.debug({ count: transformedEmails.length, total: totalFound }, 'search_emails success');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  total: totalFound,
                  position,
                  returned: transformedEmails.length,
                  emails: transformedEmails,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error({ error }, 'Exception in search_emails');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Search error: ${errorText(error)}`,
            },
          ],
        };
      }
    }
  );

  // get_email_labels - get mailbox IDs for an email (EMAIL-11)
  server.registerTool(
    'get_email_labels',
    {
      title: 'Get Email Labels',
      description: 'Get the list of mailbox IDs (labels/folders) that an email belongs to.',
      inputSchema: {
        emailId: z.string().describe('The unique identifier of the email'),
      },
      annotations: EMAIL_READ_ANNOTATIONS,
    },
    async ({ emailId }) => {
      logger.debug({ emailId }, 'get_email_labels called');

      try {
        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/get', {
            accountId: jmapClient.getPrimaryAccountId(),
            ids: [emailId],
            properties: ['id', 'mailboxIds'],
          }),
        ]);
        if (!result.ok) {
          logger.error({ error: result.error, emailId }, 'JMAP error in get_email_labels');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to get email labels: ${errorText(result.error)}`,
              },
            ],
          };
        }

        const emails = result.value.list;
        if (!emails || emails.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Email not found: ${emailId}`,
              },
            ],
          };
        }

        // Extract mailbox IDs from the JMAP response
        const mailboxIds = Object.entries(emails[0].mailboxIds)
          .filter(([, isInMailbox]) => isInMailbox)
          .map(([mailboxId]) => mailboxId);

        logger.debug({ emailId, mailboxCount: mailboxIds.length }, 'get_email_labels success');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  emailId,
                  mailboxIds,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailId }, 'Exception in get_email_labels');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error getting email labels: ${errorText(error)}`,
            },
          ],
        };
      }
    }
  );

  logger.debug('Email tools registered: get_email, search_emails, get_email_labels');
}
