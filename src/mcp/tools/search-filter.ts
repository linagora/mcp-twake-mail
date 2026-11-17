/**
 * The JMAP Email/query filter of search_emails (RFC 8621 §4.4.1).
 */

const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * A UTCDate as JMAP requires it ("2026-11-10T12:00:00Z"). Only ISO 8601 is read, never guessed:
 * a date alone is midnight UTC, a time without an offset is UTC.
 */
export function utcDate(value: string, field: 'before' | 'after'): string {
  const bad = new Error(`${field}: "${value}" is not a date. Use ISO 8601, e.g. 2026-11-10 or 2026-11-10T13:00:00Z.`);
  const m = ISO_8601.exec(value.trim());
  if (!m) throw bad;
  const [, y, mo, d, h = '00', mi = '00', sec = '00', zone = 'Z'] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const realDay = day.getUTCFullYear() === Number(y) && day.getUTCMonth() === Number(mo) - 1 && day.getUTCDate() === Number(d);
  if (!realDay || Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) throw bad;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}${zone}`);
  if (Number.isNaN(date.getTime())) throw bad;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
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
