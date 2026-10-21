import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createLogger } from '../../apps/server/src/logger.ts';
import { TestClient, connect, sleep, startServer, type Running } from './helpers.ts';

let running: Running | null = null;
const clients: TestClient[] = [];

async function start(overrides: Parameters<typeof startServer>[0] = {}, logger?: Parameters<typeof startServer>[1]) {
  running = await startServer(overrides, logger);
  return running;
}

async function client(r: Running, name = 'Device', ip?: string) {
  const res = await connect(r, name, ip);
  clients.push(res.c);
  return res;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  if (running) await running.close();
  running = null;
});

async function roomWith(r: Running, n: number) {
  const a = await client(r, 'A');
  a.c.send({ type: 'room:create', cid: 'c1' });
  const state = await a.c.next('room:state');
  const others = [];
  for (let i = 1; i < n; i++) {
    const o = await client(r, `P${i}`);
    o.c.send({ type: 'room:join', roomId: state.room.roomId, secret: state.room.secret });
    await o.c.next('room:state');
    others.push(o);
  }
  return { a, state, others };
}

describe('WebSocket admission', () => {
  it('rejects a missing Origin', async () => {
    const r = await start();
    const c = new TestClient(r.port, null);
    await expect(c.opened()).rejects.toThrow(/403/);
  });

  it('rejects a foreign Origin (cross-site WebSocket hijacking)', async () => {
    const r = await start();
    const c = new TestClient(r.port, 'https://evil.example');
    await expect(c.opened()).rejects.toThrow(/403/);
  });

  it('accepts same-origin and explicitly allowed origins, and rejects same-origin when disabled', async () => {
    const r = await start({ allowedOrigins: ['https://landrop.lan:8443'], allowSameOrigin: false });
    const allowed = new TestClient(r.port, 'https://landrop.lan:8443');
    await allowed.opened();
    allowed.close();
    const same = new TestClient(r.port, r.origin);
    await expect(same.opened()).rejects.toThrow(/403/);
  });

  it('rejects unknown paths', async () => {
    const r = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/other`, { headers: { Origin: r.origin } });
    await expect(
      new Promise((_, reject) => ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)))),
    ).rejects.toThrow(/404/);
  });

  it('enforces per-IP connection limits', async () => {
    const r = await start({ maxClientsPerIp: 2 });
    await client(r);
    await client(r);
    const third = new TestClient(r.port, r.origin);
    await expect(third.opened()).rejects.toThrow(/429/);
  });

  it('requires session:init first and closes sockets that never initialize', async () => {
    const r = await start({ initTimeoutMs: 300 });
    const c = new TestClient(r.port, r.origin);
    clients.push(c);
    await c.opened();
    c.send({ type: 'room:create' });
    expect((await c.next('error')).code).toBe('NOT_INITIALIZED');
    expect((await c.waitClosed(2000)).code).toBe(4000);
  });
});

describe('rooms', () => {
  it('creates and joins a room with the invite secret; members see each other', async () => {
    const r = await start();
    const { a, state, others } = await roomWith(r, 2);
    expect(state.cid).toBe('c1');
    expect(state.room.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const joined = await a.c.next('peer:joined');
    expect(joined.peer.peerId).toBe(others[0]!.ready.peerId);
    expect(joined.peer.deviceName).toBe('P1');
  });

  it('returns the same error for a wrong secret and a missing room', async () => {
    const r = await start();
    const { state } = await roomWith(r, 1);
    const b = await client(r, 'B');
    b.c.send({ type: 'room:join', roomId: state.room.roomId, secret: 'x'.repeat(43) });
    expect((await b.c.next('error')).code).toBe('ROOM_NOT_FOUND');
    b.c.send({ type: 'room:join', roomId: 'f'.repeat(32), secret: state.room.secret });
    expect((await b.c.next('error')).code).toBe('ROOM_NOT_FOUND');
  });

  it('enforces the participant limit', async () => {
    const r = await start({ roomMaxPeers: 2 });
    const { state } = await roomWith(r, 2);
    const c = await client(r, 'C');
    c.c.send({ type: 'room:join', roomId: state.room.roomId, secret: state.room.secret });
    expect((await c.c.next('error')).code).toBe('ROOM_FULL');
  });

  it('notifies peers on leave and reports room:left to the leaver', async () => {
    const r = await start();
    const { a, others } = await roomWith(r, 2);
    await a.c.next('peer:joined');
    others[0]!.c.send({ type: 'room:leave', cid: 'bye' });
    expect((await others[0]!.c.next('room:left')).cid).toBe('bye');
    const left = await a.c.next('peer:left');
    expect(left.peerId).toBe(others[0]!.ready.peerId);
    expect(left.reason).toBe('left');
  });

  it('expires rooms and distinguishes expired rooms for holders of the secret', async () => {
    const r = await start({ roomTtlMs: 300 });
    const { a, state } = await roomWith(r, 1);
    expect((await a.c.next('room:left', 2000)).reason).toBe('expired');
    const b = await client(r, 'B');
    b.c.send({ type: 'room:join', roomId: state.room.roomId, secret: state.room.secret });
    expect((await b.c.next('error')).code).toBe('ROOM_EXPIRED');
  });

  it('removes empty rooms after the retention period', async () => {
    const r = await start({ roomRetentionMs: 100 });
    const { a, state } = await roomWith(r, 1);
    a.c.send({ type: 'room:leave' });
    await a.c.next('room:left');
    await sleep(250);
    expect(r.server.hub.stats().rooms).toBe(0);
    const b = await client(r, 'B');
    b.c.send({ type: 'room:join', roomId: state.room.roomId, secret: state.room.secret });
    expect((await b.c.next('error')).code).toBe('ROOM_EXPIRED');
  });

  it('rate-limits join attempts per IP', async () => {
    const r = await start({ rate: { ...(await import('../../apps/server/src/config.ts')).testConfig().rate, joinPerMin: 2 } });
    const b = await client(r, 'B');
    for (let i = 0; i < 2; i++) {
      b.c.send({ type: 'room:join', roomId: 'f'.repeat(32), secret: 'y'.repeat(43) });
      expect((await b.c.next('error')).code).toBe('ROOM_NOT_FOUND');
    }
    b.c.send({ type: 'room:join', roomId: 'f'.repeat(32), secret: 'y'.repeat(43) });
    expect((await b.c.next('error')).code).toBe('RATE_LIMITED');
  });
});

describe('short-code joins require approval', () => {
  it('creates a join request that a member approves', async () => {
    const r = await start();
    const { a, state } = await roomWith(r, 1);
    const b = await client(r, 'Phone');
    b.c.send({ type: 'room:join-code', code: state.room.code!, cid: 'j' });
    const pending = await b.c.next('room:join-pending');
    const req = await a.c.next('room:join-request');
    expect(req.requestId).toBe(pending.requestId);
    expect(req.deviceName).toBe('Phone');
    // Not yet a member: cannot signal anyone.
    b.c.send({ type: 'signal:ice', to: a.ready.peerId, gen: 1, candidate: null });
    expect((await b.c.next('error')).code).toBe('NOT_IN_ROOM');

    a.c.send({ type: 'room:approve', requestId: req.requestId, approve: true });
    const joinedState = await b.c.next('room:state');
    expect(joinedState.room.roomId).toBe(state.room.roomId);
    await a.c.next('room:join-request-closed');
    expect((await a.c.next('peer:joined')).peer.deviceName).toBe('Phone');
  });

  it('tells the requester when a member denies', async () => {
    const r = await start();
    const { a, state } = await roomWith(r, 1);
    const b = await client(r, 'Phone');
    b.c.send({ type: 'room:join-code', code: state.room.code! });
    const req = await a.c.next('room:join-request');
    a.c.send({ type: 'room:approve', requestId: req.requestId, approve: false });
    expect((await b.c.next('error')).code).toBe('JOIN_DENIED');
  });

  it('does not let non-members decide requests', async () => {
    const r = await start();
    const { a, state } = await roomWith(r, 1);
    const b = await client(r, 'Phone');
    b.c.send({ type: 'room:join-code', code: state.room.code! });
    const req = await a.c.next('room:join-request');
    const outsider = await client(r, 'Outsider');
    outsider.c.send({ type: 'room:approve', requestId: req.requestId, approve: true });
    expect((await outsider.c.next('error')).code).toBe('JOIN_REQUEST_EXPIRED');
    expect(b.c.messages.find((m) => m.type === 'room:state')).toBeUndefined();
  });

  it('rejects unknown and expired codes', async () => {
    const r = await start({ roomCodeTtlMs: 200 });
    const { state } = await roomWith(r, 1);
    const b = await client(r, 'B');
    b.c.send({ type: 'room:join-code', code: 'ZZZZ-ZZZZ' });
    expect((await b.c.next('error')).code).toBe('CODE_INVALID');
    await sleep(300);
    b.c.send({ type: 'room:join-code', code: state.room.code! });
    expect((await b.c.next('error')).code).toBe('CODE_INVALID');
  });

  it('expires unanswered join requests', async () => {
    const r = await start({ joinRequestTtlMs: 200 });
    const { state } = await roomWith(r, 1);
    const b = await client(r, 'B');
    b.c.send({ type: 'room:join-code', code: state.room.code! });
    await b.c.next('room:join-pending');
    expect((await b.c.next('error', 2000)).code).toBe('JOIN_REQUEST_EXPIRED');
  });

  it('locks code joins globally once the failure budget is spent', async () => {
    const base = (await import('../../apps/server/src/config.ts')).testConfig().rate;
    const r = await start({ rate: { ...base, codeFailGlobalPerMin: 3, codeJoinPerMin: 100 } });
    const b = await client(r, 'B');
    for (let i = 0; i < 3; i++) {
      b.c.send({ type: 'room:join-code', code: 'ZZZZ-ZZZZ' });
      expect((await b.c.next('error')).code).toBe('CODE_INVALID');
    }
    b.c.send({ type: 'room:join-code', code: 'ZZZZ-ZZZZ' });
    expect((await b.c.next('error')).code).toBe('RATE_LIMITED');
  });
});

describe('signaling routing and authorization', () => {
  it('routes offers with a server-stamped sender', async () => {
    const r = await start();
    const { a, others } = await roomWith(r, 2);
    const b = others[0]!;
    a.c.send({ type: 'signal:offer', to: b.ready.peerId, gen: 1, sdp: 'v=0 fake' });
    const offer = await b.c.next('signal:offer');
    expect(offer.from).toBe(a.ready.peerId);
    expect(offer.sdp).toBe('v=0 fake');
    b.c.send({ type: 'signal:ice', to: a.ready.peerId, gen: 1, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    expect((await a.c.next('signal:ice')).from).toBe(b.ready.peerId);
  });

  it('rejects client-supplied sender identities', async () => {
    const r = await start();
    const { a, others } = await roomWith(r, 2);
    a.c.send({ type: 'signal:offer', to: others[0]!.ready.peerId, from: others[0]!.ready.peerId, gen: 1, sdp: 'x' });
    expect((await a.c.next('error')).code).toBe('BAD_REQUEST');
  });

  it('rejects cross-room signaling without delivering anything', async () => {
    const r = await start();
    const room1 = await roomWith(r, 1);
    const room2 = await roomWith(r, 1);
    room2.a.c.send({ type: 'signal:offer', to: room1.a.ready.peerId, gen: 1, sdp: 'x' });
    expect((await room2.a.c.next('error')).code).toBe('PEER_NOT_FOUND');
    await sleep(100);
    expect(room1.a.c.messages.find((m) => m.type === 'signal:offer')).toBeUndefined();
  });

  it('rejects signaling to yourself and from outside any room', async () => {
    const r = await start();
    const { a } = await roomWith(r, 1);
    a.c.send({ type: 'signal:offer', to: a.ready.peerId, gen: 1, sdp: 'x' });
    expect((await a.c.next('error')).code).toBe('PEER_NOT_FOUND');
    const lone = await client(r, 'Lone');
    lone.c.send({ type: 'signal:offer', to: a.ready.peerId, gen: 1, sdp: 'x' });
    expect((await lone.c.next('error')).code).toBe('NOT_IN_ROOM');
  });
});

describe('malformed input', () => {
  it('survives invalid JSON, wrong versions, and schema violations', async () => {
    const r = await start();
    const { c } = await client(r);
    c.sendRaw('{not json');
    expect((await c.next('error')).code).toBe('BAD_REQUEST');
    c.sendRaw(JSON.stringify({ v: 99, type: 'ping', t: 1 }));
    expect((await c.next('error')).code).toBe('UNSUPPORTED_VERSION');
    c.send({ type: 'room:join', roomId: '../../etc', secret: 1 });
    expect((await c.next('error')).code).toBe('BAD_REQUEST');
    c.send({ type: 'ping', t: 5 });
    expect((await c.next('pong')).t).toBe(5);
    const health = await fetch(`${r.origin}/healthz`);
    expect(health.status).toBe(200);
  });

  it('closes the socket on an oversized message', async () => {
    const r = await start();
    const { c } = await client(r);
    c.sendRaw(JSON.stringify({ v: 1, type: 'ping', t: 1, pad: 'x'.repeat(70 * 1024) }));
    expect((await c.waitClosed()).code).toBe(1009);
    expect((await fetch(`${r.origin}/healthz`)).status).toBe(200);
  });

  it('closes sockets that keep sending invalid messages', async () => {
    const r = await start();
    const { c } = await client(r);
    for (let i = 0; i < 25; i++) c.sendRaw('garbage');
    expect((await c.waitClosed()).code).toBe(1008);
  });

  it('rate-limits message floods', async () => {
    const base = (await import('../../apps/server/src/config.ts')).testConfig().rate;
    const r = await start({ rate: { ...base, messagesBurst: 5, messagesPerSec: 1 } });
    const { c } = await client(r);
    for (let i = 0; i < 20; i++) c.send({ type: 'ping', t: i });
    expect((await c.next('error')).code).toBe('RATE_LIMITED');
  });
});

describe('sessions, reconnect, and heartbeat', () => {
  it('resumes a session with a rotated token and keeps the peerId and room', async () => {
    const r = await start();
    const { a, others } = await roomWith(r, 2);
    await a.c.next('peer:joined');
    const b = others[0]!;
    b.c.close();
    const update = await a.c.next('peer:updated');
    expect(update.peer.status).toBe('reconnecting');

    // Signals sent while B is away are queued (bounded) and delivered on resume.
    a.c.send({ type: 'signal:offer', to: b.ready.peerId, gen: 2, sdp: 'queued' });

    const b2 = new TestClient(r.port, r.origin);
    clients.push(b2);
    const ready = await b2.init('P1', b.ready.resumeToken);
    expect(ready.resumed).toBe(true);
    expect(ready.peerId).toBe(b.ready.peerId);
    expect(ready.resumeToken).not.toBe(b.ready.resumeToken);
    await b2.next('room:state');
    expect((await b2.next('signal:offer')).sdp).toBe('queued');
    expect((await a.c.next('peer:updated')).peer.status).toBe('online');

    // The old token is single-use.
    const b3 = new TestClient(r.port, r.origin);
    clients.push(b3);
    const ready3 = await b3.init('P1', b.ready.resumeToken);
    expect(ready3.resumed).toBe(false);
    expect(ready3.peerId).not.toBe(b.ready.peerId);
  });

  it('drops a disconnected session after the grace period', async () => {
    const r = await start({ resumeGraceMs: 150 });
    const { a, others } = await roomWith(r, 2);
    await a.c.next('peer:joined');
    others[0]!.c.close();
    const left = await a.c.next('peer:left', 2000);
    expect(left.reason).toBe('timeout');
  });

  it('terminates sockets that stop answering heartbeats', async () => {
    const r = await start({ heartbeatIntervalMs: 100 });
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/ws`, { headers: { Origin: r.origin }, autoPong: false });
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ v: 1, type: 'session:init', deviceName: 'Zombie', deviceKind: 'phone' }));
    expect(await closed).toBe(1006);
    await sleep(50);
    expect(r.server.hub.stats().clients).toBe(0);
  });
});

