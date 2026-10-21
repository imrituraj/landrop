import { LIMITS, PROTOCOL_VERSION, type PeerMessageOf } from '@landrop/protocol';
import { BoundedSet, TokenBucket, randomId } from '@landrop/shared';

/**
 * Ephemeral one-to-one chat over the "chat" data channel.
 *
 * Status semantics (no "read" receipts exist):
 *   sending      queued locally or handed to the browser; no receipt yet
 *   delivered    the receiver's app acknowledged it (chat:ack)
 *   unconfirmed  no ack within the timeout; it MAY still have been delivered
 *   failed       the peer left before acknowledging
 * Retries reuse the message id, and the receiver de-duplicates by id, so a retry
 * never shows a message twice.
 *
 * Nothing is persisted: history lives in memory and is gone on reload.
 */

export type ChatStatus = 'sending' | 'delivered' | 'unconfirmed' | 'failed';

export interface ChatMessageView {
  id: string;
  direction: 'out' | 'in';
  text: string;
  /** Local time: send time for outgoing, receive time for incoming (remote clocks are untrusted). */
  at: number;
  status: ChatStatus | null;
}

export const CHAT_HISTORY_LIMIT = 500;
const ACK_TIMEOUT_MS = 8000;

export interface ChatDeps {
  send(peerId: string, raw: string): boolean;
  publish(peerId: string, messages: ChatMessageView[]): void;
}

export class ChatService {
  private readonly histories = new Map<string, ChatMessageView[]>();
  private readonly seen = new Map<string, BoundedSet<string>>();
  private readonly incomingLimit = new Map<string, TokenBucket>();
  private readonly outgoingLimit = new TokenBucket(20, 5);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deps: ChatDeps;

  constructor(deps: ChatDeps) {
    this.deps = deps;
  }

  history(peerId: string): ChatMessageView[] {
    return this.histories.get(peerId) ?? [];
  }

  private set(peerId: string, list: ChatMessageView[]): void {
    const bounded = list.length > CHAT_HISTORY_LIMIT ? list.slice(list.length - CHAT_HISTORY_LIMIT) : list;
    this.histories.set(peerId, bounded);
    this.deps.publish(peerId, bounded);
  }

  private patch(peerId: string, id: string, status: ChatStatus): void {
    const list = this.history(peerId);
    const i = list.findIndex((m) => m.id === id);
    if (i < 0 || list[i]!.status === status) return;
    if (list[i]!.status === 'delivered') return; // never downgrade
    const next = list.slice();
    next[i] = { ...list[i]!, status };
    this.set(peerId, next);
  }

  /** Returns an error string if the message was not accepted locally. */
  send(peerId: string, rawText: string): string | null {
    const text = rawText.replace(/\r\n/g, '\n');
    if (text.trim().length === 0) return 'Message is empty.';
    if (text.length > LIMITS.chatChars) return `Message is too long (max ${LIMITS.chatChars} characters).`;
    if (!this.outgoingLimit.tryTake()) return 'You are sending messages too quickly.';
    const msg: ChatMessageView = { id: randomId(), direction: 'out', text, at: Date.now(), status: 'sending' };
    this.set(peerId, [...this.history(peerId), msg]);
    this.transmit(peerId, msg);
    return null;
  }

  retry(peerId: string, id: string): void {
    const msg = this.history(peerId).find((m) => m.id === id && m.direction === 'out');
    if (!msg || msg.status === 'delivered') return;
    this.patch(peerId, id, 'sending');
    this.transmit(peerId, msg);
  }

  private transmit(peerId: string, msg: ChatMessageView): void {
    const raw = JSON.stringify({ v: PROTOCOL_VERSION, type: 'chat:message', id: msg.id, text: msg.text, sentAt: msg.at });
    this.deps.send(peerId, raw); // if the channel is down, it is re-sent when it reopens
    const old = this.timers.get(msg.id);
    if (old) clearTimeout(old);
    this.timers.set(
      msg.id,
      setTimeout(() => {
        this.timers.delete(msg.id);
        this.patch(peerId, msg.id, 'unconfirmed');
      }, ACK_TIMEOUT_MS),
    );
  }

  handle(peerId: string, msg: PeerMessageOf<'chat:message'> | PeerMessageOf<'chat:ack'>): void {
    if (msg.type === 'chat:ack') {
      const t = this.timers.get(msg.id);
      if (t) clearTimeout(t);
      this.timers.delete(msg.id);
      this.patch(peerId, msg.id, 'delivered'); // late acks still upgrade 'unconfirmed'
      return;
    }
    let bucket = this.incomingLimit.get(peerId);
    if (!bucket) {
      bucket = new TokenBucket(30, 5);
      this.incomingLimit.set(peerId, bucket);
    }
    let seen = this.seen.get(peerId);
    if (!seen) {
      seen = new BoundedSet(2000);
      this.seen.set(peerId, seen);
    }
    if (seen.has(msg.id)) {
      // Duplicate (sender retried): acknowledge again, do not display twice.
      this.ack(peerId, msg.id);
      return;
    }
    if (!bucket.tryTake()) return; // flood: drop without ack; sender sees "unconfirmed"
    seen.add(msg.id);
    this.set(peerId, [...this.history(peerId), { id: msg.id, direction: 'in', text: msg.text, at: Date.now(), status: null }]);
    this.ack(peerId, msg.id);
  }

  private ack(peerId: string, id: string): void {
    this.deps.send(peerId, JSON.stringify({ v: PROTOCOL_VERSION, type: 'chat:ack', id }));
  }

  /** Chat channel reopened: re-send everything still unacknowledged. */
  channelOpened(peerId: string): void {
    for (const m of this.history(peerId)) {
      if (m.direction === 'out' && (m.status === 'sending' || m.status === 'unconfirmed')) this.retry(peerId, m.id);
    }
  }

  peerGone(peerId: string): void {
    for (const m of this.history(peerId)) {
      if (m.direction === 'out' && (m.status === 'sending' || m.status === 'unconfirmed')) {
        const t = this.timers.get(m.id);
        if (t) clearTimeout(t);
        this.timers.delete(m.id);
        this.patch(peerId, m.id, 'failed');
      }
    }
  }

  clear(peerId: string): void {
    for (const m of this.history(peerId)) {
      const t = this.timers.get(m.id);
      if (t) clearTimeout(t);
      this.timers.delete(m.id);
    }
    this.set(peerId, []);
  }

  forget(peerId: string): void {
    this.clear(peerId);
    this.histories.delete(peerId);
    this.seen.delete(peerId);
    this.incomingLimit.delete(peerId);
  }
}
