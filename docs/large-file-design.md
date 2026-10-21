# Large-file design

Goal: multi-gigabyte transfers on capable desktop browsers with memory that
does not grow with file size. Status: **verified up to 4 GiB** on one machine
(see [testing.md](testing.md#large-file-results)); 10 GiB+ has a reproducible
procedure but is **not verified** here.

## Data path

```
Sender                                                   Receiver
File (disk-backed Blob)                                  RTCDataChannel "file"
  │ File.slice(off, off+len).arrayBuffer()   ≤ 1 chunk     │ onmessage(ArrayBuffer)  one frame
  ▼                                                        ▼
encode frame (36-byte header + copy)                     decode + validate header (no copy)
  │                                                        │ offset == expected, ≤ chunk, ≤ EOF, credit
  ▼                                                        ▼
RTCDataChannel.send  ── waits while bufferedAmount > 4 MiB  write queue (≤ credit window 16 MiB)
  │                    (bufferedamountlow @1 MiB + 50 ms poll)│
  ▼                                                        ▼ sequential
hash worker (transfer, ≤ 4 MiB backlog)                  sink.write(offset, bytes)
  │                                                        │ then hash worker (≤ 4 MiB backlog)
  └─ waits while (sent − acked) ≥ window ◄── transfer:ack ─┘ every window/4 and when idle
```

What we never do: `file.arrayBuffer()` on the whole file, accumulate received
chunks for large files, build a giant Blob on the streaming path, base64, store
file data in localStorage/IndexedDB, or hash the whole file in one call.

## Flow control

Two independent limits:

1. **Local send queue**: `RTCDataChannel.bufferedAmount` describes bytes queued
   *in this browser*. We keep it ≤ 4 MiB (plus one chunk), waking on the
   `bufferedamountlow` event at 1 MiB. Chromium throws "send queue is full" above
   16 MiB, which we measured; a unit test keeps the defaults below it.
2. **Receiver credit**: `bufferedAmount` says nothing about the receiver. The
   receiver grants a window (16 MiB); the sender keeps `sent − acknowledged ≤
   window`, where "acknowledged" means the receiver's sink `write()` resolved. This
   bounds the receiver's write queue regardless of disk speed.

Lost wakeups: `waitForSendRoom` subscribes to the event *before* re-checking the
condition and also polls every 50 ms, because `bufferedamountlow` only fires on a
threshold crossing and can be missed or coalesced. The engine's `Condition`
checks its predicate synchronously at wait time so a notification that happened
earlier is never lost. Both are unit-tested, including a simulated channel that
drops 50% of low events.

## Chunk size and framing

Payload per frame = `min(receiver chunkBytes, 256 KiB − 64 B, peer
maxMessageSize − 36)`; 16 KiB if the peer's limit is unknown. Larger frames
reduced per-chunk overhead: on the test machine they raised throughput from
~6.8 to ~10 MB/s (memory sink, 100 MB) with the same code otherwise. The frame
header is 36 bytes; see [protocol.md](protocol.md#binary-data-frame-file-channel).

## Integrity

SHA-256 via `@noble/hashes` (audited, maintained, pure JS), incremental, in a
dedicated Worker so hashing never blocks the UI thread (64–256 KiB per update;
~164 MB/s measured for noble in Node on the test machine). The sender hashes the
bytes it read, in order, once — after a reconnect rewind, re-sent bytes below the
hashed prefix are not re-hashed. The receiver hashes bytes in write order.
Completion requires the two digests to match; the UI shows the digest under
"Details" so users can compare it with `sha256sum`/`shasum -a 256`.

What it proves: the bytes written equal the bytes the sender read. It does not
detect a file modified *on the sender's disk* before it was read (browsers usually
fail reads of a modified file with `NotReadableError`, which LanDrop reports as
`READ_FAILED`), and it does not authenticate the sender (see security.md §5).

## Receiver storage capabilities

| Sink | When | Max size | Writes | Resume after reconnect | After cancel/failure | Verified in |
| --- | --- | --- | --- | --- | --- | --- |
| Streaming (`FileHandleSink`, File System Access API `showSaveFilePicker` / `showDirectoryPicker` + `createWritable`) | Secure context + API present + not disabled in settings | Disk space / browser quota | Positional, sequential in practice | Yes (same session) | `writable.abort()` discards the temporary swap file; the empty file created when the destination was chosen may remain | Chrome 155 desktop (macOS), via OPFS handles in tests |
| Bounded memory (`MemorySink`) | Everything else (Firefox, Safari, phones, plain-HTTP LAN pages) | 256 MiB desktop / 128 MiB touch or ≤ 4 GB RAM, configurable 64–1024 MiB; total budget across transfers | Sequential only, each chunk copied | Yes (same session) | Discarded | Chrome 155 (streaming disabled in settings) |
| OPFS, service-worker download streaming, third-party stream savers | **Not implemented** | — | — | — | — | — |

The receiver advertises `maxAcceptBytes` (unbounded for streaming, the memory
limit otherwise); the sender refuses larger files before sending anything, and
the receiver re-checks on every offer.

Durability: a resolved write means the browser accepted the bytes, not that they
reached physical media. The streaming sink writes to a temporary swap file that
the browser moves into place on `close()`; until then, the destination is not
updated.

## Memory accounting caveats

The large-file test samples (a) V8 `JSHeapUsedSize` of both pages via CDP and
(b) the summed RSS of every process of both test browsers via `ps`. The JS heap
excludes ArrayBuffer backing stores and browser-internal buffers; RSS includes
caches, GPU and network processes, and garbage awaiting collection. Neither is a
precise measure of LanDrop's own buffers. The evidence for bounded memory is the
*shape*: RSS rises by a few hundred MiB during the first minute (GC of
per-chunk buffers settling) and then stays flat while gigabytes continue to flow;
the JS heap stays at ~6 MiB throughout.

A pitfall we hit and documented: Playwright's default `browser.newContext()` is an
off-the-record profile in which OPFS lives in memory with a small quota. Tests
that store large files must use persistent profiles (`launchPersistentContext`),
otherwise "memory growth" is simply the destination file in RAM and the transfer
fails with `QUOTA_EXCEEDED` (which LanDrop reported correctly).
