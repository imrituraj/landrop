import type { ErrorCode, PeerMessageOf, TransferOffer } from '@landrop/protocol';
import { TransferBase, type TransferHooks } from './base.ts';
import type { DataFrame } from './frame.ts';
import type { IncrementalHasher } from './hash.ts';
import { classifyStorageError, type ReceiveSink } from './sink.ts';
import { errorInfo, type EngineConfig } from './types.ts';

type ReceiverControl =
  | PeerMessageOf<'transfer:pause'>
  | PeerMessageOf<'transfer:resume'>
  | PeerMessageOf<'transfer:cancel'>
  | PeerMessageOf<'transfer:finish'>
  | PeerMessageOf<'transfer:error'>;

export type FrameVerdict = 'ok' | 'stale' | 'violation';

/**
 * Receiving side of one file transfer.
 *
 * Invariants:
 *   writtenOffset <= receivedOffset <= size
 *   receivedOffset - writtenOffset <= windowBytes   (bounded write queue)
 *   frames must arrive at exactly receivedOffset for the current attempt
 *   the hasher sees bytes in file order, exactly once (it follows writes)
 *
 * Completion = all bytes written AND hash matches the sender's AND sink
 * finalized; only then is transfer:verified sent.
 */
export class IncomingTransfer extends TransferBase {
  readonly direction = 'in' as const;
  protected readonly role = 'receiver' as const;

  receivedOffset = 0;
  writtenOffset = 0;
  readonly offer: TransferOffer;
  windowBytes: number;
  chunkBytes: number;

  private sink: ReceiveSink | null = null;
  private hasher: IncrementalHasher | null = null;
  private readonly queue: Array<{ offset: number; data: Uint8Array }> = [];
  private writing = false;
  private expectedHash: string | null = null;
  private digestPromise: Promise<string> | null = null;
  private lastAckSent = 0;
  private channelUp = true;
  private readonly ackEveryBytes: number;

  constructor(peerId: string, offer: TransferOffer, hooks: TransferHooks, config: EngineConfig) {
    super(
      { id: offer.id, peerId, batchId: offer.batchId ?? null, name: offer.name, size: offer.size, mime: offer.mime },
      'awaiting_acceptance',
      hooks,
      config,
    );
    this.offer = offer;
    this.windowBytes = config.windowBytes;
    this.chunkBytes = config.maxChunkBytes;
    this.ackEveryBytes = Math.max(64 * 1024, Math.floor(config.windowBytes / 4));
    this.setTimer('decide', config.timings.acceptTimeoutMs, () => this.reject('ACCEPT_TIMEOUT'));
  }

  get bytesTransferred(): number {
    return this.receivedOffset;
  }

  get bytesWritten(): number {
    return this.writtenOffset;
  }

  get queuedBytes(): number {
    return this.receivedOffset - this.writtenOffset;
  }

  /** User accepted; the UI is about to open a sink (may prompt for a location). */
  beginAccept(): boolean {
    if (this.state !== 'awaiting_acceptance') return false;
    this.clearTimer('decide');
    this.setState('preparing');
    return true;
  }

  /** Sink is ready: start receiving. */
  accept(sink: ReceiveSink, hasher: IncrementalHasher): void {
    if (this.state !== 'preparing') {
      void sink.abort('not preparing');
      hasher.dispose?.();
      return;
    }
    this.sink = sink;
    this.hasher = hasher;
    this.sinkKind = sink.kind;
    this.attempt = 1;
    this.send({
      type: 'transfer:accept',
      id: this.id,
      attempt: this.attempt,
      sink: sink.kind,
      windowBytes: this.windowBytes,
      chunkBytes: this.chunkBytes,
    });
    this.setState('transferring');
  }

  /** Opening the sink failed or the user dismissed the save dialog. */
  acceptFailed(code: ErrorCode): void {
    if (this.state !== 'preparing') return;
    this.error = errorInfo(code);
    this.send({ type: 'transfer:reject', id: this.id, code });
    this.setState('rejected');
  }

  reject(code: ErrorCode = 'REJECTED_BY_USER'): void {
    if (this.state !== 'awaiting_acceptance' && this.state !== 'preparing') return;
    this.error = errorInfo(code);
    this.send({ type: 'transfer:reject', id: this.id, code });
    this.setState('rejected');
  }

  pause(): void {
    if (this.state !== 'transferring') return;
    this.paused = true;
    this.send({ type: 'transfer:pause', id: this.id });
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.paused = false;
    this.send({ type: 'transfer:resume', id: this.id });
    this.setState('transferring');
  }

  cancel(): void {
    if (this.terminal) return;
    this.send({ type: 'transfer:cancel', id: this.id });
    this.error = errorInfo('CANCELLED_BY_RECEIVER');
    this.setState('cancelled');
  }

  peerGone(): void {
    this.fail('PEER_LEFT', { notifyRemote: false });
  }

  handle(msg: ReceiverControl): void {
    if (this.terminal) {
      // The sender may have missed our verified message (e.g. lost with a channel).
      if (msg.type === 'transfer:finish' && this.state === 'completed' && this.sha256) {
        this.send({ type: 'transfer:verified', id: this.id, sha256: this.sha256 });
      }
      return;
    }
    switch (msg.type) {
      case 'transfer:pause':
        this.paused = true;
        if (this.state === 'transferring') this.setState('paused');
        return;
      case 'transfer:resume':
        this.paused = false;
        if (this.state === 'paused') this.setState('transferring');
        return;
      case 'transfer:cancel':
        this.error = errorInfo('CANCELLED_BY_SENDER', true);
        return this.setState('cancelled');
      case 'transfer:error':
        return this.fail(msg.code, { remote: true });
      case 'transfer:finish':
        if (this.state !== 'transferring' && this.state !== 'paused' && this.state !== 'verifying') return;
        if (msg.attempt !== this.attempt) return; // stale
        if (msg.size !== this.size || this.receivedOffset !== this.size) return this.fail('PROTOCOL_VIOLATION');
        if (this.expectedHash !== null && this.expectedHash !== msg.sha256) return this.fail('PROTOCOL_VIOLATION');
        this.expectedHash = msg.sha256;
        void this.maybeVerify();
        return;
    }
  }

