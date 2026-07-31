import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthController } from './health.controller.js';
import type { PrismaService } from '../prisma.service.js';

/**
 * HealthController.health — the public liveness probe now reports DB reachability as a `database`
 * field while keeping HTTP 200 unconditionally (a DB blip must never make the orchestrator restart a
 * live process). probeDatabase issues a fail-fast SELECT 1; success → "up", any failure or timeout →
 * "down". The handler returns the raw health payload; the global SerializeInterceptor adds the
 * code:0 HTTP response envelope, which is covered by the interceptor unit tests and health e2e test.
 */
describe('HealthController.health — database reachability field', () => {
  const $queryRaw = vi.fn();
  const prisma = { $queryRaw } as unknown as PrismaService;
  const controller = new HealthController(prisma);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports database "up" when SELECT 1 resolves', async () => {
    $queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);

    const result = await controller.health();

    expect(result.status).toBe('ok');
    expect(result.database).toBe('up');
    expect(typeof result.version).toBe('string');
    expect(typeof result.time).toBe('number');
  });

  it('reports database "down" when SELECT 1 rejects', async () => {
    $queryRaw.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await controller.health();

    expect(result.database).toBe('down');
  });

  it('reports database "down" when SELECT 1 hangs past the fail-fast timeout', async () => {
    vi.useFakeTimers();
    try {
      $queryRaw.mockReturnValueOnce(new Promise<never>(() => {}));

      const pending = controller.health();
      await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;

      expect(result.database).toBe('down');
    } finally {
      vi.useRealTimers();
    }
  });
});
