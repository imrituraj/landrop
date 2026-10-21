/**
 * Download filename sanitization.
 *
 * Received names are attacker-controlled. We never use them as paths: the result
 * is a single base name safe to pass to `showSaveFilePicker({ suggestedName })`,
 * `FileSystemDirectoryHandle.getFileHandle()`, or `<a download>`.
 */

const MAX_NAME_UTF16 = 200;
const FALLBACK = 'download';

// Windows reserved device names (case-insensitive, with or without extension).
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// C0/C1 controls, DEL, and Unicode bidi/format controls that can disguise extensions
// (e.g. U+202E RIGHT-TO-LEFT OVERRIDE turning "gpj.exe" into "exe.jpg").
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

// Characters invalid on Windows and/or meaningful to shells / path parsers.
const RESERVED_CHARS = /[<>:"/\\|?*]/g;

export function sanitizeFilename(raw: string): string {
  let name = raw.normalize('NFC');

  // Take only the last path segment for either separator style.
  const lastSep = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (lastSep >= 0) name = name.slice(lastSep + 1);

  name = name.replace(CONTROL, '').replace(RESERVED_CHARS, '_');

  // No leading dots (hidden files, "." and ".."), no trailing dots/spaces (Windows).
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  if (RESERVED.test(name)) name = `_${name}`;

  if (name.length > MAX_NAME_UTF16) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = truncateCodePoints(name.slice(0, name.length - ext.length), MAX_NAME_UTF16 - ext.length) + ext;
  }

  return name.length > 0 ? name : FALLBACK;
}

function truncateCodePoints(s: string, maxUtf16: number): string {
  let out = '';
  for (const cp of s) {
    if (out.length + cp.length > maxUtf16) break;
    out += cp;
  }
  return out;
}

/** "report.pdf", 1 → "report (1).pdf" */
export function withCollisionSuffix(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0) return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
  return `${name} (${n})`;
}
