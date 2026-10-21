import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  ClientMessageSchema,
  ERROR_MESSAGES,
  LIMITS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type DeviceKind,
  type ErrorCode,
  type PeerInfo,
  type RoomInfo,
  type ServerMessageBody,
} from '@landrop/protocol';
import { KeyedRateLimiter, TokenBucket, normalizeShortCode, randomId, randomSecret, randomShortCode } from '@landrop/shared';
import type { Config } from './config.ts';
import { logTag } from './logger.ts';

/**
 * Signaling hub: authenticated sessions, rooms, presence, and SDP/ICE routing.
 *
 * All state is in memory and lost on restart. This is a deliberate single-instance
 * design (see docs/architecture.md); it does not support multiple replicas.
 */

const MAX_INVALID_MESSAGES = 20;
const MAX_QUEUED_SIGNALS = 100;
const MAX_QUEUED_BYTES = 512 * 1024;
const MAX_SOCKET_BUFFERED = 4 * 1024 * 1024;
const MAX_PENDING_REQUESTS_PER_ROOM = 5;
const TOMBSTONE_TTL_MS = 60 * 60 * 1000;
const MAX_TOMBSTONES = 10_000;

type Timer = ReturnType<typeof setTimeout>;

interface Client {
  ws: WebSocket;
  ip: string;
  alive: boolean;
  session: Session | null;
  initTimer: Timer | null;
  bucket: TokenBucket;
  invalid: number;
  lastRateErrorAt: number;
}

interface Session {
  id: string;
  tokenHash: string;
  deviceName: string;
  deviceKind: DeviceKind;
  client: Client | null;
  roomId: string | null;
  graceTimer: Timer | null;
  queue: string[];
  queueBytes: number;
  pendingRequestId: string | null;
}

interface Room {
  id: string;
  secret: string;
  secretDigest: Buffer;
  code: string | null;
  codeExpiresAt: number | null;
  expiresAt: number;
  members: Set<string>;
  expireTimer: Timer;
  retentionTimer: Timer | null;
  requests: Set<string>;
}

interface JoinRequest {
  id: string;
  roomId: string;
  sessionId: string;
  expiresAt: number;
  timer: Timer;
}

export interface HubStats {
  clients: number;
  sessions: number;
  rooms: number;
  shuttingDown: boolean;
}

function sha256(data: string): Buffer {
  return createHash('sha256').update(data).digest();
}

function unref(t: Timer): Timer {
  t.unref();
  return t;
}

