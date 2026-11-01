/**
 * Prior approval of every write, asked by the server itself through MCP elicitation: the client shows
 * the user the exact action (the e-mail as it will leave: sender, recipients, subject, text,
 * attachments; or the e-mails and folders an operation touches) and the server acts only on an
 * explicit "accept". Fail closed: a client that cannot ask, a refusal, a timeout or an error means
 * nothing is sent or changed.
 */
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JMAPClient } from '../jmap/client.js';

export type ApprovalMode = 'elicit' | 'client';
export type Language = 'en' | 'fr';

const ACTIONS = {
  send_email: { en: 'Send an e-mail', fr: 'Envoyer un e-mail' },
  reply_email: { en: 'Send a reply', fr: 'Envoyer une réponse' },
  forward_email: { en: 'Forward an e-mail', fr: 'Transférer un e-mail' },
  send_draft: { en: 'Send a draft', fr: 'Envoyer un brouillon' },
  create_draft: { en: 'Create a draft (not sent)', fr: 'Créer un brouillon (non envoyé)' },
  update_draft: { en: 'Change a draft (not sent)', fr: 'Modifier un brouillon (non envoyé)' },
  mark_as_read: { en: 'Mark as read', fr: 'Marquer comme lu' },
  mark_as_unread: { en: 'Mark as unread', fr: 'Marquer comme non lu' },
  delete_email: { en: 'Move to the trash', fr: 'Mettre à la corbeille' },
  delete_email_permanently: { en: 'Delete permanently (cannot be undone)', fr: 'Supprimer définitivement (irréversible)' },
  move_email: { en: 'Move an e-mail', fr: 'Déplacer un e-mail' },
  add_label: { en: 'Add a label', fr: 'Ajouter un libellé' },
  remove_label: { en: 'Remove a label', fr: 'Retirer un libellé' },
  batch_mark_read: { en: 'Mark e-mails as read', fr: 'Marquer des e-mails comme lus' },
  batch_mark_unread: { en: 'Mark e-mails as unread', fr: 'Marquer des e-mails comme non lus' },
  batch_move: { en: 'Move e-mails', fr: 'Déplacer des e-mails' },
  batch_delete: { en: 'Move e-mails to the trash', fr: 'Mettre des e-mails à la corbeille' },
  batch_delete_permanently: { en: 'Delete e-mails permanently (cannot be undone)', fr: 'Supprimer des e-mails définitivement (irréversible)' },
  batch_add_label: { en: 'Add a label to e-mails', fr: 'Ajouter un libellé à des e-mails' },
  batch_remove_label: { en: 'Remove a label from e-mails', fr: 'Retirer un libellé de e-mails' },
  create_mailbox: { en: 'Create a folder', fr: 'Créer un dossier' },
  rename_mailbox: { en: 'Rename a folder', fr: 'Renommer un dossier' },
  delete_mailbox: { en: 'Delete a folder', fr: 'Supprimer un dossier' },
} as const;

const LABELS = {
  en: {
    as: 'As', from: 'From', to: 'To', cc: 'Cc', bcc: 'Bcc', subject: 'Subject', text: 'Text', attachments: 'Attachments', in_reply_to: 'In reply to',
    email: 'E-mail', emails: 'E-mails', draft: 'Draft', changes: 'Changes', mailbox: 'Folder', label: 'Label', destination: 'Destination', name: 'Name',
    parent: 'Inside', contents: 'Contents', account: 'your account', ref: 'Ref.', footer: 'Accept to do it now, refuse to cancel.', more: 'more',
    leaves: 'leaves now in your name', signature: 'signature included', none: 'none',
  },
  fr: {
    as: 'En tant que', from: 'De', to: 'À', cc: 'Cc', bcc: 'Cci', subject: 'Objet', text: 'Texte', attachments: 'Pièces jointes', in_reply_to: 'En réponse à',
    email: 'E-mail', emails: 'E-mails', draft: 'Brouillon', changes: 'Changements', mailbox: 'Dossier', label: 'Libellé', destination: 'Destination', name: 'Nom',
    parent: 'Dans', contents: 'Contenu', account: 'votre compte', ref: 'Réf.', footer: 'Acceptez pour le faire maintenant, refusez pour annuler.', more: 'de plus',
    leaves: 'part maintenant en votre nom', signature: 'signature comprise', none: 'aucun',
  },
} as const;

