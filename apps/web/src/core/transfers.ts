import type { Capabilities, PeerMessage } from '@landrop/protocol';
import {
  DEFAULT_ENGINE_CONFIG,
  MemorySink,
  PeerTransferManager,
  RateMeter,
  SlotScheduler,
  isTerminal,
  newBatchId,
  type EngineConfig,
  type IncomingTransfer,
  type OutgoingTransfer,
  type ReceiveSink,
  type SendChannel,
  type TransferBase,
} from '@landrop/transfer-core';
import { toWireCapabilities, type LocalCapabilities } from './capabilities.ts';
import { createHasher } from './hash-client.ts';
import { log, tag } from './log.ts';
import type { PeerLink } from './peer-link.ts';
import { BlobFileSource, downloadBlob, openSinkInDirectory, pickSaveSink } from './sinks.ts';
import type { TransferView } from './state.ts';

/** Adapts RTCDataChannel to the engine's SendChannel. */
class RtcSendChannel implements SendChannel {
  private readonly ch: RTCDataChannel;

  constructor(ch: RTCDataChannel, lowWater: number) {
    this.ch = ch;
    ch.bufferedAmountLowThreshold = lowWater;
  }

  get bufferedAmount(): number {
    return this.ch.bufferedAmount;
  }

  isOpen(): boolean {
    return this.ch.readyState === 'open';
  }

  send(frame: Uint8Array<ArrayBuffer>): void {
    this.ch.send(frame);
  }

  onLow(listener: () => void): () => void {
    this.ch.addEventListener('bufferedamountlow', listener);
    return () => this.ch.removeEventListener('bufferedamountlow', listener);
  }
}

const UI_FLUSH_MS = 250;

export interface TransferServiceDeps {
  sendControl(peerId: string, raw: string): boolean;
  caps(): LocalCapabilities;
  publish(views: TransferView[], removed: string[], memoryReservedBytes: number): void;
  notify(kind: 'info' | 'error', text: string): void;
  onIncomingOffer(t: IncomingTransfer): void;
}

/**
 * Glue between the transfer engine and the app: one PeerTransferManager per
 * peer, a shared concurrency scheduler, in-memory result handling, and
 * throttled publication of progress (UI updates at most every 250 ms, never
 * per chunk).
 */
export class TransferService {
  private readonly managers = new Map<string, PeerTransferManager>();
  private readonly scheduler: SlotScheduler;
  private readonly meters = new Map<string, RateMeter>();
  private readonly memorySinks = new Map<string, MemorySink>();
  private readonly memoryReserved = new Map<string, number>();
  private readonly sources = new Map<string, File>();
  private readonly publishedState = new Map<string, string>();
  private readonly dirty = new Set<TransferBase>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly config: EngineConfig;
  private readonly deps: TransferServiceDeps;

  constructor(deps: TransferServiceDeps, concurrency: number) {
    this.deps = deps;
    this.config = DEFAULT_ENGINE_CONFIG;
    this.scheduler = new SlotScheduler(concurrency);
  }

  setConcurrency(n: number): void {
    this.scheduler.setLimit(n);
  }

  manager(peerId: string): PeerTransferManager {
    let m = this.managers.get(peerId);
    if (!m) {
      m = new PeerTransferManager({
        peerId,
        config: this.config,
        scheduler: this.scheduler,
        localCapabilities: () => toWireCapabilities(this.deps.caps(), 0),
        sendControl: (raw) => this.deps.sendControl(peerId, raw),
        createHasher,
        onTransferChange: (t) => this.changed(t),
        onIncomingOffer: (t) => this.deps.onIncomingOffer(t),
      });
      this.managers.set(peerId, m);
    }
    return m;
  }

  private find(id: string): TransferBase | undefined {
    for (const m of this.managers.values()) {
      const t = m.outgoing.get(id) ?? m.incoming.get(id);
      if (t) return t;
    }
    return undefined;
  }

