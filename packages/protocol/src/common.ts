import { z } from 'zod';

/** Bumped on any incompatible change to signaling, control, or binary framing. */
export const PROTOCOL_VERSION = 1 as const;

export const LIMITS = {
  /** Max size of one WebSocket signaling message (bytes, enforced by `ws`). */
  signalingMessageBytes: 64 * 1024,
  /** Max SDP length accepted by the server. */
  sdpChars: 32 * 1024,
  /** Max size of one data-channel control or chat message (UTF-16 code units before parse). */
  controlMessageChars: 32 * 1024,
  /** Max chat message length (characters). */
  chatChars: 4000,
  deviceNameChars: 40,
  fileNameChars: 1024,
  mimeChars: 255,
  errorMessageChars: 500,
} as const;

export const ID_HEX = /^[0-9a-f]{32}$/;
export const SECRET_B64URL = /^[A-Za-z0-9_-]{43}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export const IdSchema = z.string().regex(ID_HEX);
export const VersionSchema = z.literal(PROTOCOL_VERSION);
/** Non-negative safe integer: file sizes, byte offsets. */
export const ByteCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const DeviceKindSchema = z.enum(['desktop', 'laptop', 'phone', 'tablet', 'unknown']);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

/** Display names are untrusted labels. Strip control/bidi chars, collapse whitespace. */
export const DeviceNameSchema = z
  .string()
  .max(200)
  .transform((s) =>
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, LIMITS.deviceNameChars),
  )
  .refine((s) => s.length > 0, 'empty name');

/** Stable error codes shared by server and clients. */
export const ErrorCodeSchema = z.enum([
  // signaling
  'BAD_REQUEST',
  'UNSUPPORTED_VERSION',
  'NOT_INITIALIZED',
  'ALREADY_INITIALIZED',
  'SESSION_EXPIRED',
  'RATE_LIMITED',
  'MESSAGE_TOO_LARGE',
  'ROOM_NOT_FOUND',
  'ROOM_EXPIRED',
  'ROOM_FULL',
  'ROOM_LIMIT',
  'ALREADY_IN_ROOM',
  'NOT_IN_ROOM',
  'PEER_NOT_FOUND',
  'PEER_UNAVAILABLE',
  'CODE_INVALID',
  'JOIN_DENIED',
  'JOIN_REQUEST_EXPIRED',
  'SERVER_FULL',
  'SERVER_SHUTTING_DOWN',
  'INTERNAL',
  // transfer
  'REJECTED_BY_USER',
  'TOO_LARGE_FOR_SINK',
  'UNSUPPORTED_CAPABILITY',
  'PROTOCOL_VIOLATION',
  'INVALID_FRAME',
  'INTEGRITY_MISMATCH',
  'READ_FAILED',
  'WRITE_FAILED',
  'SINK_PERMISSION_DENIED',
  'SINK_CANCELLED',
  'QUOTA_EXCEEDED',
  'ACK_TIMEOUT',
  'ACCEPT_TIMEOUT',
  'VERIFY_TIMEOUT',
  'RECONNECT_TIMEOUT',
  'PEER_LEFT',
  'CANCELLED_BY_SENDER',
  'CANCELLED_BY_RECEIVER',
  'RESUME_MISMATCH',
  'TOO_MANY_PENDING',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: 'The request was malformed.',
  UNSUPPORTED_VERSION: 'This device runs an incompatible LanDrop version. Reload both devices.',
  NOT_INITIALIZED: 'The session was not initialized.',
  ALREADY_INITIALIZED: 'The session was already initialized.',
  SESSION_EXPIRED: 'Your session expired. Join the room again.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  MESSAGE_TOO_LARGE: 'The message is too large.',
  ROOM_NOT_FOUND: 'Room not found, or the invitation is invalid.',
  ROOM_EXPIRED: 'This room has expired. Create a new one.',
  ROOM_FULL: 'This room is full.',
  ROOM_LIMIT: 'The server cannot host more rooms right now.',
  ALREADY_IN_ROOM: 'Leave the current room first.',
  NOT_IN_ROOM: 'You are not in a room.',
  PEER_NOT_FOUND: 'That device is not in this room.',
  PEER_UNAVAILABLE: 'That device is temporarily unreachable.',
  CODE_INVALID: 'That room code is invalid or has expired.',
  JOIN_DENIED: 'Your request to join was declined.',
  JOIN_REQUEST_EXPIRED: 'Nobody approved the join request in time.',
  SERVER_FULL: 'The server has reached its connection limit.',
  SERVER_SHUTTING_DOWN: 'The LanDrop server is shutting down.',
  INTERNAL: 'Unexpected server error.',
  REJECTED_BY_USER: 'The receiver declined the file.',
  TOO_LARGE_FOR_SINK: 'The file is larger than the receiving browser can safely store.',
  UNSUPPORTED_CAPABILITY: 'The other device does not support a required feature.',
  PROTOCOL_VIOLATION: 'The other device sent an invalid message.',
  INVALID_FRAME: 'Received corrupt or unexpected file data.',
  INTEGRITY_MISMATCH: 'Integrity check failed: the received bytes do not match what was sent.',
  READ_FAILED: 'Could not read the source file (was it moved or modified?).',
  WRITE_FAILED: 'Could not write the received file to disk.',
  SINK_PERMISSION_DENIED: 'Permission to write the file was denied.',
  SINK_CANCELLED: 'Saving was cancelled.',
  QUOTA_EXCEEDED: 'Not enough storage space.',
  ACK_TIMEOUT: 'The receiver stopped acknowledging data.',
  ACCEPT_TIMEOUT: 'The receiver did not respond to the offer in time.',
  VERIFY_TIMEOUT: 'The receiver did not confirm verification in time.',
  RECONNECT_TIMEOUT: 'The connection could not be re-established in time.',
  PEER_LEFT: 'The other device left.',
  CANCELLED_BY_SENDER: 'Cancelled by the sender.',
  CANCELLED_BY_RECEIVER: 'Cancelled by the receiver.',
  RESUME_MISMATCH: 'The transfer could not be resumed safely.',
  TOO_MANY_PENDING: 'Too many pending requests from that device.',
};