export type Action = keyof typeof ACTIONS;
export type Label = keyof (typeof LABELS)['en'];

export interface ApprovalRequest {
  action: Action;
  /** [label key, value]; undefined or empty values are left out. */
  details: [Label, string | undefined][];
}

export interface ApprovalOptions {
  mode: ApprovalMode;
  language: Language;
  timeoutMs: number;
  /** Who the writes are made as (the account e-mail). */
  as?: string;
  timeZone?: string;
  /** Tools the user chose to run without a prompt (JMAP_APPROVAL_EXEMPT). */
  exempt?: string[];
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const MAX_TEXT = 3000;

export function approvalMessage(req: ApprovalRequest, opts: Pick<ApprovalOptions, 'language' | 'as'>, ref: string): string {
  const L = LABELS[opts.language];
  const sep = opts.language === 'fr' ? ' : ' : ': ';
  const lines = [`Twake Mail${sep}${ACTIONS[req.action][opts.language]}`];
  if (opts.as) lines.push(`${L.as}${sep}${opts.as} (${L.account})`);
  for (const [label, raw] of req.details) {
    if (raw === undefined || raw === '') continue;
    const value = raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}… (+${raw.length - MAX_TEXT})` : raw;
    lines.push(value.includes('\n') ? `${L[label]}${sep}\n${value}` : `${L[label]}${sep}${value}`);
  }
  lines.push('', `${L.ref} ${ref} · ${L.footer}`);
  return lines.join('\n');
}

type Address = { name?: string; email: string };
const addr = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);
const addrs = (list: unknown) => (Array.isArray(list) && list.length ? (list as Address[]).map(addr).join(', ') : undefined);

/** Plain text of an HTML fragment, for the prompt. */
function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class Approver {
  constructor(
    private readonly server: McpServer['server'] | undefined,
    readonly opts: ApprovalOptions,
  ) {}

  label(key: Label): string {
    return LABELS[this.opts.language][key];
  }

  date(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: this.opts.timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(d)
        .map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  /** The e-mail as it will be stored or sent: sender, recipients, subject, text and attachments. */
  message(e: Record<string, unknown>): [Label, string | undefined][] {
    const values = Object.values((e.bodyValues ?? {}) as Record<string, { value: string }>);
    const textPart = (e.textBody as { partId: string }[] | undefined)?.[0]?.partId;
    const htmlPart = (e.htmlBody as { partId: string }[] | undefined)?.[0]?.partId;
    const bodies = (e.bodyValues ?? {}) as Record<string, { value: string }>;
    let text: string | undefined;
    if (textPart && bodies[textPart]) text = bodies[textPart].value;
    else if (htmlPart && bodies[htmlPart]) text = htmlToText(bodies[htmlPart].value);
    else if (values.length) text = values[0].value;
    // The configured signature ("-- " delimiter, RFC 3676) is long and always the same: name it, do not repeat it.
    const cut = text?.search(/\n-- ?\n/) ?? -1;
    if (text && cut >= 0) text = `${text.slice(0, cut).trimEnd()}\n[${this.label('signature')}]`;
    const files = (e.attachments as { name?: string; size?: number }[] | undefined)?.map((a) => a.name ?? 'file');
    return [
      ['from', addrs(e.from)],
      ['to', addrs(e.to)],
      ['cc', addrs(e.cc)],
      ['bcc', addrs(e.bcc)],
      ['subject', String(e.subject ?? '')],
      ['text', text?.trim()],
      ['attachments', files?.length ? files.join(', ') : undefined],
    ];
  }

  /** A stored e-mail (a draft about to be sent), read back with its text. */
  async stored(jmap: JMAPClient, id: string): Promise<[Label, string | undefined][]> {
    const session = jmap.getSession();
    const res = await jmap.request([
      [
        'Email/get',
        {
          accountId: session.accountId,
          ids: [id],
          properties: ['from', 'to', 'cc', 'bcc', 'subject', 'textBody', 'htmlBody', 'bodyValues', 'attachments'],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
        },
        'describe',
      ],
    ]);
    const e = ((res.methodResponses?.[0]?.[1] as { list?: Record<string, unknown>[] })?.list ?? [])[0];
    if (!e) return [['draft', id]];
    return this.message(e);
  }

  /** "Bob DURAND <bob@…> · 2026-10-30 14:02 · Subject", one line per e-mail (at most 10). */
  async emails(jmap: JMAPClient, ids: string[]): Promise<string> {
    const shown = ids.slice(0, 10);
    let lines = shown;
    try {
      const session = jmap.getSession();
      const res = await jmap.request([['Email/get', { accountId: session.accountId, ids: shown, properties: ['subject', 'from', 'receivedAt'] }, 'describe']]);
      const list = ((res.methodResponses?.[0]?.[1] as { list?: { id: string; subject?: string; from?: Address[]; receivedAt?: string }[] })?.list ?? []);
      const byId = new Map(list.map((m) => [m.id, m]));
      lines = shown.map((id) => {
        const m = byId.get(id);
        return m ? [m.from?.length ? addr(m.from[0]) : '?', this.date(m.receivedAt), m.subject || '(no subject)'].filter(Boolean).join(' · ') : id;
      });
    } catch {
      // the ids are shown instead
    }
    if (ids.length > shown.length) lines.push(`… ${ids.length - shown.length} ${this.label('more')}`);
    return lines.length === 1 ? lines[0] : lines.map((l) => `• ${l}`).join('\n');
  }

  /** Folder name (full path when it has parents), else its id. */
  async mailbox(jmap: JMAPClient, id: string): Promise<string> {
    try {
      const session = jmap.getSession();
      const res = await jmap.request([['Mailbox/get', { accountId: session.accountId, properties: ['name', 'parentId'] }, 'describe']]);
      const list = ((res.methodResponses?.[0]?.[1] as { list?: { id: string; name: string; parentId?: string | null }[] })?.list ?? []);
      const byId = new Map(list.map((m) => [m.id, m]));
      const parts: string[] = [];
      for (let m = byId.get(id), n = 0; m && n < 10; m = m.parentId ? byId.get(m.parentId) : undefined, n++) parts.unshift(m.name);
      return parts.length ? parts.join(' / ') : id;
    } catch {
      return id;
    }
  }

  /**
   * Ask the user. Returns null when they accepted (go ahead), or the tool result to send back when
   * nothing must be written. The details are computed only when the user is actually asked.
   */
  async gate(tool: string, request: () => Promise<ApprovalRequest> | ApprovalRequest): Promise<ToolResult | null> {
    if (this.opts.mode === 'client' || this.opts.exempt?.includes(tool)) return null;
    if (!this.server?.getClientCapabilities()?.elicitation) {
      return {
        content: [
          {
            type: 'text',
            text:
              'Not done: this MCP client cannot ask the user for approval (no elicitation support), so mcp-twake-mail refuses to send or change anything. ' +
              'Use a client that supports elicitation, or set JMAP_APPROVAL=client only if the client itself confirms every write tool with the user.',
          },
        ],
        isError: true,
      };
    }
    const ref = randomBytes(3).toString('hex');
    let action: string;
    try {
      const req = await request();
      const res = await this.server.elicitInput(
        { mode: 'form', message: approvalMessage(req, this.opts, ref), requestedSchema: { type: 'object', properties: {} } },
        { timeout: this.opts.timeoutMs },
      );
      action = res.action;
    } catch {
      action = 'cancel';
    }
    if (action === 'accept') return null;
    return {
      content: [
        {
          type: 'text',
          text:
            action === 'decline'
              ? 'Not done: the user refused this action, nothing was sent or changed. Do not retry unless they ask again.'
              : 'Not done: no answer to the approval request (dismissed, timed out or nobody available), nothing was sent or changed. Do not retry on your own.',
        },
      ],
    };
  }
}

const approvers = new WeakMap<object, Approver>();

export function setApprover(server: McpServer, opts: ApprovalOptions): Approver {
  const a = new Approver((server as { server?: McpServer['server'] }).server, opts);
  approvers.set(server, a);
  return a;
}

/** The server's approver; one that was never configured asks with the defaults (fail closed). */
export function approverFor(server: McpServer): Approver {
  return approvers.get(server) ?? setApprover(server, { mode: 'elicit', language: 'en', timeoutMs: 600_000 });
}
