import type { ClientMessageBody, ServerMessage } from '@landrop/protocol';
import { log, tag } from './log.ts';
import { CandidateBuffer, classifyRoute, type RouteInfo } from './stats.ts';

/**
 * One WebRTC connection to one remote peer, independent of React.
 *
 * Negotiation: "perfect negotiation" (W3C WebRTC spec example). The peer with the
 * lexicographically smaller peerId is the *controller* (impolite); the other is
 * polite and rolls back on offer collisions.
 *
 * Generations: every RTCPeerConnection has a generation number `gen` carried in
 * every signal. A side that rebuilds the connection uses gen+1; receiving a
 * higher gen makes the other side rebuild too; lower gens are stale and dropped.
 * The controller rebuilds on timeouts; either side may rebuild on manual retry.
 *
 * Channels: only the controller creates them (in-band, reliable and ordered),
 * so only the controller produces offers for a new connection and the initial
 * handshake has no glare. The other side accepts exactly these three labels
 * via ondatachannel and closes anything else:
 *   "control" – JSON (capabilities, transfer control)
 *   "chat"    – JSON (chat messages and acks)
 *   "file"    – binary frames
 * Perfect negotiation still guards renegotiations (e.g. ICE restarts).
 * Separate channels share one SCTP association, so they do NOT have independent
 * congestion control; the file sender keeps its queue short (see transfer-core)
 * so chat and control are not stuck behind megabytes of file data.
 */

export type LinkState = 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'closed';

type SignalIn = Extract<ServerMessage, { type: 'signal:offer' | 'signal:answer' | 'signal:ice' }>;

export interface LinkCallbacks {
  sendSignal(body: ClientMessageBody): void;
  /** State, route, or diagnostics changed. */
  onChange(link: PeerLink): void;
  /** All three channels opened for a new generation. */
  onOpen(link: PeerLink): void;
  /** Channels of a previously open generation closed. */
  onClose(link: PeerLink): void;
  onControl(link: PeerLink, raw: string): void;
  onChat(link: PeerLink, raw: string): void;
  onBinary(link: PeerLink, data: ArrayBuffer): void;
}

export interface LinkDiagnostics {
  gen: number;
  connectionState: RTCPeerConnectionState | 'new';
  iceConnectionState: RTCIceConnectionState | 'new';
  signalingState: RTCSignalingState;
  iceRestarts: number;
  rebuilds: number;
  bufferedCandidatesDropped: number;
  routeInfo: RouteInfo | null;
}

export interface LinkTimings {
  connectTimeoutMs: number;
  disconnectedGraceMs: number;
  maxAttempts: number;
  statsIntervalMs: number;
}

export const DEFAULT_LINK_TIMINGS: LinkTimings = {
  connectTimeoutMs: 15_000,
  disconnectedGraceMs: 4_000,
  maxAttempts: 4,
  statsIntervalMs: 2_000,
};

export class PeerLink {
  readonly remoteId: string;
  readonly controller: boolean;
  state: LinkState = 'connecting';
  /** Remote max SCTP message size (bytes), 0 if unknown. */
  maxMessageSize = 0;
  control: RTCDataChannel | null = null;
  chat: RTCDataChannel | null = null;
  file: RTCDataChannel | null = null;
  diag: LinkDiagnostics;

  private pc: RTCPeerConnection | null = null;
  private gen = 0;
  private makingOffer = false;
  private ignoreOffer = false;
  private candidates = new CandidateBuffer<RTCIceCandidateInit>(100);
  private channelsOpen = false;
  private failures = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private signalQueue: Promise<void> = Promise.resolve();
  private readonly iceServers: RTCIceServer[];
  private readonly cb: LinkCallbacks;
  private readonly timings: LinkTimings;

  constructor(
    localId: string,
    remoteId: string,
    iceServers: RTCIceServer[],
    cb: LinkCallbacks,
    timings: LinkTimings = DEFAULT_LINK_TIMINGS,
  ) {
    this.remoteId = remoteId;
    this.controller = localId < remoteId;
    this.iceServers = iceServers;
    this.cb = cb;
    this.timings = timings;
    this.diag = {
      gen: 0,
      connectionState: 'new',
      iceConnectionState: 'new',
      signalingState: 'stable',
      iceRestarts: 0,
      rebuilds: 0,
      bufferedCandidatesDropped: 0,
      routeInfo: null,
    };
    this.build(1);
  }

