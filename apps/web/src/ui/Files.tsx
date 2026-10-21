import { useMemo, useRef, useState } from 'react';
import { formatBytes, formatDuration, formatRate } from '@landrop/shared';
import { isTerminal } from '@landrop/transfer-core';
import type { TransferView } from '../core/state.ts';
import { useApp, useAppState } from './context.tsx';
import { transferStateLabel } from './labels.ts';
import { Button, Icon, Progress } from './primitives.tsx';

export function TransferItem({ t }: { t: TransferView }) {
  const app = useApp();
  const caps = useAppState((s) => s.caps);
  const svc = app.transfer;
  const terminal = isTerminal(t.state);
  const out = t.direction === 'out';
  const tone = t.state === 'completed' ? 'green' : t.state === 'failed' ? 'red' : t.state === 'paused' || t.state === 'reconnecting' ? 'amber' : 'blue';
  const showProgress = !terminal || t.state === 'completed' || t.bytesWritten > 0;
  const fitsMemory = t.size <= svc.memoryAvailable();

  return (
    <li className="rounded-xl p-3 ring-1 ring-slate-200 dark:ring-slate-800" data-testid="transfer" data-state={t.state} data-direction={t.direction}>
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${out ? 'bg-accent-50 text-accent-700 dark:bg-slate-800 dark:text-accent-100' : 'bg-emerald-50 text-emerald-700 dark:bg-slate-800 dark:text-emerald-300'}`}
        >
          <Icon name={out ? 'upload' : 'download'} className="h-4 w-4" label={out ? 'Sending' : 'Receiving'} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={t.name} data-testid="transfer-name">
            {t.name}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            <span data-testid="transfer-state">{transferStateLabel(t)}</span>
            {t.error && <span className="text-red-700 dark:text-red-300"> — {t.error.message}</span>}
          </p>
          {showProgress && (
            <div className="mt-2 space-y-1">
              <Progress value={t.bytesWritten} max={t.size} tone={tone} label={`${t.name} progress`} />
              <p className="flex flex-wrap justify-between gap-x-3 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                <span>
                  {formatBytes(t.bytesWritten)} of {formatBytes(t.size)} {out ? 'written by receiver' : 'written'}
                </span>
                {t.state === 'transferring' && t.rateBps > 0 && (
                  <span>
                    {formatRate(t.rateBps)}
                    {t.etaSeconds !== null && ` · ${formatDuration(t.etaSeconds)} left`}
                  </span>
                )}
              </p>
            </div>
          )}
          {!out && t.state === 'awaiting_acceptance' && (
            <div className="mt-2 flex flex-wrap gap-2">
              {caps.streamingSink ? (
                <Button size="sm" variant="primary" onClick={() => svc.acceptWithDialog(t.id)}>
                  Save as…
                </Button>
              ) : (
                <Button size="sm" variant="primary" disabled={!fitsMemory} onClick={() => svc.acceptInMemory(t.id)}>
                  Accept
                </Button>
              )}
              <Button size="sm" onClick={() => svc.reject(t.id)}>
                Decline
              </Button>
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {t.state === 'transferring' && (
            <Button size="sm" variant="ghost" onClick={() => svc.pause(t.id)} aria-label={`Pause ${t.name}`}>
              <Icon name="pause" className="h-4 w-4" />
            </Button>
          )}
          {t.state === 'paused' && (
            <Button size="sm" variant="ghost" onClick={() => svc.resume(t.id)} aria-label={`Resume ${t.name}`}>
              <Icon name="play" className="h-4 w-4" />
            </Button>
          )}
          {t.savable && (
            <Button size="sm" variant="ghost" onClick={() => svc.save(t.id)} aria-label={`Save ${t.name}`}>
              <Icon name="download" className="h-4 w-4" />
            </Button>
          )}
          {out && (t.state === 'failed' || t.state === 'cancelled') && (
            <Button size="sm" variant="ghost" onClick={() => svc.retry(t.id)} aria-label={`Retry ${t.name}`}>
              <Icon name="retry" className="h-4 w-4" />
            </Button>
          )}
          {!terminal && t.state !== 'awaiting_acceptance' && (
            <Button size="sm" variant="ghost" onClick={() => svc.cancel(t.id)} aria-label={`Cancel ${t.name}`}>
              <Icon name="x" className="h-4 w-4" />
            </Button>
          )}
          {out && t.state === 'awaiting_acceptance' && (
            <Button size="sm" variant="ghost" onClick={() => svc.cancel(t.id)} aria-label={`Cancel ${t.name}`}>
              <Icon name="x" className="h-4 w-4" />
            </Button>
          )}
          {terminal && (
            <Button size="sm" variant="ghost" onClick={() => svc.dismiss(t.id)} aria-label={`Remove ${t.name} from list`}>
              <Icon name="trash" className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <details className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        <summary className="cursor-pointer select-none">Details</summary>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt>Size</dt>
          <dd className="tabular-nums">{t.size.toLocaleString()} bytes</dd>
          <dt>Destination</dt>
          <dd>{t.sink === 'streaming' ? 'Streamed to disk' : t.sink === 'memory' ? 'Browser memory' : '—'}</dd>
          <dt>Attempts</dt>
          <dd>{t.attempt}</dd>
          {t.startedAt && t.finishedAt && (
            <>
              <dt>Duration</dt>
              <dd>{formatDuration((t.finishedAt - t.startedAt) / 1000)}</dd>
            </>
          )}
          <dt>SHA-256</dt>
          <dd className="break-all font-mono" data-testid="transfer-sha256">
            {t.sha256 ?? (t.state === 'completed' ? '—' : 'computed during transfer')}
          </dd>
        </dl>
      </details>
      {t.state === 'cancelled' && !out && t.sink && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">The partial file was discarded.</p>
      )}
    </li>
  );
}

export function Files({ peerId }: { peerId: string }) {
  const app = useApp();
  const transfers = useAppState((s) => s.transfers);
  const order = useAppState((s) => s.transferOrder);
  const linkUp = useAppState((s) => s.peers[peerId]?.link === 'connected');
  const remoteCaps = useAppState((s) => s.peers[peerId]?.remoteCaps ?? null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const mine = useMemo(() => order.map((id) => transfers[id]!).filter((t) => t && t.peerId === peerId).reverse(), [order, transfers, peerId]);
  const active = mine.filter((t) => !isTerminal(t.state));
  const totals = active.reduce((acc, t) => ({ size: acc.size + t.size, done: acc.done + t.bytesWritten }), { size: 0, done: 0 });
  const batches = [...new Set(active.filter((t) => t.direction === 'out' && t.batchId).map((t) => t.batchId!))];

  const pick = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    app.sendFiles([...list]);
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const { files, skippedFolders } = droppedFiles(e.dataTransfer);
          if (skippedFolders > 0) app.notify('error', 'Folders are not supported yet. Select the files inside instead.');
          if (files.length) app.sendFiles(files);
        }}
        className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragging ? 'border-accent-500 bg-accent-50 dark:bg-slate-800' : 'border-slate-300 dark:border-slate-700'
        }`}
      >
        <Icon name="upload" className="h-8 w-8 text-slate-400" />
        <p className="mt-2 text-sm font-medium">Drop files here</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">or</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          data-testid="file-input"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            pick(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
        <Button className="mt-2" variant="primary" onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400" role="status">
          {!linkUp
            ? 'Files you add now are queued until the direct connection is ready.'
            : remoteCaps
              ? 'The receiver must accept each file before any data is sent.'
              : 'Waiting for the device to report what it can receive…'}
        </p>
      </div>

      {active.length > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
          <span className="tabular-nums">
            {active.length} active · {formatBytes(totals.done)} of {formatBytes(totals.size)}
          </span>
          {batches.map((b) => (
            <Button key={b} size="sm" onClick={() => app.transfer.cancelBatch(b)}>
              Cancel batch
            </Button>
          ))}
        </div>
      )}

      {mine.length === 0 ? (
        <p className="text-center text-sm text-slate-500 dark:text-slate-400">No transfers with this device yet.</p>
      ) : (
        <ul className="space-y-2" aria-label="Transfers">
          {mine.map((t) => (
            <TransferItem key={t.id} t={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Files from a drop, skipping directories (folder transfer is not supported). */
function droppedFiles(dt: DataTransfer): { files: File[]; skippedFolders: number } {
  const files: File[] = [];
  let skippedFolders = 0;
  for (const item of dt.items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      skippedFolders++;
      continue;
    }
    const f = item.getAsFile();
    if (f) files.push(f);
  }
  return { files, skippedFolders };
}

/** Transfers whose peer is no longer in the room, so their outcome stays visible. */
export function DepartedTransfers() {
  const transfers = useAppState((s) => s.transfers);
  const order = useAppState((s) => s.transferOrder);
  const peers = useAppState((s) => s.peers);
  const list = useMemo(() => order.map((id) => transfers[id]!).filter((t) => t && !peers[t.peerId]).reverse(), [order, transfers, peers]);
  if (list.length === 0) return null;
  return (
    <section className="mt-6" aria-labelledby="departed-h">
      <h2 id="departed-h" className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
        Transfers with devices that left
      </h2>
      <ul className="space-y-2">
        {list.map((t) => (
          <TransferItem key={t.id} t={t} />
        ))}
      </ul>
    </section>
  );
}
