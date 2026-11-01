// Live test of the prior approval of writes on a REAL JMAP account. The script answers the approval
// prompts itself. It SENDS NOTHING: sending tools are only refused (and the script checks that nothing
// left); the accepted writes work on a draft addressed to the account itself, deleted at the end.
// Prints ids, counts and the prompts (test data only).
//   JMAP_SESSION_URL=… JMAP_AUTH_METHOD=… LIVE_SELF=<your address> node scripts/live-approval.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const self = process.env.LIVE_SELF;
if (!self) throw new Error('set LIVE_SELF to your own address (the test draft is addressed to it, never sent)');
const answers = [];
const prompts = [];
const client = new Client({ name: 'live-approval', version: '0' }, { capabilities: { elicitation: { form: {} } } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  prompts.push(req.params.message);
  const action = answers.shift() ?? 'decline';
  return action === 'accept' ? { action, content: {} } : { action };
});
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [new URL('../build/index.js', import.meta.url).pathname], env: { ...process.env, JMAP_APPROVAL: 'elicit', JMAP_APPROVAL_EXEMPT: '' }, stderr: 'ignore' })
);
const call = async (name, args, answer) => {
  if (answer) answers.push(answer);
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: r.content[0].text };
};
const ok = (c, s) => console.log(`${c ? 'ok  ' : 'FAIL'} ${s}`);
const stamp = `MCP approval test ${new Date().toISOString().slice(11, 19)}`;
const mailboxes = JSON.parse((await call('list_mailboxes', {})).text);
const list = Array.isArray(mailboxes) ? mailboxes : mailboxes.mailboxes ?? mailboxes.list ?? [];
const role = (r) => list.find((m) => m.role === r)?.id;
const find = async (mailboxId) => {
  const r = await call('search_emails', { subject: stamp, ...(mailboxId ? { mailboxId } : {}), limit: 10 });
  const ids = [...r.text.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(ids)];
};

let r = await call('send_email', { to: [self], subject: stamp, body: 'must not leave' }, 'decline');
ok(/^Not done: the user refused/.test(r.text), 'send_email refused: not sent');
console.log('--- prompt of the refused e-mail ---\n' + prompts[0] + '\n---');

r = await call('create_draft', { to: [self], subject: stamp, body: 'draft, never sent' }, 'decline');
ok(/^Not done/.test(r.text) && (await find()).length === 0, 'create_draft refused: no draft');
r = await call('create_draft', { to: [self], subject: stamp, body: 'draft, never sent' }, 'accept');
const draftId = /"(?:id|draftId|emailId)":\s*"([^"]+)"/.exec(r.text)?.[1];
ok(!r.isError && Boolean(draftId), 'create_draft accepted: draft created');
r = await call('update_draft', { draftId, body: 'draft v2, never sent' }, 'accept');
const draftNow = JSON.parse(r.isError ? '{}' : r.text).draftId;
ok(!r.isError && Boolean(draftNow) && !(await call('get_email', { emailId: draftNow })).isError && (await call('get_email', { emailId: draftId })).isError, 'update_draft accepted: draft replaced (new id readable, old id gone)');
r = await call('send_draft', { draftId: draftNow }, 'decline');
const sent = role('sent') ? await find(role('sent')) : [];
ok(/^Not done/.test(r.text) && sent.length === 0, 'send_draft refused: nothing in Sent');
r = await call('mark_as_unread', { emailId: draftNow }, 'accept');
ok(!r.isError, 'mark_as_unread accepted');
r = await call('mark_as_read', { emailId: draftNow }, 'decline');
ok(/^Not done/.test(r.text), 'mark_as_read refused');
r = await call('delete_email', { emailId: draftNow, permanent: true }, 'decline');
ok(/^Not done/.test(r.text) && !(await call('get_email', { emailId: draftNow })).isError, 'delete_email refused: draft still there');
r = await call('delete_email', { emailId: draftNow, permanent: true }, 'accept');
ok(!r.isError && (await call('get_email', { emailId: draftNow })).isError, 'delete_email (permanent) accepted: draft gone');
ok(new Set(prompts.map((p) => /(?:Ref\.|Réf\.) (\w+)/.exec(p)?.[1])).size === prompts.length, `${prompts.length} prompts, each with its own reference`);
await client.close();
