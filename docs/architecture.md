# Architecture

LanDrop is a single small Node.js server on a LAN host plus a browser app. The
server introduces devices to each other; file bytes and chat messages go
**directly between browsers** over WebRTC data channels and never touch the
server.

```
                      ┌──────────────────────── LAN host ───────────────────────┐
                      │  (optional) Caddy :8443  ──TLS──►  LanDrop server :8787 │
                      │   local CA, HTTPS/WSS               Fastify + ws        │
                      │                                     • static web app    │
                      │                                     • GET /api/config   │
                      │                                     • /healthz /readyz  │
                      │                                     • /ws signaling hub │
                      └──────────────▲───────────────────────────────▲──────────┘
                    signaling only   │ WSS (JSON)              WSS   │
          (rooms, presence, SDP, ICE)│                               │
┌─────────────────── Browser A ──────┴──┐            ┌───────────────┴──── Browser B ─────────────┐
│ React UI ◄── Store ◄── AppController  │            │ AppController ──► Store ──► React UI       │
│                 │   SignalingClient   │            │   SignalingClient    │                     │
│                 │   PeerLink ─────────┼── DTLS ────┼──────── PeerLink     │                     │
│                 │    "control" JSON   │  (direct,  │    "control" JSON    │                     │
│                 │    "chat"    JSON   │   UDP,     │    "chat"    JSON    │                     │
│                 │    "file"    binary │   no relay)│    "file"    binary  │                     │
│   ChatService ──┘   TransferService   │            │   TransferService ───┴─ ReceiveSink        │
│                     (transfer-core)   │            │   (transfer-core)       ├ FileHandleSink   │
│   File.slice() ──► OutgoingTransfer   │            │   IncomingTransfer ─────┤  (disk, FS API)  │
│                     hash worker       │            │   hash worker           └ MemorySink       │
└───────────────────────────────────────┘            └────────────────────────────────────────────┘
```

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/protocol` | Versioned Zod schemas for signaling (browser↔server) and peer messages (browser↔browser), error codes, limits |
| `packages/shared` | Random IDs/secrets/codes, filename sanitizer, safe link parser, token-bucket rate limiter, bounded collections, formatting |
| `packages/transfer-core` | Environment-independent transfer engine: binary framing, state machine, flow control, sender, receiver, per-peer manager, sinks interface, incremental SHA-256 |
| `apps/server` | Fastify HTTP server + `ws` signaling hub (rooms, sessions, routing, limits) |
| `apps/web` | React + Vite + Tailwind app; WebRTC `PeerLink`, signaling client, chat, transfer glue, File System Access sink, hash worker |
| `tests/integration` | Server tests over real WebSockets |
| `tests/e2e` | Playwright tests: two real browser contexts, real WebRTC |
| `tests/network` | Opt-in throughput, raw data-channel baseline, and large-file tests |
| `infra/` | Caddy reverse-proxy configuration |
| `docs/` | This documentation |

## Key decisions

- **Fastify over Express**: built-in pino logging with redaction, lifecycle hooks
  for graceful shutdown, and `inject()`/`listen(0)` for tests. WebSockets use `ws`
  directly via the HTTP `upgrade` event so the Origin check, connection limits,
  and `maxPayload` are applied before the upgrade completes.
- **No build step for the server**: the server and shared packages are written in
  erasable TypeScript and run with Node's built-in type stripping (Node ≥ 22.18,
  Node 24 LTS used here). `tsc --noEmit` provides type checking.
- **No database**: rooms and sessions are in memory. This is deliberate for a
  single LAN host; nothing needs to persist. Consequence: a server restart drops
  all rooms (see [limitations](limitations.md)).
- **No state-management library**: a ~30-line external store with
  `useSyncExternalStore`. All connection objects live outside React in
  `AppController`, so renders (including StrictMode double renders) can never
  create or destroy connections.
- **Transfer engine is DOM-free** (`packages/transfer-core`): it talks to
  abstract `SendChannel`, `FileSource`, `ReceiveSink`, and `IncrementalHasher`
  interfaces, so the same code is tested in Node against a simulated data channel
  with real backpressure semantics and used unchanged in the browser.

## Connection sequence

```
A (creator)              Server                         B (joiner)
 │ ws connect (Origin ✓)   │                               │
 │ session:init ─────────► │                               │
 │ ◄──── session:ready     │  (peerId, rotating resumeToken)
 │ room:create ──────────► │                               │
 │ ◄──── room:state        │  (roomId, secret, code)       │
 │   invite link = origin/#join=<roomId>.<secret>  (fragment: never sent over HTTP)
 │                         │ ◄──────────── ws + session:init
 │                         │ ─────────────► session:ready  │
 │                         │ ◄──── room:join(roomId,secret)│
 │                         │ ─────────────► room:state     │  B creates PeerLink(A)
 │ ◄──── peer:joined(B)    │                               │
 │ A creates PeerLink(B)   │                               │
 │                                                          │
 │   controller = smaller peerId (creates channels, offers; impolite)
 │ signal:offer(to B, gen 1) ─► │ ─► signal:offer(from A)   │   server stamps `from`,
 │ ◄─ signal:answer(from B)◄─── │ ◄─ signal:answer(to A)    │   checks same room
 │ ◄═══════ trickle ICE both ways (buffered until remote description is set) ══════► │
 │ ═══════════════ DTLS + SCTP, 3 data channels open ═══════════════════════════════ │
 │ capabilities ──────────────────────────────────────────────────────────────────► │
 │ ◄─────────────────────────────────────────────────────────────────── capabilities │
