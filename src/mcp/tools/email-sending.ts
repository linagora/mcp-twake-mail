/**
 * Email sending MCP tools for composing and sending emails via JMAP.
 * Tools: send_email
 * These tools enable AI assistants to send new emails.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Email, EmailAddress, EmailCreate, JmapClient, PatchObject } from 'jmap-client-ts';
import type { Logger } from '../../config/logger.js';
import type { SignatureContent } from '../../signature/index.js';
import { approverFor } from '../approval.js';

/**
 * Annotations for send operations (not idempotent - each call sends a new email).
 */
const EMAIL_SEND_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const toAddress = (email: string): EmailAddress => ({ email }) as EmailAddress;

/**
 * Options for email sending tools.
 */
export interface EmailSendingOptions {
  signatureContent?: SignatureContent;
  defaultFrom?: string;
}

/**
 * Append signature to email body.
 * @param body Email body content
 * @param signature Signature content to append
 * @param isHtml Whether this is HTML content
 * @returns Body with signature appended
 */
function appendSignature(body: string, signature: string, isHtml: boolean): string {
  if (!signature) return body;
  if (isHtml) {
    // HTML: use <br> tags and -- separator
    return `${body}<br/><br/>-- <br/>${signature}`;
  } else {
    // Plain text: RFC-compliant "-- \n" delimiter
    return `${body}\n\n-- \n${signature}`;
  }
}

/**
 * Register email sending MCP tools with the server.
 * @param server MCP server instance
 * @param jmapClient JMAP client for API calls
 * @param logger Pino logger
 * @param options Optional signature and defaultFrom configuration
 */
