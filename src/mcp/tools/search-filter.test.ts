import { describe, expect, it } from 'vitest';
import { buildSearchFilter, utcDate } from './search-filter.js';

describe('utcDate', () => {
  it('turns a day, a time with an offset or with milliseconds into a UTCDate', () => {
    expect(utcDate('2026-11-10', 'after')).toBe('2026-11-10T00:00:00Z');
    expect(utcDate('2026-11-10T13:00:00+01:00', 'after')).toBe('2026-11-10T12:00:00Z');
    expect(utcDate('2026-11-10T13:00:00.250Z', 'before')).toBe('2026-11-10T13:00:00Z');
  });

  it('rejects what it cannot read, naming the field and the expected form', () => {
    expect(() => utcDate('mardi', 'after')).toThrow(/after: "mardi" is not a date.*2026-11-10/);
  });
});

describe('buildSearchFilter', () => {
  const anyOf = (who: string) => ({ operator: 'OR', conditions: [{ from: who }, { to: who }, { cc: who }, { bcc: who }] });

  it('matches a participant in from, to, cc or bcc', () => {
    expect(buildSearchFilter({ participant: 'dordogne.fr' })).toEqual(anyOf('dordogne.fr'));
  });

  it('ANDs the participant with the other conditions', () => {
    expect(buildSearchFilter({ participant: 'x.fr', after: '2026-11-10', unreadOnly: true })).toEqual({
      operator: 'AND',
      conditions: [{ after: '2026-11-10T00:00:00Z', notKeyword: '$seen' }, anyOf('x.fr')],
    });
  });

  it('keeps the plain conditions as before, with cc and bcc', () => {
    expect(buildSearchFilter({ from: 'bob', cc: 'chloe', bcc: 'dan', flagged: true, mailboxId: 'mb1' })).toEqual({
      inMailbox: 'mb1',
      from: 'bob',
      cc: 'chloe',
      bcc: 'dan',
      hasKeyword: '$flagged',
    });
    expect(buildSearchFilter({})).toBeUndefined();
    expect(buildSearchFilter({ participant: '  ' })).toBeUndefined();
  });
});
