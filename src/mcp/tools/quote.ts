/**
 * The quoted original below a reply: the attribution line ("On …, X wrote:"), then the original
 * text with "> " lines (RFC 3676) and its HTML in a blockquote.
 */
import { escapeHtml, htmlToText, textToHtml } from './draft-body.js';
import { formatAddress, type Original } from './reply.js';

export interface QuoteSource extends Original {
  text?: string;
  html?: string;
}

function when(iso: string | null | undefined, language: 'en' | 'fr', timeZone?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return language === 'fr' ? `Le ${p.day}/${p.month}/${p.year} à ${p.hour}:${p.minute}` : `On ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function attribution(o: QuoteSource, language: 'en' | 'fr', timeZone?: string): string {
  const who = o.from?.[0] ? formatAddress(o.from[0]) : language === 'fr' ? 'Votre correspondant' : 'Your correspondent';
  const date = when(o.sentAt ?? o.receivedAt, language, timeZone);
  const verb = language === 'fr' ? 'a écrit :' : 'wrote:';
  return date ? `${date}, ${who} ${verb}` : `${who} ${verb}`;
}

/** The inside of <body> (or the fragment itself), without scripts or styles. */
export function bodyInner(html: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return (m ? m[1] : html).replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '').trim();
}

export function buildQuote(o: QuoteSource, opts: { language: 'en' | 'fr'; timeZone?: string }): { text: string; html: string } {
  const header = attribution(o, opts.language, opts.timeZone);
  const source = (o.text ?? (o.html ? htmlToText(bodyInner(o.html)) : '')).replace(/\r\n/g, '\n').trimEnd();
  const lines = source ? source.split('\n').map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`)) : [];
  const inner = o.html ? bodyInner(o.html) : textToHtml(o.text ?? '');
  const quoted = inner
    ? `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`
    : '';
  return { text: [header, ...lines].join('\n'), html: `<div class="quote"><p>${escapeHtml(header)}</p>${quoted}</div>` };
}
