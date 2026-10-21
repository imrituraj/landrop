import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { inviteUrl, isLoopbackOrigin } from '../core/controller.ts';
import { Chat } from './Chat.tsx';
import { useApp, useAppState } from './context.tsx';
import { DepartedTransfers, Files } from './Files.tsx';
import { kindLabel, linkLabel } from './labels.ts';
import { Badge, Button, Callout, Dialog, Icon } from './primitives.tsx';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function CopyField({ value, label, mono = true }: { value: string; label: string; mono?: boolean }) {
  const app = useApp();
  const canClipboard = useAppState((s) => s.caps.clipboardWrite);
  return (
    <div className="flex gap-2">
      <input
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className={`min-h-11 w-full min-w-0 rounded-lg border-0 bg-slate-50 px-3 text-sm ring-1 ring-inset ring-slate-300 dark:bg-slate-800 dark:ring-slate-600 ${mono ? 'font-mono' : ''}`}
      />
      <Button
        onClick={() => {
          if (!canClipboard) {
            app.notify('info', 'Select the text and copy it manually (clipboard access needs HTTPS).');
            return;
          }
          navigator.clipboard.writeText(value).then(
            () => app.notify('info', `${label} copied.`),
            () => app.notify('error', 'Copy failed. Select the text and copy it manually.'),
          );
        }}
        aria-label={`Copy ${label}`}
      >
        <Icon name="copy" className="h-4 w-4" />
      </Button>
    </div>
  );
}

