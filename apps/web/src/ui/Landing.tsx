import { useId, useState } from 'react';
import { useApp, useAppState } from './context.tsx';
import { Button, Callout, Icon } from './primitives.tsx';

export function Landing() {
  const app = useApp();
  const busy = useAppState((s) => s.busy);
  const roomError = useAppState((s) => s.roomError);
  const pending = useAppState((s) => s.joinPending);
  const ready = useAppState((s) => s.signaling.status === 'open');
  const caps = useAppState((s) => s.caps);
  const [input, setInput] = useState('');
  const inputId = useId();
  const errorId = useId();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Share files on your local network</h1>
        <p className="mx-auto mt-3 max-w-xl text-slate-600 dark:text-slate-400">
          Create a private room, open the invitation on your other device, and send files directly between them.
        </p>
      </div>

      {pending ? (
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          <h2 className="text-lg font-semibold">Waiting for approval</h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400" role="status">
            A device already in the room must approve this device. Ask them to check their screen.
          </p>
          <Button className="mt-4" onClick={() => app.cancelJoinRequest()}>
            Cancel request
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800" aria-labelledby="create-h">
            <h2 id="create-h" className="text-lg font-semibold">
              Start a room
            </h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">You get a link, QR code, and short code to invite your other devices.</p>
            <Button variant="primary" className="mt-5 w-full" disabled={!ready || busy !== null} onClick={() => app.createRoom()}>
              {busy === 'creating' ? 'Creating…' : 'Create room'}
            </Button>
          </section>

          <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800" aria-labelledby="join-h">
            <h2 id="join-h" className="text-lg font-semibold">
              Join a room
            </h2>
            <form
              className="mt-2"
              onSubmit={(e) => {
                e.preventDefault();
                app.join(input);
              }}
            >
              <label htmlFor={inputId} className="text-sm text-slate-600 dark:text-slate-400">
                Paste an invitation link or type a room code
              </label>
              <input
                id={inputId}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="7KQ2-M9XD"
                aria-describedby={roomError ? errorId : undefined}
                aria-invalid={roomError ? true : undefined}
                className="mt-2 block min-h-11 w-full rounded-lg border-0 bg-slate-50 px-3 font-mono text-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-accent-500 dark:bg-slate-800 dark:ring-slate-600"
              />
              <Button type="submit" className="mt-3 w-full" disabled={!ready || busy !== null || input.trim() === ''}>
                {busy === 'joining' ? 'Joining…' : 'Join'}
              </Button>
            </form>
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Joining with a code requires approval from a device already in the room.</p>
          </section>
        </div>
      )}

      {roomError && (
        <div className="mt-4" id={errorId}>
          <Callout tone="error">{roomError.message}</Callout>
        </div>
      )}

      <section className="mt-8 grid gap-3 text-sm text-slate-600 sm:grid-cols-3 dark:text-slate-400" aria-label="How LanDrop works">
        <div className="flex gap-3">
          <Icon name="link" className="h-5 w-5 shrink-0 text-accent-600" />
          <p>LanDrop does not scan your network. Devices find each other through a room on this LanDrop server.</p>
        </div>
        <div className="flex gap-3">
          <Icon name="lock" className="h-5 w-5 shrink-0 text-accent-600" />
          <p>Files and messages go directly between devices over encrypted WebRTC. Nothing is uploaded to the server.</p>
        </div>
        <div className="flex gap-3">
          <Icon name="download" className="h-5 w-5 shrink-0 text-accent-600" />
          <p>
            {caps.streamingSink
              ? 'This browser can save large incoming files straight to disk.'
              : `This browser keeps incoming files in memory, so it can receive files up to about ${Math.round(caps.memorySinkMaxBytes / 1048576)} MiB.`}
          </p>
        </div>
      </section>
    </div>
  );
}
