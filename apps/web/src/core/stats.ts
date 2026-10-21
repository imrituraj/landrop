/**
 * Classifies the *selected* ICE candidate pair from RTCPeerConnection.getStats().
 *
 * We never infer the route from configuration (e.g. "no TURN configured, so it
 * must be direct"); we read what the browser reports for the active pair and
 * return 'unknown' when the browser does not expose it.
 */

export type Route = 'direct' | 'relay' | 'unknown';

export interface RouteInfo {
  route: Route;
  /** Candidate types, e.g. "host", "srflx", "prflx", "relay". */
  localType: string | null;
  remoteType: string | null;
  protocol: string | null;
  rttMs: number | null;
  bytesSent: number;
  bytesReceived: number;
}

/** A stats report entry. getStats() returns loosely-typed dictionaries; we check fields at runtime. */
type StatsEntry = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function classifyRoute(report: { forEach(cb: (value: StatsEntry, key: string) => void): void }): RouteInfo {
  const byId = new Map<string, StatsEntry>();
  report.forEach((value, key) => byId.set(key, value));

  let pair: StatsEntry | undefined;
  // Standard: transport.selectedCandidatePairId (Chromium, Safari).
  for (const s of byId.values()) {
    if (s['type'] === 'transport') {
      const id = str(s['selectedCandidatePairId']);
      if (id && byId.has(id)) pair = byId.get(id);
    }
  }
  // Firefox: candidate-pair.selected; fallback: nominated + succeeded.
  if (!pair) {
    for (const s of byId.values()) {
      if (s['type'] === 'candidate-pair' && s['selected'] === true) pair = s;
    }
  }
  if (!pair) {
    for (const s of byId.values()) {
      if (s['type'] === 'candidate-pair' && s['nominated'] === true && s['state'] === 'succeeded') pair = s;
    }
  }

  const empty: RouteInfo = {
    route: 'unknown',
    localType: null,
    remoteType: null,
    protocol: null,
    rttMs: null,
    bytesSent: 0,
    bytesReceived: 0,
  };
  if (!pair) return empty;

  const local = byId.get(str(pair['localCandidateId']) ?? '');
  const remote = byId.get(str(pair['remoteCandidateId']) ?? '');
  const localType = local ? str(local['candidateType']) : null;
  const remoteType = remote ? str(remote['candidateType']) : null;
  const rtt = num(pair['currentRoundTripTime']);

  let route: Route = 'unknown';
  if (localType === 'relay' || remoteType === 'relay') route = 'relay';
  else if (localType && remoteType) route = 'direct';

  return {
    route,
    localType,
    remoteType,
    protocol: local ? str(local['protocol']) : null,
    rttMs: rtt === null ? null : Math.round(rtt * 1000),
    bytesSent: num(pair['bytesSent']) ?? 0,
    bytesReceived: num(pair['bytesReceived']) ?? 0,
  };
}

/**
 * Bounded buffer for ICE candidates that arrive before the remote description.
 * Candidates beyond the bound are dropped (the connection may then need an ICE
 * restart), which caps memory under a flood from a misbehaving peer.
 */
export class CandidateBuffer<T> {
  private items: T[] = [];
  dropped = 0;
  private readonly limit: number;

  constructor(limit = 100) {
    this.limit = limit;
  }

  push(c: T): void {
    if (this.items.length >= this.limit) {
      this.dropped++;
      return;
    }
    this.items.push(c);
  }

  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  get size(): number {
    return this.items.length;
  }
}
