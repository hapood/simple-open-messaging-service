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
      pool: {
        options: { options?: string };
        connect: () => Promise<{
          query: (
            sql: string,
          ) => Promise<{ rows: Array<{ timezone: string }> }>;
          release(): void;
        }>;
      };
      connectWithRetry(opts: {
        maxAttempts: number;
        baseDelayMs: number;
        maxDelayMs: number;
      }): Promise<void>;
    };

  const client = {
    query: vi.fn().mockResolvedValue({ rows: [{ timezone: 'UTC' }] }),
    release: vi.fn(),
  };

  it('pins every pool connection to UTC', () => {
    expect(newService().pool.options.options).toBe('-c timezone=UTC');
  });

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
    expect(client.query).toHaveBeenCalledWith(
      "SELECT current_setting('TimeZone') AS timezone",
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects a connection whose effective timezone is not UTC', async () => {
    const service = newService();
    const nonUtcClient = {
      query: vi.fn().mockResolvedValue({
        rows: [{ timezone: 'Asia/Shanghai' }],
      }),
      release: vi.fn(),
    };
    vi.spyOn(service.pool, 'connect').mockResolvedValue(nonUtcClient);

    await expect(
      service.connectWithRetry({
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 2,
      }),
    ).rejects.toThrow(
      'database session timezone must be UTC (got Asia/Shanghai)',
    );
    expect(nonUtcClient.release).toHaveBeenCalledOnce();
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
