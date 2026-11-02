/**
 * Tests for mailbox MCP tools - get_mailbox, list_mailboxes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerMailboxTools } from './mailbox.js';
import { createFakeJmap, type FakeJmap } from '../../testing/fake-jmap.js';
import type { Logger } from '../../config/logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApprover } from '../approval.js';

// Mock types
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

describe('registerMailboxTools', () => {
  let mockServer: McpServer;
  let mockJmapClient: FakeJmap;
  let mockLogger: Logger;
  let registeredTools: Map<string, ToolHandler>;

  beforeEach(async () => {
    registeredTools = new Map();

    // Mock MCP server - uses .tool() method
    mockServer = {
      tool: vi.fn((name: string, _desc: string, _schema: unknown, _annotations: unknown, handler: ToolHandler) => {
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
    registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
  });

  describe('get_mailbox', () => {
    it('returns transformed mailbox on success', async () => {
      const mockMailbox = {
        id: 'mailbox-1',
        name: 'Inbox',
        role: 'inbox',
        totalEmails: 100,
        unreadEmails: 10,
        sortOrder: 1,
        parentId: null,
      };

      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Mailbox/get', { accountId: 'account-1', list: [mockMailbox], notFound: [] }, 'get-mailbox'],
        ],
      });

      const handler = registeredTools.get('get_mailbox')!;
      const result = await handler({ mailboxId: 'mailbox-1' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('mailbox-1');
      expect(parsed.name).toBe('Inbox');
      expect(parsed.role).toBe('inbox');
      expect(parsed.totalEmails).toBe(100);
      expect(parsed.unreadEmails).toBe(10);
    });

    it('returns error when mailbox not found in notFound array', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Mailbox/get', { accountId: 'account-1', list: [], notFound: ['mailbox-nonexistent'] }, 'get-mailbox'],
        ],
      });

      const handler = registeredTools.get('get_mailbox')!;
      const result = await handler({ mailboxId: 'mailbox-nonexistent' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Mailbox not found');
    });

    it('returns error when mailbox list is empty', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Mailbox/get', { accountId: 'account-1', list: [], notFound: [] }, 'get-mailbox'],
        ],
      });

      const handler = registeredTools.get('get_mailbox')!;
      const result = await handler({ mailboxId: 'mailbox-missing' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Mailbox not found');
    });

    it('returns error on JMAP error', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'serverError', description: 'Internal server error' }, 'get-mailbox'],
        ],
      });

      const handler = registeredTools.get('get_mailbox')!;
      const result = await handler({ mailboxId: 'mailbox-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error retrieving mailbox');
      expect(result.content[0].text).toContain('Internal server error');
    });

    it('handles exception gracefully', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Network error'));

      const handler = registeredTools.get('get_mailbox')!;
      const result = await handler({ mailboxId: 'mailbox-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error retrieving mailbox');
      expect(result.content[0].text).toContain('Network error');
    });
  });

  describe('list_mailboxes', () => {
    it('returns all mailboxes when no filter', async () => {
      const mockMailboxes = [
        { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 100, unreadEmails: 10, sortOrder: 1, parentId: null },
        { id: 'sent', name: 'Sent', role: 'sent', totalEmails: 50, unreadEmails: 0, sortOrder: 2, parentId: null },
        { id: 'custom', name: 'Custom Folder', role: null, totalEmails: 20, unreadEmails: 5, sortOrder: 100, parentId: null },
      ];

      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Mailbox/get', { accountId: 'account-1', list: mockMailboxes }, 'list-mailboxes'],
        ],
      });
      const handler = registeredTools.get('list_mailboxes')!;
      const result = await handler({});

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(3);
    });

    it('filters mailboxes by role', async () => {
      const mockMailboxes = [
        { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 100, unreadEmails: 10, sortOrder: 1, parentId: null },
        { id: 'sent', name: 'Sent', role: 'sent', totalEmails: 50, unreadEmails: 0, sortOrder: 2, parentId: null },
        { id: 'drafts', name: 'Drafts', role: 'drafts', totalEmails: 5, unreadEmails: 0, sortOrder: 3, parentId: null },
      ];

      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Mailbox/get', { accountId: 'account-1', list: mockMailboxes }, 'list-mailboxes'],
        ],
      });
      const handler = registeredTools.get('list_mailboxes')!;
      const result = await handler({ role: 'inbox' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].role).toBe('inbox');
    });

    it('returns empty array when no mailboxes match filter', async () => {
      const mockMailboxes = [
        { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 100, unreadEmails: 10, sortOrder: 1, parentId: null },
      ];

      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Mailbox/get', { accountId: 'account-1', list: mockMailboxes }, 'list-mailboxes'],
        ],
      });
      const handler = registeredTools.get('list_mailboxes')!;
      const result = await handler({ role: 'archive' });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(0);
    });

    it('returns empty array when list is undefined', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Mailbox/get', { accountId: 'account-1' }, 'list-mailboxes'],
        ],
      });

      const handler = registeredTools.get('list_mailboxes')!;
      const result = await handler({});

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([]);
    });

    it('returns error on JMAP error', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'serverError', description: 'Internal error' }, 'list-mailboxes'],
        ],
      });

      const handler = registeredTools.get('list_mailboxes')!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error listing mailboxes');
    });

    it('handles exception gracefully', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Connection timeout'));

      const handler = registeredTools.get('list_mailboxes')!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error listing mailboxes');
      expect(result.content[0].text).toContain('Connection timeout');
    });
  });

  describe('tool registration', () => {
    it('registers all mailbox tools', () => {
      expect(registeredTools.has('get_mailbox')).toBe(true);
      expect(registeredTools.has('list_mailboxes')).toBe(true);
      expect(registeredTools.has('create_mailbox')).toBe(true);
      expect(registeredTools.has('rename_mailbox')).toBe(true);
      expect(registeredTools.has('delete_mailbox')).toBe(true);
      expect(registeredTools.size).toBe(5);
    });
  });
});
