/**
 * Transfer state machine. Each side (sender, receiver) runs its own instance;
 * transitions are driven by local user actions, remote control messages, or
 * the engine itself (timers, I/O results). Illegal transitions throw, which
 * makes stale or duplicated events visible in tests instead of corrupting state.
 */

export const TRANSFER_STATES = [
  'queued',
  'requesting',
  'awaiting_acceptance',
  'preparing',
  'transferring',
  'paused',
  'reconnecting',
  'verifying',
  'finalizing',
  'completed',
  'rejected',
  'cancelled',
  'failed',
] as const;

export type TransferState = (typeof TRANSFER_STATES)[number];
export type Role = 'sender' | 'receiver';

export const TERMINAL_STATES: ReadonlySet<TransferState> = new Set(['completed', 'rejected', 'cancelled', 'failed']);

export function isTerminal(s: TransferState): boolean {
  return TERMINAL_STATES.has(s);
}

/** Non-terminal states from which either side may cancel and the engine may fail. */
const ABORTABLE: TransferState[] = [
  'queued',
  'requesting',
  'awaiting_acceptance',
  'preparing',
  'transferring',
  'paused',
  'reconnecting',
  'verifying',
  'finalizing',
];

type Table = Partial<Record<TransferState, readonly TransferState[]>>;

/**
 * Sender:
 *   queued -> requesting            engine: remote capabilities known, offer being sent
 *   requesting -> awaiting_acceptance  engine: offer handed to the control channel
 *   awaiting_acceptance -> transferring  remote: transfer:accept
 *   awaiting_acceptance -> rejected  remote: transfer:reject
 *   transferring <-> paused          local pause/resume or remote transfer:pause/resume
 *   transferring|paused -> reconnecting  engine: data channel lost
 *   reconnecting -> transferring|paused|verifying  remote: transfer:resume-from
 *   transferring -> verifying        engine: all bytes acknowledged as written; finish sent
 *   verifying -> completed           remote: transfer:verified with matching hash
 *   * -> cancelled                   local cancel or remote transfer:cancel
 *   * -> failed                      engine (timeouts, read errors) or remote transfer:error
 */
const SENDER: Table = {
  queued: ['requesting', 'cancelled', 'failed'],
  requesting: ['awaiting_acceptance', 'cancelled', 'failed'],
  awaiting_acceptance: ['transferring', 'rejected', 'cancelled', 'failed'],
  transferring: ['paused', 'reconnecting', 'verifying', 'cancelled', 'failed'],
  paused: ['transferring', 'reconnecting', 'cancelled', 'failed'],
  reconnecting: ['transferring', 'paused', 'verifying', 'cancelled', 'failed'],
  verifying: ['completed', 'reconnecting', 'cancelled', 'failed'],
};

/**
 * Receiver:
 *   awaiting_acceptance -> preparing     local: user accepted, sink being opened
 *   awaiting_acceptance -> rejected      local: user rejected (or auto-reject by limits)
 *   preparing -> transferring            engine: sink ready, transfer:accept sent
 *   preparing -> rejected                local: save dialog dismissed / sink could not be opened
 *   transferring <-> paused              local or remote pause/resume
 *   transferring|paused|verifying -> reconnecting  engine: data channel lost
 *   reconnecting -> transferring|paused|verifying  engine: channel restored, resume-from sent
 *   transferring -> verifying            remote: transfer:finish and all bytes written
 *   verifying -> finalizing              engine: hash matched
 *   finalizing -> completed              engine: sink finalized, transfer:verified sent
 */
const RECEIVER: Table = {
  awaiting_acceptance: ['preparing', 'rejected', 'cancelled', 'failed'],
  preparing: ['transferring', 'rejected', 'cancelled', 'failed'],
  transferring: ['paused', 'reconnecting', 'verifying', 'cancelled', 'failed'],
  paused: ['transferring', 'reconnecting', 'verifying', 'cancelled', 'failed'],
  reconnecting: ['transferring', 'paused', 'verifying', 'cancelled', 'failed'],
  verifying: ['finalizing', 'reconnecting', 'cancelled', 'failed'],
  finalizing: ['completed', 'failed'],
};

const TABLES: Record<Role, Table> = { sender: SENDER, receiver: RECEIVER };

export function canTransition(role: Role, from: TransferState, to: TransferState): boolean {
  return TABLES[role][from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
  constructor(role: Role, from: TransferState, to: TransferState) {
    super(`illegal ${role} transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(role: Role, from: TransferState, to: TransferState): void {
  if (!canTransition(role, from, to)) throw new IllegalTransitionError(role, from, to);
}

export { ABORTABLE };
