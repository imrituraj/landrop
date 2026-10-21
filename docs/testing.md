# Testing

| Command | What runs | Needs |
| --- | --- | --- |
| `pnpm typecheck` | `tsc --noEmit` for all 5 projects (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) | — |
| `pnpm lint` | ESLint (typescript-eslint strict), zero warnings allowed | — |
| `pnpm test` | Vitest: unit + integration (Node) | — |
| `pnpm build` | Production web build | — |
| `pnpm test:e2e` | Playwright, two real browser contexts, real WebRTC, real server serving the production build | `pnpm exec playwright install chromium` (or Google Chrome installed) |
| `pnpm test:e2e:cross` | Opt-in Chrome → Firefox transfer (memory-sink fallback) | `pnpm exec playwright install firefox`; did not launch on the test machine |
| `pnpm test:perf` | Throughput probe and raw data-channel baseline (prints numbers) | same |
| `pnpm test:large` | Large-file streaming, integrity, and memory sampling | same; disk ≈ 2× file size |
| `pnpm check` | typecheck + lint + test + build | — |

`E2E_CHANNEL` selects the browser for Playwright: `chrome` (installed Google
Chrome; default on macOS when present) or `chromium` (Playwright's build;
default elsewhere and in CI). See browser-support.md for why.

## Coverage by layer

**Unit (packages, web client)** — 134 tests at last run
- Protocol schemas: strict validation, oversize rejection before parse, unsafe
  integers, unknown fields, wrong versions.
- Binary framing: round trips including offsets above 2^32, byte order, every
  header validation branch, unsafe offsets.
- State machine: terminal states, legal completion paths, cancel/fail coverage.
- Flow control: send-room waits (event, missed event → poll, close, abort),
  `Condition` without lost wakeups, FIFO slot scheduler with aborts, rate meter.
- Incremental hashing vs one-shot SHA-256 for arbitrary chunking; empty input.
- Sinks: memory sink limits, sequential writes, copy semantics.
- Engine over a simulated data channel (independent latency per channel, real
  `bufferedAmount`, configurable lost `bufferedamountlow` events, tampering):
  small/zero/boundary sizes, 64 MiB with asserted bounds on send queue, credit
  window and receiver queue, corruption → `INTEGRITY_MISMATCH`, rejection,
  pre-payload capability refusal (sender and receiver side), offer queuing,
  accept timeout, pending-offer limit, cancelled save dialog, pause/resume,
  cancel from either side, disk-full, source read error, ACK timeout, invalid
  offsets, past-EOF and oversized frames, unknown/stale frames, duplicate and
  out-of-range acks, peer departure, reconnect with resume (single, repeated,
  during verification, timeout, mismatched resume), multi-file concurrency with
  slot release on pause, per-file cancel, buffer-detaching hasher.
- Shared: filename sanitization (traversal, Windows names, bidi/zero-width,
  length, surrogates), safe links, IDs/codes, rate limiters, bounded collections.
- Client: chat delivery semantics (ack, unconfirmed → late ack, retry dedup,
  reopen resend, peer departure, length/rate limits, flood drop, bounded history),
  route classification from stats, ICE candidate buffer bounds, invite parsing.
- Server config validation.

**Integration (server over real WebSockets)** — included in the 134
- Origin: missing, foreign, allow-list, same-origin toggle; unknown paths;
  per-IP connection limit; init required and init timeout.
- Rooms: create/join/leave, uniform errors for wrong secret vs missing room,
  full room, expiry with `ROOM_EXPIRED` for secret holders, empty-room retention,
  per-IP join rate limit.
- Code joins: approval, denial, non-member cannot approve, unknown/expired code,
  request expiry, global failure lockout.
- Signaling: server-stamped `from`, client-supplied `from` rejected, cross-room
  and self signaling rejected, signaling outside a room rejected.
- Malformed input: invalid JSON, wrong version, schema violations, oversize
  (1009), repeated garbage (1008), message floods; server stays healthy.
- Sessions: resume with rotated single-use token, queued signals delivered on
  resume, grace-period expiry, heartbeat termination of unresponsive sockets.
- Graceful shutdown: notice, 1001 close, refusal of new connections.
- Logs: no secrets, room IDs, codes, tokens, or SDP in trace-level logs.
- HTTP: health/readiness/config, CSP and security headers, no CORS.

**Browser E2E (Chrome 155, two contexts)** — 16 tests
- Pair by link (secret removed from the URL), connect directly (route from
  `getStats`), chat with delivery receipts, multiline, links, HTML rendered as text.
- Code join with approval; invalid code; denial; invalid invitation.
- Streaming sink (real `FileSystemWritableFileStream` on OPFS handles; only the
  picker dialog is substituted), 12 MiB byte-verified.
