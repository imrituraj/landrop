# Known limitations and unsupported features

LanDrop is production-oriented, not independently audited. The following are
deliberate limits or not-yet-implemented features.

## Networking

- **LAN-only mode only.** No STUN/TURN; devices must reach each other directly.
  Guest networks, client isolation, VLANs, VPNs, and blocked multicast DNS
  commonly prevent this. The relay-enabled mode described in the original plan is
  **not implemented**.
- **No automatic discovery.** Browsers cannot scan the network; devices meet in a
  room on the LanDrop server.
- **Single server instance; in-memory state.** A restart drops all rooms and
  sessions; clients must create/join a room again, and transfers in progress fail.
  No horizontal scaling.
- **Not offline-capable.** The server must be reachable for pairing and recovery.
  A web app manifest is provided, but there is no service worker or offline cache,
  and installability depends on the browser.

## Security

- **No peer verification** (no short authentication string). The LanDrop server
  is trusted not to man-in-the-middle connections. See security.md §5.
- Display names and device types are self-asserted.
- Invitation links grant access until the room expires (24 h by default).
- Plain-HTTP LAN deployments are vulnerable to on-path attackers on the LAN.
- No malware scanning of received files.

## Transfers

- **Resume after page reload or browser restart: unsupported.**
- WebRTC reconnect is browser-tested only for user-initiated rebuilds on one
  machine; recovery from real network drops between devices is untested.
- Large-file streaming to disk requires a Chromium-based desktop browser in a
  secure context (HTTPS or `localhost`). Elsewhere, receiving is limited to the
  bounded in-memory size (default 256 MiB desktop / 128 MiB phones), and files
  must then be saved with a download.
- 10 GiB+ transfers have a test procedure but no recorded result (verified up to
  4 GiB on one machine).
- After cancel/failure with the streaming sink, the (empty or previous) file that
  was created when the destination was chosen remains on disk; partial data does not.
- "Acknowledged" means written to the browser's sink, not durably flushed.
- Folder transfer / directory reconstruction: **not supported** (folders dropped
  on the page are skipped with a message).
- Background transfers on mobile: not supported; tabs are suspended by the OS.
- Throughput is bounded by the browser's SCTP implementation; measured 15–17 MB/s
  between two Chrome processes on one Mac for large files. No speed is promised.

## Chat

- One-to-one, plain text, ephemeral: no server storage, no local persistence,
  gone on reload. No read receipts. No group chat, attachments, or edits.
- Clipboard: explicit copy buttons only; no background clipboard sync.

## Browsers

- Only Chrome 155 (desktop, macOS) is verified end to end. Firefox, Safari,
  Edge, and mobile browsers are unverified; see browser-support.md.

## Operations

- No metrics endpoint (diagnostics are client-side, user-initiated exports).
- The Docker image is built and smoke-tested in CI; the Compose + Caddy HTTPS
  stack has not been run end to end.

## Remaining work (checklist)

- [ ] Run the 10 GiB+ large-file procedure on a machine with ≥ 25 GB free disk and record the result in testing.md.
- [ ] Manual cross-device validation (phone ↔ laptop, laptop ↔ laptop, Windows/Android/iOS) using the checklist in testing.md.
- [ ] Get the Firefox (and WebKit) Playwright projects running and passing; then update browser-support.md.
- [ ] E2E for network-caused WebRTC drops and ICE restart (e.g. interface toggling in a VM or network namespace).
- [ ] Playwright Firefox exits with "Could not find profile folder" on the dev Mac (macOS 27); run the cross-browser project on Linux or another Mac.
- [ ] Run the Compose + Caddy stack on a LAN host, including certificate trust on a phone.
- [ ] Peer verification: short authentication string derived from both DTLS fingerprints, with a reviewed design.
- [ ] Optional relay mode (TURN), disabled by default, with explicit admin configuration and a visible "Relayed" state (the UI and stats classification already distinguish relay).
- [ ] Evaluate an OPFS-backed receive path with export for browsers without `showSaveFilePicker`, only after verifying export behavior for large files.
- [ ] Restart-resume (persisted handles, permission re-grant, source re-selection, hash state) — design first.
- [ ] Folder transfer with path-traversal defenses, duplicate handling, and empty directories.
- [ ] Test permission revocation during a streaming write.
- [ ] Service worker for the app shell with an update strategy that never interrupts active transfers.
- [ ] Reduce client bundle size (≈ 457 KB minified, mostly schema validation); consider `zod/mini`.
