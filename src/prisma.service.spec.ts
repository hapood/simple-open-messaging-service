import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaService } from './prisma.service.js';

/**
 * connectWithRetry — the boot-time bounded retry around Prisma's $connect(). Exponentially backed off
 * with full jitter so a transiently-down Postgres at boot is tolerated within one process, rather than
 * only via the orchestrator's container restart. These tests drive the private helper directly with
 * millisecond-scale knobs (real timers — the jittered sleeps are sub-millisecond) and a stubbed
 * $connect, so they neither need nor touch a real database.
 */
describe('PrismaService.connectWithRetry', () => {
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    // Construction calls requireEnv('DATABASE_URL') and only builds the adapter CONFIG — no connection
    // is opened until $connect, which each test stubs — so a dummy URL is sufficient and keeps these
    // unit tests free of any real database dependency.
    process.env.DATABASE_URL = 'postgresql://dummy:dummy@localhost:5432/dummy';
  });

  afterAll(() => {
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  // connectWithRetry is private; reach it through a minimal typed view. $connect is stubbed per test.
  const newService = () =>
    new PrismaService() as unknown as {
      $connect: () => Promise<void>;
      connectWithRetry(opts: {
        maxAttempts: number;
        baseDelayMs: number;
        maxDelayMs: number;
      }): Promise<void>;
    };

  it('resolves once $connect succeeds, having retried the earlier failures', async () => {
    const service = newService();
    const connect = vi
      .spyOn(service, '$connect')
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await expect(
      service.connectWithRetry({ maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 }),
    ).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('resolves on the first try with no retry', async () => {
    const service = newService();
    const connect = vi.spyOn(service, '$connect').mockResolvedValue(undefined);

    await expect(
      service.connectWithRetry({ maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 }),
    ).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('rejects with the underlying error after exhausting maxAttempts', async () => {
    const service = newService();
    const connect = vi.spyOn(service, '$connect').mockRejectedValue(new Error('down'));

    await expect(
      service.connectWithRetry({ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }),
    ).rejects.toThrow('down');
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('does not retry when maxAttempts is 1 (single attempt, re-throw)', async () => {
    const service = newService();
    const connect = vi.spyOn(service, '$connect').mockRejectedValue(new Error('down'));

    await expect(
      service.connectWithRetry({ maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 }),
    ).rejects.toThrow('down');
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
