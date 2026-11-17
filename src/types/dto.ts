/**
 * Simplified DTO types for MCP tools.
 * These types represent JMAP objects in a format optimized for AI assistants:
 * - Boolean flags instead of keyword objects
 * - Arrays instead of Record<string, boolean> for mailboxIds
 * - Human-readable property names
 */

/**
 * Email address with optional display name.
 */
export interface EmailAddress {
  name: string | null;
  email: string;
}

/**
 * Simplified email attachment.
 */
export interface SimplifiedAttachment {
  blobId: string;
  type: string;
  name: string | null;
  size: number;
}

/**
 * Standard mailbox roles defined in RFC 8621.
 */
export type MailboxRole =
  | 'inbox'
  | 'drafts'
  | 'sent'
  | 'trash'
  | 'junk'
  | 'archive'
  | 'all'
  | 'important'
  | 'subscribed'
  | null;

/**
 * Mailbox permission rights.
 */
export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

/**
 * Simplified email DTO for MCP tools.
 * Converts JMAP keywords to boolean flags:
 * - $seen -> isRead
 * - $flagged -> isFlagged
 * - $draft -> isDraft
 * - $answered -> isAnswered
 * - $forwarded -> isForwarded
 */
export interface SimplifiedEmail {
  // Core identifiers
  id: string;
  blobId: string;
  threadId: string;

  // Mailboxes (converted from Record<string, boolean> to string[])
  mailboxIds: string[];

  // Boolean flags (converted from keywords object)
  isRead: boolean;
  isFlagged: boolean;
  isDraft: boolean;
  isAnswered: boolean;
  isForwarded: boolean;

  // Timestamps
  receivedAt: string;

  // Content metadata
  subject: string | null;
  preview?: string;
  size?: number;
  hasAttachment?: boolean;

  // Address fields
  from: EmailAddress[];
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];

  // Threading (RFC 5322): pass messageId as inReplyTo to answer
  messageId?: string;
  inReplyTo?: string[];
  references?: string[];

  // Body content (optional, only when specifically requested)
  textBody?: string;
  htmlBody?: string;

  // Attachments
  attachments?: SimplifiedAttachment[];
}

/**
 * Simplified mailbox DTO for MCP tools.
 * Preserves JMAP structure but with cleaner typing.
 */
export interface SimplifiedMailbox {
  // Core identifiers
  id: string;
  name: string;
  role: MailboxRole;

  // Hierarchy
  parentId: string | null;
  sortOrder: number;

  // Email counts
  totalEmails: number;
  unreadEmails: number;
  totalThreads?: number;
  unreadThreads?: number;

  // Permissions (optional)
  myRights?: MailboxRights;

  // Subscription status
  isSubscribed?: boolean;
}
