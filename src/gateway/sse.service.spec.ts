import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { SseService } from './sse.service.js';

/**
 * SseService registry + disconnect. Pure unit tests (no DI — SseService has no constructor deps; the raw
 * responses are mocked). Covers the per-session FORCE_LOGOUT (onSessionRevoked disconnects ONLY the
 * matching session, including multi-tab same-credential, and leaves other devices online), the all-device
 * broadcast (onSessionsInvalidated), and the unknown-session no-op. The @OnEvent handlers are invoked
 * directly as methods (the decorator only wires the emitter; the method itself is plain).
 */
describe('SseService', () => {
  /** A mock hijacked raw response that records everything written so a FORCE_LOGOUT frame is detectable. */
  function mockRes() {
    const writes: string[] = [];
    return {
      writes,
      res: {
        writeHead: vi.fn(),
        write: vi.fn((s: string) => {
          writes.push(s);
          return true;
        }),
        end: vi.fn(),
        on: vi.fn(),
      } as unknown as ServerResponse,
    };
  }

  /** True when the connection received a FORCE_LOGOUT frame. */
  function gotForceLogout(writes: string[]) {
    return writes.some((w) => w.includes('event: FORCE_LOGOUT'));
  }

  it('onSessionRevoked disconnects ONLY the matching session (other devices survive)', () => {
    const svc = new SseService();
    const a = mockRes(); // session 11
    const b = mockRes(); // session 22 — same user, different device
    svc.register(7, 11, a.res);
    svc.register(7, 22, b.res);

    svc.onSessionRevoked({ userId: 7, sessionId: 11, reason: 'device_revoke' });

    expect(gotForceLogout(a.writes)).toBe(true);
    expect(a.res.end).toHaveBeenCalled();
    expect(gotForceLogout(b.writes)).toBe(false);
    expect(b.res.end).not.toHaveBeenCalled();
    expect(svc.isUserOnline(7)).toBe(true); // survivor remains
    svc.onModuleDestroy();
  });

  it('onSessionRevoked disconnects every connection sharing the sessionId (multi-tab same credential)', () => {
    const svc = new SseService();
    const tab1 = mockRes();
    const tab2 = mockRes(); // same session 11 — two tabs, one session token
    const other = mockRes(); // session 22
    svc.register(7, 11, tab1.res);
    svc.register(7, 11, tab2.res);
    svc.register(7, 22, other.res);

    svc.onSessionRevoked({ userId: 7, sessionId: 11, reason: 'device_revoke' });

    expect(gotForceLogout(tab1.writes)).toBe(true);
    expect(gotForceLogout(tab2.writes)).toBe(true);
    expect(gotForceLogout(other.writes)).toBe(false);
    expect(svc.isUserOnline(7)).toBe(true); // the other device survives
    svc.onModuleDestroy();
  });

  it('onSessionRevoked drops the user slot when no connections remain', () => {
    const svc = new SseService();
    const a = mockRes();
    svc.register(7, 11, a.res);

    svc.onSessionRevoked({ userId: 7, sessionId: 11, reason: 'device_revoke' });

    expect(gotForceLogout(a.writes)).toBe(true);
    expect(svc.isUserOnline(7)).toBe(false);
  });

  it('onSessionsInvalidated kicks ALL of the user\'s sessions (broadcast)', () => {
    const svc = new SseService();
    const a = mockRes();
    const b = mockRes();
    svc.register(7, 11, a.res);
    svc.register(7, 22, b.res);

    svc.onSessionsInvalidated({ userId: 7, reason: 'password_change' });

    expect(gotForceLogout(a.writes)).toBe(true);
    expect(gotForceLogout(b.writes)).toBe(true);
    expect(svc.isUserOnline(7)).toBe(false);
  });

  it('onSessionRevoked is a no-op for an unknown sessionId', () => {
    const svc = new SseService();
    const a = mockRes();
    svc.register(7, 11, a.res);

    svc.onSessionRevoked({ userId: 7, sessionId: 999, reason: 'device_revoke' });

    expect(gotForceLogout(a.writes)).toBe(false);
    expect(a.res.end).not.toHaveBeenCalled();
    expect(svc.isUserOnline(7)).toBe(true);
    svc.onModuleDestroy();
  });
});
