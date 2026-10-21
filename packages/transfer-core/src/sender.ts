import type { PeerMessageOf } from '@landrop/protocol';
import { TransferBase, type TransferHooks } from './base.ts';
import { AbortedError, ChannelClosedError, SlotScheduler, waitForSendRoom, type SendChannel } from './flow.ts';
import { FRAME_HEADER_BYTES, encodeDataFrame, transferIdToBytes } from './frame.ts';
import type { IncrementalHasher } from './hash.ts';
import { errorInfo, TransferFailure, type EngineConfig, type FileMeta, type FileSource, type PeerMessageBody } from './types.ts';

/** Chunk size used when the peer's SCTP maxMessageSize is unknown. */
export const FALLBACK_CHUNK_BYTES = 16 * 1024;

export interface SenderDeps extends TransferHooks {
  scheduler: SlotScheduler;
  hasher: IncrementalHasher;
}

type SenderControl =
  | PeerMessageOf<'transfer:accept'>
  | PeerMessageOf<'transfer:reject'>
  | PeerMessageOf<'transfer:pause'>
  | PeerMessageOf<'transfer:resume'>
  | PeerMessageOf<'transfer:resume-from'>
  | PeerMessageOf<'transfer:cancel'>
  | PeerMessageOf<'transfer:ack'>
  | PeerMessageOf<'transfer:verified'>
  | PeerMessageOf<'transfer:error'>;

/**
 * Sending side of one file transfer.
 *
 * Invariants:
 *   ackedOffset <= sentOffset <= size
 *   sentOffset - ackedOffset <= windowBytes          (receiver credit)
 *   channel.bufferedAmount <= highWater + chunk      (local send queue)
 *   hashedUpTo: bytes fed to the hasher, always a prefix of the file. After a
 *   rewind (resume-from), re-sent bytes below hashedUpTo are not hashed again.
 */
export class OutgoingTransfer extends TransferBase {
  readonly direction = 'out' as const;
  protected readonly role = 'sender' as const;

  sentOffset = 0;
  ackedOffset = 0;
  hashedUpTo = 0;
  windowBytes = 0;
  chunkBytes = 0;
  readonly lastModified: number | undefined;

  private readonly source: FileSource;
  private readonly deps: SenderDeps;
  private readonly idBytes: Uint8Array;
  private channel: SendChannel | null = null;
  private remoteMaxMessageSize = 0;
  private pumping = false;
  private lastAckProgressAt = 0;

  constructor(
    init: { id: string; peerId: string; batchId: string | null },
    meta: FileMeta,
    source: FileSource,
    deps: SenderDeps,
    config: EngineConfig,
  ) {
    super({ ...init, name: meta.name, size: meta.size, mime: meta.mime }, 'queued', deps, config);
    if (source.size !== meta.size) throw new RangeError('source size mismatch');
    this.lastModified = meta.lastModified;
    this.source = source;
    this.deps = deps;
    this.idBytes = transferIdToBytes(init.id);
  }

  get bytesTransferred(): number {
    return this.sentOffset;
  }

  get bytesWritten(): number {
    return this.ackedOffset;
  }

  /** Send (or re-send after reconnect) the offer. Duplicate offers are ignored by the receiver. */
  sendOffer(): void {
    if (this.state === 'queued') this.setState('requesting');
    if (this.state !== 'requesting' && this.state !== 'awaiting_acceptance') return;
    const offer: PeerMessageBody = {
      type: 'transfer:offer',
      id: this.id,
      name: this.name,
      size: this.size,
      mime: this.mime,
      hash: 'sha-256',
      ...(this.batchId ? { batchId: this.batchId } : {}),
      ...(this.lastModified !== undefined ? { lastModified: this.lastModified } : {}),
    };
    if (!this.send(offer)) return; // stays 'requesting'; retried when the channel reopens
    if (this.state === 'requesting') {
      this.setState('awaiting_acceptance');
      this.setTimer('accept', this.config.timings.acceptTimeoutMs, () => {
        this.send({ type: 'transfer:cancel', id: this.id });
        this.fail('ACCEPT_TIMEOUT', { notifyRemote: false });
      });
    }
  }

  /** Data channel changed. `null` = lost; a new channel = restored (await resume-from). */
  setChannel(channel: SendChannel | null, remoteMaxMessageSize: number): void {
    this.channel = channel;
    if (channel) this.remoteMaxMessageSize = remoteMaxMessageSize;
    if (!channel && (this.state === 'transferring' || this.state === 'paused' || this.state === 'verifying')) {
      this.enterReconnecting();
    }
    this.cond.notify();
  }

  private enterReconnecting(): void {
    this.setState('reconnecting');
    this.setTimer('reconnect', this.config.timings.reconnectTimeoutMs, () => this.fail('RECONNECT_TIMEOUT'));
  }

