import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(),
}));

import { registerMailboxTools } from '../../../../src/mcp/tools/mailbox.js';
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

describe('Mailbox Management Tools', () => {
  let mockServer: McpServer;
  let mockJmapClient: FakeJmap;
  let mockLogger: Logger;
  let registeredTools: Map<string, ToolRegistration>;

  beforeEach(async () => {
    vi.clearAllMocks();

    registeredTools = new Map();

    mockServer = {
      tool: vi.fn(
        (
          name: string,
          description: string,
          schema: unknown,
          config: Record<string, unknown>,
          handler: ToolRegistration['handler']
        ) => {
          // server.tool() is called with (name, desc, schema, config, handler)
          // config contains { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint }
          registeredTools.set(name, {
            name,
            config: {
              title: config.title as string,
              description,
              inputSchema: schema as Record<string, unknown>,
              annotations: {
                readOnlyHint: config.readOnlyHint as boolean,
                destructiveHint: config.destructiveHint as boolean,
                idempotentHint: config.idempotentHint as boolean,
                openWorldHint: config.openWorldHint as boolean,
              },
            },
            handler,
          });
        }
      ),
    } as unknown as McpServer;

    // these tests script every JMAP call: the client confirms (approval prompts are tested in tests/unit/mcp/approval.test.ts)

    setApprover(mockServer, { mode: 'client', language: 'en', timeoutMs: 1000 });

    mockJmapClient = await createFakeJmap('account1');

    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;
  });

  describe('create_mailbox', () => {
    it('registers create_mailbox tool with correct metadata', () => {
      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);

      expect(registeredTools.has('create_mailbox')).toBe(true);
      const tool = registeredTools.get('create_mailbox')!;

      expect(tool.config.title).toBe('Create Mailbox');
      expect(tool.config.annotations.readOnlyHint).toBe(false);
      expect(tool.config.annotations.destructiveHint).toBe(false);
      expect(tool.config.annotations.idempotentHint).toBe(false);
      expect(tool.config.annotations.openWorldHint).toBe(true);
    });

    it('creates mailbox successfully', async () => {
      const createResponse = {
        methodResponses: [
          [
            'Mailbox/set',
            { created: { new: { id: 'mailbox-123' } } },
            'createMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createResponse
      );

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('create_mailbox')!;

      const result = await tool.handler({ name: 'My Custom Folder' });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.mailboxId).toBe('mailbox-123');
      expect(response.name).toBe('My Custom Folder');
    });

    it('creates nested mailbox with parentId', async () => {
      const createResponse = {
        methodResponses: [
          [
            'Mailbox/set',
            { created: { new: { id: 'mailbox-456' } } },
            'createMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createResponse
      );

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('create_mailbox')!;

      const result = await tool.handler({ name: 'Subfolder', parentId: 'parent-123' });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.parentId).toBe('parent-123');

      // Verify parentId was sent in request
      const requestCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(requestCall[0][1].create['new'].parentId).toBe('parent-123');
    });

    it('trims whitespace from mailbox name', async () => {
      const createResponse = {
        methodResponses: [
          [
            'Mailbox/set',
            { created: { new: { id: 'mailbox-789' } } },
            'createMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createResponse
      );

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('create_mailbox')!;

      await tool.handler({ name: '  Trimmed Name  ' });

      // Verify trimmed name was sent in request
      const requestCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(requestCall[0][1].create['new'].name).toBe('Trimmed Name');
    });

    it('sets isSubscribed to true', async () => {
      const createResponse = {
        methodResponses: [
          [
            'Mailbox/set',
            { created: { new: { id: 'mailbox-sub' } } },
            'createMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createResponse
      );

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('create_mailbox')!;

      await tool.handler({ name: 'Subscribed Folder' });

      // Verify isSubscribed was set to true
      const requestCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(requestCall[0][1].create['new'].isSubscribed).toBe(true);
    });

    it('handles duplicate name error', async () => {
      const createResponse = {
        methodResponses: [
          [
            'Mailbox/set',
            {
              notCreated: {
                new: { type: 'invalidProperties', description: 'name already exists' },
              },
            },
            'createMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createResponse
      );

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('create_mailbox')!;

      const result = await tool.handler({ name: 'Existing Folder' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('already exists');
    });
  });

  describe('rename_mailbox', () => {
    it('registers rename_mailbox tool with correct metadata', () => {
      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);

      expect(registeredTools.has('rename_mailbox')).toBe(true);
      const tool = registeredTools.get('rename_mailbox')!;

      expect(tool.config.title).toBe('Rename Mailbox');
      expect(tool.config.annotations.readOnlyHint).toBe(false);
      expect(tool.config.annotations.destructiveHint).toBe(false);
      expect(tool.config.annotations.idempotentHint).toBe(true);
    });

    it('renames mailbox successfully', async () => {
      // First call: Mailbox/get to check permissions
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                { id: 'mailbox-1', name: 'Old Name', role: null, myRights: { mayRename: true } },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      // Second call: Mailbox/set to rename
      const setResponse = {
        methodResponses: [
          ['Mailbox/set', { updated: { 'mailbox-1': null } }, 'renameMailbox'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(getResponse)
        .mockResolvedValueOnce(setResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('rename_mailbox')!;

      const result = await tool.handler({ mailboxId: 'mailbox-1', newName: 'New Name' });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.oldName).toBe('Old Name');
      expect(response.newName).toBe('New Name');
    });

    it('trims whitespace from new name', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                { id: 'mailbox-1', name: 'Old Name', role: null, myRights: { mayRename: true } },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      const setResponse = {
        methodResponses: [
          ['Mailbox/set', { updated: { 'mailbox-1': null } }, 'renameMailbox'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(getResponse)
        .mockResolvedValueOnce(setResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('rename_mailbox')!;

      const result = await tool.handler({
        mailboxId: 'mailbox-1',
        newName: '  Trimmed Name  ',
      });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.newName).toBe('Trimmed Name');

      // Verify trimmed name was sent in request
      const setCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(setCall[0][1].update['mailbox-1'].name).toBe('Trimmed Name');
    });

    it('rejects renaming system mailbox', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                {
                  id: 'inbox-1',
                  name: 'Inbox',
                  role: 'inbox',
                  myRights: { mayRename: false },
                },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(getResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('rename_mailbox')!;

      const result = await tool.handler({ mailboxId: 'inbox-1', newName: 'My Inbox' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot rename system mailbox');
      expect(result.content[0].text).toContain('inbox');
    });

    it('rejects rename when permission denied', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                {
                  id: 'shared-1',
                  name: 'Shared Folder',
                  role: null,
                  myRights: { mayRename: false },
                },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(getResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('rename_mailbox')!;

      const result = await tool.handler({ mailboxId: 'shared-1', newName: 'Renamed' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('permission');
    });

    it('handles mailbox not found', async () => {
      const getResponse = {
        methodResponses: [
          ['Mailbox/get', { list: [], notFound: ['nonexistent'] }, 'getMailbox'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(getResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('rename_mailbox')!;

      const result = await tool.handler({ mailboxId: 'nonexistent', newName: 'Whatever' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('handles duplicate name error during rename', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                { id: 'mailbox-1', name: 'Original', role: null, myRights: { mayRename: true } },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      const setResponse = {
        methodResponses: [
          [
            'Mailbox/set',
            {
              notUpdated: {
                'mailbox-1': {
                  type: 'invalidProperties',
                  description: 'name already exists',
                },
              },
            },
            'renameMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(getResponse)
        .mockResolvedValueOnce(setResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('rename_mailbox')!;

      const result = await tool.handler({
        mailboxId: 'mailbox-1',
        newName: 'Existing Name',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('already exists');
    });
  });

  describe('delete_mailbox', () => {
    it('registers delete_mailbox tool with correct metadata', () => {
      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);

      expect(registeredTools.has('delete_mailbox')).toBe(true);
      const tool = registeredTools.get('delete_mailbox')!;

      expect(tool.config.title).toBe('Delete Mailbox');
      expect(tool.config.annotations.readOnlyHint).toBe(false);
      expect(tool.config.annotations.destructiveHint).toBe(true);
      expect(tool.config.annotations.idempotentHint).toBe(false);
    });

    it('deletes empty mailbox successfully', async () => {
      // First call: Mailbox/get to check permissions
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                {
                  id: 'custom-1',
                  name: 'To Delete',
                  role: null,
                  myRights: { mayDelete: true },
                },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      // Second call: Mailbox/set to delete
      const setResponse = {
        methodResponses: [
          ['Mailbox/set', { destroyed: ['custom-1'] }, 'deleteMailbox'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(getResponse)
        .mockResolvedValueOnce(setResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('delete_mailbox')!;

      const result = await tool.handler({ mailboxId: 'custom-1' });

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.deletedMailboxId).toBe('custom-1');
      expect(response.deletedMailboxName).toBe('To Delete');
    });

    it('rejects deleting system mailbox', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                { id: 'trash-1', name: 'Trash', role: 'trash', myRights: { mayDelete: false } },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(getResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('delete_mailbox')!;

      const result = await tool.handler({ mailboxId: 'trash-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot delete system mailbox');
      expect(result.content[0].text).toContain('trash');
    });

    it('handles mailboxHasEmail error', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                {
                  id: 'custom-2',
                  name: 'Has Emails',
                  role: null,
                  myRights: { mayDelete: true },
                },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      const setResponse = {
        methodResponses: [
          [
            'Mailbox/set',
            { notDestroyed: { 'custom-2': { type: 'mailboxHasEmail' } } },
            'deleteMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(getResponse)
        .mockResolvedValueOnce(setResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('delete_mailbox')!;

      const result = await tool.handler({ mailboxId: 'custom-2' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('contains emails');
      expect(result.content[0].text).toContain('force=true');
    });

    it('handles mailboxHasChild error', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                { id: 'parent-1', name: 'Parent', role: null, myRights: { mayDelete: true } },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      const setResponse = {
        methodResponses: [
          [
            'Mailbox/set',
            { notDestroyed: { 'parent-1': { type: 'mailboxHasChild' } } },
            'deleteMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(getResponse)
        .mockResolvedValueOnce(setResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('delete_mailbox')!;

      const result = await tool.handler({ mailboxId: 'parent-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('child mailboxes');
    });

    it('deletes non-empty mailbox with force=true', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                {
                  id: 'custom-3',
                  name: 'Force Delete',
                  role: null,
                  myRights: { mayDelete: true },
                },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      const setResponse = {
        methodResponses: [['Mailbox/set', { destroyed: ['custom-3'] }, 'deleteMailbox']],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(getResponse)
        .mockResolvedValueOnce(setResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('delete_mailbox')!;

      const result = await tool.handler({ mailboxId: 'custom-3', force: true });

      expect(result.isError).toBeUndefined();

      // Verify onDestroyRemoveEmails was set to true
      const setCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(setCall[0][1].onDestroyRemoveEmails).toBe(true);
    });

    it('sends onDestroyRemoveEmails=false by default', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                {
                  id: 'custom-4',
                  name: 'Default Delete',
                  role: null,
                  myRights: { mayDelete: true },
                },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      const setResponse = {
        methodResponses: [['Mailbox/set', { destroyed: ['custom-4'] }, 'deleteMailbox']],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(getResponse)
        .mockResolvedValueOnce(setResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('delete_mailbox')!;

      // Note: In real usage, zod applies the default. In tests we pass explicitly.
      await tool.handler({ mailboxId: 'custom-4', force: false });

      // Verify onDestroyRemoveEmails was set to false (default)
      const setCall = (mockJmapClient.request as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(setCall[0][1].onDestroyRemoveEmails).toBe(false);
    });

    it('rejects delete when permission denied', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                {
                  id: 'shared-2',
                  name: 'No Delete',
                  role: null,
                  myRights: { mayDelete: false },
                },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(getResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('delete_mailbox')!;

      const result = await tool.handler({ mailboxId: 'shared-2' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('permission');
    });

    it('handles mailbox not found', async () => {
      const getResponse = {
        methodResponses: [
          ['Mailbox/get', { list: [], notFound: ['nonexistent'] }, 'getMailbox'],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(getResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('delete_mailbox')!;

      const result = await tool.handler({ mailboxId: 'nonexistent' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('handles generic destroy error', async () => {
      const getResponse = {
        methodResponses: [
          [
            'Mailbox/get',
            {
              list: [
                { id: 'mailbox-x', name: 'Problematic', role: null, myRights: { mayDelete: true } },
              ],
            },
            'getMailbox',
          ],
        ],
      };

      const setResponse = {
        methodResponses: [
          [
            'Mailbox/set',
            {
              notDestroyed: {
                'mailbox-x': { type: 'serverFail', description: 'Internal error' },
              },
            },
            'deleteMailbox',
          ],
        ],
      };

      (mockJmapClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(getResponse)
        .mockResolvedValueOnce(setResponse);

      registerMailboxTools(mockServer, mockJmapClient.client, mockLogger);
      const tool = registeredTools.get('delete_mailbox')!;

      const result = await tool.handler({ mailboxId: 'mailbox-x' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('serverFail');
      expect(result.content[0].text).toContain('Internal error');
    });
  });
});
