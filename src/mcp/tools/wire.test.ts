/**
 * What each tool sends to the server: method calls and capabilities.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../../config/logger.js';
import { createFakeJmap, type FakeJmap, type Invocation } from '../../testing/fake-jmap.js';
import { setApprover } from '../approval.js';
import { registerAllTools } from './index.js';

const accountId = 'account-1';
const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const SUBMISSION = 'urn:ietf:params:jmap:submission';

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;

const FULL_EMAIL_PROPERTIES = [
  'id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject',
  'receivedAt', 'sentAt', 'preview', 'hasAttachment', 'size', 'bodyValues', 'textBody', 'htmlBody', 'attachments',
];
const MAILBOX_PROPERTIES = [
  'id', 'name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads',
  'myRights', 'isSubscribed',
];
const BODY_PROPERTIES = ['partId', 'blobId', 'type', 'name', 'size'];

const setup = [
  ['Identity/get', { list: [{ id: 'identity-1', name: 'Me', email: 'me@example.com' }] }, 'x'],
  ['Mailbox/get', { list: [{ id: 'drafts-id', role: 'drafts' }, { id: 'sent-id', role: 'sent' }] }, 'x'],
] as Invocation[];
const identityAndMailboxesCalls = [
  ['Identity/get', { accountId }, 'c0'],
  ['Mailbox/get', { accountId, properties: ['id', 'role'] }, 'c1'],
];
const original = {
  id: 'orig',
  messageId: ['m1@x'],
  references: ['m0@x'],
  subject: 'Topic',
  from: [{ name: 'Sender', email: 'sender@example.com' }],
  to: [{ name: 'Me', email: 'me@example.com' }, { name: 'Other', email: 'other@example.com' }],
  cc: [{ name: 'Copy', email: 'copy@example.com' }],
  sentAt: '2026-01-01T00:00:00Z',
  textBody: [{ partId: '1' }],
  htmlBody: [{ partId: '1' }],
  bodyValues: { 1: { value: 'quoted' } },
  attachments: [{ blobId: 'att-blob', type: 'text/plain', name: 'a.txt', size: 3 }],
};
const toSent = {
  'keywords/$draft': null,
  'mailboxIds/drafts-id': null,
  'mailboxIds/sent-id': true,
};
const created = (key: string) => [
  ['Email/set', { created: { [key]: { id: 'new-email', threadId: 't' } } }, 'x'],
  ['EmailSubmission/set', { created: { submission: { id: 'sub' } } }, 'x'],
] as Invocation[];

describe('what the tools send', () => {
  let jmap: FakeJmap;
  let tools: Map<string, Handler>;

  const sent = (request = 0) => jmap.request.mock.calls[request][0];
  const using = (request = 0) => jmap.request.mock.calls[request][1];
  const answer = (...responses: Invocation[][]) => {
    for (const methodResponses of responses) {
      jmap.request.mockResolvedValueOnce({ methodResponses });
    }
  };
  const run = async (tool: string, args: Record<string, unknown>) => {
    const result = await tools.get(tool)!(args);
    expect(result.isError, result.content[0].text).toBeFalsy();
    return result;
  };

  beforeEach(async () => {
    jmap = await createFakeJmap();
    tools = new Map();
    const register = (name: string, ...rest: unknown[]) => tools.set(name, rest[rest.length - 1] as Handler);
    const server = { registerTool: vi.fn(register), tool: vi.fn(register) } as unknown as McpServer;
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    setApprover(server, { mode: 'client', language: 'en', timeoutMs: 1000 });
    registerAllTools(server, jmap.client, logger);
  });

  it('the fake server refuses an answer for another method', async () => {
    answer([['Thread/get', { list: [] }, 'x']]);

    const result = await tools.get('get_email')!({ emailId: 'e' });

    expect(result.content[0].text).toContain('Email/get answered with Thread/get');
  });

  it('search_emails: query with the filter, then get by back-reference', async () => {
    answer([['Email/query', { ids: [] }, 'x'], ['Email/get', { list: [] }, 'x']]);

    await run('search_emails', {
      mailboxId: 'inbox', from: 'a', to: 'b', subject: 'c', text: 'd', before: 'e', after: 'f',
      hasAttachment: false, unreadOnly: true, flagged: true, limit: 7,
    });

    expect(sent()).toEqual([
      ['Email/query', {
        accountId,
        filter: {
          inMailbox: 'inbox', from: 'a', to: 'b', subject: 'c', text: 'd', before: 'e', after: 'f',
          hasAttachment: false, notKeyword: '$seen', hasKeyword: '$flagged',
        },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 7,
      }, 'c0'],
      ['Email/get', {
        accountId,
        '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' },
        properties: ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'subject', 'receivedAt', 'preview', 'hasAttachment'],
      }, 'c1'],
    ]);
    expect(using()).toEqual([CORE, MAIL]);
  });

  it('search_emails: no filter when none is given', async () => {
    answer([['Email/query', { ids: [] }, 'x'], ['Email/get', { list: [] }, 'x']]);

    await run('search_emails', { limit: 20 });

    expect(sent()[0][1]).not.toHaveProperty('filter');
  });

  it('get_email', async () => {
    answer([['Email/get', { list: [{ id: 'e', mailboxIds: {} }] }, 'x']]);
    await run('get_email', { emailId: 'e' });
    expect(sent()).toEqual([['Email/get', {
      accountId, ids: ['e'], properties: FULL_EMAIL_PROPERTIES,
      fetchTextBodyValues: true, fetchHTMLBodyValues: true, bodyProperties: BODY_PROPERTIES,
    }, 'c0']]);
  });

  it('get_email_labels', async () => {
    answer([['Email/get', { list: [{ id: 'e', mailboxIds: {} }] }, 'x']]);
    await run('get_email_labels', { emailId: 'e' });
    expect(sent()).toEqual([['Email/get', { accountId, ids: ['e'], properties: ['id', 'mailboxIds'] }, 'c0']]);
  });

  it('get_thread', async () => {
    answer([['Thread/get', { list: [{ id: 't', emailIds: [] }], notFound: [] }, 'x']]);
    await run('get_thread', { threadId: 't' });
    expect(sent()).toEqual([['Thread/get', { accountId, ids: ['t'] }, 'c0']]);
  });

  it('get_thread_emails: thread, then its emails', async () => {
    answer(
      [['Thread/get', { list: [{ id: 't', emailIds: ['e1', 'e2'] }], notFound: [] }, 'x']],
      [['Email/get', { list: [] }, 'x']]
    );
    await run('get_thread_emails', { threadId: 't' });
    expect(sent(0)).toEqual([['Thread/get', { accountId, ids: ['t'] }, 'c0']]);
    expect(sent(1)).toEqual([['Email/get', {
      accountId, ids: ['e1', 'e2'], properties: FULL_EMAIL_PROPERTIES,
      fetchTextBodyValues: true, fetchHTMLBodyValues: true, bodyProperties: BODY_PROPERTIES,
    }, 'c0']]);
  });

  it('get_attachments', async () => {
    answer([['Email/get', { list: [{ id: 'e', attachments: [] }] }, 'x']]);
    await run('get_attachments', { emailId: 'e' });
    expect(sent()).toEqual([['Email/get', {
      accountId, ids: ['e'], properties: ['attachments'],
      bodyProperties: ['blobId', 'name', 'type', 'size', 'disposition', 'cid'],
    }, 'c0']]);
  });

  it('download_attachment: the requested blob, name and type', async () => {
    jmap.serveBlob.mockResolvedValue(new ArrayBuffer(1));
    await run('download_attachment', { blobId: 'b/1', name: 'a b.pdf', type: 'application/pdf' });
    expect(jmap.serveBlob).toHaveBeenCalledWith('b/1', 'a b.pdf', 'application/pdf');
  });

  it('get_mailbox and list_mailboxes', async () => {
    answer([['Mailbox/get', { list: [{ id: 'm', name: 'M' }], notFound: [] }, 'x']], [['Mailbox/get', { list: [] }, 'x']]);
    await run('get_mailbox', { mailboxId: 'm' });
    await run('list_mailboxes', {});
    expect(sent(0)).toEqual([['Mailbox/get', { accountId, ids: ['m'], properties: MAILBOX_PROPERTIES }, 'c0']]);
    expect(sent(1)).toEqual([['Mailbox/get', { accountId, properties: MAILBOX_PROPERTIES }, 'c0']]);
  });

  it('create_mailbox', async () => {
    answer([['Mailbox/set', { created: { new: { id: 'm' } } }, 'x']]);
    await run('create_mailbox', { name: ' Work ', parentId: 'p' });
    expect(sent()).toEqual([['Mailbox/set', {
      accountId, create: { new: { name: 'Work', parentId: 'p', isSubscribed: true } },
    }, 'c0']]);
  });

  const custom = { id: 'm', name: 'Old', role: null, myRights: { mayRename: true, mayDelete: true } };

  it('rename_mailbox: reads, then renames', async () => {
    answer([['Mailbox/get', { list: [custom], notFound: [] }, 'x']], [['Mailbox/set', { updated: { m: null } }, 'x']]);
    await run('rename_mailbox', { mailboxId: 'm', newName: ' New ' });
    expect(sent(0)).toEqual([['Mailbox/get', { accountId, ids: ['m'], properties: ['id', 'name', 'role', 'myRights'] }, 'c0']]);
    expect(sent(1)).toEqual([['Mailbox/set', { accountId, update: { m: { name: 'New' } } }, 'c0']]);
  });

  it('delete_mailbox: reads, then destroys with the force option', async () => {
    answer([['Mailbox/get', { list: [custom], notFound: [] }, 'x']], [['Mailbox/set', { destroyed: ['m'] }, 'x']]);
    await run('delete_mailbox', { mailboxId: 'm', force: true });
    expect(sent(0)).toEqual([['Mailbox/get', { accountId, ids: ['m'], properties: ['id', 'name', 'role', 'myRights'] }, 'c0']]);
    expect(sent(1)).toEqual([['Mailbox/set', { accountId, destroy: ['m'], onDestroyRemoveEmails: true }, 'c0']]);
  });

  it.each([
    ['mark_as_read', { emailId: 'e' }, { e: { 'keywords/$seen': true } }],
    ['mark_as_unread', { emailId: 'e' }, { e: { 'keywords/$seen': null } }],
    ['move_email', { emailId: 'e', targetMailboxId: 'm' }, { e: { mailboxIds: { m: true } } }],
    ['add_label', { emailId: 'e', mailboxId: 'm' }, { e: { 'mailboxIds/m': true } }],
    ['remove_label', { emailId: 'e', mailboxId: 'm' }, { e: { 'mailboxIds/m': null } }],
    ['batch_mark_read', { emailIds: ['e', 'f'] }, { e: { 'keywords/$seen': true }, f: { 'keywords/$seen': true } }],
    ['batch_mark_unread', { emailIds: ['e', 'f'] }, { e: { 'keywords/$seen': null }, f: { 'keywords/$seen': null } }],
    ['batch_move', { emailIds: ['e', 'f'], targetMailboxId: 'm' }, { e: { mailboxIds: { m: true } }, f: { mailboxIds: { m: true } } }],
    ['batch_add_label', { emailIds: ['e', 'f'], mailboxId: 'm' }, { e: { 'mailboxIds/m': true }, f: { 'mailboxIds/m': true } }],
    ['batch_remove_label', { emailIds: ['e', 'f'], mailboxId: 'm' }, { e: { 'mailboxIds/m': null }, f: { 'mailboxIds/m': null } }],
  ])('%s', async (tool, args, update) => {
    answer([['Email/set', { updated: {} }, 'x']]);
    await run(tool, args);
    expect(sent()).toEqual([['Email/set', { accountId, update }, 'c0']]);
  });

  it.each([
    ['delete_email', { emailId: 'e', permanent: true }, ['e']],
    ['batch_delete', { emailIds: ['e', 'f'], permanent: true }, ['e', 'f']],
  ])('%s: permanent destroys the given ids, without looking for the Trash', async (tool, args, destroy) => {
    answer([['Email/set', { destroyed: destroy }, 'x']]);
    await run(tool, args);
    expect(sent()).toEqual([['Email/set', { accountId, destroy }, 'c0']]);
  });

  it.each([
    ['delete_email', { emailId: 'e', permanent: false }, { e: { mailboxIds: { 'trash-id': true } } }],
    ['batch_delete', { emailIds: ['e', 'f'], permanent: false }, { e: { mailboxIds: { 'trash-id': true } }, f: { mailboxIds: { 'trash-id': true } } }],
  ])('%s: looks for the Trash, then moves there', async (tool, args, update) => {
    answer([['Mailbox/query', { ids: ['trash-id'] }, 'x']], [['Email/set', { updated: {} }, 'x']]);
    await run(tool, args);
    expect(sent(0)).toEqual([['Mailbox/query', { accountId, filter: { role: 'trash' } }, 'c0']]);
    expect(sent(1)).toEqual([['Email/set', { accountId, update }, 'c0']]);
  });

  it.each([
    ['delete_email', { emailId: 'e', permanent: false }, ['e']],
    ['batch_delete', { emailIds: ['e', 'f'], permanent: false }, ['e', 'f']],
  ])('%s: destroys when there is no Trash', async (tool, args, destroy) => {
    answer([['Mailbox/query', { ids: [] }, 'x']], [['Email/set', { destroyed: destroy }, 'x']]);
    await run(tool, args);
    expect(sent(1)).toEqual([['Email/set', { accountId, destroy }, 'c0']]);
  });

  it('create_draft: mailboxes, identity, then the draft', async () => {
    answer(
      [['Mailbox/get', { list: [{ id: 'drafts-id', role: 'drafts' }] }, 'x']],
      [['Identity/get', { list: [{ id: 'identity-1', name: 'Me', email: 'me@example.com' }] }, 'x']],
      [['Email/set', { created: { draft: { id: 'd', threadId: 't' } } }, 'x']]
    );

    await run('create_draft', {
      to: ['a@x'], cc: ['b@x'], bcc: ['c@x'], subject: 'S', body: 'B', signature: false, inReplyTo: '<m1@x>',
    });

    expect(sent(0)).toEqual([['Mailbox/get', { accountId, properties: ['id', 'role'] }, 'c0']]);
    expect(using(0)).toEqual([CORE, MAIL]);
    expect(sent(1)).toEqual([['Identity/get', { accountId }, 'c0']]);
    expect(using(1)).toEqual([CORE, MAIL, SUBMISSION]);
    expect(sent(2)[0][0]).toBe('Email/set');
    expect(sent(2)[0][1].create).toEqual({
      draft: expect.objectContaining({
        mailboxIds: { 'drafts-id': true },
        keywords: { $draft: true, $seen: true },
        subject: 'S',
        from: [{ email: 'me@example.com', name: 'Me' }],
        to: [{ email: 'a@x' }],
        cc: [{ email: 'b@x' }],
        bcc: [{ email: 'c@x' }],
        inReplyTo: ['m1@x'],
        references: ['m1@x'],
      }),
    });
  });

  it('update_draft: reads the draft, then replaces it in one request', async () => {
    const draft = {
      id: 'd',
      from: [{ name: 'Me', email: 'me@example.com' }],
      replyTo: [{ name: null, email: 'reply@x' }],
      subject: 'Old',
      inReplyTo: ['m1@x'],
      references: ['m0@x'],
      mailboxIds: { 'drafts-id': true },
      keywords: { $draft: true },
      textBody: [{ partId: '1', type: 'text/plain' }],
      htmlBody: [{ partId: '1', type: 'text/plain' }],
      bodyValues: { 1: { value: 'Old body' } },
      attachments: [{ blobId: 'att-blob', type: 'text/plain', name: 'a.txt', size: 3 }],
    };
    answer([['Email/get', { list: [draft] }, 'x']], [['Email/set', { created: { draft: { id: 'new' } }, destroyed: ['d'] }, 'x']]);

    await run('update_draft', { draftId: 'd', subject: 'S', to: ['a@x'], cc: ['b@x'], bcc: ['c@x'], ifInState: 'st' });

    expect(sent(0)).toEqual([['Email/get', {
      accountId,
      ids: ['d'],
      properties: ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'inReplyTo', 'references', 'mailboxIds', 'keywords', 'textBody', 'htmlBody', 'bodyValues', 'attachments'],
      fetchAllBodyValues: true,
    }, 'c0']]);
    expect(sent(1)).toEqual([['Email/set', {
      accountId,
      ifInState: 'st',
      destroy: ['d'],
      create: {
        draft: {
          mailboxIds: { 'drafts-id': true },
          keywords: { $draft: true },
          from: [{ name: 'Me', email: 'me@example.com' }],
          subject: 'S',
          to: [{ email: 'a@x' }],
          cc: [{ email: 'b@x' }],
          bcc: [{ email: 'c@x' }],
          replyTo: [{ name: null, email: 'reply@x' }],
          inReplyTo: ['m1@x'],
          references: ['m0@x'],
          bodyValues: { 1: { value: 'Old body' } },
          textBody: [{ partId: '1', type: 'text/plain' }],
          htmlBody: [{ partId: '1', type: 'text/plain' }],
          attachments: [{ blobId: 'att-blob', type: 'text/plain', name: 'a.txt', disposition: 'attachment' }],
        },
      },
    }, 'c0']]);
  });

  it('send_draft: submits the draft and moves it to Sent', async () => {
    answer(setup, [['EmailSubmission/set', { created: { submission: { id: 'sub' } } }, 'x']]);
    await run('send_draft', { draftId: 'd' });
    expect(sent(0)).toEqual(identityAndMailboxesCalls);
    expect(sent(1)).toEqual([['EmailSubmission/set', {
      accountId,
      create: { submission: { identityId: 'identity-1', emailId: 'd' } },
      onSuccessUpdateEmail: { '#submission': toSent },
    }, 'c0']]);
    expect(using(1)).toEqual([CORE, MAIL, SUBMISSION]);
  });

  it('send_email: creates the email and submits it in one request', async () => {
    answer(setup, created('email'));

    await run('send_email', { to: ['a@x'], cc: ['b@x'], bcc: ['c@x'], subject: 'S', body: 'B', htmlBody: '<b>H</b>' });

    expect(sent(0)).toEqual(identityAndMailboxesCalls);
    expect(using(0)).toEqual([CORE, MAIL, SUBMISSION]);
    expect(sent(1)).toEqual([
      ['Email/set', {
        accountId,
        create: {
          email: {
            mailboxIds: { 'drafts-id': true },
            from: [{ name: 'Me', email: 'me@example.com' }],
            to: [{ email: 'a@x' }],
            cc: [{ email: 'b@x' }],
            bcc: [{ email: 'c@x' }],
            subject: 'S',
            bodyValues: { text: { value: 'B' }, html: { value: '<b>H</b>' } },
            textBody: [{ partId: 'text', type: 'text/plain' }],
            htmlBody: [{ partId: 'html', type: 'text/html' }],
          },
        },
      }, 'c0'],
      ['EmailSubmission/set', {
        accountId,
        create: { submission: { identityId: 'identity-1', emailId: '#email' } },
        onSuccessUpdateEmail: { '#submission': toSent },
      }, 'c1'],
    ]);
  });

  it('reply_email: threads the reply on the original', async () => {
    answer([...setup, ['Email/get', { list: [original] }, 'x']], created('reply'));

    await run('reply_email', { originalEmailId: 'orig', body: 'B', replyAll: true });

    expect(sent(0)[2]).toEqual(['Email/get', {
      accountId, ids: ['orig'], properties: ['messageId', 'references', 'subject', 'from', 'to', 'cc', 'replyTo'],
    }, 'c2']);
    expect(sent(1)[0][1].create).toEqual({
      reply: expect.objectContaining({
        mailboxIds: { 'drafts-id': true },
        to: [{ name: 'Sender', email: 'sender@example.com' }, { name: 'Other', email: 'other@example.com' }],
        cc: [{ name: 'Copy', email: 'copy@example.com' }],
        subject: 'Re: Topic',
        inReplyTo: ['m1@x'],
        references: ['m0@x', 'm1@x'],
      }),
    });
    expect(sent(1)[1]).toEqual(['EmailSubmission/set', {
      accountId,
      create: { submission: { identityId: 'identity-1', emailId: '#reply' } },
      onSuccessUpdateEmail: { '#submission': toSent },
    }, 'c1']);
  });

  it('forward_email: keeps the attachments, then marks the original', async () => {
    answer([...setup, ['Email/get', { list: [original] }, 'x']], created('forward'), [['Email/set', { updated: {} }, 'x']]);

    await run('forward_email', { originalEmailId: 'orig', to: ['a@x'], cc: ['b@x'], bcc: ['c@x'], note: 'N' });

    expect(sent(0)[2]).toEqual(['Email/get', {
      accountId,
      ids: ['orig'],
      properties: ['subject', 'from', 'to', 'cc', 'sentAt', 'textBody', 'htmlBody', 'bodyValues', 'attachments'],
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
      bodyProperties: ['partId', 'blobId', 'type', 'name', 'size', 'disposition', 'cid'],
    }, 'c2']);
    expect(sent(1)[0][1].create).toEqual({
      forward: expect.objectContaining({
        mailboxIds: { 'drafts-id': true },
        to: [{ email: 'a@x' }],
        cc: [{ email: 'b@x' }],
        bcc: [{ email: 'c@x' }],
        subject: 'Fwd: Topic',
        attachments: [{ blobId: 'att-blob', type: 'text/plain', name: 'a.txt' }],
      }),
    });
    expect(sent(1)[1]).toEqual(['EmailSubmission/set', {
      accountId,
      create: { submission: { identityId: 'identity-1', emailId: '#forward' } },
      onSuccessUpdateEmail: { '#submission': toSent },
    }, 'c1']);
    expect(sent(2)).toEqual([['Email/set', { accountId, update: { orig: { 'keywords/$forwarded': true } } }, 'c0']]);
  });
});
