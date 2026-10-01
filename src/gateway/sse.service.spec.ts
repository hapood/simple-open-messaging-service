import { Controller, Sse, type MessageEvent } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { get } from 'node:http';
import { once } from 'node:events';
import type { Observable, Subscription } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { profileNamespaceChangeFeedHead } from '../database/schema.js';
import { SseService } from './sse.service.js';

function makeService() {
  const database = {
    db: {
      update: vi.fn(() => {
        const query = {
          set: () => query,
          where: () => query,
          returning: async () => [{ id: 11 }],
        };
        return query;
      }),
      select: vi.fn(() => {
        // sendHello runs two selects per HELLO: the session/user projection
        // and the profile-namespace change head row. Distinguish them by the
        // table passed to from() — order-independent.
        let isHead = false;
        const query = {
          from: (table: unknown) => {
            if (table === profileNamespaceChangeFeedHead) isHead = true;
            return query;
          },
          innerJoin: () => query,
          where: () => query,
          limit: async () =>
            isHead
              ? [{ endId: 5n }]
              : [
                  {
                    stateFeedEndId: 4,
                    threadFeedEndId: 3,
                    profileRev: 2,
                    pushSubscriptionRev: 3,
                  },
                ],
        };
        return query;
      }),
    },
  };
  const callState = { get: vi.fn().mockReturnValue(null) };
  return {
    svc: new SseService(database as never, callState as never),
    database,
  };
}

function connect(svc: SseService, userId: number, sessionId: number) {
  const events: MessageEvent[] = [];
  const subscription: Subscription = svc
    .register(userId, sessionId)
    .subscribe((event) => events.push(event));
  return { events, subscription };
}

function eventsOf(client: ReturnType<typeof connect>, type: string) {
  return client.events.filter((event) => event.type === type);
}

@Controller()
class FixtureController {
  constructor(private readonly sse: SseService) {}

  @Sse('events')
  stream(): Observable<MessageEvent> {
    return this.sse.register(7, 11);
  }
}

async function serve(svc: SseService) {
  const module = await Test.createTestingModule({
    controllers: [FixtureController],
    providers: [{ provide: SseService, useValue: svc }],
  }).compile();
  const app = module.createNestApplication(new FastifyAdapter(), {
    logger: false,
  });
  app.enableCors({ origin: true });
  await app.listen(0, '127.0.0.1');
  return app;
}

