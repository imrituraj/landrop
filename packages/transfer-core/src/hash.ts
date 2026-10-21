import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@landrop/shared';

/**
 * Incremental hashing. We never hash a whole file in one call: data is fed in
 * chunk order as it is read (sender) or written (receiver). The web app runs
 * this in a Worker (see apps/web/src/core/hash-worker.ts) to keep the main
 * thread responsive; the synchronous version here is used in tests and as a
 * fallback.
 *
 * Implementation: @noble/hashes (audited, maintained, pure JS). Web Crypto's
 * `digest()` is one-shot and would require the whole file in memory.
 */
export interface IncrementalHasher {
  /** Feed the next bytes, in order. May return a promise to apply backpressure. */
  update(data: Uint8Array): void | Promise<void>;
  /** Lowercase hex SHA-256 of everything fed so far. Call once. */
  digest(): Promise<string>;
  dispose?(): void;
}

export class Sha256Hasher implements IncrementalHasher {
  private readonly h = sha256.create();

  update(data: Uint8Array): void {
    this.h.update(data);
  }

  digest(): Promise<string> {
    return Promise.resolve(bytesToHex(this.h.digest()));
  }
}

export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}
