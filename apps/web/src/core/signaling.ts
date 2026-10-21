import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessageBody,
  type DeviceKind,
  type ServerMessage,
} from '@landrop/protocol';
import { log } from './log.ts';

export type SignalingStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SignalingEvents {
  onStatus(status: SignalingStatus): void;
  onMessage(msg: ServerMessage): void;
}

const TOKEN_KEY = 'landrop.session';
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 25_000;

/** Session tokens go to sessionStorage (per tab, cleared when the tab closes). */
function loadToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function saveToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage may be unavailable (privacy mode); resume then simply won't work across reloads.
  }
}

/**
 * WebSocket signaling client with automatic reconnect and session resume.
 * The resume token is rotated by the server on every successful init.
 */
export class SignalingClient {
  status: SignalingStatus = 'connecting';
  reconnects = 0;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private stopped = false;
  private ready = false;
  private readonly url: string;
  private readonly identity: () => { deviceName: string; deviceKind: DeviceKind };
  private readonly events: SignalingEvents;

  constructor(url: string, identity: () => { deviceName: string; deviceKind: DeviceKind }, events: SignalingEvents) {
    this.url = url;
    this.identity = identity;
    this.events = events;
  }

  static defaultUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  get isReady(): boolean {
    return this.ready;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  private setStatus(s: SignalingStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.events.onStatus(s);
  }

  private open(): void {
    this.ready = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      const resumeToken = loadToken();
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'session:init',
          ...this.identity(),
          ...(resumeToken ? { resumeToken } : {}),
        }),
      );
      this.lastPong = Date.now();
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(ev.data);
      } catch {
        return;
      }
      const parsed = ServerMessageSchema.safeParse(json);
      if (!parsed.success) {
        log.warn('signaling: invalid server message ignored');
        return;
      }
      const msg = parsed.data;
      if (msg.type === 'pong') {
        this.lastPong = Date.now();
        return;
      }
      if (msg.type === 'session:ready') {
        saveToken(msg.resumeToken);
        this.ready = true;
        this.setStatus('open');
      }
      this.events.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.cleanupSocket();
      log.info(`signaling: closed (${ev.code})`);
      if (ev.code === 4001) {
        // Another tab resumed this session. Don't fight over it.
        this.stopped = true;
        saveToken(null);
      }
      if (this.stopped) {
        this.setStatus('closed');
        return;
      }
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do.
    };
  }

  private ping(): void {
    if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) {
      log.warn('signaling: no pong, reconnecting');
      this.ws?.close();
      return;
    }
    this.sendRaw({ type: 'ping', t: Date.now() });
  }

  private cleanupSocket(): void {
    this.ready = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const base = Math.min(10_000, 500 * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnects++;
      this.open();
    }, delay);
  }

  /** Reconnect now (e.g. after the browser reports it is back online). */
  reconnectNow(): void {
    if (this.stopped || this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnects++;
    this.open();
  }

  /** Returns false if the socket is not ready; callers decide whether that matters. */
  send(body: ClientMessageBody): boolean {
    if (!this.ready) return false;
    return this.sendRaw(body);
  }

  private sendRaw(body: ClientMessageBody): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...body }));
    return true;
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.cleanupSocket();
    ws?.close(1000);
    this.setStatus('closed');
  }

  /** Forget the session (used when leaving deliberately). */
  forgetSession(): void {
    saveToken(null);
  }
}
