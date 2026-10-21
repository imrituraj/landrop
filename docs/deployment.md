# Deployment

LanDrop runs as one Node.js process on a machine in your LAN ("the host"). Other
devices open it in a browser. Default mode is **LAN-only**: no CDN, fonts,
telemetry, STUN, or TURN; the page loads everything from the host, and WebRTC is
configured with no ICE servers, so only host candidates are used.

## Requirements

- Node.js 24 LTS (≥ 24.11) and pnpm 10 (via `corepack enable`) — or Docker.
- All devices on the same LAN segment with peer-to-peer traffic allowed (see
  [troubleshooting.md](troubleshooting.md)).

## Local development

```bash
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` runs the server on `127.0.0.1:8787` and Vite on `http://localhost:5173`
(proxying `/ws` and `/api`). Open two browser windows/profiles at
`http://localhost:5173`. `localhost` is a secure context, so the streaming sink is
available in Chromium.

To test from a phone during development, run Vite on all interfaces
(`pnpm --filter @landrop/web dev --host`) and open `http://<host-ip>:5173`. That
is plain HTTP on a LAN IP: not a secure context, so the phone (and any other
non-localhost device) uses the memory sink.

## LAN deployment without Docker (plain HTTP)

```bash
pnpm install --frozen-lockfile
pnpm build
HOST=0.0.0.0 PORT=8787 STATIC_DIR=apps/web/dist pnpm start
```

`pnpm start` runs from the repository root and loads `.env` if present. When bound
to `0.0.0.0`, the server logs the LAN URLs it can be reached on (`evt: lan_urls`).
Open one of them on every device, e.g. `http://192.168.1.20:8787`.

Plain HTTP is acceptable on a trusted home network only: it is not a secure
context (memory sink only, no clipboard API) and any device on the LAN could
tamper with the page or signaling. Prefer HTTPS below.

## LAN deployment with Docker Compose (HTTPS via Caddy)

```bash
cp .env.example .env
# edit .env: LANDROP_HOSTNAME=<host LAN IP or hostname>,
#            ALLOWED_ORIGINS=https://<same>:8443, PUBLIC_ORIGIN=https://<same>:8443
docker compose up -d --build
```

- Caddy listens on **8443** and terminates TLS with its own local certificate
  authority (`tls internal`). LanDrop itself is not published; only Caddy reaches it.
- The LanDrop container runs as the unprivileged `node` user, read-only root
  filesystem, all capabilities dropped, `no-new-privileges`, 256 MiB memory
  limit, health check on `/readyz`, 15 s stop grace period (SIGTERM → graceful
  shutdown).
- Open `https://<LANDROP_HOSTNAME>:8443` on each device after trusting the CA (next section).

> Docker files are provided and the image's runtime layout was exercised by
> running its install and start steps outside Docker, but `docker build` /
> `docker compose up` were **not run** in the development environment (Docker was
> not installed). CI includes a Docker build-and-smoke-test job.

### Trusting the certificate on each device

Caddy creates a root certificate in its data volume. Export it:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./landrop-root.crt
```

Install it as a trusted root **only on your own devices**:

- **macOS**: open the file in Keychain Access → System → set "Always Trust" for SSL.
- **Windows**: `certmgr.msc` → Trusted Root Certification Authorities → Import.
- **Linux (Chrome/Chromium)**: Settings → Privacy and security → Security → Manage
  certificates → Authorities → Import. Firefox has its own store (Settings →
  Certificates → View Certificates → Authorities → Import).
- **Android**: Settings → Security → Encryption & credentials → Install a
  certificate → CA certificate. Some apps/browsers ignore user CAs.
- **iOS/iPadOS**: AirDrop or mail the file, install the profile (Settings →
  General → VPN & Device Management), then enable it under Settings → General →
  About → Certificate Trust Settings.

Anyone holding that CA's private key (in the `caddy-data` volume) can impersonate
any site to devices that trust it. Keep the volume private, and remove the CA
from devices you no longer use. Never disable certificate checks globally.

If you already have certificates (e.g. from your router or an internal CA),
replace `tls internal` in `infra/Caddyfile` with `tls /path/cert.pem /path/key.pem`
and mount them read-only.

### Mixed content

The page and the WebSocket always use the same origin (`ws://` on HTTP pages,
`wss://` on HTTPS pages), so there is no mixed content. Do not serve the page over
HTTPS while pointing the client at a plain `ws://` server.

### Using your own reverse proxy

