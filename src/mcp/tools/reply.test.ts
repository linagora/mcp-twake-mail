import { describe, expect, it } from 'vitest';
import { describeOriginal, replySubject, threadingHeaders } from './reply.js';

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
});
