/**
 * Draft body builder: produces a multipart/alternative (text/plain + text/html)
 * JMAP body for create_draft, with the configured signature appended to both parts.
 */
import type { SignatureContent } from '../../signature/index.js';

export interface DraftBodyInput {
  body?: string;
  htmlBody?: string;
  signature?: SignatureContent;
  includeSignature?: boolean;
  /** The quoted original of a reply, placed after the signature. */
  quote?: { text: string; html: string };
}

export interface DraftBody {
  textBody: Array<{ partId: string; type: string }>;
  htmlBody: Array<{ partId: string; type: string }>;
  bodyValues: Record<string, { value: string }>;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text to simple HTML: blank lines split paragraphs, single newlines become <br>. */
export function textToHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  return normalized
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>\n')}</p>`)
    .join('\n');
}

/** Rough HTML to text, used only when the caller gives htmlBody without body. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildDraftBody({
  body,
  htmlBody,
  signature,
  includeSignature = true,
  quote,
}: DraftBodyInput): DraftBody {
  let text = body ?? (htmlBody ? htmlToText(htmlBody) : '');
  let html = htmlBody ?? textToHtml(body ?? '');

  if (includeSignature && signature) {
    text = `${text}\n\n-- \n${signature.text}`;
    html =
      `${html}\n<br>\n<div class="signature" style="color:#555555">-- <br>\n${signature.html}</div>`;
  }

  if (quote) {
    text = `${text}\n\n${quote.text}`;
    html = `${html}\n<br>\n${quote.html}`;
  }

  return {
    textBody: [{ partId: 'text', type: 'text/plain' }],
    htmlBody: [{ partId: 'html', type: 'text/html' }],
    bodyValues: {
      text: { value: text },
      html: { value: `<!DOCTYPE html><html><body>\n${html}\n</body></html>` },
    },
  };
}
