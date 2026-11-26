/**
 * Mailbox transformer - converts JMAP Mailbox objects to SimplifiedMailbox DTOs.
 */
import type { Mailbox, MailboxRights as JMAPMailboxRights } from '@linagora/jmap-client-ts';
import type { SimplifiedMailbox, MailboxRole, MailboxRights } from '../types/dto.js';

/**
 * The JMAP Mailbox properties needed for transformation (thread counts, rights and subscription
 * are optional: they are not always requested).
 */
type JMAPMailbox = Pick<Mailbox, 'id' | 'name' | 'role' | 'totalEmails' | 'unreadEmails' | 'sortOrder' | 'parentId'> &
  Partial<Pick<Mailbox, 'totalThreads' | 'unreadThreads' | 'myRights' | 'isSubscribed'>>;

/**
 * Validate and type-cast role to MailboxRole.
 * @param role Raw role string from JMAP
 * @returns Typed MailboxRole
 */
function castRole(role: string | null): MailboxRole {
  if (role === null) {
    return null;
  }
  // Known roles are passed through; unknown roles are treated as null
  const knownRoles = ['inbox', 'drafts', 'sent', 'trash', 'junk', 'archive', 'all', 'important', 'subscribed'];
  return knownRoles.includes(role) ? (role as MailboxRole) : null;
}

/**
 * Transform JMAP mailbox rights to MailboxRights DTO.
 * @param rights JMAP rights object
 * @returns MailboxRights or undefined
 */
function transformRights(rights: JMAPMailboxRights | undefined): MailboxRights | undefined {
  if (!rights) {
    return undefined;
  }
  return {
    mayReadItems: rights.mayReadItems,
    mayAddItems: rights.mayAddItems,
    mayRemoveItems: rights.mayRemoveItems,
    maySetSeen: rights.maySetSeen,
    maySetKeywords: rights.maySetKeywords,
    mayCreateChild: rights.mayCreateChild,
    mayRename: rights.mayRename,
    mayDelete: rights.mayDelete,
    maySubmit: rights.maySubmit,
  };
}

/**
 * Transform a JMAP Mailbox object to SimplifiedMailbox DTO.
 * Straightforward property mapping with type safety.
 *
 * @param jmapMailbox JMAP Mailbox object
 * @returns SimplifiedMailbox DTO
 */
export function transformMailbox(jmapMailbox: JMAPMailbox): SimplifiedMailbox {
  const result: SimplifiedMailbox = {
    // Core identifiers
    id: jmapMailbox.id,
    name: jmapMailbox.name,
    role: castRole(jmapMailbox.role),

    // Hierarchy
    parentId: jmapMailbox.parentId,
    sortOrder: jmapMailbox.sortOrder,

    // Email counts
    totalEmails: jmapMailbox.totalEmails,
    unreadEmails: jmapMailbox.unreadEmails,
  };

  // Add optional fields only if present
  if (jmapMailbox.totalThreads !== undefined) {
    result.totalThreads = jmapMailbox.totalThreads;
  }
  if (jmapMailbox.unreadThreads !== undefined) {
    result.unreadThreads = jmapMailbox.unreadThreads;
  }
  if (jmapMailbox.myRights !== undefined) {
    result.myRights = transformRights(jmapMailbox.myRights);
  }
  if (jmapMailbox.isSubscribed !== undefined) {
    result.isSubscribed = jmapMailbox.isSubscribed;
  }

  return result;
}
