# Peer verification: design

Status: implemented (see §9 for code and tests). LanDrop has not been audited, and
neither has this design.

## 1. Goal and non-goals

**Goal.** Two people standing next to each other can confirm that the direct
connection between their LanDrop tabs really ends at the other device's browser.
That means no third party relays the DTLS session by swapping fingerprints in the
signaling messages. Once they have confirmed it, later connections to the same
device show **Verified** without another comparison.

**Non-goals.**

- Verifying a *person*. A code identifies one browser profile on one origin, not
  its user.
- Protecting against a malicious LanDrop server. See §6. This limit is the
  most important part of this document.
- Any new cryptographic protocol. The design only compares values that DTLS
  already authenticates.

## 2. What DTLS already gives us

Every `RTCPeerConnection` has a certificate, either one the browser generates or
one we pass in `RTCConfiguration.certificates`. The SDP that each side sends
through the signaling server carries `a=fingerprint:sha-256 …` for that
certificate. During the DTLS handshake each browser:

1. receives the peer's certificate and checks that its hash equals the fingerprint
   from the remote SDP, aborting otherwise; and
2. checks, through the handshake's signature (`CertificateVerify`), that the peer
   holds the certificate's private key.

So DTLS proves: *"the other end of this channel holds the private key of the
certificate whose fingerprint arrived in the remote SDP."* The SDP came through the
server, so a server (or anything on the signaling path) that rewrites
fingerprints can terminate DTLS itself on both sides:

```
A (cert C_A) ──DTLS── M (certs M_A, M_B) ──DTLS── B (cert C_B)
A sees remote = M_A                               B sees remote = M_B
```

Both browsers report what they actually negotiated through `getStats()`. The
`transport` entry has `localCertificateId` and `remoteCertificateId`, and each
`certificate` entry has the DER bytes (`base64Certificate`) and the browser's own
`fingerprint`. Under the attack above, A's pair is `{C_A, M_A}` and B's is
`{C_B, M_B}`. Comparing the pairs out of band detects the attack.

## 3. The comparison