  /** Validate and enqueue a data frame. The caller fails the transfer on 'violation'. */
  onFrame(frame: DataFrame): FrameVerdict {
    if (this.terminal) return 'stale';
    if (frame.attempt !== this.attempt) return 'stale';
    if (this.state !== 'transferring' && this.state !== 'paused') return 'stale';
    const len = frame.payload.byteLength;
    if (frame.offset !== this.receivedOffset) return 'violation'; // gap, overlap, or reorder
    if (len > this.chunkBytes) return 'violation';
    if (frame.offset + len > this.size) return 'violation'; // past EOF
    if (this.receivedOffset + len - this.writtenOffset > this.windowBytes) return 'violation'; // credit exceeded
    this.receivedOffset += len;
    this.queue.push({ offset: frame.offset, data: frame.payload });
    void this.drain();
    return 'ok';
  }

  private async drain(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length > 0) {
        const head = this.queue[0]!;
        const sink = this.sink;
        const hasher = this.hasher;
        if (!sink || !hasher || this.terminal) return;
        try {
          await this.timed('write', sink.write(head.offset, head.data));
        } catch (err) {
          this.fail(classifyStorageError(err));
          return;
        }
        if (this.terminal) return;
        // Read the length first: a worker-backed hasher may transfer (detach) the buffer.
        const end = head.offset + head.data.byteLength;
        const pending = hasher.update(head.data);
        if (pending) await this.timed('hash', pending);
        this.queue.shift();
        this.writtenOffset = end;
        this.maybeAck();
        this.hooks.onChange();
      }
    } finally {
      this.writing = false;
      this.cond.notify();
    }
    this.maybeAck(true);
    void this.maybeVerify();
  }

  private maybeAck(force = false): void {
    if (!this.channelUp || this.terminal) return;
    const pending = this.writtenOffset - this.lastAckSent;
    if (pending <= 0) return;
    if (force || pending >= this.ackEveryBytes || this.writtenOffset === this.size) {
      if (this.send({ type: 'transfer:ack', id: this.id, attempt: this.attempt, offset: this.writtenOffset })) {
        this.lastAckSent = this.writtenOffset;
      }
    }
  }

  private async maybeVerify(): Promise<void> {
    if (this.expectedHash === null || this.writing || this.writtenOffset !== this.size) return;
    if (this.state !== 'transferring' && this.state !== 'paused') return;
    this.setState('verifying');
    let digest: string;
    try {
      // Digest once; a reconnect during verification re-enters here.
      this.digestPromise ??= this.hasher!.digest();
      digest = await this.digestPromise;
    } catch {
      return this.fail('WRITE_FAILED');
    }
    if (this.stateNow() !== 'verifying') return; // terminal, or reconnecting meanwhile
    if (digest !== this.expectedHash) return this.fail('INTEGRITY_MISMATCH');
    this.sha256 = digest;
    this.setState('finalizing');
    try {
      await this.sink!.finalize();
    } catch (err) {
      return this.fail(classifyStorageError(err));
    }
    if (this.terminal) return;
    this.setState('completed');
    this.send({ type: 'transfer:verified', id: this.id, sha256: digest });
  }

  /** Data channel lost: wait for a new one. Writes already queued continue. */
  channelLost(): void {
    this.channelUp = false;
    if (this.state === 'transferring' || this.state === 'paused' || this.state === 'verifying') {
      this.setState('reconnecting');
      this.setTimer('reconnect', this.config.timings.reconnectTimeoutMs, () => this.fail('RECONNECT_TIMEOUT'));
    }
  }

  /**
   * New data channel is open. Finish queued writes, then ask the sender to
   * continue from our written offset with a new attempt number. Frames from the
   * old attempt that are still in flight are discarded as stale.
   */
  async channelRestored(): Promise<void> {
    this.channelUp = true;
    if (this.state === 'completed' && this.sha256) {
      this.send({ type: 'transfer:verified', id: this.id, sha256: this.sha256 });
      return;
    }
    if (this.state === 'transferring' || this.state === 'paused') {
      // We had not noticed the loss (e.g. the sender reconnected first).
      this.setState('reconnecting');
    }
    if (this.state !== 'reconnecting') return;
    await this.cond.wait(() => this.terminal || !this.writing, this.abort.signal).catch(() => undefined);
    if (this.terminal || this.state !== 'reconnecting') return;
    this.clearTimer('reconnect');
    this.attempt++;
    this.receivedOffset = this.writtenOffset;
    this.lastAckSent = this.writtenOffset;
    this.send({ type: 'transfer:resume-from', id: this.id, attempt: this.attempt, offset: this.writtenOffset, size: this.size });
    if (this.writtenOffset === this.size && this.expectedHash !== null) {
      // Verification was interrupted; the sender will re-send finish.
      this.expectedHash = null;
    }
    this.setState(this.paused ? 'paused' : 'transferring');
  }

  protected onTerminal(): void {
    this.queue.length = 0;
    if (this.state !== 'completed') void this.sink?.abort(this.state);
    this.hasher?.dispose?.();
  }
}