  pause(): void {
    if (this.state === 'transferring') {
      this.paused = true;
      this.send({ type: 'transfer:pause', id: this.id });
      this.setState('paused');
    }
  }

  resume(): void {
    if (this.state === 'paused') {
      this.paused = false;
      this.lastAckProgressAt = Date.now();
      this.send({ type: 'transfer:resume', id: this.id });
      this.setState('transferring');
    }
  }

  cancel(): void {
    if (this.terminal) return;
    this.send({ type: 'transfer:cancel', id: this.id });
    this.error = errorInfo('CANCELLED_BY_SENDER');
    this.setState('cancelled');
  }

  peerGone(): void {
    this.fail('PEER_LEFT', { notifyRemote: false });
  }

  handle(msg: SenderControl): void {
    if (this.terminal) return;
    switch (msg.type) {
      case 'transfer:accept':
        return this.onAccept(msg);
      case 'transfer:reject':
        if (this.state !== 'awaiting_acceptance') return;
        this.error = errorInfo(msg.code === 'REJECTED_BY_USER' ? 'REJECTED_BY_USER' : msg.code, true);
        return this.setState('rejected');
      case 'transfer:pause':
        this.paused = true;
        if (this.state === 'transferring') this.setState('paused');
        return;
      case 'transfer:resume':
        this.paused = false;
        this.lastAckProgressAt = Date.now();
        if (this.state === 'paused') this.setState('transferring');
        this.cond.notify();
        return;
      case 'transfer:resume-from':
        return this.onResumeFrom(msg);
      case 'transfer:cancel':
        this.error = errorInfo('CANCELLED_BY_RECEIVER', true);
        return this.setState('cancelled');
      case 'transfer:ack':
        return this.onAck(msg);
      case 'transfer:verified':
        if (this.state === 'reconnecting' && this.sha256) {
          this.clearTimer('reconnect');
          this.setState('verifying');
        }
        if (this.state !== 'verifying') return;
        if (msg.sha256 !== this.sha256) return this.fail('INTEGRITY_MISMATCH');
        return this.setState('completed');
      case 'transfer:error':
        return this.fail(msg.code, { remote: true });
    }
  }

  private onAccept(msg: PeerMessageOf<'transfer:accept'>): void {
    if (this.state !== 'awaiting_acceptance') return; // duplicate or late
    this.clearTimer('accept');
    const byMessageSize =
      this.remoteMaxMessageSize > FRAME_HEADER_BYTES ? this.remoteMaxMessageSize - FRAME_HEADER_BYTES : FALLBACK_CHUNK_BYTES;
    this.chunkBytes = Math.min(msg.chunkBytes, this.config.maxChunkBytes, byMessageSize);
    if (this.chunkBytes < 1024) return this.fail('UNSUPPORTED_CAPABILITY');
    this.windowBytes = msg.windowBytes;
    this.attempt = msg.attempt;
    this.sinkKind = msg.sink;
    this.lastAckProgressAt = Date.now();
    this.setState('transferring');
    this.armWatchdog();
    void this.pump();
  }

  private onAck(msg: PeerMessageOf<'transfer:ack'>): void {
    if (msg.attempt !== this.attempt) return; // stale attempt
    if (this.state !== 'transferring' && this.state !== 'paused' && this.state !== 'verifying') return;
    if (msg.offset > this.sentOffset) return this.fail('PROTOCOL_VIOLATION');
    if (msg.offset <= this.ackedOffset) return; // duplicate / reordered
    this.ackedOffset = msg.offset;
    this.lastAckProgressAt = Date.now();
    this.cond.notify();
    this.hooks.onChange();
  }

  private onResumeFrom(msg: PeerMessageOf<'transfer:resume-from'>): void {
    const s = this.state;
    if (s !== 'reconnecting' && s !== 'transferring' && s !== 'paused' && s !== 'verifying') return;
    if (msg.attempt <= this.attempt) return; // stale or duplicate
    if (msg.size !== this.size || msg.offset > this.size || msg.offset < this.ackedOffset || msg.offset > this.hashedUpTo) {
      return this.fail('RESUME_MISMATCH');
    }
    if (s !== 'reconnecting') this.setState('reconnecting'); // receiver noticed the reconnect first
    this.clearTimer('reconnect');
    this.attempt = msg.attempt;
    this.sentOffset = msg.offset;
    this.ackedOffset = msg.offset;
    this.lastAckProgressAt = Date.now();
    if (msg.offset === this.size && this.sha256) {
      this.enterVerifying();
      return;
    }
    this.setState(this.paused ? 'paused' : 'transferring');
    this.armWatchdog();
    void this.pump();
  }

