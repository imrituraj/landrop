import { describe, expect, it } from 'vitest';
import {
  MAX_PINS,
  PINS_KEY,
  PinStore,
  VerificationTracker,
  certificateFingerprint,
  deviceCode,
  normalizeFingerprint,
  readDtlsCertificates,
  safetyNumber,
} from '../src/core/verification.ts';

// SHA-256("abc"), the FIPS 180-2 test vector; "YWJj" is base64 of "abc".
const ABC_FP = 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD';

const b64 = (s: string) => btoa(s);
const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

function report(local: string | null, remote: string | null, extra: Array<[string, Record<string, unknown>]> = []) {
  return new Map<string, Record<string, unknown>>([
    ['T1', { type: 'transport', dtlsState: 'connected', localCertificateId: 'CL', remoteCertificateId: 'CR' }],
    ...(local ? ([['CL', { type: 'certificate', base64Certificate: local }]] as Array<[string, Record<string, unknown>]>) : []),
    ...(remote ? ([['CR', { type: 'certificate', base64Certificate: remote }]] as Array<[string, Record<string, unknown>]>) : []),
    ...extra,
  ]);
}

describe('reading DTLS certificates from getStats()', () => {
  it('follows the transport certificate ids', () => {
    expect(readDtlsCertificates(report(b64('local'), b64('remote')))).toEqual({ local: b64('local'), remote: b64('remote') });
  });

  it('fails closed on missing or ambiguous data', () => {
    expect(readDtlsCertificates(report(b64('l'), null))).toBeNull();
    expect(readDtlsCertificates(new Map())).toBeNull();
    const notConnected = report(b64('l'), b64('r'));
    notConnected.set('T1', { ...notConnected.get('T1'), dtlsState: 'connecting' });
    expect(readDtlsCertificates(notConnected)).toBeNull();
    const twoTransports = report(b64('l'), b64('r'), [
      ['T2', { type: 'transport', dtlsState: 'connected', localCertificateId: 'CL', remoteCertificateId: 'CR' }],
    ]);
    expect(readDtlsCertificates(twoTransports)).toBeNull();
    // An id pointing at a non-certificate entry is not accepted.
    const wrongType = report(b64('l'), null, [['CR', { type: 'codec', base64Certificate: b64('r') }]]);
    expect(readDtlsCertificates(wrongType)).toBeNull();
  });
});

describe('fingerprints and safety numbers', () => {
  it('hashes the DER bytes with SHA-256 (uppercase hex)', () => {
    expect(certificateFingerprint('YWJj')).toBe(ABC_FP);
    expect(certificateFingerprint('')).toBeNull();
    expect(certificateFingerprint('***')).toBeNull();
  });

  it('normalizes browser-formatted fingerprints', () => {
    const colon = ABC_FP.match(/../g)!.join(':').toLowerCase();
    expect(normalizeFingerprint(colon)).toBe(ABC_FP);
    expect(normalizeFingerprint('AB:CD')).toBeNull();
  });

  it('shows the first 128 bits of each fingerprint as 8 groups of 4', () => {
    expect(deviceCode(ABC_FP)).toEqual(['BA78', '16BF', '8F01', 'CFEA', '4141', '40DE', '5DAE', '2223']);
  });

  it('is identical on both sides and marks the local line', () => {
    const a = certificateFingerprint(b64('device A'))!;
    const b = certificateFingerprint(b64('device B'))!;
    const onA = safetyNumber(a, b);
    const onB = safetyNumber(b, a);
    expect(onA.lines).toEqual(onB.lines);
    expect(onA.localLine).not.toBe(onB.localLine);
    expect(onA.lines[onA.localLine]).toEqual(deviceCode(a));
    expect(onB.lines[onB.localLine]).toEqual(deviceCode(b));
  });

  it('differs when either side sees a substituted certificate (MITM)', () => {
    const [ca, cb, ma, mb] = ['A', 'B', 'MA', 'MB'].map((s) => certificateFingerprint(b64(s))!);
    expect(safetyNumber(ca!, ma!).lines).not.toEqual(safetyNumber(cb!, mb!).lines);
  });
});

