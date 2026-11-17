/**
 * Tests for email transformer - converts JMAP Email objects to SimplifiedEmail DTOs.
 * TDD RED phase: These tests define the expected behavior.
 */
import { describe, it, expect } from 'vitest';
import { transformEmail } from '../email.js';

describe('transformEmail', () => {
  describe('keyword mapping', () => {
    it('converts $seen keyword to isRead: true', () => {
      const jmapEmail = {
        id: 'e1',
        blobId: 'blob1',
        threadId: 'thread1',
        mailboxIds: { 'inbox': true },
        keywords: { '$seen': true },
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'Test Subject',
        from: [{ name: 'Sender', email: 'sender@example.com' }],
        to: [{ name: 'Recipient', email: 'recipient@example.com' }],
      };

      const result = transformEmail(jmapEmail);

      expect(result.id).toBe('e1');
      expect(result.isRead).toBe(true);
      expect(result.isFlagged).toBe(false);
      expect(result.isDraft).toBe(false);
    });

    it('converts $flagged keyword to isFlagged: true', () => {
      const jmapEmail = {
        id: 'e2',
        blobId: 'blob2',
        threadId: 'thread2',
        mailboxIds: { 'inbox': true },
        keywords: { '$flagged': true },
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'Flagged Email',
        from: [{ name: 'Sender', email: 'sender@example.com' }],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.isFlagged).toBe(true);
      expect(result.isRead).toBe(false);
      expect(result.isDraft).toBe(false);
    });

    it('converts $draft keyword to isDraft: true', () => {
      const jmapEmail = {
        id: 'e3',
        blobId: 'blob3',
        threadId: 'thread3',
        mailboxIds: { 'drafts': true },
        keywords: { '$draft': true },
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'Draft Email',
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.isDraft).toBe(true);
      expect(result.isRead).toBe(false);
      expect(result.isFlagged).toBe(false);
    });

    it('converts $answered keyword to isAnswered: true', () => {
      const jmapEmail = {
        id: 'e4',
        blobId: 'blob4',
        threadId: 'thread4',
        mailboxIds: { 'inbox': true },
        keywords: { '$answered': true },
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'Answered Email',
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.isAnswered).toBe(true);
    });

    it('converts $forwarded keyword to isForwarded: true', () => {
      const jmapEmail = {
        id: 'e5',
        blobId: 'blob5',
        threadId: 'thread5',
        mailboxIds: { 'inbox': true },
        keywords: { '$forwarded': true },
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'Forwarded Email',
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.isForwarded).toBe(true);
    });

    it('handles multiple keywords', () => {
      const jmapEmail = {
        id: 'e6',
        blobId: 'blob6',
        threadId: 'thread6',
        mailboxIds: { 'inbox': true },
        keywords: { '$seen': true, '$flagged': true, '$answered': true },
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'Multi-keyword Email',
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.isRead).toBe(true);
      expect(result.isFlagged).toBe(true);
      expect(result.isAnswered).toBe(true);
      expect(result.isDraft).toBe(false);
      expect(result.isForwarded).toBe(false);
    });

    it('handles empty keywords object', () => {
      const jmapEmail = {
        id: 'e7',
        blobId: 'blob7',
        threadId: 'thread7',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'No Keywords',
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.isRead).toBe(false);
      expect(result.isFlagged).toBe(false);
      expect(result.isDraft).toBe(false);
      expect(result.isAnswered).toBe(false);
      expect(result.isForwarded).toBe(false);
    });

    it('handles missing keywords (undefined/null)', () => {
      const jmapEmail = {
        id: 'e8',
        blobId: 'blob8',
        threadId: 'thread8',
        mailboxIds: { 'inbox': true },
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'No Keywords Field',
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.isRead).toBe(false);
      expect(result.isFlagged).toBe(false);
      expect(result.isDraft).toBe(false);
      expect(result.isAnswered).toBe(false);
      expect(result.isForwarded).toBe(false);
    });
  });

  describe('mailboxIds conversion', () => {
    it('converts mailboxIds object to string array', () => {
      const jmapEmail = {
        id: 'e9',
        blobId: 'blob9',
        threadId: 'thread9',
        mailboxIds: { 'mb1': true, 'mb2': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'Multi-mailbox',
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.mailboxIds).toHaveLength(2);
      expect(result.mailboxIds).toContain('mb1');
      expect(result.mailboxIds).toContain('mb2');
    });

    it('filters out false mailbox associations', () => {
      const jmapEmail = {
        id: 'e10',
        blobId: 'blob10',
        threadId: 'thread10',
        mailboxIds: { 'mb1': true, 'mb2': false, 'mb3': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'Mixed mailboxIds',
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.mailboxIds).toHaveLength(2);
      expect(result.mailboxIds).toContain('mb1');
      expect(result.mailboxIds).toContain('mb3');
      expect(result.mailboxIds).not.toContain('mb2');
    });

    it('handles empty mailboxIds', () => {
      const jmapEmail = {
        id: 'e11',
        blobId: 'blob11',
        threadId: 'thread11',
        mailboxIds: {},
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'No Mailboxes',
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.mailboxIds).toEqual([]);
    });
  });

  describe('address fields', () => {
    it('preserves from addresses', () => {
      const jmapEmail = {
        id: 'e12',
        blobId: 'blob12',
        threadId: 'thread12',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'From Test',
        from: [
          { name: 'John Doe', email: 'john@example.com' },
          { name: 'Jane Doe', email: 'jane@example.com' },
        ],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.from).toHaveLength(2);
      expect(result.from[0]).toEqual({ name: 'John Doe', email: 'john@example.com' });
      expect(result.from[1]).toEqual({ name: 'Jane Doe', email: 'jane@example.com' });
    });

    it('preserves to addresses', () => {
      const jmapEmail = {
        id: 'e13',
        blobId: 'blob13',
        threadId: 'thread13',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'To Test',
        from: [],
        to: [
          { name: 'Recipient One', email: 'one@example.com' },
          { name: 'Recipient Two', email: 'two@example.com' },
        ],
      };

      const result = transformEmail(jmapEmail);

      expect(result.to).toHaveLength(2);
      expect(result.to[0]).toEqual({ name: 'Recipient One', email: 'one@example.com' });
    });

    it('preserves cc addresses', () => {
      const jmapEmail = {
        id: 'e14',
        blobId: 'blob14',
        threadId: 'thread14',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'CC Test',
        from: [],
        to: [],
        cc: [{ name: 'CC User', email: 'cc@example.com' }],
      };

      const result = transformEmail(jmapEmail);

      expect(result.cc).toHaveLength(1);
      expect(result.cc![0]).toEqual({ name: 'CC User', email: 'cc@example.com' });
    });

    it('preserves bcc addresses', () => {
      const jmapEmail = {
        id: 'e15',
        blobId: 'blob15',
        threadId: 'thread15',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'BCC Test',
        from: [],
        to: [],
        bcc: [{ name: 'BCC User', email: 'bcc@example.com' }],
      };

      const result = transformEmail(jmapEmail);

      expect(result.bcc).toHaveLength(1);
      expect(result.bcc![0]).toEqual({ name: 'BCC User', email: 'bcc@example.com' });
    });

    it('handles null name in address', () => {
      const jmapEmail = {
        id: 'e16',
        blobId: 'blob16',
        threadId: 'thread16',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'Null Name',
        from: [{ name: null, email: 'noname@example.com' }],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.from[0].name).toBeNull();
      expect(result.from[0].email).toBe('noname@example.com');
    });
  });

  describe('core fields', () => {
    it('preserves all core email fields', () => {
      const jmapEmail = {
        id: 'email-123',
        blobId: 'blob-456',
        threadId: 'thread-789',
        mailboxIds: { 'inbox': true },
        keywords: { '$seen': true },
        receivedAt: '2026-01-29T15:30:00Z',
        subject: 'Important Message',
        from: [{ name: 'Sender', email: 'sender@example.com' }],
        to: [{ name: 'Recipient', email: 'recipient@example.com' }],
        preview: 'This is a preview of the email content...',
        hasAttachment: true,
        size: 12345,
      };

      const result = transformEmail(jmapEmail);

      expect(result.id).toBe('email-123');
      expect(result.blobId).toBe('blob-456');
      expect(result.threadId).toBe('thread-789');
      expect(result.receivedAt).toBe('2026-01-29T15:30:00Z');
      expect(result.subject).toBe('Important Message');
      expect(result.preview).toBe('This is a preview of the email content...');
      expect(result.hasAttachment).toBe(true);
      expect(result.size).toBe(12345);
    });

    it('handles missing optional fields', () => {
      const jmapEmail = {
        id: 'e17',
        blobId: 'blob17',
        threadId: 'thread17',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'Minimal Email',
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.id).toBe('e17');
      expect(result.preview).toBeUndefined();
      expect(result.hasAttachment).toBeUndefined();
      expect(result.size).toBeUndefined();
      expect(result.cc).toBeUndefined();
      expect(result.bcc).toBeUndefined();
      expect(result.replyTo).toBeUndefined();
    });

    it('handles null subject', () => {
      const jmapEmail = {
        id: 'e18',
        blobId: 'blob18',
        threadId: 'thread18',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: null,
        from: [],
        to: [],
      };

      const result = transformEmail(jmapEmail);

      expect(result.subject).toBeNull();
    });
  });

  describe('body content', () => {
    it('includes textBody when present', () => {
      const jmapEmail = {
        id: 'e19',
        blobId: 'blob19',
        threadId: 'thread19',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'With Text Body',
        from: [],
        to: [],
        textBody: [{ partId: 'part1', type: 'text/plain' }],
        bodyValues: {
          'part1': { value: 'Plain text content', isEncodingProblem: false, isTruncated: false },
        },
      };

      const result = transformEmail(jmapEmail);

      expect(result.textBody).toBe('Plain text content');
    });

    it('includes htmlBody when present', () => {
      const jmapEmail = {
        id: 'e20',
        blobId: 'blob20',
        threadId: 'thread20',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'With HTML Body',
        from: [],
        to: [],
        htmlBody: [{ partId: 'htmlPart', type: 'text/html' }],
        bodyValues: {
          'htmlPart': { value: '<p>HTML content</p>', isEncodingProblem: false, isTruncated: false },
        },
      };

      const result = transformEmail(jmapEmail);

      expect(result.htmlBody).toBe('<p>HTML content</p>');
    });
  });

  describe('attachments', () => {
    it('transforms attachments array', () => {
      const jmapEmail = {
        id: 'e21',
        blobId: 'blob21',
        threadId: 'thread21',
        mailboxIds: { 'inbox': true },
        keywords: {},
        receivedAt: '2026-01-29T10:00:00Z',
        subject: 'With Attachments',
        from: [],
        to: [],
        attachments: [
          {
            blobId: 'att-blob1',
            type: 'application/pdf',
            name: 'document.pdf',
            size: 1024,
          },
          {
            blobId: 'att-blob2',
            type: 'image/png',
            name: 'image.png',
            size: 2048,
          },
        ],
      };

      const result = transformEmail(jmapEmail);

      expect(result.attachments).toHaveLength(2);
      expect(result.attachments![0]).toEqual({
        blobId: 'att-blob1',
        type: 'application/pdf',
        name: 'document.pdf',
        size: 1024,
      });
      expect(result.attachments![1]).toEqual({
        blobId: 'att-blob2',
        type: 'image/png',
        name: 'image.png',
        size: 2048,
      });
    });
  });

  describe('threading', () => {
    const base = {
      id: 'e9',
      blobId: 'blob9',
      threadId: 'thread9',
      mailboxIds: { inbox: true },
      receivedAt: '2026-01-29T10:00:00Z',
      subject: 'Budget',
      from: [{ name: 'Sender', email: 'sender@example.com' }],
      to: [{ name: 'Recipient', email: 'recipient@example.com' }],
    };

    it('exposes the Message-ID and the threading headers', () => {
      const out = transformEmail({ ...base, messageId: ['m2@x'], inReplyTo: ['m1@x'], references: ['m0@x', 'm1@x'] });
      expect(out.messageId).toBe('m2@x');
      expect(out.inReplyTo).toEqual(['m1@x']);
      expect(out.references).toEqual(['m0@x', 'm1@x']);
    });

    it('leaves threading fields out when the server gives none', () => {
      const out = transformEmail({ ...base, messageId: null, references: [] });
      expect(out).not.toHaveProperty('messageId');
      expect(out).not.toHaveProperty('inReplyTo');
      expect(out).not.toHaveProperty('references');
    });
  });
});
