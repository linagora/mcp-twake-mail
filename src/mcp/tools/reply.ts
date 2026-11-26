/**
 * What a reply needs from the e-mail it answers: threading headers, subject, recipients and
 * how to name it in an approval prompt. Shared by reply_email, reply_draft and create_draft.
 */
export type Address = { name?: string | null; email: string };

export interface Original {
  messageId?: string[] | null;
  references?: string[] | null;
  subject?: string | null;
  from?: Address[] | null;
  to?: Address[] | null;
  cc?: Address[] | null;
  replyTo?: Address[] | null;
  sentAt?: string | null;
  receivedAt?: string | null;
}

/** The properties of the original to fetch with Email/get. */
export const ORIGINAL_PROPERTIES = ['messageId', 'references', 'subject', 'from', 'to', 'cc', 'replyTo', 'sentAt', 'receivedAt'] as const;

/** In-Reply-To and References of a reply (RFC 5322 §3.6.4), as JMAP arrays. */
export function threadingHeaders(o: Original): { inReplyTo: string[]; references: string[] } {
  return { inReplyTo: o.messageId ?? [], references: [...(o.references ?? []), ...(o.messageId ?? [])] };
}

export function replySubject(subject: string | null | undefined): string {
  const s = subject ?? '';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export const formatAddress = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);

/** "Bob DURAND <bob@example.com> · Budget": the e-mail being answered, for the approval prompt. */
export function describeOriginal(o: Original): string {
  return [o.from?.[0] ? formatAddress(o.from[0]) : undefined, o.subject || undefined].filter(Boolean).join(' · ');
}

/**
 * Who a reply goes to: Reply-To, else From; with replyAll, also the original To (but the primary
 * recipient) and Cc, never the user. null when the original has no address to answer.
 */
export function replyRecipients(o: Original, selfEmail: string | undefined, replyAll: boolean): { to: Address[]; cc: Address[] } | null {
  const primary = o.replyTo?.[0] || o.from?.[0];
  if (!primary) return null;
  const to: Address[] = [primary];
  const cc: Address[] = [];
  if (replyAll) {
    const self = selfEmail?.toLowerCase();
    const same = (a: Address, b: string | undefined) => a.email.toLowerCase() === b;
    for (const a of o.to ?? []) if (!same(a, self) && !same(a, primary.email.toLowerCase())) to.push(a);
    for (const a of o.cc ?? []) if (!same(a, self)) cc.push(a);
  }
  return { to, cc };
}
