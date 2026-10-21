import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-600 text-white hover:bg-accent-700 disabled:bg-slate-400 dark:disabled:bg-slate-700',
  secondary:
    'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600 dark:hover:bg-slate-700',
  ghost: 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  const sz = size === 'sm' ? 'min-h-9 px-3 text-sm' : 'min-h-11 px-4 text-sm';
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${sz} ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      className={`m-auto w-[calc(100%-2rem)] ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-2xl bg-white p-0 text-slate-900 shadow-2xl dark:bg-slate-900 dark:text-slate-100`}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {dismissible && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close dialog"
              >
                <Icon name="x" />
              </button>
            )}
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

const PATHS: Record<string, string> = {
  x: 'M6 6l12 12M18 6L6 18',
  upload: 'M12 16V4m0 0l-5 5m5-5l5 5M4 20h16',
  download: 'M12 4v12m0 0l-5-5m5 5l5-5M4 20h16',
  laptop: 'M4 6h16v10H4zM2 19h20',
  desktop: 'M3 4h18v12H3zM8 20h8M12 16v4',
  phone: 'M8 2h8a1 1 0 011 1v18a1 1 0 01-1 1H8a1 1 0 01-1-1V3a1 1 0 011-1zM11 18h2',
  tablet: 'M5 3h14v18H5zM11 18h2',
  unknown: 'M12 18h.01M9.1 9a3 3 0 015.8 1c0 2-3 2-3 4',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4l13 8-13 8z',
  retry: 'M4 4v6h6M20 20v-6h-6M5.6 15a8 8 0 0013.4 2M18.4 9A8 8 0 005 7',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
  link: 'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  chat: 'M21 12a8 8 0 01-11.6 7.1L3 21l1.9-6.4A8 8 0 1121 12z',
  files: 'M14 3H6v18h12V7zM14 3v4h4',
};

export function Icon({ name, className = 'h-5 w-5', label }: { name: keyof typeof PATHS | string; className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <path d={PATHS[name] ?? PATHS['unknown']} />
    </svg>
  );
}

export function Badge({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'slate' | 'blue'; children: ReactNode }) {
  const tones = {
    green: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/30',
    amber: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/30',
    red: 'bg-red-50 text-red-800 ring-red-600/20 dark:bg-red-950 dark:text-red-300 dark:ring-red-400/30',
    slate: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/30',
    blue: 'bg-accent-50 text-accent-700 ring-accent-600/20 dark:bg-slate-800 dark:text-accent-100 dark:ring-accent-500/40',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>{children}</span>;
}

/** Progress bar with text equivalent; color is never the only signal. */
export function Progress({ value, max, label, tone = 'blue' }: { value: number; max: number; label: string; tone?: 'blue' | 'green' | 'red' | 'amber' }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : value > 0 ? 100 : 0;
  const color = { blue: 'bg-accent-600', green: 'bg-emerald-600', red: 'bg-red-600', amber: 'bg-amber-500' }[tone];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
    >
      <div className={`h-full ${color} transition-[width] duration-300`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Callout({ tone, title, children }: { tone: 'info' | 'warn' | 'error'; title?: string; children: ReactNode }) {
  const tones = {
    info: 'border-accent-500/30 bg-accent-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200',
    warn: 'border-amber-500/40 bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100',
    error: 'border-red-500/40 bg-red-50 text-red-950 dark:bg-red-950/40 dark:text-red-100',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${tones[tone]}`} role={tone === 'error' ? 'alert' : undefined}>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}
