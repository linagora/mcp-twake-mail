/**
 * Tests for attachment MCP tool - get_attachments.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { registerAttachmentTools, isInlineAttachment } from './attachment.js';
import { setApprover } from '../approval.js';
import { createFakeJmap, type FakeJmap } from '../../testing/fake-jmap.js';
import type { Logger } from '../../config/logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock types
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

describe('isInlineAttachment', () => {
  it('returns true when has cid and disposition is null', () => {
    expect(isInlineAttachment({ cid: 'img123', disposition: null })).toBe(true);
  });

  it('returns true when has cid and disposition is undefined', () => {
    expect(isInlineAttachment({ cid: 'img123' })).toBe(true);
  });

  it('returns true when has cid and disposition is inline', () => {
    expect(isInlineAttachment({ cid: 'img123', disposition: 'inline' })).toBe(true);
  });

  it('returns false when has cid but disposition is attachment', () => {
    expect(isInlineAttachment({ cid: 'img123', disposition: 'attachment' })).toBe(false);
  });

  it('returns false when no cid (even if disposition is inline)', () => {
    expect(isInlineAttachment({ disposition: 'inline' })).toBe(false);
  });

  it('returns false when no cid and disposition is attachment', () => {
    expect(isInlineAttachment({ disposition: 'attachment' })).toBe(false);
  });

  it('returns false when both cid and disposition are undefined', () => {
    expect(isInlineAttachment({})).toBe(false);
  });

  it('returns false when cid is empty string', () => {
    expect(isInlineAttachment({ cid: '', disposition: 'inline' })).toBe(false);
  });
});

describe('registerAttachmentTools', () => {
  let mockServer: McpServer;
  let mockJmapClient: FakeJmap;
  let mockLogger: Logger;
  let registeredTools: Map<string, ToolHandler>;

  beforeEach(async () => {
    registeredTools = new Map();

    // Mock MCP server
    mockServer = {
      registerTool: vi.fn((name: string, _options: unknown, handler: ToolHandler) => {
        registeredTools.set(name, handler);
      }),
    } as unknown as McpServer;

    // Mock JMAP client
    mockJmapClient = await createFakeJmap();

    // Mock logger (silent)
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    // Register all tools
    setApprover(mockServer, { mode: 'client', language: 'en', timeoutMs: 1000 });
    registerAttachmentTools(mockServer, mockJmapClient.client, mockLogger);
  });

  describe('get_attachments', () => {
    it('returns multiple attachments with mixed inline/regular types', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/get',
            {
              accountId: 'account-1',
              list: [
                {
                  id: 'email-1',
                  attachments: [
                    {
                      blobId: 'blob-1',
                      name: 'document.pdf',
                      type: 'application/pdf',
                      size: 102400,
                      disposition: 'attachment',
                      cid: null,
                    },
                    {
                      blobId: 'blob-2',
                      name: 'logo.png',
                      type: 'image/png',
                      size: 5120,
                      disposition: 'inline',
                      cid: 'logo123',
                    },
                    {
                      blobId: 'blob-3',
                      name: 'photo.jpg',
                      type: 'image/jpeg',
                      size: 25600,
                      disposition: null,
                      cid: null,
                    },
                  ],
                },
              ],
            },
            'getAttachments',
          ],
        ],
      });

      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.emailId).toBe('email-1');
      expect(parsed.total).toBe(3);
      expect(parsed.filtered).toBe(3);
      expect(parsed.attachments).toHaveLength(3);

      // Check isInline detection
      expect(parsed.attachments[0].isInline).toBe(false); // PDF with disposition=attachment
      expect(parsed.attachments[1].isInline).toBe(true); // PNG with cid and disposition=inline
      expect(parsed.attachments[2].isInline).toBe(false); // JPG with no cid
    });

    it('returns empty array when email has no attachments', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/get',
            {
              accountId: 'account-1',
              list: [{ id: 'email-1', attachments: [] }],
            },
            'getAttachments',
          ],
        ],
      });

      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.attachments).toEqual([]);
      expect(parsed.total).toBe(0);
      expect(parsed.filtered).toBe(0);
    });

    it('returns empty array when attachments property is undefined', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/get',
            {
              accountId: 'account-1',
              list: [{ id: 'email-1' }], // No attachments property
            },
            'getAttachments',
          ],
        ],
      });

      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.attachments).toEqual([]);
      expect(parsed.total).toBe(0);
    });

    it('returns error when email is not found', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/get',
            {
              accountId: 'account-1',
              list: [],
              notFound: ['email-999'],
            },
            'getAttachments',
          ],
        ],
      });

      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-999' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Email not found: email-999');
    });

    it('returns error on JMAP method error', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [['error', { type: 'serverError', description: 'Internal error' }, 'getAttachments']],
      });

      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to retrieve attachments');
      expect(result.content[0].text).toContain('Internal error');
    });
  });

  describe('excludeInline filter', () => {
    beforeEach(() => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/get',
            {
              accountId: 'account-1',
              list: [
                {
                  id: 'email-1',
                  attachments: [
                    {
                      blobId: 'blob-1',
                      name: 'document.pdf',
                      type: 'application/pdf',
                      size: 102400,
                      disposition: 'attachment',
                      cid: null,
                    },
                    {
                      blobId: 'blob-2',
                      name: 'inline-image.png',
                      type: 'image/png',
                      size: 5120,
                      disposition: 'inline',
                      cid: 'img123',
                    },
                  ],
                },
              ],
            },
            'getAttachments',
          ],
        ],
      });
    });

    it('excludes inline attachments when excludeInline is true', async () => {
      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-1', excludeInline: true });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.total).toBe(2);
      expect(parsed.filtered).toBe(1);
      expect(parsed.attachments).toHaveLength(1);
      expect(parsed.attachments[0].name).toBe('document.pdf');
    });

    it('includes all attachments when excludeInline is false', async () => {
      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-1', excludeInline: false });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.total).toBe(2);
      expect(parsed.filtered).toBe(2);
      expect(parsed.attachments).toHaveLength(2);
    });
  });

  describe('mimeTypeFilter', () => {
    beforeEach(() => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/get',
            {
              accountId: 'account-1',
              list: [
                {
                  id: 'email-1',
                  attachments: [
                    { blobId: 'blob-1', name: 'doc.pdf', type: 'application/pdf', size: 1000 },
                    { blobId: 'blob-2', name: 'photo.jpg', type: 'image/jpeg', size: 2000 },
                    { blobId: 'blob-3', name: 'logo.png', type: 'image/png', size: 3000 },
                    { blobId: 'blob-4', name: 'data.xlsx', type: 'application/vnd.ms-excel', size: 4000 },
                  ],
                },
              ],
            },
            'getAttachments',
          ],
        ],
      });
    });

    it('filters by MIME type prefix (image/)', async () => {
      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-1', mimeTypeFilter: 'image/' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.total).toBe(4);
      expect(parsed.filtered).toBe(2);
      expect(parsed.attachments.map((a: { name: string }) => a.name)).toEqual(['photo.jpg', 'logo.png']);
    });

    it('filters by exact MIME type (application/pdf)', async () => {
      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-1', mimeTypeFilter: 'application/pdf' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.total).toBe(4);
      expect(parsed.filtered).toBe(1);
      expect(parsed.attachments[0].name).toBe('doc.pdf');
    });

    it('returns all attachments when no filter provided', async () => {
      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-1' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.total).toBe(4);
      expect(parsed.filtered).toBe(4);
    });
  });

  describe('combined filters', () => {
    it('applies both excludeInline and mimeTypeFilter together', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/get',
            {
              accountId: 'account-1',
              list: [
                {
                  id: 'email-1',
                  attachments: [
                    { blobId: 'blob-1', name: 'doc.pdf', type: 'application/pdf', size: 1000 },
                    { blobId: 'blob-2', name: 'inline-logo.png', type: 'image/png', size: 2000, cid: 'logo', disposition: 'inline' },
                    { blobId: 'blob-3', name: 'attached-photo.jpg', type: 'image/jpeg', size: 3000 },
                  ],
                },
              ],
            },
            'getAttachments',
          ],
        ],
      });

      const handler = registeredTools.get('get_attachments')!;
      const result = await handler({ emailId: 'email-1', excludeInline: true, mimeTypeFilter: 'image/' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.total).toBe(3);
      expect(parsed.filtered).toBe(1); // Only non-inline image
      expect(parsed.attachments[0].name).toBe('attached-photo.jpg');
    });
  });

  describe('download_attachment', () => {
    const previousHome = process.env.HOME;
    const size = 800 * 1024;
    let home: string;

    const download = async (args: Record<string, unknown>) =>
      registeredTools.get('download_attachment')!({ blobId: 'blob-1', ...args });
    const savedTo = async (args: Record<string, unknown>): Promise<string> =>
      JSON.parse((await download(args)).content[0].text).savedTo;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'attachment-test-'));
      process.env.HOME = home;
      mockJmapClient.serveBlob.mockImplementation(async () => new ArrayBuffer(size));
    });

    afterEach(() => {
      process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    });

    it('returns a small blob inline, downloaded with the default name and type', async () => {
      mockJmapClient.serveBlob.mockResolvedValue(new TextEncoder().encode('hello').buffer as ArrayBuffer);

      const result = await download({});

      expect(mockJmapClient.serveBlob).toHaveBeenCalledWith('blob-1', 'attachment', 'application/octet-stream');
      expect(JSON.parse(result.content[0].text)).toEqual({
        blobId: 'blob-1',
        name: 'attachment',
        mimeType: 'application/octet-stream',
        size: 5,
        data: Buffer.from('hello').toString('base64'),
      });
      expect(existsSync(join(home, 'Downloads'))).toBe(false);
    });

    it('keeps the file in ~/Downloads whatever the name', async () => {
      expect(await savedTo({ name: '../outside/file.bin' })).toBe(join(home, 'Downloads', 'file.bin'));
      expect(existsSync(join(home, 'outside'))).toBe(false);
    });

    it('ignores an absolute name', async () => {
      expect(await savedTo({ name: join(home, 'outside.bin') })).toBe(join(home, 'Downloads', 'outside.bin'));
      expect(existsSync(join(home, 'outside.bin'))).toBe(false);
    });

    it('ignores a path given by the caller', async () => {
      const target = join(home, 'target.bin');

      expect(await savedTo({ name: 'a.bin', saveToPath: target })).toBe(join(home, 'Downloads', 'a.bin'));
      expect(existsSync(target)).toBe(false);
    });

    it('does not overwrite an existing file', async () => {
      const first = await savedTo({ name: 'a.pdf' });
      writeFileSync(first, 'mine');

      const second = await savedTo({ name: 'a.pdf' });

      expect(readFileSync(first, 'utf8')).toBe('mine');
      expect(basename(second)).toMatch(/^a-.+\.pdf$/);
      expect(statSync(second).size).toBe(size);
    });

    it('does not write through a symbolic link', async () => {
      const target = join(home, 'target');
      writeFileSync(target, 'mine');
      await savedTo({ name: 'first.bin' });
      symlinkSync(target, join(home, 'Downloads', 'link'));

      await savedTo({ name: 'link' });

      expect(readFileSync(target, 'utf8')).toBe('mine');
    });

    it('writes private files', async () => {
      const first = await savedTo({ name: 'a.bin' });
      const second = await savedTo({ name: 'a.bin' });

      expect(statSync(first).mode & 0o777).toBe(0o600);
      expect(statSync(second).mode & 0o777).toBe(0o600);
    });

    it.each([
      ['a\nb.txt', 'a_b.txt'],
      [`a${String.fromCodePoint(0x202e)}b.txt`, 'a_b.txt'],
    ])('replaces control and direction characters in %j', async (name, expected) => {
      expect(await savedTo({ name })).toBe(join(home, 'Downloads', expected));
    });

    it.each([
      `a${String.fromCodePoint(0x200c)}b.txt`,
      `a${String.fromCodePoint(0x200d)}b.txt`,
    ])('keeps the joiner in %j', async (name) => {
      expect(await savedTo({ name })).toBe(join(home, 'Downloads', name));
    });

    it('falls back on a default for an empty name', async () => {
      expect(await savedTo({ name: '' })).toBe(join(home, 'Downloads', 'attachment'));
    });

    it.each([' ', '.', '..', '../..', '/', 'a/..'])('refuses the name %j', async (name) => {
      const result = await download({ name });

      expect(result.isError).toBe(true);
      expect(mockJmapClient.serveBlob).not.toHaveBeenCalled();
    });

    it('declares that it writes', () => {
      const calls = vi.mocked(mockServer.registerTool).mock.calls as unknown as Array<
        [string, { annotations: Record<string, boolean>; inputSchema: object }]
      >;
      const config = calls.find(([name]) => name === 'download_attachment')![1];

      expect(config.annotations.readOnlyHint).toBe(false);
      expect(config.annotations.destructiveHint).toBe(false);
      expect(config.inputSchema).not.toHaveProperty('saveToPath');
    });

    it('reports a failed download', async () => {
      mockJmapClient.serveBlob.mockRejectedValue(new Error('boom'));

      const result = await registeredTools.get('download_attachment')!({ blobId: 'blob-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error downloading attachment: boom');
    });
  });

  describe('tool registration', () => {
    it('registers get_attachments tool', () => {
      expect(registeredTools.has('get_attachments')).toBe(true);
      expect(registeredTools.has('download_attachment')).toBe(true);
      expect(registeredTools.size).toBe(2);
    });
  });
});
