/**
 * Email transformer - converts JMAP Email objects to SimplifiedEmail DTOs.
 * Implements TRANS-03: keyword to boolean flag conversion.
 */
import type { Email, EmailAddress as JMAPEmailAddress, EmailBodyPart } from '@linagora/jmap-client-ts';
import type { SimplifiedEmail, EmailAddress, SimplifiedAttachment } from '../types/dto.js';

/** A body part reference (textBody or htmlBody): only its partId and type are read. */
type JMAPBodyPart = Pick<EmailBodyPart, 'partId' | 'type'>;

/** An attachment part, as requested with bodyProperties. */
type JMAPAttachment = Pick<EmailBodyPart, 'blobId' | 'type' | 'name' | 'size'>;

/**
 * The JMAP Email properties needed for transformation. mailboxIds and keywords are read as
 * booleans; the other properties are optional, as not every call requests them.
 */
type JMAPEmail = Pick<Email, 'id' | 'blobId' | 'threadId' | 'receivedAt' | 'subject'> & {
  mailboxIds: Record<string, boolean>;
  keywords?: Record<string, boolean>;
  from: JMAPEmailAddress[] | null;
  to: JMAPEmailAddress[] | null;
} & Partial<
    Pick<Email, 'cc' | 'bcc' | 'replyTo' | 'preview' | 'size' | 'hasAttachment' | 'bodyValues' | 'messageId' | 'inReplyTo' | 'references'>
  > & {
    textBody?: JMAPBodyPart[];
    htmlBody?: JMAPBodyPart[];
    attachments?: JMAPAttachment[];
  };

/**
 * Convert JMAP mailboxIds object to string array.
 * Filters to only include mailboxes where value is true.
 * @param mailboxIds Record of mailbox ID to boolean
 * @returns Array of mailbox IDs
 */
function convertMailboxIds(mailboxIds: Record<string, boolean>): string[] {
  return Object.entries(mailboxIds)
    .filter(([, isInMailbox]) => isInMailbox)
    .map(([mailboxId]) => mailboxId);
}

/**
 * Extract boolean flag from keywords object.
 * @param keywords Keywords object or undefined
 * @param keyword Keyword to check (e.g., '$seen')
 * @returns true if keyword is set, false otherwise
 */
function hasKeyword(keywords: Record<string, boolean> | undefined, keyword: string): boolean {
  return keywords?.[keyword] === true;
}

/**
 * Transform JMAP email addresses to EmailAddress DTOs.
 * @param addresses JMAP email addresses
 * @returns EmailAddress array
 */
function transformAddresses(addresses: JMAPEmailAddress[] | null | undefined): EmailAddress[] {
  if (!addresses) {
    return [];
  }
  return addresses.map((addr) => ({
    name: addr.name,
    email: addr.email,
  }));
}

/**
 * Extract body content from JMAP body parts and values.
 * @param bodyParts Body part references (textBody or htmlBody)
 * @param bodyValues Body values keyed by partId
 * @returns Extracted body text or undefined
 */
function extractBodyContent(
  bodyParts: JMAPBodyPart[] | undefined,
  bodyValues: Email['bodyValues'] | undefined
): string | undefined {
  if (!bodyParts || !bodyValues || bodyParts.length === 0) {
    return undefined;
  }
  // Use first body part
  const firstPart = bodyParts[0];
  const value = firstPart.partId === null ? undefined : bodyValues[firstPart.partId];
  return value?.value;
}

/**
 * Transform JMAP attachments to SimplifiedAttachment DTOs.
 * @param attachments JMAP attachments
 * @returns SimplifiedAttachment array or undefined
 */
function transformAttachments(
  attachments: JMAPAttachment[] | undefined
): SimplifiedAttachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((att) => ({
    // an attachment is a leaf part: it always has a blob
    blobId: att.blobId as string,
    type: att.type,
    name: att.name,
    size: att.size,
  }));
}

/**
 * Transform a JMAP Email object to SimplifiedEmail DTO.
 * Converts keywords to boolean flags and mailboxIds to array.
 *
 * Keyword mapping:
 * - $seen -> isRead
 * - $flagged -> isFlagged
 * - $draft -> isDraft
 * - $answered -> isAnswered
 * - $forwarded -> isForwarded
 *
 * @param jmapEmail JMAP Email object
 * @returns SimplifiedEmail DTO
 */
export function transformEmail(jmapEmail: JMAPEmail): SimplifiedEmail {
  const keywords = jmapEmail.keywords;

  const result: SimplifiedEmail = {
    // Core identifiers
    id: jmapEmail.id,
    blobId: jmapEmail.blobId,
    threadId: jmapEmail.threadId,

    // Convert mailboxIds from object to array
    mailboxIds: convertMailboxIds(jmapEmail.mailboxIds),

    // Convert keywords to boolean flags
    isRead: hasKeyword(keywords, '$seen'),
    isFlagged: hasKeyword(keywords, '$flagged'),
    isDraft: hasKeyword(keywords, '$draft'),
    isAnswered: hasKeyword(keywords, '$answered'),
    isForwarded: hasKeyword(keywords, '$forwarded'),

    // Timestamp
    receivedAt: jmapEmail.receivedAt,

    // Content metadata
    subject: jmapEmail.subject,

    // Address fields
    from: transformAddresses(jmapEmail.from),
    to: transformAddresses(jmapEmail.to),
  };

  // Add optional fields only if present
  if (jmapEmail.preview !== undefined) {
    result.preview = jmapEmail.preview;
  }
  if (jmapEmail.size !== undefined) {
    result.size = jmapEmail.size;
  }
  if (jmapEmail.hasAttachment !== undefined) {
    result.hasAttachment = jmapEmail.hasAttachment;
  }
  if (jmapEmail.cc) {
    result.cc = transformAddresses(jmapEmail.cc);
  }
  if (jmapEmail.bcc) {
    result.bcc = transformAddresses(jmapEmail.bcc);
  }
  if (jmapEmail.replyTo) {
    result.replyTo = transformAddresses(jmapEmail.replyTo);
  }
  if (jmapEmail.messageId?.length) {
    result.messageId = jmapEmail.messageId[0];
  }
  if (jmapEmail.inReplyTo?.length) {
    result.inReplyTo = jmapEmail.inReplyTo;
  }
  if (jmapEmail.references?.length) {
    result.references = jmapEmail.references;
  }

  // Extract body content if available
  const textBody = extractBodyContent(jmapEmail.textBody, jmapEmail.bodyValues);
  if (textBody !== undefined) {
    result.textBody = textBody;
  }

  const htmlBody = extractBodyContent(jmapEmail.htmlBody, jmapEmail.bodyValues);
  if (htmlBody !== undefined) {
    result.htmlBody = htmlBody;
  }

  // Transform attachments
  const attachments = transformAttachments(jmapEmail.attachments);
  if (attachments !== undefined) {
    result.attachments = attachments;
  }

  return result;
}
