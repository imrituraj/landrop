import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '@landrop/shared';
import { DEFAULT_SETTINGS } from '../core/capabilities.ts';
import { useApp, useAppState } from './context.tsx';
import { kindLabel } from './labels.ts';
import { Button, Callout, Dialog } from './primitives.tsx';

/** Incoming offers awaiting a decision, from any peer. */
export function IncomingDialog() {
  const app = useApp();
  const transfers = useAppState((s) => s.transfers);
  const order = useAppState((s) => s.transferOrder);
  const peers = useAppState((s) => s.peers);
  const caps = useAppState((s) => s.caps);
  const reserved = useAppState((s) => s.memoryReservedBytes);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const pending = useMemo(
    () => order.map((id) => transfers[id]!).filter((t) => t && t.direction === 'in' && t.state === 'awaiting_acceptance'),
    [order, transfers],
  );
  const visible = pending.filter((t) => !hidden.has(t.id));
  const open = visible.length > 0;
  const total = visible.reduce((n, t) => n + t.size, 0);
  const memoryLeft = Math.max(0, caps.memorySinkMaxBytes - reserved);
  const svc = app.transfer;

  const acceptAllToFolder = () => {
    // Directory picker must be opened directly from the click.
    window.showDirectoryPicker({ id: 'landrop-receive', mode: 'readwrite' }).then(
      (dir) => void svc.acceptIntoDirectory(visible.map((t) => t.id), dir),
      (err: unknown) => {
        if ((err as Error).name !== 'AbortError') app.notify('error', 'Could not open that folder.');
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={() => setHidden(new Set(pending.map((t) => t.id)))}
      title={visible.length === 1 ? 'Incoming file' : `${visible.length} incoming files`}
      wide
      footer={
        visible.length > 1 ? (
          <>
            <Button onClick={() => visible.forEach((t) => svc.reject(t.id))}>Decline all</Button>
            {caps.streamingSink && caps.directoryPicker ? (
              <Button variant="primary" onClick={acceptAllToFolder}>
                Save all to folder…
              </Button>
            ) : !caps.streamingSink ? (
              <Button variant="primary" disabled={total > memoryLeft} onClick={() => visible.forEach((t) => svc.acceptInMemory(t.id))}>
                Accept all ({formatBytes(total)})
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <ul className="space-y-2">
          {visible.map((t) => {
            const from = peers[t.peerId];
            const fits = t.size <= memoryLeft;
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 rounded-xl p-3 ring-1 ring-slate-200 dark:ring-slate-800" data-testid="incoming-offer">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={t.name}>
                    {t.name}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {formatBytes(t.size)} from {from ? `${from.deviceName} (${kindLabel[from.deviceKind]})` : 'a device that left'}
                  </p>
                  {!caps.streamingSink && !fits && (
                    <p className="mt-1 text-xs text-red-700 dark:text-red-300">Too large to receive in memory on this browser.</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => svc.reject(t.id)}>
                    Decline
                  </Button>
                  {caps.streamingSink ? (
                    <Button size="sm" variant="primary" onClick={() => svc.acceptWithDialog(t.id)}>
                      Save as…
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" disabled={!fits} onClick={() => svc.acceptInMemory(t.id)}>
                      Accept
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {!caps.streamingSink && (
          <Callout tone="info">
            {caps.streamingDisabledByUser
              ? 'Saving directly to disk is turned off in settings, so files are received into memory first.'
              : caps.secureContext
                ? 'This browser cannot save directly to disk, so files are received into memory first.'
                : 'Saving directly to disk requires HTTPS, so files are received into memory first.'}{' '}
            Up to {formatBytes(memoryLeft)} is available. Use the Save button after the transfer to keep the file.
          </Callout>
        )}
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Only accept files you expect. Device names are chosen by the sender and are not verified. LanDrop never opens received files.
        </p>
      </div>
    </Dialog>
  );
}

export function JoinRequestsDialog() {
  const app = useApp();
  const requests = useAppState((s) => s.joinRequests);
  const r = requests[0];
  return (
    <Dialog
      open={!!r}
      onClose={() => r && app.answerJoinRequest(r.requestId, false)}
      title="A device wants to join"
      footer={
        r && (
          <>
            <Button onClick={() => app.answerJoinRequest(r.requestId, false)}>Deny</Button>
            <Button variant="primary" onClick={() => app.answerJoinRequest(r.requestId, true)}>
              Approve
            </Button>
          </>
        )
      }
    >
      {r && (
        <div className="space-y-3 text-sm">
          <p>
            <strong className="font-semibold">{r.deviceName}</strong> ({kindLabel[r.deviceKind]}) entered this room's code and is asking to
            join.
          </p>
          <Callout tone="warn">
            The name is chosen by that device and is not verified. Approve only if you are expecting this device right now.
          </Callout>
        </div>
      )}
    </Dialog>
  );
}

export function RenameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const name = useAppState((s) => s.identity.deviceName);
  const [value, setValue] = useState(name);
  useEffect(() => {
    if (open) setValue(name);
  }, [open, name]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rename this device"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={value.trim() === ''}
            onClick={() => {
              app.rename(value);
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <label className="text-sm" htmlFor="rename-input">
        Name shown to other devices
      </label>
      <input
        id="rename-input"
        value={value}
        maxLength={40}
        onChange={(e) => setValue(e.target.value)}
        className="mt-2 block min-h-11 w-full rounded-lg border-0 bg-slate-50 px-3 text-sm ring-1 ring-inset ring-slate-300 dark:bg-slate-800 dark:ring-slate-600"
      />
    </Dialog>
  );
}

export function SettingsDialog({
  open,
  onClose,
  theme,
  setTheme,
}: {
  open: boolean;
  onClose: () => void;
  theme: 'system' | 'light' | 'dark';
  setTheme: (t: 'system' | 'light' | 'dark') => void;
}) {
  const app = useApp();
  const settings = useAppState((s) => s.settings);
  const caps = useAppState((s) => s.caps);
  const update = (patch: Partial<typeof settings>) => app.updateSettings({ ...settings, ...patch });

  const exportDiagnostics = () => {
    const blob = new Blob([app.diagnostics()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `landrop-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const row = 'flex items-center justify-between gap-4 py-3';
  return (
    <Dialog open={open} onClose={onClose} title="Settings" wide>
      <div className="divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <div className={row}>
          <label htmlFor="theme">Theme</label>
          <select
            id="theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value as typeof theme)}
            className="min-h-11 rounded-lg bg-slate-50 px-3 ring-1 ring-slate-300 dark:bg-slate-800 dark:ring-slate-600"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <div className={row}>
          <div>
            <label htmlFor="streaming">Save incoming files directly to disk</label>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {caps.saveFilePicker
                ? 'Uses the File System Access API. Turn off to receive into memory instead.'
                : caps.secureContext
                  ? 'Not supported by this browser.'
                  : 'Requires HTTPS. See the deployment guide.'}
            </p>
          </div>
          <input
            id="streaming"
            type="checkbox"
            className="h-5 w-5"
            disabled={!caps.saveFilePicker}
            checked={caps.saveFilePicker && !settings.disableStreaming}
            onChange={(e) => update({ disableStreaming: !e.target.checked })}
          />
        </div>
        <div className={row}>
          <div>
            <label htmlFor="memlimit">In-memory receive limit</label>
            <p className="text-xs text-slate-500 dark:text-slate-400">Applies when files cannot be streamed to disk. Currently {formatBytes(caps.memorySinkMaxBytes)}.</p>
          </div>
          <select
            id="memlimit"
            value={settings.memoryLimitMiB}
            onChange={(e) => update({ memoryLimitMiB: Number(e.target.value) })}
            className="min-h-11 rounded-lg bg-slate-50 px-3 ring-1 ring-slate-300 dark:bg-slate-800 dark:ring-slate-600"
          >
            <option value={0}>Automatic</option>
            {[64, 128, 256, 512, 1024].map((v) => (
              <option key={v} value={v}>
                {v} MiB
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <label htmlFor="concurrency">Files sent at the same time</label>
          <select
            id="concurrency"
            value={settings.concurrency}
            onChange={(e) => update({ concurrency: Number(e.target.value) })}
            className="min-h-11 rounded-lg bg-slate-50 px-3 ring-1 ring-slate-300 dark:bg-slate-800 dark:ring-slate-600"
          >
            {[1, 2, 3, 4].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="py-3">
          <p className="font-medium">This browser</p>
          <ul className="mt-1 grid grid-cols-2 gap-x-4 text-xs text-slate-600 dark:text-slate-400">
            <li>
              {caps.browser} on {caps.os}
            </li>
            <li>Secure context (HTTPS): {caps.secureContext ? 'yes' : 'no'}</li>
            <li>WebRTC: {caps.webrtc ? 'yes' : 'no'}</li>
            <li>Save to disk API: {caps.saveFilePicker ? 'yes' : 'no'}</li>
            <li>Folder picker: {caps.directoryPicker ? 'yes' : 'no'}</li>
            <li>Background workers: {caps.workers ? 'yes' : 'no'}</li>
          </ul>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Keep this tab open and in the foreground during transfers. Mobile browsers may pause pages in the background, which stops
            transfers.
          </p>
        </div>
        <div className="py-3">
          <p className="font-medium">Diagnostics</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Downloads connection states, error codes, sizes, and timings. It excludes chat messages, file names and contents, device names,
            room links and codes, and IP addresses.
          </p>
          <Button size="sm" className="mt-2" onClick={exportDiagnostics}>
            Download diagnostics
          </Button>
        </div>
        <div className="py-3 text-xs text-slate-600 dark:text-slate-400">
          <p className="font-medium text-slate-800 dark:text-slate-200">Security</p>
          <p className="mt-1">
            Connections between devices are encrypted (WebRTC DTLS). LanDrop does not verify who is on the other device: anyone with the
            invitation link can join, and the LanDrop server itself is trusted to introduce the right devices. Received files are checked
            with SHA-256 against what the sender read.
          </p>
        </div>
        <div className="flex justify-end pt-3">
          <Button size="sm" variant="ghost" onClick={() => app.updateSettings(DEFAULT_SETTINGS)}>
            Reset settings
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
