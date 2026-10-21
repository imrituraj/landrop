/**
 * Flow-control primitives.
 *
 * Two independent limits govern the sender:
 *   1. Local send queue: RTCDataChannel.bufferedAmount must stay below a
 *      high-water mark. This bounds *local* memory only; it says nothing about
 *      what the receiver has written.
 *   2. Receiver credit: bytes sent but not yet acknowledged as written by the
 *      receiver must stay below the receiver's advertised window. This bounds the
 *      receiver's write queue.
 */

export class AbortedError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export class ChannelClosedError extends Error {
  constructor() {
    super('channel closed');
    this.name = 'ChannelClosedError';
  }
}

/** Minimal view of a binary data channel, so the engine does not depend on DOM types. */
export interface SendChannel {
  readonly bufferedAmount: number;
  isOpen(): boolean;
  send(frame: Uint8Array<ArrayBuffer>): void;
  /** Subscribe to "bufferedAmount fell to or below the low threshold". Returns unsubscribe. */
  onLow(listener: () => void): () => void;
}

/** Safety-net poll interval for missed or coalesced bufferedamountlow events. */
export const DRAIN_POLL_MS = 50;

/**
 * Resolves when `channel.bufferedAmount <= highWater`.
 *
 * Lost-wakeup prevention: we subscribe to the low event *before* re-checking the
 * condition, and also poll on a timer; the event alone is unreliable if the
 * buffer drained between our check and the subscription, or if the threshold
 * was crossed while no listener was attached.
 */
export function waitForSendRoom(channel: SendChannel, highWater: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortedError());
  if (!channel.isOpen()) return Promise.reject(new ChannelClosedError());
  if (channel.bufferedAmount <= highWater) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      unsubscribe();
      clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const check = () => {
      if (!channel.isOpen()) finish(new ChannelClosedError());
      else if (channel.bufferedAmount <= highWater) finish();
    };
    const onAbort = () => finish(new AbortedError());
    const unsubscribe = channel.onLow(check);
    const poll = setInterval(check, DRAIN_POLL_MS);
    signal?.addEventListener('abort', onAbort);
    check();
  });
}

/**
 * Condition variable for single-threaded JS. `wait(pred)` resolves once `pred()`
 * is true, re-evaluated synchronously at call time and on every `notify()`.
 * Because the initial check and registration happen in the same tick, a
 * `notify()` cannot be lost between them.
 */
export class Condition {
  private readonly waiters = new Set<() => void>();

  notify(): void {
    for (const w of [...this.waiters]) w();
  }

  get waiting(): number {
    return this.waiters.size;
  }

  wait(pred: () => boolean, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new AbortedError());
    if (pred()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(check);
        signal?.removeEventListener('abort', onAbort);
      };
      const check = () => {
        if (pred()) {
          cleanup();
          resolve();
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new AbortedError());
      };
      this.waiters.add(check);
      signal?.addEventListener('abort', onAbort);
    });
  }
}

/**
 * FIFO counting semaphore limiting how many transfers move data concurrently.
 * Transfers waiting for acceptance, paused, or reconnecting do not hold a slot,
 * so a stalled transfer cannot block unrelated ones indefinitely.
 */
export class SlotScheduler {
  private readonly holders = new Set<object>();
  private readonly queue: Array<{ owner: object; grant: () => void }> = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
    this.pump();
  }

  get active(): number {
    return this.holders.size;
  }

  get waiting(): number {
    return this.queue.length;
  }

  holds(owner: object): boolean {
    return this.holders.has(owner);
  }

  acquire(owner: object, signal?: AbortSignal): Promise<void> {
    if (this.holders.has(owner)) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new AbortedError());
    if (this.holders.size < this.limit && this.queue.length === 0) {
      this.holders.add(owner);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        owner,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new AbortedError());
      };
      this.queue.push(entry);
      signal?.addEventListener('abort', onAbort);
    });
  }

  release(owner: object): void {
    if (this.holders.delete(owner)) this.pump();
    else {
      const i = this.queue.findIndex((e) => e.owner === owner);
      if (i >= 0) this.queue.splice(i, 1);
    }
  }

  private pump(): void {
    while (this.holders.size < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.holders.add(next.owner);
      next.grant();
    }
  }
}

/** Time-weighted exponential moving average of throughput (bytes/second). */
export class RateMeter {
  private lastBytes = 0;
  private lastTime = 0;
  private rate = 0;
  private started = false;
  private readonly tauMs: number;

  constructor(tauMs = 3000) {
    this.tauMs = tauMs;
  }

  reset(bytes: number, now: number): void {
    this.lastBytes = bytes;
    this.lastTime = now;
    this.rate = 0;
    this.started = true;
  }

  sample(bytes: number, now: number): number {
    if (!this.started) {
      this.reset(bytes, now);
      return 0;
    }
    const dt = now - this.lastTime;
    if (dt < 100) return this.rate;
    const instant = ((bytes - this.lastBytes) * 1000) / dt;
    const alpha = 1 - Math.exp(-dt / this.tauMs);
    this.rate = this.rate === 0 ? instant : this.rate + alpha * (instant - this.rate);
    this.lastBytes = bytes;
    this.lastTime = now;
    return this.rate;
  }

  get value(): number {
    return this.rate;
  }
}
