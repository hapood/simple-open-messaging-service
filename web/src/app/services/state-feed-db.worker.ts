/// <reference lib="webworker" />

import { WebdbStorage } from './webdb-storage';
import type { ClientStateFeedItem } from './user.service';
import { syncThreadFeed, coalesceThreadFeedWakes } from './thread-feed-sync';
import type { GroupMetaProfileReference } from './group-meta-model';
import {
  isProfileSelector,
  type ProfileKey,
  type ProfileSelector,
} from '../../../../shared/profile-selector';

interface ApplyRequest {
  id: number;
  type: 'apply';
  userId: string;
  items: ClientStateFeedItem[];
  feedId: number;
  resetProjection: boolean;
}

const storage = new WebdbStorage();
// Forward committed snapshots, including immediate HTTP READY responses.
storage.profileWake$.subscribe((wake) =>
  postMessage({ type: 'profile-wake', wake }),
);
let openedUserId: string | null = null;
let queue = Promise.resolve();
let feedPort: MessagePort | null = null;

interface ResolvedProfile {
  namespaceId: number;
  account: string;
  domain: string;
  rev: number;
  name: string;
  bio: string;
  avatarBase64: string | null;
}

type ProfileResolutionAttempt =
  | { status: 'READY'; profile: ResolvedProfile }
  | { status: 'PENDING'; key: ProfileKey };

const requestProfile = (url: string) => async (selector: ProfileSelector) => {
  const cached = await storage.findProfileForEvidence(selector);
  if (cached) return { status: 'READY', profile: cached } as const;
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
    message?: string;
    data?:
      | { status: 'PENDING'; key: unknown }
      | { status: 'READY'; profile: ResolvedProfile };
  };
  if (envelope.code !== 0 || !envelope.data)
    throw new Error(envelope.message ?? 'profile resolution failed');
  if (envelope.data.status === 'PENDING')
    return envelope.data as ProfileResolutionAttempt;
  return {
    status: 'READY',
    profile: await storage.commitResolvedProfile(envelope.data.profile),
  } as const;
};

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
            type: 'GROUP_META' as const,
            threadId: reference.threadId,
            profileRev: reference.rev,
            subject: { type: 'GROUP' as const },
          }
        : {
            type: 'GROUP_META' as const,
            threadId: reference.threadId,
            profileRev: reference.rev,
            subject: {
              type: 'MEMBER' as const,
              account: reference.account,
              domain: reference.domain,
            },
          };
    return (await requestProfile(url)(selector)).status === 'READY';
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
    }
  | {
      id: number;
      type: 'resolve-profile';
      userId: string;
      selector: ProfileSelector;
      profileResolutionUrl: string;
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
                  aliases: result.states.flatMap(({ server }) =>
                    server
                      ? [
                          {
                            threadId: server.threadId,
                            threadFeedId: server.threadFeedId,
                            alias: server.alias,
                          },
                        ]
                      : [],
                  ),
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
            data?: unknown;
          };
          if (
            message.event === 'PROFILE_AVAILABLE' ||
            message.event === 'PROFILE_UNAVAILABLE'
          ) {
            const key = profileKey(message.data);
            if (!key) return;
            queue = queue.then(async () => {
              try {
                if (message.event === 'PROFILE_AVAILABLE') {
                  await requestProfile(data.profileResolutionUrl)({
                    type: 'EXACT',
                    account: key.account,
                    domain: key.domain,
                    rev: key.rev,
                  });
                  // An exact snapshot wake also reaches independent consumers of
                  // this revision; the evidence wake settles its invoking method.
                  const evidence =
                    message.data && typeof message.data === 'object' &&
                    'evidence' in message.data &&
                    isProfileSelector(message.data.evidence)
                      ? message.data.evidence : undefined;
                  if (evidence) {
                    await storage.applyGroupMetaProfileDrift(evidence, key);
                    postMessage({
                      type: 'profile-wake',
                      wake: { event: 'PROFILE_AVAILABLE', key, evidence },
                    });
                  }
                  return;
                }
                const reason =
                  message.data &&
                  typeof message.data === 'object' &&
                  typeof (message.data as { reason?: unknown }).reason ===
                    'string'
                    ? (message.data as { reason: string }).reason
                    : 'TEMPORARILY_UNAVAILABLE';
                postMessage({
                  type: 'profile-wake',
                  wake: { event: 'PROFILE_UNAVAILABLE', key, reason },
                });
              } catch (error) {
                console.warn('[profile] event materialization failed', error);
              }
            });
            return;
          }
          if (typeof message.target === 'number') wake(message.target);
        };
        port.start();
        postMessage({ id: data.id, ok: true });
        return;
      }
      if (data.type === 'resolve-profile') {
        const result = await requestProfile(data.profileResolutionUrl)(
          data.selector,
        );
        postMessage({ id: data.id, ok: true, result });
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
            groupThreadIds: result.groupThreadIds,
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

function profileKey(value: unknown): ProfileKey | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const key = value as Partial<ProfileKey>;
  if (
    !Number.isSafeInteger(key.namespaceId) ||
    Number(key.namespaceId) < 0 ||
    typeof key.account !== 'string' ||
    !key.account ||
    typeof key.domain !== 'string' ||
    !key.domain ||
    !Number.isSafeInteger(key.rev) ||
    Number(key.rev) < 1
  )
    return;
  return {
    namespaceId: Number(key.namespaceId),
    account: key.account,
    domain: key.domain,
    rev: Number(key.rev),
  };
}