describe('graceful shutdown', () => {
  it('notifies clients, closes sockets with 1001, and refuses new connections', async () => {
    const r = await start({ shutdownGraceMs: 500 });
    const { c } = await client(r);
    const stopping = r.close();
    expect((await c.next('server:shutdown')).type).toBe('server:shutdown');
    expect((await c.waitClosed()).code).toBe(1001);
    await stopping;
    running = null;
    const late = new TestClient(r.port, r.origin);
    await expect(late.opened()).rejects.toThrow();
  });
});

describe('log redaction', () => {
  it('never writes secrets, tokens, SDP, or names to logs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const r = await start({}, createLogger('trace', sink));
    const { a, state, others } = await roomWith(r, 2);
    a.c.send({ type: 'signal:offer', to: others[0]!.ready.peerId, gen: 1, sdp: 'SECRET-SDP-BODY' });
    await others[0]!.c.next('signal:offer');
    a.c.send({ type: 'room:join', roomId: state.room.roomId, secret: 'z'.repeat(43) });
    await a.c.next('error');
    await sleep(50);
    const all = lines.join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(state.room.secret);
    expect(all).not.toContain(state.room.roomId);
    expect(all).not.toContain(a.ready.resumeToken);
    expect(all).not.toContain('SECRET-SDP-BODY');
    expect(all).not.toContain(state.room.code!);
  });
});

describe('HTTP surface', () => {
  it('serves health, readiness, client config, and security headers', async () => {
    const r = await start({ publicOrigin: 'https://landrop.lan:8443' });
    const health = await fetch(`${r.origin}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(health.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(health.headers.get('referrer-policy')).toBe('no-referrer');
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(`${r.origin}/readyz`)).status).toBe(200);
    const cfg = (await (await fetch(`${r.origin}/api/config`)).json()) as Record<string, unknown>;
    expect(cfg).toMatchObject({ protocolVersion: 1, mode: 'lan', iceServers: [], publicOrigin: 'https://landrop.lan:8443' });
    // No permissive CORS.
    expect((await fetch(`${r.origin}/api/config`, { headers: { Origin: 'https://evil.example' } })).headers.get('access-control-allow-origin')).toBeNull();
  });
});