- Memory-sink fallback with download, byte-verified.
- Zero-byte file; bidi-override filename sanitized.
- Rejection; refusal above the receiver's memory limit before any payload.
- Sender cancel: both sides cancelled, no partial data written.
- Pause/resume with chat during the transfer, byte-verified.
- Batch of 3 into a folder, then a duplicate name saved as `one (1).txt`.
- Peer tab closed mid-transfer → clear failure.
- WebRTC reconnect ("Reconnect" from sender and from receiver) mid-transfer:
  new connection generation, transfer resumes on attempt 2, bytes verified.
- Signaling server restart; signaling outage with a forced socket drop (chat keeps
  flowing over WebRTC; session resumes with the same peer identity).

**Not covered by automated tests (be aware)**
- Real cross-device LAN behavior (phone ↔ laptop, laptop ↔ laptop).
- Firefox, Safari, Edge, mobile browsers (the Chrome→Firefox test exists but did
  not run: Playwright's Firefox failed to launch on the test machine).
- WebRTC drops caused by the network (Wi-Fi loss, ICE failure) on real devices;
  user-initiated rebuilds are browser-tested, ICE restart is not.
- The real save/folder picker dialogs (they need a human).
- Docker image build and Compose stack (Docker unavailable in the dev environment;
  CI job provided but not yet run).
- Permission revocation of a granted file handle mid-write (maps to
  `SINK_PERMISSION_DENIED` in code; untested).

## Large-file results

Procedure: `LANDROP_LARGE_BYTES=<bytes> pnpm test:large`. Each device is a
separate Chrome process with a persistent on-disk profile; the receiver streams
to an OPFS file through the real `FileSystemWritableFileStream`. The test checks
both sides' SHA-256 against Node's digest of the generated source, spot-checks
written bytes against the generator, samples memory every 2 s, and appends a
record to `tests/.artifacts/large-file-results.json`.

| Date | Browser | OS | Sink | Size | Time | Throughput | Outcome | JS heap peak | Browser RSS (all processes, both browsers) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-20 | Chrome 155 | macOS 27 arm64 (10 cores, 16 GB) | Streaming (OPFS) | 1 GiB | 64.5 s | 16.6 MB/s | Completed, SHA-256 verified | 6 MiB | 2,074 → peak 2,508 MiB; 2,401 / 2,447 / 2,481 at 17 / 34 / 52 s |
| 2026-10-20 | Chrome 155 | macOS 27 arm64 | Streaming (OPFS) | 4 GiB | 282.4 s | 15.2 MB/s | Completed, SHA-256 verified | 6 MiB | 1,715 → peak 2,299 MiB; flat at 2,066–2,104 MiB from 64 s to 257 s |

Interpretation: RSS settles within about a minute and then stays flat while the
remaining ~3 GiB flow, and the JS heap never exceeds ~6 MiB — memory does not
grow with file size. RSS includes browser caches and garbage awaiting collection
and is an upper bound, not LanDrop's exact buffer usage.

Throughput context on the same machine (`pnpm test:perf`): a raw RTCDataChannel
with no LanDrop code reached ~19 MB/s within one page and ~13 MB/s between two
browser contexts over loopback/LAN host candidates. Results depend heavily on
hardware, browser, and network; no universal speed is claimed.

**10 GiB+**: not run here (≈ 24 GB free disk; the test needs ≈ 2× the file size).
Procedure:

```bash
LANDROP_LARGE_BYTES=10737418240 pnpm test:large   # ~22 GB free disk needed
```

Record the printed JSON (browser, OS, sink, size, seconds, MB/s, outcome,
memory) in the table above. Until then, 10 GiB is **unverified**.

## Manual cross-device checklist

Run on real devices on the same Wi-Fi (not a guest network), with LanDrop served
from a third machine or one of them:

1. Desktop A creates a room; phone B scans the QR code. Both list each other.
2. The device card says **Direct** with candidate types (expect `host ↔ host`).
3. Chat both ways; "Delivered" appears on each sent message.
4. Send a photo phone → desktop and a 1 GB file desktop → desktop; compare
   SHA-256 from "Details" with `shasum -a 256` / `sha256sum` / `certutil -hashfile`.
5. Pause/resume and cancel a large transfer from each side.
6. Toggle Wi-Fi off/on on one device for < 30 s during a transfer; record whether
   it resumed (`Attempts` in Details > 1) or failed, and the error.
7. Put the phone's browser in the background for 1 minute during a transfer;
   record the outcome (expected: stalls or fails; not a supported scenario).
8. Repeat on a guest network to confirm the "No direct connection" explanation appears.

Record browser versions, OS versions, network type, sizes, throughput, and outcomes.
