import type { ErrorCode, SinkKind } from '@landrop/protocol';
import { Condition } from './flow.ts';
import { assertTransition, isTerminal, type Role, type TransferState } from './state.ts';
import {
  errorInfo,
  type Direction,
  type EngineConfig,
  type PeerMessageBody,
  type TransferErrorInfo,
  type TransferSnapshot,
  type WaitTimings,
} from './types.ts';

export interface TransferHooks {
  sendControl(msg: PeerMessageBody): boolean;
  onChange(): void;
}

/** Shared state handling for both directions. */
export abstract class TransferBase {
  readonly id: string;
  readonly peerId: string;
  readonly batchId: string | null;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly createdAt: number;
  abstract readonly direction: Direction;
  protected abstract readonly role: Role;

  state: TransferState;
  attempt = 0;
  paused = false;
  error: TransferErrorInfo | null = null;
  startedAt: number | null = null;
  finishedAt: number | null = null;
  sha256: string | null = null;
  sinkKind: SinkKind | null = null;
  readonly waits: WaitTimings = { read: 0, sendQueue: 0, credit: 0, hash: 0, write: 0 };

  protected readonly cond = new Condition();
  protected readonly abort = new AbortController();
  protected readonly hooks: TransferHooks;
  protected readonly config: EngineConfig;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    init: { id: string; peerId: string; batchId: string | null; name: string; size: number; mime: string },
    initial: TransferState,
    hooks: TransferHooks,
    config: EngineConfig,
  ) {
    this.id = init.id;
    this.peerId = init.peerId;
    this.batchId = init.batchId;
    this.name = init.name;
    this.size = init.size;
    this.mime = init.mime;
    this.state = initial;
    this.hooks = hooks;
    this.config = config;
    this.createdAt = Date.now();
  }

  /** Current state, read through a call so TypeScript does not keep a stale narrowing across awaits. */
  stateNow(): TransferState {
    return this.state;
  }

  get terminal(): boolean {
    return isTerminal(this.state);
  }

  abstract get bytesTransferred(): number;
  abstract get bytesWritten(): number;

  snapshot(): TransferSnapshot {
    return {
      id: this.id,
      peerId: this.peerId,
      direction: this.direction,
      batchId: this.batchId,
      name: this.name,
      size: this.size,
      mime: this.mime,
      state: this.state,
      attempt: this.attempt,
      bytesTransferred: this.bytesTransferred,
      bytesWritten: this.bytesWritten,
      paused: this.paused,
      sink: this.sinkKind,
      error: this.error,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      sha256: this.sha256,
      waits: { ...this.waits },
    };
  }

  /** Await `p` and add the elapsed time to a wait bucket. */
  protected async timed<T>(bucket: keyof WaitTimings, p: Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await p;
    } finally {
      this.waits[bucket] += performance.now() - t0;
    }
  }

  protected setState(to: TransferState): void {
    if (this.state === to) return;
    assertTransition(this.role, this.state, to);
    this.state = to;
    if (to === 'transferring' && this.startedAt === null) this.startedAt = Date.now();
    if (isTerminal(to)) {
      this.finishedAt = Date.now();
      this.clearAllTimers();
      this.abort.abort();
      this.onTerminal();
    }
    this.cond.notify();
    this.hooks.onChange();
  }

  /** Called once when a terminal state is entered. */
  protected abstract onTerminal(): void;

  protected send(msg: PeerMessageBody): boolean {
    return this.hooks.sendControl(msg);
  }

  /**
   * Fail locally. If `notifyRemote`, tell the peer with transfer:error so it does
   * not wait for a timeout.
   */
  fail(code: ErrorCode, opts: { remote?: boolean; notifyRemote?: boolean } = {}): void {
    if (this.terminal) return;
    this.error = errorInfo(code, opts.remote ?? false);
    if (opts.notifyRemote ?? !opts.remote) this.send({ type: 'transfer:error', id: this.id, code });
    this.setState('failed');
  }

  protected setTimer(name: string, ms: number, fn: () => void): void {
    this.clearTimer(name);
    const t = setTimeout(() => {
      this.timers.delete(name);
      if (!this.terminal) fn();
    }, ms);
    this.timers.set(name, t);
  }

  protected clearTimer(name: string): void {
    const t = this.timers.get(name);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(name);
  }

  private clearAllTimers(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
