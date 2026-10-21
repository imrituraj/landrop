import { z } from 'zod';

/**
 * Server configuration from environment variables, validated at startup.
 * Invalid configuration aborts startup with a readable error.
 */

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const origins = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
  )
  .pipe(
    z.array(
      z.string().refine((o) => {
        try {
          const u = new URL(o);
          return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === o;
        } catch {
          return false;
        }
      }, 'ALLOWED_ORIGINS entries must be exact origins like https://landrop.lan:8443 (no path, no trailing slash)'),
    ),
  );

const EnvSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: int(1, 65535).default(8787),
  /** Exact origins allowed to open the signaling WebSocket. */
  ALLOWED_ORIGINS: origins.default([]),
  /** Also allow an Origin whose host:port equals the request Host header. */
  ALLOW_SAME_ORIGIN: bool.default(true),
  /** Trust X-Forwarded-For from a reverse proxy for per-IP limits. Only enable behind the proxy. */
  TRUST_PROXY: bool.default(false),
  /** Origin used in invitation links, e.g. https://landrop.lan:8443. Empty = the page's own origin. */
  PUBLIC_ORIGIN: origins
    .refine((list) => list.length <= 1, 'PUBLIC_ORIGIN must be a single origin')
    .default([]),
  /** Directory with the built web app. Empty = do not serve static files. */
  STATIC_DIR: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  ROOM_TTL_SECONDS: int(60, 7 * 24 * 3600).default(24 * 3600),
  ROOM_RETENTION_SECONDS: int(0, 24 * 3600).default(300),
  ROOM_MAX_PEERS: int(2, 32).default(8),
  ROOM_CODE_TTL_SECONDS: int(30, 3600).default(600),
  JOIN_REQUEST_TTL_SECONDS: int(10, 600).default(90),
  MAX_ROOMS: int(1, 100_000).default(500),
  MAX_CLIENTS: int(1, 100_000).default(1000),
  MAX_CLIENTS_PER_IP: int(1, 1000).default(20),
  SESSION_RESUME_GRACE_SECONDS: int(0, 3600).default(45),
  HEARTBEAT_INTERVAL_MS: int(1000, 120_000).default(15_000),
  INIT_TIMEOUT_MS: int(500, 60_000).default(10_000),
  SHUTDOWN_GRACE_MS: int(0, 60_000).default(3000),

  /** Rate limits: capacity (burst) and refill per minute. */
  RATE_JOIN_PER_MIN: int(1, 10_000).default(10),
  RATE_CODE_JOIN_PER_MIN: int(1, 10_000).default(5),
  RATE_CODE_FAIL_GLOBAL_PER_MIN: int(1, 100_000).default(60),
  RATE_ROOM_CREATE_PER_MIN: int(1, 10_000).default(10),
  RATE_MESSAGES_PER_SEC: int(1, 100_000).default(50),
  RATE_MESSAGES_BURST: int(1, 100_000).default(200),
  RATE_CONNECT_PER_MIN: int(1, 100_000).default(60),
});

export type Config = {
  host: string;
  port: number;
  allowedOrigins: string[];
  allowSameOrigin: boolean;
  trustProxy: boolean;
  staticDir: string;
  publicOrigin: string | null;
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  roomTtlMs: number;
  roomRetentionMs: number;
  roomMaxPeers: number;
  roomCodeTtlMs: number;
  joinRequestTtlMs: number;
  maxRooms: number;
  maxClients: number;
  maxClientsPerIp: number;
  resumeGraceMs: number;
  heartbeatIntervalMs: number;
  initTimeoutMs: number;
  shutdownGraceMs: number;
  rate: {
    joinPerMin: number;
    codeJoinPerMin: number;
    codeFailGlobalPerMin: number;
    roomCreatePerMin: number;
    messagesPerSec: number;
    messagesBurst: number;
    connectPerMin: number;
  };
};

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings as unset so `.env` templates with blank values use defaults.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    host: e.HOST,
    port: e.PORT,
    allowedOrigins: e.ALLOWED_ORIGINS,
    allowSameOrigin: e.ALLOW_SAME_ORIGIN,
    trustProxy: e.TRUST_PROXY,
    staticDir: e.STATIC_DIR,
    publicOrigin: e.PUBLIC_ORIGIN[0] ?? null,
    logLevel: e.LOG_LEVEL,
    roomTtlMs: e.ROOM_TTL_SECONDS * 1000,
    roomRetentionMs: e.ROOM_RETENTION_SECONDS * 1000,
    roomMaxPeers: e.ROOM_MAX_PEERS,
    roomCodeTtlMs: e.ROOM_CODE_TTL_SECONDS * 1000,
    joinRequestTtlMs: e.JOIN_REQUEST_TTL_SECONDS * 1000,
    maxRooms: e.MAX_ROOMS,
    maxClients: e.MAX_CLIENTS,
    maxClientsPerIp: e.MAX_CLIENTS_PER_IP,
    resumeGraceMs: e.SESSION_RESUME_GRACE_SECONDS * 1000,
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    initTimeoutMs: e.INIT_TIMEOUT_MS,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    rate: {
      joinPerMin: e.RATE_JOIN_PER_MIN,
      codeJoinPerMin: e.RATE_CODE_JOIN_PER_MIN,
      codeFailGlobalPerMin: e.RATE_CODE_FAIL_GLOBAL_PER_MIN,
      roomCreatePerMin: e.RATE_ROOM_CREATE_PER_MIN,
      messagesPerSec: e.RATE_MESSAGES_PER_SEC,
      messagesBurst: e.RATE_MESSAGES_BURST,
      connectPerMin: e.RATE_CONNECT_PER_MIN,
    },
  };
}

/** Defaults with overrides, for tests. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ LOG_LEVEL: 'silent' }), ...overrides };
}
