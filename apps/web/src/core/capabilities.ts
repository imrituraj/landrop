import { PROTOCOL_VERSION, type Capabilities } from '@landrop/protocol';

/**
 * Runtime capability detection. Detection says an API *exists*; it does not
 * prove a browser combination works end to end (see docs/browser-support.md).
 */
export interface LocalCapabilities {
  secureContext: boolean;
  webrtc: boolean;
  workers: boolean;
  saveFilePicker: boolean;
  directoryPicker: boolean;
  /** Streaming to disk is possible (and not disabled by the user). */
  streamingSink: boolean;
  /** User turned streaming off in settings (for testing or preference). */
  streamingDisabledByUser: boolean;
  memorySinkMaxBytes: number;
  clipboardWrite: boolean;
  touch: boolean;
  browser: string;
  os: string;
}

const MiB = 1024 * 1024;
const SETTINGS_KEY = 'landrop.settings';

export interface UserSettings {
  disableStreaming: boolean;
  memoryLimitMiB: number;
  concurrency: number;
}

export const DEFAULT_SETTINGS: UserSettings = { disableStreaming: false, memoryLimitMiB: 0, concurrency: 2 };

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return DEFAULT_SETTINGS;
    const o = v as Record<string, unknown>;
    return {
      disableStreaming: o['disableStreaming'] === true,
      memoryLimitMiB:
        typeof o['memoryLimitMiB'] === 'number' && o['memoryLimitMiB'] >= 0 && o['memoryLimitMiB'] <= 2048
          ? Math.floor(o['memoryLimitMiB'])
          : 0,
      concurrency:
        typeof o['concurrency'] === 'number' && o['concurrency'] >= 1 && o['concurrency'] <= 4 ? Math.floor(o['concurrency']) : 2,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: UserSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore: settings just won't persist
  }
}

function describeBrowser(ua: string): { browser: string; os: string } {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  return { browser, os };
}

export function detectCapabilities(settings: UserSettings): LocalCapabilities {
  const secureContext = window.isSecureContext;
  const saveFilePicker = secureContext && typeof window.showSaveFilePicker === 'function';
  const directoryPicker = secureContext && typeof window.showDirectoryPicker === 'function';
  const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  // Conservative default: phones and low-memory devices get a smaller in-memory limit.
  const defaultLimit = touch || (deviceMemory !== undefined && deviceMemory <= 4) ? 128 * MiB : 256 * MiB;
  const memorySinkMaxBytes = settings.memoryLimitMiB > 0 ? settings.memoryLimitMiB * MiB : defaultLimit;
  const { browser, os } = describeBrowser(navigator.userAgent);
  return {
    secureContext,
    webrtc: typeof RTCPeerConnection === 'function',
    workers: typeof Worker === 'function',
    saveFilePicker,
    directoryPicker,
    streamingSink: saveFilePicker && !settings.disableStreaming,
    streamingDisabledByUser: settings.disableStreaming,
    memorySinkMaxBytes,
    clipboardWrite: secureContext && typeof navigator.clipboard?.writeText === 'function',
    touch,
    browser,
    os,
  };
}

export function toWireCapabilities(c: LocalCapabilities, maxMessageSize: number): Capabilities {
  return {
    v: PROTOCOL_VERSION,
    type: 'capabilities',
    streamingSink: c.streamingSink,
    memorySinkMaxBytes: c.memorySinkMaxBytes,
    maxAcceptBytes: c.streamingSink ? Number.MAX_SAFE_INTEGER : c.memorySinkMaxBytes,
    maxMessageSize,
    hashAlgorithms: ['sha-256'],
    resume: { pause: true, reconnect: true, reload: false },
  };
}

export function guessDeviceKind(c: LocalCapabilities): 'phone' | 'tablet' | 'laptop' | 'desktop' | 'unknown' {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (/Mobi|iPhone|Android/.test(ua)) return 'phone';
  if (c.os === 'macOS' || c.os === 'Windows' || c.os === 'Linux') return 'laptop';
  return 'unknown';
}
