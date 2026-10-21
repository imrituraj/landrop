import { PROTOCOL_VERSION, type Capabilities, type PeerMessage, type TransferOffer } from '@landrop/protocol';
import { TokenBucket, randomId } from '@landrop/shared';
import type { TransferBase } from './base.ts';
import { SlotScheduler, type SendChannel } from './flow.ts';
import { decodeDataFrame, peekTransferId } from './frame.ts';
import type { IncrementalHasher } from './hash.ts';
import { IncomingTransfer } from './receiver.ts';
import { OutgoingTransfer } from './sender.ts';
import { classifyStorageError, type ReceiveSink } from './sink.ts';
import type { EngineConfig, FileMeta, FileSource, PeerMessageBody } from './types.ts';

export interface PeerTransferDeps {
  peerId: string;
  config: EngineConfig;
  scheduler: SlotScheduler;
  /** Our current receiving capabilities (enforced again on every offer). */
  localCapabilities(): Capabilities;
  sendControl(raw: string): boolean;
  createHasher(): IncrementalHasher;
  onTransferChange(t: TransferBase): void;
  onIncomingOffer(t: IncomingTransfer): void;
}

export interface PeerTransferCounters {
  staleFrames: number;
  unknownFrames: number;
  invalidFrames: number;
  rejectedOffers: number;
}

const MAX_TERMINAL_RECORDS = 200;

/**
 * All transfers with one remote peer, in both directions. Routes control
 * messages and binary frames, applies receiver-side limits to incoming offers,
 * and propagates data-channel loss/restoration.
 */
export class PeerTransferManager {
  readonly outgoing = new Map<string, OutgoingTransfer>();
  readonly incoming = new Map<string, IncomingTransfer>();
  remoteCaps: Capabilities | null = null;
  readonly counters: PeerTransferCounters = { staleFrames: 0, unknownFrames: 0, invalidFrames: 0, rejectedOffers: 0 };

  private channel: SendChannel | null = null;
  private remoteMaxMessageSize = 0;
  private connected = false;
  private readonly offerLimiter: TokenBucket;
  private readonly deps: PeerTransferDeps;

