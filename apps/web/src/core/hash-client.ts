import { Sha256Hasher, type IncrementalHasher } from '@landrop/transfer-core';
import { log } from './log.ts';

/**
 * IncrementalHasher that runs SHA-256 in a shared Worker. `update()` transfers
 * the chunk's buffer to the worker (zero-copy; the caller must not reuse it)
 * and only returns a promise when too many chunks are outstanding, which bounds
 * memory held in the worker's message queue.
 */

/** Max bytes posted to the worker but not yet hashed, per hasher. */
const MAX_OUTSTANDING_BYTES = 4 * 1024 * 1024;

type Out =
  | { op: 'ack'; id: number; seq: number }
  | { op: 'digest'; id: number; seq: number; hex: string }
  | { op: 'error'; id: number; seq: number; message: string };

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const clients = new Map<number, WorkerHasher>();

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('./hash-worker.ts', import.meta.url), { type: 'module', name: 'landrop-hash' });
    worker.onmessage = (ev: MessageEvent<Out>) => clients.get(ev.data.id)?.onMessage(ev.data);
    worker.onerror = () => {
      log.error('hash worker crashed');
      for (const c of clients.values()) c.onMessage({ op: 'error', id: 0, seq: -1, message: 'worker crashed' });
    };
  } catch {
    workerFailed = true;
    log.warn('hash worker unavailable; hashing on the main thread');
  }
  return worker;
}

class WorkerHasher implements IncrementalHasher {
  private readonly id = nextId++;
  private seq = 0;
  private outstanding = 0;
  private readonly sizes = new Map<number, number>();
  private failed: Error | null = null;
  private drainWaiters: Array<() => void> = [];
  private digestResolve: ((hex: string) => void) | null = null;
  private digestReject: ((e: Error) => void) | null = null;
  private readonly w: Worker;

  constructor(w: Worker) {
    this.w = w;
    clients.set(this.id, this);
  }

  onMessage(m: Out): void {
    if (m.op === 'ack') {
      this.outstanding -= this.sizes.get(m.seq) ?? 0;
      this.sizes.delete(m.seq);
      if (this.outstanding < MAX_OUTSTANDING_BYTES) {
        const w = this.drainWaiters;
        this.drainWaiters = [];
        for (const f of w) f();
      }
    } else if (m.op === 'digest') {
      this.digestResolve?.(m.hex);
      clients.delete(this.id);
    } else {
      this.failed = new Error(m.message);
      this.digestReject?.(this.failed);
      for (const f of this.drainWaiters) f();
      this.drainWaiters = [];
    }
  }

  update(data: Uint8Array): void | Promise<void> {
    if (this.failed) throw this.failed;
    const seq = ++this.seq;
    const buf = data.buffer as ArrayBuffer;
    this.sizes.set(seq, data.byteLength);
    this.outstanding += data.byteLength;
    this.w.postMessage({ op: 'update', id: this.id, seq, buf, offset: data.byteOffset, length: data.byteLength }, [buf]);
    if (this.outstanding >= MAX_OUTSTANDING_BYTES) {
      return new Promise<void>((resolve) => this.drainWaiters.push(resolve)).then(() => {
        if (this.failed) throw this.failed;
      });
    }
  }

  digest(): Promise<string> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise<string>((resolve, reject) => {
      this.digestResolve = resolve;
      this.digestReject = reject;
      this.w.postMessage({ op: 'digest', id: this.id, seq: ++this.seq });
    });
  }

  dispose(): void {
    if (!clients.has(this.id)) return;
    clients.delete(this.id);
    this.w.postMessage({ op: 'dispose', id: this.id });
  }
}

export function createHasher(): IncrementalHasher {
  const w = getWorker();
  return w ? new WorkerHasher(w) : new Sha256Hasher();
}
