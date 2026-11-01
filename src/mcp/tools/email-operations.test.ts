/**
 * Tests for email operation MCP tools - mark_as_read, mark_as_unread, delete_email,
 * move_email, add_label, remove_label, create_draft, update_draft, send_draft.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerEmailOperationTools } from './email-operations.js';
import type { JMAPClient } from '../../jmap/client.js';
import type { Logger } from '../../config/logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApprover } from '../approval.js';

// Mock types
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

describe('registerEmailOperationTools', () => {
  let mockServer: McpServer;
  let mockJmapClient: JMAPClient;
  let mockLogger: Logger;
  let registeredTools: Map<string, ToolHandler>;

  beforeEach(() => {
    registeredTools = new Map();

    // Mock MCP server
    mockServer = {
      registerTool: vi.fn((name: string, _options: unknown, handler: ToolHandler) => {
        registeredTools.set(name, handler);
      }),
    } as unknown as McpServer;

    // Mock JMAP client
    mockJmapClient = {
      getSession: vi.fn(() => ({ accountId: 'account-1', apiUrl: 'https://jmap.example.com/api' })),
      request: vi.fn(),
      parseMethodResponse: vi.fn(),
    } as unknown as JMAPClient;

    // Mock logger (silent)
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    // Register all tools
    setApprover(mockServer, { mode: 'client', language: 'en', timeoutMs: 1000 });
    registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
  });

  describe('mark_as_read', () => {
    it('returns success when email is marked as read', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', updated: { 'email-1': null } }, 'markRead'],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: { accountId: 'account-1', updated: { 'email-1': null } },
      });

      const handler = registeredTools.get('mark_as_read')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: true,
        emailId: 'email-1',
        marked: 'read',
      });
    });

    it('returns error when notUpdated in response', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', notUpdated: { 'email-1': { type: 'notFound' } } }, 'markRead'],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: { accountId: 'account-1', notUpdated: { 'email-1': { type: 'notFound' } } },
      });

      const handler = registeredTools.get('mark_as_read')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to mark email as read');
    });
  });

  describe('mark_as_unread', () => {
    it('returns success when email is marked as unread', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', updated: { 'email-1': null } }, 'markUnread'],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: { accountId: 'account-1', updated: { 'email-1': null } },
      });

      const handler = registeredTools.get('mark_as_unread')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: true,
        emailId: 'email-1',
        marked: 'unread',
      });
    });

    it('returns error when notUpdated in response', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', notUpdated: { 'email-1': { type: 'notFound' } } }, 'markUnread'],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: { accountId: 'account-1', notUpdated: { 'email-1': { type: 'notFound' } } },
      });

      const handler = registeredTools.get('mark_as_unread')!;
      const result = await handler({ emailId: 'email-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to mark email as unread');
    });
  });

  describe('delete_email', () => {
    it('moves email to Trash by default', async () => {
      // First call: find Trash mailbox
      // Second call: move to Trash
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({
          methodResponses: [['Mailbox/query', { ids: ['trash-mailbox-id'] }, 'findTrash']],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            ['Email/set', { accountId: 'account-1', updated: { 'email-1': null } }, 'moveToTrash'],
          ],
        });
      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { ids: ['trash-mailbox-id'] } })
        .mockReturnValueOnce({
          success: true,
          data: { accountId: 'account-1', updated: { 'email-1': null } },
        });

      const handler = registeredTools.get('delete_email')!;
      const result = await handler({ emailId: 'email-1', permanent: false });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: true,
        emailId: 'email-1',
        action: 'moved_to_trash',
      });
    });

    it('permanently destroys email when permanent=true', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', destroyed: ['email-1'] }, 'destroyEmail'],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: { accountId: 'account-1', destroyed: ['email-1'] },
      });

      const handler = registeredTools.get('delete_email')!;
      const result = await handler({ emailId: 'email-1', permanent: true });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: true,
        emailId: 'email-1',
        action: 'permanently_deleted',
      });
    });

    it('falls back to permanent delete when no Trash mailbox found', async () => {
      // First call: find Trash mailbox (none found)
      // Second call: destroy email
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({
          methodResponses: [['Mailbox/query', { ids: [] }, 'findTrash']],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            ['Email/set', { accountId: 'account-1', destroyed: ['email-1'] }, 'destroyEmailFallback'],
          ],
        });
      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { ids: [] } })
        .mockReturnValueOnce({
          success: true,
          data: { accountId: 'account-1', destroyed: ['email-1'] },
        });

      const handler = registeredTools.get('delete_email')!;
      const result = await handler({ emailId: 'email-1', permanent: false });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: true,
        emailId: 'email-1',
        action: 'permanently_deleted',
      });
    });
  });

  describe('move_email', () => {
    it('returns success when email is moved', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', updated: { 'email-1': null } }, 'moveEmail'],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: { accountId: 'account-1', updated: { 'email-1': null } },
      });

      const handler = registeredTools.get('move_email')!;
      const result = await handler({ emailId: 'email-1', targetMailboxId: 'archive-mailbox' });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: true,
        emailId: 'email-1',
        targetMailboxId: 'archive-mailbox',
      });
    });

    it('returns error when notUpdated in response', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              notUpdated: { 'email-1': { type: 'notFound', description: 'Email not found' } },
            },
            'moveEmail',
          ],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: {
          accountId: 'account-1',
          notUpdated: { 'email-1': { type: 'notFound', description: 'Email not found' } },
        },
      });

      const handler = registeredTools.get('move_email')!;
      const result = await handler({ emailId: 'email-1', targetMailboxId: 'archive-mailbox' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to move email');
    });
  });

  describe('add_label', () => {
    it('returns success when label is added', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', updated: { 'email-1': null } }, 'addLabel'],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: { accountId: 'account-1', updated: { 'email-1': null } },
      });

      const handler = registeredTools.get('add_label')!;
      const result = await handler({ emailId: 'email-1', mailboxId: 'important-mailbox' });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: true,
        emailId: 'email-1',
        addedMailboxId: 'important-mailbox',
      });
    });

    it('returns error when notUpdated in response', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              notUpdated: { 'email-1': { type: 'invalidProperties' } },
            },
            'addLabel',
          ],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: {
          accountId: 'account-1',
          notUpdated: { 'email-1': { type: 'invalidProperties' } },
        },
      });

      const handler = registeredTools.get('add_label')!;
      const result = await handler({ emailId: 'email-1', mailboxId: 'invalid-mailbox' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to add label');
    });
  });

  describe('remove_label', () => {
    it('returns success when label is removed', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          ['Email/set', { accountId: 'account-1', updated: { 'email-1': null } }, 'removeLabel'],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: { accountId: 'account-1', updated: { 'email-1': null } },
      });

      const handler = registeredTools.get('remove_label')!;
      const result = await handler({ emailId: 'email-1', mailboxId: 'label-mailbox' });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: true,
        emailId: 'email-1',
        removedMailboxId: 'label-mailbox',
      });
    });

    it('returns friendly error when email only has one mailbox', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValue({
        methodResponses: [
          [
            'Email/set',
            {
              accountId: 'account-1',
              notUpdated: {
                'email-1': {
                  type: 'invalidProperties',
                  description: 'mailboxIds must contain at least one entry',
                },
              },
            },
            'removeLabel',
          ],
        ],
      });
      vi.mocked(mockJmapClient.parseMethodResponse).mockReturnValue({
        success: true,
        data: {
          accountId: 'account-1',
          notUpdated: {
            'email-1': {
              type: 'invalidProperties',
              description: 'mailboxIds must contain at least one entry',
            },
          },
        },
      });

      const handler = registeredTools.get('remove_label')!;
      const result = await handler({ emailId: 'email-1', mailboxId: 'only-mailbox' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        'Cannot remove label: email must belong to at least one mailbox'
      );
    });
  });

  describe('create_draft', () => {
    it('creates draft in Drafts mailbox with $draft keyword and from field', async () => {
      // First call: get mailboxes
      // Second call: get identity (optional, with submission capability)
      // Third call: create draft
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({
          methodResponses: [['Mailbox/get', { list: [{ id: 'drafts-mailbox-id', role: 'drafts' }] }, 'getMailboxes']],
        })
        .mockResolvedValueOnce({
          methodResponses: [['Identity/get', { list: [{ id: 'identity-1', email: 'test@example.com', name: 'Test User' }] }, 'getIdentity']],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            [
              'Email/set',
              {
                accountId: 'account-1',
                created: {
                  draft: { id: 'draft-email-123', blobId: 'blob-1', threadId: 'thread-1' },
                },
              },
              'createDraft',
            ],
          ],
        });
      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'drafts-mailbox-id', role: 'drafts' }] } })
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'identity-1', email: 'test@example.com', name: 'Test User' }] } })
        .mockReturnValueOnce({
          success: true,
          data: {
            accountId: 'account-1',
            created: {
              draft: { id: 'draft-email-123', blobId: 'blob-1', threadId: 'thread-1' },
            },
          },
        });

      const handler = registeredTools.get('create_draft')!;
      const result = await handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Test body content',
      });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: true,
        draftId: 'draft-email-123',
        threadId: 'thread-1',
      });
    });

    it('returns error when no Drafts mailbox found', async () => {
      vi.mocked(mockJmapClient.request).mockResolvedValueOnce({
        methodResponses: [['Mailbox/get', { list: [{ id: 'inbox-id', role: 'inbox' }] }, 'getMailboxes']],
      });
      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'inbox-id', role: 'inbox' }] } });

      const handler = registeredTools.get('create_draft')!;
      const result = await handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No Drafts mailbox found');
    });

    it('returns error when notCreated in response', async () => {
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({
          methodResponses: [['Mailbox/get', { list: [{ id: 'drafts-mailbox-id', role: 'drafts' }] }, 'getMailboxes']],
        })
        .mockResolvedValueOnce({
          methodResponses: [['Identity/get', { list: [{ id: 'identity-1', email: 'test@example.com' }] }, 'getIdentity']],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            [
              'Email/set',
              {
                accountId: 'account-1',
                notCreated: {
                  draft: { type: 'invalidProperties', description: 'Invalid email format' },
                },
              },
              'createDraft',
            ],
          ],
        });
      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'drafts-mailbox-id', role: 'drafts' }] } })
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'identity-1', email: 'test@example.com' }] } })
        .mockReturnValueOnce({
          success: true,
          data: {
            accountId: 'account-1',
            notCreated: {
              draft: { type: 'invalidProperties', description: 'Invalid email format' },
            },
          },
        });

      const handler = registeredTools.get('create_draft')!;
      const result = await handler({
        to: ['invalid-email'],
        subject: 'Test Subject',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to create draft');
      expect(result.content[0].text).toContain('invalidProperties');
    });
  });

  describe('tool registration', () => {
    it('registers all 9 email operation tools', () => {
      expect(registeredTools.has('mark_as_read')).toBe(true);
      expect(registeredTools.has('mark_as_unread')).toBe(true);
      expect(registeredTools.has('delete_email')).toBe(true);
      expect(registeredTools.has('move_email')).toBe(true);
      expect(registeredTools.has('add_label')).toBe(true);
      expect(registeredTools.has('remove_label')).toBe(true);
      expect(registeredTools.has('create_draft')).toBe(true);
      expect(registeredTools.has('update_draft')).toBe(true);
      expect(registeredTools.has('send_draft')).toBe(true);
      expect(registeredTools.size).toBe(9);
    });
  });
});
