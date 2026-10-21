import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@landrop/protocol';
import { ChatService, type ChatMessageView } from '../src/core/chat.ts';
import { parseInvite } from '../src/core/controller.ts';
import { CandidateBuffer, classifyRoute } from '../src/core/stats.ts';

const ID = 'a'.repeat(32);
const SECRET = 'b'.repeat(43);

describe('invite parsing', () => {
  it('accepts full links and bare fragments', () => {
    expect(parseInvite(`https://landrop.lan:8443/#join=${ID}.${SECRET}`)).toEqual({ roomId: ID, secret: SECRET });
    expect(parseInvite(`#join=${ID}.${SECRET}`)).toEqual({ roomId: ID, secret: SECRET });
  });

  it('rejects malformed or truncated invitations', () => {
    expect(parseInvite(`#join=${ID}.${SECRET.slice(1)}`)).toBeNull();
    expect(parseInvite(`#join=${ID.toUpperCase()}.${SECRET}`)).toBeNull();
    expect(parseInvite(`#join=${ID}.${SECRET}x`)).toBeNull();
    expect(parseInvite('https://example.com/?join=abc')).toBeNull();
    expect(parseInvite('7KQ2-M9XD')).toBeNull();
  });
});

describe('route classification from getStats()', () => {
  const report = (entries: Array<[string, Record<string, unknown>]>) => new Map(entries);

  it('uses transport.selectedCandidatePairId', () => {
    const r = classifyRoute(
      report([
        ['T', { type: 'transport', selectedCandidatePairId: 'P' }],
        ['P', { type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.004, bytesSent: 10, bytesReceived: 20 }],
        ['L', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
        ['R', { type: 'remote-candidate', candidateType: 'host' }],
        // A relay pair exists but is not selected: must not affect the result.
        ['P2', { type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R', nominated: true, state: 'succeeded' }],
        ['L2', { type: 'local-candidate', candidateType: 'relay' }],
      ]),
    );
    expect(r).toMatchObject({ route: 'direct', localType: 'host', remoteType: 'host', protocol: 'udp', rttMs: 4, bytesSent: 10 });
  });

  it('reports relay when either selected candidate is a relay', () => {
    const r = classifyRoute(
      report([
        ['P', { type: 'candidate-pair', selected: true, localCandidateId: 'L', remoteCandidateId: 'R' }],
        ['L', { type: 'local-candidate', candidateType: 'srflx' }],
        ['R', { type: 'remote-candidate', candidateType: 'relay' }],
      ]),
    );
    expect(r.route).toBe('relay');
  });

  it('returns unknown when nothing is selected or fields are missing', () => {
    expect(classifyRoute(report([['P', { type: 'candidate-pair', state: 'in-progress' }]])).route).toBe('unknown');
    expect(
      classifyRoute(report([['P', { type: 'candidate-pair', selected: true, localCandidateId: 'missing', remoteCandidateId: 'missing' }]])).route,
    ).toBe('unknown');
  });
});

describe('ICE candidate buffer', () => {
  it('buffers until drained and bounds its size', () => {
    const b = new CandidateBuffer<number>(3);
    for (let i = 0; i < 5; i++) b.push(i);
    expect(b.size).toBe(3);
    expect(b.dropped).toBe(2);
    expect(b.drain()).toEqual([0, 1, 2]);
    expect(b.size).toBe(0);
  });
});

describe('chat delivery semantics', () => {
  let sent: Array<{ peer: string; msg: Record<string, unknown> }>;
  let published: Record<string, ChatMessageView[]>;
  let channelUp: boolean;
  let chat: ChatService;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    published = {};
    channelUp = true;
    chat = new ChatService({
      send: (peer, raw) => {
        if (!channelUp) return false;
        sent.push({ peer, msg: JSON.parse(raw) as Record<string, unknown> });
        return true;
      },
      publish: (peer, list) => {
        published[peer] = list;
      },
    });
  });
  afterEach(() => vi.useRealTimers());

  const status = () => published['p']!.at(-1)!.status;

  it('is "sending" until the receiver acknowledges, then "delivered"', () => {
    expect(chat.send('p', 'hi')).toBeNull();
    expect(status()).toBe('sending');
    const id = sent[0]!.msg['id'] as string;
    chat.handle('p', { v: PROTOCOL_VERSION, type: 'chat:ack', id });
    expect(status()).toBe('delivered');
  });

  it('becomes "unconfirmed" without an ack and accepts a late ack', () => {
    chat.send('p', 'hi');
    vi.advanceTimersByTime(9000);
    expect(status()).toBe('unconfirmed');
    chat.handle('p', { v: PROTOCOL_VERSION, type: 'chat:ack', id: sent[0]!.msg['id'] as string });
    expect(status()).toBe('delivered');
  });

  it('retries with the same id; the receiver shows it once and re-acks', () => {
    const receiver = new ChatService({ send: (peer, raw) => (sent.push({ peer, msg: JSON.parse(raw) }), true), publish: (peer, l) => (published[`r-${peer}`] = l) });
    chat.send('p', 'once');
    const msg = sent[0]!.msg;
    chat.retry('p', msg['id'] as string);
    expect(sent[1]!.msg['id']).toBe(msg['id']);
    const asMessage = { v: PROTOCOL_VERSION, type: 'chat:message' as const, id: msg['id'] as string, text: 'once', sentAt: 1 };
    receiver.handle('a', asMessage);
    receiver.handle('a', asMessage);
    expect(published['r-a']!.length).toBe(1);
    expect(sent.filter((s) => s.msg['type'] === 'chat:ack').length).toBe(2);
  });

  it('re-sends pending messages when the channel reopens and fails them if the peer leaves', () => {
    channelUp = false;
    chat.send('p', 'queued');
    expect(sent.length).toBe(0);
    channelUp = true;
    chat.channelOpened('p');
    expect(sent.length).toBe(1);
    chat.peerGone('p');
    expect(status()).toBe('failed');
  });

  it('validates length and rate', () => {
    expect(chat.send('p', '   ')).toMatch(/empty/);
    expect(chat.send('p', 'x'.repeat(4001))).toMatch(/too long/);
    let limited = false;
    for (let i = 0; i < 40; i++) if (chat.send('p', `m${i}`)) limited = true;
    expect(limited).toBe(true);
  });

  it('drops floods from a peer without acknowledging them', () => {
    for (let i = 0; i < 100; i++) {
      chat.handle('p', { v: PROTOCOL_VERSION, type: 'chat:message', id: i.toString(16).padStart(32, '0'), text: 'x', sentAt: 0 });
    }
    const accepted = published['p']!.length;
    expect(accepted).toBeLessThan(100);
    expect(sent.filter((s) => s.msg['type'] === 'chat:ack').length).toBe(accepted);
  });

  it('keeps history bounded', () => {
    for (let i = 0; i < 600; i++) {
      vi.advanceTimersByTime(1000);
      chat.handle('p', { v: PROTOCOL_VERSION, type: 'chat:message', id: i.toString(16).padStart(32, '0'), text: 'x', sentAt: 0 });
    }
    expect(published['p']!.length).toBe(500);
  });
});
