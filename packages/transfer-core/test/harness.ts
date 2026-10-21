import { createHash } from 'node:crypto';
import { PROTOCOL_VERSION, parsePeerMessage, type Capabilities } from '@landrop/protocol';
import {
  DEFAULT_ENGINE_CONFIG,
  PeerTransferManager,
  Sha256Hasher,
  SlotScheduler,
  type EngineConfig,
  type FileSource,
  type IncomingTransfer,
  type ReceiveSink,
  type SendChannel,
  type TransferBase,
  type TransferState,
} from '../src/index.ts';

/** Hashes, then detaches the buffer exactly as postMessage(..., [buffer]) would. */
export class DetachingHasher extends Sha256Hasher {
  override update(data: Uint8Array): void {
    super.update(data);
    structuredClone(data.buffer, { transfer: [data.buffer as ArrayBuffer] });
  }
}

/** Deterministic pseudo-random bytes addressable by offset (no storage needed). */
export class DeterministicSource implements FileSource {
  readonly size: number;
  private readonly seed: number;
  reads = 0;
  maxReadLength = 0;
  failAt: number | null = null;

  constructor(size: number, seed = 1) {
    this.size = size;
    this.seed = seed >>> 0;
  }

  static byteAt(seed: number, i: number): number {
    let x = (Math.floor(i / 4) * 2654435761) ^ seed;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x ^= x >>> 16;
    return (x >>> ((i % 4) * 8)) & 0xff;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.failAt !== null && offset >= this.failAt) throw Object.assign(new Error('gone'), { name: 'NotReadableError' });
    if (offset < 0 || offset + length > this.size) throw new RangeError('read out of range');
    this.reads++;
    this.maxReadLength = Math.max(this.maxReadLength, length);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = DeterministicSource.byteAt(this.seed, offset + i);
    return out;
  }

  sha256(): string {
    const h = createHash('sha256');
    const block = 1 << 20;
    for (let off = 0; off < this.size; off += block) {
      const len = Math.min(block, this.size - off);
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) buf[i] = DeterministicSource.byteAt(this.seed, off + i);
      h.update(buf);
    }
    return h.digest('hex');
  }
}

/** Sink that hashes what it receives without storing it, and records behavior. */
export class HashingSink implements ReceiveSink {
  readonly kind = 'streaming' as const;
  readonly randomAccess = true;
  private readonly h = createHash('sha256');
  written = 0;
  finalized = false;
  aborted = false;
  failAt: number | null = null;
  hang = false;
  writeDelayMs = 0;

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (this.hang) return new Promise(() => undefined);
    if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs));
    if (this.failAt !== null && offset + data.byteLength > this.failAt) {
      throw Object.assign(new Error('disk full'), { name: 'QuotaExceededError' });
    }
    if (offset !== this.written) throw new Error(`non-sequential write at ${offset}, expected ${this.written}`);
    this.h.update(data);
    this.written += data.byteLength;
  }

  async finalize(): Promise<void> {
    this.finalized = true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  digest(): string {
    return this.h.copy().digest('hex');
  }
}

export interface ChannelOptions {
  /** Bytes delivered per tick (simulated link throughput). */
  bytesPerTick: number;
  tickMs: number;
  lowThreshold: number;
  /** Probability of NOT firing bufferedamountlow when it should (tests lost wakeups). */
  dropLowEventRate: number;
  /** Mutate frames in flight (tests integrity checks). */
  tamper?: (frame: Uint8Array) => void;
}

/** Simulated RTCDataChannel send side with a real bufferedAmount and low-threshold events. */
export class FakeBinaryChannel implements SendChannel {
  bufferedAmount = 0;
  peakBuffered = 0;
  framesSent = 0;
  private open = true;
  private readonly queue: Uint8Array[] = [];
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly deliver: (buf: ArrayBuffer) => void;
  private readonly opts: ChannelOptions;

  constructor(deliver: (buf: ArrayBuffer) => void, opts: ChannelOptions) {
    this.deliver = deliver;
    this.opts = opts;
  }

  isOpen(): boolean {
    return this.open;
  }

  send(frame: Uint8Array): void {
    if (!this.open) throw Object.assign(new Error('closed'), { name: 'InvalidStateError' });
    this.queue.push(frame);
    this.framesSent++;
    this.bufferedAmount += frame.byteLength;
    this.peakBuffered = Math.max(this.peakBuffered, this.bufferedAmount);
    this.schedule();
  }