  get generation(): number {
    return this.gen;
  }

  get isOpen(): boolean {
    return this.channelsOpen;
  }

  /** Remote peer's connection is gone for good (left the room) or we are leaving. */
  close(): void {
    this.teardown();
    this.setState('closed');
  }

  /** Manual retry after 'unavailable', or when the remote comes back online. */
  retry(): void {
    if (this.state === 'closed') return;
    this.failures = 0;
    log.info(`link ${tag(this.remoteId)}: manual rebuild`);
    this.build(this.gen + 1, true);
  }

  handleSignal(msg: SignalIn): void {
    // Serialize: an ICE candidate must not race the offer that precedes it.
    this.signalQueue = this.signalQueue.then(() => this.processSignal(msg)).catch((err: unknown) => {
      log.warn(`link ${tag(this.remoteId)}: signal handling failed: ${(err as Error).name}`);
    });
  }

  // ---------------------------------------------------------------------------

  private setState(s: LinkState): void {
    if (this.state === s) return;
    this.state = s;
    log.info(`link ${tag(this.remoteId)}: ${s} (gen ${this.gen})`);
    this.cb.onChange(this);
  }

  private teardown(): void {
    this.clearTimers();
    const wasOpen = this.channelsOpen;
    this.channelsOpen = false;
    const pc = this.pc;
    this.pc = null;
    for (const ch of [this.control, this.chat, this.file]) {
      if (ch) {
        ch.onopen = ch.onclose = ch.onmessage = ch.onerror = ch.onbufferedamountlow = null;
      }
    }
    if (pc) {
      pc.onnegotiationneeded = pc.onicecandidate = pc.oniceconnectionstatechange = pc.onconnectionstatechange = null;
      pc.onsignalingstatechange = null;
      pc.close();
    }
    if (wasOpen) this.cb.onClose(this);
  }

  private clearTimers(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.connectTimer = this.disconnectTimer = this.statsTimer = null;
  }

  private build(gen: number, nudge = false): void {
    this.teardown();
    if (gen > 1) this.diag.rebuilds++;
    this.gen = gen;
    this.diag.gen = gen;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.candidates = new CandidateBuffer<RTCIceCandidateInit>(100);
    this.maxMessageSize = 0;
    this.diag.routeInfo = null;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    const current = () => this.pc === pc;

    const setup = (ch: RTCDataChannel, label: 'control' | 'chat' | 'file') => {
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => {
        log.debug(`link ${tag(this.remoteId)}: channel ${label} open`);
        if (current()) this.checkOpen();
      };
      ch.onclose = () => current() && this.onChannelClosed(label);
      ch.onerror = () => current() && log.warn(`link ${tag(this.remoteId)}: channel ${label} error`);
      if (label === 'file') {
        ch.onmessage = (e: MessageEvent) => {
          if (current() && e.data instanceof ArrayBuffer) this.cb.onBinary(this, e.data);
        };
      } else {
        ch.onmessage = (e: MessageEvent) => {
          if (!current() || typeof e.data !== 'string') return;
          if (label === 'control') this.cb.onControl(this, e.data);
          else this.cb.onChat(this, e.data);
        };
      }
      this[label] = ch;
    };

    if (this.controller) {
      // Only the controller creates channels, so only it fires negotiationneeded:
      // no offer glare on the initial connection.
      for (const label of ['control', 'chat', 'file'] as const) setup(pc.createDataChannel(label, { ordered: true }), label);
    } else {
      this.control = this.chat = this.file = null;
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        if (!current()) return;
        const label = ch.label;
        const reliable = ch.ordered && ch.maxRetransmits === null && ch.maxPacketLifeTime === null;
        // Accept exactly our three reliable, ordered channels; anything else from the peer is closed.
        if ((label === 'control' || label === 'chat' || label === 'file') && reliable && this[label] === null) setup(ch, label);
        else {
          log.warn(`link ${tag(this.remoteId)}: unexpected data channel rejected`);
          ch.close();
        }
      };
    }

