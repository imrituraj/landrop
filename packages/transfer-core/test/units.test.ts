import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  ChannelClosedError,
  Condition,
  FRAME_HEADER_BYTES,
  MemorySink,
  RateMeter,
  Sha256Hasher,
  SinkError,
  SlotScheduler,
  TRANSFER_STATES,
  canTransition,
  decodeDataFrame,
  encodeDataFrame,
  isTerminal,
  transferIdToBytes,
  waitForSendRoom,
  type SendChannel,
} from '../src/index.ts';
import { sleep } from './harness.ts';

const ID = '0123456789abcdef0123456789abcdef';

describe('binary framing', () => {
  it('round-trips header fields including offsets above 2^32', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    for (const offset of [0, 1, 2 ** 32 - 1, 2 ** 32, 2 ** 40 + 7, Number.MAX_SAFE_INTEGER - 5]) {
      const f = encodeDataFrame(transferIdToBytes(ID), 3, offset, payload);
      expect(f.byteLength).toBe(FRAME_HEADER_BYTES + 5);
      const d = decodeDataFrame(f.buffer, 64);
      expect(d.ok).toBe(true);
      if (!d.ok) continue;
      expect(d.frame.transferId).toBe(ID);
      expect(d.frame.attempt).toBe(3);
      expect(d.frame.offset).toBe(offset);
      expect([...d.frame.payload]).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('uses big-endian byte order', () => {
    const f = encodeDataFrame(transferIdToBytes(ID), 0x01020304, 0x0a0b0c0d0e, new Uint8Array(2));
    expect([...f.slice(20, 24)]).toEqual([1, 2, 3, 4]);
    expect([...f.slice(24, 32)]).toEqual([0, 0, 0, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e]);
    expect([...f.slice(32, 36)]).toEqual([0, 0, 0, 2]);
  });

  it('rejects malformed frames before exposing payload', () => {
    const good = encodeDataFrame(transferIdToBytes(ID), 1, 0, new Uint8Array(10));
    const mutate = (fn: (v: DataView) => void, buf: Uint8Array = good) => {
      const copy = buf.slice();
      fn(new DataView(copy.buffer));
      return decodeDataFrame(copy.buffer, 64);
    };
    expect(decodeDataFrame(new ArrayBuffer(10), 64)).toMatchObject({ ok: false, reason: 'short frame' });
    expect(mutate((v) => v.setUint8(0, 2))).toMatchObject({ ok: false, reason: 'unsupported frame version' });
    expect(mutate((v) => v.setUint8(1, 9))).toMatchObject({ ok: false, reason: 'unknown frame type' });
    expect(mutate((v) => v.setUint16(2, 1))).toMatchObject({ ok: false, reason: 'reserved bits set' });
    expect(mutate((v) => v.setUint32(20, 0))).toMatchObject({ ok: false, reason: 'bad attempt' });
    expect(mutate((v) => v.setUint32(24, 2 ** 21))).toMatchObject({ ok: false, reason: 'offset out of safe range' });
    expect(mutate((v) => v.setUint32(32, 11))).toMatchObject({ ok: false, reason: 'length mismatch' });
    expect(mutate((v) => v.setUint32(32, 1_000_000_000))).toMatchObject({ ok: false, reason: 'length mismatch' });
    expect(decodeDataFrame(good.buffer, 9)).toMatchObject({ ok: false, reason: 'payload exceeds negotiated chunk size' });
    const empty = encodeDataFrame(transferIdToBytes(ID), 1, 0, new Uint8Array(0));
    expect(decodeDataFrame(empty.buffer, 64)).toMatchObject({ ok: false, reason: 'empty payload' });
    const nearMax = encodeDataFrame(transferIdToBytes(ID), 1, Number.MAX_SAFE_INTEGER - 1, new Uint8Array(10));
    expect(decodeDataFrame(nearMax.buffer, 64)).toMatchObject({ ok: false, reason: 'end offset out of safe range' });
  });

  it('refuses to encode unsafe offsets or bad ids', () => {
    expect(() => encodeDataFrame(transferIdToBytes(ID), 1, 2 ** 53, new Uint8Array(1))).toThrow(RangeError);
    expect(() => encodeDataFrame(transferIdToBytes(ID), 1, -1, new Uint8Array(1))).toThrow(RangeError);
    expect(() => transferIdToBytes('xyz')).toThrow(RangeError);
  });
});

describe('state machine', () => {
  it('has terminal states with no outgoing transitions', () => {
    for (const s of TRANSFER_STATES) {
      if (!isTerminal(s)) continue;
      for (const to of TRANSFER_STATES) {
        expect(canTransition('sender', s, to)).toBe(false);
        expect(canTransition('receiver', s, to)).toBe(false);
      }
    }
  });

  it('allows completion only from the right states', () => {
    expect(canTransition('sender', 'transferring', 'completed')).toBe(false);
    expect(canTransition('sender', 'verifying', 'completed')).toBe(true);
    expect(canTransition('receiver', 'verifying', 'completed')).toBe(false);
    expect(canTransition('receiver', 'finalizing', 'completed')).toBe(true);
    expect(canTransition('receiver', 'awaiting_acceptance', 'transferring')).toBe(false);
    expect(canTransition('sender', 'queued', 'transferring')).toBe(false);
  });

  it('lets every non-terminal state be cancelled except receiver finalizing', () => {
    for (const s of TRANSFER_STATES) {
      if (isTerminal(s)) continue;
      if (canTransition('sender', s, 'failed')) expect(canTransition('sender', s, 'cancelled')).toBe(true);
    }
    expect(canTransition('receiver', 'finalizing', 'cancelled')).toBe(false);
  });
});

class ManualChannel implements SendChannel {
  bufferedAmount = 0;
  open = true;
  listeners = new Set<() => void>();
  isOpen() {
    return this.open;
  }
  send(f: Uint8Array) {
    this.bufferedAmount += f.byteLength;
  }
  onLow(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  fire() {
    for (const l of [...this.listeners]) l();
  }
}

describe('backpressure primitives', () => {
  it('resolves immediately below the high-water mark', async () => {
    const ch = new ManualChannel();
    await waitForSendRoom(ch, 100);
  });

  it('wakes on the low event', async () => {
    const ch = new ManualChannel();
    ch.bufferedAmount = 500;
    let done = false;
    const p = waitForSendRoom(ch, 100).then(() => (done = true));
    await sleep(5);
    expect(done).toBe(false);
    ch.bufferedAmount = 50;
    ch.fire();
    await p;
    expect(ch.listeners.size).toBe(0);
  });

  it('does not lose a wakeup when the event never fires (drained silently)', async () => {
    const ch = new ManualChannel();
    ch.bufferedAmount = 500;
    const p = waitForSendRoom(ch, 100);
    ch.bufferedAmount = 0; // drained without an event
    await p; // resolved by the safety-net poll
  });

  it('rejects when the channel closes or the operation is aborted', async () => {
    const ch = new ManualChannel();
    ch.bufferedAmount = 500;
    const p = waitForSendRoom(ch, 100);
    ch.open = false;
    await expect(p).rejects.toBeInstanceOf(ChannelClosedError);
    const ac = new AbortController();
    const ch2 = new ManualChannel();
    ch2.bufferedAmount = 500;
    const p2 = waitForSendRoom(ch2, 100, ac.signal);
    ac.abort();
    await expect(p2).rejects.toBeInstanceOf(AbortedError);
    expect(ch2.listeners.size).toBe(0);
  });

  it('Condition checks the predicate synchronously so a prior notify is not lost', async () => {
    const c = new Condition();
    let x = 0;
    x = 1;
    c.notify(); // nobody waiting yet
    await c.wait(() => x === 1); // must not hang
    const p = c.wait(() => x === 2);
    x = 2;
    c.notify();
    await p;
    expect(c.waiting).toBe(0);
  });

  it('SlotScheduler grants FIFO up to the limit and skips aborted waiters', async () => {
    const s = new SlotScheduler(1);
    const a = {}, b = {}, c = {};
    await s.acquire(a);
    const order: string[] = [];
    const ac = new AbortController();
    const pb = s.acquire(b, ac.signal).then(() => order.push('b'), () => order.push('b-aborted'));
    const pc = s.acquire(c).then(() => order.push('c'));
    ac.abort();
    await pb;
    s.release(a);
    await pc;
    expect(order).toEqual(['b-aborted', 'c']);
    expect(s.holds(c)).toBe(true);
    s.setLimit(3);
    await s.acquire(a);
    expect(s.active).toBe(2);
  });

  it('RateMeter smooths throughput', () => {
    const m = new RateMeter(1000);
    m.reset(0, 0);
    let r = 0;
    for (let t = 200; t <= 5000; t += 200) r = m.sample(t * 1000, t); // 1 MB/s
    expect(r).toBeGreaterThan(950_000);
    expect(r).toBeLessThan(1_050_000);
  });
});

describe('incremental hashing', () => {
  it('matches a one-shot SHA-256 for arbitrary chunking', async () => {
    const data = randomBytes(1_000_003);
    const h = new Sha256Hasher();
    let off = 0;
    let step = 1;
    while (off < data.length) {
      const len = Math.min(step, data.length - off);
      h.update(data.subarray(off, off + len));
      off += len;
      step = (step * 7 + 13) % 65_537;
    }
    expect(await h.digest()).toBe(createHash('sha256').update(data).digest('hex'));
  });

  it('hashes the empty input', async () => {
    expect(await new Sha256Hasher().digest()).toBe(createHash('sha256').digest('hex'));
  });
});

describe('memory sink', () => {
  it('refuses files above its limit before any write', () => {
    expect(() => new MemorySink(11, 10)).toThrow(SinkError);
  });

  it('requires sequential writes and produces a Blob on finalize', async () => {
    const s = new MemorySink(6, 100, 'text/plain');
    await s.write(0, new Uint8Array([104, 105]));
    await expect(s.write(5, new Uint8Array([1]))).rejects.toThrow(/non-sequential/);
    await s.write(2, new TextEncoder().encode('!!!!'));
    await expect(s.write(6, new Uint8Array([1]))).rejects.toThrow(/past expected size/);
    await s.finalize();
    expect(await s.result()!.text()).toBe('hi!!!!');
  });

  it('copies data so callers may reuse buffers', async () => {
    const s = new MemorySink(3, 10);
    const buf = new Uint8Array([1, 2, 3]);
    await s.write(0, buf);
    buf.fill(0);
    await s.finalize();
    expect([...new Uint8Array(await s.result()!.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