Requirements: proxy `/ws` with WebSocket upgrade, preserve the `Host` header (or
set `ALLOWED_ORIGINS` explicitly and `ALLOW_SAME_ORIGIN=false`), set
`X-Forwarded-For` and enable `TRUST_PROXY=true` only if LanDrop is reachable
exclusively through the proxy. Example nginx location:

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_read_timeout 1h;
}
```

## Binding and firewall

- `HOST=127.0.0.1` (default) accepts connections from the host only. Use
  `HOST=0.0.0.0` for LAN access (Docker sets this inside the container).
- Allow inbound TCP 8787 (plain) or 8443 (Caddy) on the host firewall.
- WebRTC needs **UDP between the devices** on ephemeral ports. Host firewalls on
  the *devices* must allow the browser to receive UDP; macOS asks once per app
  ("Allow incoming connections?").
- Finding the host address: the server logs it at startup; otherwise `ipconfig
  getifaddr en0` (macOS), `ip -4 addr` (Linux), `ipconfig` (Windows).

## Connecting a phone

1. Phone on the same Wi-Fi as the host (not a guest network; see troubleshooting).
2. On a desktop, create a room. The QR code encodes the invitation link.
3. Scan it with the phone's camera, or type the 8-character code on the phone and
   approve the request on the desktop.
4. Keep the LanDrop tab open and in the foreground on the phone during transfers.

If the desktop opened LanDrop as `localhost`, its invitation link points to
`localhost` and will not work on the phone; the app warns about this. Open LanDrop
via the LAN address, or set `PUBLIC_ORIGIN`.

## Configuration reference

All variables are validated at startup; invalid values print a readable error
and exit with status 2. See [`.env.example`](../.env.example) for a commented template.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8787` | HTTP/WebSocket port |
| `ALLOWED_ORIGINS` | *(empty)* | Exact origins allowed to open `/ws` (comma-separated) |
| `ALLOW_SAME_ORIGIN` | `true` | Also allow an Origin matching the request `Host` |
| `PUBLIC_ORIGIN` | *(empty)* | Origin used in invitation links |
| `TRUST_PROXY` | `false` | Use the right-most `X-Forwarded-For` for per-IP limits |
| `STATIC_DIR` | *(empty)* | Built web app directory; empty = API/WebSocket only |
| `LOG_LEVEL` | `info` | pino level |
| `ROOM_TTL_SECONDS` | `86400` | Absolute room lifetime |
| `ROOM_RETENTION_SECONDS` | `300` | How long an empty room is kept |
| `ROOM_MAX_PEERS` | `8` | Devices per room (2–32) |
| `ROOM_CODE_TTL_SECONDS` | `600` | Short-code lifetime |
| `JOIN_REQUEST_TTL_SECONDS` | `90` | How long a code-join request waits for approval |
| `SESSION_RESUME_GRACE_SECONDS` | `45` | How long a disconnected device keeps its identity and membership |
| `MAX_ROOMS` / `MAX_CLIENTS` / `MAX_CLIENTS_PER_IP` | `500` / `1000` / `20` | Server-wide limits |
| `HEARTBEAT_INTERVAL_MS` | `15000` | WebSocket ping interval; one missed pong terminates |
| `INIT_TIMEOUT_MS` | `10000` | Time allowed before `session:init` |
| `SHUTDOWN_GRACE_MS` | `3000` | Time sockets get to close on shutdown |
| `RATE_JOIN_PER_MIN` | `10` | Invite joins per IP |
| `RATE_CODE_JOIN_PER_MIN` | `5` | Code join attempts per IP |
| `RATE_CODE_FAIL_GLOBAL_PER_MIN` | `60` | Failed code attempts server-wide before code joins lock |
| `RATE_ROOM_CREATE_PER_MIN` | `10` | Room creations / code refreshes per IP |
| `RATE_CONNECT_PER_MIN` | `60` | WebSocket connections per IP |
| `RATE_MESSAGES_PER_SEC` / `RATE_MESSAGES_BURST` | `50` / `200` | Signaling messages per socket |

## Health, logs, shutdown

- `GET /healthz` → 200 while the process runs (liveness).
- `GET /readyz` → 200, or 503 while shutting down (readiness).
- Logs are JSON (pino) on stdout. They contain event names, error codes, counts,
  and 12-hex-char hashes of room/peer IDs — never secrets, tokens, SDP, ICE
  candidates, chat, file names, or file data (enforced by a test). Startup logs
  the LAN URLs.
- SIGTERM/SIGINT: readiness turns 503, connected clients receive
  `server:shutdown`, sockets close with 1001, then HTTP closes. A second signal
  exits immediately. Peer connections that are already established keep working
  until they close, but anything that needs signaling (new connections, recovery)
  fails until the server is back, and rooms do not survive the restart.

## Upgrading

1. Stop the server (rooms are in memory and will be lost; tell users to finish transfers).
2. `git pull` (or pull the new image), `pnpm install --frozen-lockfile && pnpm build`
   (or `docker compose up -d --build`).
3. Start it. Clients reconnect automatically and must create or join a room again.
   If the protocol version changed, older open tabs get `UNSUPPORTED_VERSION` and
   must be reloaded.

## Scaling

LanDrop is a **single-instance** server. Rooms, sessions, and routing live in one
process's memory; running multiple replicas behind a load balancer would split
rooms and break routing. Horizontal scaling is not implemented or claimed.