describe('verified-device pins', () => {
  it('persists, validates, and bounds pins', () => {
    const storage = memoryStorage();
    const pins = new PinStore(storage);
    pins.add(ABC_FP, 'Bob');
    expect(new PinStore(storage).get(ABC_FP)?.label).toBe('Bob');
    for (let i = 0; i < MAX_PINS + 5; i++) pins.add(i.toString(16).toUpperCase().padStart(64, '0'), `d${i}`);
    expect(new PinStore(storage).size).toBe(MAX_PINS);
    expect(new PinStore(storage).get(ABC_FP)).toBeNull(); // oldest dropped
    storage.setItem(PINS_KEY, JSON.stringify([{ fingerprint: 'nothex', label: 'x', verifiedAt: 1 }, 'junk']));
    expect(new PinStore(storage).size).toBe(0);
    storage.setItem(PINS_KEY, '{not json');
    expect(new PinStore(storage).size).toBe(0);
  });
});

describe('verification status', () => {
  const local = b64('local cert');
  const remote = b64('remote cert');
  const other = b64('attacker cert');
  const localFp = certificateFingerprint(local)!;
  const remoteFp = certificateFingerprint(remote)!;
  const otherFp = certificateFingerprint(other)!;
  const tracker = () => new VerificationTracker(new PinStore(memoryStorage()), localFp);

  it('is pending without certificates and unverified until marked', () => {
    const t = tracker();
    expect(t.observe('p', null).status).toBe('pending');
    const v = t.observe('p', { local, remote });
    expect(v.status).toBe('unverified');
    expect(v.remoteFingerprint).toBe(remoteFp);
    expect(v.number).toEqual(safetyNumber(localFp, remoteFp));
  });

  it('is unavailable when the local certificate is not the configured one, or local equals remote', () => {
    const t = tracker();
    expect(t.observe('p', { local: other, remote }).status).toBe('unavailable');
    expect(t.observe('p', { local, remote: local }).status).toBe('unavailable');
    expect(t.observe('p', { local: '***', remote }).status).toBe('unavailable');
  });

  it('stays verified across generations and new sessions with the same certificate', () => {
    const pins = new PinStore(memoryStorage());
    const t = new VerificationTracker(pins, localFp);
    t.observe('p', { local, remote });
    expect(t.markVerified('p', remoteFp, 'Bob')).toBe(true);
    expect(t.observe('p', null).status).toBe('pending'); // new generation, not yet connected
    expect(t.observe('p', { local, remote })).toMatchObject({ status: 'verified', verifiedLabel: 'Bob' });
    // Next session: new peerId, new tracker, same pins.
    expect(new VerificationTracker(pins, localFp).observe('q', { local, remote }).status).toBe('verified');
  });

  it('reports "changed" when a verified peer comes back with another certificate', () => {
    const t = tracker();
    t.observe('p', { local, remote });
    t.markVerified('p', remoteFp, 'Bob');
    expect(t.observe('p', { local, remote: other }).status).toBe('changed');
    expect(t.observe('p', null).status).toBe('pending');
    expect(t.observe('p', { local, remote: other }).status).toBe('changed'); // sticky across generations
    expect(t.markVerified('p', otherFp, 'Bob')).toBe(true); // user compared again
    expect(t.observe('p', { local, remote: other }).status).toBe('verified');
    expect(t.observe('p', { local, remote }).status).toBe('verified'); // old pin still valid
  });

  it('an unverified peer whose certificate changes is simply unverified', () => {
    const t = tracker();
    t.observe('p', { local, remote });
    expect(t.observe('p', { local, remote: other }).status).toBe('unverified');
  });

  it('refuses to pin a fingerprint that is not the current one', () => {
    const t = tracker();
    expect(t.markVerified('p', remoteFp, 'Bob')).toBe(false); // nothing observed
    t.observe('p', { local, remote });
    t.observe('p', { local, remote: other }); // generation changed while the dialog was open
    expect(t.markVerified('p', remoteFp, 'Bob')).toBe(false);
    t.observe('p', null);
    expect(t.markVerified('p', otherFp, 'Bob')).toBe(false);
  });

  it('removing verification unpins the certificate', () => {
    const t = tracker();
    t.observe('p', { local, remote });
    t.markVerified('p', remoteFp, 'Bob');
    t.unverify('p');
    expect(t.observe('p', { local, remote }).status).toBe('unverified');
  });
});
