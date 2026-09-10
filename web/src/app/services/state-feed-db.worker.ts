/// <reference lib="webworker" />

import { WebdbStorage, type ClientGroupMetaApply } from './webdb-storage';
import type { ClientStateFeedItem } from './user.service';
import { syncThreadFeed, coalesceThreadFeedWakes } from './thread-feed-sync';

interface ApplyRequest {
  id: number;
  type: 'apply';
  userId: string;
  items: ClientStateFeedItem[];
  feedId: number;
  groupMeta: readonly ClientGroupMetaApply[];
  resetProjection: boolean;
}

const storage = new WebdbStorage();
let openedUserId: string | null = null;
let queue = Promise.resolve();
let feedPort: MessagePort | null = null;

const requestThreadFeed = (url: string) => async (body: unknown) => {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`thread feed HTTP ${response.status}`);
  return response.json();
};

type Request =
  | ApplyRequest
  | {
      id: number;
      type: 'bind-thread-feed';
      userId: string;
      url: string;
      port: MessagePort;
    }
  | {
      id: number;
      type: 'thread-sync';
      userId: string;
      target: number;
      after: number;
      url: string;
    };

addEventListener('message', ({ data }: MessageEvent<Request>) => {
  queue = queue.then(async () => {
    try {
      if (openedUserId !== data.userId) {
        if (openedUserId !== null) await storage.close();
        await storage.openForUser(data.userId);
        openedUserId = data.userId;
      }
      if (data.type === 'bind-thread-feed') {
        feedPort?.close();
        const port = data.port;
        feedPort = port;
        const wake = coalesceThreadFeedWakes(
          (task) => {
            queue = queue.then(task);
          },
          async (target) => {
            if (feedPort !== port) return;
            try {
              const result = await syncThreadFeed(
                storage,
                target,
                requestThreadFeed(data.url),
              );
              if (result.error)
                console.warn(
                  '[thread-feed] wake failed; next wake retries',
                  result.error,
                );
              if (feedPort === port)
                port.postMessage({
                  userId: Number(data.userId),
                  cursor: result.cursor,
                });
            } catch (error) {
              console.warn(
                '[thread-feed] wake unavailable; next wake retries',
                error,
              );
            }
          },
        );
        port.onmessage = (event) => {
          if (feedPort === port) wake(event.data?.target);
        };
        port.start();
        postMessage({ id: data.id, ok: true });
        return;
      }
      if (data.type === 'thread-sync') {
        const result = await syncThreadFeed(
          storage,
          data.target,
          requestThreadFeed(data.url),
        );
        const changes = await storage.readThreadFeedChanges(data.after);
        postMessage({
          id: data.id,
          ok: true,
          result: {
            ...changes,
            ...(result.error ? { error: result.error } : {}),
          },
        });
        return;
      }
      await storage.applyStateFeedPage(
        data.items,
        data.feedId,
        data.groupMeta,
        data.resetProjection,
      );
      postMessage({ id: data.id, ok: true });
    } catch (error) {
      postMessage({
        id: data.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});
