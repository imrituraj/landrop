import { useEffect, useState } from 'react';
import type { AppController } from '../core/controller.ts';
import { ControllerContext, useApp, useAppState } from './context.tsx';
import { IncomingDialog, JoinRequestsDialog, RenameDialog, SettingsDialog } from './Dialogs.tsx';
import { Landing } from './Landing.tsx';
import { Badge, Button, Callout, Icon } from './primitives.tsx';
import { RoomView } from './RoomView.tsx';

type Theme = 'system' | 'light' | 'dark';

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem('landrop.theme');
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    mq.addEventListener('change', apply);
    try {
      localStorage.setItem('landrop.theme', theme);
    } catch {
      // ignore
    }
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}

function ServerPill() {
  const status = useAppState((s) => s.signaling.status);
  const map = {
    open: { tone: 'green', text: 'Server connected' },
    connecting: { tone: 'blue', text: 'Connecting to server…' },
    reconnecting: { tone: 'amber', text: 'Server reconnecting…' },
    closed: { tone: 'red', text: 'Server disconnected' },
  } as const;
  const m = map[status];
  return (
    <Badge tone={m.tone}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {m.text}
    </Badge>
  );
}

function Header({ onSettings, onRename }: { onSettings: () => void; onRename: () => void }) {
  const name = useAppState((s) => s.identity.deviceName);
  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="text-lg font-semibold tracking-tight">LanDrop</span>
        </div>
        <div className="hidden sm:block">
          <ServerPill />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onRename} aria-label={`This device: ${name}. Rename`}>
            <span className="max-w-[10rem] truncate">{name}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={onSettings} aria-label="Settings and diagnostics">
            <Icon name="settings" />
          </Button>
        </div>
      </div>
      <div className="px-4 pb-2 sm:hidden">
        <ServerPill />
      </div>
    </header>
  );
}

function Banners() {
  const configError = useAppState((s) => s.configError);
  const sig = useAppState((s) => s.signaling);
  const caps = useAppState((s) => s.caps);
  const inRoom = useAppState((s) => s.room !== null);
  return (
    <div className="mb-4 space-y-3 empty:hidden">
      {configError && (
        <Callout tone="error" title="Server unreachable">
          {configError} LanDrop needs its local server to find other devices. Check that this device is on the same network as the
          LanDrop host.
        </Callout>
      )}
      {sig.serverShutdown && (
        <Callout tone="warn" title="The LanDrop server is restarting">
          Rooms are kept in the server's memory only. If it restarts, create or join a room again. Direct connections that are already
          open may keep working until they close.
        </Callout>
      )}
      {sig.status === 'reconnecting' && inRoom && !sig.serverShutdown && (
        <Callout tone="warn">Lost contact with the LanDrop server. Reconnecting… Open direct connections keep working meanwhile.</Callout>
      )}
      {!caps.webrtc && (
        <Callout tone="error" title="WebRTC unavailable">
          This browser does not provide WebRTC data channels, so it cannot send or receive files with LanDrop.
        </Callout>
      )}
    </div>
  );
}

function Toasts() {
  const app = useApp();
  const notices = useAppState((s) => s.notices);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite" role="status">
      {notices.map((n) => (
        <div
          key={n.id}
          className={`pointer-events-auto flex max-w-md items-start gap-3 rounded-xl px-4 py-3 text-sm shadow-lg ring-1 ${
            n.kind === 'error'
              ? 'bg-red-50 text-red-900 ring-red-200 dark:bg-red-950 dark:text-red-100 dark:ring-red-900'
              : 'bg-white text-slate-900 ring-slate-200 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-700'
          }`}
        >
          <Icon name={n.kind === 'error' ? 'alert' : 'check'} className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{n.text}</span>
          <button type="button" onClick={() => app.dismissNotice(n.id)} aria-label="Dismiss notification" className="rounded p-0.5 opacity-70 hover:opacity-100">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

function Shell() {
  const inRoom = useAppState((s) => s.room !== null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  return (
    <div className="flex min-h-full flex-col">
      <a href="#main" className="sr-only-focusable absolute left-2 top-2 z-50 rounded bg-white px-3 py-2 text-sm shadow">
        Skip to content
      </a>
      <Header onSettings={() => setSettingsOpen(true)} onRename={() => setRenameOpen(true)} />
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Banners />
        {inRoom ? <RoomView /> : <Landing />}
      </main>
      <footer className="mx-auto w-full max-w-7xl px-4 pb-6 text-xs text-slate-500 dark:text-slate-400">
        Files travel directly between devices over encrypted WebRTC connections. The LanDrop server only introduces devices; it never
        receives files or messages.
      </footer>
      <Toasts />
      <IncomingDialog />
      <JoinRequestsDialog />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} setTheme={setTheme} />
      <RenameDialog open={renameOpen} onClose={() => setRenameOpen(false)} />
    </div>
  );
}

export function App({ app }: { app: AppController }) {
  return (
    <ControllerContext.Provider value={app}>
      <Shell />
    </ControllerContext.Provider>
  );
}
