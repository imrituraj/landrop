import {
  ClientConfigSchema,
  ERROR_MESSAGES,
  ID_HEX,
  SECRET_B64URL,
  parsePeerMessage,
  type ClientMessageBody,
  type DeviceKind,
  type ServerMessage,
} from '@landrop/protocol';
import { normalizeShortCode } from '@landrop/shared';
import { isTerminal, type IncomingTransfer } from '@landrop/transfer-core';
import {
  detectCapabilities,
  guessDeviceKind,
  loadSettings,
  saveSettings,
  toWireCapabilities,
  type UserSettings,
} from './capabilities.ts';
import { ChatService } from './chat.ts';
import { buildDiagnostics } from './diagnostics.ts';
import { log, tag } from './log.ts';
import { PeerLink, type LinkCallbacks } from './peer-link.ts';
import { SignalingClient } from './signaling.ts';
import type { AppState, PeerView, TransferView } from './state.ts';
import { Store } from './store.ts';
import { TransferService } from './transfers.ts';

const NAME_KEY = 'landrop.deviceName';

export interface Invite {
  roomId: string;
  secret: string;
}

/** Parses "#join=<roomId>.<secret>" from a URL or a bare fragment. */
export function parseInvite(input: string): Invite | null {
  const hashIndex = input.indexOf('#');
  const frag = hashIndex >= 0 ? input.slice(hashIndex + 1) : input;
  const m = /(?:^|&)join=([0-9a-f]{32})\.([A-Za-z0-9_-]{43})(?:&|$)/.exec(frag);
  if (!m || !ID_HEX.test(m[1]!) || !SECRET_B64URL.test(m[2]!)) return null;
  return { roomId: m[1]!, secret: m[2]! };
}

export function inviteUrl(roomId: string, secret: string, publicOrigin: string | null): string {
  return `${publicOrigin ?? location.origin}/#join=${roomId}.${secret}`;
}

/** True if the page is open via a loopback name another device cannot reach. */
export function isLoopbackOrigin(): boolean {
  const h = location.hostname;
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '::1' || /^127\./.test(h);
}

