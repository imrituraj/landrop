/**
 * Splits plain text into text and link segments. Only http: and https: URLs that
 * parse with the WHATWG URL parser become links; everything else stays text.
 * Rendering code must output segments as text nodes / <a href> — never as HTML.
 */

export type TextSegment = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const CANDIDATE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;
const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

export function safeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
    // Reject credentials in links ("https://bank.example@evil.example/").
    if (url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

export function linkify(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    let raw = match[0];
    const start = match.index;
    const trail = TRAILING_PUNCT.exec(raw);
    if (trail) raw = raw.slice(0, raw.length - trail[0].length);
    const href = safeHref(raw);
    if (!href) continue;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'link', text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}