function InvitePanel({ active }: { active: boolean }) {
  const app = useApp();
  const room = useAppState((s) => s.room);
  const publicOrigin = useAppState((s) => s.config?.publicOrigin ?? null);
  const [qr, setQr] = useState<string | null>(null);
  const now = useNow(1000);
  const url = room ? inviteUrl(room.roomId, room.secret, publicOrigin) : '';
  const loopback = !publicOrigin && isLoopbackOrigin();
  useEffect(() => {
    if (!active || !url) return;
    let cancelled = false;
    QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }).then(
      (svg) => !cancelled && setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`),
      () => !cancelled && setQr(null),
    );
    return () => {
      cancelled = true;
    };
  }, [active, url]);
  if (!room) return null;
  const codeLeft = room.codeExpiresAt ? Math.max(0, Math.round((room.codeExpiresAt - now) / 1000)) : 0;
  return (
    <div className="space-y-5">
      {loopback && (
        <Callout tone="warn" title="This link only works on this computer">
          You opened LanDrop as {location.host}, which other devices cannot reach. Open LanDrop using this computer's network address
          (shown in the server log, e.g. http://192.168.1.20:8787) or set PUBLIC_ORIGIN on the server, then invite from there.
        </Callout>
      )}
      <div className="flex flex-col items-center">
        {qr ? (
          <img src={qr} alt="QR code containing the room invitation link" className="h-56 w-56 rounded-lg bg-white p-2" />
        ) : (
          <div className="h-56 w-56 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" aria-hidden="true" />
        )}
        <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">Scan with the other device's camera.</p>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium">Invitation link</p>
        <CopyField value={url} label="Invitation link" />
      </div>
      <div>
        <p className="mb-1 text-sm font-medium">Room code</p>
        {room.code && codeLeft > 0 ? (
          <div className="flex items-center gap-3">
            <span className="font-mono text-2xl tracking-widest" aria-label={`Room code ${room.code.split('').join(' ')}`}>
              {room.code}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              expires in {Math.floor(codeLeft / 60)}:{String(codeLeft % 60).padStart(2, '0')}
            </span>
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">The code has expired.</p>
        )}
        <Button size="sm" className="mt-2" onClick={() => app.refreshCode()}>
          New code
        </Button>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Joining by code needs your approval on this screen.</p>
      </div>
      <Callout tone="warn">
        The link and QR code grant access to this room without approval. Share them only with your own devices or people you trust.
      </Callout>
    </div>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Invite a device">
      <InvitePanel active={open} />
    </Dialog>
  );
}

function DeviceList() {
  const app = useApp();
  const peers = useAppState((s) => s.peers);
  const order = useAppState((s) => s.peerOrder);
  const selected = useAppState((s) => s.selectedPeerId);
  const unread = useAppState((s) => s.unread);
  if (order.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
        <p className="font-medium text-slate-800 dark:text-slate-200">No other devices yet</p>
        <p className="mt-1">Open the invitation on another device on this network. It will appear here when it joins.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-2" aria-label="Devices in this room">
      {order.map((id) => {
        const p = peers[id]!;
        const l = linkLabel(p);
        const isSel = id === selected;
        const u = unread[id] ?? 0;
        return (
          <li key={id}>
            <button
              type="button"
              onClick={() => app.selectPeer(id)}
              aria-pressed={isSel}
              aria-label={`${p.deviceName}, ${kindLabel[p.deviceKind]}, ${l.text}${u ? `, ${u} unread messages` : ''}`}
              className={`flex w-full items-center gap-3 rounded-xl p-3 text-left ring-1 transition-colors ${
                isSel
                  ? 'bg-accent-50 ring-accent-500 dark:bg-slate-800 dark:ring-accent-500'
                  : 'bg-white ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:ring-slate-800 dark:hover:bg-slate-800'
              }`}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                <Icon name={p.deviceKind} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.deviceName}</span>
                <span className="mt-1 block">
                  <Badge tone={l.tone}>{l.text}</Badge>
                </span>
              </span>
              {u > 0 && (
                <span className="rounded-full bg-accent-600 px-2 py-0.5 text-xs font-semibold text-white" aria-hidden="true">
                  {u}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PeerPanel({ peerId }: { peerId: string }) {
  const app = useApp();
  const peer = useAppState((s) => s.peers[peerId]);
  const [tab, setTab] = useState<'files' | 'chat'>('files');
  const unread = useAppState((s) => s.unread[peerId] ?? 0);
  if (!peer) return null;
  const l = linkLabel(peer);
  const caps = peer.remoteCaps;
  return (
    <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800" aria-label={`Device ${peer.deviceName}`}>
      <div className="flex flex-wrap items-start gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{peer.deviceName}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <Badge tone={l.tone}>{l.text}</Badge>
            <span>{l.detail}</span>
          </p>
          {caps && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {caps.streamingSink
                ? 'Their browser saves incoming files directly to disk.'
                : `Their browser keeps incoming files in memory: files over ${Math.round(caps.maxAcceptBytes / 1048576)} MiB will be refused before sending.`}
            </p>
          )}
        </div>
        {peer.link === 'unavailable' ? (
          <Button size="sm" onClick={() => app.retryLink(peerId)}>
            <Icon name="retry" className="h-4 w-4" /> Retry connection
          </Button>
        ) : (
          peer.link === 'connected' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => app.retryLink(peerId)}
              title="Build a fresh connection. Active transfers pause briefly and resume where the receiver left off."
            >
              <Icon name="retry" className="h-4 w-4" /> Reconnect
            </Button>
          )
        )}
      </div>
      <div className="flex gap-1 border-b border-slate-200 px-4 xl:hidden dark:border-slate-800" role="tablist" aria-label="Files or chat">
        {(['files', 'chat'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`min-h-11 border-b-2 px-3 text-sm font-medium ${tab === t ? 'border-accent-600 text-accent-700 dark:text-accent-100' : 'border-transparent text-slate-500'}`}
          >
            {t === 'files' ? 'Files' : `Chat${unread ? ` (${unread})` : ''}`}
          </button>
        ))}
      </div>
      <div className="grid xl:grid-cols-[1fr_380px]">
        <div className={`${tab === 'files' ? 'block' : 'hidden'} p-4 xl:block`}>
          <Files peerId={peerId} />
        </div>
        <div className={`${tab === 'chat' ? 'block' : 'hidden'} border-slate-200 xl:block xl:border-l dark:border-slate-800`}>
          <Chat peerId={peerId} />
        </div>
      </div>
    </section>
  );
}

export function RoomView() {
  const app = useApp();
  const selected = useAppState((s) => s.selectedPeerId);
  const count = useAppState((s) => s.peerOrder.length);
  const maxPeers = useAppState((s) => s.room?.maxPeers ?? 0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <aside className="space-y-4">
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Room</h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {count + 1} of {maxPeers} devices
            </span>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" className="flex-1" onClick={() => setInviteOpen(true)}>
              <Icon name="qr" className="h-4 w-4" /> Invite
            </Button>
            <Button onClick={() => setLeaveOpen(true)}>Leave</Button>
          </div>
        </div>
        <DeviceList />
      </aside>
      <div>
        {selected ? (
          <PeerPanel peerId={selected} />
        ) : count === 0 ? (
          <section className="mx-auto max-w-md rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800" aria-labelledby="invite-h">
            <h2 id="invite-h" className="mb-4 text-lg font-semibold">
              Invite your other device
            </h2>
            <InvitePanel active={!inviteOpen} />
          </section>
        ) : (
          <div className="flex h-full min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
            Select a device to send files or chat.
          </div>
        )}
        <DepartedTransfers />
      </div>
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <Dialog
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        title="Leave this room?"
        footer={
          <>
            <Button onClick={() => setLeaveOpen(false)}>Stay</Button>
            <Button
              variant="danger"
              onClick={() => {
                setLeaveOpen(false);
                app.leaveRoom();
              }}
            >
              Leave room
            </Button>
          </>
        }
      >
        <p className="text-sm">Active transfers with devices in this room will stop, and chat history will be cleared.</p>
      </Dialog>
    </div>
  );
}
