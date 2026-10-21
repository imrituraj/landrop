import { createHash } from 'node:crypto';
import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Structured logger with redaction. Policy: never log chat bodies, file data,
 * file names, room secrets, session tokens, SDP, or ICE candidates. Code must log
 * message *types* and IDs only; redaction paths are a second line of defense.
 */
export const REDACT_PATHS = [
  'secret',
  'resumeToken',
  'token',
  'sdp',
  'candidate',
  'text',
  'name',
  '*.secret',
  '*.resumeToken',
  '*.token',
  '*.sdp',
  '*.candidate',
  '*.text',
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["sec-websocket-key"]',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { svc: 'landrop' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}

/** Short, non-reversible tag for correlating log lines about a room or peer. */
export function logTag(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}