  onLow(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.open = false;
    this.queue.length = 0;
    this.bufferedAmount = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer || !this.open) return;
    this.timer = setTimeout(() => this.tick(), this.opts.tickMs);
  }

  private tick(): void {
    this.timer = null;
    let budget = this.opts.bytesPerTick;
    const before = this.bufferedAmount;
    while (budget > 0 && this.queue.length > 0 && this.open) {
      const f = this.queue.shift()!;
      budget -= f.byteLength;
      this.bufferedAmount -= f.byteLength;
      this.opts.tamper?.(f);
      // Each received message is its own ArrayBuffer, as in the browser.
      this.deliver(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer);
    }
    if (before > this.opts.lowThreshold && this.bufferedAmount <= this.opts.lowThreshold) {
      if (Math.random() >= this.opts.dropLowEventRate) for (const l of [...this.listeners]) l();
    }
    if (this.queue.length > 0) this.schedule();
  }
}

export const CAPS = (over: Partial<Capabilities> = {}): Capabilities => ({
  v: PROTOCOL_VERSION,
  type: 'capabilities',
  streamingSink: true,
  memorySinkMaxBytes: 1024 * 1024,
  maxAcceptBytes: Number.MAX_SAFE_INTEGER,
  maxMessageSize: 256 * 1024,
  hashAlgorithms: ['sha-256'],
  resume: { pause: true, reconnect: true, reload: false },
  ...over,
});

export interface Side {
  mgr: PeerTransferManager;
  offers: IncomingTransfer[];
  history: Map<string, TransferState[]>;
  caps: Capabilities;
}

/**
 * Two PeerTransferManagers connected by simulated control (JSON, schema-validated)
 * and binary channels with independent latencies, like separate SCTP streams.
 */
export class FakeLink {
  a: Side;
  b: Side;
  up = false;
  chanAtoB: FakeBinaryChannel | null = null;
  chanBtoA: FakeBinaryChannel | null = null;
  controlDelayMs = 1;
  dropControl = false;
  readonly channelOpts: ChannelOptions;
  invalidControl = 0;
  private readonly detachingHasher: boolean;

  constructor(
    opts: {
      config?: Partial<EngineConfig>;
      channel?: Partial<ChannelOptions>;
      concurrency?: number;
      capsB?: Partial<Capabilities>;
      /** Use a hasher that transfers (detaches) each buffer, like the web worker hasher. */
      detachingHasher?: boolean;
    } = {},
  ) {
    this.detachingHasher = opts.detachingHasher ?? false;
    const config: EngineConfig = { ...DEFAULT_ENGINE_CONFIG, ...opts.config, timings: { ...DEFAULT_ENGINE_CONFIG.timings, ...opts.config?.timings } };
    this.channelOpts = {
      bytesPerTick: 512 * 1024,
      tickMs: 1,
      lowThreshold: config.lowWaterBytes,
      dropLowEventRate: 0,
      ...opts.channel,
    };
    this.a = this.makeSide('peer-b', config, CAPS(), opts.concurrency ?? 2, () => this.b);
    this.b = this.makeSide('peer-a', config, CAPS(opts.capsB), opts.concurrency ?? 2, () => this.a);
  }

  private makeSide(remoteName: string, config: EngineConfig, caps: Capabilities, concurrency: number, other: () => Side): Side {
    const side: Side = {
      offers: [],
      history: new Map(),
      caps,
      mgr: null as unknown as PeerTransferManager, // assigned immediately below
    };
    side.mgr = new PeerTransferManager({
      peerId: remoteName,
      config,
      scheduler: new SlotScheduler(concurrency),
      localCapabilities: () => side.caps,
      sendControl: (raw) => {
        if (!this.up || this.dropControl) return false;
        setTimeout(() => {
          if (!this.up) return;
          const parsed = parsePeerMessage(raw);
          if (!parsed.ok) {
            this.invalidControl++;
            return;
          }
          if (parsed.value.type === 'capabilities') other().mgr.setRemoteCapabilities(parsed.value);
          else other().mgr.handleMessage(parsed.value);
        }, this.controlDelayMs);
        return true;
      },
      createHasher: () => (this.detachingHasher ? new DetachingHasher() : new Sha256Hasher()),
      onTransferChange: (t: TransferBase) => {
        const h = side.history.get(t.id) ?? [];
        if (h[h.length - 1] !== t.state) h.push(t.state);
        side.history.set(t.id, h);
      },
      onIncomingOffer: (t) => side.offers.push(t),
    });
    return side;
  }

  connect(): void {
    this.up = true;
    this.chanAtoB = new FakeBinaryChannel((buf) => this.b.mgr.handleFrame(buf), this.channelOpts);
    this.chanBtoA = new FakeBinaryChannel((buf) => this.a.mgr.handleFrame(buf), this.channelOpts);
    this.a.mgr.linkOpened(this.chanAtoB, 256 * 1024);
    this.b.mgr.linkOpened(this.chanBtoA, 256 * 1024);
    this.a.mgr.setRemoteCapabilities(this.b.caps);
    this.b.mgr.setRemoteCapabilities(this.a.caps);
  }

  drop(): void {
    this.up = false;
    this.chanAtoB?.close();
    this.chanBtoA?.close();
    this.a.mgr.linkClosed();
    this.b.mgr.linkClosed();
  }
}

export async function waitFor(pred: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