  private armWatchdog(): void {
    this.setTimer('watchdog', 1000, () => {
      if (this.state === 'transferring' || this.state === 'paused') {
        const outstanding = this.sentOffset > this.ackedOffset;
        const stalled = Date.now() - this.lastAckProgressAt > this.config.timings.ackTimeoutMs;
        if (this.state === 'transferring' && !this.paused && this.channel && outstanding && stalled) {
          this.fail('ACK_TIMEOUT');
          return;
        }
        this.armWatchdog();
      }
    });
  }

  private enterVerifying(): void {
    this.setState('verifying');
    this.send({ type: 'transfer:finish', id: this.id, attempt: this.attempt, size: this.size, sha256: this.sha256! });
    this.setTimer('verify', this.config.timings.verifyTimeoutMs, () => this.fail('VERIFY_TIMEOUT'));
  }

  private ready(): boolean {
    return this.state === 'transferring' && !this.paused && this.channel !== null;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const signal = this.abort.signal;
    const scheduler = this.deps.scheduler;
    try {
      for (;;) {
        if (this.terminal) return;
        if (!this.ready()) {
          if (this.state === 'verifying') return;
          scheduler.release(this);
          await this.cond.wait(() => this.terminal || this.ready() || this.state === 'verifying', signal);
          continue;
        }
        if (this.sentOffset >= this.size) {
          // Everything sent; free the slot while waiting for the final acks.
          scheduler.release(this);
          if (this.ackedOffset >= this.size) {
            if (this.hashedUpTo !== this.size) throw new TransferFailure('READ_FAILED', 'hash does not cover file');
            this.sha256 ??= await this.deps.hasher.digest();
            if (this.terminal) return;
            if (!this.ready()) continue; // paused or reconnecting meanwhile
            this.clearTimer('watchdog');
            this.enterVerifying();
            return;
          }
          const attempt = this.attempt;
          await this.cond.wait(
            () => this.terminal || !this.ready() || this.ackedOffset >= this.size || this.sentOffset < this.size || this.attempt !== attempt,
            signal,
          );
          continue;
        }
        if (!scheduler.holds(this)) {
          await scheduler.acquire(this, signal);
          continue;
        }
        if (this.sentOffset - this.ackedOffset >= this.windowBytes) {
          const attempt = this.attempt;
          await this.timed(
            'credit',
            this.cond.wait(
              () => this.terminal || !this.ready() || this.attempt !== attempt || this.sentOffset - this.ackedOffset < this.windowBytes,
              signal,
            ),
          );
          continue;
        }

        const ch = this.channel!;
        try {
          await this.timed('sendQueue', waitForSendRoom(ch, this.config.highWaterBytes, signal));
        } catch (err) {
          if (!(err instanceof ChannelClosedError)) throw err;
          await this.cond.wait(() => this.terminal || this.channel !== ch, signal);
          continue;
        }
        if (this.terminal) return;
        if (!this.ready() || this.channel !== ch) continue;

        const offset = this.sentOffset;
        const attempt = this.attempt;
        const length = Math.min(this.chunkBytes, this.size - offset, this.windowBytes - (offset - this.ackedOffset));
        let data: Uint8Array;
        try {
          data = await this.timed('read', this.source.read(offset, length));
        } catch (err) {
          throw new TransferFailure('READ_FAILED', (err as Error).name);
        }
        if (data.byteLength !== length) throw new TransferFailure('READ_FAILED', 'short read');
        if (this.terminal) return;
        // Anything may have changed while reading (pause, rewind, reconnect): re-check, discard if stale.
        if (!this.ready() || this.channel !== ch || this.attempt !== attempt || this.sentOffset !== offset) continue;

        const frame = encodeDataFrame(this.idBytes, attempt, offset, data);
        try {
          ch.send(frame);
        } catch {
          if (ch.isOpen()) throw new TransferFailure('UNSUPPORTED_CAPABILITY', 'data channel refused frame');
          await this.cond.wait(() => this.terminal || this.channel !== ch, signal);
          continue;
        }
        if (offset === this.hashedUpTo) {
          this.hashedUpTo = offset + length;
          const pending = this.deps.hasher.update(data);
          if (pending) await this.timed('hash', pending);
        }
        this.sentOffset = offset + length;
        this.hooks.onChange();
      }
    } catch (err) {
      if (err instanceof AbortedError || this.terminal) return;
      this.fail(err instanceof TransferFailure ? err.code : 'READ_FAILED');
    } finally {
      scheduler.release(this);
      this.pumping = false;
    }
  }

  protected onTerminal(): void {
    this.deps.scheduler.release(this);
    this.deps.hasher.dispose?.();
    this.channel = null;
  }
}
