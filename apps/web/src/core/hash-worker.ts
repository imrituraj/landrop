/// <reference lib="webworker" />
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Incremental SHA-256 off the main thread. Holds one hash state per transfer.
 * Messages are processed in order, so updates for a given id are hashed in
 * the order they were posted.
 */

type In =
  | { op: 'update'; id: number; seq: number; buf: ArrayBuffer; offset: number; length: number }
  | { op: 'digest'; id: number; seq: number }
  | { op: 'dispose'; id: number };

const states = new Map<number, ReturnType<typeof sha256.create>>();
const scope = self as unknown as DedicatedWorkerGlobalScope;

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

scope.onmessage = (ev: MessageEvent<In>) => {
  const m = ev.data;
  try {
    if (m.op === 'update') {
      let h = states.get(m.id);
      if (!h) {
        h = sha256.create();
        states.set(m.id, h);
      }
      h.update(new Uint8Array(m.buf, m.offset, m.length));
      scope.postMessage({ op: 'ack', id: m.id, seq: m.seq });
    } else if (m.op === 'digest') {
      const h = states.get(m.id) ?? sha256.create();
      states.delete(m.id);
      scope.postMessage({ op: 'digest', id: m.id, seq: m.seq, hex: hex(h.digest()) });
    } else {
      states.delete(m.id);
    }
  } catch (err) {
    scope.postMessage({ op: 'error', id: m.id, seq: 'seq' in m ? m.seq : -1, message: String(err) });
  }
};