function loadName(fallback: string): string {
  try {
    return localStorage.getItem(NAME_KEY) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Composition root. Owns signaling, peer links, chat, and transfers; React only
 * reads the store and calls these methods. Connections are therefore never
 * created or destroyed by renders.
 */
export class AppController {
  readonly store: Store<AppState>;
  private readonly signaling: SignalingClient;
  private readonly links = new Map<string, PeerLink>();
  private readonly chat: ChatService;
  private readonly transfers: TransferService;
  private pendingInvite: Invite | null = null;
  private readonly announced = new Set<string>();
  private wakeLock: WakeLockSentinel | null = null;
  private lastRoom: Invite | null = null;
  private noticeSeq = 0;

  constructor() {
    const settings = loadSettings();
    const caps = detectCapabilities(settings);
    const kind: DeviceKind = guessDeviceKind(caps);
    this.store = new Store<AppState>({
      config: null,
      configError: null,
      signaling: { status: 'connecting', reconnects: 0, serverShutdown: false },
      identity: { deviceName: loadName(`${caps.browser} on ${caps.os}`), deviceKind: kind },
      selfId: null,
      room: null,
      roomError: null,
      busy: null,
      joinPending: null,
      joinRequests: [],
      peers: {},
      peerOrder: [],
      selectedPeerId: null,
      chats: {},
      unread: {},
      transfers: {},
      transferOrder: [],
      caps,
      settings,
      notices: [],
      memoryReservedBytes: 0,
    });

    this.signaling = new SignalingClient(SignalingClient.defaultUrl(), () => this.store.get().identity, {
      onStatus: (status) =>
        this.store.update((s) => ({ ...s, signaling: { ...s.signaling, status, reconnects: this.signaling.reconnects } })),
      onMessage: (msg) => this.onSignal(msg),
    });

    this.chat = new ChatService({
      send: (peerId, raw) => this.links.get(peerId)?.sendChat(raw) ?? false,
      publish: (peerId, messages) =>
        this.store.update((s) => {
          const prev = s.chats[peerId] ?? [];
          const newIncoming = messages.filter((m) => m.direction === 'in').length - prev.filter((m) => m.direction === 'in').length;
          const unread = peerId !== s.selectedPeerId && newIncoming > 0 ? (s.unread[peerId] ?? 0) + newIncoming : s.unread[peerId] ?? 0;
          return { ...s, chats: { ...s.chats, [peerId]: messages }, unread: { ...s.unread, [peerId]: unread } };
        }),
    });

    this.transfers = new TransferService(
      {
        sendControl: (peerId, raw) => this.links.get(peerId)?.sendControl(raw) ?? false,
        caps: () => this.store.get().caps,
        publish: (views, removed, memoryReservedBytes) => this.publishTransfers(views, removed, memoryReservedBytes),
        notify: (kind, text) => this.notify(kind, text),
        onIncomingOffer: (t: IncomingTransfer) => {
          if (!this.store.get().selectedPeerId) this.selectPeer(t.peerId);
        },
      },
      settings.concurrency,
    );
  }

  // ---------------------------------------------------------------------------
  // Startup

  /** Reads an invite from the URL fragment, then removes it from the address bar and history. */
  private consumeHashInvite(): Invite | null {
    const invite = parseInvite(location.hash);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    return invite;
  }

  async start(): Promise<void> {
    this.pendingInvite = this.consumeHashInvite();
    // An invitation opened in an already-loaded tab only changes the fragment.
    window.addEventListener('hashchange', () => {
      const invite = this.consumeHashInvite();
      if (!invite) return;
      if (this.store.get().room?.roomId === invite.roomId) return;
      if (this.store.get().room) {
        this.notify('info', 'Leave the current room before joining another one.');
        return;
      }
      this.join(`#join=${invite.roomId}.${invite.secret}`);
    });
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const config = ClientConfigSchema.parse(await res.json());
      this.store.update((s) => ({ ...s, config }));
    } catch (err) {
      this.store.update((s) => ({ ...s, configError: `Cannot reach the LanDrop server (${(err as Error).message}).` }));
    }
    this.signaling.connect();
    window.addEventListener('online', () => this.signaling.reconnectNow());
    document.addEventListener('visibilitychange', () => void this.syncWakeLock());
    window.addEventListener('beforeunload', (e) => {
      if (this.transfers.activeCount > 0) {
        e.preventDefault();
      }
    });
  }

  private send(body: ClientMessageBody): boolean {
    return this.signaling.send(body);
  }

  notify(kind: 'info' | 'error', text: string): void {
    const id = ++this.noticeSeq;
    this.store.update((s) => ({ ...s, notices: [...s.notices.slice(-4), { id, kind, text }] }));
    setTimeout(() => this.dismissNotice(id), kind === 'error' ? 10_000 : 5000);
  }

  dismissNotice(id: number): void {
    this.store.update((s) => (s.notices.some((n) => n.id === id) ? { ...s, notices: s.notices.filter((n) => n.id !== id) } : s));
  }

  // ---------------------------------------------------------------------------
  // Signaling

  private onSignal(msg: ServerMessage): void {
    switch (msg.type) {
      case 'session:ready': {
        const changed = this.store.get().selfId !== msg.peerId;
        this.store.update((s) => ({ ...s, selfId: msg.peerId, signaling: { ...s.signaling, serverShutdown: false } }));
        if (!msg.resumed) {
          if (changed && this.links.size > 0) this.resetRoom('session lost');
          const invite = this.pendingInvite ?? this.lastRoom;
          if (invite) {
            this.store.update((s) => ({ ...s, busy: 'joining' }));
            this.send({ type: 'room:join', roomId: invite.roomId, secret: invite.secret });
          }
        }
        return;
      }
      case 'room:state':
        return this.onRoomState(msg);
      case 'room:left':
        this.resetRoom(msg.reason);
        this.lastRoom = null;
        if (msg.reason === 'expired') this.notify('info', 'The room expired.');
        return;
      case 'room:join-pending':
        this.store.update((s) => ({ ...s, busy: null, joinPending: { requestId: msg.requestId, expiresAt: msg.expiresAt } }));
        return;
      case 'room:join-request':
        this.store.update((s) => ({
          ...s,
          joinRequests: [
            ...s.joinRequests.filter((r) => r.requestId !== msg.requestId),
            { requestId: msg.requestId, deviceName: msg.deviceName, deviceKind: msg.deviceKind, expiresAt: msg.expiresAt },
          ],
        }));
        return;
      case 'room:join-request-closed':
        this.store.update((s) => ({ ...s, joinRequests: s.joinRequests.filter((r) => r.requestId !== msg.requestId) }));
        return;
      case 'peer:joined':
        this.upsertPeer(msg.peer);
        this.ensureLink(msg.peer.peerId);
        return;
      case 'peer:updated': {
        this.upsertPeer(msg.peer);
        const link = this.links.get(msg.peer.peerId);
        if (msg.peer.status === 'online' && link?.state === 'unavailable') link.retry();
        return;
      }
      case 'peer:left':
        this.removePeer(msg.peerId);
        return;
      case 'signal:offer':
      case 'signal:answer':
      case 'signal:ice': {
        const link = this.links.get(msg.from);
        if (link) link.handleSignal(msg);
        else log.debug(`signal from unknown peer ${tag(msg.from)} dropped`);
        return;
      }
      case 'server:shutdown':
        this.store.update((s) => ({ ...s, signaling: { ...s.signaling, serverShutdown: true } }));
        return;
      case 'error':
        return this.onServerError(msg);
      case 'pong':
        return;
    }
  }

  private onServerError(msg: Extract<ServerMessage, { type: 'error' }>): void {
    log.warn(`server error ${msg.code}${msg.for ? ` for ${msg.for}` : ''}`);
    const roomOps = ['room:create', 'room:join', 'room:join-code'];
    if (msg.for && roomOps.includes(msg.for)) {
      this.store.update((s) => ({
        ...s,
        busy: null,
        joinPending: null,
        roomError: { code: msg.code, message: ERROR_MESSAGES[msg.code] },
      }));
      if (msg.for === 'room:join') this.lastRoom = null;
      this.pendingInvite = null;
      return;
    }
    if (msg.code === 'PEER_UNAVAILABLE' || msg.code === 'PEER_NOT_FOUND') return; // peer state updates follow
    this.notify('error', ERROR_MESSAGES[msg.code]);
  }

  private onRoomState(msg: Extract<ServerMessage, { type: 'room:state' }>): void {
    this.pendingInvite = null;
    this.lastRoom = { roomId: msg.room.roomId, secret: msg.room.secret };
    const ids = new Set(msg.peers.map((p) => p.peerId));
    for (const id of [...this.links.keys()]) if (!ids.has(id)) this.removePeer(id);
    this.store.update((s) => ({
      ...s,
      room: msg.room,
      roomError: null,
      busy: null,
      joinPending: null,
      selfId: msg.self.peerId,
      identity: { ...s.identity, deviceName: msg.self.deviceName },
    }));
    for (const p of msg.peers) {
      this.upsertPeer(p);
      this.ensureLink(p.peerId);
    }
  }

  private resetRoom(reason: string): void {
    log.info(`leaving room state (${reason})`);
    for (const id of [...this.links.keys()]) this.removePeer(id);
    this.store.update((s) => ({ ...s, room: null, peers: {}, peerOrder: [], selectedPeerId: null, joinRequests: [], joinPending: null }));
  }

  private upsertPeer(p: { peerId: string; deviceName: string; deviceKind: DeviceKind; status: 'online' | 'reconnecting' }): void {
    this.store.update((s) => {
      const prev = s.peers[p.peerId];
      const view: PeerView = prev
        ? { ...prev, ...p }
        : { ...p, link: 'none', route: null, remoteCaps: null, gen: 0, iceRestarts: 0, rebuilds: 0, iceState: 'new' };
      const peerOrder = s.peerOrder.includes(p.peerId) ? s.peerOrder : [...s.peerOrder, p.peerId];
      const selectedPeerId = s.selectedPeerId ?? (peerOrder.length === 1 ? p.peerId : null);
      return { ...s, peers: { ...s.peers, [p.peerId]: view }, peerOrder, selectedPeerId };
    });
  }

  private removePeer(peerId: string): void {
    const s0 = this.store.get();
    const name = s0.peers[peerId]?.deviceName;
    const active = Object.values(s0.transfers).filter((t) => t.peerId === peerId && !isTerminal(t.state)).length;
    if (name && active > 0) this.notify('error', `${name} left. ${active} transfer${active > 1 ? 's' : ''} stopped.`);
    this.links.get(peerId)?.close();
    this.links.delete(peerId);
    this.transfers.peerGone(peerId);
    this.chat.peerGone(peerId);
    this.store.update((s) => {
      const peers = Object.fromEntries(Object.entries(s.peers).filter(([id]) => id !== peerId));
      const peerOrder = s.peerOrder.filter((id) => id !== peerId);
      return {
        ...s,
        peers,
        peerOrder,
        selectedPeerId: s.selectedPeerId === peerId ? (peerOrder.length === 1 ? peerOrder[0]! : null) : s.selectedPeerId,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Peer links

  private ensureLink(peerId: string): void {
    const selfId = this.store.get().selfId;
    if (!selfId || this.links.has(peerId) || peerId === selfId) return;
    const iceServers = this.store.get().config?.iceServers ?? [];
    const cb: LinkCallbacks = {
      sendSignal: (body) => {
        if (!this.send(body)) log.debug('signal dropped: signaling not ready');
      },
      onChange: (link) => this.publishLink(peerId, link),
      onOpen: (link) => {
        link.sendControl(JSON.stringify(toWireCapabilities(this.store.get().caps, link.maxMessageSize)));
        this.transfers.linkOpened(peerId, link);
        this.chat.channelOpened(peerId);
      },
      onClose: () => {
        this.transfers.linkClosed(peerId);
        this.store.update((s) => (s.peers[peerId] ? { ...s, peers: { ...s.peers, [peerId]: { ...s.peers[peerId], remoteCaps: null } } } : s));
      },
      onControl: (_link, raw) => {
        const parsed = parsePeerMessage(raw);
        if (!parsed.ok) {
          log.warn(`control message from ${tag(peerId)} rejected (${parsed.reason})`);
          return;
        }
        const m = parsed.value;
        if (m.type === 'capabilities') {
          this.transfers.remoteCapabilities(peerId, m);
          this.store.update((s) => (s.peers[peerId] ? { ...s, peers: { ...s.peers, [peerId]: { ...s.peers[peerId], remoteCaps: m } } } : s));
        } else if (m.type.startsWith('transfer:')) {
          this.transfers.handleControl(peerId, m);
        }
      },
      onChat: (_link, raw) => {
        const parsed = parsePeerMessage(raw);
        if (!parsed.ok) {
          log.warn(`chat message from ${tag(peerId)} rejected (${parsed.reason})`);
          return;
        }
        if (parsed.value.type === 'chat:message' || parsed.value.type === 'chat:ack') this.chat.handle(peerId, parsed.value);
      },
      onBinary: (_link, data) => this.transfers.handleBinary(peerId, data),
    };
    this.links.set(peerId, new PeerLink(selfId, peerId, iceServers, cb));
  }

  private publishLink(peerId: string, link: PeerLink): void {
    this.store.update((s) => {
      const prev = s.peers[peerId];
      if (!prev) return s;
      return {
        ...s,
        peers: {
          ...s.peers,
          [peerId]: {
            ...prev,
            link: link.state,
            route: link.diag.routeInfo,
            gen: link.diag.gen,
            iceRestarts: link.diag.iceRestarts,
            rebuilds: link.diag.rebuilds,
            iceState: link.diag.iceConnectionState,
          },
        },
      };
    });
  }

  /** Announce outcomes once (toast region is aria-live=polite); progress is never announced. */
  private announce(views: TransferView[]): void {
    for (const v of views) {
      if (!isTerminal(v.state) || this.announced.has(v.id)) continue;
      this.announced.add(v.id);
      if (v.state === 'completed') {
        this.notify('info', v.direction === 'out' ? `${v.name} was delivered and verified.` : `${v.name} was received and verified.`);
      } else if (v.state === 'failed') {
        this.notify('error', `${v.name}: ${v.error?.message ?? 'transfer failed.'}`);
      }
    }
  }

  /**
   * Keep the screen on while transfers run (Screen Wake Lock, where supported).
   * This only prevents screen sleep; it cannot keep a backgrounded tab running.
   */
  private async syncWakeLock(): Promise<void> {
    const active = this.transfers.activeCount > 0;
    if (active && !this.wakeLock && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => (this.wakeLock = null));
      } catch {
        this.wakeLock = null; // denied or unsupported (e.g. insecure context)
      }
    } else if (!active && this.wakeLock) {
      const lock = this.wakeLock;
      this.wakeLock = null;
      await lock.release().catch(() => undefined);
    }
  }

  private publishTransfers(views: TransferView[], removed: string[], memoryReservedBytes: number): void {
    this.announce(views);
    void this.syncWakeLock();
    this.store.update((s) => {
      let transfers = { ...s.transfers };
      let order = s.transferOrder;
      for (const v of views) {
        if (!transfers[v.id]) order = [...order, v.id];
        transfers[v.id] = v;
      }
      if (removed.length) {
        transfers = Object.fromEntries(Object.entries(transfers).filter(([id]) => !removed.includes(id)));
        order = order.filter((id) => !removed.includes(id));
      }
      return { ...s, transfers, transferOrder: order, memoryReservedBytes };
    });
  }

  // ---------------------------------------------------------------------------
  // User actions: rooms

  createRoom(): void {
    this.store.update((s) => ({ ...s, busy: 'creating', roomError: null }));
    if (!this.send({ type: 'room:create' })) {
      this.store.update((s) => ({ ...s, busy: null, roomError: { code: 'INTERNAL', message: 'Not connected to the LanDrop server yet.' } }));
    }
  }

  /** Accepts a full invite link, a "#join=..." fragment, or a short code. */
  join(input: string): void {
    const trimmed = input.trim();
    const invite = parseInvite(trimmed);
    this.store.update((s) => ({ ...s, roomError: null }));
    if (invite) {
      this.store.update((s) => ({ ...s, busy: 'joining' }));
      if (!this.send({ type: 'room:join', roomId: invite.roomId, secret: invite.secret })) this.pendingInvite = invite;
      return;
    }
    const code = normalizeShortCode(trimmed);
    if (code) {
      this.store.update((s) => ({ ...s, busy: 'joining' }));
      this.send({ type: 'room:join-code', code });
      return;
    }
    this.store.update((s) => ({
      ...s,
      roomError: { code: 'BAD_REQUEST', message: 'Enter an invitation link or an 8-character room code (e.g. 7KQ2-M9XD).' },
    }));
  }

  cancelJoinRequest(): void {
    this.send({ type: 'room:leave' });
    this.store.update((s) => ({ ...s, joinPending: null }));
  }

  answerJoinRequest(requestId: string, approve: boolean): void {
    this.send({ type: 'room:approve', requestId, approve });
    this.store.update((s) => ({ ...s, joinRequests: s.joinRequests.filter((r) => r.requestId !== requestId) }));
  }

  refreshCode(): void {
    this.send({ type: 'room:refresh-code' });
  }

  leaveRoom(): void {
    this.send({ type: 'room:leave' });
    this.lastRoom = null;
    this.resetRoom('left');
  }

  rename(name: string): void {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) return;
    try {
      localStorage.setItem(NAME_KEY, clean);
    } catch {
      // ignore
    }
    this.store.update((s) => ({ ...s, identity: { ...s.identity, deviceName: clean } }));
    this.send({ type: 'peer:update', deviceName: clean });
  }

  selectPeer(peerId: string | null): void {
    this.store.update((s) => ({ ...s, selectedPeerId: peerId, unread: peerId ? { ...s.unread, [peerId]: 0 } : s.unread }));
  }

  retryLink(peerId: string): void {
    this.links.get(peerId)?.retry();
  }

  // ---------------------------------------------------------------------------
  // User actions: chat and transfers

  sendChat(text: string): string | null {
    const peerId = this.store.get().selectedPeerId;
    if (!peerId) return 'Select a device first.';
    return this.chat.send(peerId, text);
  }

  retryChat(messageId: string): void {
    const peerId = this.store.get().selectedPeerId;
    if (peerId) this.chat.retry(peerId, messageId);
  }

  clearChat(peerId: string): void {
    this.chat.clear(peerId);
  }

  sendFiles(files: File[]): void {
    const peerId = this.store.get().selectedPeerId;
    if (!peerId || files.length === 0) return;
    this.transfers.sendFiles(peerId, files);
  }

  get transfer(): TransferService {
    return this.transfers;
  }

  updateSettings(next: UserSettings): void {
    saveSettings(next);
    const caps = detectCapabilities(next);
    this.transfers.setConcurrency(next.concurrency);
    this.store.update((s) => ({ ...s, settings: next, caps }));
    // Re-advertise capabilities to connected peers.
    for (const link of this.links.values()) {
      if (link.isOpen) link.sendControl(JSON.stringify(toWireCapabilities(caps, link.maxMessageSize)));
    }
  }

  diagnostics(): string {
    return JSON.stringify(buildDiagnostics(this.store.get(), this.signaling.reconnects, log.entries()), null, 2);
  }
}
