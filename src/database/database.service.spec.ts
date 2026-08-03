import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from './database.service.js';

describe('DatabaseService.connectWithRetry', () => {
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://dummy:dummy@localhost:5432/dummy';
  });

  afterAll(() => {
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
  });

  const newService = () =>
    new DatabaseService() as unknown as {
      pool: { connect: () => Promise<{ release(): void }> };
      connectWithRetry(opts: {
        maxAttempts: number;
        baseDelayMs: number;
        maxDelayMs: number;
      }): Promise<void>;
    };

  const client = { release: vi.fn() };

  it('resolves after transient connection failures', async () => {
    const service = newService();
    const connect = vi
      .spyOn(service.pool, 'connect')
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(client);

    await expect(
      service.connectWithRetry({
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 2,
      }),
    ).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('resolves on the first successful connection', async () => {
    const service = newService();
    const connect = vi.spyOn(service.pool, 'connect').mockResolvedValue(client);

    await expect(
      service.connectWithRetry({
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 2,
      }),
    ).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('rethrows the underlying error after exhausting retries', async () => {
    const service = newService();
    const connect = vi
      .spyOn(service.pool, 'connect')
      .mockRejectedValue(new Error('down'));

    await expect(
      service.connectWithRetry({
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
      }),
    ).rejects.toThrow('down');
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('does not retry when maxAttempts is one', async () => {
    const service = newService();
    const connect = vi
      .spyOn(service.pool, 'connect')
      .mockRejectedValue(new Error('down'));

    await expect(
      service.connectWithRetry({
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 2,
      }),
    ).rejects.toThrow('down');
    expect(connect).toHaveBeenCalledOnce();
  });

  it('accepts standard PostgreSQL variables when DATABASE_URL is absent', () => {
    delete process.env.DATABASE_URL;
    process.env.PGHOST = 'postgres';
    process.env.PGDATABASE = 'soms';
    process.env.PGUSER = 'timescale';
    process.env.PGPASSWORD = 'password with @:/?# characters';
    try {
      expect(new DatabaseService().pool).toBeDefined();
    } finally {
      process.env.DATABASE_URL =
        'postgresql://dummy:dummy@localhost:5432/dummy';
      delete process.env.PGHOST;
      delete process.env.PGDATABASE;
      delete process.env.PGUSER;
      delete process.env.PGPASSWORD;
    }
  });
});
