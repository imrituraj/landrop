import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { PROTOCOL_VERSION, type ClientConfig } from '@landrop/protocol';
import type { Config } from './config.ts';
import { SignalingHub } from './hub.ts';

/**
 * HTTP server: health endpoints, client config, static web app, security
 * headers, and the WebSocket upgrade path handed to the SignalingHub.
 *
 * Fastify was chosen over Express for its built-in pino logging with redaction,
 * lifecycle hooks used for graceful shutdown, and `inject()` for testing.
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "media-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface LanDropServer {
  app: FastifyInstance;
  hub: SignalingHub;
  /** Graceful stop: readiness false, notify clients, close sockets, close HTTP. */
  stop(): Promise<void>;
}

export async function createServer(config: Config, logger: Logger): Promise<LanDropServer> {
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024,
    // Proxy trust only affects request.ip; the hub applies the same setting for WebSockets.
    trustProxy: config.trustProxy,
  });
  const hub = new SignalingHub(config, logger.child({ mod: 'hub' }));
  let stopping = false;

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    return payload;
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    if (stopping) return reply.code(503).send({ status: 'stopping' });
    return { status: 'ready' };
  });

  app.get('/api/config', async (_req, reply) => {
    const body: ClientConfig = {
      protocolVersion: PROTOCOL_VERSION,
      mode: 'lan',
      iceServers: [],
      maxPeers: config.roomMaxPeers,
      resumeGraceMs: config.resumeGraceMs,
      publicOrigin: config.publicOrigin,
    };
    reply.header('Cache-Control', 'no-store');
    return body;
  });

  if (config.staticDir) {
    const root = resolve(config.staticDir);
    if (!existsSync(resolve(root, 'index.html'))) {
      throw new Error(`STATIC_DIR ${root} does not contain index.html (run \`pnpm build\` first)`);
    }
    await app.register(fastifyStatic, {
      root,
      index: ['index.html'],
      wildcard: false,
      setHeaders(res, path) {
        // Vite emits content-hashed names under /assets; everything else must revalidate.
        if (/[\\/]assets[\\/]/.test(path)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache');
      },
    });
  }

  app.server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info({ evt: 'shutdown_begin' }, 'shutting down');
    await hub.shutdown(config.shutdownGraceMs);
    await app.close();
    logger.info({ evt: 'shutdown_complete' }, 'shutdown complete');
  }

  return { app, hub, stop };
}
