# Pause, resume, cancel, and recovery

## Definitions

- **Acknowledged / written**: the receiver's sink `write()` promise resolved for
  every byte below the acknowledged offset. This is *not* a durable checkpoint:
  browsers provide no fsync, and the streaming sink writes to a temporary swap
  file that only becomes the destination on `close()`.
- **File identity**: a transfer is identified by its random 128-bit transfer ID,
  plus the declared size. A resume request must name the same ID and size; the
  sender also checks the offset against what it has actually sent and hashed.
- **Attempt**: a counter that increases each time the data channel is replaced.
  Frames and control messages carry it; anything from an older attempt is
  dropped as stale.

## Supported vs unsupported

| Scenario | Supported | How | Verified by |
| --- | --- | --- | --- |
| Pause / resume in the same session (either side) | **Yes** | Sender stops reading new chunks; in-flight frames are still written and acknowledged; resume continues from the sender's current offset on the same attempt | Unit tests; browser E2E (40 MiB, bytes verified) |
| Cancel (either side) | **Yes** | `transfer:cancel`; sender stops reading, receiver aborts the sink (partial data discarded) | Unit tests; browser E2E |
| Signaling server unreachable briefly (Wi-Fi blip, server busy) | **Yes, transparently** | Data channels do not depend on signaling. The client reconnects and resumes its session (same peer ID, same room) with a single-use token within `SESSION_RESUME_GRACE_SECONDS` (default 45 s) | Server integration tests; browser E2E with a forced socket drop |
| WebRTC connection interrupted (ICE failure, data channels closed), same page session | **Yes** (within `reconnectTimeoutMs`, default 60 s) | ICE restart first; if channels close, the controller builds a new connection generation. Each side's transfers enter `reconnecting`; the receiver finishes queued writes, then sends `transfer:resume-from {attempt+1, offset = written}`; the sender validates `acked ≤ offset ≤ hashed` and same size, then continues. Interrupted verification is redone; a lost `transfer:verified` is re-sent | Engine tests with a simulated link (drops mid-transfer, repeated drops, drop during verification, timeout, mismatched resume); browser E2E in Chrome where either side forces a new connection generation mid-transfer (40 MiB, resumes on attempt 2, bytes verified). A *network-caused* drop on real devices is not yet tested |
| Signaling server restart | **No** (rooms are in memory) | Clients see a "server is restarting" notice, reconnect, and get `ROOM_NOT_FOUND`. LanDrop closes existing peer connections when the session cannot be resumed, so active transfers fail with `PEER_LEFT` | Browser E2E |
| Remote peer reloads or closes the tab | **No** | It returns as a new peer ID. Transfers with the old one fail (`PEER_LEFT` after the grace period, or `RECONNECT_TIMEOUT`) | Browser E2E (tab closure) |
| Page reload / browser restart resume | **No — unsupported** | Would need persisted file handles with re-granted permission, re-selection of the source file, persisted hash state, and a verified partial destination. None of this is implemented; nothing about transfers is persisted | — |

## Why recovery can be refused

The sender fails the transfer with `RESUME_MISMATCH` if the resume request:

- names a different size,
- asks for an offset beyond the file, below what the receiver already acknowledged,
  or beyond the prefix the sender has hashed (it never sent those bytes),
- or carries an attempt number that is not newer than the current one (ignored as stale).

The receiver only resumes if its sink is still open and all queued writes
succeeded. Hash state is kept in memory on both sides, so the final SHA-256 still
covers every byte exactly once.

## Partial files

- Streaming sink: on cancel/failure the swap file is discarded with
  `FileSystemWritableFileStream.abort()`. The destination file that was created
  when the user chose the location remains with its previous content (empty for a
  new file). The UI says "The partial file was discarded".
- Memory sink: buffered chunks are dropped immediately and the reserved memory
  budget is released.
