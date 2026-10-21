import { z } from 'zod';
import {
  DeviceKindSchema,
  DeviceNameSchema,
  ErrorCodeSchema,
  IdSchema,
  LIMITS,
  SECRET_B64URL,
  VersionSchema,
} from './common.ts';

/**
 * Signaling protocol (browser <-> server, JSON over WebSocket).
 *
 * Client->server schemas are strict (unknown keys rejected). The server never
 * trusts any identity field from clients: `from` exists only on server->client
 * messages and is stamped by the server from the authenticated socket.
 */

const Cid = z.string().min(1).max(64).optional(); // correlation id echoed in replies/errors

const SessionToken = z.string().regex(SECRET_B64URL);
const RoomSecret = z.string().regex(SECRET_B64URL);
const ShortCode = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

const Sdp = z.string().min(1).max(LIMITS.sdpChars);
const Gen = z.number().int().min(1).max(1_000_000);

export const IceCandidateSchema = z.strictObject({
  candidate: z.string().max(1024),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(1024).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    v: VersionSchema,
    type: z.literal('session:init'),
    deviceName: DeviceNameSchema,
    deviceKind: DeviceKindSchema,
    resumeToken: SessionToken.optional(),
  }),
  z.strictObject({ v: VersionSchema, type: z.literal('room:create'), cid: Cid }),
  z.strictObject({ v: VersionSchema, type: z.literal('room:join'), cid: Cid, roomId: IdSchema, secret: RoomSecret }),
  z.strictObject({ v: VersionSchema, type: z.literal('room:join-code'), cid: Cid, code: ShortCode }),
  z.strictObject({ v: VersionSchema, type: z.literal('room:approve'), requestId: IdSchema, approve: z.boolean() }),
  z.strictObject({ v: VersionSchema, type: z.literal('room:leave'), cid: Cid }),
  z.strictObject({ v: VersionSchema, type: z.literal('room:refresh-code'), cid: Cid }),
  z.strictObject({ v: VersionSchema, type: z.literal('peer:update'), deviceName: DeviceNameSchema }),
  z.strictObject({ v: VersionSchema, type: z.literal('signal:offer'), to: IdSchema, gen: Gen, sdp: Sdp }),
  z.strictObject({ v: VersionSchema, type: z.literal('signal:answer'), to: IdSchema, gen: Gen, sdp: Sdp }),
  z.strictObject({
    v: VersionSchema,
    type: z.literal('signal:ice'),
    to: IdSchema,
    gen: Gen,
    candidate: IceCandidateSchema.nullable(),
  }),
  z.strictObject({ v: VersionSchema, type: z.literal('ping'), t: z.number().finite() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const PeerStatusSchema = z.enum(['online', 'reconnecting']);

export const PeerInfoSchema = z.object({
  peerId: IdSchema,
  deviceName: z.string(),
  deviceKind: DeviceKindSchema,
  status: PeerStatusSchema,
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

export const RoomInfoSchema = z.object({
  roomId: IdSchema,
  /** Invite secret; only ever sent to members of the room. */
  secret: RoomSecret,
  code: ShortCode.nullable(),
  codeExpiresAt: z.number().nullable(),
  expiresAt: z.number(),
  maxPeers: z.number().int(),
});
export type RoomInfo = z.infer<typeof RoomInfoSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v: VersionSchema,
    type: z.literal('session:ready'),
    peerId: IdSchema,
    resumeToken: SessionToken,
    resumed: z.boolean(),
    resumeGraceMs: z.number().int(),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('room:state'),
    cid: Cid,
    room: RoomInfoSchema,
    self: PeerInfoSchema,
    peers: z.array(PeerInfoSchema),
  }),
  z.object({ v: VersionSchema, type: z.literal('room:left'), cid: Cid, reason: z.enum(['left', 'expired', 'kicked']) }),
  z.object({ v: VersionSchema, type: z.literal('room:join-pending'), cid: Cid, requestId: IdSchema, expiresAt: z.number() }),
  z.object({
    v: VersionSchema,
    type: z.literal('room:join-request'),
    requestId: IdSchema,
    deviceName: z.string(),
    deviceKind: DeviceKindSchema,
    expiresAt: z.number(),
  }),
  z.object({ v: VersionSchema, type: z.literal('room:join-request-closed'), requestId: IdSchema }),
  z.object({ v: VersionSchema, type: z.literal('peer:joined'), peer: PeerInfoSchema }),
  z.object({ v: VersionSchema, type: z.literal('peer:left'), peerId: IdSchema, reason: z.enum(['left', 'timeout']) }),
  z.object({ v: VersionSchema, type: z.literal('peer:updated'), peer: PeerInfoSchema }),
  z.object({ v: VersionSchema, type: z.literal('signal:offer'), from: IdSchema, gen: Gen, sdp: Sdp }),
  z.object({ v: VersionSchema, type: z.literal('signal:answer'), from: IdSchema, gen: Gen, sdp: Sdp }),
  z.object({ v: VersionSchema, type: z.literal('signal:ice'), from: IdSchema, gen: Gen, candidate: IceCandidateSchema.nullable() }),
  z.object({ v: VersionSchema, type: z.literal('pong'), t: z.number() }),
  z.object({ v: VersionSchema, type: z.literal('server:shutdown') }),
  z.object({
    v: VersionSchema,
    type: z.literal('error'),
    cid: Cid,
    code: ErrorCodeSchema,
    message: z.string().max(LIMITS.errorMessageChars),
    /** Message type that caused the error, if any. */
    for: z.string().max(40).optional(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage['type'];

/** Distributive Omit so it works per union member. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ServerMessageBody = DistributiveOmit<ServerMessage, 'v'>;
export type ClientMessageBody = DistributiveOmit<ClientMessage, 'v'>;

/** Public client configuration served at GET /api/config. */
export const ClientConfigSchema = z.object({
  protocolVersion: z.number().int(),
  mode: z.enum(['lan']),
  /** Empty in LAN mode: no external STUN/TURN. */
  iceServers: z.array(z.object({ urls: z.union([z.string(), z.array(z.string())]) })),
  maxPeers: z.number().int(),
  resumeGraceMs: z.number().int(),
  /** Origin to put in invitation links (e.g. https://landrop.lan:8443), if configured. */
  publicOrigin: z.string().nullable(),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;