export function registerEmailSendingTools(
  server: McpServer,
  jmapClient: JmapClient,
  logger: Logger,
  options: EmailSendingOptions = {}
): void {
  const { signatureContent, defaultFrom } = options;

  // send_email - compose and send a new email (EMAIL-01)
  server.registerTool(
    'send_email',
    {
      title: 'Send Email',
      description:
        'Compose and send a new email. Supports plain text and HTML body content.',
      inputSchema: {
        to: z
          .array(z.string().email())
          .min(1)
          .describe('Recipient email addresses (at least one required)'),
        cc: z.array(z.string().email()).optional().describe('CC email addresses'),
        bcc: z.array(z.string().email()).optional().describe('BCC email addresses'),
        subject: z.string().describe('Email subject line'),
        body: z.string().optional().describe('Plain text email body'),
        htmlBody: z.string().optional().describe('HTML email body'),
        from: z.string().email().optional().describe('Sender email address (uses default if not specified)'),
      },
      annotations: EMAIL_SEND_ANNOTATIONS,
    },
    async ({ to, cc, bcc, subject, body, htmlBody, from }) => {
      logger.debug(
        { to, cc, bcc, subject, hasBody: !!body, hasHtmlBody: !!htmlBody, from },
        'send_email called'
      );

      try {
        const accountId = jmapClient.getPrimaryAccountId();

        // Step 1: Get identity and mailboxes in a single batch
        // Use Mailbox/get instead of Mailbox/query because some servers don't support filter by role
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
                text: 'Failed to get mailboxes. Cannot send email.',
              },
            ],
          };
        }

        const mailboxes = mailboxResult.value.list;
        const sentMailbox = mailboxes.find((mb) => mb.role === 'sent');
        const draftsMailbox = mailboxes.find((mb) => mb.role === 'drafts');

        const sentMailboxId = sentMailbox?.id;

        if (!draftsMailbox) {
          logger.error({}, 'No Drafts mailbox found');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'No Drafts mailbox found. Cannot send email.',
              },
            ],
          };
        }
        const draftsMailboxId = draftsMailbox.id;

        // Step 2: Build textBody/htmlBody for better server compatibility
        // Using textBody/htmlBody instead of bodyStructure as it's better supported
        let textBody: Array<{ partId: string; type: string }> | undefined;
        let htmlBodyParts: Array<{ partId: string; type: string }> | undefined;
        const bodyValues: Record<string, { value: string }> = {};

        if (body) {
          textBody = [{ partId: 'text', type: 'text/plain' }];
          // Inject signature into plain text body
          const finalBody = signatureContent
            ? appendSignature(body, signatureContent.text, false)
            : body;
          bodyValues.text = { value: finalBody };
        }
        if (htmlBody) {
          htmlBodyParts = [{ partId: 'html', type: 'text/html' }];
          // Inject signature into HTML body
          const finalHtml = signatureContent
            ? appendSignature(htmlBody, signatureContent.html, true)
            : htmlBody;
          bodyValues.html = { value: finalHtml };
        }

        // Step 3: Build email object with sender address priority chain
        // Priority: explicit from parameter > defaultFrom config > identity.email
        const senderEmail = from || defaultFrom || identity.email;
        const senderName = identity.name; // Always use identity name

        const emailCreate: EmailCreate = {
          mailboxIds: { [draftsMailboxId]: true },
          from: [{ name: senderName, email: senderEmail }],
          to: to.map(toAddress),
          subject,
          bodyValues,
        };

        // Add body parts (server will create multipart/alternative if both present)
        if (textBody) {
          emailCreate.textBody = textBody;
        }
        if (htmlBodyParts) {
          emailCreate.htmlBody = htmlBodyParts;
        }

        // Add optional address fields
        if (cc && cc.length > 0) {
          emailCreate.cc = cc.map(toAddress);
        }
        if (bcc && bcc.length > 0) {
          emailCreate.bcc = bcc.map(toAddress);
        }

        // Step 4: Build onSuccessUpdateEmail for Drafts-to-Sent transition
        const onSuccessUpdate: PatchObject<Email> = {
          'keywords/$draft': null,
        };

        if (sentMailboxId) {
          onSuccessUpdate[`mailboxIds/${draftsMailboxId}`] = null;
          onSuccessUpdate[`mailboxIds/${sentMailboxId}`] = true;
        }

        // Step 5: Create email and submit in single batch
        const refused = await approverFor(server).gate('send_email', async () => ({ action: 'send_email', details: approverFor(server).message(emailCreate) }));
        if (refused) return refused;
        const [emailResult, submissionResult] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', {
            accountId,
            create: { email: emailCreate },
          }),
          b.call('EmailSubmission/set', {
            accountId,
            create: {
              submission: {
                identityId: identity.id,
                emailId: '#email',
              },
            },
            onSuccessUpdateEmail: { '#submission': onSuccessUpdate },
          }),
        ]);

        // Step 6: Check Email/set response
        if (!emailResult.ok) {
          logger.error({ error: emailResult.error }, 'JMAP error in Email/set');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to create email: ${emailResult.error.description || emailResult.error.type}`,
              },
            ],
          };
        }

        const emailSetResponse = emailResult.value;
        if (emailSetResponse.notCreated?.email) {
          const error = emailSetResponse.notCreated.email;
          logger.error({ error }, 'Email/set notCreated');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to create email: ${error.type} - ${error.description || ''}`,
              },
            ],
          };
        }

        const createdEmail = emailSetResponse.created?.email;
        if (!createdEmail) {
          logger.error({}, 'No created email in response');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Failed to create email: no created email in response',
              },
            ],
          };
        }

        // Step 7: Check EmailSubmission/set response
        if (!submissionResult.ok) {
          logger.error({ error: submissionResult.error }, 'JMAP error in EmailSubmission/set');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to send email: ${submissionResult.error.description || submissionResult.error.type}`,
              },
            ],
          };
        }

        const submissionSetResponse = submissionResult.value;
        if (submissionSetResponse.notCreated?.submission) {
          const error = submissionSetResponse.notCreated.submission;
          logger.error({ error }, 'EmailSubmission/set notCreated');
          // Provide user-friendly messages for common errors
          let errorMessage = `Failed to send email: ${error.type}`;
          if (error.type === 'forbiddenFrom') {
            errorMessage = 'Failed to send email: You are not authorized to send from this address.';
          } else if (error.type === 'forbiddenToSend') {
            errorMessage = 'Failed to send email: You do not have permission to send emails.';
          } else if (error.type === 'tooManyRecipients') {
            errorMessage = 'Failed to send email: Too many recipients specified.';
          } else if (error.description) {
            errorMessage = `Failed to send email: ${error.type} - ${error.description}`;
          }
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: errorMessage,
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
                text: 'Failed to send email: no submission created in response',
              },
            ],
          };
        }

        logger.debug(
          { emailId: createdEmail.id, submissionId: createdSubmission.id },
          'send_email success'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                emailId: createdEmail.id,
                submissionId: createdSubmission.id,
              }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error }, 'Exception in send_email');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error sending email: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // reply_email - reply to an existing email with proper threading (EMAIL-02)
  server.registerTool(
    'reply_email',
    {
      title: 'Reply to Email',
      description:
        'Reply to an existing email with proper threading (In-Reply-To, References headers). Supports reply-all to include all original recipients.',
      inputSchema: {
        originalEmailId: z.string().describe('ID of the email being replied to'),
        body: z.string().describe('Plain text reply body'),
        htmlBody: z.string().optional().describe('HTML reply body'),
        replyAll: z
          .boolean()
          .default(false)
          .describe('If true, reply to all original recipients'),
        from: z.string().email().optional().describe('Sender email address (uses default if not specified)'),
      },
      annotations: EMAIL_SEND_ANNOTATIONS,
    },
    async ({ originalEmailId, body, htmlBody, replyAll, from }) => {
      logger.debug(
        { originalEmailId, hasBody: !!body, hasHtmlBody: !!htmlBody, replyAll, from },
        'reply_email called'
      );

      try {
        const accountId = jmapClient.getPrimaryAccountId();

        // Step 1: Get identity, mailboxes, and original email in a single batch
        // Use Mailbox/get instead of Mailbox/query because some servers don't support filter by role
        const [identityResult, mailboxResult, originalResult] = await jmapClient.requestSettled((b) => [
          b.call('Identity/get', { accountId }),
          b.call('Mailbox/get', { accountId, properties: ['id', 'role'] }),
          b.call('Email/get', {
            accountId,
            ids: [originalEmailId],
            properties: ['messageId', 'references', 'subject', 'from', 'to', 'cc', 'replyTo'],
          }),
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
                text: 'Failed to get mailboxes. Cannot send reply.',
              },
            ],
          };
        }

        const mailboxes = mailboxResult.value.list;
        const sentMailbox = mailboxes.find((mb) => mb.role === 'sent');
        const draftsMailbox = mailboxes.find((mb) => mb.role === 'drafts');

        const sentMailboxId = sentMailbox?.id;

        if (!draftsMailbox) {
          logger.error({}, 'No Drafts mailbox found');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'No Drafts mailbox found. Cannot send reply.',
              },
            ],
          };
        }
        const draftsMailboxId = draftsMailbox.id;

        // Parse original email response
        if (!originalResult.ok) {
          logger.error({ error: originalResult.error }, 'Failed to get original email');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to fetch original email: ${originalResult.error.description || originalResult.error.type}`,
              },
            ],
          };
        }

        const originalList = originalResult.value.list;

        if (!originalList || originalList.length === 0) {
          logger.error({ originalEmailId }, 'Original email not found');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Original email not found: ${originalEmailId}`,
              },
            ],
          };
        }
        const original = originalList[0];

        // Step 2: Build threading headers (arrays per RFC 8621)
        const inReplyTo: string[] = original.messageId || [];
        const references: string[] = [
          ...(original.references || []),
          ...(original.messageId || []),
        ];

        // Step 3: Build subject with Re: prefix
        let replySubject: string;
        const originalSubject = original.subject || '';
        if (originalSubject.toLowerCase().startsWith('re:')) {
          replySubject = originalSubject;
        } else {
          replySubject = `Re: ${originalSubject}`;
        }

        // Step 4: Build recipients
        // Primary recipient: replyTo if available, otherwise from
        const primaryRecipient = original.replyTo?.[0] || original.from?.[0];
        if (!primaryRecipient) {
          logger.error({}, 'No recipient found in original email');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Original email has no sender address to reply to.',
              },
            ],
          };
        }

        const toAddresses: EmailAddress[] = [primaryRecipient];
        const ccAddresses: EmailAddress[] = [];

        if (replyAll) {
          // Add all original 'to' recipients except self (case-insensitive)
          const selfEmail = identity.email.toLowerCase();
          for (const addr of original.to || []) {
            if (addr.email.toLowerCase() !== selfEmail) {
              // Avoid duplicates with primary recipient
              if (addr.email.toLowerCase() !== primaryRecipient.email.toLowerCase()) {
                toAddresses.push(addr);
              }
            }
          }
          // Add all original 'cc' recipients except self
          for (const addr of original.cc || []) {
            if (addr.email.toLowerCase() !== selfEmail) {
              ccAddresses.push(addr);
            }
          }
        }

        // Step 5: Build textBody/htmlBody for better server compatibility
        let textBody: Array<{ partId: string; type: string }> | undefined;
        let htmlBodyParts: Array<{ partId: string; type: string }> | undefined;
        const bodyValues: Record<string, { value: string }> = {};

        if (body) {
          textBody = [{ partId: 'text', type: 'text/plain' }];
          // Inject signature into plain text body
          const finalBody = signatureContent
            ? appendSignature(body, signatureContent.text, false)
            : body;
          bodyValues.text = { value: finalBody };
        }
        if (htmlBody) {
          htmlBodyParts = [{ partId: 'html', type: 'text/html' }];
          // Inject signature into HTML body
          const finalHtml = signatureContent
            ? appendSignature(htmlBody, signatureContent.html, true)
            : htmlBody;
          bodyValues.html = { value: finalHtml };
        }

        // Step 6: Build email object with sender address priority chain
        // Priority: explicit from parameter > defaultFrom config > identity.email
        const senderEmail = from || defaultFrom || identity.email;
        const senderName = identity.name; // Always use identity name

        const emailCreate: EmailCreate = {
          mailboxIds: { [draftsMailboxId]: true },
          from: [{ name: senderName, email: senderEmail }],
          to: toAddresses,
          subject: replySubject,
          inReplyTo,
          references,
          bodyValues,
        };

        // Add body parts (server will create multipart/alternative if both present)
        if (textBody) {
          emailCreate.textBody = textBody;
        }
        if (htmlBodyParts) {
          emailCreate.htmlBody = htmlBodyParts;
        }

        // Add cc if non-empty
        if (ccAddresses.length > 0) {
          emailCreate.cc = ccAddresses;
        }

        // Step 7: Build onSuccessUpdateEmail for Drafts-to-Sent transition
        const onSuccessUpdate: PatchObject<Email> = {
          'keywords/$draft': null,
        };

        if (sentMailboxId) {
          onSuccessUpdate[`mailboxIds/${draftsMailboxId}`] = null;
          onSuccessUpdate[`mailboxIds/${sentMailboxId}`] = true;
        }

        // Step 8: Create email and submit in single batch
        const refused = await approverFor(server).gate('reply_email', async () => ({ action: 'reply_email', details: [['in_reply_to', [original.from?.[0] ? (original.from[0].name ? `${original.from[0].name} <${original.from[0].email}>` : original.from[0].email) : undefined, original.subject].filter(Boolean).join(' · ')], ...approverFor(server).message(emailCreate)] }));
        if (refused) return refused;
        const [emailResult, submissionResult] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', {
            accountId,
            create: { reply: emailCreate },
          }),
          b.call('EmailSubmission/set', {
            accountId,
            create: {
              submission: {
                identityId: identity.id,
                emailId: '#reply',
              },
            },
            onSuccessUpdateEmail: { '#submission': onSuccessUpdate },
          }),
        ]);

        // Step 9: Check Email/set response
        if (!emailResult.ok) {
          logger.error({ error: emailResult.error }, 'JMAP error in Email/set for reply');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to create reply: ${emailResult.error.description || emailResult.error.type}`,
              },
            ],
          };
        }

        const emailSetResponse = emailResult.value;
        if (emailSetResponse.notCreated?.reply) {
          const error = emailSetResponse.notCreated.reply;
          logger.error({ error }, 'Email/set notCreated for reply');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to create reply: ${error.type} - ${error.description || ''}`,
              },
            ],
          };
        }

        const createdEmail = emailSetResponse.created?.reply;
        if (!createdEmail) {
          logger.error({}, 'No created reply in response');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Failed to create reply: no created email in response',
              },
            ],
          };
        }

        // Step 10: Check EmailSubmission/set response
        if (!submissionResult.ok) {
          logger.error({ error: submissionResult.error }, 'JMAP error in EmailSubmission/set for reply');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to send reply: ${submissionResult.error.description || submissionResult.error.type}`,
              },
            ],
          };
        }

        const submissionSetResponse = submissionResult.value;
        if (submissionSetResponse.notCreated?.submission) {
          const error = submissionSetResponse.notCreated.submission;
          logger.error({ error }, 'EmailSubmission/set notCreated for reply');
          let errorMessage = `Failed to send reply: ${error.type}`;
          if (error.type === 'forbiddenFrom') {
            errorMessage = 'Failed to send reply: You are not authorized to send from this address.';
          } else if (error.type === 'forbiddenToSend') {
            errorMessage = 'Failed to send reply: You do not have permission to send emails.';
          } else if (error.type === 'tooManyRecipients') {
            errorMessage = 'Failed to send reply: Too many recipients specified.';
          } else if (error.description) {
            errorMessage = `Failed to send reply: ${error.type} - ${error.description}`;
          }
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: errorMessage,
              },
            ],
          };
        }

        const createdSubmission = submissionSetResponse.created?.submission;
        if (!createdSubmission) {
          logger.error({}, 'No created submission in response for reply');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Failed to send reply: no submission created in response',
              },
            ],
          };
        }

        logger.debug(
          {
            emailId: createdEmail.id,
            submissionId: createdSubmission.id,
            threadId: createdEmail.threadId,
            inReplyTo,
            references,
          },
          'reply_email success'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                emailId: createdEmail.id,
                submissionId: createdSubmission.id,
                threadId: createdEmail.threadId,
              }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error }, 'Exception in reply_email');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error sending reply: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // forward_email - forward an email to new recipients (FWD-01, FWD-02, FWD-03, FWD-04)
  server.registerTool(
    'forward_email',
    {
      title: 'Forward Email',
      description:
        'Forward an existing email to new recipients. Includes original content as quoted text and preserves all attachments.',
      inputSchema: {
        originalEmailId: z.string().describe('ID of the email to forward'),
        to: z
          .array(z.string().email())
          .min(1)
          .describe('Recipient email addresses (at least one required)'),
        cc: z.array(z.string().email()).optional().describe('CC email addresses'),
        bcc: z.array(z.string().email()).optional().describe('BCC email addresses'),
        note: z.string().optional().describe('Personal note to include above the forwarded content'),
        htmlNote: z.string().optional().describe('HTML version of the personal note'),
        from: z.string().email().optional().describe('Sender email address (uses default if not specified)'),
      },
      annotations: EMAIL_SEND_ANNOTATIONS,
    },
    async ({ originalEmailId, to, cc, bcc, note, htmlNote, from }) => {
      logger.debug(
        { originalEmailId, to, cc, bcc, hasNote: !!note, hasHtmlNote: !!htmlNote, from },
        'forward_email called'
      );

      try {
        const accountId = jmapClient.getPrimaryAccountId();

        // Step 1: Get identity, mailboxes, and original email in a single batch
        const [identityResult, mailboxResult, originalResult] = await jmapClient.requestSettled((b) => [
          b.call('Identity/get', { accountId }),
          b.call('Mailbox/get', { accountId, properties: ['id', 'role'] }),
          b.call('Email/get', {
            accountId,
            ids: [originalEmailId],
            properties: ['subject', 'from', 'to', 'cc', 'sentAt', 'textBody', 'htmlBody', 'bodyValues', 'attachments'],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
            bodyProperties: ['partId', 'blobId', 'type', 'name', 'size', 'disposition', 'cid'],
          }),
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
                text: 'Failed to get mailboxes. Cannot forward email.',
              },
            ],
          };
        }

        const mailboxes = mailboxResult.value.list;
        const sentMailbox = mailboxes.find((mb) => mb.role === 'sent');
        const draftsMailbox = mailboxes.find((mb) => mb.role === 'drafts');

        const sentMailboxId = sentMailbox?.id;

        if (!draftsMailbox) {
          logger.error({}, 'No Drafts mailbox found');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'No Drafts mailbox found. Cannot forward email.',
              },
            ],
          };
        }
        const draftsMailboxId = draftsMailbox.id;

        // Parse original email response
        if (!originalResult.ok) {
          logger.error({ error: originalResult.error }, 'Failed to get original email');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to fetch original email: ${originalResult.error.description || originalResult.error.type}`,
              },
            ],
          };
        }

        const originalList = originalResult.value.list;

        if (!originalList || originalList.length === 0) {
          logger.error({ originalEmailId }, 'Original email not found');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Original email not found: ${originalEmailId}`,
              },
            ],
          };
        }
        const original = originalList[0];

        // Step 2: Build subject with Fwd: prefix (case-insensitive check)
        let forwardSubject: string;
        const originalSubject = original.subject || '';
        if (originalSubject.toLowerCase().startsWith('fwd:')) {
          forwardSubject = originalSubject;
        } else {
          forwardSubject = `Fwd: ${originalSubject}`;
        }

        // Step 3: Extract original email body content
        const originalTextPartId = original.textBody?.[0]?.partId;
        const originalHtmlPartId = original.htmlBody?.[0]?.partId;
        const originalTextBody = originalTextPartId ? original.bodyValues?.[originalTextPartId]?.value || '' : '';
        const originalHtmlBody = originalHtmlPartId ? original.bodyValues?.[originalHtmlPartId]?.value || '' : '';

        // Format original sender info for quoted header
        const originalFrom = original.from?.[0];
        const originalFromStr = originalFrom
          ? originalFrom.name
            ? `${originalFrom.name} <${originalFrom.email}>`
            : originalFrom.email
          : 'Unknown';
        const originalToStr = (original.to || [])
          .map((addr) => (addr.name ? `${addr.name} <${addr.email}>` : addr.email))
          .join(', ') || 'Unknown';
        const originalDate = original.sentAt
          ? new Date(original.sentAt).toLocaleString()
          : 'Unknown date';

        // Step 4: Build quoted forwarded content
        const forwardHeader = `---------- Forwarded message ---------
From: ${originalFromStr}
Date: ${originalDate}
Subject: ${originalSubject}
To: ${originalToStr}`;

        // Plain text version
        let plainTextBody = note ? `${note}\n\n` : '';
        plainTextBody += `${forwardHeader}\n\n${originalTextBody}`;

        // HTML version with styling
        const htmlForwardHeader = `<div style="border-left: 2px solid #ccc; padding-left: 10px; margin-left: 5px; color: #666;">
<p>---------- Forwarded message ---------<br/>
From: ${escapeHtml(originalFromStr)}<br/>
Date: ${escapeHtml(originalDate)}<br/>
Subject: ${escapeHtml(originalSubject)}<br/>
To: ${escapeHtml(originalToStr)}</p>
${originalHtmlBody || `<p>${escapeHtml(originalTextBody).replace(/\n/g, '<br/>')}</p>`}
</div>`;

        let htmlBodyContent = htmlNote ? `<div>${htmlNote}</div><br/>` : (note ? `<p>${escapeHtml(note).replace(/\n/g, '<br/>')}</p><br/>` : '');
        htmlBodyContent += htmlForwardHeader;

        // Step 5: Apply signature if configured
        if (signatureContent) {
          plainTextBody = appendSignature(plainTextBody, signatureContent.text, false);
          htmlBodyContent = appendSignature(htmlBodyContent, signatureContent.html, true);
        }

        // Step 6: Build email object with sender address priority chain
        // Priority: explicit from parameter > defaultFrom config > identity.email
        const senderEmail = from || defaultFrom || identity.email;
        const senderName = identity.name; // Always use identity name

        // Build email object with textBody/htmlBody
        // Note: We use textBody/htmlBody + attachments property instead of bodyStructure
        // because Apache James ignores bodyValues when bodyStructure is present
        const attachments = original.attachments || [];

        const bodyValues: Record<string, { value: string }> = {
          text: { value: plainTextBody },
          html: { value: htmlBodyContent },
        };

        const emailCreate: EmailCreate = {
          mailboxIds: { [draftsMailboxId]: true },
          from: [{ name: senderName, email: senderEmail }],
          to: (to as string[]).map(toAddress),
          subject: forwardSubject,
          bodyValues,
          textBody: [{ partId: 'text', type: 'text/plain' }],
          htmlBody: [{ partId: 'html', type: 'text/html' }],
        };

        // Add attachments if present (reference original blobs)
        if (attachments.length > 0) {
          emailCreate.attachments = attachments.map((att, index) => ({
            blobId: att.blobId as string,
            type: att.type,
            name: att.name || `attachment-${index + 1}`,
          }));
        }

        // Add optional address fields
        if (cc && (cc as string[]).length > 0) {
          emailCreate.cc = (cc as string[]).map(toAddress);
        }
        if (bcc && (bcc as string[]).length > 0) {
          emailCreate.bcc = (bcc as string[]).map(toAddress);
        }

        // Note: Unlike reply_email, forward does NOT include inReplyTo or references headers

        // Step 7: Build onSuccessUpdateEmail for Drafts-to-Sent transition
        const onSuccessUpdate: PatchObject<Email> = {
          'keywords/$draft': null,
        };

        if (sentMailboxId) {
          onSuccessUpdate[`mailboxIds/${draftsMailboxId}`] = null;
          onSuccessUpdate[`mailboxIds/${sentMailboxId}`] = true;
        }

        // Step 8: Create email and submit in single batch
        const refused = await approverFor(server).gate('forward_email', async () => ({ action: 'forward_email', details: [['email', [original.from?.[0] ? (original.from[0].name ? `${original.from[0].name} <${original.from[0].email}>` : original.from[0].email) : undefined, original.subject].filter(Boolean).join(' · ')], ...approverFor(server).message(emailCreate)] }));
        if (refused) return refused;
        const [emailResult, submissionResult] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', {
            accountId,
            create: { forward: emailCreate },
          }),
          b.call('EmailSubmission/set', {
            accountId,
            create: {
              submission: {
                identityId: identity.id,
                emailId: '#forward',
              },
            },
            onSuccessUpdateEmail: { '#submission': onSuccessUpdate },
          }),
        ]);

        // Step 9: Check Email/set response
        if (!emailResult.ok) {
          logger.error({ error: emailResult.error }, 'JMAP error in Email/set for forward');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to create forwarded email: ${emailResult.error.description || emailResult.error.type}`,
              },
            ],
          };
        }

        const emailSetResponse = emailResult.value;
        if (emailSetResponse.notCreated?.forward) {
          const error = emailSetResponse.notCreated.forward;
          logger.error({ error }, 'Email/set notCreated for forward');

          // Handle blobNotFound error for attachments
          if (error.type === 'blobNotFound') {
            const missingCount = attachments.length;
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Forward failed: Some attachments are no longer available (${missingCount} attachment${missingCount !== 1 ? 's' : ''} missing). The original email may have been modified or deleted.`,
                },
              ],
            };
          }

          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to create forwarded email: ${error.type} - ${error.description || ''}`,
              },
            ],
          };
        }

        const createdEmail = emailSetResponse.created?.forward;
        if (!createdEmail) {
          logger.error({}, 'No created forward in response');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Failed to create forwarded email: no created email in response',
              },
            ],
          };
        }

        // Step 10: Check EmailSubmission/set response
        if (!submissionResult.ok) {
          logger.error({ error: submissionResult.error }, 'JMAP error in EmailSubmission/set for forward');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to send forwarded email: ${submissionResult.error.description || submissionResult.error.type}`,
              },
            ],
          };
        }

        const submissionSetResponse = submissionResult.value;
        if (submissionSetResponse.notCreated?.submission) {
          const error = submissionSetResponse.notCreated.submission;
          logger.error({ error }, 'EmailSubmission/set notCreated for forward');
          let errorMessage = `Failed to send forwarded email: ${error.type}`;
          if (error.type === 'forbiddenFrom') {
            errorMessage = 'Failed to send forwarded email: You are not authorized to send from this address.';
          } else if (error.type === 'forbiddenToSend') {
            errorMessage = 'Failed to send forwarded email: You do not have permission to send emails.';
          } else if (error.type === 'tooManyRecipients') {
            errorMessage = 'Failed to send forwarded email: Too many recipients specified.';
          } else if (error.description) {
            errorMessage = `Failed to send forwarded email: ${error.type} - ${error.description}`;
          }
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: errorMessage,
              },
            ],
          };
        }

        const createdSubmission = submissionSetResponse.created?.submission;
        if (!createdSubmission) {
          logger.error({}, 'No created submission in response for forward');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Failed to send forwarded email: no submission created in response',
              },
            ],
          };
        }

        // Step 11: Mark original email with $forwarded keyword (non-blocking)
        try {
          await jmapClient.call('Email/set', {
            accountId,
            update: {
              [originalEmailId as string]: { 'keywords/$forwarded': true },
            },
          });
        } catch (markError) {
          // Log warning but don't fail the forward
          logger.warn({ error: markError, originalEmailId }, 'Failed to mark original email as forwarded');
        }

        logger.debug(
          {
            emailId: createdEmail.id,
            submissionId: createdSubmission.id,
            attachmentCount: attachments.length,
          },
          'forward_email success'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                emailId: createdEmail.id,
                submissionId: createdSubmission.id,
              }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error }, 'Exception in forward_email');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error forwarding email: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  logger.debug('Email sending tools registered: send_email, reply_email, forward_email');
}

/**
 * Escape HTML special characters.
 * @param text Text to escape
 * @returns HTML-escaped text
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