    pc.onnegotiationneeded = async () => {
      if (!current()) return;
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (!current() || !pc.localDescription) return;
        log.debug(`link ${tag(this.remoteId)}: send offer gen ${gen}`);
        this.cb.sendSignal({ type: 'signal:offer', to: this.remoteId, gen, sdp: pc.localDescription.sdp });
      } catch (err) {
        log.warn(`link ${tag(this.remoteId)}: createOffer failed: ${(err as Error).name}`);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicegatheringstatechange = () => log.debug(`link ${tag(this.remoteId)}: gathering ${pc.iceGatheringState}`);
    pc.onicecandidate = (e) => {
      log.debug(`link ${tag(this.remoteId)}: local candidate ${e.candidate ? (e.candidate.type ?? '?') : 'end'}`);
      if (!current() || !e.candidate) return;
      const c = e.candidate.toJSON();
      this.cb.sendSignal({
        type: 'signal:ice',
        to: this.remoteId,
        gen,
        candidate: {
          candidate: c.candidate ?? '',
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
          usernameFragment: c.usernameFragment ?? null,
        },
      });
    };
    pc.oniceconnectionstatechange = () => {
      if (!current()) return;
      this.diag.iceConnectionState = pc.iceConnectionState;
      log.debug(`link ${tag(this.remoteId)}: ice ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') this.restartIce('ice failed');
      this.cb.onChange(this);
    };
    pc.onsignalingstatechange = () => {
      if (current()) this.diag.signalingState = pc.signalingState;
    };
    pc.onconnectionstatechange = () => {
      if (!current()) return;
      this.diag.connectionState = pc.connectionState;
      log.debug(`link ${tag(this.remoteId)}: connection ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected') {
        if (this.state === 'connected') this.setState('reconnecting');
        if (!this.disconnectTimer) {
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = null;
            if (current() && pc.connectionState === 'disconnected') this.restartIce('disconnected too long');
          }, this.timings.disconnectedGraceMs);
        }
      } else if (pc.connectionState === 'failed') {
        if (this.state === 'connected') this.setState('reconnecting');
        this.restartIce('connection failed');
      } else if (pc.connectionState === 'connected') {
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        if (this.channelsOpen) this.setState('connected');
      }
      this.cb.onChange(this);
    };

    this.setState(this.state === 'connected' || this.state === 'reconnecting' ? 'reconnecting' : 'connecting');
    this.armConnectTimer();
    if (nudge && !this.controller) {
      // The non-controller cannot offer (it has no channels); an empty ICE signal
      // carrying the new generation asks the controller to rebuild and offer.
      this.cb.sendSignal({ type: 'signal:ice', to: this.remoteId, gen, candidate: null });
    }
  }

  private armConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    const pc = this.pc;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.pc !== pc || this.channelsOpen) return;
      this.failures++;
      log.warn(`link ${tag(this.remoteId)}: connect timeout (attempt ${this.failures})`);
      if (this.failures >= this.timings.maxAttempts) {
        this.teardown();
        this.setState('unavailable');
        return;
      }
      if (this.controller) this.build(this.gen + 1);
      else this.armConnectTimer(); // the controller drives rebuilds
    }, this.timings.connectTimeoutMs);
  }

  private restartIce(reason: string): void {
    const pc = this.pc;
    if (!pc) return;
    if (!this.controller) {
      // The controller drives ICE restarts; we just keep the timeout armed.
      this.armConnectTimer();
      return;
    }
    log.info(`link ${tag(this.remoteId)}: ICE restart (${reason})`);
    this.diag.iceRestarts++;
    pc.restartIce(); // triggers negotiationneeded -> new offer with fresh ICE credentials
    this.armConnectTimer();
  }

  private checkOpen(): void {
    if (this.channelsOpen) return;
    if (this.control?.readyState !== 'open' || this.chat?.readyState !== 'open' || this.file?.readyState !== 'open') return;
    this.channelsOpen = true;
    this.failures = 0;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.maxMessageSize = this.pc?.sctp?.maxMessageSize ?? 0;
    this.setState('connected');
    this.startStats();
    this.cb.onOpen(this);
  }

  private onChannelClosed(label: string): void {
    log.warn(`link ${tag(this.remoteId)}: channel ${label} closed`);
    if (!this.channelsOpen) return;
    // A closed channel means the SCTP association is gone; build a new generation.
    this.teardown();
    this.setState('reconnecting');
    if (this.controller) this.build(this.gen + 1);
    else this.armWaitForController();
  }

  /** Non-controller after channel loss: wait for the controller's new generation, then give up. */
  private armWaitForController(): void {
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.pc) return; // a new generation arrived
      this.failures++;
      if (this.failures >= this.timings.maxAttempts) this.setState('unavailable');
      else this.build(this.gen + 1, true);
    }, this.timings.connectTimeoutMs);
  }

  private startStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    const pc = this.pc;
    const poll = async () => {
      if (!pc || this.pc !== pc) return;
      try {
        const report = await pc.getStats();
        if (this.pc !== pc) return;
        this.diag.routeInfo = classifyRoute(report);
        this.diag.bufferedCandidatesDropped = this.candidates.dropped;
        this.cb.onChange(this);
      } catch {
        // getStats can reject while closing; ignore.
      }
    };
    void poll();
    this.statsTimer = setInterval(() => void poll(), this.timings.statsIntervalMs);
  }

  private async processSignal(msg: SignalIn): Promise<void> {
    log.debug(`link ${tag(this.remoteId)}: recv ${msg.type} gen ${msg.gen} (local gen ${this.gen}, ${this.pc?.signalingState ?? 'no pc'})`);
    if (this.state === 'closed') return;
    if (msg.gen < this.gen) return; // stale generation
    if (msg.gen > this.gen || !this.pc) {
      log.info(`link ${tag(this.remoteId)}: remote started gen ${msg.gen}`);
      this.build(msg.gen);
    }
    const pc = this.pc;
    if (!pc) return;

    if (msg.type === 'signal:ice') {
      if (!msg.candidate) return;
      const init: RTCIceCandidateInit = {
        candidate: msg.candidate.candidate,
        sdpMid: msg.candidate.sdpMid ?? null,
        sdpMLineIndex: msg.candidate.sdpMLineIndex ?? null,
        ...(msg.candidate.usernameFragment ? { usernameFragment: msg.candidate.usernameFragment } : {}),
      };
      if (!pc.remoteDescription) {
        this.candidates.push(init);
        return;
      }
      try {
        await pc.addIceCandidate(init);
      } catch (err) {
        if (!this.ignoreOffer) log.debug(`link ${tag(this.remoteId)}: addIceCandidate failed: ${(err as Error).name}`);
      }
      return;
    }

    const description: RTCSessionDescriptionInit = {
      type: msg.type === 'signal:offer' ? 'offer' : 'answer',
      sdp: msg.sdp,
    };
    const offerCollision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = this.controller && offerCollision;
    if (this.ignoreOffer) {
      log.debug(`link ${tag(this.remoteId)}: ignoring colliding offer (impolite)`);
      return;
    }
    if (description.type === 'answer' && pc.signalingState !== 'have-local-offer') {
      log.debug(`link ${tag(this.remoteId)}: ignoring unexpected answer`);
      return;
    }
    await pc.setRemoteDescription(description); // polite side rolls back implicitly on collision
    if (this.pc !== pc) return;
    for (const c of this.candidates.drain()) {
      try {
        await pc.addIceCandidate(c);
      } catch (err) {
        log.debug(`link ${tag(this.remoteId)}: buffered candidate failed: ${(err as Error).name}`);
      }
    }
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      if (this.pc !== pc || !pc.localDescription) return;
      this.cb.sendSignal({ type: 'signal:answer', to: this.remoteId, gen: this.gen, sdp: pc.localDescription.sdp });
    }
  }

  // ---------------------------------------------------------------------------
  // Sending helpers

  sendControl(raw: string): boolean {
    if (!this.channelsOpen || this.control?.readyState !== 'open') return false;
    try {
      this.control.send(raw);
      return true;
    } catch {
      return false;
    }
  }

  sendChat(raw: string): boolean {
    if (!this.channelsOpen || this.chat?.readyState !== 'open') return false;
    try {
      this.chat.send(raw);
      return true;
    } catch {
      return false;
    }
  }
}
