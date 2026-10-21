import { useEffect, useId, useRef, useState } from 'react';
import { LIMITS } from '@landrop/protocol';
import { linkify } from '@landrop/shared';
import type { ChatMessageView } from '../core/chat.ts';
import { useApp, useAppState } from './context.tsx';
import { Button, Icon } from './primitives.tsx';

const EMPTY: ChatMessageView[] = [];

function Text({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((seg, i) =>
        seg.kind === 'link' ? (
          <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2 break-all">
            {seg.text}
          </a>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

const STATUS_TEXT = {
  sending: 'Sending…',
  delivered: 'Delivered',
  unconfirmed: 'Not confirmed',
  failed: 'Not delivered',
} as const;

function Message({ m }: { m: ChatMessageView }) {
  const app = useApp();
  const canClipboard = useAppState((s) => s.caps.clipboardWrite);
  const out = m.direction === 'out';
  return (
    <li className={`flex ${out ? 'justify-end' : 'justify-start'}`} data-testid="chat-message" data-direction={m.direction}>
      <div className="group max-w-[85%]">
        <div
          className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
            out ? 'rounded-br-md bg-accent-600 text-white' : 'rounded-bl-md bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
          }`}
        >
          <span className="sr-only">{out ? 'You said: ' : 'They said: '}</span>
          <span data-testid="chat-text">
            <Text text={m.text} />
          </span>
        </div>
        <div className={`mt-1 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 ${out ? 'justify-end' : ''}`}>
          <time dateTime={new Date(m.at).toISOString()}>{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          {out && m.status && <span data-testid="chat-status">{STATUS_TEXT[m.status]}</span>}
          {out && (m.status === 'unconfirmed' || m.status === 'failed') && (
            <button type="button" className="underline" onClick={() => app.retryChat(m.id)}>
              Retry
            </button>
          )}
          {canClipboard && (
            <button
              type="button"
              className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              onClick={() => navigator.clipboard.writeText(m.text).then(() => app.notify('info', 'Message copied.'), () => undefined)}
              aria-label="Copy message"
            >
              <Icon name="copy" className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function Chat({ peerId }: { peerId: string }) {
  const app = useApp();
  const messages = useAppState((s) => s.chats[peerId] ?? EMPTY);
  const linkUp = useAppState((s) => s.peers[peerId]?.link === 'connected');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const inputId = useId();

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = () => {
    const err = app.sendChat(draft);
    setError(err);
    if (!err) setDraft('');
  };

  return (
    <div className="flex h-[28rem] flex-col xl:h-[36rem]">
      <ol ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4" role="log" aria-live="polite" aria-label="Chat messages">
        {messages.length === 0 && (
          <li className="text-center text-xs text-slate-500 dark:text-slate-400">
            Messages go directly to this device and are not stored anywhere. Reloading the page clears them.
          </li>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
      </ol>
      <form
        className="border-t border-slate-200 p-3 dark:border-slate-800"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Message
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={inputId}
            value={draft}
            maxLength={LIMITS.chatChars}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={linkUp ? 'Message' : 'Message (sent when connected)'}
            className="max-h-32 min-h-11 flex-1 resize-y rounded-lg border-0 bg-slate-50 px-3 py-2.5 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-accent-500 dark:bg-slate-800 dark:ring-slate-600"
          />
          <Button type="submit" variant="primary" disabled={draft.trim() === ''} aria-label="Send message">
            <Icon name="send" className="h-4 w-4" />
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Enter to send · Shift+Enter for a new line</p>
        {error && (
          <p className="mt-1 text-xs text-red-700 dark:text-red-300" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
