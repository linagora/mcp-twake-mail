/**
 * Tests for batch email operation MCP tools - batch_mark_read, batch_mark_unread, batch_move,
 * batch_delete, batch_add_label, batch_remove_label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerBatchOperationTools } from './batch-operations.js';
import { createFakeJmap, type FakeJmap } from '../../testing/fake-jmap.js';
import type { Logger } from '../../config/logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApprover } from '../approval.js';

// Mock types
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

describe('registerBatchOperationTools', () => {
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
    registerBatchOperationTools(mockServer, mockJmapClient.client, mockLogger);
  });

  describe('batch_mark_read', () => {
    it('returns success when all emails are marked as read', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              updated: { 'email-1': null, 'email-2': null, 'email-3': null },
            },
            'batchMarkRead',
          ],
        ],
      });
      const handler = registeredTools.get('batch_mark_read')!;
      const result = await handler({ emailIds: ['email-1', 'email-2', 'email-3'] });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        success: true,
        total: 3,
        succeeded: 3,
        failed: 0,
        results: {
          succeeded: ['email-1', 'email-2', 'email-3'],
          failed: [],
        },
      });
    });

    it('handles partial failure with per-email reporting', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              updated: { 'email-1': null, 'email-3': null },
              notUpdated: { 'email-2': { type: 'notFound', description: 'Email not found' } },
            },
            'batchMarkRead',
          ],
        ],
      });
      const handler = registeredTools.get('batch_mark_read')!;
      const result = await handler({ emailIds: ['email-1', 'email-2', 'email-3'] });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        success: false,
        total: 3,
        succeeded: 2,
        failed: 1,
        results: {
          succeeded: ['email-1', 'email-3'],
          failed: [{ emailId: 'email-2', error: 'notFound: Email not found' }],
        },
      });
    });

    it('handles total failure with all emails in notUpdated', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              notUpdated: {
                'email-1': { type: 'notFound' },
                'email-2': { type: 'notFound' },
              },
            },
            'batchMarkRead',
          ],
        ],
      });
      const handler = registeredTools.get('batch_mark_read')!;
      const result = await handler({ emailIds: ['email-1', 'email-2'] });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.total).toBe(2);
      expect(parsed.succeeded).toBe(0);
      expect(parsed.failed).toBe(2);
    });

    it('returns error when JMAP method fails', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'serverFail', description: 'Server error' }, 'batchMarkRead'],
        ],
      });
      const handler = registeredTools.get('batch_mark_read')!;
      const result = await handler({ emailIds: ['email-1'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to batch mark emails as read');
    });
  });

  describe('batch_mark_unread', () => {
    it('returns success when all emails are marked as unread', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              updated: { 'email-1': null, 'email-2': null },
            },
            'batchMarkUnread',
          ],
        ],
      });
      const handler = registeredTools.get('batch_mark_unread')!;
      const result = await handler({ emailIds: ['email-1', 'email-2'] });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        success: true,
        total: 2,
        succeeded: 2,
        failed: 0,
        results: {
          succeeded: ['email-1', 'email-2'],
          failed: [],
        },
      });
    });

    it('handles partial failure', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              updated: { 'email-1': null },
              notUpdated: { 'email-2': { type: 'invalidProperties' } },
            },
            'batchMarkUnread',
          ],
        ],
      });
      const handler = registeredTools.get('batch_mark_unread')!;
      const result = await handler({ emailIds: ['email-1', 'email-2'] });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.succeeded).toBe(1);
      expect(parsed.failed).toBe(1);
      expect(parsed.results.failed[0].emailId).toBe('email-2');
    });

    it('returns error when JMAP method fails', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'serverFail' }, 'batchMarkUnread'],
        ],
      });
      const handler = registeredTools.get('batch_mark_unread')!;
      const result = await handler({ emailIds: ['email-1'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to batch mark emails as unread');
    });
  });

  describe('batch_move', () => {
    it('returns success when all emails are moved', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              updated: { 'email-1': null, 'email-2': null, 'email-3': null },
            },
            'batchMove',
          ],
        ],
      });
      const handler = registeredTools.get('batch_move')!;
      const result = await handler({
        emailIds: ['email-1', 'email-2', 'email-3'],
        targetMailboxId: 'archive-mailbox',
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        success: true,
        total: 3,
        succeeded: 3,
        failed: 0,
        results: {
          succeeded: ['email-1', 'email-2', 'email-3'],
          failed: [],
        },
        targetMailboxId: 'archive-mailbox',
      });
    });

    it('handles partial failure with some emails not found', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              updated: { 'email-1': null },
              notUpdated: {
                'email-2': { type: 'notFound', description: 'Email not found' },
                'email-3': { type: 'notFound', description: 'Email not found' },
              },
            },
            'batchMove',
          ],
        ],
      });
      const handler = registeredTools.get('batch_move')!;
      const result = await handler({
        emailIds: ['email-1', 'email-2', 'email-3'],
        targetMailboxId: 'archive-mailbox',
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.total).toBe(3);
      expect(parsed.succeeded).toBe(1);
      expect(parsed.failed).toBe(2);
      expect(parsed.targetMailboxId).toBe('archive-mailbox');
      expect(parsed.results.failed.length).toBe(2);
    });

    it('includes targetMailboxId in request', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', updated: { 'email-1': null } }, 'batchMove'],
        ],
      });
      const handler = registeredTools.get('batch_move')!;
      await handler({ emailIds: ['email-1'], targetMailboxId: 'target-123' });

      // Verify the request was made with correct mailboxIds structure
      expect(mockJmapClient.request).toHaveBeenCalledWith([
        [
          'Email/set',
          {
            accountId: 'account-1',
            update: {
              'email-1': { mailboxIds: { 'target-123': true } },
            },
          },
          'c0',
        ],
      ], expect.anything());
    });

    it('returns error when JMAP method fails', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'invalidArguments', description: 'Invalid mailbox ID' }, 'batchMove'],
        ],
      });
      const handler = registeredTools.get('batch_move')!;
      const result = await handler({
        emailIds: ['email-1'],
        targetMailboxId: 'invalid-mailbox',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to batch move emails');
    });
  });

  describe('batch_delete', () => {
    it('returns success when all emails are permanently deleted', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              destroyed: ['email-1', 'email-2', 'email-3'],
            },
            'batchDestroy',
          ],
        ],
      });
      const handler = registeredTools.get('batch_delete')!;
      const result = await handler({ emailIds: ['email-1', 'email-2', 'email-3'], permanent: true });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        success: true,
        total: 3,
        succeeded: 3,
        failed: 0,
        results: {
          succeeded: ['email-1', 'email-2', 'email-3'],
          failed: [],
        },
        action: 'permanently_deleted',
      });
    });

    it('handles partial failure with some emails not destroyed', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              destroyed: ['email-1'],
              notDestroyed: {
                'email-2': { type: 'notFound', description: 'Email not found' },
              },
            },
            'batchDestroy',
          ],
        ],
      });
      const handler = registeredTools.get('batch_delete')!;
      const result = await handler({ emailIds: ['email-1', 'email-2'], permanent: true });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.succeeded).toBe(1);
      expect(parsed.failed).toBe(1);
      expect(parsed.action).toBe('permanently_deleted');
      expect(parsed.results.failed[0].emailId).toBe('email-2');
    });

    it('moves emails to Trash when permanent=false', async () => {
      // First call: Mailbox/query to find Trash
      // Second call: Email/set to move to Trash
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({
          methodResponses: [
            ['Mailbox/query', { ids: ['trash-mailbox-id'] }, 'findTrash'],
          ],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            [
              'Email/set',
              {
                accountId: 'account-1',
                updated: { 'email-1': null, 'email-2': null },
              },
              'batchMoveToTrash',
            ],
          ],
        });
      const handler = registeredTools.get('batch_delete')!;
      const result = await handler({ emailIds: ['email-1', 'email-2'], permanent: false });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.action).toBe('moved_to_trash');
      expect(parsed.succeeded).toBe(2);
    });

    it('falls back to permanent delete when no Trash mailbox exists', async () => {
      // First call: Mailbox/query returns empty
      // Second call: Email/set with destroy
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({
          methodResponses: [
            ['Mailbox/query', { ids: [] }, 'findTrash'],
          ],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            [
              'Email/set',
              {
                accountId: 'account-1',
                destroyed: ['email-1', 'email-2'],
              },
              'batchDestroyFallback',
            ],
          ],
        });
      const handler = registeredTools.get('batch_delete')!;
      const result = await handler({ emailIds: ['email-1', 'email-2'], permanent: false });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.action).toBe('permanently_deleted');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('queries Trash mailbox only once for batch operation', async () => {
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({
          methodResponses: [
            ['Mailbox/query', { ids: ['trash-mailbox-id'] }, 'findTrash'],
          ],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            [
              'Email/set',
              {
                accountId: 'account-1',
                updated: { 'email-1': null, 'email-2': null, 'email-3': null },
              },
              'batchMoveToTrash',
            ],
          ],
        });
      const handler = registeredTools.get('batch_delete')!;
      await handler({ emailIds: ['email-1', 'email-2', 'email-3'], permanent: false });

      // Exactly 2 requests: 1 for Trash query, 1 for Email/set
      expect(mockJmapClient.request).toHaveBeenCalledTimes(2);
    });

    it('returns error when JMAP method fails', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'serverFail', description: 'Server error' }, 'batchDestroy'],
        ],
      });
      const handler = registeredTools.get('batch_delete')!;
      const result = await handler({ emailIds: ['email-1'], permanent: true });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to batch delete emails');
    });
  });

  describe('batch_add_label', () => {
    it('returns success when label is added to all emails', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              updated: { 'email-1': null, 'email-2': null, 'email-3': null },
            },
            'batchAddLabel',
          ],
        ],
      });
      const handler = registeredTools.get('batch_add_label')!;
      const result = await handler({
        emailIds: ['email-1', 'email-2', 'email-3'],
        mailboxId: 'important-label',
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        success: true,
        total: 3,
        succeeded: 3,
        failed: 0,
        results: {
          succeeded: ['email-1', 'email-2', 'email-3'],
          failed: [],
        },
        mailboxId: 'important-label',
      });
    });

    it('handles partial failure with some emails not found', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              updated: { 'email-1': null },
              notUpdated: {
                'email-2': { type: 'notFound', description: 'Email not found' },
              },
            },
            'batchAddLabel',
          ],
        ],
      });
      const handler = registeredTools.get('batch_add_label')!;
      const result = await handler({
        emailIds: ['email-1', 'email-2'],
        mailboxId: 'label-123',
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.succeeded).toBe(1);
      expect(parsed.failed).toBe(1);
      expect(parsed.mailboxId).toBe('label-123');
    });

    it('uses correct path syntax for mailboxId', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', updated: { 'email-1': null } }, 'batchAddLabel'],
        ],
      });
      const handler = registeredTools.get('batch_add_label')!;
      await handler({ emailIds: ['email-1'], mailboxId: 'label-xyz' });

      // Verify path syntax: mailboxIds/[mailboxId]
      expect(mockJmapClient.request).toHaveBeenCalledWith([
        [
          'Email/set',
          {
            accountId: 'account-1',
            update: {
              'email-1': { 'mailboxIds/label-xyz': true },
            },
          },
          'c0',
        ],
      ], expect.anything());
    });

    it('returns error when JMAP method fails', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'invalidArguments', description: 'Invalid mailbox' }, 'batchAddLabel'],
        ],
      });
      const handler = registeredTools.get('batch_add_label')!;
      const result = await handler({ emailIds: ['email-1'], mailboxId: 'invalid' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to batch add label');
    });
  });

  describe('batch_remove_label', () => {
    it('returns success when label is removed from all emails', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              updated: { 'email-1': null, 'email-2': null },
            },
            'batchRemoveLabel',
          ],
        ],
      });
      const handler = registeredTools.get('batch_remove_label')!;
      const result = await handler({
        emailIds: ['email-1', 'email-2'],
        mailboxId: 'old-label',
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        success: true,
        total: 2,
        succeeded: 2,
        failed: 0,
        results: {
          succeeded: ['email-1', 'email-2'],
          failed: [],
        },
        mailboxId: 'old-label',
      });
    });

    it('handles partial failure', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              updated: { 'email-1': null },
              notUpdated: {
                'email-2': { type: 'invalidProperties', description: 'Cannot remove last mailbox' },
              },
            },
            'batchRemoveLabel',
          ],
        ],
      });
      const handler = registeredTools.get('batch_remove_label')!;
      const result = await handler({
        emailIds: ['email-1', 'email-2'],
        mailboxId: 'label-123',
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.succeeded).toBe(1);
      expect(parsed.failed).toBe(1);
      expect(parsed.results.failed[0].error).toContain('invalidProperties');
    });

    it('uses correct path syntax for mailboxId removal', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', updated: { 'email-1': null } }, 'batchRemoveLabel'],
        ],
      });
      const handler = registeredTools.get('batch_remove_label')!;
      await handler({ emailIds: ['email-1'], mailboxId: 'label-xyz' });

      // Verify path syntax with null value: mailboxIds/[mailboxId]: null
      expect(mockJmapClient.request).toHaveBeenCalledWith([
        [
          'Email/set',
          {
            accountId: 'account-1',
            update: {
              'email-1': { 'mailboxIds/label-xyz': null },
            },
          },
          'c0',
        ],
      ], expect.anything());
    });

    it('returns error when JMAP method fails', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['error', { type: 'serverFail' }, 'batchRemoveLabel'],
        ],
      });
      const handler = registeredTools.get('batch_remove_label')!;
      const result = await handler({ emailIds: ['email-1'], mailboxId: 'label' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to batch remove label');
    });
  });

  describe('tool registration', () => {
    it('registers all 6 batch operation tools', () => {
      expect(registeredTools.has('batch_mark_read')).toBe(true);
      expect(registeredTools.has('batch_mark_unread')).toBe(true);
      expect(registeredTools.has('batch_move')).toBe(true);
      expect(registeredTools.has('batch_delete')).toBe(true);
      expect(registeredTools.has('batch_add_label')).toBe(true);
      expect(registeredTools.has('batch_remove_label')).toBe(true);
      expect(registeredTools.size).toBe(6);
    });
  });

  describe('error handling', () => {
    it('handles exceptions in batch_mark_read', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Network error'));

      const handler = registeredTools.get('batch_mark_read')!;
      const result = await handler({ emailIds: ['email-1'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error batch marking emails as read');
      expect(result.content[0].text).toContain('Network error');
    });

    it('handles exceptions in batch_mark_unread', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Connection failed'));

      const handler = registeredTools.get('batch_mark_unread')!;
      const result = await handler({ emailIds: ['email-1'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error batch marking emails as unread');
    });

    it('handles exceptions in batch_move', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Timeout'));

      const handler = registeredTools.get('batch_move')!;
      const result = await handler({ emailIds: ['email-1'], targetMailboxId: 'mailbox-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error batch moving emails');
    });

    it('handles exceptions in batch_delete', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Connection reset'));

      const handler = registeredTools.get('batch_delete')!;
      const result = await handler({ emailIds: ['email-1'], permanent: true });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error batch deleting emails');
      expect(result.content[0].text).toContain('Connection reset');
    });

    it('handles exceptions in batch_add_label', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Service unavailable'));

      const handler = registeredTools.get('batch_add_label')!;
      const result = await handler({ emailIds: ['email-1'], mailboxId: 'label-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error batch adding label');
    });

    it('handles exceptions in batch_remove_label', async () => {
      vi.mocked(mockJmapClient.request).mockRejectedValue(new Error('Gateway timeout'));

      const handler = registeredTools.get('batch_remove_label')!;
      const result = await handler({ emailIds: ['email-1'], mailboxId: 'label-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error batch removing label');
    });
  });
});
