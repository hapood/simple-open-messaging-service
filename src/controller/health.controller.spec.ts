import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthController } from './health.controller.js';
import { BusinessCode } from '../common/business-code.js';
import type { PrismaService } from '../prisma.service.js';

/**
 * HealthController.health — the public liveness probe now reports DB reachability as a `database`
 * field while keeping HTTP 200 unconditionally (a DB blip must never make the orchestrator restart a
 * live process). probeDatabase issues a fail-fast SELECT 1; success → "up", any failure or timeout →
 * "down". The handler never throws, so each case below still yields a code:0 (200) envelope.
 */
describe('HealthController.health — database reachability field', () => {
  const $queryRaw = vi.fn();
  const prisma = { $queryRaw } as unknown as PrismaService;
  const controller = new HealthController(prisma);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports database "up" when SELECT 1 resolves, in a 200 envelope', async () => {
    $queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);

    const result = await controller.health();
    expect(result.data).toBeDefined();
    const data = result.data!;

    expect(result.code).toBe(BusinessCode.OK);
    expect(data.status).toBe('ok');
    expect(data.database).toBe('up');
    expect(typeof data.version).toBe('string');
    expect(typeof data.time).toBe('number');
  });

  it('reports database "down" (still a 200 envelope) when SELECT 1 rejects', async () => {
    $queryRaw.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await controller.health();
    expect(result.data).toBeDefined();

    expect(result.code).toBe(BusinessCode.OK);
    expect(result.data!.database).toBe('down');
  });

  it('reports database "down" when SELECT 1 hangs past the fail-fast timeout', async () => {
    vi.useFakeTimers();
    try {
      $queryRaw.mockReturnValueOnce(new Promise<never>(() => {}));

      const pending = controller.health();
      await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;
      expect(result.data).toBeDefined();

      expect(result.code).toBe(BusinessCode.OK);
      expect(result.data!.database).toBe('down');
    } finally {
      vi.useRealTimers();
    }
  });
});
