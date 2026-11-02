/**
 * Email MCP tools - get_email, search_emails, get_email_labels.
 * These tools enable AI assistants to read and search emails.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { EmailFilterCondition, JmapClient } from 'jmap-client-ts';
import type { Logger } from '../../config/logger.js';
import { transformEmail } from '../../transformers/email.js';

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
      description: 'Retrieve a single email by ID with full content including body text and attachments.',
      inputSchema: {
        emailId: z.string().describe('The unique identifier of the email to retrieve'),
      },
      annotations: EMAIL_READ_ANNOTATIONS,
    },
    async ({ emailId }) => {
      logger.debug({ emailId }, 'get_email called');

      try {
        const accountId = jmapClient.getPrimaryAccountId();
        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/get', {
            accountId,
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
                text: `Failed to retrieve email: ${result.error.description || result.error.type}`,
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
              text: `Error retrieving email: ${error instanceof Error ? error.message : String(error)}`,
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
        subject: z.string().optional().describe('Filter by subject text'),
        text: z.string().optional().describe('Full-text search in email body'),
        before: z.string().optional().describe('Filter to emails received before this date (ISO 8601)'),
        after: z.string().optional().describe('Filter to emails received after this date (ISO 8601)'),
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
      },
      annotations: EMAIL_READ_ANNOTATIONS,
    },
    async (args) => {
      const { mailboxId, from, to, subject, text, before, after, hasAttachment, unreadOnly, flagged, limit } =
        args;

      logger.debug({ args }, 'search_emails called');

      try {
        const accountId = jmapClient.getPrimaryAccountId();

        // Build JMAP filter from inputs
        const filter: EmailFilterCondition = {};

        if (mailboxId) {
          filter.inMailbox = mailboxId;
        }
        if (from) {
          filter.from = from;
        }
        if (to) {
          filter.to = to;
        }
        if (subject) {
          filter.subject = subject;
        }
        if (text) {
          filter.text = text;
        }
        if (before) {
          filter.before = before;
        }
        if (after) {
          filter.after = after;
        }
        if (hasAttachment !== undefined) {
          filter.hasAttachment = hasAttachment;
        }
        if (unreadOnly) {
          filter.notKeyword = '$seen';
        }
        if (flagged) {
          filter.hasKeyword = '$flagged';
        }

        // Use back-reference pattern: Email/query -> Email/get with '#ids'
        const [queryResult, getResult] = await jmapClient.requestSettled((b) => {
          const query = b.call('Email/query', {
            accountId,
            filter: Object.keys(filter).length > 0 ? filter : undefined,
            sort: [{ property: 'receivedAt', isAscending: false }],
            limit,
          });
          const get = b.call('Email/get', {
            accountId,
            '#ids': query.ref('/ids'),
            properties: SUMMARY_EMAIL_PROPERTIES,
          });
          return [query, get];
        });

        // Check query response
        if (!queryResult.ok) {
          logger.error({ error: queryResult.error }, 'JMAP query error in search_emails');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Search failed: ${queryResult.error.description || queryResult.error.type}`,
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
                text: `Failed to fetch email details: ${getResult.error.description || getResult.error.type}`,
              },
            ],
          };
        }

        const emails = getResult.value.list || [];
        const transformedEmails = emails.map((email) => transformEmail(email));

        const totalFound = queryResult.value.total || emails.length;

        logger.debug({ count: transformedEmails.length, total: totalFound }, 'search_emails success');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  total: totalFound,
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
              text: `Search error: ${error instanceof Error ? error.message : String(error)}`,
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
        const accountId = jmapClient.getPrimaryAccountId();
        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/get', {
            accountId,
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
                text: `Failed to get email labels: ${result.error.description || result.error.type}`,
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
              text: `Error getting email labels: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  logger.debug('Email tools registered: get_email, search_emails, get_email_labels');
}
