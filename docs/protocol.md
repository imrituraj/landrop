# Protocol (version 1)

Source of truth: [`packages/protocol/src`](../packages/protocol/src) (Zod schemas)
and [`packages/transfer-core/src/frame.ts`](../packages/transfer-core/src/frame.ts).
Every message carries `v: 1`. A different version is rejected with
`UNSUPPORTED_VERSION` (server) or dropped as invalid (peer).

## 1. Signaling (browser ↔ server, JSON over WebSocket `/ws`)

Transport rules:

- The upgrade is refused (HTTP 403) unless `Origin` is listed in
  `ALLOWED_ORIGINS`, or `ALLOW_SAME_ORIGIN=true` and the Origin's host:port equals
  the `Host` header. A missing `Origin` is refused.
- Max message 64 KiB (`ws` closes with 1009 beyond that). Binary messages close
  the socket (1003). More than 20 invalid messages close it (1008).
- The first message must be `session:init` within `INIT_TIMEOUT_MS` (closed with 4000).
- Per-socket rate limit (default 50 msg/s, burst 200). Excess messages are dropped
  and answered with at most one `RATE_LIMITED` error per second.
- Server pings every `HEARTBEAT_INTERVAL_MS`; a socket that misses a pong is terminated.
- Client→server schemas are **strict**: unknown fields (e.g. a forged `from`) are rejected.

### Client → server

| Type | Fields | Authorization / behavior |
| --- | --- | --- |
| `session:init` | `deviceName`, `deviceKind`, `resumeToken?` | First message only. A valid, unexpired token resumes the previous session (same `peerId`, same room); otherwise a new session is created. Tokens are single-use: every init returns a new one. |
| `room:create` | `cid?` | Not already in a room; per-IP limit; global `MAX_ROOMS`. |
| `room:join` | `roomId`, `secret`, `cid?` | Per-IP limit. Secret compared in constant time. Wrong secret and unknown room both give `ROOM_NOT_FOUND`; a recently expired room gives `ROOM_EXPIRED` only to holders of its secret. `ROOM_FULL` after the secret is verified. |
| `room:join-code` | `code` (`XXXX-XXXX`), `cid?` | Per-IP and global failure limits; code must be unexpired and the room must have an online member. Creates a join **request**, not membership. |
| `room:approve` | `requestId`, `approve` | Only members of the request's room. |
| `room:refresh-code` | `cid?` | Members only; rate-limited. Issues a new code and expiry. |
| `room:leave` | `cid?` | Leaves the room or withdraws a pending join request. |
| `peer:update` | `deviceName` | Broadcast as `peer:updated` to the room. |
| `signal:offer` / `signal:answer` | `to`, `gen`, `sdp` (≤ 32 KiB) | Sender must be in a room; `to` must be a **different member of the same room**, else `PEER_NOT_FOUND`. |
| `signal:ice` | `to`, `gen`, `candidate \| null` | Same as above. `null` with a new `gen` asks the controller to rebuild the connection. |
| `ping` | `t` | Answered with `pong`. |

### Server → client

| Type | Notes |
| --- | --- |
| `session:ready` | `peerId`, new `resumeToken`, `resumed`, `resumeGraceMs` |
| `room:state` | Room (`roomId`, `secret`, `code`, `codeExpiresAt`, `expiresAt`, `maxPeers`), `self`, `peers` |
| `room:left` | `reason`: `left`, `expired`, `kicked` |
| `room:join-pending` / `room:join-request` / `room:join-request-closed` | Code-join approval flow |
| `peer:joined` / `peer:left` / `peer:updated` | Presence. `status` is `online` or `reconnecting` (socket gone, within grace period) |
| `signal:offer` / `signal:answer` / `signal:ice` | As sent, plus `from` stamped by the server from the authenticated socket |
| `pong`, `server:shutdown` | |
| `error` | `code` (stable, see below), `message`, optional `cid` and `for` (the message type that failed) |

Signals addressed to a member who is temporarily disconnected are queued (max
100 messages / 512 KiB per session) and delivered on resume.

### Connection generations (`gen`)

Each `RTCPeerConnection` between two peers has a generation number. The peer
with the lexicographically smaller `peerId` is the **controller**: it creates the
data channels, makes offers, and drives ICE restarts and rebuilds. A signal with
a higher `gen` makes the receiver discard its connection and build that
generation; lower generations are stale and dropped. Negotiation within a
generation follows the W3C "perfect negotiation" pattern (controller =
impolite).

## 2. Peer protocol (browser ↔ browser, WebRTC data channels)

Channels (created by the controller, reliable and ordered; the other side
accepts exactly these labels and closes anything else):

| Label | Content |
| --- | --- |
| `control` | JSON: `capabilities`, `transfer:*` |
| `chat` | JSON: `chat:message`, `chat:ack` |
| `file` | Binary DATA frames |

All JSON peer messages are length-checked (≤ 32 KiB) before `JSON.parse` and then
validated with strict schemas (`parsePeerMessage`). Invalid messages are dropped
and logged by type only.

### Capabilities (sent by both sides whenever channels open or settings change)

```json
{ "v": 1, "type": "capabilities", "streamingSink": true, "memorySinkMaxBytes": 268435456,
  "maxAcceptBytes": 9007199254740991, "maxMessageSize": 262144,
  "hashAlgorithms": ["sha-256"], "resume": { "pause": true, "reconnect": true, "reload": false } }
```

