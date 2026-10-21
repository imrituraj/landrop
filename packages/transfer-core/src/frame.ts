import { bytesToHex, hexToBytes } from '@landrop/shared';

/**
 * Binary data frame (big-endian / network byte order):
 *
 *   offset size field
 *   0      1    version        = 1
 *   1      1    frame type     = 1 (DATA)
 *   2      2    reserved       = 0
 *   4      16   transfer id    (128-bit, same as the hex id in control messages)
 *   20     4    attempt        (u32, connection attempt the frame belongs to)
 *   24     8    byte offset    (u64, must be <= 2^53 - 1)
 *   32     4    payload length (u32, must equal message length - 36)
 *   36     n    payload
 *
 * Total frame size = 36 + payload, which must not exceed the peer's SCTP
 * maxMessageSize; the sender sizes chunks accordingly.
 */

export const FRAME_VERSION = 1;
export const FRAME_TYPE_DATA = 1;
export const FRAME_HEADER_BYTES = 36;

export interface DataFrame {
  transferId: string;
  attempt: number;
  offset: number;
  /** View into the received buffer (no copy). */
  payload: Uint8Array;
}

export type DecodeResult = { ok: true; frame: DataFrame } | { ok: false; reason: string };

const MAX_SAFE_HI = 2 ** 21; // high 32 bits of a value <= 2^53 - 1 are < 2^21

export function encodeDataFrame(transferIdBytes: Uint8Array, attempt: number, offset: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (transferIdBytes.length !== 16) throw new RangeError('transfer id must be 16 bytes');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a safe non-negative integer');
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 0xffffffff) throw new RangeError('bad attempt');
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_VERSION);
  view.setUint8(1, FRAME_TYPE_DATA);
  view.setUint16(2, 0);
  out.set(transferIdBytes, 4);
  view.setUint32(20, attempt);
  view.setUint32(24, Math.floor(offset / 2 ** 32));
  view.setUint32(28, offset >>> 0);
  view.setUint32(32, payload.byteLength);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Validates every header field before exposing the payload. `maxPayload` is the
 * negotiated chunk size; anything larger is rejected.
 */
export function decodeDataFrame(buf: ArrayBuffer, maxPayload: number): DecodeResult {
  if (buf.byteLength < FRAME_HEADER_BYTES) return { ok: false, reason: 'short frame' };
  const view = new DataView(buf);
  if (view.getUint8(0) !== FRAME_VERSION) return { ok: false, reason: 'unsupported frame version' };
  if (view.getUint8(1) !== FRAME_TYPE_DATA) return { ok: false, reason: 'unknown frame type' };
  if (view.getUint16(2) !== 0) return { ok: false, reason: 'reserved bits set' };
  const attempt = view.getUint32(20);
  if (attempt < 1) return { ok: false, reason: 'bad attempt' };
  const hi = view.getUint32(24);
  const lo = view.getUint32(28);
  if (hi >= MAX_SAFE_HI) return { ok: false, reason: 'offset out of safe range' };
  const offset = hi * 2 ** 32 + lo;
  const length = view.getUint32(32);
  if (length !== buf.byteLength - FRAME_HEADER_BYTES) return { ok: false, reason: 'length mismatch' };
  if (length === 0) return { ok: false, reason: 'empty payload' };
  if (length > maxPayload) return { ok: false, reason: 'payload exceeds negotiated chunk size' };
  if (!Number.isSafeInteger(offset + length)) return { ok: false, reason: 'end offset out of safe range' };
  return {
    ok: true,
    frame: {
      transferId: bytesToHex(new Uint8Array(buf, 4, 16)),
      attempt,
      offset,
      payload: new Uint8Array(buf, FRAME_HEADER_BYTES, length),
    },
  };
}

/** Reads only the transfer id (for routing) without validating the rest. */
export function peekTransferId(buf: ArrayBuffer): string | null {
  if (buf.byteLength < FRAME_HEADER_BYTES) return null;
  return bytesToHex(new Uint8Array(buf, 4, 16));
}

export function transferIdToBytes(id: string): Uint8Array {
  const b = hexToBytes(id);
  if (!b || b.length !== 16) throw new RangeError('transfer id must be 32 hex chars');
  return b;
}
