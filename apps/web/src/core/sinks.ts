import { sanitizeFilename, withCollisionSuffix } from '@landrop/shared';
import type { FileSource, ReceiveSink } from '@landrop/transfer-core';

/**
 * Streaming sink backed by the File System Access API (Chromium desktop, secure
 * contexts only). Bytes go to the browser's temporary swap file as they arrive;
 * `close()` atomically moves it into place. `abort()` discards the swap file,
 * so cancelled or failed transfers leave no partial file behind.
 */
export class FileHandleSink implements ReceiveSink {
  readonly kind = 'streaming' as const;
  readonly randomAccess = true;
  private closed = false;
  private readonly writable: FileSystemWritableFileStream;

  private constructor(writable: FileSystemWritableFileStream) {
    this.writable = writable;
  }

  static async open(handle: FileSystemFileHandle): Promise<FileHandleSink> {
    const writable = await handle.createWritable({ keepExistingData: false });
    return new FileHandleSink(writable);
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    await this.writable.write({ type: 'write', position: offset, data: data as Uint8Array<ArrayBuffer> });
  }

  async finalize(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writable.close();
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writable.abort();
    } catch {
      // already closed/errored
    }
  }
}

/**
 * Prompts for a save location. MUST be called synchronously from a user
 * gesture (click handler) or the browser rejects with SecurityError.
 */
export function pickSaveSink(name: string): Promise<ReceiveSink> {
  const opts: SaveFilePickerOptions = { suggestedName: sanitizeFilename(name), id: 'landrop-save' };
  return window.showSaveFilePicker(opts).then((handle) => FileHandleSink.open(handle));
}

/** Creates a new, non-colliding file in a user-chosen directory. */
export async function openSinkInDirectory(dir: FileSystemDirectoryHandle, name: string): Promise<ReceiveSink> {
  const base = sanitizeFilename(name);
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : withCollisionSuffix(base, i);
    try {
      await dir.getFileHandle(candidate, { create: false });
      continue; // exists: never overwrite
    } catch (err) {
      if ((err as Error).name !== 'NotFoundError') throw err;
    }
    const handle = await dir.getFileHandle(candidate, { create: true });
    return FileHandleSink.open(handle);
  }
  throw Object.assign(new Error('too many name collisions'), { name: 'InvalidModificationError' });
}

/** Reads bounded slices of a File/Blob. Never loads the whole file. */
export class BlobFileSource implements FileSource {
  readonly size: number;
  private readonly blob: Blob;

  constructor(blob: Blob) {
    this.blob = blob;
    this.size = blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const buf = await this.blob.slice(offset, offset + length).arrayBuffer();
    return new Uint8Array(buf);
  }
}

/** Starts a download of an in-memory result. Never opens the file. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFilename(name);
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
