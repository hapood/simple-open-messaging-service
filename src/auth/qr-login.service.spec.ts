import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QrLoginService } from './qr-login.service.js';
import { BusinessCode } from '../common/business-code.js';
import type { KvStoreService } from '../kv-store/kv-store.service.js';
import type { SessionTokenService } from './session-token.service.js';

/**
 * QrLoginService: the desktop/web → 2-week sliding-session flow confirmed by a logged-in phone. The
 * ephemeral state lives in the KV, so the mock KV is a real in-memory Map — letting create→poll→scan→
 * confirm→claim run as one end-to-end state machine within a test. Covers the two-step gates, the
 * atomic issue-once claim (del returns 1 iff this caller removed the key), and unknown-token handling.
 */
describe('QrLoginService', () => {
  // Real in-memory KV so QR state persists across the service's own read/scan/confirm/poll calls.
  let store: Map<string, string>;
  const kv = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      store.set(k, v);
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
  const sessionTokens = { issue: vi.fn() };
  const svc = new QrLoginService(
    kv as unknown as KvStoreService,
    sessionTokens as unknown as SessionTokenService,
  );

  beforeEach(() => {
    store = new Map();
    kv.get.mockClear();
    kv.setex.mockClear();
    kv.del.mockClear();
    sessionTokens.issue.mockReset();
    sessionTokens.issue.mockResolvedValue('sess-token');
  });

  describe('create + poll state machine', () => {
    it('creates a pending token, then polls pending', async () => {
      const r = await svc.create('web');
      expect(r.qrToken).toMatch(/^[0-9a-f]+$/);
      expect((await svc.poll(r.qrToken, {})).status).toBe('pending');
    });

    it('scan → scanned; confirm → confirmed; the first confirming poll claims + issues ONCE', async () => {
      const { qrToken } = await svc.create('desktop');
      await svc.scan(qrToken, 42); // phone scanned
      expect((await svc.poll(qrToken, {})).status).toBe('scanned');
      await svc.confirm(qrToken, 42); // phone confirmed → desktop session belongs to userId 42

      const claimed = await svc.poll(qrToken, { ip: '1.2.3.4' });
      expect(claimed.status).toBe('confirmed');
      expect(claimed.sessionToken).toBe('sess-token');
      expect(sessionTokens.issue).toHaveBeenCalledWith(
        42,
        'desktop',
        expect.objectContaining({ ip: '1.2.3.4', persistent: true }),
      );

      // A second poll finds the key already claimed (del returns 0) → expired. Issue-once is enforced.
      expect((await svc.poll(qrToken, {})).status).toBe('expired');
      expect(sessionTokens.issue).toHaveBeenCalledTimes(1);
    });

    it('polls an unknown token → expired', async () => {
      expect((await svc.poll('nonexistent', {})).status).toBe('expired');
    });
  });

  describe('two-step gates', () => {
    it('scan rejects a non-pending token (e.g. already scanned) → QR_INVALID', async () => {
      const { qrToken } = await svc.create('web');
      await svc.scan(qrToken, 42);
      await expect(svc.scan(qrToken, 42)).rejects.toMatchObject({
        bizCode: BusinessCode.QR_INVALID,
      });
    });

    it('confirm rejects a token that was not scanned first → QR_INVALID', async () => {
      const { qrToken } = await svc.create('web');
      await expect(svc.confirm(qrToken, 42)).rejects.toMatchObject({
        bizCode: BusinessCode.QR_INVALID,
      });
    });

    it('scan on an unknown token → QR_EXPIRED', async () => {
      await expect(svc.scan('nonexistent', 42)).rejects.toMatchObject({
        bizCode: BusinessCode.QR_EXPIRED,
      });
    });
  });
});
