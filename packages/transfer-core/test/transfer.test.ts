import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, parsePeerMessage } from '@landrop/protocol';
import { encodeDataFrame, transferIdToBytes, type IncomingTransfer, type OutgoingTransfer } from '../src/index.ts';
import { DeterministicSource, FakeLink, HashingSink, sleep, waitFor } from './harness.ts';

const meta = (size: number, name = 'file.bin') => ({ name, size, mime: 'application/octet-stream' });

async function sendAndAccept(link: FakeLink, size: number, sink = new HashingSink(), seed = 7) {
  const source = new DeterministicSource(size, seed);
  const out = link.a.mgr.send(source, meta(size));
  await waitFor(() => link.b.offers.length > 0, 2000, 'offer');
  const inc = link.b.offers.shift()!;
  await link.b.mgr.accept(inc.id, async () => sink);
  return { source, out, inc, sink };
}

describe('end-to-end transfer over a simulated link', () => {
  it('transfers a small file and completes only after receiver verification', async () => {
    const link = new FakeLink();
    link.connect();
    const { source, out, inc, sink } = await sendAndAccept(link, 300_000);
    await waitFor(() => out.state === 'completed', 5000, 'sender completed');
    expect(inc.state).toBe('completed');
    expect(sink.digest()).toBe(source.sha256());
    expect(sink.finalized).toBe(true);
    expect(out.sha256).toBe(source.sha256());
    // Sender history never shows completed before verifying.
    expect(link.a.history.get(out.id)).toEqual(['queued', 'requesting', 'awaiting_acceptance', 'transferring', 'verifying', 'completed']);
    expect(link.b.history.get(inc.id)).toEqual(['awaiting_acceptance', 'preparing', 'transferring', 'verifying', 'finalizing', 'completed']);
  });

  it('works when the hasher detaches buffers (worker transfer semantics)', async () => {
    const link = new FakeLink({ detachingHasher: true });
    link.connect();
    const { source, out, inc, sink } = await sendAndAccept(link, 3_000_000);
    await waitFor(() => out.state === 'completed', 5000);
    expect(inc.writtenOffset).toBe(3_000_000);
    expect(sink.digest()).toBe(source.sha256());
  });

  it('keeps default send-queue limits below the 16 MiB Chromium data channel cap', async () => {
    const { DEFAULT_ENGINE_CONFIG } = await import('../src/index.ts');
    expect(DEFAULT_ENGINE_CONFIG.highWaterBytes + DEFAULT_ENGINE_CONFIG.maxChunkBytes + 36).toBeLessThan(16 * 1024 * 1024);
    expect(DEFAULT_ENGINE_CONFIG.maxChunkBytes + 36).toBeLessThanOrEqual(256 * 1024);
  });

  it('transfers a zero-byte file', async () => {
    const link = new FakeLink();
    link.connect();
    const { out, inc, sink } = await sendAndAccept(link, 0);
    await waitFor(() => out.state === 'completed');
    expect(inc.state).toBe('completed');
    expect(sink.digest()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('handles sizes at and around chunk boundaries', async () => {
    const link = new FakeLink({ config: { maxChunkBytes: 4096 } });
    link.connect();
    for (const size of [1, 4095, 4096, 4097, 8192, 12_289]) {
      const { source, out, sink } = await sendAndAccept(link, size, new HashingSink(), size);
      await waitFor(() => out.state === 'completed', 5000, `size ${size}`);
      expect(sink.digest()).toBe(source.sha256());
      expect(source.maxReadLength).toBeLessThanOrEqual(4096);
    }
  });

  it('keeps sender queue and receiver queue bounded on a 64 MiB transfer', async () => {
    const high = 512 * 1024;
    const windowBytes = 2 * 1024 * 1024;
    const link = new FakeLink({
      config: { highWaterBytes: high, lowWaterBytes: 128 * 1024, windowBytes, maxChunkBytes: 64 * 1024 },
      channel: { bytesPerTick: 1024 * 1024, tickMs: 1, dropLowEventRate: 0.5 },
    });
    link.connect();
    const sink = new HashingSink();
    sink.writeDelayMs = 0;
    const size = 64 * 1024 * 1024;
    const { source, out, inc } = await sendAndAccept(link, size, sink);
    let peakQueue = 0;
    while (out.state !== 'completed') {
      peakQueue = Math.max(peakQueue, inc.queuedBytes);
      expect(out.sentOffset - out.ackedOffset).toBeLessThanOrEqual(windowBytes);
      if (out.terminal) throw new Error(`ended ${out.state} ${out.error?.code}`);
      await sleep(1);
    }
    expect(sink.digest()).toBe(source.sha256());
    expect(link.chanAtoB!.peakBuffered).toBeLessThanOrEqual(high + 64 * 1024 + 36);
    expect(peakQueue).toBeLessThanOrEqual(windowBytes);
    expect(source.maxReadLength).toBeLessThanOrEqual(64 * 1024);
  }, 60_000);

  it('detects corruption in transit and never reports completion', async () => {
    let n = 0;
    const link = new FakeLink({
      channel: {
        tamper: (f) => {
          if (++n === 3) f[f.length - 1]! ^= 0xff;
        },
      },
    });
    link.connect();
    const { out, inc, sink } = await sendAndAccept(link, 2_000_000);
    await waitFor(() => inc.terminal && out.terminal);
    expect(inc.state).toBe('failed');
    expect(inc.error?.code).toBe('INTEGRITY_MISMATCH');
    expect(out.state).toBe('failed');
    expect(out.error?.code).toBe('INTEGRITY_MISMATCH');
    expect(sink.finalized).toBe(false);
    expect(sink.aborted).toBe(true);
  });
});

describe('acceptance and capabilities', () => {
  it('rejection by the receiver ends both sides without payload', async () => {
    const link = new FakeLink();
    link.connect();
    const out = link.a.mgr.send(new DeterministicSource(1000), meta(1000));
    await waitFor(() => link.b.offers.length === 1);
    link.b.offers[0]!.reject();
    await waitFor(() => out.terminal);
    expect(out.state).toBe('rejected');
    expect(out.error).toMatchObject({ code: 'REJECTED_BY_USER', remote: true });
    expect(link.chanAtoB!.framesSent).toBe(0);
  });

  it('refuses files larger than the receiver can store before sending any payload', async () => {
    const link = new FakeLink({ capsB: { streamingSink: false, maxAcceptBytes: 1000 } });
    link.connect();
    const out = link.a.mgr.send(new DeterministicSource(1001), meta(1001));
    await waitFor(() => out.terminal);
    expect(out.state).toBe('failed');
    expect(out.error?.code).toBe('TOO_LARGE_FOR_SINK');
    expect(link.b.offers.length).toBe(0);
    expect(link.chanAtoB!.framesSent).toBe(0);
  });

  it('the receiver re-checks its own limit even if the sender ignores it', async () => {
    const link = new FakeLink({ capsB: { maxAcceptBytes: 1000 } });
    link.connect();
    link.a.mgr.setRemoteCapabilities({ ...link.b.caps, maxAcceptBytes: Number.MAX_SAFE_INTEGER }); // lying/stale caps
    const out = link.a.mgr.send(new DeterministicSource(5000), meta(5000));
    await waitFor(() => out.terminal);
    expect(out.error?.code).toBe('TOO_LARGE_FOR_SINK');
    expect(link.b.offers.length).toBe(0);
  });

  it('queues offers until the peer is connected and has advertised capabilities', async () => {
    const link = new FakeLink();
    const out = link.a.mgr.send(new DeterministicSource(10), meta(10));
    await sleep(20);
    expect(out.state).toBe('queued');
    link.connect();
    await waitFor(() => out.state === 'awaiting_acceptance');
  });

  it('times out unanswered offers', async () => {
    const link = new FakeLink({ config: { timings: { acceptTimeoutMs: 100, ackTimeoutMs: 30_000, verifyTimeoutMs: 1000, reconnectTimeoutMs: 1000 } } });
    link.connect();
    const out = link.a.mgr.send(new DeterministicSource(10), meta(10));
    await waitFor(() => out.terminal, 2000);
    expect(out.error?.code).toBe('ACCEPT_TIMEOUT');
    await waitFor(() => link.b.offers[0]!.terminal, 2000);
  });

  it('limits pending offers per peer', async () => {
    const link = new FakeLink({ config: { maxPendingOffers: 3 } });
    link.connect();
    const outs = Array.from({ length: 5 }, (_, i) => link.a.mgr.send(new DeterministicSource(10, i), meta(10)));
    await waitFor(() => outs.filter((o) => o.terminal).length === 2);
    expect(outs.slice(3).every((o) => o.error?.code === 'TOO_MANY_PENDING')).toBe(true);
    expect(link.b.offers.length).toBe(3);
  });

  it('reports a cancelled save dialog as a rejection', async () => {
    const link = new FakeLink();
    link.connect();
    const out = link.a.mgr.send(new DeterministicSource(10), meta(10));
    await waitFor(() => link.b.offers.length === 1);
    await link.b.mgr.accept(link.b.offers[0]!.id, () => Promise.reject(new DOMException('user cancelled', 'AbortError')));
    await waitFor(() => out.terminal);
    expect(out.state).toBe('rejected');
    expect(out.error?.code).toBe('SINK_CANCELLED');
  });
});

describe('pause, resume, cancel', () => {
  async function midTransfer(link: FakeLink, size = 20 * 1024 * 1024) {
    const sink = new HashingSink();
    const r = await sendAndAccept(link, size, sink);
    await waitFor(() => r.out.ackedOffset > 1024 * 1024, 5000, 'progress');
    return r;
  }

  it('pauses (sender stops reading) and resumes to a verified completion', async () => {
    const link = new FakeLink({ channel: { bytesPerTick: 256 * 1024 } });
    link.connect();
    const { source, out, inc, sink } = await midTransfer(link);
    out.pause();
    await waitFor(() => inc.state === 'paused');
    await sleep(30);
    const reads = source.reads;
    const sent = out.sentOffset;
    await sleep(100);
    expect(source.reads).toBe(reads);
    expect(out.sentOffset).toBe(sent);
    // In-flight data is still written and acknowledged while paused.
    await waitFor(() => out.ackedOffset === out.sentOffset);
    inc.resume(); // either side may resume
    await waitFor(() => out.state === 'completed', 20_000);
    expect(sink.digest()).toBe(source.sha256());
  }, 30_000);

  it('cancel by the sender stops promptly, aborts the sink, and informs the receiver', async () => {
    const link = new FakeLink({ channel: { bytesPerTick: 128 * 1024 } });
    link.connect();
    const { out, inc, sink, source } = await midTransfer(link);
    out.cancel();
    const reads = source.reads;
    await waitFor(() => inc.state === 'cancelled');
    expect(inc.error).toMatchObject({ code: 'CANCELLED_BY_SENDER', remote: true });
    await sleep(50);
    expect(source.reads).toBe(reads);
    expect(sink.aborted).toBe(true);
    expect(sink.finalized).toBe(false);
    expect(out.state).toBe('cancelled');
  });

  it('cancel by the receiver stops the sender', async () => {
    const link = new FakeLink({ channel: { bytesPerTick: 128 * 1024 } });
    link.connect();
    const { out, inc, sink } = await midTransfer(link);
    inc.cancel();
    await waitFor(() => out.state === 'cancelled');
    expect(out.error).toMatchObject({ code: 'CANCELLED_BY_RECEIVER', remote: true });
    expect(sink.aborted).toBe(true);
  });
});

describe('failures', () => {
  it('a receiver disk error fails both sides with the storage code', async () => {
    const link = new FakeLink();
    link.connect();
    const sink = new HashingSink();
    sink.failAt = 200_000;
    const { out, inc } = await sendAndAccept(link, 1_000_000, sink);
    await waitFor(() => out.terminal && inc.terminal);
    expect(inc.error?.code).toBe('QUOTA_EXCEEDED');
    expect(out.error).toMatchObject({ code: 'QUOTA_EXCEEDED', remote: true });
    expect(sink.aborted).toBe(true);
  });

  it('a source read error fails the transfer', async () => {
    const link = new FakeLink();
    link.connect();
    const source = new DeterministicSource(1_000_000);
    source.failAt = 300_000;
    const out = link.a.mgr.send(source, meta(1_000_000));
    await waitFor(() => link.b.offers.length === 1);
    await link.b.mgr.accept(link.b.offers[0]!.id, async () => new HashingSink());
    await waitFor(() => out.terminal);
    expect(out.error?.code).toBe('READ_FAILED');
    await waitFor(() => link.b.offers[0]!.terminal);
    expect(link.b.offers[0]!.error).toMatchObject({ code: 'READ_FAILED', remote: true });
  });

  it('fails with ACK_TIMEOUT when the receiver stops making progress', async () => {
    const link = new FakeLink({
      config: { windowBytes: 256 * 1024, timings: { acceptTimeoutMs: 10_000, ackTimeoutMs: 300, verifyTimeoutMs: 1000, reconnectTimeoutMs: 1000 } },
    });
    link.connect();
    const sink = new HashingSink();
    sink.hang = true;
    const { out } = await sendAndAccept(link, 5_000_000, sink);
    await waitFor(() => out.terminal, 5000);
    expect(out.error?.code).toBe('ACK_TIMEOUT');
    expect(out.sentOffset).toBeLessThanOrEqual(256 * 1024);
  });

  it('rejects frames at unexpected offsets', async () => {
    const link = new FakeLink();
    link.connect();
    const out = link.a.mgr.send(new DeterministicSource(100_000), meta(100_000));
    await waitFor(() => link.b.offers.length === 1);
    out.pause = () => undefined;
    const inc = link.b.offers[0]!;
    // Accept on the receiver, then inject a forged frame before real data arrives.
    await link.b.mgr.accept(inc.id, async () => new HashingSink());
    link.b.mgr.handleFrame(encodeDataFrame(transferIdToBytes(inc.id), 1, 5000, new Uint8Array(10)).buffer);
    expect(inc.state).toBe('failed');
    expect(inc.error?.code).toBe('INVALID_FRAME');
  });

  it('rejects frames past EOF and oversized frames', async () => {
    for (const [offset, len] of [
      [0, 100_001],
      [0, 70_000],
    ] as const) {
      const link = new FakeLink({ config: { maxChunkBytes: 65_536 } });
      link.connect();
      link.a.mgr.send(new DeterministicSource(100_000), meta(100_000));
      await waitFor(() => link.b.offers.length === 1);
      const inc = link.b.offers[0]!;
      await link.b.mgr.accept(inc.id, async () => new HashingSink());
      link.b.mgr.handleFrame(encodeDataFrame(transferIdToBytes(inc.id), 1, offset, new Uint8Array(len)).buffer);
      expect(inc.error?.code).toBe('INVALID_FRAME');
    }
  });

  it('ignores frames for unknown transfers and stale attempts', () => {
    const link = new FakeLink();
    link.connect();
    link.b.mgr.handleFrame(encodeDataFrame(transferIdToBytes('f'.repeat(32)), 1, 0, new Uint8Array(4)).buffer);
    expect(link.b.mgr.counters.unknownFrames).toBe(1);
  });

  it('ignores duplicate acks, accepts, and verifications; flags acks beyond sent data', async () => {
    const link = new FakeLink();
    link.connect();
    const { out, inc } = await sendAndAccept(link, 200_000);
    await waitFor(() => out.state === 'completed');
    const before = out.snapshot();
    out.handle({ v: PROTOCOL_VERSION, type: 'transfer:verified', id: out.id, sha256: out.sha256! });
    out.handle({ v: PROTOCOL_VERSION, type: 'transfer:accept', id: out.id, attempt: 1, sink: 'streaming', windowBytes: 1 << 20, chunkBytes: 1 << 16 });
    out.handle({ v: PROTOCOL_VERSION, type: 'transfer:ack', id: out.id, attempt: 1, offset: 5 });
    expect(out.snapshot()).toEqual(before);
    expect(inc.state).toBe('completed');

    const link2 = new FakeLink({ channel: { bytesPerTick: 64 * 1024 } });
    link2.connect();
    const r2 = await sendAndAccept(link2, 10_000_000);
    await waitFor(() => r2.out.sentOffset > 0);
    r2.out.handle({ v: PROTOCOL_VERSION, type: 'transfer:ack', id: r2.out.id, attempt: 1, offset: r2.out.sentOffset + 1 });
    expect(r2.out.error?.code).toBe('PROTOCOL_VIOLATION');
  });

  it('peer departure fails active transfers on both sides', async () => {
    const link = new FakeLink({ channel: { bytesPerTick: 64 * 1024 } });
    link.connect();
    const { out, inc } = await sendAndAccept(link, 10_000_000);
    await waitFor(() => out.sentOffset > 0);
    link.drop();
    link.a.mgr.peerGone();
    link.b.mgr.peerGone();
    expect(out.error?.code).toBe('PEER_LEFT');
    expect(inc.error?.code).toBe('PEER_LEFT');
  });

  it('rejects malformed control messages at the schema boundary', () => {
    expect(parsePeerMessage('{')).toEqual({ ok: false, reason: 'not_json' });
    expect(parsePeerMessage('x'.repeat(40_000))).toEqual({ ok: false, reason: 'too_large' });
    expect(parsePeerMessage(JSON.stringify({ v: 1, type: 'transfer:ack', id: 'a'.repeat(32), attempt: 1, offset: -1 })).ok).toBe(false);
    expect(parsePeerMessage(JSON.stringify({ v: 1, type: 'transfer:ack', id: 'a'.repeat(32), attempt: 1, offset: 2 ** 53 })).ok).toBe(false);
    expect(parsePeerMessage(JSON.stringify({ v: 1, type: 'transfer:offer', id: 'a'.repeat(32), name: 'x', size: 1, mime: '', hash: 'md5' })).ok).toBe(false);
    expect(parsePeerMessage(JSON.stringify({ v: 1, type: 'chat:message', id: 'a'.repeat(32), text: 'hi', sentAt: 1, extra: 1 })).ok).toBe(false);
    expect(parsePeerMessage(JSON.stringify({ v: 2, type: 'chat:ack', id: 'a'.repeat(32) })).ok).toBe(false);
    expect(parsePeerMessage(42)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('reconnect recovery (same session)', () => {
  it('resumes from the receiver written offset with a new attempt and verifies', async () => {
    const link = new FakeLink({ channel: { bytesPerTick: 256 * 1024 } });
    link.connect();
    const { source, out, inc, sink } = await sendAndAccept(link, 16 * 1024 * 1024);
    await waitFor(() => out.ackedOffset > 4 * 1024 * 1024, 10_000);
    link.drop();
    expect(out.state).toBe('reconnecting');
    expect(inc.state).toBe('reconnecting');
    await sleep(50);
    link.connect();
    await waitFor(() => out.state === 'completed', 20_000);
    expect(inc.state).toBe('completed');
    expect(inc.attempt).toBe(2);
    expect(out.attempt).toBe(2);
    expect(sink.digest()).toBe(source.sha256());
    expect(link.a.history.get(out.id)).toContain('reconnecting');
  }, 30_000);

  it('survives repeated drops, including during the final phase', async () => {
    const link = new FakeLink({ channel: { bytesPerTick: 512 * 1024 } });
    link.connect();
    const { source, out, sink } = await sendAndAccept(link, 6 * 1024 * 1024);
    for (let i = 0; i < 3 && out.state !== 'completed'; i++) {
      await sleep(15);
      link.drop();
      await sleep(10);
      link.connect();
    }
    await waitFor(() => out.state === 'completed', 20_000);
    expect(sink.digest()).toBe(source.sha256());
  }, 30_000);

  it('completes when only the verification message was lost', async () => {
    const link = new FakeLink();
    link.connect();
    const { out, inc } = await sendAndAccept(link, 100_000);
    await waitFor(() => inc.state === 'finalizing' || inc.state === 'completed');
    // Lose everything in flight (including transfer:verified), then reconnect.
    link.drop();
    await sleep(10);
    link.connect();
    await waitFor(() => out.state === 'completed', 5000);
  });

  it('fails clearly when the connection does not come back in time', async () => {
    const link = new FakeLink({
      channel: { bytesPerTick: 64 * 1024 },
      config: { timings: { acceptTimeoutMs: 10_000, ackTimeoutMs: 10_000, verifyTimeoutMs: 10_000, reconnectTimeoutMs: 200 } },
    });
    link.connect();
    const { out, inc, sink } = await sendAndAccept(link, 10_000_000);
    await waitFor(() => out.sentOffset > 0);
    link.drop();
    await waitFor(() => out.terminal && inc.terminal, 3000);
    expect(out.error?.code).toBe('RECONNECT_TIMEOUT');
    expect(inc.error?.code).toBe('RECONNECT_TIMEOUT');
    expect(sink.aborted).toBe(true);
  });

  it('rejects a resume that claims more data than was ever sent', async () => {
    const link = new FakeLink({ channel: { bytesPerTick: 64 * 1024 } });
    link.connect();
    const { out } = await sendAndAccept(link, 10_000_000);
    await waitFor(() => out.sentOffset > 0);
    out.handle({ v: PROTOCOL_VERSION, type: 'transfer:resume-from', id: out.id, attempt: 5, offset: 9_000_000, size: 10_000_000 });
    expect(out.error?.code).toBe('RESUME_MISMATCH');
    const link2 = new FakeLink({ channel: { bytesPerTick: 64 * 1024 } });
    link2.connect();
    const r2 = await sendAndAccept(link2, 10_000_000);
    await waitFor(() => r2.out.sentOffset > 0);
    r2.out.handle({ v: PROTOCOL_VERSION, type: 'transfer:resume-from', id: r2.out.id, attempt: 5, offset: 0, size: 1 });
    expect(r2.out.error?.code).toBe('RESUME_MISMATCH');
  });
});

describe('multi-file queue', () => {
  it('limits concurrent data transfers; paused transfers release their slot', async () => {
    const link = new FakeLink({ concurrency: 1, channel: { bytesPerTick: 128 * 1024 } });
    link.connect();
    const sizes = [8_000_000, 300_000, 200_000];
    const outs: OutgoingTransfer[] = sizes.map((s, i) => link.a.mgr.send(new DeterministicSource(s, i), meta(s, `f${i}`)));
    await waitFor(() => link.b.offers.length === 3);
    const incs: IncomingTransfer[] = [...link.b.offers];
    for (const inc of incs) await link.b.mgr.accept(inc.id, async () => new HashingSink());
    await waitFor(() => outs[0]!.sentOffset > 0);
    await sleep(30);
    expect(outs[1]!.sentOffset).toBe(0); // waiting for the single slot
    outs[0]!.pause();
    await waitFor(() => outs[1]!.state === 'completed' && outs[2]!.state === 'completed', 10_000);
    expect(outs[0]!.state).toBe('paused');
    outs[0]!.resume();
    await waitFor(() => outs[0]!.state === 'completed', 20_000);
  }, 30_000);

  it('cancelling one file leaves the others running', async () => {
    const link = new FakeLink({ concurrency: 2, channel: { bytesPerTick: 128 * 1024 } });
    link.connect();
    const outs = [4_000_000, 4_000_000].map((s, i) => link.a.mgr.send(new DeterministicSource(s, i), meta(s)));
    await waitFor(() => link.b.offers.length === 2);
    for (const inc of [...link.b.offers]) await link.b.mgr.accept(inc.id, async () => new HashingSink());
    await waitFor(() => outs[0]!.sentOffset > 0);
    outs[0]!.cancel();
    await waitFor(() => outs[1]!.state === 'completed', 15_000);
    expect(outs[0]!.state).toBe('cancelled');
  }, 20_000);
});
