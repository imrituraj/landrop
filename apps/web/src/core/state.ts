import type { Capabilities, ClientConfig, DeviceKind, ErrorCode, PeerInfo, RoomInfo } from '@landrop/protocol';
import type { TransferSnapshot } from '@landrop/transfer-core';
import type { LocalCapabilities, UserSettings } from './capabilities.ts';
import type { ChatMessageView } from './chat.ts';
import type { LinkState } from './peer-link.ts';
import type { SignalingStatus } from './signaling.ts';
import type { RouteInfo } from './stats.ts';
import type { VerificationView } from './verification.ts';
import type { LocalIdentity } from './identity.ts';

export interface PeerView extends PeerInfo {
  link: LinkState | 'none';
  route: RouteInfo | null;
  remoteCaps: Capabilities | null;
  gen: number;
  iceRestarts: number;
  rebuilds: number;
  iceState: string;
  verification: VerificationView;
}

export interface TransferView extends TransferSnapshot {
  rateBps: number;
  etaSeconds: number | null;
  /** In-memory result is available to save (memory sink only). */
  savable: boolean;
}

export interface JoinRequestView {
  requestId: string;
  deviceName: string;
  deviceKind: DeviceKind;
  expiresAt: number;
}

export interface Notice {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

export interface AppState {
  config: ClientConfig | null;
  configError: string | null;
  signaling: { status: SignalingStatus; reconnects: number; serverShutdown: boolean };
  identity: { deviceName: string; deviceKind: DeviceKind };
  selfId: string | null;
  room: RoomInfo | null;
  roomError: { code: ErrorCode; message: string } | null;
  busy: 'creating' | 'joining' | null;
  joinPending: { requestId: string; expiresAt: number } | null;
  joinRequests: JoinRequestView[];
  peers: Record<string, PeerView>;
  peerOrder: string[];
  selectedPeerId: string | null;
  chats: Record<string, ChatMessageView[]>;
  unread: Record<string, number>;
  transfers: Record<string, TransferView>;
  transferOrder: string[];
  caps: LocalCapabilities;
  settings: UserSettings;
  notices: Notice[];
  memoryReservedBytes: number;
  /** How this device's verification code is kept (docs/peer-verification.md §4). */
  identityPersistence: LocalIdentity['persistence'] | null;
}
