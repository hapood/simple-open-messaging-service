import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { get } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { SseService } from './sse.service.js';

/**
 * SseService registry, disconnect, and HTTP shutdown with a real held SSE connection.
 * Covers the per-session FORCE_LOGOUT (onSessionRevoked disconnects ONLY the
 * matching session, including multi-tab same-credential, and leaves other devices online), the all-device
 * broadcast (onSessionsInvalidated), and the unknown-session no-op. The @OnEvent handlers are invoked
 * directly as methods (the decorator only wires the emitter; the method itself is plain).
 */
describe('SseService', () => {
  function makeService() {
    const database = {
      db: {
        select: vi.fn(() => {
          const query = {
            from: () => query,
            innerJoin: () => query,
            where: () => query,
            limit: async () => [
              {
                stateFeedEndId: 4,
                threadFeedEndId: 3,
                profileRev: 2,
              },
            ],
          };
          return query;
        }),
      },
    };
    const callState = { get: vi.fn().mockReturnValue(null) };
    return new SseService(database as never, callState as never);
  }

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

  it('ends every stream and clears heartbeats even when one close fails', () => {
    vi.useFakeTimers();
    const svc = makeService();
    const clients = [mockRes(), mockRes(), mockRes()];
    try {
      svc.register(7, 11, clients[0].res);
      svc.register(7, 11, clients[1].res);
      svc.register(8, 22, clients[2].res);
      vi.mocked(clients[0].res.end).mockImplementation(() => {
        throw new Error('connection already closed');
      });
      // A synchronous close callback must not make iteration skip another tab.
      vi.mocked(clients[1].res.end).mockImplementation(() => {
        const close = vi
          .mocked(clients[1].res.on)
          .mock.calls.find(([event]) => event === 'close')![1];
        close();
        return clients[1].res;
      });

      svc.onModuleDestroy();
      svc.onModuleDestroy();

      for (const client of clients) {
        expect(client.res.end).toHaveBeenCalledTimes(1);
        expect(gotForceLogout(client.writes)).toBe(false);
      }
      expect(svc.snapshot()).toMatchObject({ total: 0, uniqueUsers: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('closes the HTTP server while a client holds an SSE stream open', async () => {
    const svc = makeService();
    const module = await Test.createTestingModule({
      providers: [{ provide: SseService, useValue: svc }],
    }).compile();
    const adapter = new FastifyAdapter();
    const app = module.createNestApplication(adapter, { logger: false });
    adapter.getInstance().get('/events', (_request, reply) => {
      reply.hijack();
      svc.register(7, 11, reply.raw);
    });
    await app.listen(0, '127.0.0.1');
    const request = get(`${await app.getUrl()}/events`);
    let closing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [response] = await once(request, 'response');
      const ended = once(response, 'end');
      response.resume();
      expect(svc.isSessionOnline(7, 11)).toBe(true);

      closing = app.close();
      await Promise.race([
        Promise.all([closing, ended]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('shutdown blocked by open SSE stream')),
            1000,
          );
        }),
      ]);
      expect(response.complete).toBe(true);
      expect(svc.isSessionOnline(7, 11)).toBe(false);
    } finally {
      clearTimeout(timer);
      request.destroy();
      app.getHttpServer().closeAllConnections();
      await (closing ?? app.close());
    }
  });

  it('always includes the mandatory stateFeedEndId in HELLO', async () => {
    const svc = makeService();
    const client = mockRes();

    svc.register(7, 11, client.res);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hello = client.writes.find((write) => write.includes('event: HELLO'));
    expect(hello).toContain('"stateFeedEndId":4');
    svc.onModuleDestroy();
  });

  it('reports online state for the exact session rather than the whole user', () => {
    const svc = makeService();
    const client = mockRes();
    svc.register(7, 11, client.res);

    expect(svc.isSessionOnline(7, 11)).toBe(true);
    expect(svc.isSessionOnline(7, 22)).toBe(false);
    expect(svc.isSessionOnline(8, 11)).toBe(false);
    svc.onModuleDestroy();
  });

  it('pushes only the attention revision as the durable-feed wake-up', () => {
    const svc = makeService();
    const client = mockRes();
    svc.register(7, 11, client.res);

    svc.onThreadFeedUpdated(7, { threadFeedEndId: 9 });

    const frame = client.writes.find((write) =>
      write.includes('event: THREAD_FEED_UPDATED'),
    );
    expect(frame).toContain('"threadFeedEndId":9');
    expect(frame).not.toContain('threadId');
    expect(frame).not.toContain('unreadCount');
    svc.onModuleDestroy();
  });

  it('throttles state hints per account independently of thread hints and broadcasts the maximum head', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const clients = [mockRes(), mockRes(), mockRes()];
    const stateFrames = (client: ReturnType<typeof mockRes>) =>
      client.writes.filter((write) =>
        write.includes('event: STATE_FEED_UPDATED'),
      );
    try {
      svc.register(7, 11, clients[0].res);
      svc.register(7, 22, clients[1].res);
      svc.register(8, 33, clients[2].res);

      svc.onStateFeedUpdated(7, { feedId: 5 });
      for (const client of clients.slice(0, 2)) {
        expect(stateFrames(client)).toHaveLength(1);
        expect(stateFrames(client)[0]).toContain('"feedId":5');
      }
      await vi.advanceTimersByTimeAsync(400);
      svc.onStateFeedUpdated(7, { feedId: 9 });
      svc.onStateFeedUpdated(7, { feedId: 7 });
      svc.onStateFeedUpdated(8, { feedId: 6 });
      svc.onThreadFeedUpdated(7, { threadFeedEndId: 3 });
      expect(stateFrames(clients[2])).toHaveLength(1);
      expect(stateFrames(clients[2])[0]).toContain('"feedId":6');
      expect(
        clients[0].writes.filter((write) =>
          write.includes('event: THREAD_FEED_UPDATED'),
        ),
      ).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(599);
      expect(stateFrames(clients[0])).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      for (const client of clients.slice(0, 2)) {
        expect(stateFrames(client)).toHaveLength(2);
        expect(stateFrames(client)[1]).toContain('"feedId":9');
      }
      svc.onStateFeedUpdated(7, { feedId: 9 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(stateFrames(clients[0])).toHaveLength(2);

      svc.onStateFeedUpdated(7, { feedId: 10 });
      expect(stateFrames(clients[0])).toHaveLength(3);
      svc.onStateFeedUpdated(7, { feedId: 11 });
      await Promise.resolve();
      svc.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(stateFrames(clients[0])).toHaveLength(3);
    } finally {
      svc.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('pushes committed heads to every online device without idle head queries', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const first = mockRes();
    const second = mockRes();
    svc.register(7, 11, first.res);
    svc.register(7, 12, second.res);
    await Promise.resolve();
    const database = (
      svc as unknown as {
        database: { db: { select: ReturnType<typeof vi.fn> } };
      }
    ).database;
    database.db.select.mockClear();
    try {
      svc.onThreadFeedUpdated(7, { threadFeedEndId: 8 });
      svc.onStateFeedUpdated(7, { feedId: 9 });
      svc.onThreadFeedUpdated(99, { threadFeedEndId: 10 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(database.db.select).not.toHaveBeenCalled();
      for (const client of [first, second]) {
        expect(
          client.writes.filter((w) => w.includes('event: THREAD_FEED_UPDATED')),
        ).toEqual([expect.stringContaining('"threadFeedEndId":8')]);
        expect(
          client.writes.filter((w) => w.includes('event: STATE_FEED_UPDATED')),
        ).toEqual([expect.stringContaining('"feedId":9')]);
      }
    } finally {
      svc.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('onSessionRevoked disconnects ONLY the matching session (other devices survive)', () => {
    const svc = makeService();
    const a = mockRes(); // session 11
    const b = mockRes(); // session 22 — same user, different device
    svc.register(7, 11, a.res);
    svc.register(7, 22, b.res);

    svc.onSessionRevoked({ userId: 7, sessionId: 11, reason: 'device_revoke' });

    expect(gotForceLogout(a.writes)).toBe(true);
    expect(a.res.end).toHaveBeenCalled();
    expect(gotForceLogout(b.writes)).toBe(false);
    expect(b.res.end).not.toHaveBeenCalled();
    expect(svc.snapshot()).toMatchObject({ total: 1, uniqueUsers: 1 });
    svc.onModuleDestroy();
  });

  it('onSessionRevoked disconnects every connection sharing the sessionId (multi-tab same credential)', () => {
    const svc = makeService();
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
    expect(svc.snapshot()).toMatchObject({ total: 1, uniqueUsers: 1 });
    svc.onModuleDestroy();
  });

  it('onSessionRevoked drops the user slot when no connections remain', () => {
    const svc = makeService();
    const a = mockRes();
    svc.register(7, 11, a.res);

    svc.onSessionRevoked({ userId: 7, sessionId: 11, reason: 'device_revoke' });

    expect(gotForceLogout(a.writes)).toBe(true);
    expect(svc.snapshot()).toMatchObject({ total: 0, uniqueUsers: 0 });
  });

  it("onSessionsInvalidated kicks ALL of the user's sessions (broadcast)", () => {
    const svc = makeService();
    const a = mockRes();
    const b = mockRes();
    svc.register(7, 11, a.res);
    svc.register(7, 22, b.res);

    svc.onSessionsInvalidated({ userId: 7, reason: 'password_change' });

    expect(gotForceLogout(a.writes)).toBe(true);
    expect(gotForceLogout(b.writes)).toBe(true);
    expect(svc.snapshot()).toMatchObject({ total: 0, uniqueUsers: 0 });
  });

  it('onSessionRevoked is a no-op for an unknown sessionId', () => {
    const svc = makeService();
    const a = mockRes();
    svc.register(7, 11, a.res);

    svc.onSessionRevoked({
      userId: 7,
      sessionId: 999,
      reason: 'device_revoke',
    });

    expect(gotForceLogout(a.writes)).toBe(false);
    expect(a.res.end).not.toHaveBeenCalled();
    expect(svc.snapshot()).toMatchObject({ total: 1, uniqueUsers: 1 });
    svc.onModuleDestroy();
  });
});
