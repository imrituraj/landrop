import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, ServerMessageSchema, type ServerMessage } from '@landrop/protocol';
import { createServer, type LanDropServer } from '../../apps/server/src/app.ts';
import { testConfig, type Config } from '../../apps/server/src/config.ts';
import { createLogger } from '../../apps/server/src/logger.ts';

export interface Running {
  server: LanDropServer;
  port: number;
  origin: string;
  close(): Promise<void>;
}

export async function startServer(overrides: Partial<Config> = {}, logger?: Logger): Promise<Running> {
  const config = testConfig({ port: 0, host: '127.0.0.1', ...overrides });
  const server = await createServer(config, logger ?? createLogger('silent'));
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (server.app.server.address() as AddressInfo).port;
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => server.stop(),
  };
}

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** Minimal test client that records every validated server message. */
export class TestClient {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  closed: { code: number; reason: string } | null = null;

  constructor(port: number, origin: string | null, ip?: string) {
    const headers: Record<string, string> = {};
    if (origin !== null) headers['Origin'] = origin;
    if (ip) headers['X-Forwarded-For'] = ip;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    this.ws.on('message', (data) => {
      const parsed = ServerMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) throw new Error(`server sent invalid message: ${data.toString()}`);
      this.messages.push(parsed.data);
      this.notify();
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.notify();
    });
    this.ws.on('error', () => this.notify());
  }

  private notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  send(body: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...body }));
  }

  sendRaw(raw: string): void {
    this.ws.send(raw);
  }

  /** Wait for the next message of `type` not yet consumed (consumes it). */
  async next<T extends ServerMessage['type']>(type: T, timeoutMs = 3000, pred?: (m: Msg<T>) => boolean): Promise<Msg<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.messages.findIndex((m) => m.type === type && (!pred || pred(m as Msg<T>)));
      if (idx >= 0) return this.messages.splice(idx, 1)[0] as Msg<T>;
      if (this.closed) throw new Error(`closed (${this.closed.code}) while waiting for ${type}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout waiting for ${type}; have: ${this.messages.map((m) => m.type).join(',')}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async waitClosed(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('timeout waiting for close');
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.closed;
  }

  async init(name = 'Test device', resumeToken?: string): Promise<Msg<'session:ready'>> {
    await this.opened();
    this.send({ type: 'session:init', deviceName: name, deviceKind: 'laptop', ...(resumeToken ? { resumeToken } : {}) });
    return this.next('session:ready');
  }

  close(): void {
    this.ws.close();
  }
}

export async function connect(r: Running, name = 'Device', ip?: string): Promise<{ c: TestClient; ready: Msg<'session:ready'> }> {
  const c = new TestClient(r.port, r.origin, ip);
  const ready = await c.init(name);
  return { c, ready };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
