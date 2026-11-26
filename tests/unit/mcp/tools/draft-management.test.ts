import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(),
}));

import { registerEmailOperationTools } from '../../../../src/mcp/tools/email-operations.js';
import { fakeJmap, type FakeJmap } from '../../../../src/jmap/__tests__/fake-jmap.js';
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
  let jmap: FakeJmap;
  let mockLogger: Logger;
  let registeredTools: Map<string, ToolRegistration>;

  beforeEach(async () => {
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

    // Fake JMAP server
    jmap = await fakeJmap({ accountId: 'account1' });

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
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);

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
      jmap.request
        .mockResolvedValueOnce({ methodResponses: [['Email/get', { list: draft ? [draft] : [] }, 'getDraft']] })
        .mockResolvedValueOnce({ methodResponses: [['Email/set', setData, 'updateDraft']] });
    }
    const setCall = () => jmap.request.mock.calls[1][0][0];

    it('replaces the draft with its new subject and body, keeping threading and attachments', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
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

    it('keeps the quote of a reply draft when its body changes', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger, { text: 'Alice', html: '<p>Alice</p>' });
      const tool = registeredTools.get('update_draft')!;
      const quoteHtml = '<div class="quote"><p>Bob a écrit :</p><blockquote type="cite"><p>Budget ?</p></blockquote></div>';
      mockDraftThen({ created: { draft: { id: 'draft-2' } }, destroyed: ['draft-1'] }, {
        ...DRAFT,
        textBody: [{ partId: 'text', type: 'text/plain' }],
        htmlBody: [{ partId: 'html', type: 'text/html' }],
        bodyValues: {
          text: { value: 'Old\n\n-- \nAlice\n\nLe 30/10/2026 à 14:02, Bob a écrit :\n> Budget ?\n>> plus ancien' },
          html: { value: `<!DOCTYPE html><html><body>\n<p>Old</p>\n<br>\n<div class="signature">-- <br>\n<p>Alice</p></div>\n<br>\n${quoteHtml}\n</body></html>` },
        },
      });

      await tool.handler({ draftId: 'draft-1', body: 'New' });

      const created = setCall()[1].create.draft;
      expect(created.bodyValues.text.value).toBe('New\n\n-- \nAlice\n\nLe 30/10/2026 à 14:02, Bob a écrit :\n> Budget ?\n>> plus ancien');
      expect(created.bodyValues.html.value).toContain('<p>New</p>');
      expect(created.bodyValues.html.value).toContain(quoteHtml);
    });

    it('does not bring back a signature the draft was made without', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger, { text: 'Alice', html: '<p>Alice</p>' });
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({ created: { draft: { id: 'draft-2' } }, destroyed: ['draft-1'] });

      await tool.handler({ draftId: 'draft-1', body: 'New' });

      expect(setCall()[1].create.draft.bodyValues.text.value).toBe('New');
    });

    it('updates draft recipients and keeps the body as it was', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
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
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({}, null);

      const result = await tool.handler({ draftId: 'draft-1', subject: 'New Subject' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Draft not found');
      expect(jmap.request).toHaveBeenCalledTimes(1);
    });

    it('refuses to rewrite an e-mail that is not a draft', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({}, { ...DRAFT, keywords: { $seen: true } });

      const result = await tool.handler({ draftId: 'draft-1', subject: 'New Subject' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not a draft');
      expect(jmap.request).toHaveBeenCalledTimes(1);
    });

    it('returns error when state mismatch occurs', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      jmap.request
        .mockResolvedValueOnce({ methodResponses: [['Email/get', { list: [DRAFT] }, 'getDraft']] })
        .mockResolvedValueOnce({ methodResponses: [['error', { type: 'stateMismatch' }, 'updateDraft']] });

      const result = await tool.handler({ draftId: 'draft-1', subject: 'New Subject', ifInState: 'old-state' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('modified by another client');
    });

    it('reports a draft the server could not create', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({ notCreated: { draft: { type: 'invalidProperties', description: 'bad' } } });

      const result = await tool.handler({ draftId: 'draft-1', subject: 'x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('invalidProperties');
    });

    it('returns error when no fields to update', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      const tool = registeredTools.get('update_draft')!;

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No fields to update');
      expect(jmap.request).not.toHaveBeenCalled();
    });

    it('supports optional ifInState parameter', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      const tool = registeredTools.get('update_draft')!;
      mockDraftThen({ created: { draft: { id: 'draft-2' } }, destroyed: ['draft-1'] });

      await tool.handler({ draftId: 'draft-1', subject: 'New Subject', ifInState: 'state-123' });

      expect(setCall()[1].ifInState).toBe('state-123');
    });
  });

  describe('send_draft', () => {
    it('registers send_draft tool with correct metadata', () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);

      expect(registeredTools.has('send_draft')).toBe(true);
      const tool = registeredTools.get('send_draft')!;

      expect(tool.config.title).toBe('Send Draft Email');
      expect(tool.config.annotations.readOnlyHint).toBe(false);
      expect(tool.config.annotations.destructiveHint).toBe(false);
      expect(tool.config.annotations.idempotentHint).toBe(false); // Send is NOT idempotent
      expect(tool.config.annotations.openWorldHint).toBe(true);
    });

    it('sends draft and moves to Sent folder', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
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

      jmap.request
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);


      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('success');
      expect(result.content[0].text).toContain('submission-1');

      // Verify onSuccessUpdateEmail includes correct structure
      const sendCall = jmap.request.mock.calls[1][0];
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
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
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

      jmap.request
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);


      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.movedToSent).toBe(false); // No Sent mailbox to move to

      // Verify onSuccessUpdateEmail only removes draft keyword
      const sendCall = jmap.request.mock.calls[1][0];
      const submissionCall = sendCall[0];
      const params = submissionCall[1] as Record<string, unknown>;
      const onSuccess = params.onSuccessUpdateEmail as Record<string, Record<string, unknown>>;
      const update = onSuccess['#submission'];

      expect(update['keywords/$draft']).toBe(null); // Remove draft keyword
      expect(update['mailboxIds/drafts-1']).toBeUndefined(); // Should not modify mailboxIds if no Sent
    });

    it('returns error for forbiddenFrom', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
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

      jmap.request
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);


      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Not authorized to send from this address');
    });

    it('returns error for invalidEmail', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
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

      jmap.request
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);


      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Draft is invalid or missing required fields');
    });

    it('returns error for tooManyRecipients', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
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

      jmap.request
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);


      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Too many recipients');
    });

    it('returns error when no identity available', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      const tool = registeredTools.get('send_draft')!;

      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-1', role: 'sent' }, { id: 'drafts-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      jmap.request.mockResolvedValueOnce(setupResponse);

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No sending identity available');
    });

    it('returns error when mailbox fetch fails', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      const tool = registeredTools.get('send_draft')!;

      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', email: 'test@example.com' }] }, 'getIdentity'],
          ['error', { type: 'serverError' }, 'getMailboxes'],
        ],
      };

      jmap.request.mockResolvedValueOnce(setupResponse);

      const result = await tool.handler({ draftId: 'draft-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to get mailboxes');
    });
  });

  describe('create_draft', () => {
    const ORIGINAL = { id: 'e1', messageId: ['m2@x'], references: ['m1@x'], subject: 'Budget', from: [{ email: 'bob@x' }] };

    function mockCreate(original: Record<string, unknown> | null) {
      jmap.request
        .mockResolvedValueOnce({
          methodResponses: [
            ['Mailbox/get', { list: [{ id: 'mb-drafts', role: 'drafts' }] }, 'getMailboxes'],
            ['Email/get', { list: original ? [original] : [] }, 'getOriginal'],
          ],
        })
        .mockRejectedValueOnce(new Error('no submission capability'))
        .mockResolvedValueOnce({ methodResponses: [['Email/set', { created: { draft: { id: 'd1', threadId: 't1' } } }, 'createDraft']] });
    }
    const setCall = () => jmap.request.mock.calls.map((c) => c[0][0]).find(([m]: any) => m === 'Email/set');

    it('threads a draft under the e-mail given by replyToEmailId', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      mockCreate(ORIGINAL);

      const result = await registeredTools.get('create_draft')!.handler({ to: ['bob@x'], subject: 'Re: Budget', body: 'OK', replyToEmailId: 'e1' });

      expect(result.isError).toBeUndefined();
      const getOriginal = jmap.request.mock.calls[0][0][1];
      expect(getOriginal[0]).toBe('Email/get');
      expect(getOriginal[1].ids).toEqual(['e1']);
      const created = setCall()![1].create.draft;
      expect(created.inReplyTo).toEqual(['m2@x']);
      expect(created.references).toEqual(['m1@x', 'm2@x']);
    });

    it('refuses inReplyTo and replyToEmailId together', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);

      const result = await registeredTools.get('create_draft')!.handler({ body: 'x', inReplyTo: 'm@x', replyToEmailId: 'e1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('either inReplyTo or replyToEmailId');
      expect(jmap.request).not.toHaveBeenCalled();
    });

    it('says so when the e-mail to answer does not exist, and creates nothing', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      mockCreate(null);

      const result = await registeredTools.get('create_draft')!.handler({ body: 'OK', replyToEmailId: 'e1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Original email not found: e1');
      expect(setCall()).toBeUndefined();
    });

    it('still takes a Message-ID in inReplyTo', async () => {
      registerEmailOperationTools(mockServer, jmap.client, mockLogger);
      jmap.request
        .mockResolvedValueOnce({ methodResponses: [['Mailbox/get', { list: [{ id: 'mb-drafts', role: 'drafts' }] }, 'getMailboxes']] })
        .mockRejectedValueOnce(new Error('no submission capability'))
        .mockResolvedValueOnce({ methodResponses: [['Email/set', { created: { draft: { id: 'd1', threadId: 't1' } } }, 'createDraft']] });

      const result = await registeredTools.get('create_draft')!.handler({ body: 'OK', inReplyTo: '<m2@x>' });

      expect(result.isError).toBeUndefined();
      expect(jmap.request.mock.calls[0][0]).toHaveLength(1);
      expect(setCall()![1].create.draft.inReplyTo).toEqual(['m2@x']);
    });
  });

  describe('attachments', () => {
    let base: string;
    let root: string;

    const withMaxUpload = async (maxSizeUpload: number) => {
      jmap = await fakeJmap({ accountId: 'account1', session: { capabilities: { 'urn:ietf:params:jmap:core': { maxSizeUpload }, 'urn:ietf:params:jmap:mail': {} } } });
      jmap.upload.mockImplementation((_data: Uint8Array, type: string) => ({ accountId: 'account1', blobId: `blob-${type}`, type, size: 3 }));
    };

    beforeEach(async () => {
      base = mkdtempSync(join(tmpdir(), 'draft-files-'));
      root = join(base, 'uploads');
      mkdirSync(root);
      writeFileSync(join(root, 'devis.pdf'), 'pdf');
      writeFileSync(join(root, 'plan.png'), 'png!');
      writeFileSync(join(base, 'secret.txt'), 'secret');
      await withMaxUpload(1000);
    });
    afterEach(() => rmSync(base, { recursive: true, force: true }));

    const register = () => registerEmailOperationTools(mockServer, jmap.client, mockLogger, undefined, { uploadDir: root });
    const setCall = () => jmap.request.mock.calls.map((c) => c[0][0]).find(([m]: any) => m === 'Email/set');
    function mockCreate() {
      jmap.request
        .mockResolvedValueOnce({ methodResponses: [['Mailbox/get', { list: [{ id: 'mb-drafts', role: 'drafts' }] }, 'getMailboxes']] })
        .mockRejectedValueOnce(new Error('no submission capability'))
        .mockResolvedValueOnce({ methodResponses: [['Email/set', { created: { draft: { id: 'd1', threadId: 't1' } } }, 'createDraft']] });
    }

    it('create_draft uploads the files and attaches them to the draft', async () => {
      register();
      mockCreate();

      const result = await registeredTools.get('create_draft')!.handler({ to: ['bob@x'], body: 'Ci-joint.', attachments: ['devis.pdf'] });

      expect(result.isError).toBeUndefined();
      expect(jmap.upload).toHaveBeenCalledTimes(1);
      expect(setCall()![1].create.draft.attachments).toEqual([{ blobId: 'blob-application/pdf', type: 'application/pdf', name: 'devis.pdf', disposition: 'attachment' }]);
    });

    it('create_draft refuses a file outside the upload folder before uploading anything', async () => {
      register();
      mockCreate();

      const result = await registeredTools.get('create_draft')!.handler({ body: 'x', attachments: ['../secret.txt'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/inside .*JMAP_UPLOAD_DIR/);
      expect(jmap.upload).not.toHaveBeenCalled();
      expect(setCall()).toBeUndefined();
    });

    it('create_draft refuses a file over the server limit', async () => {
      await withMaxUpload(2);
      register();
      mockCreate();

      const result = await registeredTools.get('create_draft')!.handler({ body: 'x', attachments: ['devis.pdf'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('over the 2 B the server accepts');
      expect(jmap.upload).not.toHaveBeenCalled();
    });

    const DRAFT = {
      id: 'draft-1',
      from: [{ email: 'alice@x' }],
      to: [{ email: 'bob@x' }],
      subject: 'Devis',
      mailboxIds: { 'mb-drafts': true },
      keywords: { $draft: true, $seen: true },
      textBody: [{ partId: '1', type: 'text/plain' }],
      htmlBody: [{ partId: '1', type: 'text/plain' }],
      bodyValues: { '1': { value: 'Ci-joint.' } },
      attachments: [{ blobId: 'blob-a', type: 'application/pdf', name: 'devis.pdf', size: 1000 }],
    };
    function mockUpdate() {
      jmap.request
        .mockResolvedValueOnce({ methodResponses: [['Email/get', { list: [DRAFT] }, 'getDraft']] })
        .mockResolvedValueOnce({ methodResponses: [['Email/set', { created: { draft: { id: 'draft-2' } }, destroyed: ['draft-1'] }, 'updateDraft']] });
    }

    it('update_draft adds files to the attachments a draft has, and removes some by name', async () => {
      register();
      mockUpdate();

      const result = await registeredTools.get('update_draft')!.handler({ draftId: 'draft-1', attachments: ['plan.png'], removeAttachments: ['devis.pdf'] });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).updated).toEqual(['attachments']);
      expect(setCall()![1].create.draft.attachments).toEqual([{ blobId: 'blob-image/png', type: 'image/png', name: 'plan.png', disposition: 'attachment' }]);
    });

    it('update_draft keeps the attachments it already had when adding one', async () => {
      register();
      mockUpdate();

      await registeredTools.get('update_draft')!.handler({ draftId: 'draft-1', attachments: ['plan.png'] });

      expect(setCall()![1].create.draft.attachments.map((a: any) => a.name)).toEqual(['devis.pdf', 'plan.png']);
    });

    it('update_draft says which attachment to remove does not exist, and changes nothing', async () => {
      register();
      mockUpdate();

      const result = await registeredTools.get('update_draft')!.handler({ draftId: 'draft-1', removeAttachments: ['absent.pdf'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No attachment named absent.pdf in this draft: it has devis.pdf');
      expect(setCall()).toBeUndefined();
    });
  });
});