**Device code.** For a certificate with DER encoding `der`, the device code is the
first 128 bits of `SHA-256(der)`: 32 uppercase hex digits shown as 8 groups of 4.
This is the first half of the standard WebRTC `sha-256` fingerprint. A user can
check it independently on the `chrome://webrtc-internals` page (the first 16 bytes
of the certificate's fingerprint).

**Safety number.** The two devices' full fingerprints are sorted, and their device
codes are shown as two lines (16 groups). Both screens therefore show the same
number, and the user only checks that the two screens are identical. Each screen
also marks which line is "this device".

We hash `base64Certificate` ourselves (with `@noble/hashes`, which already ships in
the client, since `crypto.subtle` is missing on plain-HTTP origins). We do not
trust the reported `fingerprintAlgorithm`, so a peer that negotiates a SHA-1
fingerprint gains nothing. As a consistency check, our hash of the *local*
certificate must equal the fingerprint of the certificate we configured. If not,
the status is "cannot verify".

### What a match proves, precisely

If A's and B's screens show the same two lines, then (barring a 128-bit
truncated-SHA-256 second preimage, below):

- the certificate on A's remote end has the device code B shows for itself, and
  vice versa; therefore
- A's DTLS session ends at a party holding B's certificate private key, which never
  leaves B's browser profile, and the same holds in the other direction; therefore
- all three data channels (control, chat, files) of this connection run directly
  between those two browser profiles, because they share that one DTLS transport.

A match proves nothing about who uses either device, what the page code does with
the data (§6), or connections to *other* devices in the room. Each pair is verified
separately.

### Why this length (attack cost)

To fool both users, an attacker M must present certificates such that A's line set
`{code(C_A), code(M_A)}` equals B's `{code(C_B), code(M_B)}`. Honest certificates
collide with probability 2^-128, so M needs `code(M_A) = code(C_B)` **and**
`code(M_B) = code(C_A)`: two independent second preimages on a 128-bit truncation
of SHA-256. Generic cost: ~2^128 hash evaluations each. M learns `C_A` and `C_B`
from the SDP, and with persisted certificates (§4) it can precompute against them
for as long as they live. Neither fact matters at this cost: 2^22 (or 2^60)
precomputed certificates per leg gives a success probability of 2^-106 (2^-68) per
leg.

We do **not** use a short combined code such as
`truncate44(SHA-256(fp_A ‖ fp_B))`. M chooses both `M_A` and `M_B`, so it needs
only a *collision* between the families `H(C_A ‖ ·)` and `H(C_B ‖ ·)`. That costs
~2^(n/2): about 2^22 certificates per leg for a 44-bit code, which is cheap
(certificate bytes can be varied without new keys). Showing each device's code
separately turns the problem into second preimages, which keeps the full n bits.

## 4. Stable codes: a persisted certificate

Browsers generate a new certificate per `RTCPeerConnection` by default. That would
change the code on every reconnect (LanDrop rebuilds connections automatically) and
make a "Verified" mark worthless. Instead:

- At startup the client loads an `RTCCertificate` (ECDSA P-256) from IndexedDB
  (`landrop` database, `identity` store). If there is none, or it expires within a
  day, the client calls `RTCPeerConnection.generateCertificate` with a 365-day
  lifetime and stores the result. `RTCCertificate` is structured-cloneable; the
  private key is not extractable by page script.
- Every `RTCPeerConnection` gets `certificates: [cert]`, so the code is the same
  across generations, ICE restarts, reloads and rooms.
- If IndexedDB is unavailable (some private modes, blocked storage), the
  certificate is kept in memory for the page's lifetime. The code is then stable
  across reconnects but changes on reload, and the dialog says so. If
  `generateCertificate` is missing, the browser default is used and verification
  still works per connection.

Consequences:

- **Rotation.** When the certificate expires (after a year) or site data is
  cleared, the device gets a new code. Peers then show it as not verified, and the
  users must compare again.
- **Linkability (privacy cost).** The fingerprint is a stable identifier of the
  browser profile. It is visible to room peers and, inside SDP, to the LanDrop
  server, which can now link the same device across rooms and sessions. The server
  could already correlate by LAN IP and the self-chosen device name. Clearing site
  data resets the identifier. Not logged: SDP is never logged (security.md §7),
  and the diagnostics export has the verification status, never fingerprints.
- **Origin-bound.** `http://192.168.1.20:8787` and `https://landrop.lan:8443` are
  different origins with different IndexedDB storage, so they have different codes.

## 5. Verified marks and re-checking

- **Pins.** "Mark as verified" stores the *remote* certificate's full SHA-256
  fingerprint with the device name shown at that moment and a timestamp
  (`localStorage`, `landrop.verifiedDevices`, at most 200 entries, oldest dropped).
  The pin says "this certificate belongs to the device I compared with". It is
  keyed by fingerprint, not by the server-assigned `peerId` (which changes every
  session) or the self-asserted display name.
- The UI shows the **saved** name next to the badge when the current display name
  differs ("Verified as Bob's laptop"). Renaming cannot transfer a verification.
- **Re-check on every generation.** Certificates are read from `getStats()` in the
  existing 2-second stats poll of the current `RTCPeerConnection`, and reset when a
  new generation is built. The status is recomputed from scratch each time:

  | Status | Condition |
  | --- | --- |
  | `pending` | No DTLS certificates reported yet (connecting / new generation) |
  | `unavailable` | Stats missing or inconsistent: not exactly one connected DTLS transport, local hash ≠ configured certificate, or local = remote |
  | `verified` | Remote fingerprint is pinned |
  | `changed` | This `peerId` was verified earlier in this session and the current remote fingerprint is different and not pinned |
  | `unverified` | Otherwise |

- `changed` shows a red badge, a persistent warning in the device panel, and one
  notice. Transfers and chat are **not** blocked: the user decides. Across
  sessions there is no `peerId` continuity, so a device that comes back with a new
  certificate just shows as not verified. The missing badge is the signal.
- "Mark as verified" pins the fingerprint that the dialog *displayed*. It is refused
  if the connection's remote certificate changed in between (for example a new
  generation arrived while the dialog was open).
