import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(),
}));

import { registerReplyDraftTool } from '../../../../src/mcp/tools/reply-draft.js';
import { setApprover } from '../../../../src/mcp/approval.js';
import type { JMAPClient } from '../../../../src/jmap/client.js';
import type { Logger } from '../../../../src/config/logger.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const ORIGINAL = {
  id: 'e1',
  messageId: ['m2@x'],
  references: ['m1@x'],
  subject: 'Budget 2027',
  from: [{ name: 'Bob DURAND', email: 'bob@x' }],
  to: [{ email: 'alice@x' }],
  cc: [{ email: 'chloe@x' }],
  sentAt: '2026-10-30T13:02:00Z',
  textBody: [{ partId: '1', type: 'text/plain' }],
  htmlBody: [{ partId: '2', type: 'text/html' }],
  bodyValues: { '1': { value: 'Peux-tu valider ?' }, '2': { value: '<p>Peux-tu valider ?</p>' } },
};

describe('reply_draft', () => {
  let server: McpServer;
  let jmap: JMAPClient;
  let handlers: Map<string, { config: { annotations: Record<string, boolean> }; handler: Handler }>;
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;

  beforeEach(() => {
    handlers = new Map();
    server = {
      registerTool: vi.fn((name: string, config: never, handler: Handler) => handlers.set(name, { config, handler })),
    } as unknown as McpServer;
    // these tests script every JMAP call: the client confirms (prompts are tested in tests/unit/mcp/approval.test.ts)
    setApprover(server, { mode: 'client', language: 'fr', timeoutMs: 1000, timeZone: 'Europe/Paris' });
    jmap = { getSession: vi.fn().mockReturnValue({ accountId: 'acc' }), request: vi.fn(), parseMethodResponse: vi.fn() } as unknown as JMAPClient;
  });

  function jmapAnswering(original: Record<string, unknown> | null) {
    vi.mocked(jmap.request).mockImplementation(async (calls: any) => ({
      methodResponses: calls.map(([m, , id]: any) =>
        m === 'Mailbox/get'
          ? [m, { list: [{ id: 'mb-drafts', role: 'drafts' }] }, id]
          : m === 'Email/get'
            ? [m, { list: original ? [original] : [] }, id]
            : m === 'Identity/get'
              ? [m, { list: [{ id: 'i1', email: 'alice@x', name: 'Alice MARTIN' }] }, id]
              : [m, { created: { draft: { id: 'd1', threadId: 't9' } } }, id]
      ),
    }));
    vi.mocked(jmap.parseMethodResponse).mockImplementation((r: any) => ({ success: true, data: r[1] }));
  }
  const setCalls = () => vi.mocked(jmap.request).mock.calls.map((c) => (c[0] as any)[0]).filter(([m]: any) => m === 'Email/set');
  const created = () => setCalls()[0][1].create.draft;
  const tool = () => {
    registerReplyDraftTool(server, jmap, logger, { text: 'Alice', html: '<p>Alice</p>' });
    return handlers.get('reply_draft')!;
  };

  it('is a write that creates, never destroys', () => {
    expect(tool().config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it('creates a draft in Drafts, threaded, with Re:, the signature, then the quote', async () => {
    jmapAnswering(ORIGINAL);

    const r = await tool().handler({ originalEmailId: 'e1', body: 'Validé.' });

    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ success: true, draftId: 'd1', threadId: 't9' });
    const d = created();
    expect(d.mailboxIds).toEqual({ 'mb-drafts': true });
    expect(d.keywords).toEqual({ $draft: true, $seen: true });
    expect(d.from).toEqual([{ email: 'alice@x', name: 'Alice MARTIN' }]);
    expect(d.subject).toBe('Re: Budget 2027');
    expect(d.to).toEqual([{ name: 'Bob DURAND', email: 'bob@x' }]);
    expect(d.cc).toBeUndefined();
    expect(d.inReplyTo).toEqual(['m2@x']);
    expect(d.references).toEqual(['m1@x', 'm2@x']);
    expect(d.bodyValues.text.value).toBe('Validé.\n\n-- \nAlice\n\nLe 30/10/2026 à 14:02, Bob DURAND <bob@x> a écrit :\n> Peux-tu valider ?');
    expect(d.bodyValues.html.value).toContain('<blockquote type="cite"');
    expect(d.bodyValues.html.value.indexOf('Alice')).toBeLessThan(d.bodyValues.html.value.indexOf('<blockquote'));
  });

  it('replies to all, leaving the user out', async () => {
    jmapAnswering(ORIGINAL);

    await tool().handler({ originalEmailId: 'e1', body: 'Validé.', replyAll: true });

    expect(created().to).toEqual([{ name: 'Bob DURAND', email: 'bob@x' }]);
    expect(created().cc).toEqual([{ email: 'chloe@x' }]);
  });

  it('leaves the quote out with quote: false, and the signature with signature: false', async () => {
    jmapAnswering(ORIGINAL);

    await tool().handler({ originalEmailId: 'e1', body: 'Validé.', quote: false, signature: false });

    expect(created().bodyValues.text.value).toBe('Validé.');
  });

  it('needs the text of the reply', async () => {
    jmapAnswering(ORIGINAL);

    const r = await tool().handler({ originalEmailId: 'e1' });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Give body or htmlBody');
    expect(jmap.request).not.toHaveBeenCalled();
  });

  it('says so when the original does not exist, and creates nothing', async () => {
    jmapAnswering(null);

    const r = await tool().handler({ originalEmailId: 'e1', body: 'Validé.' });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Original email not found: e1');
    expect(setCalls()).toEqual([]);
  });

  it('quotes an original that has only an HTML body', async () => {
    jmapAnswering({ ...ORIGINAL, textBody: [{ partId: '2', type: 'text/html' }] });

    await tool().handler({ originalEmailId: 'e1', body: 'Validé.' });

    expect(created().bodyValues.text.value).toMatch(/a écrit :\n> Peux-tu valider \?$/);
  });

  it('quotes the attribution line alone when the original has no body', async () => {
    jmapAnswering({ ...ORIGINAL, textBody: [], htmlBody: [], bodyValues: {} });

    const r = await tool().handler({ originalEmailId: 'e1', body: 'Validé.' });

    expect(r.isError).toBeUndefined();
    expect(created().bodyValues.text.value).toMatch(/Bob DURAND <bob@x> a écrit :$/);
  });
});
