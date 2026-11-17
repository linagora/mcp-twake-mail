/**
 * The JMAP Email/query filter of search_emails (RFC 8621 §4.4.1).
 */

/** A UTCDate as JMAP requires it ("2026-11-10T12:00:00Z"); a date alone is midnight UTC. */
export function utcDate(value: string, field: 'before' | 'after'): string {
  const v = value.trim();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${field}: "${value}" is not a date. Use ISO 8601, e.g. 2026-11-10 or 2026-11-10T13:00:00Z.`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface SearchInput {
  mailboxId?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  participant?: string;
  subject?: string;
  text?: string;
  before?: string;
  after?: string;
  hasAttachment?: boolean;
  unreadOnly?: boolean;
  flagged?: boolean;
}

/** The filter, or undefined for none; throws on a date it cannot read. */
export function buildSearchFilter(i: SearchInput): Record<string, unknown> | undefined {
  const f: Record<string, unknown> = {};
  if (i.mailboxId) f.inMailbox = i.mailboxId;
  for (const k of ['from', 'to', 'cc', 'bcc', 'subject', 'text'] as const) {
    if (i[k]) f[k] = i[k];
  }
  if (i.before) f.before = utcDate(i.before, 'before');
  if (i.after) f.after = utcDate(i.after, 'after');
  if (i.hasAttachment !== undefined) f.hasAttachment = i.hasAttachment;
  if (i.unreadOnly) f.notKeyword = '$seen';
  if (i.flagged) f.hasKeyword = '$flagged';

  // A participant is anywhere in the addresses: From, To, Cc or Bcc
  const who = i.participant?.trim();
  const anyOf = who ? { operator: 'OR', conditions: [{ from: who }, { to: who }, { cc: who }, { bcc: who }] } : undefined;
  if (!anyOf) return Object.keys(f).length ? f : undefined;
  return Object.keys(f).length ? { operator: 'AND', conditions: [f, anyOf] } : anyOf;
}
