/**
 * Secure random identifiers. Uses `crypto.getRandomValues`, which exists in
 * browsers (including insecure contexts) and in Node.js >= 19 as a global.
 */

const HEX = '0123456789abcdef';

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += HEX[b >> 4]! + HEX[b & 15]!;
  return s;
}

/** Returns null if `hex` is not an even-length lowercase/uppercase hex string. */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 128-bit random identifier as 32 lowercase hex chars. */
export function randomId(): string {
  return bytesToHex(randomBytes(16));
}

/** base64url without padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 256-bit secret, base64url encoded (43 chars). */
export function randomSecret(): string {
  return bytesToBase64Url(randomBytes(32));
}

/** Crockford base32 alphabet: no I, L, O, U to avoid confusion. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Short human-enterable code, e.g. "7KQ2-M9XD" (8 symbols = 40 bits).
 * NOT a high-entropy secret: callers must rate-limit, expire, and require approval.
 */
export function randomShortCode(): string {
  const bytes = randomBytes(8);
  let s = '';
  // 256 is divisible by 32, so `b % 32` is unbiased.
  for (const b of bytes) s += CODE_ALPHABET[b % 32]!;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normalizes user input ("7kq2 m9xd", "7KQ2M9XD") to canonical "7KQ2-M9XD", or null. */
export function normalizeShortCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (cleaned.length !== 8) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}
