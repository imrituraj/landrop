# LanDrop security model and threat model

Status: written before the security-sensitive code (Phase 0) and updated as it was
built. LanDrop has **not** been independently audited. "Production-oriented" means
the controls below are implemented and tested, not that they are proven complete.

## 1. Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| File contents | Sender's disk → WebRTC data channel → receiver's disk | Primary user data |
| Chat bodies | Browser memory only (both peers) | Private user data |
| Room invite secret | Invite link fragment / QR code, server memory (hashed) | Anyone holding it can join the room |
| Room short code | Shown in UI, server memory | Lets a device *ask* to join (approval still required) |
| Session token | `sessionStorage` of one tab, server memory (hashed) | Lets a reconnecting tab reclaim its peer identity |
| Peer identity (`peerId`) | Server-assigned random ID | Used for routing and display; not a human identity |

## 2. Trust boundaries

```
 ┌──────────── Browser A ───────────┐          ┌──────────── Browser B ───────────┐
 │ UI ── AppController ── PeerLink ─┼── DTLS ──┼─ PeerLink ── AppController ── UI │
 │            │  (files, chat,      │  (direct │      │                           │
 │            │   control)          │   P2P)   │      │                           │
 └────────────┼─────────────────────┘          └──────┼───────────────────────────┘
              │ WSS (signaling only: presence, SDP, ICE)
              ▼                                        ▼
        ┌────────────────────── LanDrop server (LAN host) ──────────────────────┐
        │ Origin check → session auth → room authorization → routing           │
        │ In-memory only. Never sees file bytes or chat bodies.                │
        └──────────────────────────────────────────────────────────────────────┘
```

Boundaries:

1. **Browser ↔ server.** Everything a client sends the server is untrusted and
   validated with Zod schemas, size-bounded, and rate-limited.
2. **Peer ↔ peer.** Everything a peer sends over a data channel is untrusted:
   control messages are schema-validated, binary frames are bounds-checked, and
   file names are sanitized. Being in the same room does not make a peer trusted.
3. **Server ↔ peers.** The server is trusted for *room access control and
   routing*, and — because peer verification is not implemented — it is also
   implicitly trusted not to man-in-the-middle the WebRTC handshake (see §5).
4. **Page ↔ local disk.** Received data reaches disk only through a sink the user
   chose (save dialog / directory picker) or a bounded in-memory buffer the user
   explicitly saves. Received files are never opened automatically.

## 3. Separation of guarantees

| Property | Mechanism | What it does **not** give you |
| --- | --- | --- |
| Transport encryption | WebRTC DTLS (data channels) and HTTPS/WSS when deployed behind the TLS proxy | Does not prove *who* is at the other end |
| Room access control | 256-bit invite secret (constant-time comparison of SHA-256 digests), or short code **plus approval by an existing member** | Does not stop a member from forwarding the link |
| Peer authentication | Server-assigned `peerId` bound to the authenticated WebSocket session; server stamps `from` on every routed message | Does not authenticate a *human*; display names are self-asserted |
| File integrity | Incremental SHA-256 over the bytes the sender read, compared by the receiver over the bytes it wrote | Detects corruption/truncation in transport and storage writes; does not authenticate the sender against a malicious signaling server (the hash is sent over the same DTLS channel) |

## 4. Threats and mitigations