export class SignalingHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly connectionsPerIp = new Map<string, number>();
  private readonly sessions = new Map<string, Session>();
  private readonly sessionsByToken = new Map<string, Session>();
  private readonly rooms = new Map<string, Room>();
  private readonly roomsByCode = new Map<string, Room>();
  private readonly tombstones = new Map<string, { secretDigest: Buffer; until: number }>();
  private readonly requests = new Map<string, JoinRequest>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private shuttingDown = false;

  private readonly connectLimiter: KeyedRateLimiter;
  private readonly joinLimiter: KeyedRateLimiter;
  private readonly codeJoinLimiter: KeyedRateLimiter;
  private readonly createLimiter: KeyedRateLimiter;
  private readonly codeFailGlobal: TokenBucket;

  private readonly config: Config;
  private readonly log: Logger;

  constructor(config: Config, log: Logger) {
    this.config = config;
    this.log = log;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: LIMITS.signalingMessageBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
    const r = config.rate;
    this.connectLimiter = new KeyedRateLimiter(r.connectPerMin, r.connectPerMin / 60);
    this.joinLimiter = new KeyedRateLimiter(r.joinPerMin, r.joinPerMin / 60);
    this.codeJoinLimiter = new KeyedRateLimiter(r.codeJoinPerMin, r.codeJoinPerMin / 60);
    this.createLimiter = new KeyedRateLimiter(r.roomCreatePerMin, r.roomCreatePerMin / 60);
    this.codeFailGlobal = new TokenBucket(r.codeFailGlobalPerMin, r.codeFailGlobalPerMin / 60);
    this.heartbeat = setInterval(() => this.runHeartbeat(), config.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  // -------------------------------------------------------------------------
  // Connection admission
  // -------------------------------------------------------------------------

  stats(): HubStats {
    return {
      clients: this.clients.size,
      sessions: this.sessions.size,
      rooms: this.rooms.size,
      shuttingDown: this.shuttingDown,
    };
  }

  isOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
    if (!origin) return false;
    if (this.config.allowedOrigins.includes(origin)) return true;
    if (this.config.allowSameOrigin && host) {
      try {
        return new URL(origin).host.toLowerCase() === host.toLowerCase();
      } catch {
        return false;
      }
    }
    return false;
  }

  clientIp(req: IncomingMessage): string {
    if (this.config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const value = Array.isArray(xff) ? xff[xff.length - 1] : xff;
      // Right-most entry is the one appended by our (single, trusted) proxy.
      const last = value?.split(',').pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws') return reject(404, 'Not Found');
    if (this.shuttingDown) return reject(503, 'Service Unavailable');
    if (!this.isOriginAllowed(req.headers.origin, req.headers.host)) {
      this.log.warn({ evt: 'ws_origin_rejected' }, 'websocket origin rejected');
      return reject(403, 'Forbidden');
    }
    const ip = this.clientIp(req);
    if (!this.connectLimiter.tryTake(ip)) return reject(429, 'Too Many Requests');
    if (this.clients.size >= this.config.maxClients) return reject(503, 'Service Unavailable');
    if ((this.connectionsPerIp.get(ip) ?? 0) >= this.config.maxClientsPerIp) return reject(429, 'Too Many Requests');

    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const client: Client = {
      ws,
      ip,
      alive: true,
      session: null,
      initTimer: null,
      bucket: new TokenBucket(this.config.rate.messagesBurst, this.config.rate.messagesPerSec),
      invalid: 0,
      lastRateErrorAt: 0,
    };
    this.clients.add(client);
    this.connectionsPerIp.set(ip, (this.connectionsPerIp.get(ip) ?? 0) + 1);

    client.initTimer = unref(
      setTimeout(() => {
        if (!client.session) ws.close(4000, 'init timeout');
      }, this.config.initTimeoutMs),
    );

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    ws.on('close', () => this.onClose(client));
    ws.on('error', (err) => {
      this.log.debug({ evt: 'ws_error', err: err.message }, 'websocket error');
    });
  }

  private onClose(client: Client): void {
    if (!this.clients.delete(client)) return;
    const n = (this.connectionsPerIp.get(client.ip) ?? 1) - 1;
    if (n <= 0) this.connectionsPerIp.delete(client.ip);
    else this.connectionsPerIp.set(client.ip, n);
    if (client.initTimer) clearTimeout(client.initTimer);

    const session = client.session;
    if (!session || session.client !== client) return;
    session.client = null;
    if (this.shuttingDown) return;

    // Keep the session (and room membership) for a grace period so a reconnecting
    // tab can resume with its token and keep the same peerId.
    if (session.roomId) this.broadcastPeerUpdate(session);
    session.graceTimer = unref(setTimeout(() => this.expireSession(session), this.config.resumeGraceMs));
  }

  private expireSession(session: Session): void {
    if (session.client) return;
    this.log.debug({ evt: 'session_expired', peer: logTag(session.id) }, 'session expired');
    this.removeFromRoom(session, 'timeout');
    this.cancelPendingRequest(session);
    this.sessions.delete(session.id);
    this.sessionsByToken.delete(session.tokenHash);
  }

  private runHeartbeat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        this.log.debug({ evt: 'ws_dead' }, 'terminating unresponsive socket');
        client.ws.terminate();
        // 'close' fires asynchronously after terminate and performs cleanup.
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        client.ws.terminate();
      }
    }
    const now = Date.now();
    for (const [id, t] of this.tombstones) if (t.until < now) this.tombstones.delete(id);
  }

  // -------------------------------------------------------------------------
  // Messaging helpers
  // -------------------------------------------------------------------------

  private send(client: Client, body: ServerMessageBody): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > MAX_SOCKET_BUFFERED) {
      this.log.warn({ evt: 'ws_slow_consumer' }, 'terminating slow consumer');
      client.ws.terminate();
      return;
    }
    client.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...body }));
  }

  private sendError(client: Client, code: ErrorCode, forType?: string, cid?: string): void {
    const body: ServerMessageBody = { type: 'error', code, message: ERROR_MESSAGES[code] };
    if (forType) body.for = forType;
    if (cid) body.cid = cid;
    this.send(client, body);
  }

  /** Send to a session; if it is temporarily disconnected, optionally queue (bounded). */
  private sendToSession(session: Session, body: ServerMessageBody, queue: boolean): boolean {
    if (session.client) {
      this.send(session.client, body);
      return true;
    }
    if (!queue) return false;
    const raw = JSON.stringify({ v: PROTOCOL_VERSION, ...body });
    if (session.queue.length >= MAX_QUEUED_SIGNALS || session.queueBytes + raw.length > MAX_QUEUED_BYTES) return false;
    session.queue.push(raw);
    session.queueBytes += raw.length;
    return true;
  }

  private peerInfo(s: Session): PeerInfo {
    return {
      peerId: s.id,
      deviceName: s.deviceName,
      deviceKind: s.deviceKind,
      status: s.client ? 'online' : 'reconnecting',
    };
  }

  private roomInfo(room: Room): RoomInfo {
    const codeValid = room.code !== null && room.codeExpiresAt !== null && room.codeExpiresAt > Date.now();
    return {
      roomId: room.id,
      secret: room.secret,
      code: codeValid ? room.code : null,
      codeExpiresAt: codeValid ? room.codeExpiresAt : null,
      expiresAt: room.expiresAt,
      maxPeers: this.config.roomMaxPeers,
    };
  }

  private sendRoomState(session: Session, room: Room, cid?: string): void {
    const peers: PeerInfo[] = [];
    for (const id of room.members) {
      if (id === session.id) continue;
      const s = this.sessions.get(id);
      if (s) peers.push(this.peerInfo(s));
    }
    const body: ServerMessageBody = { type: 'room:state', room: this.roomInfo(room), self: this.peerInfo(session), peers };
    if (cid) body.cid = cid;
    this.sendToSession(session, body, false);
  }

  private broadcast(room: Room, body: ServerMessageBody, exceptId?: string): void {
    for (const id of room.members) {
      if (id === exceptId) continue;
      const s = this.sessions.get(id);
      if (s) this.sendToSession(s, body, false);
    }
  }

  private broadcastPeerUpdate(session: Session): void {
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    if (room) this.broadcast(room, { type: 'peer:updated', peer: this.peerInfo(session) }, session.id);
  }

  // -------------------------------------------------------------------------
  // Inbound dispatch
  // -------------------------------------------------------------------------

  private onMessage(client: Client, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      client.ws.close(1003, 'binary not supported');
      return;
    }
    if (!client.bucket.tryTake()) {
      const now = Date.now();
      if (now - client.lastRateErrorAt > 1000) {
        client.lastRateErrorAt = now;
        this.sendError(client, 'RATE_LIMITED');
      }
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return this.invalid(client, 'BAD_REQUEST');
    }
    const typeHint =
      typeof json === 'object' && json !== null && 'type' in json && typeof json.type === 'string'
        ? json.type.slice(0, 40)
        : undefined;
    if (typeof json === 'object' && json !== null && 'v' in json && json.v !== PROTOCOL_VERSION) {
      return this.invalid(client, 'UNSUPPORTED_VERSION', typeHint);
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) return this.invalid(client, 'BAD_REQUEST', typeHint);

    try {
      this.dispatch(client, parsed.data);
    } catch (err) {
      this.log.error({ evt: 'dispatch_error', type: parsed.data.type, err: (err as Error).message }, 'dispatch error');
      this.sendError(client, 'INTERNAL', parsed.data.type);
    }
  }

  private invalid(client: Client, code: ErrorCode, forType?: string): void {
    client.invalid++;
    this.log.debug({ evt: 'invalid_message', code, type: forType }, 'invalid message');
    this.sendError(client, code, forType);
    if (client.invalid > MAX_INVALID_MESSAGES) client.ws.close(1008, 'too many invalid messages');
  }

  private dispatch(client: Client, msg: ClientMessage): void {
    if (msg.type === 'session:init') return this.onInit(client, msg);
    const session = client.session;
    if (!session) return this.sendError(client, 'NOT_INITIALIZED', msg.type);

    switch (msg.type) {
      case 'ping':
        return this.send(client, { type: 'pong', t: msg.t });
      case 'room:create':
        return this.onCreate(client, session, msg.cid);
      case 'room:join':
        return this.onJoin(client, session, msg.roomId, msg.secret, msg.cid);
      case 'room:join-code':
        return this.onJoinCode(client, session, msg.code, msg.cid);
      case 'room:approve':
        return this.onApprove(client, session, msg.requestId, msg.approve);
      case 'room:leave':
        return this.onLeave(client, session, msg.cid);
      case 'room:refresh-code':
        return this.onRefreshCode(client, session, msg.cid);
      case 'peer:update':
        session.deviceName = msg.deviceName;
        this.broadcastPeerUpdate(session);
        if (session.roomId) {
          const room = this.rooms.get(session.roomId);
          if (room) this.sendRoomState(session, room);
        }
        return;
      case 'signal:offer':
      case 'signal:answer':
      case 'signal:ice':
        return this.onSignal(client, session, msg);
    }
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  private onInit(client: Client, msg: Extract<ClientMessage, { type: 'session:init' }>): void {
    if (client.session) return this.sendError(client, 'ALREADY_INITIALIZED', msg.type);
    if (client.initTimer) {
      clearTimeout(client.initTimer);
      client.initTimer = null;
    }

    let session: Session | undefined;
    let resumed = false;
    if (msg.resumeToken) {
      const oldHash = sha256(msg.resumeToken).toString('hex');
      session = this.sessionsByToken.get(oldHash);
      if (session) {
        resumed = true;
        this.sessionsByToken.delete(oldHash);
        if (session.graceTimer) clearTimeout(session.graceTimer);
        session.graceTimer = null;
        // A second tab presenting the same token takes over; the old socket is closed.
        if (session.client && session.client !== client) {
          const old = session.client;
          old.session = null;
          old.ws.close(4001, 'session resumed elsewhere');
        }
      }
    }

    if (!session) {
      session = {
        id: randomId(),
        tokenHash: '',
        deviceName: msg.deviceName,
        deviceKind: msg.deviceKind,
        client: null,
        roomId: null,
        graceTimer: null,
        queue: [],
        queueBytes: 0,
        pendingRequestId: null,
      };
      this.sessions.set(session.id, session);
    } else {
      session.deviceName = msg.deviceName;
      session.deviceKind = msg.deviceKind;
    }

    // Rotate the token on every init so a captured token is single-use.
    const token = randomSecret();
    session.tokenHash = sha256(token).toString('hex');
    this.sessionsByToken.set(session.tokenHash, session);
    session.client = client;
    client.session = session;

    this.log.info({ evt: 'session_ready', peer: logTag(session.id), resumed }, 'session ready');
    this.send(client, {
      type: 'session:ready',
      peerId: session.id,
      resumeToken: token,
      resumed,
      resumeGraceMs: this.config.resumeGraceMs,
    });

    if (resumed && session.roomId) {
      const room = this.rooms.get(session.roomId);
      if (room) {
        this.sendRoomState(session, room);
        this.broadcastPeerUpdate(session);
      }
      const queued = session.queue;
      session.queue = [];
      session.queueBytes = 0;
      for (const raw of queued) if (client.ws.readyState === WebSocket.OPEN) client.ws.send(raw);
    }
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  private onCreate(client: Client, session: Session, cid?: string): void {
    if (session.roomId) return this.sendError(client, 'ALREADY_IN_ROOM', 'room:create', cid);
    if (!this.createLimiter.tryTake(client.ip)) return this.sendError(client, 'RATE_LIMITED', 'room:create', cid);
    if (this.rooms.size >= this.config.maxRooms) return this.sendError(client, 'ROOM_LIMIT', 'room:create', cid);

    const now = Date.now();
    const secret = randomSecret();
    const room: Room = {
      id: randomId(),
      secret,
      secretDigest: sha256(secret),
      code: null,
      codeExpiresAt: null,
      expiresAt: now + this.config.roomTtlMs,
      members: new Set(),
      expireTimer: unref(setTimeout(() => this.expireRoom(room, 'expired'), this.config.roomTtlMs)),
      retentionTimer: null,
      requests: new Set(),
    };
    this.assignCode(room);
    this.rooms.set(room.id, room);
    this.log.info({ evt: 'room_created', room: logTag(room.id) }, 'room created');
    this.addMember(room, session, cid);
  }

  private assignCode(room: Room): void {
    if (room.code) this.roomsByCode.delete(room.code);
    let code = randomShortCode();
    for (let i = 0; i < 5 && this.roomsByCode.has(code); i++) code = randomShortCode();
    if (this.roomsByCode.has(code)) {
      room.code = null;
      room.codeExpiresAt = null;
      return;
    }
    room.code = code;
    room.codeExpiresAt = Date.now() + this.config.roomCodeTtlMs;
    this.roomsByCode.set(code, room);
  }

  private onRefreshCode(client: Client, session: Session, cid?: string): void {
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    if (!room) return this.sendError(client, 'NOT_IN_ROOM', 'room:refresh-code', cid);
    if (!this.createLimiter.tryTake(client.ip)) return this.sendError(client, 'RATE_LIMITED', 'room:refresh-code', cid);
    this.assignCode(room);
    for (const id of room.members) {
      const s = this.sessions.get(id);
      if (s) this.sendRoomState(s, room, id === session.id ? cid : undefined);
    }
  }

  private secretMatches(expected: Buffer, provided: string): boolean {
    return timingSafeEqual(expected, sha256(provided));
  }

  private onJoin(client: Client, session: Session, roomId: string, secret: string, cid?: string): void {
    if (!this.joinLimiter.tryTake(client.ip)) return this.sendError(client, 'RATE_LIMITED', 'room:join', cid);
    const room = this.rooms.get(roomId);
    if (!room) {
      const t = this.tombstones.get(roomId);
      const code: ErrorCode = t && this.secretMatches(t.secretDigest, secret) ? 'ROOM_EXPIRED' : 'ROOM_NOT_FOUND';
      return this.sendError(client, code, 'room:join', cid);
    }
    // Same error for wrong secret and missing room: no room enumeration.
    if (!this.secretMatches(room.secretDigest, secret)) return this.sendError(client, 'ROOM_NOT_FOUND', 'room:join', cid);
    if (session.roomId === room.id) return this.sendRoomState(session, room, cid);
    if (session.roomId) return this.sendError(client, 'ALREADY_IN_ROOM', 'room:join', cid);
    if (room.members.size >= this.config.roomMaxPeers) return this.sendError(client, 'ROOM_FULL', 'room:join', cid);
    this.addMember(room, session, cid);
  }

  private onJoinCode(client: Client, session: Session, rawCode: string, cid?: string): void {
    if (!this.codeJoinLimiter.tryTake(client.ip)) return this.sendError(client, 'RATE_LIMITED', 'room:join-code', cid);
    if (session.roomId) return this.sendError(client, 'ALREADY_IN_ROOM', 'room:join-code', cid);
    if (session.pendingRequestId) this.cancelPendingRequest(session);

    // Global failure budget bounds distributed guessing across many IPs: once it is
    // exhausted, every code join is refused until it refills.
    if (this.codeFailGlobal.available() < 1) {
      this.log.warn({ evt: 'code_failure_budget_exhausted' }, 'code joins temporarily locked');
      return this.sendError(client, 'RATE_LIMITED', 'room:join-code', cid);
    }
    const code = normalizeShortCode(rawCode);
    const room = code ? this.roomsByCode.get(code) : undefined;
    const now = Date.now();
    const hasOnlineMember = room ? [...room.members].some((id) => this.sessions.get(id)?.client) : false;
    if (!room || room.codeExpiresAt === null || room.codeExpiresAt <= now || !hasOnlineMember) {
      this.codeFailGlobal.tryTake();
      return this.sendError(client, 'CODE_INVALID', 'room:join-code', cid);
    }
    if (room.members.size >= this.config.roomMaxPeers) return this.sendError(client, 'ROOM_FULL', 'room:join-code', cid);
    if (room.requests.size >= MAX_PENDING_REQUESTS_PER_ROOM) return this.sendError(client, 'RATE_LIMITED', 'room:join-code', cid);

    const request: JoinRequest = {
      id: randomId(),
      roomId: room.id,
      sessionId: session.id,
      expiresAt: now + this.config.joinRequestTtlMs,
      timer: unref(setTimeout(() => this.expireRequest(request.id), this.config.joinRequestTtlMs)),
    };
    this.requests.set(request.id, request);
    room.requests.add(request.id);
    session.pendingRequestId = request.id;

    const pending: ServerMessageBody = { type: 'room:join-pending', requestId: request.id, expiresAt: request.expiresAt };
    if (cid) pending.cid = cid;
    this.send(client, pending);
    this.broadcast(room, {
      type: 'room:join-request',
      requestId: request.id,
      deviceName: session.deviceName,
      deviceKind: session.deviceKind,
      expiresAt: request.expiresAt,
    });
    this.log.info({ evt: 'join_request', room: logTag(room.id) }, 'join request created');
  }

  private closeRequest(request: JoinRequest): void {
    clearTimeout(request.timer);
    this.requests.delete(request.id);
    const room = this.rooms.get(request.roomId);
    const requester = this.sessions.get(request.sessionId);
    if (requester?.pendingRequestId === request.id) requester.pendingRequestId = null;
    if (room) {
      room.requests.delete(request.id);
      this.broadcast(room, { type: 'room:join-request-closed', requestId: request.id });
    }
  }

  private expireRequest(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.closeRequest(request);
    const requester = this.sessions.get(request.sessionId);
    if (requester?.client) this.sendError(requester.client, 'JOIN_REQUEST_EXPIRED', 'room:join-code');
  }

  private cancelPendingRequest(session: Session): void {
    const request = session.pendingRequestId ? this.requests.get(session.pendingRequestId) : undefined;
    if (request) this.closeRequest(request);
    session.pendingRequestId = null;
  }

  private onApprove(client: Client, session: Session, requestId: string, approve: boolean): void {
    const request = this.requests.get(requestId);
    // Only members of the request's room may decide it.
    if (!request || request.roomId !== session.roomId) return this.sendError(client, 'JOIN_REQUEST_EXPIRED', 'room:approve');
    const room = this.rooms.get(request.roomId);
    const requester = this.sessions.get(request.sessionId);
    this.closeRequest(request);
    if (!room || !requester) return;
    if (!approve) {
      if (requester.client) this.sendError(requester.client, 'JOIN_DENIED', 'room:join-code');
      return;
    }
    if (requester.roomId) return;
    if (room.members.size >= this.config.roomMaxPeers) {
      if (requester.client) this.sendError(requester.client, 'ROOM_FULL', 'room:join-code');
      return;
    }
    this.addMember(room, requester);
  }

  private addMember(room: Room, session: Session, cid?: string): void {
    if (room.retentionTimer) {
      clearTimeout(room.retentionTimer);
      room.retentionTimer = null;
    }
    room.members.add(session.id);
    session.roomId = room.id;
    this.sendRoomState(session, room, cid);
    this.broadcast(room, { type: 'peer:joined', peer: this.peerInfo(session) }, session.id);
    this.log.info({ evt: 'room_joined', room: logTag(room.id), peer: logTag(session.id), size: room.members.size }, 'joined room');
  }

  private onLeave(client: Client, session: Session, cid?: string): void {
    const hadRequest = session.pendingRequestId !== null;
    this.cancelPendingRequest(session);
    if (!session.roomId) {
      if (hadRequest) return; // leaving withdraws a pending code-join request
      return this.sendError(client, 'NOT_IN_ROOM', 'room:leave', cid);
    }
    this.removeFromRoom(session, 'left');
    const body: ServerMessageBody = { type: 'room:left', reason: 'left' };
    if (cid) body.cid = cid;
    this.send(client, body);
  }

  private removeFromRoom(session: Session, reason: 'left' | 'timeout'): void {
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    session.roomId = null;
    session.queue = [];
    session.queueBytes = 0;
    if (!room) return;
    room.members.delete(session.id);
    this.broadcast(room, { type: 'peer:left', peerId: session.id, reason });
    this.log.info({ evt: 'room_left', room: logTag(room.id), peer: logTag(session.id), reason }, 'left room');
    if (room.members.size === 0) {
      room.retentionTimer = unref(setTimeout(() => this.expireRoom(room, 'closed'), this.config.roomRetentionMs));
    }
  }

  private expireRoom(room: Room, why: 'expired' | 'closed'): void {
    if (this.rooms.get(room.id) !== room) return;
    clearTimeout(room.expireTimer);
    if (room.retentionTimer) clearTimeout(room.retentionTimer);
    for (const reqId of room.requests) {
      const r = this.requests.get(reqId);
      if (r) this.closeRequest(r);
    }
    for (const id of room.members) {
      const s = this.sessions.get(id);
      if (!s) continue;
      s.roomId = null;
      s.queue = [];
      s.queueBytes = 0;
      this.sendToSession(s, { type: 'room:left', reason: 'expired' }, false);
    }
    room.members.clear();
    this.rooms.delete(room.id);
    if (room.code) this.roomsByCode.delete(room.code);
    if (this.tombstones.size >= MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next();
      if (!oldest.done) this.tombstones.delete(oldest.value);
    }
    this.tombstones.set(room.id, { secretDigest: room.secretDigest, until: Date.now() + TOMBSTONE_TTL_MS });
    this.log.info({ evt: 'room_removed', room: logTag(room.id), why }, 'room removed');
  }

  // -------------------------------------------------------------------------
  // Signaling relay
  // -------------------------------------------------------------------------

  private onSignal(
    client: Client,
    session: Session,
    msg: Extract<ClientMessage, { type: 'signal:offer' | 'signal:answer' | 'signal:ice' }>,
  ): void {
    if (!session.roomId) return this.sendError(client, 'NOT_IN_ROOM', msg.type);
    const target = this.sessions.get(msg.to);
    // Authorization: target must be a *different* member of the *same* room.
    if (!target || target.id === session.id || target.roomId !== session.roomId) {
      return this.sendError(client, 'PEER_NOT_FOUND', msg.type);
    }
    let body: ServerMessageBody;
    if (msg.type === 'signal:ice') body = { type: 'signal:ice', from: session.id, gen: msg.gen, candidate: msg.candidate };
    else body = { type: msg.type, from: session.id, gen: msg.gen, sdp: msg.sdp };
    if (!this.sendToSession(target, body, true)) this.sendError(client, 'PEER_UNAVAILABLE', msg.type);
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /** Stop admitting sockets, notify clients, and close them. */
  async shutdown(graceMs: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    clearInterval(this.heartbeat);
    for (const client of this.clients) this.send(client, { type: 'server:shutdown' });
    for (const client of this.clients) client.ws.close(1001, 'server shutting down');

    const deadline = Date.now() + graceMs;
    while (this.clients.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const client of this.clients) client.ws.terminate();

    for (const s of this.sessions.values()) if (s.graceTimer) clearTimeout(s.graceTimer);
    for (const r of this.rooms.values()) {
      clearTimeout(r.expireTimer);
      if (r.retentionTimer) clearTimeout(r.retentionTimer);
    }
    for (const r of this.requests.values()) clearTimeout(r.timer);
    this.wss.close();
  }
}
