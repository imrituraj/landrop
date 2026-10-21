import { test } from '@playwright/test';

/**
 * Baseline: raw RTCDataChannel throughput between two RTCPeerConnections in one
 * page (no LanDrop code). Used to separate browser/transport limits from
 * LanDrop's pipeline. Results are environment-specific.
 */
test('raw data channel baseline', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/healthz');
  for (const chunk of [16 * 1024, 64 * 1024, 256 * 1024 - 64]) {
    for (const high of [1, 4, 8]) {
      const r = await page.evaluate(
        async ({ chunk, high }) => {
          const a = new RTCPeerConnection();
          const b = new RTCPeerConnection();
          a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
          b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
          const ch = a.createDataChannel('x', { ordered: true });
          ch.binaryType = 'arraybuffer';
          const total = 64 * 1024 * 1024;
          let received = 0;
          const done = new Promise<number>((resolve) => {
            b.ondatachannel = (e) => {
              const t0 = performance.now();
              e.channel.onmessage = (m) => {
                received += (m.data as ArrayBuffer).byteLength;
                if (received >= total) resolve(performance.now() - t0);
              };
            };
          });
          await a.setLocalDescription();
          await b.setRemoteDescription(a.localDescription!);
          await b.setLocalDescription();
          await a.setRemoteDescription(b.localDescription!);
          await new Promise((r) => (ch.onopen = r));
          const buf = new Uint8Array(chunk);
          ch.bufferedAmountLowThreshold = (high * 1024 * 1024) / 4;
          let sent = 0;
          while (sent < total) {
            if (ch.bufferedAmount > high * 1024 * 1024) {
              await new Promise((r) => (ch.onbufferedamountlow = r));
              continue;
            }
            const n = Math.min(chunk, total - sent);
            ch.send(n === chunk ? buf : buf.subarray(0, n));
            sent += n;
          }
          const ms = await done;
          a.close();
          b.close();
          return { mbps: total / 1e6 / (ms / 1000), maxMessageSize: a.sctp?.maxMessageSize };
        },
        { chunk, high },
      );
      console.log(`chunk=${chunk} highWater=${high}MiB -> ${r.mbps.toFixed(1)} MB/s (maxMessageSize ${r.maxMessageSize})`);
    }
  }
});

test('raw data channel baseline across two browser contexts', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await a.goto('/healthz');
  await b.goto('/healthz');
  const total = 128 * 1024 * 1024;
  const offer = await a.evaluate(async () => {
    const pc = new RTCPeerConnection();
    (window as unknown as { pc: RTCPeerConnection }).pc = pc;
    const ch = pc.createDataChannel('x');
    ch.binaryType = 'arraybuffer';
    (window as unknown as { ch: RTCDataChannel }).ch = ch;
    await pc.setLocalDescription();
    await new Promise<void>((r) => {
      if (pc.iceGatheringState === 'complete') r();
      else pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r();
    });
    return pc.localDescription!.sdp;
  });
  const answer = await b.evaluate(
    async ({ sdp, total }) => {
      const pc = new RTCPeerConnection();
      (window as unknown as { pc: RTCPeerConnection }).pc = pc;
      (window as unknown as { done: Promise<number> }).done = new Promise((resolve) => {
        pc.ondatachannel = (e) => {
          let received = 0;
          let t0 = 0;
          e.channel.onmessage = (m) => {
            if (!t0) t0 = performance.now();
            received += (m.data as ArrayBuffer).byteLength;
            if (received >= total) resolve(performance.now() - t0);
          };
        };
      });
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription();
      await new Promise<void>((r) => {
        if (pc.iceGatheringState === 'complete') r();
        else pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r();
      });
      return pc.localDescription!.sdp;
    },
    { sdp: offer, total },
  );
  await a.evaluate(async ({ sdp, total }) => {
    const w = window as unknown as { pc: RTCPeerConnection; ch: RTCDataChannel };
    await w.pc.setRemoteDescription({ type: 'answer', sdp });
    const ch = w.ch;
    if (ch.readyState !== 'open') await new Promise((r) => (ch.onopen = r));
    const buf = new Uint8Array(64 * 1024);
    ch.bufferedAmountLowThreshold = 1024 * 1024;
    let sent = 0;
    while (sent < total) {
      if (ch.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise((r) => (ch.onbufferedamountlow = r));
        continue;
      }
      ch.send(buf);
      sent += buf.length;
    }
  }, { sdp: answer, total });
  const ms = await b.evaluate(() => (window as unknown as { done: Promise<number> }).done);
  console.log(`two contexts, 64 KiB chunks: ${(total / 1e6 / (ms / 1000)).toFixed(1)} MB/s`);
  await ctxA.close();
  await ctxB.close();
});
