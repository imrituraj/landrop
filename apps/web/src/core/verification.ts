import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@landrop/shared';

/**
 * Peer verification (design: docs/peer-verification.md).
 *
 * Users compare each device's code: the first 128 bits of the SHA-256 hash of
 * its DTLS certificate, i.e. the first half of the standard WebRTC "sha-256"
 * fingerprint. Codes are shown per device (never a short hash *over both*
 * fingerprints) so that fooling the comparison needs a 128-bit second preimage
 * per leg, not a 2^(n/2) collision. No new protocol: we only compare what DTLS
 * already authenticated, as reported by getStats().
 */

/** Base64 DER of the leaf certificates of the connection's DTLS transport. */
export interface DtlsCertificates {
  local: string;
  remote: string;
}

type StatsEntry = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Reads the negotiated certificates from a getStats() report. Fails closed
 * (null) unless there is exactly one connected DTLS transport with both
 * certificates present: LanDrop uses data channels only, so one bundled
 * transport carries every channel.
 */
export function readDtlsCertificates(report: { forEach(cb: (value: StatsEntry, key: string) => void): void }): DtlsCertificates | null {
  const byId = new Map<string, StatsEntry>();
  report.forEach((value, key) => byId.set(key, value));
  const transports = [...byId.values()].filter((s) => s['type'] === 'transport' && s['dtlsState'] === 'connected');
  if (transports.length !== 1) return null;
  const t = transports[0]!;
  const cert = (id: string | null): string | null => {
    const entry = id ? byId.get(id) : undefined;
    return entry && entry['type'] === 'certificate' ? str(entry['base64Certificate']) : null;
  };
  const local = cert(str(t['localCertificateId']));
  const remote = cert(str(t['remoteCertificateId']));
  return local && remote ? { local, remote } : null;
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Full SHA-256 fingerprint of a base64 DER certificate: 64 uppercase hex digits. */
export function certificateFingerprint(base64Der: string): string | null {
  const der = base64ToBytes(base64Der);
  return der && der.length > 0 ? bytesToHex(sha256(der)).toUpperCase() : null;
}

/** "AB:CD:…" (RTCCertificate.getFingerprints(), getStats()) → "ABCD…". */
export function normalizeFingerprint(value: string): string | null {
  const hex = value.replace(/:/g, '').toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex : null;
}

/** Hex digits of each device's code (128 bits). */
export const CODE_HEX_DIGITS = 32;

/** A device's code: the first 128 bits of its fingerprint as 8 groups of 4 hex digits. */
export function deviceCode(fingerprint: string): string[] {
  return fingerprint.slice(0, CODE_HEX_DIGITS).match(/.{4}/g) ?? [];
}

export interface SafetyNumber {
  /** Two device codes, ordered by fingerprint so both screens show the same lines. */
  lines: [string[], string[]];
  /** Which line is this device. */
  localLine: 0 | 1;
}

export function safetyNumber(localFp: string, remoteFp: string): SafetyNumber {
  const localFirst = localFp < remoteFp;
  const [a, b] = localFirst ? [localFp, remoteFp] : [remoteFp, localFp];
  return { lines: [deviceCode(a), deviceCode(b)], localLine: localFirst ? 0 : 1 };
}

// -----------------------------------------------------------------------------
// Pins: remote certificates the user has verified.

export interface Pin {
  /** Full SHA-256 fingerprint of the verified device's certificate. */
  fingerprint: string;
  /** Device name shown when the user verified it (display names are self-asserted). */
  label: string;
  verifiedAt: number;
}

export const PINS_KEY = 'landrop.verifiedDevices';
export const MAX_PINS = 200;

export class PinStore {
  private pins: Pin[];
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;

  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.storage = storage;
    this.pins = this.load();
  }

  get(fingerprint: string): Pin | null {
    return this.pins.find((p) => p.fingerprint === fingerprint) ?? null;
  }

  add(fingerprint: string, label: string, now = Date.now()): void {
    this.pins = [...this.pins.filter((p) => p.fingerprint !== fingerprint), { fingerprint, label: label.slice(0, 64), verifiedAt: now }];
    if (this.pins.length > MAX_PINS) this.pins = this.pins.slice(-MAX_PINS);
    this.save();
  }

  remove(fingerprint: string): void {
    this.pins = this.pins.filter((p) => p.fingerprint !== fingerprint);
    this.save();
  }

  get size(): number {
    return this.pins.length;
  }

  private load(): Pin[] {
    try {
      const raw = this.storage?.getItem(PINS_KEY);
      if (!raw) return [];
      const v: unknown = JSON.parse(raw);
      if (!Array.isArray(v)) return [];
      return v
        .filter(
          (p): p is Pin =>
            typeof p === 'object' &&
            p !== null &&
            typeof p.fingerprint === 'string' &&
            /^[0-9A-F]{64}$/.test(p.fingerprint) &&
            typeof p.label === 'string' &&
            typeof p.verifiedAt === 'number',
        )
        .slice(-MAX_PINS);
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(PINS_KEY, JSON.stringify(this.pins));
    } catch {
      // Storage full or unavailable: the pin lasts for this page only.
    }
  }
}

