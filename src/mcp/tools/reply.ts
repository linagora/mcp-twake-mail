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
export const ORIGINAL_PROPERTIES = ['messageId', 'references', 'subject', 'from', 'to', 'cc', 'replyTo', 'sentAt', 'receivedAt'];

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