  constructor(deps: PeerTransferDeps) {
    this.deps = deps;
    this.offerLimiter = new TokenBucket(deps.config.offersPerMinute, deps.config.offersPerMinute / 60);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private sendMsg(msg: PeerMessageBody): boolean {
    return this.deps.sendControl(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
  }

  // ---------------------------------------------------------------------------
  // Outgoing

  send(source: FileSource, meta: FileMeta, batchId: string | null = null): OutgoingTransfer {
    const id = randomId();
    const t: OutgoingTransfer = new OutgoingTransfer(
      { id, peerId: this.deps.peerId, batchId },
      meta,
      source,
      {
        scheduler: this.deps.scheduler,
        hasher: this.deps.createHasher(),
        sendControl: (m) => this.sendMsg(m),
        onChange: () => this.deps.onTransferChange(t),
      },
      this.deps.config,
    );
    this.outgoing.set(id, t);
    if (this.channel) t.setChannel(this.channel, this.remoteMaxMessageSize);
    this.deps.onTransferChange(t);
    this.tryStart(t);
    return t;
  }

  private tryStart(t: OutgoingTransfer): void {
    if (t.state !== 'queued' && t.state !== 'requesting' && t.state !== 'awaiting_acceptance') return;
    if (!this.connected || !this.remoteCaps) return;
    // Honor the receiver's advertised capability before any payload is sent.
    if (t.state === 'queued' && t.size > this.remoteCaps.maxAcceptBytes) {
      t.fail('TOO_LARGE_FOR_SINK', { notifyRemote: false });
      return;
    }
    t.sendOffer();
  }

  // ---------------------------------------------------------------------------
  // Incoming

  /**
   * Accept an incoming offer. `openSink` is called synchronously (so a file
   * picker keeps the user activation of the click that called this).
   */
  async accept(id: string, openSink: () => Promise<ReceiveSink>): Promise<void> {
    const t = this.incoming.get(id);
    if (!t || !t.beginAccept()) return;
    let sink: ReceiveSink;
    try {
      sink = await openSink();
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      t.acceptFailed(name === 'AbortError' ? 'SINK_CANCELLED' : classifyStorageError(err));
      return;
    }
    if (t.state !== 'preparing') {
      await sink.abort('cancelled while preparing');
      return;
    }
    t.accept(sink, this.deps.createHasher());
  }

  private onOffer(offer: TransferOffer): void {
    if (this.outgoing.has(offer.id) || this.incoming.has(offer.id)) return; // duplicate / collision
    if (!this.offerLimiter.tryTake()) {
      this.counters.rejectedOffers++;
      this.sendMsg({ type: 'transfer:reject', id: offer.id, code: 'RATE_LIMITED' });
      return;
    }
    let pending = 0;
    for (const t of this.incoming.values()) if (t.state === 'awaiting_acceptance') pending++;
    if (pending >= this.deps.config.maxPendingOffers) {
      this.counters.rejectedOffers++;
      this.sendMsg({ type: 'transfer:reject', id: offer.id, code: 'TOO_MANY_PENDING' });
      return;
    }
    const t: IncomingTransfer = new IncomingTransfer(
      this.deps.peerId,
      offer,
      { sendControl: (m) => this.sendMsg(m), onChange: () => this.deps.onTransferChange(t) },
      this.deps.config,
    );
    this.incoming.set(offer.id, t);
    this.prune();
    this.deps.onTransferChange(t);
    if (offer.size > this.deps.localCapabilities().maxAcceptBytes) {
      t.reject('TOO_LARGE_FOR_SINK');
      return;
    }
    this.deps.onIncomingOffer(t);
  }

  // ---------------------------------------------------------------------------
  // Routing

  handleMessage(msg: PeerMessage): void {
    switch (msg.type) {
      case 'transfer:offer':
        return this.onOffer(msg);
      case 'transfer:accept':
      case 'transfer:reject':
      case 'transfer:resume-from':
      case 'transfer:ack':
      case 'transfer:verified':
        this.outgoing.get(msg.id)?.handle(msg);
        return;
      case 'transfer:finish':
        this.incoming.get(msg.id)?.handle(msg);
        return;
      case 'transfer:pause':
      case 'transfer:resume':
      case 'transfer:cancel':
      case 'transfer:error': {
        const out = this.outgoing.get(msg.id);
        if (out) out.handle(msg);
        else this.incoming.get(msg.id)?.handle(msg);
        return;
      }
      default:
        return;
    }
  }

  handleFrame(buf: ArrayBuffer): void {
    const id = peekTransferId(buf);
    const t = id ? this.incoming.get(id) : undefined;
    if (!t) {
      this.counters.unknownFrames++;
      return;
    }
    const decoded = decodeDataFrame(buf, t.chunkBytes);
    if (!decoded.ok) {
      this.counters.invalidFrames++;
      t.fail('INVALID_FRAME');
      return;
    }
    const verdict = t.onFrame(decoded.frame);
    if (verdict === 'stale') this.counters.staleFrames++;
    else if (verdict === 'violation') {
      this.counters.invalidFrames++;
      t.fail('INVALID_FRAME');
    }
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle

  /** Data channels (re)opened. Call `setRemoteCapabilities` when the peer advertises. */
  linkOpened(channel: SendChannel, remoteMaxMessageSize: number): void {
    this.connected = true;
    this.channel = channel;
    this.remoteMaxMessageSize = remoteMaxMessageSize;
    for (const t of this.outgoing.values()) t.setChannel(channel, remoteMaxMessageSize);
    for (const t of this.incoming.values()) void t.channelRestored();
    for (const t of this.outgoing.values()) this.tryStart(t);
  }

  linkClosed(): void {
    this.connected = false;
    this.channel = null;
    this.remoteCaps = null;
    for (const t of this.outgoing.values()) t.setChannel(null, 0);
    for (const t of this.incoming.values()) t.channelLost();
  }

  setRemoteCapabilities(caps: Capabilities): void {
    this.remoteCaps = caps;
    for (const t of this.outgoing.values()) this.tryStart(t);
  }

  peerGone(): void {
    for (const t of this.outgoing.values()) t.peerGone();
    for (const t of this.incoming.values()) t.peerGone();
  }

  get currentChannel(): SendChannel | null {
    return this.channel;
  }

  get maxMessageSize(): number {
    return this.remoteMaxMessageSize;
  }

  /** Drop the oldest terminal records beyond a bound. */
  prune(limit = MAX_TERMINAL_RECORDS): string[] {
    const removed: string[] = [];
    for (const map of [this.incoming, this.outgoing] as Array<Map<string, TransferBase>>) {
      const terminal = [...map.values()].filter((t) => t.terminal);
      for (const t of terminal.slice(0, Math.max(0, terminal.length - limit))) {
        map.delete(t.id);
        removed.push(t.id);
      }
    }
    return removed;
  }

  remove(id: string): void {
    const t = this.outgoing.get(id) ?? this.incoming.get(id);
    if (t && !t.terminal) return;
    this.outgoing.delete(id);
    this.incoming.delete(id);
  }
}

export function newBatchId(): string {
  return randomId();
}