// -----------------------------------------------------------------------------
// Per-peer status, recomputed on every stats poll of every generation.

export type VerifyStatus = 'pending' | 'unavailable' | 'unverified' | 'verified' | 'changed';

export interface VerificationView {
  status: VerifyStatus;
  number: SafetyNumber | null;
  /** Remote fingerprint the number was computed from (what "mark verified" pins). */
  remoteFingerprint: string | null;
  /** Name saved with the pin, when verified. */
  verifiedLabel: string | null;
}

export const PENDING_VERIFICATION: VerificationView = { status: 'pending', number: null, remoteFingerprint: null, verifiedLabel: null };

interface PeerRecord {
  /** Remote fingerprint last seen as verified for this peerId in this session. */
  verifiedFp: string | null;
  current: string | null;
}

export class VerificationTracker {
  private readonly peers = new Map<string, PeerRecord>();
  private readonly hashCache = new Map<string, string | null>();

  /**
   * @param expectedLocal fingerprint of the certificate we configured, or null
   *   when the browser chose its own (then the local check is skipped).
   */
  private readonly pins: PinStore;
  private readonly expectedLocal: string | null;

  constructor(pins: PinStore, expectedLocal: string | null) {
    this.pins = pins;
    this.expectedLocal = expectedLocal;
  }

  private hash(b64: string): string | null {
    let fp = this.hashCache.get(b64);
    if (fp === undefined) {
      fp = certificateFingerprint(b64);
      if (this.hashCache.size > 64) this.hashCache.clear();
      this.hashCache.set(b64, fp);
    }
    return fp;
  }

  observe(peerId: string, certs: DtlsCertificates | null): VerificationView {
    let rec = this.peers.get(peerId);
    if (!rec) {
      rec = { verifiedFp: null, current: null };
      this.peers.set(peerId, rec);
    }
    rec.current = null;
    if (!certs) return PENDING_VERIFICATION;
    const local = this.hash(certs.local);
    const remote = this.hash(certs.remote);
    if (!local || !remote || local === remote || (this.expectedLocal !== null && local !== this.expectedLocal)) {
      return { status: 'unavailable', number: null, remoteFingerprint: null, verifiedLabel: null };
    }
    rec.current = remote;
    const number = safetyNumber(local, remote);
    const pin = this.pins.get(remote);
    if (pin) {
      rec.verifiedFp = remote;
      return { status: 'verified', number, remoteFingerprint: remote, verifiedLabel: pin.label };
    }
    const status = rec.verifiedFp !== null && rec.verifiedFp !== remote ? 'changed' : 'unverified';
    return { status, number, remoteFingerprint: remote, verifiedLabel: null };
  }

  /** Pins the fingerprint the user compared; refused if the connection's certificate changed since. */
  markVerified(peerId: string, displayedFp: string, label: string): boolean {
    const rec = this.peers.get(peerId);
    if (!rec || rec.current === null || rec.current !== displayedFp) return false;
    this.pins.add(displayedFp, label);
    rec.verifiedFp = displayedFp;
    return true;
  }

  unverify(peerId: string): void {
    const rec = this.peers.get(peerId);
    if (!rec) return;
    if (rec.current) this.pins.remove(rec.current);
    if (rec.verifiedFp) this.pins.remove(rec.verifiedFp);
    rec.verifiedFp = null;
  }

  forget(peerId: string): void {
    this.peers.delete(peerId);
  }
}
