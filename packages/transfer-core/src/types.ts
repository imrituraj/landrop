import { ERROR_MESSAGES, type DistributiveOmit, type ErrorCode, type PeerMessage, type SinkKind } from '@landrop/protocol';
import type { TransferState } from './state.ts';

export type PeerMessageBody = DistributiveOmit<PeerMessage, 'v'>;

/** Random-access, bounded reads from the file being sent (e.g. File.slice()). */
export interface FileSource {
  readonly size: number;
  /** Must return exactly `length` bytes or reject. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface FileMeta {
  name: string;
  size: number;
  mime: string;
  lastModified?: number;
}

export interface TransferTimings {
  /** How long the receiver has to accept/reject an offer. */
  acceptTimeoutMs: number;
  /** Max time without receiver ack progress while data is outstanding. */
  ackTimeoutMs: number;
  /** Max time between transfer:finish and transfer:verified. */
  verifyTimeoutMs: number;
  /** Max time to re-establish the data channel and resume. */
  reconnectTimeoutMs: number;
}

export interface EngineConfig {
  timings: TransferTimings;
  /** Local RTC send-queue high-water mark (bytes). */
  highWaterBytes: number;
  /** Low-water mark used for bufferedAmountLowThreshold (bytes). */
  lowWaterBytes: number;
  /** Largest payload per frame we will send or accept. */
  maxChunkBytes: number;
  /** Receiver credit window we grant as a receiver (bytes). */
  windowBytes: number;
  /** Receiver: max offers awaiting a decision per peer. */
  maxPendingOffers: number;
  /** Receiver: offers accepted per minute per peer (burst = same). */
  offersPerMinute: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  timings: {
    acceptTimeoutMs: 10 * 60_000,
    ackTimeoutMs: 30_000,
    verifyTimeoutMs: 120_000,
    reconnectTimeoutMs: 60_000,
  },
  highWaterBytes: 4 * 1024 * 1024,
  lowWaterBytes: 1024 * 1024,
  maxChunkBytes: 256 * 1024 - 64,
  windowBytes: 16 * 1024 * 1024,
  maxPendingOffers: 50,
  offersPerMinute: 120,
};

export interface TransferErrorInfo {
  code: ErrorCode;
  message: string;
  /** True if the other peer reported it. */
  remote: boolean;
}

export function errorInfo(code: ErrorCode, remote = false): TransferErrorInfo {
  return { code, message: ERROR_MESSAGES[code], remote };
}

/** Engine-level failure carrying a stable code. */
export class TransferFailure extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, detail?: string) {
    super(detail ?? ERROR_MESSAGES[code]);
    this.name = 'TransferFailure';
    this.code = code;
  }
}

export type Direction = 'out' | 'in';

/** Cumulative milliseconds spent waiting on each stage (for diagnostics). */
export interface WaitTimings {
  read: number;
  sendQueue: number;
  credit: number;
  hash: number;
  write: number;
}

/** Immutable view for UIs and diagnostics. */
export interface TransferSnapshot {
  id: string;
  peerId: string;
  direction: Direction;
  batchId: string | null;
  name: string;
  size: number;
  mime: string;
  state: TransferState;
  attempt: number;
  /** Sender: bytes handed to the data channel. Receiver: bytes received from frames. */
  bytesTransferred: number;
  /** Bytes the receiver confirmed as written to its sink. */
  bytesWritten: number;
  paused: boolean;
  sink: SinkKind | null;
  error: TransferErrorInfo | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  sha256: string | null;
  waits: WaitTimings;
}
