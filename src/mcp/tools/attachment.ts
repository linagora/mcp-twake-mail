/**
 * Attachment MCP tools - get_attachments, download_attachment.
 * Enables AI assistants to list and download email attachments.
 */
import { z } from 'zod';
import { writeFile, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { basename, extname, join, resolve } from 'path';
import { homedir } from 'os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { JMAPClient } from '../../jmap/client.js';
import type { Logger } from '../../config/logger.js';
import { approverFor } from '../approval.js';

/** Maximum size for inline base64 response (750KB to stay under 1MB limit with overhead) */
const MAX_INLINE_SIZE = 750 * 1024;

/**
 * Metadata for a single attachment.
 */
export interface AttachmentMetadata {
  blobId: string;
  name: string | null;
  type: string;
  size: number;
  isInline: boolean;
}

/**
 * JMAP body part structure from Email/get response.
 */
interface JMAPBodyPart {
  blobId: string;
  name?: string | null;
  type: string;
  size: number;
  disposition?: string | null;
  cid?: string | null;
}

/**
 * Common annotations for read-only attachment tools.
 */
const ATTACHMENT_READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * download_attachment writes to the disk for large files, after the user's approval.
 */
const ATTACHMENT_DOWNLOAD_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * File name for an attachment: its last path segment, without control or
 * direction-changing characters. Zero-width joiners stay: Persian words and
 * emoji sequences need them, and they only join the characters around them.
 * @returns The name, or null if nothing usable remains
 */
function toFilename(name: string | undefined): string | null {
  if (!name) {
    return 'attachment';
  }
  const filename = basename(name.replace(/(?!\p{Join_Control})[\p{Cc}\p{Cf}]/gu, '_')).trim();
  return filename === '' || filename === '.' || filename === '..' ? null : filename;
}

/**
 * Write a new private file in dir, under a unique name if this one is taken.
 * The wx flag also refuses to follow a symbolic link left at that path.
 * @returns The path written
 */
async function writeNewFile(dir: string, filename: string, data: Buffer): Promise<string> {
  const path = join(dir, filename);
  try {
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const extension = extname(filename);
  const uniquePath = join(dir, `${basename(filename, extension)}-${randomUUID()}${extension}`);
  await writeFile(uniquePath, data, { flag: 'wx', mode: 0o600 });
  return uniquePath;
}

/**
 * Determine if an attachment is inline based on RFC 8621 algorithm.
 * isInline = has cid AND disposition !== 'attachment'
 * @param part The body part to check
 * @returns true if the attachment is inline
 */
export function isInlineAttachment(part: { cid?: string | null; disposition?: string | null }): boolean {
  return !!part.cid && part.disposition !== 'attachment';
}

/**
 * Transform a JMAP body part to AttachmentMetadata.
 * @param part JMAP body part from attachments array
 * @returns AttachmentMetadata with isInline flag
 */
function transformAttachment(part: JMAPBodyPart): AttachmentMetadata {
  return {
    blobId: part.blobId,
    name: part.name ?? null,
    type: part.type,
    size: part.size,
    isInline: isInlineAttachment(part),
  };
}

/**
 * Filter attachments based on optional criteria.
 * @param attachments List of attachment metadata
 * @param excludeInline If true, remove inline attachments
 * @param mimeTypeFilter If provided, only include attachments matching this MIME type prefix
 * @returns Filtered list of attachments
 */
function filterAttachments(
  attachments: AttachmentMetadata[],
  excludeInline?: boolean,
  mimeTypeFilter?: string
): AttachmentMetadata[] {
  return attachments.filter((att) => {
    if (excludeInline && att.isInline) return false;
    if (mimeTypeFilter && !att.type.startsWith(mimeTypeFilter)) return false;
    return true;
  });
}

export interface AttachmentOptions {
  /** Where download_attachment saves files (JMAP_DOWNLOAD_DIR); `~` is the home folder. Default ~/Downloads. */
  downloadDir?: string;
}

/** The download folder, resolved when a file is saved: `~` stands for the home folder. */
function downloadFolder(dir: string | undefined): string {
  if (!dir) return join(homedir(), 'Downloads');
  if (dir === '~' || dir.startsWith('~/')) return join(homedir(), dir.slice(1));
  return resolve(dir);
}

/**
 * Register attachment MCP tools with the server.
 * @param server MCP server instance
 * @param jmapClient JMAP client for API calls
 * @param logger Pino logger
 */
export function registerAttachmentTools(
  server: McpServer,
  jmapClient: JMAPClient,
  logger: Logger,
  options: AttachmentOptions = {}
): void {
  // get_attachments - list attachment metadata for an email (ATTACH-01, ATTACH-02)
  server.registerTool(
    'get_attachments',
    {
      title: 'Get Attachments',
      description:
        'List all attachments for an email with metadata (blobId, name, type, size, isInline). Supports filtering by excludeInline and mimeTypeFilter.',
      inputSchema: {
        emailId: z.string().describe('The unique identifier of the email to get attachments from'),
        excludeInline: z
          .boolean()
          .optional()
          .default(false)
          .describe('Exclude inline attachments (images embedded in HTML body)'),
        mimeTypeFilter: z
          .string()
          .optional()
          .describe('Filter by MIME type prefix (e.g., "image/", "application/pdf")'),
      },
      annotations: ATTACHMENT_READ_ANNOTATIONS,
    },
    async ({ emailId, excludeInline, mimeTypeFilter }) => {
      logger.debug({ emailId, excludeInline, mimeTypeFilter }, 'get_attachments called');

      try {
        const session = jmapClient.getSession();
        const response = await jmapClient.request([
          [
            'Email/get',
            {
              accountId: session.accountId,
              ids: [emailId],
              properties: ['attachments'],
              bodyProperties: ['blobId', 'name', 'type', 'size', 'disposition', 'cid'],
            },
            'getAttachments',
          ],
        ]);

        const result = jmapClient.parseMethodResponse(response.methodResponses[0]);
        if (!result.success) {
          logger.error({ error: result.error, emailId }, 'JMAP error in get_attachments');
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to retrieve attachments: ${result.error?.description || result.error?.type || 'Unknown error'}`,
              },
            ],
          };
        }

        const emails = result.data?.list as Array<{ id: string; attachments?: JMAPBodyPart[] }>;
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

        // Get attachments array (may be empty or undefined)
        const rawAttachments = emails[0].attachments || [];

        // Transform all attachments to metadata
        const allAttachments = rawAttachments.map(transformAttachment);
        const totalCount = allAttachments.length;

        // Apply filters
        const filteredAttachments = filterAttachments(allAttachments, excludeInline, mimeTypeFilter);
        const filteredCount = filteredAttachments.length;

        logger.debug(
          { emailId, total: totalCount, filtered: filteredCount },
          'get_attachments success'
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  emailId,
                  attachments: filteredAttachments,
                  total: totalCount,
                  filtered: filteredCount,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        logger.error({ error, emailId }, 'Exception in get_attachments');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error retrieving attachments: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // download_attachment - download attachment content (ATTACH-03)
  server.registerTool(
    'download_attachment',
    {
      title: 'Download Attachment',
      description:
        'Download an attachment by its blobId. Small files (< 750KB) are returned as base64, unless save is true. Large files, and any file with save: true, are saved in the download folder after the user approves, and the path is returned: use save: true to keep a file, for example to upload it to Twake Drive.',
      inputSchema: {
        blobId: z.string().describe('The blob ID of the attachment to download (from get_attachments)'),
        name: z.string().optional().describe('Filename for the attachment'),
        type: z.string().optional().describe('MIME type of the attachment'),
        save: z
          .boolean()
          .optional()
          .default(false)
          .describe('Save the file in the download folder whatever its size, and return its path instead of its content'),
      },
      annotations: ATTACHMENT_DOWNLOAD_ANNOTATIONS,
    },
    async ({ blobId, name, type, save }) => {
      logger.debug({ blobId, name, type, save }, 'download_attachment called');

      try {
        const filename = toFilename(name);
        if (filename === null) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Invalid attachment name: ${name}`,
              },
            ],
          };
        }

        // Download the blob
        const data = await jmapClient.downloadBlob(blobId, filename, type);
        const buffer = Buffer.from(data);

        logger.debug(
          { blobId, size: data.byteLength, maxInline: MAX_INLINE_SIZE },
          'download_attachment downloaded'
        );

        // Decide whether to return inline or save to disk
        if (save || data.byteLength > MAX_INLINE_SIZE) {
          const downloadDir = downloadFolder(options.downloadDir);
          const refused = await approverFor(server).gate('download_attachment', () => ({
            action: 'download_attachment',
            details: [
              ['attachments', filename],
              ['destination', downloadDir],
            ],
          }));
          if (refused) return refused;

          await mkdir(downloadDir, { recursive: true });
          const outputPath = await writeNewFile(downloadDir, filename, buffer);

          logger.debug(
            { blobId, size: data.byteLength, path: outputPath },
            'download_attachment saved to disk'
          );

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    blobId,
                    name: filename,
                    mimeType: type || 'application/octet-stream',
                    size: data.byteLength,
                    savedTo: outputPath,
                    message: `File saved to ${outputPath}${save ? '' : ' (too large for inline response)'}`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          // Return inline as base64
          const base64 = buffer.toString('base64');

          logger.debug(
            { blobId, size: data.byteLength },
            'download_attachment returning inline'
          );

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    blobId,
                    name: filename,
                    mimeType: type || 'application/octet-stream',
                    size: data.byteLength,
                    data: base64,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } catch (error) {
        logger.error({ error, blobId }, 'Exception in download_attachment');
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Error downloading attachment: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  logger.debug('Attachment tools registered: get_attachments, download_attachment');
}