The sender refuses to offer a file larger than the receiver's `maxAcceptBytes`
(fails locally with `TOO_LARGE_FOR_SINK` before any payload). The receiver
enforces its own limit again on every offer.

### Transfer control

| Message | Direction | Meaning |
| --- | --- | --- |
| `transfer:offer {id, batchId?, name, size, mime, lastModified?, hash:"sha-256"}` | S→R | Request. `size` ≤ 2^53−1, `name` ≤ 1024 chars (sanitized before any use), `mime` ≤ 255 chars (display only). |
| `transfer:accept {id, attempt, sink, windowBytes, chunkBytes}` | R→S | Receiver opened a sink. Grants a credit window and max payload per frame. |
| `transfer:reject {id, code}` | R→S | Declined, auto-rejected by limits (`TOO_LARGE_FOR_SINK`, `TOO_MANY_PENDING`, `RATE_LIMITED`, `ACCEPT_TIMEOUT`), or save dialog dismissed (`SINK_CANCELLED`). |
| `transfer:ack {id, attempt, offset}` | R→S | All bytes below `offset` were **written to the sink** (write promise resolved — not a durability guarantee). Monotonic. |
| `transfer:pause` / `transfer:resume {id}` | either | Sender stops/starts reading. In-flight data is still written and acknowledged. |
| `transfer:resume-from {id, attempt, offset, size}` | R→S | After a data-channel reconnect: continue from the receiver's written offset with a new attempt number. |
| `transfer:finish {id, attempt, size, sha256}` | S→R | All bytes acknowledged; SHA-256 of the bytes the sender read. |
| `transfer:verified {id, sha256}` | R→S | Hash matched and the sink was finalized. **The only completion signal.** |
| `transfer:cancel {id}` | either | Stop and discard. |
| `transfer:error {id, code}` | either | Failure with a stable code. |

Handlers are idempotent: duplicate accepts/verifications are ignored, acks below
the current acknowledged offset are ignored, acks beyond sent data fail the
transfer with `PROTOCOL_VIOLATION`, messages for unknown IDs are ignored, and
frames/messages carrying an old `attempt` are counted as stale and dropped.

### Binary DATA frame (`file` channel)

Big-endian (network byte order):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | version = 1 |
| 1 | 1 | frame type = 1 (DATA) |
| 2 | 2 | reserved = 0 |
| 4 | 16 | transfer ID (the 32-hex-char ID as bytes) |
| 20 | 4 | attempt (u32) |
| 24 | 8 | byte offset (u64, must be ≤ 2^53 − 1) |
| 32 | 4 | payload length (u32) |
| 36 | n | payload |

The receiver validates, before touching the payload: total length ≥ 36,
version, type, reserved bits, attempt ≥ 1, offset within the safe-integer range,
`payload length == message length − 36`, payload non-empty, payload ≤ the
negotiated `chunkBytes`, `offset + length` safe. Then, for the transfer:
attempt equals the current attempt (else stale, dropped), `offset` equals the
next expected offset (no gaps, overlaps, or reordering), no data past EOF, and
the credit window is respected. Any violation fails the transfer with
`INVALID_FRAME`.

Frame size = 36 + payload ≤ the peer's SCTP `maxMessageSize` (the sender uses
`min(receiver chunkBytes, 256 KiB − 64, maxMessageSize − 36)`, or 16 KiB when the
peer's limit is unknown).

### Chat

`chat:message {id, text (1–4000 chars), sentAt}` → `chat:ack {id}`. The receiver
de-duplicates by ID (bounded set) and acknowledges duplicates again, so a retry
after an ambiguous loss never shows a message twice. `sentAt` is untrusted and
not displayed; the receiver shows its own receive time.

## 3. Error codes

Signaling: `BAD_REQUEST`, `UNSUPPORTED_VERSION`, `NOT_INITIALIZED`,
`ALREADY_INITIALIZED`, `SESSION_EXPIRED`, `RATE_LIMITED`, `MESSAGE_TOO_LARGE`,
`ROOM_NOT_FOUND`, `ROOM_EXPIRED`, `ROOM_FULL`, `ROOM_LIMIT`, `ALREADY_IN_ROOM`,
`NOT_IN_ROOM`, `PEER_NOT_FOUND`, `PEER_UNAVAILABLE`, `CODE_INVALID`,
`JOIN_DENIED`, `JOIN_REQUEST_EXPIRED`, `SERVER_FULL`, `SERVER_SHUTTING_DOWN`,
`INTERNAL`.

Transfer: `REJECTED_BY_USER`, `TOO_LARGE_FOR_SINK`, `UNSUPPORTED_CAPABILITY`,
`PROTOCOL_VIOLATION`, `INVALID_FRAME`, `INTEGRITY_MISMATCH`, `READ_FAILED`,
`WRITE_FAILED`, `SINK_PERMISSION_DENIED`, `SINK_CANCELLED`, `QUOTA_EXCEEDED`,
`ACK_TIMEOUT`, `ACCEPT_TIMEOUT`, `VERIFY_TIMEOUT`, `RECONNECT_TIMEOUT`,
`PEER_LEFT`, `CANCELLED_BY_SENDER`, `CANCELLED_BY_RECEIVER`, `RESUME_MISMATCH`,
`TOO_MANY_PENDING`.

Human-readable messages live in `ERROR_MESSAGES` in
[`common.ts`](../packages/protocol/src/common.ts); clients never display
peer-supplied error text, only messages for known codes.
