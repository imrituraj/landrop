import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

describe('startup configuration', () => {
  it('uses safe defaults: loopback bind, same-origin only, no proxy trust', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8787);
    expect(c.allowedOrigins).toEqual([]);
    expect(c.allowSameOrigin).toBe(true);
    expect(c.trustProxy).toBe(false);
    expect(c.publicOrigin).toBeNull();
  });

  it('parses explicit origins and rejects anything that is not an exact origin', () => {
    expect(loadConfig({ ALLOWED_ORIGINS: 'https://landrop.lan:8443, http://192.168.1.20:8787' }).allowedOrigins).toEqual([
      'https://landrop.lan:8443',
      'http://192.168.1.20:8787',
    ]);
    expect(() => loadConfig({ ALLOWED_ORIGINS: '*' })).toThrow(ConfigError);
    expect(() => loadConfig({ ALLOWED_ORIGINS: 'https://landrop.lan/' })).toThrow(ConfigError);
    expect(() => loadConfig({ ALLOWED_ORIGINS: 'ftp://landrop.lan' })).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'https://a.lan,https://b.lan' })).toThrow(ConfigError);
  });

  it('rejects out-of-range values with a readable message', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ ROOM_MAX_PEERS: '1' })).toThrow(/ROOM_MAX_PEERS/);
    expect(() => loadConfig({ TRUST_PROXY: 'maybe' })).toThrow(/TRUST_PROXY/);
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ PORT: '', ALLOWED_ORIGINS: '' }).port).toBe(8787);
  });
});
