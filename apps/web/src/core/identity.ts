import { log } from './log.ts';
import { normalizeFingerprint } from './verification.ts';

/**
 * This device's DTLS certificate, kept in IndexedDB so its verification code
 * stays the same across connections, reloads and rooms (docs/peer-verification.md §4).
 * The private key is not extractable by page script; IndexedDB stores the
 * structured-cloned RTCCertificate.
 */

const DB_NAME = 'landrop';
const STORE = 'identity';
const KEY = 'dtls-certificate';
const LIFETIME_MS = 365 * 24 * 3600 * 1000;
const MIN_REMAINING_MS = 24 * 3600 * 1000;
const IDB_TIMEOUT_MS = 3000;

export interface LocalIdentity {
  certificate: RTCCertificate | null;
  /** SHA-256 fingerprint (64 uppercase hex) of `certificate`, if known. */
  fingerprint: string | null;
  /** 'stored': survives reloads; 'memory': this page only; 'browser': browser picks one per connection. */
  persistence: 'stored' | 'memory' | 'browser';
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('IndexedDB timeout')), IDB_TIMEOUT_MS))]);
}

async function openDb(): Promise<IDBDatabase> {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  return withTimeout(req(open));
}

async function readStored(db: IDBDatabase): Promise<unknown> {
  return withTimeout(req(db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY)));
}

async function writeStored(db: IDBDatabase, cert: RTCCertificate): Promise<void> {
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(cert, KEY);
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    }),
  );
}

function fingerprintOf(cert: RTCCertificate): string | null {
  const fp = cert.getFingerprints?.().find((f) => f.algorithm?.toLowerCase() === 'sha-256');
  return fp?.value ? normalizeFingerprint(fp.value) : null;
}

const usable = (c: unknown): c is RTCCertificate =>
  typeof RTCCertificate !== 'undefined' && c instanceof RTCCertificate && c.expires - Date.now() > MIN_REMAINING_MS;

export async function loadLocalIdentity(): Promise<LocalIdentity> {
  if (typeof RTCPeerConnection === 'undefined' || typeof RTCPeerConnection.generateCertificate !== 'function') {
    return { certificate: null, fingerprint: null, persistence: 'browser' };
  }
  let db: IDBDatabase | null;
  try {
    db = await openDb();
  } catch (err) {
    log.warn(`identity: IndexedDB unavailable (${(err as Error).name})`);
    db = null;
  }
  if (db) {
    const stored = await readStored(db).catch(() => null);
    if (usable(stored)) {
      db.close();
      return { certificate: stored, fingerprint: fingerprintOf(stored), persistence: 'stored' };
    }
  }
  let cert: RTCCertificate;
  try {
    cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256', expires: LIFETIME_MS } as AlgorithmIdentifier);
  } catch (err) {
    log.warn(`identity: generateCertificate failed (${(err as Error).name})`);
    db?.close();
    return { certificate: null, fingerprint: null, persistence: 'browser' };
  }
  let persistence: LocalIdentity['persistence'] = 'memory';
  if (db) {
    try {
      await writeStored(db, cert);
      persistence = 'stored';
    } catch (err) {
      log.warn(`identity: could not store certificate (${(err as Error).name})`);
    }
    db.close();
  }
  log.info(`identity: new certificate (${persistence})`);
  return { certificate: cert, fingerprint: fingerprintOf(cert), persistence };
}
