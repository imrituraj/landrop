# Troubleshooting

LanDrop separates four things that fail independently:

1. **Server reachability** — the header pill says "Server connected".
2. **Room membership** — you see the other device in the device list.
3. **Direct connectivity** — its card says **Direct** (not "Connecting…" or "No direct connection").
4. **Receiver storage** — the receiver can store a file of that size (shown under the device name).

## "Cannot reach the LanDrop server" / pill not green

- Is the server bound to the LAN (`HOST=0.0.0.0`)? The default `127.0.0.1` only
  accepts connections from the host itself.
- Is the host firewall allowing TCP 8787 (or 8443 with Caddy)?
- Are you using the host's LAN address? `localhost` on a phone is the phone.
- HTTPS: is the certificate trusted on this device? An untrusted certificate fails
  the page load and the WebSocket. See deployment.md.
- Server logs `websocket origin rejected`: the page origin is not allowed. Add it to
  `ALLOWED_ORIGINS` (exact scheme, host, and port) or keep `ALLOW_SAME_ORIGIN=true`
  and make sure your proxy preserves the `Host` header.

## Both devices are in the room but stay "Connecting…" → "No direct connection"

The devices reach the server but not each other. LanDrop never relays files
through the server, so this is a hard stop. Common causes:

- **Guest Wi-Fi / client isolation / "AP isolation"**: devices may talk to the
  internet and the router but not to each other. Use the main network or disable
  isolation.
- **Different VLANs or subnets** (e.g. wired vs. IoT Wi-Fi) without routing between them.
- **VPN on one device** routing LAN traffic into the tunnel.
- **Multicast DNS blocked**: Chromium hides local IPs behind `.local` names that
  are resolved with multicast DNS. Some mesh/enterprise Wi-Fi blocks multicast.
- **Device firewall** blocking the browser from receiving UDP (macOS: System
  Settings → Network → Firewall → allow the browser).
- One device reloaded: it rejoined as a new device; select the new card.

Use **Retry connection** on the device panel after fixing the network.
Diagnostics (Settings → Download diagnostics) show the ICE state and candidate
types without exposing addresses.

## Transfer problems

| Message | Meaning / fix |
| --- | --- |
| The file is larger than the receiving browser can safely store | The receiver has no streaming sink (Firefox, Safari, phones, plain HTTP) and the file exceeds its in-memory limit. Use a Chromium desktop browser over HTTPS or `localhost` as the receiver, or raise the in-memory limit in its settings (uses RAM). |
| Saving was cancelled | The receiver closed the save dialog. |
| Not enough storage space | Disk full, or the browser's storage quota (incognito/private windows have small in-memory quotas). |
| Permission to write the file was denied | The browser revoked write access; try again and choose a different folder. |
| The receiver stopped acknowledging data | No progress for 30 s: the receiving tab may be in the background or frozen, or its disk is stalled. |
| Connection lost — trying to resume → The connection could not be re-established in time | The direct link dropped and did not return within 60 s. |
| Integrity check failed | Bytes differ between sender and receiver; nothing was saved. Retry; if it repeats, check for faulty hardware or a proxy modifying traffic (should be impossible over DTLS). |
| Could not read the source file | The file was moved, deleted, or modified while sending. |
| The other device left | Its tab closed, reloaded, or lost the server for longer than the grace period. |

Phones: keep the tab open and visible. Mobile browsers suspend background tabs,
which stops transfers; LanDrop requests a screen wake lock where supported but
cannot keep a background tab running.

## Invitation and code problems

- "Room not found, or the invitation is invalid": wrong or expired link, or the
  server restarted (rooms are kept in memory only).
- "That room code is invalid or has expired": codes expire after 10 minutes; use
  **New code** in the invite panel. Repeated wrong codes from your network can
  trigger a temporary lockout ("Too many requests").
- The invitation shows `localhost`: open LanDrop via the host's LAN address or set
  `PUBLIC_ORIGIN`.

## Development / test issues

- Playwright E2E: ICE stays "checking" with Playwright's bundled Chromium on macOS
  with the application firewall on → run with `E2E_CHANNEL=chrome`.
- Large-file tests fail with "Not enough storage space" in default Playwright
  contexts: they are off-the-record; the large-file test uses persistent profiles.
- Enable client debug logs: `localStorage.setItem('landrop.debug', '1')` and reload.
