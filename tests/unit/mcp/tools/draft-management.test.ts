import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(),
}));

import { registerEmailOperationTools } from '../../../../src/mcp/tools/email-operations.js';
import type { JMAPClient } from '../../../../src/jmap/client.js';
import type { Logger } from '../../../../src/config/logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setApprover } from '../../../../src/mcp/approval.js';

// Test utilities
interface ToolRegistration {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
    };
  };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

describe('Draft Management Tools', () => {
  let mockServer: McpServer;
  let mockJmapClient: JMAPClient;
  let mockLogger: Logger;
  let registeredTools: Map<string, ToolRegistration>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Track tool registrations
    registeredTools = new Map();

    // Mock McpServer
    mockServer = {
      registerTool: vi.fn((name: string, config: unknown, handler: unknown) => {
        registeredTools.set(name, {
          name,
          config: config as ToolRegistration['config'],
          handler: handler as ToolRegistration['handler'],
        });
      }),
    } as unknown as McpServer;
    // these tests script every JMAP call: the client confirms (approval prompts are tested in tests/unit/mcp/approval.test.ts)
    setApprover(mockServer, { mode: 'client', language: 'en', timeoutMs: 1000 });

    // Mock JMAPClient
    mockJmapClient = {
      getSession: vi.fn().mockReturnValue({ accountId: 'account1' }),
      request: vi.fn(),
      parseMethodResponse: vi.fn(),
    } as unknown as JMAPClient;

    // Mock Logger
    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;
  });

  describe('update_draft', () => {
    it('registers update_draft tool with correct metadata', () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);

      expect(registeredTools.has('update_draft')).toBe(true);
      const tool = registeredTools.get('update_draft')!;

      expect(tool.config.title).toBe('Update Draft Email');
      expect(tool.config.annotations.readOnlyHint).toBe(false);
      expect(tool.config.annotations.destructiveHint).toBe(false);
      expect(tool.config.annotations.idempotentHint).toBe(true); // Update is idempotent
      expect(tool.config.annotations.openWorldHint).toBe(true);
    });

    // JMAP e-mails are immutable except keywords and mailboxes (RFC 8621 §4.6): update_draft reads the
    // draft, creates its new version and destroys the old one in one Email/set.
    const DRAFT = {
      id: 'draft-1',
      from: [{ name: 'Alice MARTIN', email: 'alice.martin@example.com' }],
      to: [{ email: 'bob.durand@example.com' }],
      subject: 'Old subject',
      inReplyTo: ['orig@example.com'],
      references: ['orig@example.com'],
      mailboxIds: { 'mb-drafts': true },
      keywords: { $draft: true, $seen: true },
      textBody: [{ partId: '1', type: 'text/plain', blobId: 'x', size: 3 }],
      htmlBody: [{ partId: '1', type: 'text/plain', blobId: 'x', size: 3 }],
      bodyValues: { '1': { value: 'Old body', isTruncated: false } },
      attachments: [{ blobId: 'blob-a', type: 'application/pdf', name: 'devis.pdf', size: 1000 }],
    };

    function mockDraftThen(setData: Record<string, unknown>, draft: Record<string, unknown> | null = DRAFT) {
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({ methodResponses: [['Email/get', { list: draft ? [draft] : [] }, 'getDraft']] })
        .mockResolvedValueOnce({ methodResponses: [['Email/set', setData, 'updateDraft']] });
      vi.mocked(mockJmapClient.parseMethodResponse).mockImplementation((r: any) =>
        r[0] === 'error' ? { success: false, error: r[1] } : { success: true, data: r[1] }
      );
    }
    const setCall = () => vi.mocked(mockJmapClient.request).mock.calls[1][0][0];

    it('replaces the draft with its new subject and body, keeping threading and attachments', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({ created: { draft: { id: 'draft-2' } }, destroyed: ['draft-1'] });

      const result = await tool.handler({ draftId: 'draft-1', subject: 'Updated Subject', body: 'Updated body text' });

      expect(result.isError).toBeUndefined();
      const out = JSON.parse(result.content[0].text);
      expect(out).toMatchObject({ success: true, draftId: 'draft-2', previousDraftId: 'draft-1', updated: ['subject', 'body'] });
      const [method, params] = setCall();
      expect(method).toBe('Email/set');
      expect(params.destroy).toEqual(['draft-1']);
      const created = params.create.draft;
      expect(created.subject).toBe('Updated Subject');
      expect(created.bodyValues.text.value).toBe('Updated body text');
      expect(created.inReplyTo).toEqual(['orig@example.com']);
      expect(created.references).toEqual(['orig@example.com']);
      expect(created.mailboxIds).toEqual({ 'mb-drafts': true });
      expect(created.keywords).toEqual({ $draft: true, $seen: true });
      expect(created.to).toEqual([{ email: 'bob.durand@example.com' }]);
      expect(created.attachments).toEqual([{ blobId: 'blob-a', type: 'application/pdf', name: 'devis.pdf', disposition: 'attachment' }]);
    });

    it('updates draft recipients and keeps the body as it was', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({ created: { draft: { id: 'draft-2' } }, destroyed: ['draft-1'] });

      const result = await tool.handler({
        draftId: 'draft-1',
        to: ['user1@example.com', 'user2@example.com'],
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
      });

      expect(result.isError).toBeUndefined();
      const created = setCall()[1].create.draft;
      expect(created.to).toEqual([{ email: 'user1@example.com' }, { email: 'user2@example.com' }]);
      expect(created.cc).toEqual([{ email: 'cc@example.com' }]);
      expect(created.bcc).toEqual([{ email: 'bcc@example.com' }]);
      expect(created.subject).toBe('Old subject');
      expect(created.bodyValues).toEqual({ '1': { value: 'Old body' } });
      expect(created.textBody).toEqual([{ partId: '1', type: 'text/plain' }]);
    });

    it('returns error when draft not found', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({}, null);

      const result = await tool.handler({ draftId: 'draft-1', subject: 'New Subject' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Draft not found');
      expect(vi.mocked(mockJmapClient.request)).toHaveBeenCalledTimes(1);
    });

    it('refuses to rewrite an e-mail that is not a draft', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({}, { ...DRAFT, keywords: { $seen: true } });

      const result = await tool.handler({ draftId: 'draft-1', subject: 'New Subject' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not a draft');
      expect(vi.mocked(mockJmapClient.request)).toHaveBeenCalledTimes(1);
    });

    it('returns error when state mismatch occurs', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce({ methodResponses: [['Email/get', { list: [DRAFT] }, 'getDraft']] })
        .mockResolvedValueOnce({ methodResponses: [['error', { type: 'stateMismatch' }, 'updateDraft']] });
      vi.mocked(mockJmapClient.parseMethodResponse).mockImplementation((r: any) =>
        r[0] === 'error' ? { success: false, error: r[1] } : { success: true, data: r[1] }
      );

      const result = await tool.handler({ draftId: 'draft-1', subject: 'New Subject', ifInState: 'old-state' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('modified by another client');
    });

    it('reports a draft the server could not create', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({ notCreated: { draft: { type: 'invalidProperties', description: 'bad' } } });

      const result = await tool.handler({ draftId: 'draft-1', subject: 'x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('invalidProperties');
    });

    it('returns error when no fields to update', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('update_draft')!;

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No fields to update');
      expect(vi.mocked(mockJmapClient.request)).not.toHaveBeenCalled();
    });

    it('supports optional ifInState parameter', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({ created: { draft: { id: 'draft-2' } }, destroyed: ['draft-1'] });

      await tool.handler({ draftId: 'draft-1', subject: 'New Subject', ifInState: 'state-123' });

      expect(setCall()[1].ifInState).toBe('state-123');
    });
  });

  describe('send_draft', () => {
    it('registers send_draft tool with correct metadata', () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);

      expect(registeredTools.has('send_draft')).toBe(true);
      const tool = registeredTools.get('send_draft')!;

      expect(tool.config.title).toBe('Send Draft Email');
      expect(tool.config.annotations.readOnlyHint).toBe(false);
      expect(tool.config.annotations.destructiveHint).toBe(false);
      expect(tool.config.annotations.idempotentHint).toBe(false); // Send is NOT idempotent
      expect(tool.config.annotations.openWorldHint).toBe(true);
    });

    it('sends draft and moves to Sent folder', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('send_draft')!;

      // Mock setup response (Identity/get, Mailbox/get)
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      // Mock send response (EmailSubmission/set)
      const sendResponse = {
        methodResponses: [
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitDraft'],
        ],
      };

      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);

      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'identity1', email: 'test@example.com' }] } })
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] } })
        .mockReturnValueOnce({ success: true, data: { created: { submission: { id: 'submission-1' } } } });

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('success');
      expect(result.content[0].text).toContain('submission-1');

      // Verify onSuccessUpdateEmail includes correct structure
      const sendCall = vi.mocked(mockJmapClient.request).mock.calls[1][0];
      const submissionCall = sendCall[0];
      expect(submissionCall[0]).toBe('EmailSubmission/set');
      const params = submissionCall[1] as Record<string, unknown>;
      const onSuccess = params.onSuccessUpdateEmail as Record<string, Record<string, unknown>>;
      const update = onSuccess['#submission'];

      expect(update['keywords/$draft']).toBe(null); // Remove draft keyword
      expect(update['mailboxIds/drafts-1']).toBe(null); // Remove from Drafts
      expect(update['mailboxIds/sent-1']).toBe(true); // Add to Sent
    });

    it('sends draft when Sent mailbox missing', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('send_draft')!;

      // Mock setup response (Identity/get, Mailbox/get with no Sent)
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'drafts-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitDraft'],
        ],
      };

      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);

      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'identity1', email: 'test@example.com' }] } })
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'drafts-1', role: 'drafts' }] } })
        .mockReturnValueOnce({ success: true, data: { created: { submission: { id: 'submission-1' } } } });

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.movedToSent).toBe(false); // No Sent mailbox to move to

      // Verify onSuccessUpdateEmail only removes draft keyword
      const sendCall = vi.mocked(mockJmapClient.request).mock.calls[1][0];
      const submissionCall = sendCall[0];
      const params = submissionCall[1] as Record<string, unknown>;
      const onSuccess = params.onSuccessUpdateEmail as Record<string, Record<string, unknown>>;
      const update = onSuccess['#submission'];

      expect(update['keywords/$draft']).toBe(null); // Remove draft keyword
      expect(update['mailboxIds/drafts-1']).toBeUndefined(); // Should not modify mailboxIds if no Sent
    });

    it('returns error for forbiddenFrom', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('send_draft')!;

      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['EmailSubmission/set', { notCreated: { submission: { type: 'forbiddenFrom' } } }, 'submitDraft'],
        ],
      };

      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);

      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'identity1', email: 'test@example.com' }] } })
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] } })
        .mockReturnValueOnce({ success: true, data: { notCreated: { submission: { type: 'forbiddenFrom' } } } });

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Not authorized to send from this address');
    });

    it('returns error for invalidEmail', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('send_draft')!;

      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['EmailSubmission/set', { notCreated: { submission: { type: 'invalidEmail' } } }, 'submitDraft'],
        ],
      };

      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);

      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'identity1', email: 'test@example.com' }] } })
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] } })
        .mockReturnValueOnce({ success: true, data: { notCreated: { submission: { type: 'invalidEmail' } } } });

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Draft is invalid or missing required fields');
    });

    it('returns error for tooManyRecipients', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('send_draft')!;

      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['EmailSubmission/set', { notCreated: { submission: { type: 'tooManyRecipients' } } }, 'submitDraft'],
        ],
      };

      vi.mocked(mockJmapClient.request)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);

      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'identity1', email: 'test@example.com' }] } })
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] } })
        .mockReturnValueOnce({ success: true, data: { notCreated: { submission: { type: 'tooManyRecipients' } } } });

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Too many recipients');
    });

    it('returns error when no identity available', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('send_draft')!;

      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      vi.mocked(mockJmapClient.request).mockResolvedValueOnce(setupResponse);
      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { list: [] } })
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] } });

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No sending identity available');
    });

    it('returns error when mailbox fetch fails', async () => {
      registerEmailOperationTools(mockServer, mockJmapClient, mockLogger);
      const tool = registeredTools.get('send_draft')!;

      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', email: 'test@example.com' }] }, 'getIdentity'],
          ['error', { type: 'serverError' }, 'getMailboxes'],
        ],
      };

      vi.mocked(mockJmapClient.request).mockResolvedValueOnce(setupResponse);
      vi.mocked(mockJmapClient.parseMethodResponse)
        .mockReturnValueOnce({ success: true, data: { list: [{ id: 'identity1', email: 'test@example.com' }] } })
        .mockReturnValueOnce({ success: false, error: { type: 'serverError' } });

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to get mailboxes');
    });
  });
});
