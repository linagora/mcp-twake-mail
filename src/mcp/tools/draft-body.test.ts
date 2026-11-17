import { describe, it, expect } from 'vitest';
import { buildDraftBody, textToHtml, htmlToText } from './draft-body.js';

const sig = { text: 'Jane DOE\nACME', html: '<p><strong>Jane DOE</strong><br>ACME</p>' };

describe('textToHtml', () => {
  it('splits paragraphs and keeps line breaks, escaping HTML', () => {
    expect(textToHtml('Bonjour,\n\nLigne 1\nLigne <2> & co')).toBe(
      '<p>Bonjour,</p>\n<p>Ligne 1<br>\nLigne &lt;2&gt; &amp; co</p>'
    );
  });
  it('returns empty string for empty input', () => {
    expect(textToHtml('  \n ')).toBe('');
  });
});

describe('htmlToText', () => {
  it('converts basic HTML to readable text', () => {
    expect(htmlToText('<p>Hello <b>you</b></p><p>A&amp;B<br>next</p>')).toBe('Hello you\n\nA&B\nnext');
  });
});

describe('buildDraftBody', () => {
  it('builds multipart text+html with signature on both parts', () => {
    const r = buildDraftBody({ body: 'Bonjour,\n\nMerci.', signature: sig });
    expect(r.textBody).toEqual([{ partId: 'text', type: 'text/plain' }]);
    expect(r.htmlBody).toEqual([{ partId: 'html', type: 'text/html' }]);
    expect(r.bodyValues.text.value).toBe('Bonjour,\n\nMerci.\n\n-- \nJane DOE\nACME');
    expect(r.bodyValues.html.value).toContain('<p>Bonjour,</p>');
    expect(r.bodyValues.html.value).toContain('<strong>Jane DOE</strong>');
    expect(r.bodyValues.html.value).toMatch(/^<!DOCTYPE html>/);
  });

  it('uses htmlBody as given and derives text from it', () => {
    const r = buildDraftBody({ htmlBody: '<p>Hi <em>there</em></p>', signature: sig });
    expect(r.bodyValues.html.value).toContain('<p>Hi <em>there</em></p>');
    expect(r.bodyValues.text.value.startsWith('Hi there')).toBe(true);
  });

  it('omits signature when includeSignature is false or no signature configured', () => {
    expect(buildDraftBody({ body: 'x', signature: sig, includeSignature: false }).bodyValues.text.value).toBe('x');
    expect(buildDraftBody({ body: 'x' }).bodyValues.html.value).not.toContain('signature');
  });

  it('puts the quote after the signature, inside the HTML body', () => {
    const b = buildDraftBody({
      body: 'OK',
      signature: { text: 'Alice', html: '<p>Alice</p>' },
      quote: { text: 'On …, Bob wrote:\n> Budget ?', html: '<div class="quote">Q</div>' },
    });
    expect(b.bodyValues.text.value).toBe('OK\n\n-- \nAlice\n\nOn …, Bob wrote:\n> Budget ?');
    const html = b.bodyValues.html.value;
    expect(html.indexOf('Alice')).toBeLessThan(html.indexOf('<div class="quote">'));
    expect(html.indexOf('<div class="quote">')).toBeLessThan(html.indexOf('</body>'));
  });
});
