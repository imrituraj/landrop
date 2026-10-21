import { describe, expect, it } from 'vitest';
import {
  BoundedSet,
  KeyedRateLimiter,
  TokenBucket,
  formatBytes,
  linkify,
  normalizeShortCode,
  pushBounded,
  randomId,
  randomSecret,
  randomShortCode,
  safeHref,
  sanitizeFilename,
  withCollisionSuffix,
} from '../src/index.ts';

describe('filename sanitization', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\Windows\\System32\\cmd.exe', 'cmd.exe'],
    ['/absolute/path/report.pdf', 'report.pdf'],
    ['C:\\Users\\me\\a.txt', 'a.txt'],
    ['..', 'download'],
    ['.', 'download'],
    ['', 'download'],
    ['   ', 'download'],
    ['.bashrc', 'bashrc'],
    ['photo.jpg.   ', 'photo.jpg'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['com1', '_com1'],
    ['a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['evil\u202Egpj.exe', 'evilgpj.exe'],
    ['tab\there\n.txt', 'tabhere.txt'],
    ['zero\u200Bwidth.txt', 'zerowidth.txt'],
    ['résumé.pdf', 'résumé.pdf'],
    ['日本語のファイル.txt', '日本語のファイル.txt'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('bounds length and keeps a short extension', () => {
    const out = sanitizeFilename(`${'a'.repeat(500)}.tar.gz`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('.gz')).toBe(true);
  });

  it('does not split surrogate pairs when truncating', () => {
    const out = sanitizeFilename('😀'.repeat(300));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it('adds collision suffixes before the extension', () => {
    expect(withCollisionSuffix('a.txt', 1)).toBe('a (1).txt');
    expect(withCollisionSuffix('noext', 2)).toBe('noext (2)');
  });
});

describe('safe links', () => {
  it('only allows http(s) URLs without credentials', () => {
    expect(safeHref('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(safeHref('https://bank.example@evil.example/')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });

  it('splits text into text and link segments without HTML interpretation', () => {
    const segs = linkify('see https://example.com/x). and <b>http://a.b</b> javascript:alert(1)');
    expect(segs).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://example.com/x', href: 'https://example.com/x' },
      { kind: 'text', text: '). and <b>' },
      { kind: 'link', text: 'http://a.b', href: 'http://a.b/' },
      { kind: 'text', text: '</b> javascript:alert(1)' },
    ]);
  });

  it('handles text without links', () => {
    expect(linkify('hello')).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(linkify('')).toEqual([]);
  });
});

describe('identifiers', () => {
  it('produces well-formed random ids, secrets, and codes', () => {
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomShortCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Set(Array.from({ length: 1000 }, randomId)).size).toBe(1000);
  });

  it('normalizes user-typed codes', () => {
    expect(normalizeShortCode('7kq2 m9xd')).toBe('7KQ2-M9XD');
    expect(normalizeShortCode('7KQ2M9XD')).toBe('7KQ2-M9XD');
    expect(normalizeShortCode('OIL0-0000')).toBe('0110-0000');
    expect(normalizeShortCode('7KQ2-M9X')).toBeNull();
    expect(normalizeShortCode('7KQ2-M9XU')).toBeNull();
  });
});

describe('rate limiting', () => {
  it('token bucket refills over time', () => {
    let now = 0;
    const b = new TokenBucket(2, 1, () => now);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    now = 1000;
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });

  it('keyed limiter caps tracked keys and evicts idle ones', () => {
    let now = 0;
    const l = new KeyedRateLimiter(1, 1, 2, () => now);
    expect(l.tryTake('a')).toBe(true);
    expect(l.tryTake('b')).toBe(true);
    expect(l.tryTake('c')).toBe(false); // full, nothing idle
    now = 5000;
    expect(l.tryTake('c')).toBe(true); // idle keys evicted
    expect(l.size).toBeLessThanOrEqual(2);
  });
});

describe('bounded collections', () => {
  it('BoundedSet forgets the oldest entries', () => {
    const s = new BoundedSet<number>(2);
    expect(s.add(1)).toBe(true);
    expect(s.add(1)).toBe(false);
    s.add(2);
    s.add(3);
    expect(s.has(1)).toBe(false);
    expect(s.has(3)).toBe(true);
  });

  it('pushBounded keeps the newest items', () => {
    expect(pushBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });
});

describe('formatting', () => {
  it('formats bytes with SI units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1500)).toBe('1.50 KB');
    expect(formatBytes(10_000_000_000)).toBe('10.0 GB');
  });
});
