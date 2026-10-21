# LanDrop

Local-network file sharing and text chat in the browser. Create a private room on
a LanDrop server in your LAN, open the invitation on your other devices, and send
files **directly between devices** over encrypted WebRTC data channels. The server
only introduces devices; it never receives files or messages.

- Rooms with a 256-bit invitation link/QR code, or a short code that a member must approve.
- Explicit acceptance before any file data is sent; multi-file queue; pause, resume, cancel, retry.
- Large files stream to disk on Chromium desktop browsers with bounded memory and
  end-to-end SHA-256 verification (verified up to 4 GiB); other browsers use a
  bounded in-memory fallback that refuses oversize files *before* transfer.
- One-to-one ephemeral chat with real delivery receipts.
- The UI says whether a connection is **Direct**, **Relayed**, or unavailable,
  based on WebRTC statistics — never assumed.

It is not AirDrop: there is no automatic discovery, it needs the LanDrop server
on your network, and it does not work across networks that block device-to-device
traffic (guest Wi-Fi, client isolation). See [limitations](docs/limitations.md).

## Quick start

Requirements: Node.js 24 LTS, pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm build
HOST=0.0.0.0 STATIC_DIR=apps/web/dist pnpm start
```

The server logs the LAN URLs to open on each device (e.g. `http://192.168.1.20:8787`).
On one device click **Create room**; on another, scan the QR code or open the link.

For HTTPS on the LAN (needed for streaming large files to disk on devices other
than the host, clipboard access, and protection from other LAN users), use the
Docker Compose stack with Caddy: see [deployment](docs/deployment.md).

Development: `pnpm dev` (server on :8787, Vite on http://localhost:5173).

## How it works

```
Browser A ── WSS signaling (rooms, presence, SDP/ICE) ──► LanDrop server ◄── WSS ── Browser B
    └──────────────────── WebRTC DTLS data channels: control · chat · file ──────────────┘
```

Files are read with `File.slice()` in ≤ 256 KiB chunks, framed with a 36-byte
binary header, sent under two limits (local send-queue high-water mark and a
receiver credit window acknowledged only after bytes are written), written
incrementally to the receiver's sink, and hashed on both sides in a Worker.
A transfer is "completed" only after the receiver has written every byte,
matched the sender's SHA-256, finalized the file, and acknowledged it.

## Status

| Area | State |
| --- | --- |
| Rooms, pairing (link/QR/code + approval), presence, reconnecting sessions | Implemented, integration + E2E tested |
| WebRTC connection management (perfect negotiation, ICE buffering, generations, ICE restart, rebuild, stats) | Implemented; connection E2E tested in Chrome |
| Chat with delivery acks, retry, dedup | Implemented, unit + E2E tested |
| File transfer: accept/reject/cancel/pause/resume, multi-file queue, integrity | Implemented, unit + E2E tested |
| Streaming-to-disk sink, bounded memory fallback, capability negotiation | Implemented, E2E tested in Chrome |
| Large files | 1 GiB and 4 GiB verified (Chrome 155, macOS); 10 GiB+ procedure documented, **unverified** |
| Same-session recovery after a WebRTC drop | Implemented; engine-tested, and browser E2E tested for user-initiated reconnects |
| Resume after page reload | **Not supported** |
| TURN relay mode | **Not implemented** |
| Cross-device / non-Chrome browsers | **Unverified** — manual checklist in docs/testing.md |
| Docker/Compose/CI | CI green on GitHub Actions (checks, 16 E2E on Linux Chromium, Docker build + smoke test); Compose + Caddy stack not run yet |

Production-oriented does not mean audited. No security audit, universal browser
support, or particular transfer speed is claimed.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Server + Vite dev server |
| `pnpm build` | Production web build (`apps/web/dist`) |
| `pnpm start` | Run the server (loads `.env` if present) |
| `pnpm check` | Typecheck, lint, unit/integration tests, build |
| `pnpm test:e2e` | Browser E2E (two contexts, real WebRTC) |
| `pnpm test:large` | Large-file verification (`LANDROP_LARGE_BYTES=…`) |
| `pnpm test:perf` | Throughput and raw data-channel baseline |

## Documentation

- [Architecture](docs/architecture.md) — components, sequences, state machine, bounds
- [Protocol](docs/protocol.md) — signaling, peer messages, binary frames, error codes
- [Security](docs/security.md) — threat model, trust boundaries, what is not protected
- [Large-file design](docs/large-file-design.md) — streaming, backpressure, storage matrix
- [Resume semantics](docs/resume-semantics.md) — supported vs unsupported recovery
- [Browser support](docs/browser-support.md) — verified vs unverified combinations
- [Deployment](docs/deployment.md) — LAN, Docker, HTTPS, configuration reference
- [Testing](docs/testing.md) — test layers, recorded results, manual procedures
- [Troubleshooting](docs/troubleshooting.md)
- [Limitations](docs/limitations.md)

## Repository layout

```
apps/server         Fastify + ws signaling server (runs TypeScript directly on Node 24)
apps/web            React + Vite + Tailwind client
packages/protocol   Versioned Zod schemas, error codes, limits
packages/transfer-core  DOM-free transfer engine (framing, state machine, flow control)
packages/shared     IDs, filename sanitizer, safe links, rate limiting
tests/integration   Server tests over real WebSockets
tests/e2e           Playwright browser tests
tests/network       Throughput, raw baseline, large-file tests
infra/              Caddy config
docs/               Documentation
```