- Verification is one-sided state. A verifying B does not make A show B as
  verified; each user marks the other on their own screen after comparing.

## 6. What this does **not** protect against

**The LanDrop server delivers the app.** The same Fastify process (behind Caddy in
the HTTPS deployment) serves the HTML and JavaScript. An attacker who controls the
server, or an on-path attacker when LanDrop is used over plain HTTP, can serve a
modified client that shows matching numbers, shows a fake "Verified" badge, or
just uploads the files over the WebSocket. No in-page check can defend against the
code doing the checking. **Verification therefore does not remove the need to
trust the LanDrop host,** and security.md §5 still says so.

What verification does protect against, given a genuine client:

1. **Impersonation by another room member.** Display names are self-asserted. A
   member who renames itself "Bob's phone" cannot get Bob's pin, because it does
   not hold Bob's certificate key. This is the main practical benefit today.
2. **Signaling-only tampering.** Any component that can alter signaling messages
   but not the page code: for example a future deployment where the client comes
   from a separately trusted source (an installed or pinned build) and signaling
   from an untrusted relay. Today's single-server deployment does not have this
   separation, so treat this as a foundation, not a current guarantee.
3. **After-the-fact detection** of a lazily compromised server that rewrites SDP
   but leaves the client alone. A pinned device then shows `changed` or loses its
   badge. This is evidence, not a guarantee.

Also not covered: compromised endpoints (security.md T15), a person who clicks
"They match" without comparing, and a mistaken comparison over a channel the
attacker controls (compare in person, or over a voice/video call you trust).

## 7. Alternatives considered

| Option | Why not (now) |
| --- | --- |
| Short combined SAS (e.g. 6–8 words / 44 bits) over both fingerprints | Collision-grindable by an active MITM at ~2^(n/2) (§3). |
| Commitment-based SAS (hash-commit/reveal of nonces over the data channel, as in ZRTP or Vaudenay's SAS-MCA) giving a short code with a single-guess 2^-n bound | Needs a new in-band protocol adapted by us to WebRTC, which the project rules out without an expert review. The code changes on every connection, so it must be recompared after every automatic rebuild, which defeats a stable "Verified" mark. A reasonable future option *in addition* to pins, after review. |
| WebRTC identity providers (`setIdentityProvider`) | Not implemented by Chromium; needs an external IdP. |
| Show full 256-bit fingerprints | No security gain over 128 bits per device for human comparison; twice as long. |
| QR-code scan of the other screen's code | Better UX for co-located devices; needs camera access and a scanner dependency. Future work, compatible with this design (scan = compare). |

## 8. UX

- Device card: green **Verified** badge, or red **Code changed**.
- Device panel: verification status and a **Verify** button that opens the
  dialog with the 16-group safety number (8 groups for "This device", 8 for the
  other device, in a deterministic order identical on both screens), instructions,
  and the limits from §6 in one sentence.
- Buttons: **They match — mark as verified**, or **Remove verification** for a
  verified device.

## 9. Implementation map and tests

| Piece | Location |
| --- | --- |
| Certificate load/generate/persist | `apps/web/src/core/identity.ts` |
| Stats parsing, hashing, safety number, pins, status tracker | `apps/web/src/core/verification.ts` |
| Certificate passed to every `RTCPeerConnection`; certificates read each stats poll and reset per generation | `apps/web/src/core/peer-link.ts` |
| Status per peer, mark/remove, "changed" notice | `apps/web/src/core/controller.ts` |
| Dialog and badges | `apps/web/src/ui/Verify.tsx`, `RoomView.tsx` |

Tests:

- Unit (`apps/web/test/verification.test.ts`): stats parsing (fail-closed
  cases), hashing against a known vector, symmetric safety number, every status
  transition including `changed`, pin bounds and validation, refusal to pin a
  stale fingerprint.
- E2E (`tests/e2e/verify.spec.ts`, Chromium): both screens show the same number;
  it equals the browser's own `getStats()` fingerprints; mark verified; still
  verified after a manual reconnect (new generation, same number); still verified
  after the other tab reloads (persisted certificate); `changed` warning after the
  other device's certificate is replaced.
