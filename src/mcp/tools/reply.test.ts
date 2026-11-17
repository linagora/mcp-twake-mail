import { describe, expect, it } from 'vitest';
import { describeOriginal, replyRecipients, replySubject, threadingHeaders } from './reply.js';

describe('reply helpers', () => {
  it('threads a reply under the original and its references', () => {
    expect(threadingHeaders({ messageId: ['m2@x'], references: ['m0@x', 'm1@x'] })).toEqual({
      inReplyTo: ['m2@x'],
      references: ['m0@x', 'm1@x', 'm2@x'],
    });
    expect(threadingHeaders({})).toEqual({ inReplyTo: [], references: [] });
  });

  it('adds Re: once, whatever its case', () => {
    expect(replySubject('Budget')).toBe('Re: Budget');
    expect(replySubject('RE: Budget')).toBe('RE: Budget');
    expect(replySubject(null)).toBe('Re: ');
  });

  it('describes the original by sender and subject', () => {
    expect(describeOriginal({ from: [{ name: 'Bob DURAND', email: 'bob@x' }], subject: 'Budget' })).toBe('Bob DURAND <bob@x> · Budget');
    expect(describeOriginal({ from: [{ email: 'bob@x' }] })).toBe('bob@x');
  });

  it('answers Reply-To, else From; reply-all adds To and Cc without me or duplicates', () => {
    const o = {
      from: [{ email: 'bob@x' }],
      replyTo: [{ email: 'list@x' }],
      to: [{ email: 'me@x' }, { email: 'chloe@x' }, { email: 'LIST@x' }],
      cc: [{ email: 'ME@x' }, { email: 'dan@x' }],
    };
    expect(replyRecipients(o, 'me@x', false)).toEqual({ to: [{ email: 'list@x' }], cc: [] });
    expect(replyRecipients(o, 'me@x', true)).toEqual({ to: [{ email: 'list@x' }, { email: 'chloe@x' }], cc: [{ email: 'dan@x' }] });
    expect(replyRecipients({ from: [{ email: 'bob@x' }] }, undefined, false)).toEqual({ to: [{ email: 'bob@x' }], cc: [] });
    expect(replyRecipients({}, 'me@x', false)).toBeNull();
  });
});
