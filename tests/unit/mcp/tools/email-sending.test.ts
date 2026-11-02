import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(),
}));

import { registerEmailSendingTools } from '../../../../src/mcp/tools/email-sending.js';
import { createFakeJmap, type FakeJmap } from '../../../../src/testing/fake-jmap.js';
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

describe('Email Sending Tools', () => {
  let mockServer: McpServer;
  let mockJmapClient: FakeJmap;
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

    mockJmapClient = await createFakeJmap('account1');

    // Mock Logger
    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;
  });

  describe('send_email', () => {
    it('registers send_email tool with correct metadata', () => {
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);

      expect(registeredTools.has('send_email')).toBe(true);
      const tool = registeredTools.get('send_email')!;

      expect(tool.config.title).toBe('Send Email');
      expect(tool.config.annotations.readOnlyHint).toBe(false);
      expect(tool.config.annotations.destructiveHint).toBe(false);
      expect(tool.config.annotations.idempotentHint).toBe(false);
      expect(tool.config.annotations.openWorldHint).toBe(true);
    });

    it('sends email with plain text body', async () => {
      // Mock setup response (Identity/get, Mailbox/query x2)
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      // Mock send response (Email/set, EmailSubmission/set)
      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { email: { id: 'email-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createEmail'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('send_email')!;

      const result = await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.emailId).toBe('email-1');
      expect(response.submissionId).toBe('submission-1');

      // Verify Email/set was called with textBody (not bodyStructure)
      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.email.textBody).toEqual([{ partId: 'text', type: 'text/plain' }]);
      expect(emailSetCall[1].create.email.bodyValues.text.value).toBe('Hello, World!');
    });

    it('sends email with multipart body (text + HTML)', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { email: { id: 'email-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createEmail'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('send_email')!;

      await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
        htmlBody: '<p>Hello, World!</p>',
      });

      // Verify Email/set was called with both textBody and htmlBody
      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.email.textBody).toEqual([{ partId: 'text', type: 'text/plain' }]);
      expect(emailSetCall[1].create.email.htmlBody).toEqual([{ partId: 'html', type: 'text/html' }]);
      expect(emailSetCall[1].create.email.bodyValues).toHaveProperty('text');
      expect(emailSetCall[1].create.email.bodyValues).toHaveProperty('html');
    });

    it('includes submission capability in requests', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { email: { id: 'email-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createEmail'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('send_email')!;

      await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
      });

      // Verify submission capability in request
      const [, using] = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(using).toContain('urn:ietf:params:jmap:submission');
    });

    it('handles missing identity gracefully', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(setupResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('send_email')!;

      const result = await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No sending identity available');
    });

    it('handles email creation failure', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { notCreated: { email: { type: 'invalidProperties', description: 'Bad email data' } } }, 'createEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('send_email')!;

      const result = await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('invalidProperties');
    });

    it('handles submission failure', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { email: { id: 'email-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createEmail'],
          ['EmailSubmission/set', { notCreated: { submission: { type: 'forbiddenFrom', description: 'Cannot send from this address' } } }, 'submitEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('send_email')!;

      const result = await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not authorized to send from this address');
    });
  });

  describe('reply_email', () => {
    it('registers reply_email tool with correct metadata', () => {
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);

      expect(registeredTools.has('reply_email')).toBe(true);
      const tool = registeredTools.get('reply_email')!;

      expect(tool.config.title).toBe('Reply to Email');
      expect(tool.config.annotations.readOnlyHint).toBe(false);
      expect(tool.config.annotations.idempotentHint).toBe(false);
    });

    it('builds correct threading headers', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              messageId: ['<msg1@example.com>'],
              references: ['<ref1@example.com>'],
              subject: 'Original Subject',
              from: [{ name: 'Sender', email: 'sender@example.com' }],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { reply: { id: 'reply-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createReply'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitReply'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('reply_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        body: 'This is my reply.',
      });

      // Verify Email/set was called with correct threading headers
      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      const emailCreate = emailSetCall[1].create.reply;

      expect(emailCreate.inReplyTo).toEqual(['<msg1@example.com>']);
      expect(emailCreate.references).toEqual(['<ref1@example.com>', '<msg1@example.com>']);
    });

    it('adds Re: prefix to subject', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              messageId: ['<msg1@example.com>'],
              subject: 'Hello',
              from: [{ email: 'sender@example.com' }],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { reply: { id: 'reply-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createReply'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitReply'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('reply_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        body: 'This is my reply.',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.reply.subject).toBe('Re: Hello');
    });

    it('preserves existing Re: prefix', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              messageId: ['<msg1@example.com>'],
              subject: 'Re: Hello',
              from: [{ email: 'sender@example.com' }],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { reply: { id: 'reply-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createReply'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitReply'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('reply_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        body: 'This is my reply.',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.reply.subject).toBe('Re: Hello');
    });

    it('uses replyTo address when available', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              messageId: ['<msg1@example.com>'],
              subject: 'Hello',
              from: [{ email: 'from@example.com' }],
              replyTo: [{ email: 'reply@example.com' }],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { reply: { id: 'reply-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createReply'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitReply'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('reply_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        body: 'This is my reply.',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.reply.to).toEqual([{ email: 'reply@example.com' }]);
    });

    it('falls back to from address when no replyTo', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              messageId: ['<msg1@example.com>'],
              subject: 'Hello',
              from: [{ email: 'from@example.com' }],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { reply: { id: 'reply-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createReply'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitReply'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('reply_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        body: 'This is my reply.',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.reply.to).toEqual([{ email: 'from@example.com' }]);
    });

    it('includes all recipients on replyAll', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              messageId: ['<msg1@example.com>'],
              subject: 'Hello',
              from: [{ email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }, { email: 'other@example.com' }],
              cc: [{ email: 'cc1@example.com' }, { email: 'cc2@example.com' }],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { reply: { id: 'reply-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createReply'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitReply'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('reply_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        body: 'This is my reply.',
        replyAll: true,
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      const toEmails = emailSetCall[1].create.reply.to.map((t: { email: string }) => t.email);
      const ccEmails = emailSetCall[1].create.reply.cc.map((c: { email: string }) => c.email);

      // Should include sender and other@example.com in to, but not me@example.com (self)
      expect(toEmails).toContain('sender@example.com');
      expect(toEmails).toContain('other@example.com');
      expect(toEmails).not.toContain('me@example.com');

      // Should include cc addresses
      expect(ccEmails).toContain('cc1@example.com');
      expect(ccEmails).toContain('cc2@example.com');
    });

    it('excludes self from replyAll recipients', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'ME@EXAMPLE.COM' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              messageId: ['<msg1@example.com>'],
              subject: 'Hello',
              from: [{ email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }, { email: 'other@example.com' }],
              cc: [{ email: 'me@example.com' }], // Self in CC with different case
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { reply: { id: 'reply-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createReply'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitReply'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('reply_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        body: 'This is my reply.',
        replyAll: true,
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      const toEmails = emailSetCall[1].create.reply.to.map((t: { email: string }) => t.email.toLowerCase());
      const ccEmails = emailSetCall[1].create.reply.cc?.map((c: { email: string }) => c.email.toLowerCase()) || [];

      // Self should be excluded (case-insensitive)
      expect(toEmails).not.toContain('me@example.com');
      expect(ccEmails).not.toContain('me@example.com');
    });

    it('handles original email not found', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', { list: [] }, 'getOriginal'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(setupResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('reply_email')!;

      const result = await tool.handler({
        originalEmailId: 'nonexistent-email-id',
        body: 'This is my reply.',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Original email not found');
      expect(result.content[0].text).toContain('nonexistent-email-id');
    });
  });

  describe('signature injection', () => {
    const mockSignature = {
      text: 'Best regards,\nJohn Doe',
      html: '<p>Best regards,<br/>John Doe</p>',
    };

    it('sends email with text signature appended', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { email: { id: 'email-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createEmail'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger, { signatureContent: mockSignature });
      const tool = registeredTools.get('send_email')!;

      await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.email.bodyValues.text.value).toBe('Hello, World!\n\n-- \nBest regards,\nJohn Doe');
    });

    it('sends email with HTML signature appended', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { email: { id: 'email-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createEmail'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger, { signatureContent: mockSignature });
      const tool = registeredTools.get('send_email')!;

      await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        htmlBody: '<p>Hello, World!</p>',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.email.bodyValues.html.value).toBe('<p>Hello, World!</p><br/><br/>-- <br/><p>Best regards,<br/>John Doe</p>');
    });

    it('sends email without signature when not configured', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { email: { id: 'email-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createEmail'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('send_email')!;

      await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.email.bodyValues.text.value).toBe('Hello, World!');
    });

    it('uses explicit from parameter when provided', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { email: { id: 'email-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createEmail'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger, { defaultFrom: 'default@example.com' });
      const tool = registeredTools.get('send_email')!;

      await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
        from: 'custom@example.com',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.email.from).toEqual([{ name: 'Test User', email: 'custom@example.com' }]);
    });

    it('uses defaultFrom when from parameter not provided', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { email: { id: 'email-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createEmail'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger, { defaultFrom: 'default@example.com' });
      const tool = registeredTools.get('send_email')!;

      await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.email.from).toEqual([{ name: 'Test User', email: 'default@example.com' }]);
    });

    it('falls back to identity.email when neither from nor defaultFrom provided', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'test@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { email: { id: 'email-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createEmail'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitEmail'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('send_email')!;

      await tool.handler({
        to: ['recipient@example.com'],
        subject: 'Test Subject',
        body: 'Hello, World!',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.email.from).toEqual([{ name: 'Test User', email: 'test@example.com' }]);
    });

    it('appends signature to reply body', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              messageId: ['<msg1@example.com>'],
              subject: 'Original Subject',
              from: [{ name: 'Sender', email: 'sender@example.com' }],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { reply: { id: 'reply-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createReply'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitReply'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger, { signatureContent: mockSignature });
      const tool = registeredTools.get('reply_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        body: 'This is my reply.',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.reply.bodyValues.text.value).toBe('This is my reply.\n\n-- \nBest regards,\nJohn Doe');
    });

    it('uses defaultFrom in reply when from parameter not provided', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              messageId: ['<msg1@example.com>'],
              subject: 'Original Subject',
              from: [{ name: 'Sender', email: 'sender@example.com' }],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { reply: { id: 'reply-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createReply'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitReply'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger, { defaultFrom: 'default@example.com' });
      const tool = registeredTools.get('reply_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        body: 'This is my reply.',
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.reply.from).toEqual([{ name: 'Test User', email: 'default@example.com' }]);
    });
  });

  describe('forward_email', () => {
    it('registers forward_email tool with correct metadata', () => {
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);

      expect(registeredTools.has('forward_email')).toBe(true);
      const tool = registeredTools.get('forward_email')!;

      expect(tool.config.title).toBe('Forward Email');
      expect(tool.config.annotations.readOnlyHint).toBe(false);
      expect(tool.config.annotations.idempotentHint).toBe(false);
      expect(tool.config.annotations.openWorldHint).toBe(true);
    });

    it('should forward email without attachments', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              subject: 'Original Subject',
              from: [{ name: 'Sender', email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }],
              sentAt: '2026-01-15T10:00:00Z',
              textBody: [{ partId: 'text1' }],
              htmlBody: [{ partId: 'html1' }],
              bodyValues: {
                text1: { value: 'Original body text' },
                html1: { value: '<p>Original body text</p>' },
              },
              attachments: [],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { forward: { id: 'forward-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createForward'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitForward'],
        ],
      };

      const markResponse = {
        methodResponses: [
          ['Email/set', { updated: { 'original-email-1': null } }, 'markForwarded'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse)
        .mockResolvedValueOnce(markResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('forward_email')!;

      const result = await tool.handler({
        originalEmailId: 'original-email-1',
        to: ['recipient@example.com'],
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.emailId).toBe('forward-1');
      expect(response.submissionId).toBe('submission-1');

      // Verify Email/set was called with textBody/htmlBody (not bodyStructure for no attachments)
      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.forward.textBody).toBeDefined();
      expect(emailSetCall[1].create.forward.htmlBody).toBeDefined();
      expect(emailSetCall[1].create.forward.bodyStructure).toBeUndefined();

      // Verify no inReplyTo or references headers
      expect(emailSetCall[1].create.forward.inReplyTo).toBeUndefined();
      expect(emailSetCall[1].create.forward.references).toBeUndefined();
    });

    it('should forward email with attachments using blobId references', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              subject: 'Original Subject',
              from: [{ email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }],
              sentAt: '2026-01-15T10:00:00Z',
              textBody: [{ partId: 'text1' }],
              bodyValues: { text1: { value: 'Original body' } },
              attachments: [
                { blobId: 'blob-att-1', type: 'application/pdf', name: 'document.pdf', size: 1024 },
                { blobId: 'blob-att-2', type: 'image/png', name: 'image.png', size: 2048 },
              ],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { forward: { id: 'forward-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createForward'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitForward'],
        ],
      };

      const markResponse = {
        methodResponses: [
          ['Email/set', { updated: { 'original-email-1': null } }, 'markForwarded'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse)
        .mockResolvedValueOnce(markResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('forward_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        to: ['recipient@example.com'],
      });

      // Verify attachments property is used (not bodyStructure) for Apache James compatibility
      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      const emailData = emailSetCall[1].create.forward;

      // Should use textBody/htmlBody instead of bodyStructure
      expect(emailData.textBody).toBeDefined();
      expect(emailData.htmlBody).toBeDefined();
      expect(emailData.bodyStructure).toBeUndefined();

      // Attachments should be referenced via attachments property
      expect(emailData.attachments).toBeDefined();
      expect(emailData.attachments).toHaveLength(2);
      expect(emailData.attachments[0].blobId).toBe('blob-att-1');
      expect(emailData.attachments[0].name).toBe('document.pdf');
      expect(emailData.attachments[1].blobId).toBe('blob-att-2');
      expect(emailData.attachments[1].name).toBe('image.png');
    });

    it('should include personal note above forwarded content', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              subject: 'Test',
              from: [{ email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }],
              sentAt: '2026-01-15T10:00:00Z',
              textBody: [{ partId: 'text1' }],
              bodyValues: { text1: { value: 'Original body' } },
              attachments: [],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { forward: { id: 'forward-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createForward'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitForward'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse)
        .mockResolvedValueOnce({ methodResponses: [] });
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('forward_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        to: ['recipient@example.com'],
        note: 'FYI - check this out!',
      });

      // Verify note appears before forwarded content
      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      const textBodyValue = emailSetCall[1].create.forward.bodyValues.text.value;

      expect(textBodyValue).toContain('FYI - check this out!');
      expect(textBodyValue.indexOf('FYI - check this out!')).toBeLessThan(textBodyValue.indexOf('Forwarded message'));
    });

    it('should not duplicate Fwd: prefix', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              subject: 'Fwd: Already Forwarded',
              from: [{ email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }],
              sentAt: '2026-01-15T10:00:00Z',
              textBody: [{ partId: 'text1' }],
              bodyValues: { text1: { value: 'Content' } },
              attachments: [],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { forward: { id: 'forward-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createForward'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitForward'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse)
        .mockResolvedValueOnce({ methodResponses: [] });
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('forward_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        to: ['recipient@example.com'],
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.forward.subject).toBe('Fwd: Already Forwarded');
      expect(emailSetCall[1].create.forward.subject).not.toBe('Fwd: Fwd: Already Forwarded');
    });

    it('should add Fwd: prefix to subject', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              subject: 'Hello World',
              from: [{ email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }],
              sentAt: '2026-01-15T10:00:00Z',
              textBody: [{ partId: 'text1' }],
              bodyValues: { text1: { value: 'Content' } },
              attachments: [],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { forward: { id: 'forward-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createForward'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitForward'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse)
        .mockResolvedValueOnce({ methodResponses: [] });
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('forward_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        to: ['recipient@example.com'],
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.forward.subject).toBe('Fwd: Hello World');
    });

    it('should return error when original email not found', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', { list: [] }, 'getOriginal'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(setupResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('forward_email')!;

      const result = await tool.handler({
        originalEmailId: 'nonexistent-email-id',
        to: ['recipient@example.com'],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Original email not found');
      expect(result.content[0].text).toContain('nonexistent-email-id');
    });

    it('should forward to multiple recipients with cc and bcc', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              subject: 'Test',
              from: [{ email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }],
              sentAt: '2026-01-15T10:00:00Z',
              textBody: [{ partId: 'text1' }],
              bodyValues: { text1: { value: 'Content' } },
              attachments: [],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { forward: { id: 'forward-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createForward'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitForward'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse)
        .mockResolvedValueOnce({ methodResponses: [] });
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('forward_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        to: ['recipient1@example.com', 'recipient2@example.com'],
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      const emailCreate = emailSetCall[1].create.forward;

      expect(emailCreate.to).toHaveLength(2);
      expect(emailCreate.to[0].email).toBe('recipient1@example.com');
      expect(emailCreate.to[1].email).toBe('recipient2@example.com');
      expect(emailCreate.cc).toHaveLength(2);
      expect(emailCreate.cc[0].email).toBe('cc1@example.com');
      expect(emailCreate.bcc).toHaveLength(1);
      expect(emailCreate.bcc[0].email).toBe('bcc@example.com');
    });

    it('should use defaultFrom when from parameter not provided', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              subject: 'Test',
              from: [{ email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }],
              sentAt: '2026-01-15T10:00:00Z',
              textBody: [{ partId: 'text1' }],
              bodyValues: { text1: { value: 'Content' } },
              attachments: [],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { forward: { id: 'forward-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createForward'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitForward'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse)
        .mockResolvedValueOnce({ methodResponses: [] });
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger, { defaultFrom: 'default@example.com' });
      const tool = registeredTools.get('forward_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        to: ['recipient@example.com'],
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].create.forward.from).toEqual([{ name: 'Test User', email: 'default@example.com' }]);
    });

    it('should mark original email with $forwarded keyword', async () => {
      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              subject: 'Test',
              from: [{ email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }],
              sentAt: '2026-01-15T10:00:00Z',
              textBody: [{ partId: 'text1' }],
              bodyValues: { text1: { value: 'Content' } },
              attachments: [],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { forward: { id: 'forward-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createForward'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitForward'],
        ],
      };

      const markResponse = {
        methodResponses: [
          ['Email/set', { updated: { 'original-email-1': null } }, 'markForwarded'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse)
        .mockResolvedValueOnce(markResponse);
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('forward_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        to: ['recipient@example.com'],
      });

      // Verify third request was to mark original as forwarded
      expect(mockJmapClient.request).toHaveBeenCalledTimes(3);
      const markCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[2][0];
      const emailSetCall = markCall.find((call: unknown[]) => call[0] === 'Email/set');
      expect(emailSetCall[1].update['original-email-1']).toEqual({ 'keywords/$forwarded': true });
    });

    it('should append signature to forwarded email', async () => {
      const mockSignature = {
        text: 'Best regards,\nJohn Doe',
        html: '<p>Best regards,<br/>John Doe</p>',
      };

      const setupResponse = {
        methodResponses: [
          ['Identity/get', { list: [{ id: 'identity1', name: 'Test User', email: 'me@example.com' }] }, 'getIdentity'],
          ['Mailbox/get', { list: [{ id: 'sent-mailbox-1', role: 'sent' }, { id: 'drafts-mailbox-1', role: 'drafts' }] }, 'getMailboxes'],
          ['Email/get', {
            list: [{
              subject: 'Test',
              from: [{ email: 'sender@example.com' }],
              to: [{ email: 'me@example.com' }],
              sentAt: '2026-01-15T10:00:00Z',
              textBody: [{ partId: 'text1' }],
              bodyValues: { text1: { value: 'Original body' } },
              attachments: [],
            }],
          }, 'getOriginal'],
        ],
      };

      const sendResponse = {
        methodResponses: [
          ['Email/set', { created: { forward: { id: 'forward-1', blobId: 'blob-1', threadId: 'thread-1' } } }, 'createForward'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, 'submitForward'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(setupResponse)
        .mockResolvedValueOnce(sendResponse)
        .mockResolvedValueOnce({ methodResponses: [] });
      registerEmailSendingTools(mockServer, mockJmapClient.client, mockLogger, { signatureContent: mockSignature });
      const tool = registeredTools.get('forward_email')!;

      await tool.handler({
        originalEmailId: 'original-email-1',
        to: ['recipient@example.com'],
      });

      const sendCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const emailSetCall = sendCall.find((call: unknown[]) => call[0] === 'Email/set');
      const textBodyValue = emailSetCall[1].create.forward.bodyValues.text.value;
      const htmlBodyValue = emailSetCall[1].create.forward.bodyValues.html.value;

      expect(textBodyValue).toContain('-- \nBest regards,\nJohn Doe');
      expect(htmlBodyValue).toContain('<p>Best regards,<br/>John Doe</p>');
    });
  });
});
