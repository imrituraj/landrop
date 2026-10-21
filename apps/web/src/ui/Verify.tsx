import { useState } from 'react';
import type { PeerView } from '../core/state.ts';
import { useApp, useAppState } from './context.tsx';
import { Badge, Button, Callout, Dialog, Icon } from './primitives.tsx';

/** Short badge for device cards; nothing for the common "not verified" case. */
export function VerificationBadge({ peer }: { peer: PeerView }) {
  const v = peer.verification;
  if (v.status === 'verified') {
    return (
      <Badge tone="green">
        <Icon name="check" className="h-3 w-3" /> Verified
      </Badge>
    );
  }
  if (v.status === 'changed') {
    return (
      <Badge tone="red">
        <Icon name="alert" className="h-3 w-3" /> Code changed
      </Badge>
    );
  }
  return null;
}

export function verificationText(peer: PeerView): string {
  const v = peer.verification;
  switch (v.status) {
    case 'verified':
      return v.verifiedLabel && v.verifiedLabel !== peer.deviceName ? `Verified as “${v.verifiedLabel}”` : 'Verified';
    case 'changed':
      return 'Security code changed';
    case 'unverified':
      return 'Not verified';
    case 'pending':
      return 'Checking security code…';
    case 'unavailable':
      return 'Cannot verify this connection';
  }
}

function CodeLine({ groups, label }: { groups: string[]; label: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="grid grid-cols-4 gap-x-3 gap-y-1 font-mono text-lg tracking-wider" aria-label={`${label}: ${groups.join(' ')}`}>
        {groups.map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </p>
    </div>
  );
}

/** Status row and dialog in the device panel header. */
export function VerifySection({ peerId }: { peerId: string }) {
  const peer = useAppState((s) => s.peers[peerId]);
  const [open, setOpen] = useState(false);
  if (!peer) return null;
  const changed = peer.verification.status === 'changed';
  return (
    <>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <Icon name="lock" className="h-4 w-4" />
        <span data-testid="verification-status">{verificationText(peer)}</span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)} disabled={!peer.verification.number}>
          Verify
        </Button>
      </p>
      {changed && (
        <div className="mt-2">
          <Callout tone="error" title="Security code changed">
            This connection does not reach the certificate you verified for this device. The device may have reset its browser data, or
            someone may be intercepting the connection. Compare codes again before sending anything sensitive.
          </Callout>
        </div>
      )}
      <VerifyDialog peer={peer} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function VerifyDialog({ peer, open, onClose }: { peer: PeerView; open: boolean; onClose: () => void }) {
  const app = useApp();
  const persistence = useAppState((s) => s.identityPersistence);
  const v = peer.verification;
  const n = v.number;
  const verified = v.status === 'verified';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Verify ${peer.deviceName}`}
      footer={
        <>
          <Button onClick={onClose}>{verified ? 'Close' : 'Cancel'}</Button>
          {verified ? (
            <Button variant="danger" onClick={() => app.removeVerification(peer.peerId)}>
              Remove verification
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!n || !v.remoteFingerprint}
              onClick={() => {
                if (v.remoteFingerprint && app.markVerified(peer.peerId, v.remoteFingerprint)) onClose();
              }}
            >
              They match — mark as verified
            </Button>
          )}
        </>
      }
    >
      {n ? (
        <div className="space-y-4 text-sm">
          <p>
            Open <strong>Verify</strong> for this device on the other screen as well. Both screens must show exactly the same two lines.
            Compare them in person, or over a call you trust.
          </p>
          <div className="space-y-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700" data-testid="safety-number">
            <CodeLine groups={n.lines[0]} label={n.localLine === 0 ? 'This device' : 'Other device'} />
            <CodeLine groups={n.lines[1]} label={n.localLine === 1 ? 'This device' : 'Other device'} />
          </div>
          {verified && <p className="text-emerald-700 dark:text-emerald-400">{verificationText(peer)}.</p>}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            A match means this connection runs directly between these two browsers, with no one relaying it. It does not identify the
            person using the device, and it cannot protect you if the LanDrop server itself sends a tampered app.
            {persistence === 'memory' && ' Your browser does not allow LanDrop to store data, so this device’s code changes when the page reloads.'}
            {persistence === 'browser' && ' This browser cannot keep a fixed code, so this device’s code changes with every connection.'}
          </p>
        </div>
      ) : (
        <p className="text-sm">
          {v.status === 'unavailable'
            ? 'This browser does not report the connection’s security certificates, so this connection cannot be verified.'
            : 'Waiting for the direct connection…'}
        </p>
      )}
    </Dialog>
  );
}
