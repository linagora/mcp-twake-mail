import { describe, expect, it } from 'vitest';
import { bodyInner, buildQuote } from './quote.js';

const o = {
  from: [{ name: 'Bob DURAND', email: 'bob@x' }],
  sentAt: '2026-10-30T13:02:00Z',
  text: 'Peux-tu valider ?\n> plus ancien',
  html: '<!DOCTYPE html><html><head><style>p{}</style></head><body><p>Peux-tu valider ?</p><script>x()</script></body></html>',
};

describe('buildQuote', () => {
  it('writes the attribution line in French, in the user time zone', () => {
    expect(buildQuote(o, { language: 'fr', timeZone: 'Europe/Paris' }).text.split('\n')[0]).toBe('Le 30/10/2026 à 14:02, Bob DURAND <bob@x> a écrit :');
  });

  it('writes it in English otherwise', () => {
    expect(buildQuote(o, { language: 'en', timeZone: 'UTC' }).text.split('\n')[0]).toBe('On 2026-10-30 13:02, Bob DURAND <bob@x> wrote:');
  });

  it('prefixes every text line, nesting earlier quotes', () => {
    expect(buildQuote(o, { language: 'en', timeZone: 'UTC' }).text.split('\n').slice(1)).toEqual(['> Peux-tu valider ?', '>> plus ancien']);
  });

  it('quotes the HTML body inside a blockquote, without scripts or styles', () => {
    const { html } = buildQuote(o, { language: 'en', timeZone: 'UTC' });
    expect(html).toMatch(/^<div class="quote">/);
    expect(html).toContain('<blockquote type="cite"');
    expect(html).toContain('<p>Peux-tu valider ?</p>');
    expect(html).not.toMatch(/script|<style/);
  });

  it('falls back to the text, then to the attribution line alone', () => {
    expect(buildQuote({ ...o, html: undefined }, { language: 'en' }).html).toContain('Peux-tu valider ?');
    const empty = buildQuote({ from: o.from }, { language: 'en' });
    expect(empty.text).toBe('Bob DURAND <bob@x> wrote:');
    expect(empty.html).toBe('<div class="quote"><p>Bob DURAND &lt;bob@x&gt; wrote:</p></div>');
  });

  it('quotes the text of an HTML-only original', () => {
    expect(buildQuote({ ...o, text: undefined }, { language: 'en', timeZone: 'UTC' }).text.split('\n').slice(1)).toEqual(['> Peux-tu valider ?']);
  });
});

describe('bodyInner', () => {
  it('keeps a fragment as it is', () => {
    expect(bodyInner('<p>a</p>')).toBe('<p>a</p>');
  });
});
