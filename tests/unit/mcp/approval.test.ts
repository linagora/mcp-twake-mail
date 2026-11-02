/**
 * Prior approval of every write: each write tool asks the user (MCP elicitation) with the exact
 * action, and sends or changes nothing unless the user accepts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerAllTools } from '../../../src/mcp/tools/index.js';
import { approvalMessage, setApprover } from '../../../src/mcp/approval.js';
import { createFakeJmap, type Invocation } from '../../../src/testing/fake-jmap.js';
import type { Logger } from '../../../src/config/logger.js';

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } } as unknown as Logger;

const MAILBOXES = [
  { id: 'mb-inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0 },
  { id: 'mb-drafts', name: 'Drafts', role: 'drafts', parentId: null, totalEmails: 0 },
  { id: 'mb-sent', name: 'Sent', role: 'sent', parentId: null, totalEmails: 0 },
  { id: 'mb-trash', name: 'Trash', role: 'trash', parentId: null, totalEmails: 0 },
  { id: 'mb-proj', name: 'Projets', role: null, parentId: 'mb-inbox', totalEmails: 0 },
];

const email = (id: string) => ({
  id,
  subject: id === 'draft-1' ? 'Proposition' : 'Budget 2027',
  from: [{ name: 'Bob DURAND', email: 'bob.durand@example.com' }],
  to: id === 'draft-1' ? [{ email: 'bob.durand@example.com' }] : [{ name: 'Alice MARTIN', email: 'alice.martin@example.com' }],
  cc: id === 'draft-1' ? [] : [{ email: 'chloe.petit@example.com' }],
  replyTo: undefined,
  receivedAt: '2026-10-30T13:02:00Z',
  sentAt: '2026-10-30T13:02:00Z',
  messageId: [`${id}@example.com`],
  references: [],
  mailboxIds: { 'mb-inbox': true },
  keywords: id === 'draft-1' ? { $draft: true } : {},
  textBody: [{ partId: '1', type: 'text/plain' }],
  htmlBody: [{ partId: '1', type: 'text/plain' }],
  bodyValues: { '1': { value: id === 'draft-1' ? 'Voici notre proposition.' : 'Peux-tu valider le budget ?' } },
  attachments: [],
});

/** A fake JMAP server: reads answer, every "/set" call is recorded as a write. */
async function fakeJmap() {
  const writes: string[] = [];
  const fake = await createFakeJmap('acc');
  fake.request.mockImplementation(async (calls: Invocation[]) => ({
    methodResponses: calls.map(([method, args, id]): Invocation => {
      if (method.endsWith('/set')) {
        writes.push(method);
        const created = Object.fromEntries(Object.keys(args.create ?? {}).map((k) => [k, { id: `new-${k}`, threadId: 't1', blobId: 'b1', size: 10 }]));
        const updated = Object.fromEntries(Object.keys(args.update ?? {}).map((k) => [k, null]));
        return [method, { accountId: 'acc', created, updated, destroyed: args.destroy ?? [] }, id];
      }
      if (method === 'Identity/get') return [method, { list: [{ id: 'id1', email: 'alice.martin@example.com', name: 'Alice MARTIN' }] }, id];
      if (method === 'Mailbox/get') return [method, { list: args.ids ? MAILBOXES.filter((m) => args.ids.includes(m.id)) : MAILBOXES }, id];
      if (method === 'Email/get') return [method, { list: (args.ids ?? []).map(email) }, id];
      if (method === 'Email/query') return [method, { ids: [] }, id];
      return [method, {}, id];
    }),
  }));
  fake.serveBlob.mockImplementation(async (blobId) => new ArrayBuffer(blobId === 'small' ? 10 : 800 * 1024));
  return { jmap: fake.client, writes };
}

async function connect(answer: 'accept' | 'decline' | 'cancel', opts: { elicitation?: boolean; mode?: 'elicit' | 'client'; exempt?: string[] } = {}) {
  const { jmap, writes } = await fakeJmap();
  const server = new McpServer({ name: 't', version: '0' });
  setApprover(server, { mode: opts.mode ?? 'elicit', language: 'fr', timeoutMs: 2000, as: 'alice.martin@example.com', timeZone: 'Europe/Paris', exempt: opts.exempt });
  registerAllTools(server, jmap, logger, { signatureContent: { text: '--\nAlice MARTIN', html: '<p>--<br>Alice MARTIN</p>' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const prompts: string[] = [];
  const client = new Client({ name: 'c', version: '0' }, { capabilities: opts.elicitation === false ? {} : { elicitation: { form: {} } } });
  if (opts.elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return answer === 'accept' ? { action: answer, content: {} } : { action: answer };
    });
  }
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: r.content[0].text as string };
  };
  return { call, writes, prompts, client };
}