  get activeCount(): number {
    let n = 0;
    for (const m of this.managers.values()) {
      for (const t of [...m.outgoing.values(), ...m.incoming.values()]) if (!t.terminal) n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // Link events

  linkOpened(peerId: string, link: PeerLink): void {
    if (!link.file) return;
    this.manager(peerId).linkOpened(new RtcSendChannel(link.file, this.config.lowWaterBytes), link.maxMessageSize);
  }

  linkClosed(peerId: string): void {
    this.managers.get(peerId)?.linkClosed();
  }

  remoteCapabilities(peerId: string, caps: Capabilities): void {
    this.manager(peerId).setRemoteCapabilities(caps);
  }

  handleControl(peerId: string, msg: PeerMessage): void {
    this.manager(peerId).handleMessage(msg);
  }

  handleBinary(peerId: string, buf: ArrayBuffer): void {
    this.managers.get(peerId)?.handleFrame(buf);
  }

  peerGone(peerId: string): void {
    this.managers.get(peerId)?.peerGone();
  }

  // ---------------------------------------------------------------------------
  // User actions

  sendFiles(peerId: string, files: File[]): void {
    const m = this.manager(peerId);
    const batchId = files.length > 1 ? newBatchId() : null;
    for (const file of files) {
      const t = m.send(
        new BlobFileSource(file),
        { name: file.name, size: file.size, mime: file.type.slice(0, 255), lastModified: file.lastModified },
        batchId,
      );
      this.sources.set(t.id, file);
    }
  }

  /** Accept into a save dialog. Must be called directly from a click handler. */
  acceptWithDialog(id: string): void {
    const t = this.find(id);
    if (!t || t.direction !== 'in') return;
    void this.manager(t.peerId).accept(id, () => pickSaveSink(t.name));
  }

  /** Accept several offers into one directory picked once by the user. */
  async acceptIntoDirectory(ids: string[], dir: FileSystemDirectoryHandle): Promise<void> {
    for (const id of ids) {
      const t = this.find(id);
      if (!t || t.direction !== 'in') continue;
      await this.manager(t.peerId).accept(id, () => openSinkInDirectory(dir, t.name));
    }
  }

  memoryAvailable(): number {
    let reserved = 0;
    for (const v of this.memoryReserved.values()) reserved += v;
    return Math.max(0, this.deps.caps().memorySinkMaxBytes - reserved);
  }

  /** Accept into bounded memory. Refused (before any payload) if it would exceed the budget. */
  acceptInMemory(id: string): boolean {
    const t = this.find(id);
    if (!t || t.direction !== 'in' || t.state !== 'awaiting_acceptance') return false;
    if (t.size > this.memoryAvailable()) {
      this.deps.notify('error', 'Not enough in-memory space for this file. Save or remove earlier files, or use a browser that can save directly to disk.');
      return false;
    }
    this.memoryReserved.set(id, t.size);
    void this.manager(t.peerId).accept(id, async (): Promise<ReceiveSink> => {
      const sink = new MemorySink(t.size, this.deps.caps().memorySinkMaxBytes, t.mime || 'application/octet-stream');
      this.memorySinks.set(id, sink);
      return sink;
    });
    this.publishAll();
    return true;
  }

  reject(id: string): void {
    const t = this.find(id);
    if (t && t.direction === 'in') (t as IncomingTransfer).reject();
  }

  pause(id: string): void {
    const t = this.find(id) as OutgoingTransfer | IncomingTransfer | undefined;
    t?.pause();
  }

  resume(id: string): void {
    const t = this.find(id) as OutgoingTransfer | IncomingTransfer | undefined;
    t?.resume();
  }

  cancel(id: string): void {
    const t = this.find(id) as OutgoingTransfer | IncomingTransfer | undefined;
    t?.cancel();
  }

  cancelBatch(batchId: string): void {
    for (const m of this.managers.values()) {
      for (const t of [...m.outgoing.values(), ...m.incoming.values()]) {
        if (t.batchId === batchId && !t.terminal) t.cancel();
      }
    }
  }

  retry(id: string): void {
    const t = this.find(id);
    const file = this.sources.get(id);
    if (!t || t.direction !== 'out' || !file || !(t.state === 'failed' || t.state === 'cancelled')) return;
    this.dismiss(id);
    this.sendFiles(t.peerId, [file]);
  }

  save(id: string): void {
    const t = this.find(id);
    const blob = this.memorySinks.get(id)?.result();
    if (!t || !blob) return;
    downloadBlob(blob, t.name);
  }

  /** Remove a finished record and release any in-memory result. */
  dismiss(id: string): void {
    const t = this.find(id);
    if (!t || !t.terminal) return;
    this.memorySinks.get(id)?.release();
    this.memorySinks.delete(id);
    this.memoryReserved.delete(id);
    this.sources.delete(id);
    this.meters.delete(id);
    this.publishedState.delete(id);
    this.managers.get(t.peerId)?.remove(id);
    this.deps.publish([], [id], this.reservedTotal());
  }

  forgetPeer(peerId: string): void {
    const m = this.managers.get(peerId);
    if (!m) return;
    m.peerGone();
  }

  // ---------------------------------------------------------------------------
  // Publication

  private reservedTotal(): number {
    let n = 0;
    for (const v of this.memoryReserved.values()) n += v;
    return n;
  }

  private changed(t: TransferBase): void {
    if (isTerminal(t.state) && t.state !== 'completed') {
      // Failed/cancelled/rejected: release memory immediately.
      this.memorySinks.delete(t.id);
      this.memoryReserved.delete(t.id);
    }
    const prev = this.publishedState.get(t.id);
    if (prev !== t.state) {
      log.info(`transfer ${tag(t.id)} ${t.direction} ${prev ?? '-'} -> ${t.state}${t.error ? ` (${t.error.code})` : ''}`);
      if (isTerminal(t.state) && t.startedAt) {
        const w = t.waits;
        const ms = (t.finishedAt ?? Date.now()) - t.startedAt;
        log.info(
          `transfer ${tag(t.id)} ${t.size} B in ${ms} ms; waits ms: read ${w.read.toFixed(0)}, queue ${w.sendQueue.toFixed(0)}, credit ${w.credit.toFixed(0)}, hash ${w.hash.toFixed(0)}, write ${w.write.toFixed(0)}`,
        );
      }
      this.publishedState.set(t.id, t.state);
      this.dirty.add(t);
      this.flush();
      return;
    }
    this.dirty.add(t);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), UI_FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const views: TransferView[] = [];
    const now = Date.now();
    for (const t of this.dirty) views.push(this.view(t, now));
    this.dirty.clear();
    if (views.length) this.deps.publish(views, [], this.reservedTotal());
  }

  private publishAll(): void {
    for (const m of this.managers.values()) for (const t of [...m.outgoing.values(), ...m.incoming.values()]) this.dirty.add(t);
    this.flush();
  }

  private view(t: TransferBase, now: number): TransferView {
    const snap = t.snapshot();
    let meter = this.meters.get(t.id);
    if (!meter) {
      meter = new RateMeter(3000);
      this.meters.set(t.id, meter);
    }
    const active = t.state === 'transferring';
    const rate = active ? meter.sample(snap.bytesWritten, now) : 0;
    if (!active) meter.reset(snap.bytesWritten, now);
    const remaining = snap.size - snap.bytesWritten;
    const eta = active && rate > 1024 && snap.startedAt !== null && now - snap.startedAt > 2000 ? remaining / rate : null;
    return {
      ...snap,
      rateBps: rate,
      etaSeconds: eta,
      savable: t.state === 'completed' && Boolean(this.memorySinks.get(t.id)?.result()),
    };
  }
}
