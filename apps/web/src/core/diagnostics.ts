import { PROTOCOL_VERSION } from '@landrop/protocol';
import type { LogEntry } from './log.ts';
import type { AppState } from './state.ts';

/**
 * Privacy-preserving diagnostics export. Contains no chat text, file names,
 * device names, room IDs/secrets/codes, tokens, SDP, ICE candidates, or IP
 * addresses. Peers and transfers are referred to by position, not ID.
 * Candidate *types* (host/srflx/relay) are included; they are not addresses.
 */
export function buildDiagnostics(s: AppState, reconnects: number, logs: readonly LogEntry[]) {
  return {
    generatedAt: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    app: { mode: s.config?.mode ?? 'unknown' },
    browser: { name: s.caps.browser, os: s.caps.os },
    capabilities: {
      secureContext: s.caps.secureContext,
      webrtc: s.caps.webrtc,
      workers: s.caps.workers,
      saveFilePicker: s.caps.saveFilePicker,
      directoryPicker: s.caps.directoryPicker,
      streamingSink: s.caps.streamingSink,
      streamingDisabledByUser: s.caps.streamingDisabledByUser,
      memorySinkMaxBytes: s.caps.memorySinkMaxBytes,
    },
    settings: s.settings,
    signaling: { status: s.signaling.status, reconnects },
    inRoom: s.room !== null,
    peers: s.peerOrder.map((id, i) => {
      const p = s.peers[id]!;
      return {
        peer: i + 1,
        presence: p.status,
        link: p.link,
        iceState: p.iceState,
        generation: p.gen,
        iceRestarts: p.iceRestarts,
        rebuilds: p.rebuilds,
        route: p.route?.route ?? 'unknown',
        localCandidateType: p.route?.localType ?? null,
        remoteCandidateType: p.route?.remoteType ?? null,
        protocol: p.route?.protocol ?? null,
        rttMs: p.route?.rttMs ?? null,
        remoteStreamingSink: p.remoteCaps?.streamingSink ?? null,
        remoteMaxAcceptBytes: p.remoteCaps?.maxAcceptBytes ?? null,
      };
    }),
    transfers: s.transferOrder.map((id, i) => {
      const t = s.transfers[id]!;
      return {
        transfer: i + 1,
        peer: s.peerOrder.indexOf(t.peerId) + 1 || null,
        direction: t.direction,
        size: t.size,
        state: t.state,
        attempt: t.attempt,
        bytesTransferred: t.bytesTransferred,
        bytesWritten: t.bytesWritten,
        sink: t.sink,
        error: t.error?.code ?? null,
        durationMs: t.startedAt && t.finishedAt ? t.finishedAt - t.startedAt : null,
        rateBps: Math.round(t.rateBps),
      };
    }),
    memoryReservedBytes: s.memoryReservedBytes,
    log: logs.map((e) => ({ t: new Date(e.t).toISOString(), level: e.level, msg: e.msg })),
  };
}