const WRITES: [string, Record<string, unknown>][] = [
  ['send_email', { to: ['bob.durand@example.com'], subject: 'Budget', body: 'Validé, merci.' }],
  ['reply_email', { originalEmailId: 'e1', body: 'Validé, merci.', replyAll: true }],
  ['forward_email', { originalEmailId: 'e1', to: ['chloe.petit@example.com'], note: 'Pour info.' }],
  ['send_draft', { draftId: 'draft-1' }],
  ['create_draft', { to: ['bob.durand@example.com'], subject: 'Budget', body: 'Brouillon.' }],
  ['update_draft', { draftId: 'draft-1', subject: 'Proposition v2' }],
  ['mark_as_read', { emailId: 'e1' }],
  ['mark_as_unread', { emailId: 'e1' }],
  ['delete_email', { emailId: 'e1' }],
  ['delete_email', { emailId: 'e1', permanent: true }],
  ['move_email', { emailId: 'e1', targetMailboxId: 'mb-proj' }],
  ['add_label', { emailId: 'e1', mailboxId: 'mb-proj' }],
  ['remove_label', { emailId: 'e1', mailboxId: 'mb-proj' }],
  ['batch_mark_read', { emailIds: ['e1', 'e2'] }],
  ['batch_mark_unread', { emailIds: ['e1', 'e2'] }],
  ['batch_move', { emailIds: ['e1', 'e2'], targetMailboxId: 'mb-proj' }],
  ['batch_delete', { emailIds: ['e1', 'e2'] }],
  ['batch_add_label', { emailIds: ['e1', 'e2'], mailboxId: 'mb-proj' }],
  ['batch_remove_label', { emailIds: ['e1', 'e2'], mailboxId: 'mb-proj' }],
  ['create_mailbox', { name: 'Archives 2026', parentId: 'mb-proj' }],
  ['rename_mailbox', { mailboxId: 'mb-proj', newName: 'Projets 2027' }],
  ['delete_mailbox', { mailboxId: 'mb-proj' }],
];

