/**
 * Client lifecycle logging. Policy: log event names, states, and error codes
 * only — never chat text, file names, file bytes, SDP, ICE candidates, room
 * secrets, or tokens. Logs are kept in a bounded ring for diagnostics export.
 */

export interface LogEntry {
  t: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
}

const RING_SIZE = 300;
const ring: LogEntry[] = [];
let debugEnabled = false;
try {
  debugEnabled = localStorage.getItem('landrop.debug') === '1';
} catch {
  debugEnabled = false;
}

function push(level: LogEntry['level'], msg: string): void {
  ring.push({ t: Date.now(), level, msg });
  if (ring.length > RING_SIZE) ring.shift();
  if (level === 'error') console.error(`[landrop] ${msg}`);
  else if (level === 'warn') console.warn(`[landrop] ${msg}`);
  else if (debugEnabled) console.warn(`[landrop:${level}] ${msg}`);
}

export const log = {
  debug: (msg: string) => push('debug', msg),
  info: (msg: string) => push('info', msg),
  warn: (msg: string) => push('warn', msg),
  error: (msg: string) => push('error', msg),
  entries: (): readonly LogEntry[] => ring.slice(),
};

/** Short non-reversible tag for correlating log lines without exposing IDs (FNV-1a). */
export function tag(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}
