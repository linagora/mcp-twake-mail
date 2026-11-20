/**
 * approve_batch: the user approves a list of writes once; each matching call with the batchId then runs
 * without another question, and anything else asks as usual.
 */
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerAllTools } from '../../../src/mcp/tools/index.js';
import { setApprover, WRITE_TOOLS } from '../../../src/mcp/approval.js';
import type { JMAPClient } from '../../../src/jmap/client.js';
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
function fakeJmap() {
  const writes: string[] = [];
  const request = vi.fn(async (calls: [string, Record<string, any>, string][]) => ({
    methodResponses: calls.map(([method, args, id]) => {
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
  const jmap = {
    getSession: () => ({ accountId: 'acc', apiUrl: 'https://jmap.example.com/api', username: 'alice.martin@example.com' }),
    request,
    parseMethodResponse: (r: [string, Record<string, unknown>]) => (r[0] === 'error' ? { success: false, error: { type: String(r[1].type) } } : { success: true, data: r[1] }),
    downloadBlob: async (blobId: string) => new ArrayBuffer(blobId === 'small' ? 10 : 800 * 1024),
    uploadBlob: async () => {
      writes.push('upload');
      return { blobId: 'uploaded', type: 'application/pdf', size: 3 };
    },
  } as unknown as JMAPClient;
  return { jmap, writes };
}

async function connect(answers: ('accept' | 'decline')[], opts: { elicitation?: boolean; mode?: 'elicit' | 'client'; exempt?: string[]; uploadDir?: string } = {}) {
  const { jmap, writes } = fakeJmap();
  const server = new McpServer({ name: 't', version: '0' });
  setApprover(server, { mode: opts.mode ?? 'elicit', language: 'fr', timeoutMs: 2000, as: 'alice.martin@example.com', timeZone: 'Europe/Paris', exempt: opts.exempt, signature: '--\nAlice MARTIN' });
  registerAllTools(server, jmap, logger, { signatureContent: { text: '--\nAlice MARTIN', html: '<p>--<br>Alice MARTIN</p>' } }, { uploadDir: opts.uploadDir });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const prompts: string[] = [];
  const client = new Client({ name: 'c', version: '0' }, { capabilities: opts.elicitation === false ? {} : { elicitation: { form: {} } } });
  if (opts.elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      const answer = answers.shift() ?? 'decline';
      return answer === 'accept' ? { action: answer, content: {} } : { action: answer };
    });
  }
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: (r.content as { text: string }[]).map((c) => c.text).join('\n') };
  };
  const batchOf = async (actions: { tool: string; arguments: Record<string, unknown> }[]) => {
    const r = await call('approve_batch', { actions });
    return { ...r, batchId: /"batchId":"([0-9a-f]{32})"/.exec(r.text)?.[1] };
  };
  return { call, batchOf, writes, prompts, client };
}

const WRITES: [string, Record<string, unknown>][] = [
  ['send_email', { to: ['bob.durand@example.com'], subject: 'Budget', body: 'Validé, merci.' }],
  ['reply_email', { originalEmailId: 'e1', body: 'Validé, merci.', replyAll: true }],
  ['forward_email', { originalEmailId: 'e1', to: ['chloe.petit@example.com'], note: 'Pour info.' }],
  ['send_draft', { draftId: 'draft-1' }],
  ['create_draft', { to: ['bob.durand@example.com'], subject: 'Budget', body: 'Brouillon.' }],
  ['update_draft', { draftId: 'draft-1', subject: 'Proposition v2' }],
  ['reply_draft', { originalEmailId: 'e1', body: 'Validé, merci.' }],
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
  ['set_mailbox_subscription', { mailboxIds: ['mb-proj'], subscribed: true }],
];

const draft = { to: ['bob.durand@example.com'], subject: 'Budget', body: 'Brouillon.' };
const draft2 = { ...draft, subject: 'Budget 2' };

describe('approve_batch', () => {
  it('lists every tool that asks before writing as WRITE_TOOLS', async () => {
    const { client } = await connect([]);
    const tools = (await client.listTools()).tools;
    const writers = tools.filter((t) => t.annotations?.readOnlyHint !== true && t.name !== 'approve_batch').map((t) => t.name);
    expect([...WRITE_TOOLS].sort()).toEqual(writers.sort());
    expect(new Set([...WRITE_TOOLS, ...WRITES.map(([n]) => n)]).size).toBe(WRITE_TOOLS.length);
  });

  it('creates two drafts after one approval of the batch', async () => {
    const t = await connect(['accept']);
    const b = await t.batchOf([
      { tool: 'create_draft', arguments: draft },
      { tool: 'create_draft', arguments: draft2 },
    ]);
    expect(b.batchId, b.text).toBeDefined();
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain('2 actions');
    expect(t.prompts[0]).toContain('[1/2] Twake Mail : ');
    expect(t.prompts[0]).toContain('Objet : Budget 2');
    expect(t.writes).toEqual([]);
    expect((await t.call('create_draft', { ...draft, batchId: b.batchId })).error).toBe(false);
    expect((await t.call('create_draft', { ...draft2, batchId: b.batchId })).error).toBe(false);
    expect(t.prompts).toHaveLength(1);
    expect(t.writes.filter((w) => w === 'Email/set')).toHaveLength(2);
  });

  it('asks again for a create_draft whose arguments are not in the batch', async () => {
    const t = await connect(['accept', 'accept']);
    const b = await t.batchOf([{ tool: 'create_draft', arguments: draft }]);
    const r = await t.call('create_draft', { ...draft, subject: 'Autre chose', batchId: b.batchId });
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]).toContain('Objet : Autre chose');
    expect(r.text).toContain('lot non utilisé');
    expect(t.writes.length).toBeGreaterThan(0);
  });

  it('writes nothing while preparing the batch', async () => {
    const t = await connect(['decline']);
    // the sending tools (each one's text carries the whole e-mail); every tool alone is checked below
    const sending = WRITES.slice(0, 7);
    const b = await t.batchOf(sending.map(([tool, args]) => ({ tool, arguments: args })));
    expect(b.batchId).toBeUndefined();
    expect(b.text).toContain('Lot non approuvé');
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain(`${sending.length} actions`);
    expect(t.writes).toEqual([]);
  });

  it('refuses a batch with a read tool', async () => {
    const t = await connect(['accept']);
    const b = await t.batchOf([
      { tool: 'create_draft', arguments: draft },
      { tool: 'search_emails', arguments: { query: 'budget' } },
    ]);
    expect(b.error).toBe(true);
    expect(b.text).toContain('action 2.');
    expect(t.prompts).toEqual([]);
  });

  it.each(WRITES)('%s runs once approved in a batch, without another question (%o)', async (tool, args) => {
    const t = await connect(['accept']);
    const b = await t.batchOf([{ tool, arguments: args }]);
    expect(b.batchId, b.text).toBeDefined();
    expect(t.writes).toEqual([]);
    const r = await t.call(tool, { ...args, batchId: b.batchId });
    expect(r.error, r.text).toBe(false);
    expect(r.text).not.toContain('lot non utilisé');
    expect(t.prompts).toHaveLength(1);
    expect(t.writes.length).toBeGreaterThan(0);
  });

  it('accepts an exempted tool in a batch, saying it asks for no approval', async () => {
    const t = await connect(['accept'], { exempt: ['create_draft'] });
    const b = await t.batchOf([
      { tool: 'create_draft', arguments: draft },
      { tool: 'send_email', arguments: { to: ['bob.durand@example.com'], subject: 'Budget', body: 'Validé.' } },
    ]);
    expect(b.batchId, b.text).toBeDefined();
    expect(t.prompts[0]).toContain('[1/2] Twake Mail : create_draft (sans approbation : JMAP_APPROVAL_EXEMPT)');
    expect(t.prompts[0]).toContain('[2/2] Twake Mail : Envoyer un e-mail');
    expect(t.writes).toEqual([]);
  });

  it('creates no batch with JMAP_APPROVAL=client', async () => {
    const t = await connect([], { mode: 'client' });
    const b = await t.batchOf([{ tool: 'create_draft', arguments: draft }]);
    expect(b.batchId).toBeUndefined();
    expect(b.text).toContain('client');
  });
});
