import { z } from 'zod';
import { ByteCountSchema, ErrorCodeSchema, IdSchema, LIMITS, SHA256_HEX, VersionSchema } from './common.ts';

/**
 * Peer-to-peer protocol over WebRTC data channels.
 *
 *   channel "control" (id 0, reliable, ordered): capabilities + transfer:* messages (JSON)
 *   channel "chat"    (id 1, reliable, ordered): chat:* messages (JSON)
 *   channel "file"    (id 2, reliable, ordered): binary data frames (see transfer-core/frame.ts)
 *
 * All peer messages are untrusted input and must be parsed with `parsePeerMessage`.
 */

const Attempt = z.number().int().min(1).max(1_000_000);
const Sha256 = z.string().regex(SHA256_HEX);

export const SinkKindSchema = z.enum(['streaming', 'memory']);
export type SinkKind = z.infer<typeof SinkKindSchema>;

export const CapabilitiesSchema = z.strictObject({
  v: VersionSchema,
  type: z.literal('capabilities'),
  /** Receiver can stream to disk via the File System Access API. */
  streamingSink: z.boolean(),
  /** Largest file the in-memory fallback sink will accept. */
  memorySinkMaxBytes: ByteCountSchema,
  /** Largest file accepted at all with the best available sink. */
  maxAcceptBytes: ByteCountSchema,
  /** Max binary message the receiver can take (from RTCSctpTransport.maxMessageSize, 0 = unknown). */
  maxMessageSize: ByteCountSchema,
  hashAlgorithms: z.array(z.enum(['sha-256'])).min(1).max(4),
  resume: z.strictObject({ pause: z.boolean(), reconnect: z.boolean(), reload: z.boolean() }),
});

export const TransferOfferSchema = z.strictObject({
  v: VersionSchema,
  type: z.literal('transfer:offer'),
  id: IdSchema,
  batchId: IdSchema.optional(),
  name: z.string().min(1).max(LIMITS.fileNameChars),
  size: ByteCountSchema,
  mime: z.string().max(LIMITS.mimeChars),
  lastModified: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  hash: z.literal('sha-256'),
});

export const PeerMessageSchema = z.discriminatedUnion('type', [
  CapabilitiesSchema,
  TransferOfferSchema,
  z.strictObject({
    v: VersionSchema,
    type: z.literal('transfer:accept'),
    id: IdSchema,
    attempt: Attempt,
    sink: SinkKindSchema,
    /** Max un-acknowledged bytes the sender may have in flight (receiver credit window). */
    windowBytes: z.number().int().min(16 * 1024).max(256 * 1024 * 1024),
    /** Max payload bytes per binary frame. */
    chunkBytes: z.number().int().min(1024).max(1024 * 1024),
  }),
  z.strictObject({
    v: VersionSchema,
    type: z.literal('transfer:reject'),
    id: IdSchema,
    code: ErrorCodeSchema,
  }),
  z.strictObject({ v: VersionSchema, type: z.literal('transfer:pause'), id: IdSchema }),
  z.strictObject({ v: VersionSchema, type: z.literal('transfer:resume'), id: IdSchema }),
  /**
   * Receiver -> sender after a data-channel reconnect: continue from `offset`,
   * the receiver's written offset, using a new `attempt` number.
   */
  z.strictObject({
    v: VersionSchema,
    type: z.literal('transfer:resume-from'),
    id: IdSchema,
    attempt: Attempt,
    offset: ByteCountSchema,
    size: ByteCountSchema,
  }),
  z.strictObject({ v: VersionSchema, type: z.literal('transfer:cancel'), id: IdSchema }),
  /** Receiver -> sender: all bytes below `offset` have been written to the sink. */
  z.strictObject({ v: VersionSchema, type: z.literal('transfer:ack'), id: IdSchema, attempt: Attempt, offset: ByteCountSchema }),
  /** Sender -> receiver: all bytes sent; here is the SHA-256 over what was read. */
  z.strictObject({
    v: VersionSchema,
    type: z.literal('transfer:finish'),
    id: IdSchema,
    attempt: Attempt,
    size: ByteCountSchema,
    sha256: Sha256,
  }),
  /** Receiver -> sender: bytes written, hash matched, sink finalized. The only completion signal. */
  z.strictObject({ v: VersionSchema, type: z.literal('transfer:verified'), id: IdSchema, sha256: Sha256 }),
  z.strictObject({ v: VersionSchema, type: z.literal('transfer:error'), id: IdSchema, code: ErrorCodeSchema }),
  z.strictObject({
    v: VersionSchema,
    type: z.literal('chat:message'),
    id: IdSchema,
    text: z.string().min(1).max(LIMITS.chatChars),
    sentAt: z.number().int().min(0),
  }),
  z.strictObject({ v: VersionSchema, type: z.literal('chat:ack'), id: IdSchema }),
]);

export type PeerMessage = z.infer<typeof PeerMessageSchema>;
export type PeerMessageType = PeerMessage['type'];
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type TransferOffer = z.infer<typeof TransferOfferSchema>;
export type PeerMessageOf<T extends PeerMessageType> = Extract<PeerMessage, { type: T }>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: 'too_large' | 'not_json' | 'invalid' };

/** Size-check before JSON.parse, then schema-validate. Never throws. */
export function parsePeerMessage(raw: unknown): ParseResult<PeerMessage> {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' };
  if (raw.length > LIMITS.controlMessageChars) return { ok: false, reason: 'too_large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const parsed = PeerMessageSchema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid' };
}
