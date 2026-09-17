/// <reference lib="webworker" />

import { WebdbStorage } from './webdb-storage';
import type { ClientStateFeedItem } from './user.service';
import { syncThreadFeed, coalesceThreadFeedWakes } from './thread-feed-sync';
import type { GroupMetaProfileReference } from './group-meta-model';

interface ApplyRequest {
  id: number;
  type: 'apply';
  userId: string;
  items: ClientStateFeedItem[];
  feedId: number;
  resetProjection: boolean;
}

const storage = new WebdbStorage();
let openedUserId: string | null = null;
let queue = Promise.resolve();
let feedPort: MessagePort | null = null;
const pendingProfiles = new Map<string, GroupMetaProfileReference>();

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

const requestGroupMeta =
  (url: string) =>
  async (input: {
    threadId: number;
    mode: 'full' | 'delta';
    after: string;
    through: string;
    take: number;
  }) => {
    const query = new URLSearchParams({
      threadId: String(input.threadId),
      mode: input.mode,
      after: input.after,
      through: input.through,
      take: String(input.take),
    });
    const response = await fetch(`${url}?${query.toString()}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`group-meta HTTP ${response.status}`);
    return response.json();
  };

const resolveGroupMetaProfile =
  (url: string) => async (reference: GroupMetaProfileReference) => {
    const selector =
      reference.type === 'GROUP'
        ? {
            type: 'EXACT' as const,
            account: reference.account,
            domain: reference.domain,
            rev: reference.rev,
          }
        : {
            type: 'GROUP_MEMBER' as const,
            threadId: reference.threadId,
            memberAccount: reference.account,
            memberDomain: reference.domain,
          };
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(selector),
    });
    if (!response.ok)
      throw new Error(`profile-resolution HTTP ${response.status}`);
    const envelope = (await response.json()) as {
      code?: number;
      data?:
        | { status: 'PENDING'; requestId: string }
        | {
            status: 'READY';
            profile: Parameters<
              WebdbStorage['commitResolvedGroupMetaProfile']
            >[1];
          };
    };
    if (envelope.code !== 0 || !envelope.data)
      throw new Error('profile resolution failed');
    if (envelope.data.status === 'PENDING') {
      pendingProfiles.set(envelope.data.requestId, reference);
      return false;
    }
    return storage.commitResolvedGroupMetaProfile(
      reference,
      envelope.data.profile,
    );
  };

type Request =
  | ApplyRequest
  | {
      id: number;
      type: 'bind-thread-feed';
      userId: string;
      url: string;
      groupMetaUrl: string;
      profileResolutionUrl: string;
      port: MessagePort;
    }
  | {
      id: number;
      type: 'thread-sync';
      userId: string;
      target: number;
      after: number;
      url: string;
      groupMetaUrl: string;
      profileResolutionUrl: string;
    };

addEventListener('message', ({ data }: MessageEvent<Request>) => {
  queue = queue.then(async () => {
    try {
      if (openedUserId !== data.userId) {
        if (openedUserId !== null) await storage.close();
        pendingProfiles.clear();
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
                requestGroupMeta(data.groupMetaUrl),
                resolveGroupMetaProfile(data.profileResolutionUrl),
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
                  changes: [
                    ...(result.states.length ? ['THREADS'] : []),
                    ...(result.groupThreadIds.length ? ['GROUP_META'] : []),
                  ],
                  groupThreadIds: result.groupThreadIds,
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
          if (feedPort !== port) return;
          const message = event.data as {
            target?: unknown;
            event?: unknown;
            data?: {
              requestId?: unknown;
              profile?: Parameters<
                WebdbStorage['commitResolvedGroupMetaProfile']
              >[1];
            };
          };
          if (message.event === 'PROFILE_RESOLVED') {
            const requestId = message.data?.requestId;
            if (typeof requestId !== 'string') return;
            const reference = pendingProfiles.get(requestId);
            if (!reference || !message.data?.profile) return;
            pendingProfiles.delete(requestId);
            queue = queue.then(async () => {
              await storage.commitResolvedGroupMetaProfile(
                reference,
                message.data!.profile!,
              );
              if (feedPort === port)
                port.postMessage({
                  userId: Number(data.userId),
                  cursor: 0,
                  changes: ['PROFILE'],
                  groupThreadIds: [reference.threadId],
                });
            });
            return;
          }
          if (message.event === 'PROFILE_FAILED') {
            const requestId = message.data?.requestId;
            if (typeof requestId === 'string')
              pendingProfiles.delete(requestId);
            return;
          }
          wake(message.target);
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
          requestGroupMeta(data.groupMetaUrl),
          resolveGroupMetaProfile(data.profileResolutionUrl),
        );
        const changes = await storage.readThreadFeedChanges(data.after);
        const notificationStates = new Map(
          result.states.map((state) => [state.threadId, state]),
        );
        postMessage({
          id: data.id,
          ok: true,
          result: {
            ...changes,
            states: changes.states.map((state) => {
              const transient = notificationStates.get(state.threadId);
              return transient?.server &&
                state.server &&
                transient.server.threadFeedId === state.server.threadFeedId
                ? {
                    ...state,
                    server: {
                      ...state.server,
                      previews: transient.server.previews,
                    },
                  }
                : state;
            }),
            ...(result.error ? { error: result.error } : {}),
          },
        });
        return;
      }
      await storage.applyStateFeedPage(
        data.items,
        data.feedId,
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
