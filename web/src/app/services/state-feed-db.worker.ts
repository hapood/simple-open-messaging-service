/// <reference lib="webworker" />

import { WebdbService, type ClientGroupMetaApply } from './webdb.service';
import type { ClientStateFeedItem } from './user.service';

interface ApplyRequest {
  id: number;
  type: 'apply';
  userId: string;
  items: ClientStateFeedItem[];
  feedId: number;
  groupMeta: readonly ClientGroupMetaApply[];
  resetProjection: boolean;
}

const storage = new WebdbService();
let openedUserId: string | null = null;
let queue = Promise.resolve();

addEventListener('message', ({ data }: MessageEvent<ApplyRequest>) => {
  queue = queue.then(async () => {
    try {
      if (openedUserId !== data.userId) {
        if (openedUserId !== null) await storage.close();
        await storage.openForUser(data.userId);
        openedUserId = data.userId;
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