describe('prior approval of writes', () => {
  it('covers every tool that sends or changes something', async () => {
    const { client } = await connect('accept');
    const tools = (await client.listTools()).tools;
    const writers = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect([...new Set([...WRITES.map(([n]) => n), 'download_attachment'])].sort()).toEqual(writers.sort());
  });

  describe('download_attachment', () => {
    const previousHome = process.env.HOME;
    let home: string;
    const saved = () => join(home, 'Downloads', 'a.pdf');

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'approval-test-'));
      process.env.HOME = home;
    });

    afterEach(() => {
      process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    });

    it('saves a large file only after the user accepts', async () => {
      const ok = await connect('accept');
      const r = await ok.call('download_attachment', { blobId: 'b', name: 'a.pdf' });
      expect(r.error, r.text).toBe(false);
      expect(ok.prompts).toHaveLength(1);
      expect(ok.prompts[0]).toContain('Enregistrer une pièce jointe');
      expect(ok.prompts[0]).toContain('a.pdf');
      expect(existsSync(saved())).toBe(true);
    });

    it.each(['decline', 'cancel'] as const)('writes nothing on %s', async (answer) => {
      const no = await connect(answer);
      const r = await no.call('download_attachment', { blobId: 'b', name: 'a.pdf' });
      expect(r.text).toMatch(/^Not done: .*nothing was sent or changed/);
      expect(existsSync(join(home, 'Downloads'))).toBe(false);
    });

    it('writes nothing when the client cannot ask', async () => {
      const t = await connect('accept', { elicitation: false });
      const r = await t.call('download_attachment', { blobId: 'b', name: 'a.pdf' });
      expect(r.text).toMatch(/^Not done: /);
      expect(existsSync(join(home, 'Downloads'))).toBe(false);
    });

    it('does not ask for a small file returned inline', async () => {
      const t = await connect('decline');
      const r = await t.call('download_attachment', { blobId: 'small', name: 'a.pdf' });
      expect(r.error, r.text).toBe(false);
      expect(t.prompts).toEqual([]);
      expect(existsSync(join(home, 'Downloads'))).toBe(false);
    });
  });

  it.each(WRITES)('%s acts only after the user accepts (%o)', async (tool, args) => {
    const ok = await connect('accept');
    const r = await ok.call(tool, args);
    expect(r.error, r.text).toBe(false);
    expect(ok.prompts).toHaveLength(1);
    expect(ok.prompts[0]).toMatch(/^Twake Mail : .+\nEn tant que : alice\.martin@example\.com \(votre compte\)\n/);
    expect(ok.prompts[0]).toMatch(/Réf\. [0-9a-f]{6} · Acceptez/);
    expect(ok.writes.length).toBeGreaterThan(0);
    for (const answer of ['decline', 'cancel'] as const) {
      const no = await connect(answer);
      const n = await no.call(tool, args);
      expect(n.text).toMatch(/^Not done: .*nothing was sent or changed/);
      expect(no.writes).toEqual([]);
    }
  });

  it('shows the e-mail exactly as it leaves: recipients, subject, text with the signature', async () => {
    const t = await connect('accept');
    await t.call('send_email', { to: ['bob.durand@example.com'], cc: ['chloe.petit@example.com'], subject: 'Budget', body: 'Validé, merci.' });
    expect(t.prompts[0]).toContain('Twake Mail : Envoyer un e-mail');
    expect(t.prompts[0]).toContain('De : Alice MARTIN <alice.martin@example.com>');
    expect(t.prompts[0]).toContain('À : bob.durand@example.com');
    expect(t.prompts[0]).toContain('Cc : chloe.petit@example.com');
    expect(t.prompts[0]).toContain('Objet : Budget');
    expect(t.prompts[0]).toContain('Texte : \nValidé, merci.\n[signature comprise]');
    expect(t.prompts[0]).not.toMatch(/--\s*\nAlice MARTIN/);
    await t.call('reply_email', { originalEmailId: 'e1', body: 'OK pour moi.', replyAll: true });
    expect(t.prompts[1]).toContain('En réponse à : Bob DURAND <bob.durand@example.com> · Budget 2027');
    expect(t.prompts[1]).toContain('À : Bob DURAND <bob.durand@example.com>');
    expect(t.prompts[1]).toContain('Cc : chloe.petit@example.com');
    expect(t.prompts[1]).toContain('Objet : Re: Budget 2027');
    await t.call('send_draft', { draftId: 'draft-1' });
    expect(t.prompts[2]).toContain('Objet : Proposition');
    expect(t.prompts[2]).toContain('Texte : Voici notre proposition.');
    await t.call('batch_move', { emailIds: ['e1', 'e2'], targetMailboxId: 'mb-proj' });
    expect(t.prompts[3]).toContain('• Bob DURAND <bob.durand@example.com> · 2026-10-30 14:02 · Budget 2027');
    expect(t.prompts[3]).toContain('Destination : Inbox / Projets');
    expect(new Set(t.prompts.map((p) => /Réf\. (\w+)/.exec(p)![1])).size).toBe(4);
  });

  it('refuses to act when the client cannot ask, unless it confirms itself', async () => {
    const blind = await connect('accept', { elicitation: false });
    const r = await blind.call('send_email', { to: ['bob.durand@example.com'], subject: 'x', body: 'y' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/cannot ask the user for approval/);
    expect(blind.writes).toEqual([]);
    const client = await connect('accept', { elicitation: false, mode: 'client' });
    expect((await client.call('mark_as_read', { emailId: 'e1' })).error).toBe(false);
    expect(client.writes).toHaveLength(1);
  });

  it('runs the tools the user exempted without a prompt, and only those', async () => {
    const t = await connect('decline', { exempt: ['create_draft'] });
    expect((await t.call('create_draft', { to: ['bob.durand@example.com'], subject: 'B', body: 'b' })).error).toBe(false);
    expect(t.prompts).toEqual([]);
    expect((await t.call('send_draft', { draftId: 'draft-1' })).text).toMatch(/^Not done/);
    expect(t.prompts).toHaveLength(1);
  });

  it('never asks for reads, including sensitive ones', async () => {
    const t = await connect('decline');
    await t.call('get_email', { emailId: 'e1' });
    await t.call('list_mailboxes', {});
    await t.call('get_thread_emails', { threadId: 't1' });
    expect(t.prompts).toEqual([]);
    expect(t.writes).toEqual([]);
  });
});

describe('approvalMessage', () => {
  it('leaves out empty fields, writes English by default and shortens very long texts', () => {
    const m = approvalMessage({ action: 'send_email', details: [['to', 'bob@example.com'], ['cc', undefined], ['text', 'x'.repeat(3100)]] }, { language: 'en', as: 'alice@example.com' }, 'abc123');
    expect(m.split('\n').slice(0, 3)).toEqual(['Twake Mail: Send an e-mail', 'As: alice@example.com (your account)', 'To: bob@example.com']);
    expect(m).toContain('… (+100)');
    expect(m.endsWith('Ref. abc123 · Accept to do it now, refuse to cancel.')).toBe(true);
  });
});
