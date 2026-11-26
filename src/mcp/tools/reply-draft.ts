/**
 * reply_draft - prepare a reply as a draft (nothing is sent): Re: subject, threading headers,
 * recipients of the original, the configured signature, then the quoted original.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EmailCreate } from '@linagora/jmap-client-ts';
import { errorText, type JmapClient } from '../../jmap/client.js';
import type { Logger } from '../../config/logger.js';
import type { SignatureContent } from '../../signature/index.js';
import { approverFor } from '../approval.js';
import { buildDraftBody } from './draft-body.js';
import { buildQuote } from './quote.js';
import { draftFiles, promptFiles, uploadFiles, type DraftFileOptions, type LocalFile } from './files.js';
import { describeOriginal, ORIGINAL_PROPERTIES, replyRecipients, replySubject, threadingHeaders, type Original } from './reply.js';

type Part = { partId: string | null; type: string };
type OriginalWithBody = Original & { textBody?: Part[]; htmlBody?: Part[]; bodyValues?: Record<string, { value: string }> };

const fail = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

/** The original's plain text and HTML, each only when the server has that part. */
function bodies(o: OriginalWithBody): { text?: string; html?: string } {
  const value = (parts: Part[] | undefined, type: string) => {
    const part = parts?.find((p) => p.type === type);
    return part ? o.bodyValues?.[part.partId ?? '']?.value : undefined;
  };
  return { text: value(o.textBody, 'text/plain'), html: value(o.htmlBody, 'text/html') };
}

export function registerReplyDraftTool(
  server: McpServer,
  jmapClient: JmapClient,
  logger: Logger,
  signatureContent?: SignatureContent,
  fileOptions?: DraftFileOptions
): void {
  server.registerTool(
    'reply_draft',
    {
      title: 'Prepare a Reply Draft',
      description:
        'Prepare a reply as a draft (nothing is sent): Re: subject, threading headers, recipients of the original (replyAll for all), ' +
        'the configured signature, then the quoted original ("On …, X wrote:"). Use this rather than create_draft to answer an e-mail.',
      inputSchema: {
        originalEmailId: z.string().describe('ID of the e-mail to answer'),
        body: z.string().optional().describe('Plain text of the reply, without signature or quote'),
        htmlBody: z.string().optional().describe('HTML fragment of the reply, without signature or quote'),
        replyAll: z.boolean().default(false).describe('Also answer the original To and Cc (never yourself)'),
        quote: z.boolean().default(true).describe('Quote the original below the signature (default true)'),
        signature: z.boolean().default(true).describe('Append the configured signature (default true)'),
        attachments: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('Files to attach: paths inside the upload folder (JMAP_UPLOAD_DIR, by default the Uploads folder inside the download folder), relative to it or absolute'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ originalEmailId, body, htmlBody, replyAll, quote, signature, attachments }) => {
      logger.debug({ originalEmailId, hasBody: !!body, hasHtmlBody: !!htmlBody, replyAll, quote, signature }, 'reply_draft called');
      if (!body && !htmlBody) return fail('Give body or htmlBody: the text of the reply, without signature or quote.');

      try {
        const accountId = jmapClient.getPrimaryAccountId();
        let files: LocalFile[] = [];
        if (attachments?.length) {
          try {
            files = await draftFiles(await jmapClient.getSession(), fileOptions, attachments);
          } catch (error) {
            return fail((error as Error).message);
          }
        }
        const [mailboxes, got] = await jmapClient.requestSettled((b) => [
          b.call('Mailbox/get', { accountId, properties: ['id', 'role'] }),
          b.call('Email/get', {
            accountId,
            ids: [originalEmailId],
            properties: [...ORIGINAL_PROPERTIES, 'textBody', 'htmlBody', 'bodyValues'],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
          }),
        ]);
        if (!mailboxes.ok) return fail('Failed to get mailboxes');
        const drafts = mailboxes.value.list.find((m) => m.role === 'drafts');
        const original: OriginalWithBody | undefined = got.ok ? got.value.list[0] : undefined;
        if (!original) return fail(`Original email not found: ${originalEmailId}`);
        if (!drafts) return fail('No Drafts mailbox found. Cannot create draft.');

        // Without the submission capability there is no identity: no From, and reply-all keeps every address
        let identity: { email: string; name?: string | null } | undefined;
        try {
          identity = (await jmapClient.call('Identity/get', { accountId })).list[0];
        } catch {
          logger.debug('Could not fetch identity for reply_draft - will create without from field');
        }

        const recipients = replyRecipients(original, identity?.email, replyAll);
        if (!recipients) return fail('Original email has no sender address to reply to.');

        const { language, timeZone } = approverFor(server).opts;
        const emailCreate: Record<string, unknown> = {
          mailboxIds: { [drafts.id]: true },
          keywords: { $draft: true, $seen: true },
          subject: replySubject(original.subject),
          to: recipients.to,
          ...buildDraftBody({
            body,
            htmlBody,
            signature: signatureContent,
            includeSignature: signature !== false,
            quote: quote === false ? undefined : buildQuote({ ...original, ...bodies(original) }, { language, timeZone }),
          }),
        };
        if (identity) emailCreate.from = [{ email: identity.email, name: identity.name }];
        if (recipients.cc.length) emailCreate.cc = recipients.cc;
        const headers = threadingHeaders(original);
        if (headers.inReplyTo.length) emailCreate.inReplyTo = headers.inReplyTo;
        if (headers.references.length) emailCreate.references = headers.references;

        const refused = await approverFor(server).gate('reply_draft', async () => ({
          action: 'reply_draft',
          details: [
            ['in_reply_to', describeOriginal(original)],
            ...approverFor(server).message(files.length ? { ...emailCreate, attachments: promptFiles(files) } : emailCreate),
          ],
        }));
        if (refused) return refused;
        if (files.length) emailCreate.attachments = await uploadFiles(jmapClient, files);

        // EmailCreate wants a name with every address: the recipients go as the original had them
        const [result] = await jmapClient.requestSettled((b) => [
          b.call('Email/set', { accountId, create: { draft: emailCreate as unknown as EmailCreate } }),
        ]);
        if (!result.ok) return fail(`Failed to create draft: ${errorText(result.error)}`);
        const set = result.value;
        const notCreated = set.notCreated?.draft;
        if (notCreated) return fail(`Failed to create draft: ${notCreated.type} - ${notCreated.description || ''}`);
        const created = set.created?.draft;
        if (!created) return fail('Failed to create draft: no created email in response');

        logger.debug({ draftId: created.id }, 'reply_draft success');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, draftId: created.id, threadId: created.threadId, to: recipients.to, cc: recipients.cc }),
            },
          ],
        };
      } catch (error) {
        logger.error({ error }, 'Exception in reply_draft');
        return fail(`Error creating reply draft: ${errorText(error)}`);
      }
    }
  );
}
