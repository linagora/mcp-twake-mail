/**
 * Tests for thread MCP tools - get_thread, get_thread_emails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerThreadTools } from './thread.js';
import { createFakeJmap, type FakeJmap } from '../../testing/fake-jmap.js';
import type { Logger } from '../../config/logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock types
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

describe('registerThreadTools', () => {
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
    registerThreadTools(mockServer, mockJmapClient.client, mockLogger);
  });

  describe('get_thread', () => {
    it('returns thread with emailIds array on success', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Thread/get',
            {
              accountId: 'account-1',
              list: [{ id: 'thread-1', emailIds: ['email-1', 'email-2', 'email-3'] }],
              notFound: [],
            },
            'getThread',
          ],
        ],
      });

      const handler = registeredTools.get('get_thread')!;
      const result = await handler({ threadId: 'thread-1' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        id: 'thread-1',
        emailIds: ['email-1', 'email-2', 'email-3'],
      });
    });

    it('returns error when thread not found (notFound array)', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Thread/get',
            { accountId: 'account-1', list: [], notFound: ['thread-nonexistent'] },
            'getThread',
          ],
        ],
      });

      const handler = registeredTools.get('get_thread')!;
      const result = await handler({ threadId: 'thread-nonexistent' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Thread not found');
    });

    it('returns error when thread not found (empty list)', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Thread/get', { accountId: 'account-1', list: [], notFound: [] }, 'getThread'],
        ],
      });

      const handler = registeredTools.get('get_thread')!;
      const result = await handler({ threadId: 'thread-missing' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Thread not found');
    });

    it('returns error on JMAP error', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'serverError', description: 'Internal server error' }, 'getThread'],
        ],
      });

      const handler = registeredTools.get('get_thread')!;
      const result = await handler({ threadId: 'thread-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to retrieve thread');
      expect(result.content[0].text).toContain('Internal server error');
    });

    it('handles exception gracefully', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Network error'));

      const handler = registeredTools.get('get_thread')!;
      const result = await handler({ threadId: 'thread-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error retrieving thread');
      expect(result.content[0].text).toContain('Network error');
    });
  });

  describe('get_thread_emails', () => {
    it('returns array of transformed emails on success', async () => {
      const mockEmails = [
        {
          id: 'email-1',
          blobId: 'blob-1',
          threadId: 'thread-1',
          mailboxIds: { inbox: true },
          keywords: { $seen: true },
          receivedAt: '2024-01-01T10:00:00Z',
          subject: 'First email',
          from: [{ name: 'Alice', email: 'alice@example.com' }],
          to: [{ name: 'Bob', email: 'bob@example.com' }],
          preview: 'First email content',
        },
        {
          id: 'email-2',
          blobId: 'blob-2',
          threadId: 'thread-1',
          mailboxIds: { inbox: true },
          keywords: {},
          receivedAt: '2024-01-01T11:00:00Z',
          subject: 'Re: First email',
          from: [{ name: 'Bob', email: 'bob@example.com' }],
          to: [{ name: 'Alice', email: 'alice@example.com' }],
          preview: 'Reply content',
        },
      ];

      // First call: Thread/get
      // Second call: Email/get
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({
          methodResponses: [
            [
              'Thread/get',
              {
                accountId: 'account-1',
                list: [{ id: 'thread-1', emailIds: ['email-1', 'email-2'] }],
                notFound: [],
              },
              'getThread',
            ],
          ],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            ['Email/get', { accountId: 'account-1', list: mockEmails }, 'getEmails'],
          ],
        });

      const handler = registeredTools.get('get_thread_emails')!;
      const result = await handler({ threadId: 'thread-1' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.threadId).toBe('thread-1');
      expect(parsed.emails).toHaveLength(2);
      expect(parsed.emails[0].id).toBe('email-1');
      expect(parsed.emails[1].id).toBe('email-2');
      // Check transformation worked (keywords -> boolean flags)
      expect(parsed.emails[0].isRead).toBe(true);
      expect(parsed.emails[1].isRead).toBe(false);
    });

    it('returns error when thread not found', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Thread/get',
            { accountId: 'account-1', list: [], notFound: ['thread-nonexistent'] },
            'getThread',
          ],
        ],
      });

      const handler = registeredTools.get('get_thread_emails')!;
      const result = await handler({ threadId: 'thread-nonexistent' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Thread not found');
    });

    it('returns empty array for empty thread (no emails)', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Thread/get',
            {
              accountId: 'account-1',
              list: [{ id: 'thread-empty', emailIds: [] }],
              notFound: [],
            },
            'getThread',
          ],
        ],
      });

      const handler = registeredTools.get('get_thread_emails')!;
      const result = await handler({ threadId: 'thread-empty' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.threadId).toBe('thread-empty');
      expect(parsed.emails).toEqual([]);
    });

    it('preserves emailIds order (oldest-first)', async () => {
      // Note: emails returned from Email/get may be in different order than requested
      // The tool should reorder them to match the original emailIds order
      const mockEmails = [
        {
          id: 'email-3',
          blobId: 'blob-3',
          threadId: 'thread-1',
          mailboxIds: { inbox: true },
          keywords: {},
          receivedAt: '2024-01-03T10:00:00Z',
          subject: 'Third',
          from: [],
          to: [],
        },
        {
          id: 'email-1',
          blobId: 'blob-1',
          threadId: 'thread-1',
          mailboxIds: { inbox: true },
          keywords: {},
          receivedAt: '2024-01-01T10:00:00Z',
          subject: 'First',
          from: [],
          to: [],
        },
        {
          id: 'email-2',
          blobId: 'blob-2',
          threadId: 'thread-1',
          mailboxIds: { inbox: true },
          keywords: {},
          receivedAt: '2024-01-02T10:00:00Z',
          subject: 'Second',
          from: [],
          to: [],
        },
      ];

      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({
          methodResponses: [
            [
              'Thread/get',
              {
                accountId: 'account-1',
                list: [{ id: 'thread-1', emailIds: ['email-1', 'email-2', 'email-3'] }],
                notFound: [],
              },
              'getThread',
            ],
          ],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            // Emails returned in different order
            ['Email/get', { accountId: 'account-1', list: mockEmails }, 'getEmails'],
          ],
        });

      const handler = registeredTools.get('get_thread_emails')!;
      const result = await handler({ threadId: 'thread-1' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Should be in order: email-1, email-2, email-3 (oldest-first per RFC 8621)
      expect(parsed.emails[0].id).toBe('email-1');
      expect(parsed.emails[1].id).toBe('email-2');
      expect(parsed.emails[2].id).toBe('email-3');
    });

    it('returns error on Email/get failure after successful Thread/get', async () => {
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({
          methodResponses: [
            [
              'Thread/get',
              {
                accountId: 'account-1',
                list: [{ id: 'thread-1', emailIds: ['email-1'] }],
                notFound: [],
              },
              'getThread',
            ],
          ],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            ['error', { type: 'serverError', description: 'Email fetch failed' }, 'getEmails'],
          ],
        });

      const handler = registeredTools.get('get_thread_emails')!;
      const result = await handler({ threadId: 'thread-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to retrieve thread emails');
      expect(result.content[0].text).toContain('Email fetch failed');
    });

    it('handles exception gracefully', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Connection timeout'));

      const handler = registeredTools.get('get_thread_emails')!;
      const result = await handler({ threadId: 'thread-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error retrieving thread emails');
      expect(result.content[0].text).toContain('Connection timeout');
    });
  });

  describe('tool registration', () => {
    it('registers both thread tools', () => {
      expect(registeredTools.has('get_thread')).toBe(true);
      expect(registeredTools.has('get_thread_emails')).toBe(true);
      expect(registeredTools.size).toBe(2);
    });
  });
});