| # | Threat | Mitigation (implemented) | Residual risk |
| --- | --- | --- | --- |
| T1 | Unauthorized room join (guessing) | Room IDs 128-bit, invite secrets 256-bit from CSPRNG; compared with `timingSafeEqual` over SHA-256 digests; wrong secret and missing room return the same error; per-IP join rate limit. The server keeps the secret in memory (it re-sends it to members for "Copy invitation") and never logs it | Leaked link = access until room expiry |
| T2 | Short-code brute force | Codes are 8 Crockford-base32 chars (40 bits), expire (default 10 min), per-IP and global failed-attempt limits, **and** a correct code only creates a *join request* an existing member must approve | A member could approve the wrong device; the UI shows the requester's (self-asserted) name and kind |
| T3 | Malicious room participant | Every incoming transfer requires explicit acceptance; receiver-side offer/chat rate limits; bounded pending offers; sanitized names; no auto-open; no HTML rendering of chat | A participant can send you an *offer* for malware; you decide whether to accept it |
| T4 | Signaling spoofing | Server ignores any client-supplied sender field; `from` is derived from the socket's session; `to` must be a member of the *same* room | — |
| T5 | Peer impersonation | `peerId` is server-assigned and bound to the socket; display names are labeled untrusted in docs/UI | Two devices can pick the same display name |
| T6 | Forged transfer metadata | Offer schema bounds (size ≤ 2^53−1, name ≤ 1024 chars, MIME ≤ 255); receiver enforces its own advertised limits again on accept; size must match frames received; EOF overrun rejected | Declared MIME type is not trusted for anything except display |
| T7 | Oversized messages | `ws` `maxPayload` (64 KiB), data-channel control messages ≤ 32 KiB checked before `JSON.parse`, binary frame payload ≤ negotiated chunk size checked before allocation | — |
| T8 | Resource exhaustion (server) | Limits on total clients, clients per IP, rooms, room size, pending join requests, per-session message rate, buffered signals for reconnecting peers; heartbeat terminates dead sockets; session/room expiry timers | A LAN attacker with many IPs can still fill global limits (local DoS) |
| T9 | Resource exhaustion (browser) | Bounded read-ahead, send queue (`bufferedAmount` high-water mark), receiver credit window, bounded write queue, bounded memory-sink budget, bounded chat history and dedup sets | Streaming sink can fill the user's disk with an accepted file of the advertised size; size is shown before acceptance |
| T10 | Malicious filenames | Names are reduced to a base name, control/bidi characters and reserved characters removed, Windows reserved device names prefixed, length-bounded, never empty; the browser save dialog / FS Access API also refuses paths | — |
| T11 | Cross-site WebSocket hijacking | `Origin` must be in `ALLOWED_ORIGINS` or (if `ALLOW_SAME_ORIGIN=true`) match the `Host` header; missing `Origin` rejected; no cookies are used for auth, so a hijacked socket still has no session | A malicious page *served from an allowed origin* is out of scope |
| T12 | Invitation leakage | Secret carried in the URL **fragment** (never sent in HTTP requests or `Referer`), removed from the address bar immediately after reading (`history.replaceState`), sent to the server only inside the WebSocket `room:join` message, never logged (logger redaction + we never log message bodies); `Referrer-Policy: no-referrer` | Anyone who sees the QR code or link can join; screenshots/history sync of the link before load are outside our control |
| T13 | Replay / duplicate control messages | Session tokens rotate on every resume; transfer handlers are idempotent and state-machine guarded; acks are monotonic; per-attempt IDs drop stale frames; chat dedup by message ID | — |
| T14 | Local server compromise | Server never receives file bytes or chat; see §5 for what a compromised server *can* do | A compromised server can MITM new WebRTC connections |
| T15 | Compromised browser endpoint | Out of scope; a compromised endpoint sees everything it sends/receives | — |
| T16 | XSS via chat / names | React text rendering only; no `dangerouslySetInnerHTML`; links limited to `http:`/`https:` via `URL` parsing; strict CSP (`script-src 'self'`) | — |
| T17 | Log leakage | Pino redaction paths for secrets/tokens; we log message *types* and hashed room IDs only; no chat bodies, filenames, or file contents are ever logged by server or client | Browser devtools console in the user's own browser shows lifecycle events (no payloads) |

## 5. What is *not* protected: trust in the signaling server

LanDrop does **not** implement peer verification (no short authentication string
or fingerprint comparison). WebRTC DTLS fingerprints travel inside SDP through the
signaling server. Therefore:

- A **malicious or compromised LanDrop server** (or anyone who can tamper with the
  signaling path when it is served over plain HTTP) can substitute its own DTLS
  fingerprints and relay/observe file and chat traffic.
- TLS between browser and server (the provided Caddy configuration) protects the
  signaling path from *other* LAN attackers, but not from the server itself.
- Integrity hashes do not help here: an active MITM can recompute them.

We chose not to invent a pairing protocol. A future version could add SAS
verification by having each side display a short code derived from both DTLS
certificate fingerprints (obtainable via `RTCPeerConnection.getStats()`
`certificate` entries) and asking users to compare them out of band. Until that
exists, **treat the LAN host running LanDrop as trusted.**

## 6. Plain HTTP on a LAN

When opened over `http://<lan-ip>`, the page is not a secure context. Then:

- Signaling and the page itself can be modified by any on-path LAN attacker.
- `showSaveFilePicker` and other secure-context APIs are unavailable (the app
  detects this and falls back to the bounded memory sink).
- `crypto.randomUUID` is unavailable; LanDrop uses `crypto.getRandomValues`,
  which is available in insecure contexts.

Use the HTTPS deployment (docs/deployment.md) for anything beyond a trusted home
network.

## 7. Logging policy

Never logged (server or client): chat bodies, file contents, file names, room
secrets, session tokens, invite links, SDP bodies, ICE candidates.

Logged: connection lifecycle, message *types*, error codes, counts, a truncated
SHA-256 of room IDs (so related events can be correlated without exposing the ID).

## 8. How the controls are verified

| Control | Test |
| --- | --- |
| Origin check, unknown paths, connection limits | `tests/integration/signaling.test.ts` › WebSocket admission |
| Uniform join errors, expiry, full rooms, rate limits, code lockout, approval | › rooms, › short-code joins |
| Server-stamped sender, cross-room and self routing rejected | › signaling routing and authorization |
| Malformed/oversized/flooding input does not crash the server | › malformed input |
| Single-use rotating session tokens | › sessions, reconnect, and heartbeat |
| No secrets/IDs/codes/tokens/SDP in logs (trace level) | › log redaction |
| CSP and security headers, no CORS | › HTTP surface |
| Schema strictness, size checks before parse | `packages/transfer-core/test/transfer.test.ts` › failures |
| Frame validation (offsets, EOF, size, stale attempts) | `units.test.ts` › binary framing; `transfer.test.ts` › failures |
| Receiver re-checks size limits; pending-offer and rate limits | `transfer.test.ts` › acceptance and capabilities |
| Filename sanitization | `packages/shared/test/shared.test.ts`; E2E bidi-override file name |
| Chat rendered as text, safe links only | `shared.test.ts` › safe links; E2E chat with HTML payload |
| Invitation secret removed from the address bar | E2E `pair()` helper |
| CSP blocks `eval` on the served page | observed while writing `tests/network/raw-datachannel.spec.ts` |

Additional implementation notes:

- Only the controller creates data channels; the other side accepts exactly the
  `control`, `chat`, and `file` labels, and only if reliable and ordered. Any other
  channel a peer opens is closed immediately.
- Clients never display peer-supplied error text, only messages for known codes.
- The diagnostics export contains states, codes, sizes, timings, and candidate
  *types* — no names, IDs, room data, chat, or IP addresses — so it needs no
  network-address warning; the export dialog states what is excluded.
- Client logs use non-reversible 6-hex-char tags (FNV-1a) instead of IDs.

## 9. Explicitly out of scope / not claimed

- Protection against a malicious LanDrop server (see §5).
- Human identity verification.
- Anonymity on the LAN (peers learn each other's LAN addresses via ICE; with
  Chromium's default mDNS obfuscation they learn a `.local` name instead).
- Malware scanning of received files.
- Encrypted-at-rest storage (nothing is stored at rest by default).
