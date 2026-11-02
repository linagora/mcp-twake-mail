/**
 * Tests for email MCP tools - get_email, search_emails, get_email_labels.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerEmailTools } from './email.js';
import { createFakeJmap, type FakeJmap } from '../../testing/fake-jmap.js';
import type { Logger } from '../../config/logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock types
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

describe('registerEmailTools', () => {
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
    registerEmailTools(mockServer, mockJmapClient.client, mockLogger);
  });

  describe('get_email', () => {
    it('returns transformed email on success', async () => {
      const mockEmail = {
        id: 'email-1',
        blobId: 'blob-1',
        threadId: 'thread-1',
        mailboxIds: { inbox: true },
        keywords: { $seen: true, $flagged: true },
        receivedAt: '2024-01-15T10:00:00Z',
        subject: 'Test Email',
        from: [{ name: 'Sender', email: 'sender@example.com' }],
        to: [{ name: 'Recipient', email: 'recipient@example.com' }],
        preview: 'Email preview text...',
        hasAttachment: false,
        size: 1234,
        textBody: [{ partId: 'part1' }],
        bodyValues: { part1: { value: 'Email body content' } },
      };

      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/get', { accountId: 'account-1', list: [mockEmail] }, 'getEmail'],
        ],
      });

      const handler = registeredTools.get('get_email')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('email-1');
      expect(parsed.isRead).toBe(true);
      expect(parsed.isFlagged).toBe(true);
      expect(parsed.subject).toBe('Test Email');
    });

    it('returns error when email not found', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/get', { accountId: 'account-1', list: [], notFound: ['email-nonexistent'] }, 'getEmail'],
        ],
      });

      const handler = registeredTools.get('get_email')!;
      const result = await handler({ emailId: 'email-nonexistent' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Email not found');
    });

    it('returns error on JMAP error', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'serverError', description: 'Internal server error' }, 'getEmail'],
        ],
      });

      const handler = registeredTools.get('get_email')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to retrieve email');
      expect(result.content[0].text).toContain('Internal server error');
    });

    it('handles exception gracefully', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Network error'));

      const handler = registeredTools.get('get_email')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error retrieving email');
      expect(result.content[0].text).toContain('Network error');
    });
  });

  describe('search_emails', () => {
    it('returns list of emails matching filters', async () => {
      const mockEmails = [
        {
          id: 'email-1',
          blobId: 'blob-1',
          threadId: 'thread-1',
          mailboxIds: { inbox: true },
          keywords: { $seen: true },
          receivedAt: '2024-01-15T10:00:00Z',
          subject: 'Test Email 1',
          from: [{ email: 'sender@example.com' }],
          to: [],
          preview: 'Preview 1',
        },
        {
          id: 'email-2',
          blobId: 'blob-2',
          threadId: 'thread-2',
          mailboxIds: { inbox: true },
          keywords: {},
          receivedAt: '2024-01-14T10:00:00Z',
          subject: 'Test Email 2',
          from: [{ email: 'other@example.com' }],
          to: [],
          preview: 'Preview 2',
        },
      ];

      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/query', { accountId: 'account-1', ids: ['email-1', 'email-2'], total: 2 }, 'queryEmails'],
          ['Email/get', { accountId: 'account-1', list: mockEmails }, 'getEmails'],
        ],
      });

      const handler = registeredTools.get('search_emails')!;
      const result = await handler({ mailboxId: 'inbox', limit: 20 });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.total).toBe(2);
      expect(parsed.returned).toBe(2);
      expect(parsed.emails).toHaveLength(2);
    });

    it('builds filter with all parameters', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/query', { accountId: 'account-1', ids: [], total: 0 }, 'queryEmails'],
          ['Email/get', { accountId: 'account-1', list: [] }, 'getEmails'],
        ],
      });

      const handler = registeredTools.get('search_emails')!;
      await handler({
        mailboxId: 'inbox',
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'body search',
        before: '2024-01-20T00:00:00Z',
        after: '2024-01-01T00:00:00Z',
        hasAttachment: true,
        unreadOnly: true,
        flagged: true,
        limit: 50,
      });

      expect(mockJmapClient.request).toHaveBeenCalled();
      const requestCall = vi.mocked(mockJmapClient.request).mock.calls[0][0];
      const queryArgs = requestCall[0][1] as Record<string, unknown>;

      expect(queryArgs.filter).toEqual({
        inMailbox: 'inbox',
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'body search',
        before: '2024-01-20T00:00:00Z',
        after: '2024-01-01T00:00:00Z',
        hasAttachment: true,
        notKeyword: '$seen',
        hasKeyword: '$flagged',
      });
      expect(queryArgs.limit).toBe(50);
    });

    it('returns error on query failure', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'invalidArguments', description: 'Bad filter' }, 'queryEmails'],
        ],
      });

      const handler = registeredTools.get('search_emails')!;
      const result = await handler({ limit: 20 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Search failed');
    });

    it('returns error on Email/get failure', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/query', { accountId: 'account-1', ids: ['email-1'], total: 1 }, 'queryEmails'],
          ['error', { type: 'serverError', description: 'Fetch failed' }, 'getEmails'],
        ],
      });

      const handler = registeredTools.get('search_emails')!;
      const result = await handler({ limit: 20 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to fetch email details');
    });

    it('handles exception gracefully', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Connection timeout'));

      const handler = registeredTools.get('search_emails')!;
      const result = await handler({ limit: 20 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Search error');
      expect(result.content[0].text).toContain('Connection timeout');
    });
  });

  describe('get_email_labels', () => {
    it('returns mailbox IDs for an email', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/get',
            {
              accountId: 'account-1',
              list: [{ id: 'email-1', mailboxIds: { inbox: true, archive: true, trash: false } }],
            },
            'getEmailLabels',
          ],
        ],
      });

      const handler = registeredTools.get('get_email_labels')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.emailId).toBe('email-1');
      expect(parsed.mailboxIds).toContain('inbox');
      expect(parsed.mailboxIds).toContain('archive');
      expect(parsed.mailboxIds).not.toContain('trash');
    });

    it('returns error when email not found', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/get', { accountId: 'account-1', list: [] }, 'getEmailLabels'],
        ],
      });

      const handler = registeredTools.get('get_email_labels')!;
      const result = await handler({ emailId: 'email-nonexistent' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Email not found');
    });

    it('returns error on JMAP error', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'serverError', description: 'Internal error' }, 'getEmailLabels'],
        ],
      });

      const handler = registeredTools.get('get_email_labels')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to get email labels');
    });

    it('handles exception gracefully', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Network failure'));

      const handler = registeredTools.get('get_email_labels')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error getting email labels');
      expect(result.content[0].text).toContain('Network failure');
    });
  });

  describe('tool registration', () => {
    it('registers all email tools', () => {
      expect(registeredTools.has('get_email')).toBe(true);
      expect(registeredTools.has('search_emails')).toBe(true);
      expect(registeredTools.has('get_email_labels')).toBe(true);
      expect(registeredTools.size).toBe(3);
    });
  });
});