describe('framework SSE streams', () => {
  it('registers on subscription and removes the exact client on unsubscribe', async () => {
    const { svc } = makeService();
    const stream = svc.register(7, 11);
    expect(svc.snapshot().total).toBe(0);
    const a = connect(svc, 7, 11);
    const b = connect(svc, 7, 22);
    expect(svc.isSessionOnline(7, 11)).toBe(true);
    expect(svc.isSessionOnline(7, 22)).toBe(true);
    await vi.waitFor(() => expect(eventsOf(a, 'HELLO')).toHaveLength(1));
    expect(eventsOf(a, 'HELLO')[0].data).toMatchObject({
      userId: 7,
      sessionId: 11,
      stateFeedEndId: 4,
      pushSubscriptionRev: 3,
      profileNamespaceChangeEndId: 5,
    });
    a.subscription.unsubscribe();
    expect(svc.isSessionOnline(7, 11)).toBe(false);
    expect(svc.snapshot().total).toBe(1);
    b.subscription.unsubscribe();
    expect(svc.snapshot().total).toBe(0);
    expect(stream).toBeDefined();
    svc.onModuleDestroy();
  });

  it('sends profile wakes only to the indexed current session stream', () => {
    const { svc } = makeService();
    const old = connect(svc, 7, 11);
    const current = connect(svc, 7, 11);
    const sameUserOtherSession = connect(svc, 7, 22);
    const otherUserSameSessionId = connect(svc, 8, 33);
    svc.onProfileAvailable(11, {
      publisherNamespaceId: 4,
      profileNamespaceId: 4,
      account: 'alice',
      domain: 'remote.test',
      rev: 9,
    });
    expect(eventsOf(old, 'PROFILE_AVAILABLE')).toHaveLength(0);
    expect(eventsOf(current, 'PROFILE_AVAILABLE')).toHaveLength(1);
    expect(eventsOf(sameUserOtherSession, 'PROFILE_AVAILABLE')).toHaveLength(0);
    expect(eventsOf(otherUserSameSessionId, 'PROFILE_AVAILABLE')).toHaveLength(
      0,
    );

    current.subscription.unsubscribe();
    svc.onProfileUnavailable(11, {
      publisherNamespaceId: 4,
      profileNamespaceId: 4,
      account: 'alice',
      domain: 'remote.test',
      rev: 9,
      reason: 'NOT_FOUND',
    });
    expect(eventsOf(current, 'PROFILE_UNAVAILABLE')).toHaveLength(0);
    svc.onModuleDestroy();
  });

  it('sends media progress through temporary keyed streams and closes on terminal events', () => {
    const { svc } = makeService();
    const messageEvents: MessageEvent[] = [];
    const fileEvents: MessageEvent[] = [];
    const otherFileEvents: MessageEvent[] = [];
    const messageSub = svc
      .registerMediaMessageProgress(7, 3, 9)
      .subscribe((event) => messageEvents.push(event));
    const fileSub = svc
      .registerMediaFileProgress(7, 3, 9, 'a'.repeat(64))
      .subscribe((event) => fileEvents.push(event));
    const otherFileSub = svc
      .registerMediaFileProgress(7, 3, 9, 'b'.repeat(64))
      .subscribe((event) => otherFileEvents.push(event));

    svc.onMediaMessageDownloadProgress({
      threadId: 3,
      seq: 9,
      status: 'downloading',
      completedFiles: 1,
      totalFiles: 2,
      activeFile: { digest: 'a'.repeat(64), name: 'a.png' },
    });
    svc.onMediaFileDownloadProgress({
      threadId: 3,
      seq: 9,
      file: { digest: 'a'.repeat(64), name: 'a.png' },
      status: 'downloading',
      loaded: 128,
      total: 256,
    });
    svc.completeMediaFileDownloadProgress({
      threadId: 3,
      seq: 9,
      file: { digest: 'a'.repeat(64), name: 'a.png' },
      status: 'ready',
      loaded: 256,
      total: 256,
    });
    svc.completeMediaMessageDownloadProgress({
      threadId: 3,
      seq: 9,
      status: 'ready',
      completedFiles: 2,
      totalFiles: 2,
      activeFile: null,
    });

    expect(messageEvents.map((event) => event.type)).toEqual([
      'MEDIA_MESSAGE_DOWNLOAD_PROGRESS',
      'MEDIA_MESSAGE_DOWNLOAD_PROGRESS',
    ]);
    expect(fileEvents.map((event) => event.type)).toEqual([
      'MEDIA_FILE_DOWNLOAD_PROGRESS',
      'MEDIA_FILE_DOWNLOAD_PROGRESS',
    ]);
    expect(otherFileEvents).toHaveLength(0);
    expect(messageSub.closed).toBe(true);
    expect(fileSub.closed).toBe(true);
    expect(otherFileSub.closed).toBe(false);
    otherFileSub.unsubscribe();
    svc.onModuleDestroy();
  });

  it('sends push revision only to matching sessions and thread wake-up only to its user', () => {
    const { svc } = makeService();
    const a = connect(svc, 7, 11);
    const tab = connect(svc, 7, 11);
    const b = connect(svc, 7, 22);
    const other = connect(svc, 8, 33);
    svc.onPushSubscriptionChanged(7, 11, 5);
    svc.onThreadFeedUpdated(7, { threadFeedEndId: 9 });
    expect(a.subscription.closed).toBe(true);
    expect(eventsOf(a, 'SSE_REPLACED')).toHaveLength(1);
    expect(eventsOf(a, 'PUSH_SUBSCRIPTION_CHANGED')).toHaveLength(0);
    expect(eventsOf(tab, 'PUSH_SUBSCRIPTION_CHANGED')).toHaveLength(1);
    expect(eventsOf(b, 'PUSH_SUBSCRIPTION_CHANGED')).toHaveLength(0);
    expect(eventsOf(tab, 'THREAD_FEED_UPDATED')[0].data).toEqual({
      threadFeedEndId: 9,
    });
    expect(eventsOf(other, 'THREAD_FEED_UPDATED')).toHaveLength(0);
    svc.onModuleDestroy();
  });

  it('throttles state and thread heads independently and sends the highest head', async () => {
    vi.useFakeTimers();
    const { svc } = makeService();
    try {
      const client = connect(svc, 7, 11);
      svc.onStateFeedUpdated(7, { feedId: 5 });
      await vi.advanceTimersByTimeAsync(400);
      svc.onStateFeedUpdated(7, { feedId: 9 });
      svc.onStateFeedUpdated(7, { feedId: 7 });
      svc.onThreadFeedUpdated(7, { threadFeedEndId: 3 });
      expect(eventsOf(client, 'THREAD_FEED_UPDATED')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600);
      expect(eventsOf(client, 'STATE_FEED_UPDATED').map((e) => e.data)).toEqual(
        [{ feedId: 5 }, { feedId: 9 }],
      );
      svc.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      svc.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('one device session has one stream; UUID and emitted head scope its receipts', async () => {
    vi.useFakeTimers();
    const { svc, database } = makeService();
    try {
      const firstStream = connect(svc, 7, 11);
      const other = connect(svc, 7, 22);
      svc.onThreadFeedUpdated(7, {
        threadFeedEndId: 4,
        notificationRelevant: true,
      });
      const first = eventsOf(firstStream, 'THREAD_FEED_UPDATED')[0].data as {
        sseUuid: string;
      };
      expect(
        (
          eventsOf(other, 'THREAD_FEED_UPDATED')[0].data as {
            sseUuid: string;
          }
        ).sseUuid,
      ).not.toBe(first.sseUuid);
      expect(await svc.confirmThreadReceipt(7, 22, first.sseUuid, 4)).toBe(
        false,
      );
      expect(await svc.confirmThreadReceipt(8, 11, first.sseUuid, 4)).toBe(
        false,
      );
      expect(await svc.confirmThreadReceipt(7, 11, first.sseUuid, 5)).toBe(
        false,
      );
      expect(await svc.confirmThreadReceipt(7, 11, first.sseUuid, 4)).toBe(
        true,
      );
      expect(svc.confirmedThreadHead(7, 11)).toBe(4);
      const current = connect(svc, 7, 11);
      expect(firstStream.subscription.closed).toBe(true);
      expect(eventsOf(firstStream, 'SSE_REPLACED')).toHaveLength(1);
      expect(svc.snapshot().total).toBe(2);
      svc.onThreadFeedUpdated(7, {
        threadFeedEndId: 5,
        notificationRelevant: true,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const second = eventsOf(current, 'THREAD_FEED_UPDATED')[0].data as {
        sseUuid: string;
      };
      expect(second.sseUuid).not.toBe(first.sseUuid);
      expect(await svc.confirmThreadReceipt(7, 11, first.sseUuid, 4)).toBe(
        false,
      );
      expect(svc.confirmedThreadHead(7, 11)).toBe(4);
      expect(await svc.confirmThreadReceipt(7, 11, second.sseUuid, 5)).toBe(
        true,
      );
      expect(svc.confirmedThreadHead(7, 11)).toBe(5);
      expect(database.db.update).not.toHaveBeenCalled();
    } finally {
      svc.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('does not poll database or send idle ping events', async () => {
    vi.useFakeTimers();
    const { svc, database } = makeService();
    try {
      const client = connect(svc, 7, 11);
      await vi.advanceTimersByTimeAsync(1);
      database.db.select.mockClear();
      await vi.advanceTimersByTimeAsync(70_000);
      expect(database.db.select).not.toHaveBeenCalled();
      expect(eventsOf(client, 'ping')).toHaveLength(0);
    } finally {
      svc.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('revokes only the current stream of a device session', () => {
    const { svc } = makeService();
    const old = connect(svc, 7, 11);
    const current = connect(svc, 7, 11);
    const other = connect(svc, 7, 22);
    expect(old.subscription.closed).toBe(true);
    svc.onSessionRevoked({ userId: 7, sessionId: 11, reason: 'device_revoke' });
    expect(eventsOf(current, 'FORCE_LOGOUT')[0].data).toMatchObject({
      message: 'device_revoke',
    });
    expect(current.subscription.closed).toBe(true);
    expect(other.subscription.closed).toBe(false);
    expect(svc.snapshot().total).toBe(1);
    svc.onModuleDestroy();
  });

  it('invalidates all sessions and ignores an unknown revoked session', () => {
    const { svc } = makeService();
    const a = connect(svc, 7, 11);
    const b = connect(svc, 7, 22);
    svc.onSessionRevoked({ userId: 7, sessionId: 99, reason: 'unknown' });
    expect(svc.snapshot().total).toBe(2);
    svc.onSessionsInvalidated({ userId: 7, reason: 'password_change' });
    expect(eventsOf(a, 'FORCE_LOGOUT')).toHaveLength(1);
    expect(eventsOf(b, 'FORCE_LOGOUT')).toHaveLength(1);
    expect(svc.snapshot().total).toBe(0);
    svc.onModuleDestroy();
  });

  it('unsubscribes after an actual HTTP disconnect and flushes framework SSE headers', async () => {
    const { svc } = makeService();
    const app = await serve(svc);
    const request = get(`${await app.getUrl()}/events`, {
      headers: { Origin: 'https://tauri.localhost' },
    });
    try {
      const [response] = await once(request, 'response');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');
      expect(response.headers['access-control-allow-origin']).toBe(
        'https://tauri.localhost',
      );
      const chunks: string[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
      await vi.waitFor(() => expect(chunks.join('')).toContain('event: HELLO'));
      expect(chunks.join('')).toContain('"stateFeedEndId":4');
      expect(chunks.join('')).toContain('id:');
      await vi.waitFor(() => expect(svc.snapshot().total).toBe(1));
      request.destroy();
      await vi.waitFor(() => expect(svc.snapshot().total).toBe(0));
    } finally {
      request.destroy();
      await app.close();
    }
  });

  it('ends held streams when Nest shuts down', async () => {
    const { svc } = makeService();
    const app = await serve(svc);
    const request = get(`${await app.getUrl()}/events`);
    let closing: Promise<void> | undefined;
    try {
      const [response] = await once(request, 'response');
      response.resume();
      const ended = once(response, 'end');
      closing = app.close();
      await Promise.race([
        Promise.all([closing, ended]),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('SSE shutdown blocked')), 1500),
        ),
      ]);
      expect(svc.snapshot().total).toBe(0);
    } finally {
      request.destroy();
      app.getHttpServer().closeAllConnections();
      await (closing ?? app.close());
    }
  });
});