```

Code-based joins (`room:join-code`) add a step: the server sends
`room:join-request` to members, and B is only added after a member answers
`room:approve`.

## Transfer sequence

```
Sender                                                     Receiver
transfer:offer {id,name,size,mime} ───────────────────────►  (shown to user; nothing sent yet)
                                                            user Accepts → sink opened (save dialog / memory)
◄─────────────── transfer:accept {attempt=1, window, chunk, sink}
DATA frames [hdr|payload] (file channel) ─────────────────► validate → write queue → sink.write → hash
   (sent − acked ≤ window; bufferedAmount ≤ high-water)
◄─────────────────────── transfer:ack {attempt, offset=written}   (every window/4 and when idle)
… all bytes acknowledged as written …
transfer:finish {size, sha256(read bytes)} ───────────────► compare with sha256(written bytes)
                                                            sink.finalize()  (atomic move into place)
◄──────────────────────────── transfer:verified {sha256}   ← the only completion signal
completed                                                   completed
```

## State machine

States: `queued → requesting → awaiting_acceptance → (preparing) → transferring ⇄
paused`, `transferring/paused → reconnecting → transferring`, `transferring →
verifying → (finalizing) → completed`; terminal: `completed`, `rejected`,
`cancelled`, `failed`. Legal transitions are defined per role in
[`packages/transfer-core/src/state.ts`](../packages/transfer-core/src/state.ts)
together with who triggers each one; any other transition throws, which tests
rely on to catch stale or duplicated events.

```
 sender:   queued ─► requesting ─► awaiting_acceptance ─► transferring ─► verifying ─► completed
                                         │ reject              │ ▲  │            │
                                         ▼                     ▼ │  ▼            ▼
                                      rejected              paused  reconnecting (resume-from)
 receiver: awaiting_acceptance ─► preparing ─► transferring ─► verifying ─► finalizing ─► completed
 any non-terminal state ─► cancelled (either side) | failed (timeouts, I/O, protocol, peer left)
```

## Trust boundaries

See [security.md](security.md) for the full threat model. In short: everything
from the network is validated at the boundary (Zod schemas, size checks before
parsing, frame header validation before exposing payload); the server derives
sender identity from the authenticated socket; peers are untrusted even inside a
room; the server itself is trusted for introductions because peer verification is
not implemented.

## Concurrency and bounded resources

| Resource | Bound | Where |
| --- | --- | --- |
| Sender read-ahead | 1 chunk (≤ 256 KiB − 64 B) in flight per transfer | `OutgoingTransfer.pump` |
| RTC send queue | `bufferedAmount` ≤ 4 MiB (+1 chunk); Chromium aborts sends above 16 MiB | `waitForSendRoom` |
| Unacknowledged data / receiver write queue | 16 MiB per transfer (receiver credit window) | `transfer:accept.windowBytes` |
| Hash worker backlog | 4 MiB per transfer | `hash-client.ts` |
| Concurrent data transfers | 2 by default (1–4 in settings) | `SlotScheduler` |
| In-memory receive | 256 MiB desktop / 128 MiB touch or low-memory (configurable) total | `TransferService.memoryAvailable` |
| Pending offers per peer | 50; 120 offers/min | `PeerTransferManager` |
| Chat history | 500 messages per peer; dedup set 2,000 IDs | `ChatService` |
| UI progress updates | ≤ 4 per second; never per chunk | `TransferService.flush` |
| Server message size | 64 KiB WebSocket payload, 32 KiB SDP | `ws maxPayload`, schemas |
| Server state | rooms, clients, clients/IP, pending requests/room, queued signals per reconnecting session (100 / 512 KiB), tombstones (10,000) | `hub.ts`, `.env` |
