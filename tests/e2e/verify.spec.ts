import { expect, test, type Page } from '@playwright/test';
import { openDevice, pair, selectPeer, type Device } from './fixtures.ts';

/** Records every RTCPeerConnection so the test can read the browser's own getStats() fingerprints. */
async function trackPeerConnections(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Orig = window.RTCPeerConnection;
    const pcs: RTCPeerConnection[] = [];
    (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
    window.RTCPeerConnection = class extends Orig {
      constructor(config?: RTCConfiguration) {
        super(config);
        pcs.push(this);
      }
    };
  });
}

/** [local, remote] sha-256 fingerprints (uppercase hex, no colons) of the open connection, per the browser. */
function browserFingerprints(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((pc) => pc.connectionState === 'connected');
    if (pcs.length !== 1) throw new Error(`expected one connected pc, got ${pcs.length}`);
    const stats = new Map<string, Record<string, unknown>>();
    (await pcs[0]!.getStats()).forEach((v: Record<string, unknown>, k: string) => stats.set(k, v));
    const t = [...stats.values()].find((s) => s['type'] === 'transport' && s['dtlsState'] === 'connected')!;
    return [t['localCertificateId'], t['remoteCertificateId']].map((id) => {
      const c = stats.get(id as string)!;
      if (c['fingerprintAlgorithm'] !== 'sha-256') throw new Error('unexpected fingerprint algorithm');
      return (c['fingerprint'] as string).replace(/:/g, '').toUpperCase();
    });
  });
}

/** Opens the Verify dialog for the selected peer and returns the safety number's 16 groups. */
async function readSafetyNumber(d: Device): Promise<string[]> {
  const verify = d.page.getByRole('button', { name: 'Verify', exact: true });
  await expect(verify).toBeEnabled({ timeout: 20_000 });
  await verify.click();
  const number = d.page.getByTestId('safety-number');
  await expect(number).toBeVisible();
  const groups = (await number.innerText()).match(/\b[0-9A-F]{4}\b/g) ?? [];
  expect(groups).toHaveLength(16);
  return groups;
}

async function closeDialog(d: Device): Promise<void> {
  await d.page.getByRole('dialog').getByRole('button', { name: /^(Cancel|Close)$/ }).click();
}

const status = (d: Device) => d.page.getByTestId('verification-status');

test('peer verification: matching safety numbers, pins across reconnects and reloads, changed-code warning', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await openDevice(browser, 'Alice', trackPeerConnections);
  const b = await openDevice(browser, 'Bob', trackPeerConnections);
  try {
    await pair(a, b);
    await selectPeer(a, 'Bob');
    await selectPeer(b, 'Alice');
    await expect(status(a)).toHaveText('Not verified', { timeout: 20_000 });

    // Both screens show the same number, made of the first 128 bits of each
    // certificate fingerprint the browser itself reports for the DTLS transport.
    const onA = await readSafetyNumber(a);
    const onB = await readSafetyNumber(b);
    expect(onA).toEqual(onB);
    const [aLocal, aRemote] = await browserFingerprints(a.page);
    const [bLocal, bRemote] = await browserFingerprints(b.page);
    expect(aRemote).toBe(bLocal); // no MITM in the test, so each side sees the other's real certificate
    expect(bRemote).toBe(aLocal);
    const expected = [aLocal!, aRemote!].sort().map((fp) => fp.slice(0, 32).match(/.{4}/g)!).flat();
    expect(onA).toEqual(expected);
    await closeDialog(b);

    // A marks B as verified; B's view of A is unaffected.
    await a.page.getByRole('button', { name: 'They match — mark as verified' }).click();
    await expect(status(a)).toHaveText('Verified');
    await expect(a.page.getByRole('button', { name: /^Bob, .*, Verified/ })).toBeVisible();
    await expect(status(b)).toHaveText('Not verified');

    // A new connection generation re-checks the certificate: same number, still verified.
    await a.page.getByRole('button', { name: 'Reconnect' }).click();
    await expect(status(a)).toHaveText('Verified', { timeout: 30_000 });
    expect(await readSafetyNumber(a)).toEqual(onA);
    await closeDialog(a);

    // B reloads: its certificate comes back from IndexedDB, so the pin still matches.
    await b.page.reload();
    await expect(b.page.getByText('Server connected').first()).toBeVisible();
    await expect(status(a)).toHaveText('Verified', { timeout: 40_000 });
    await expect(a.page.getByRole('button', { name: /^Bob, .*Direct/ })).toBeVisible({ timeout: 30_000 });
    expect(await readSafetyNumber(a)).toEqual(onA);
    await closeDialog(a);

    // B loses its stored certificate (as if a different key answered as Bob): A warns.
    await b.page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const r = indexedDB.deleteDatabase('landrop');
          r.onsuccess = () => resolve();
          r.onerror = () => reject(new Error('delete failed'));
        }),
    );
    await b.page.reload();
    // The reload resumes the same server session (peerId), so this is the in-session "changed" case.
    await expect(status(a)).toHaveText('Security code changed', { timeout: 40_000 });
    await expect(a.page.getByRole('button', { name: /^Bob, .*, Security code changed/ })).toBeVisible();
    await expect(a.page.getByText('the security code changed since you verified this device')).toBeVisible();
    const changedNumber = await readSafetyNumber(a);
    expect(changedNumber).not.toEqual(onA);
    await closeDialog(a);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
