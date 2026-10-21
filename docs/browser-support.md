# Browser support

LanDrop separates **capability detection** (an API exists) from **verification**
(an end-to-end test passed). Only verified combinations are listed as tested.
Everything else is "expected" at best and may fail.

## Verified end to end

All on macOS 27 (arm64), Google Chrome 155 headless, two browser contexts or two
browser processes on one machine, real WebRTC over the host's LAN interface.

| Sender → Receiver | Sink | What was verified |
| --- | --- | --- |
| Chrome 155 → Chrome 155 | Streaming (File System Access API) | Pairing (link, code + approval), direct connection reported from stats, chat with delivery acks, files 0 B – 4 GiB with SHA-256, reject, cancel, pause/resume, batch to folder with de-duplicated names, peer disappearance, signaling outage, server restart |
| Chrome 155 → Chrome 155 | Memory (streaming disabled) | Accept, download, byte-for-byte match; refusal above the advertised limit before any payload |

Two contexts on one machine do **not** prove phone↔laptop or
laptop↔laptop compatibility across a real network. See
[testing.md](testing.md#manual-cross-device-checklist) for the manual
cross-device procedure; no cross-device results are recorded yet.

## Not verified (expected behavior only)

| Browser | Expected receive sink | Notes |
| --- | --- | --- |
| Chrome / Edge on Windows, Linux, ChromeOS | Streaming | Same engine as the verified build; not tested |
| Chrome on Android | Memory (no `showSaveFilePicker` on Android) | Mobile tabs are suspended in the background, which stops transfers |
| Firefox (desktop, Android) | Memory | Has RTCDataChannel; no File System Access save picker. A Chrome→Firefox Playwright test exists (`--project cross-browser`) but Playwright's Firefox build failed to launch on the test machine, so it has **not** passed anywhere yet |
| Safari (macOS, iOS) | Memory | Not tested. iOS suspends background tabs aggressively |
| Any browser over plain `http://<LAN IP>` | Memory | Not a secure context: no save picker, no clipboard API, no wake lock |

## Capability matrix (what LanDrop checks at runtime)

| Capability | Check | Effect if missing |
| --- | --- | --- |
| WebRTC data channels | `RTCPeerConnection` | Banner; cannot send or receive |
| Secure context | `window.isSecureContext` | No streaming sink, no clipboard copy, no wake lock |
| Streaming sink | `showSaveFilePicker` in a secure context, not disabled in settings | Falls back to the bounded memory sink and advertises the smaller limit |
| Batch save to folder | `showDirectoryPicker` | Each file is saved individually |
| Hash worker | `Worker` | Hashing runs on the main thread in small increments |
| Clipboard write | `navigator.clipboard.writeText` in a secure context | "Copy manually" hint |
| Screen Wake Lock | `navigator.wakeLock` | Screen may sleep during long transfers |
| SCTP max message size | `RTCPeerConnection.sctp.maxMessageSize` | Frames limited to 16 KiB |
| Selected route | `getStats()` selected candidate pair | Shown as "route unknown" |

The settings dialog shows the detected capabilities for the current browser.

## Browser-specific notes

- **Chromium hides local IPs** behind random `.local` mDNS names in ICE
  candidates. Devices on the same LAN resolve them via multicast DNS. Networks
  that block multicast (some corporate, guest, or mesh Wi-Fi) can prevent direct
  connections even though both devices reach the server. The automated tests turn
  this obfuscation off (`--disable-features=WebRtcHideLocalIpsWithMdns`) because
  two headless contexts on one machine did not resolve each other's names.
- **Chromium's data-channel send queue is capped at 16 MiB**; exceeding it throws
  `OperationError: RTCDataChannel send queue is full`. LanDrop stays at ≤ 4 MiB.
- **Playwright's bundled Chromium builds** (headless shell and Chrome for Testing)
  connected their ICE checks but never completed them on the test Mac, whose
  application firewall was enabled; the signed Google Chrome worked with identical
  code. On such hosts run E2E tests with `E2E_CHANNEL=chrome` (the default on
  macOS when Chrome is installed).
- **Off-the-record profiles** (incognito, Playwright's default contexts) keep the
  Origin Private File System in memory with a small quota; the streaming sink
  writes through a temporary file there as well, so very large receives may fail
  with "Not enough storage space" in such profiles.
