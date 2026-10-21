import type { SinkKind } from '@landrop/protocol';

/**
 * Where received bytes go.
 *
 * `write` resolving means the sink accepted the bytes (e.g. the browser's
 * FileSystemWritableFileStream wrote them to its temporary swap file). It does
 * NOT mean the bytes are durably on physical media; nothing in the browser
 * gives us an fsync. "Acknowledged" in LanDrop therefore means "written to the
 * sink", not "durably checkpointed".
 */
export interface ReceiveSink {
  readonly kind: SinkKind;
  /** If false, writes must be strictly sequential (offset === bytes written so far). */
  readonly randomAccess: boolean;
  write(offset: number, data: Uint8Array): Promise<void>;
  /** Commit the file. Only called after integrity verification succeeded. */
  finalize(): Promise<void>;
  /** Discard partial data and release resources. Must be safe to call more than once. */
  abort(reason?: string): Promise<void>;
}

export class SinkError extends Error {
  readonly code: 'WRITE_FAILED' | 'QUOTA_EXCEEDED' | 'SINK_PERMISSION_DENIED' | 'TOO_LARGE_FOR_SINK';
  constructor(code: SinkError['code'], message: string) {
    super(message);
    this.name = 'SinkError';
    this.code = code;
  }
}

/** Maps DOMException names from storage APIs to stable error codes. */
export function classifyStorageError(err: unknown): SinkError['code'] {
  if (err instanceof SinkError) return err.code;
  const name = err instanceof Error ? err.name : '';
  if (name === 'QuotaExceededError') return 'QUOTA_EXCEEDED';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'SINK_PERMISSION_DENIED';
  return 'WRITE_FAILED';
}

/**
 * Bounded in-memory sink for browsers without a streaming file API.
 * Refuses anything above `maxBytes` *before* payload transfer (the engine checks
 * `maxBytes` at accept time) and again on every write as a second guard.
 */
export class MemorySink implements ReceiveSink {
  readonly kind = 'memory' as const;
  readonly randomAccess = false;
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  private written = 0;
  private done = false;
  private blob: Blob | null = null;
  private readonly expectedSize: number;
  private readonly maxBytes: number;
  private readonly mime: string;

  constructor(expectedSize: number, maxBytes: number, mime = 'application/octet-stream') {
    if (expectedSize > maxBytes) throw new SinkError('TOO_LARGE_FOR_SINK', 'file exceeds in-memory limit');
    this.expectedSize = expectedSize;
    this.maxBytes = maxBytes;
    this.mime = mime;
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (this.done) throw new SinkError('WRITE_FAILED', 'sink closed');
    if (offset !== this.written) throw new SinkError('WRITE_FAILED', 'non-sequential write to memory sink');
    if (this.written + data.byteLength > Math.min(this.maxBytes, this.expectedSize)) {
      throw new SinkError('TOO_LARGE_FOR_SINK', 'write past expected size');
    }
    // Copy: `data` may be a view into a larger received message buffer.
    this.chunks.push(new Uint8Array(data));
    this.written += data.byteLength;
  }

  async finalize(): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = [];
  }

  async abort(): Promise<void> {
    this.done = true;
    this.chunks = [];
    this.blob = null;
  }

  get bytesWritten(): number {
    return this.written;
  }

  /** The completed file, available after finalize(). */
  result(): Blob | null {
    return this.blob;
  }

  release(): void {
    this.blob = null;
  }
}
