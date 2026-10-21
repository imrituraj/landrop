import type { DeviceKind } from '@landrop/protocol';
import type { TransferView, PeerView } from '../core/state.ts';

export function transferStateLabel(t: TransferView): string {
  const out = t.direction === 'out';
  switch (t.state) {
    case 'queued':
      return 'Queued — waiting for the device to connect';
    case 'requesting':
      return 'Sending request…';
    case 'awaiting_acceptance':
      return out ? 'Waiting for the receiver to accept' : 'Waiting for your decision';
    case 'preparing':
      return 'Preparing destination…';
    case 'transferring':
      return 'Transferring';
    case 'paused':
      return 'Paused';
    case 'reconnecting':
      return 'Connection lost — trying to resume';
    case 'verifying':
      return out ? 'Sent — waiting for the receiver to verify' : 'Verifying integrity';
    case 'finalizing':
      return 'Saving file…';
    case 'completed':
      if (out) return 'Delivered — receiver verified the file';
      return t.sink === 'memory' ? 'Received and verified — use Save to keep it' : 'Saved to disk and verified';
    case 'rejected':
      return 'Declined';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
  }
}

export function linkLabel(p: PeerView): { text: string; tone: 'green' | 'amber' | 'red' | 'slate' | 'blue'; detail: string } {
  if (p.status === 'reconnecting' && p.link !== 'connected') {
    return { text: 'Device reconnecting', tone: 'amber', detail: 'The device lost contact with the LanDrop server.' };
  }
  switch (p.link) {
    case 'connected': {
      const r = p.route;
      if (!r || r.route === 'unknown')
        return { text: 'Connected (route unknown)', tone: 'slate', detail: 'This browser does not report the selected connection route.' };
      if (r.route === 'relay')
        return { text: 'Relayed', tone: 'amber', detail: 'Traffic passes through a TURN relay server.' };
      return {
        text: 'Direct',
        tone: 'green',
        detail: `Direct peer-to-peer (${r.localType ?? '?'} ↔ ${r.remoteType ?? '?'}${r.protocol ? `, ${r.protocol.toUpperCase()}` : ''}${r.rttMs !== null ? `, ${r.rttMs} ms` : ''}).`,
      };
    }
    case 'connecting':
    case 'none':
      return { text: 'Connecting…', tone: 'blue', detail: 'Negotiating a direct connection.' };
    case 'reconnecting':
      return { text: 'Reconnecting…', tone: 'amber', detail: 'The direct connection dropped; trying to restore it.' };
    case 'unavailable':
      return {
        text: 'No direct connection',
        tone: 'red',
        detail:
          'The devices could not reach each other directly. Guest Wi-Fi isolation, VPNs, firewalls, or separate VLANs commonly cause this. LanDrop does not relay files through the server.',
      };
    case 'closed':
      return { text: 'Disconnected', tone: 'slate', detail: '' };
  }
}

export const kindLabel: Record<DeviceKind, string> = {
  desktop: 'Desktop',
  laptop: 'Laptop',
  phone: 'Phone',
  tablet: 'Tablet',
  unknown: 'Device',
};
