/// <reference lib="webworker" />

import { WebdbStorage } from './webdb-storage';
import { attentionSnapshot } from '../../../../shared/thread-attention';
import {
  coalesceGroupMetaWakes,
  coalesceThreadFeedWakes,
} from './thread-feed-sync';
import { TrailingSingleFlight } from '../../../../shared/trailing-single-flight';
import { syncGroupMeta, syncGroupMetaThread } from './group-meta-sync';
import { syncTombstoneThread } from './tombstone-sync';
import { synchronizeStateFeed } from './worker-state-feed-sync';
import { syncPushThreads, type PushThreadResult } from './push-thread-sync';
import { PreferenceStorage } from './preference-storage';
import { apiPrefix } from './constants';
import en from '../i18n/en.json';
import zh from '../i18n/zh-CN.json';
import type { GroupMetaProfileReference } from './group-meta-model';
import type { DeletedMessageItem } from './model';
import {
  type ProfileDemand,
  type ProfileKey,
} from '../../../../shared/profile-demand';

const storage = new WebdbStorage();
const preferences = new PreferenceStorage();

// API endpoints are worker-local configuration, not per-event payload. Same-origin
// relative paths work in the worker scope; the dev proxy / Tauri backend match them.
const URLS = {
  threadFeed: `${apiPrefix()}/thread-feed`,
  groupMeta: `${apiPrefix()}/user/group-meta`,
  stateFeed: `${apiPrefix()}/user/state-feed`,
  tombstone: `${apiPrefix()}/deleted-messages/query`,
  profileResolution: `${apiPrefix()}/user/profile-resolution`,
} as const;

// Forward committed snapshots, including immediate HTTP READY responses.
storage.profileWake$.subscribe((wake) =>
  postMessage({ type: 'profile-wake', wake }),
);
let openedUserId: string | null = null;
let storageLifecycle = Promise.resolve();
let activeStorageUsers = 0;
const idleWaiters: Array<() => void> = [];

let feedPort: MessagePort | null = null;

/** The thread the UI currently has open, or null when none. Each per-thread drain
 *  checks this after committing a page and before starting the next: a page
 *  already in flight finishes and commits; this only prevents the NEXT page. */
let openThreadId: number | null = null;

/** Per-thread Group Meta drains. Different threads run concurrently; the same
 *  thread coalesces (one trailing round keeps the newest target). */
const groupMetaDrains = new Map<number, TrailingSingleFlight<string>>();
/** Per-thread tombstone drains, same coalescing policy as Group Meta. */
const tombstoneDrains = new Map<number, TrailingSingleFlight<number>>();

type StorageRelease = () => void;

function waitForStorageIdle(): Promise<void> {
  if (activeStorageUsers === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function notifyStorageIdle(): void {
  if (activeStorageUsers !== 0) return;
  const waiters = idleWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

async function acquireUserStorage(userId: string): Promise<StorageRelease> {
  const acquire = storageLifecycle.then(async () => {
    if (openedUserId !== userId) {
      await waitForStorageIdle();
      if (openedUserId !== null) await storage.close();
      await storage.openForUser(userId);
      openedUserId = userId;
    }
    activeStorageUsers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeStorageUsers -= 1;
      notifyStorageIdle();
    };
  });
  storageLifecycle = acquire.then(
    () => undefined,
    () => undefined,
  );
  return acquire;
}

async function withUserStorage<T>(
  userId: string,
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquireUserStorage(userId);
  try {
    return await run();
  } finally {
    release();
  }
}

function enqueueConcurrent(task: () => Promise<void>): void {
  void task().catch((error) => {
    console.warn('[worker] scheduled task failed', error);
  });
}

async function synchronizeNotifications(
  userId: string,
  target: number,
): Promise<PushThreadResult> {
  const language =
    (await preferences.get<string>('global', 'language')) ?? navigator.language;
  const locale = language.startsWith('zh') ? zh : en;
  const result = await syncPushThreads(
    storage,
    Number(userId),
    target,
    requestThreadFeed,
    preferences,
    {
      lang: language,
      privateBody: locale.settings.notifNewMessage,
      retracted: '[' + locale.chat.messageRetracted + ']',
      removed: '[' + locale.chat.messageRemovedByAdmin + ']',
    },
    requestGroupMeta,
    resolveGroupMetaProfile,
  );
  if (result.notifications.length && openedUserId === userId) {
    const feedIds = new Map(
      result.states.flatMap((state) =>
        state.threadFeedId !== null
          ? [[state.threadId, state.threadFeedId] as const]
          : [],
      ),
    );
    postMessage({
      type: 'notification-batch',
      userId: Number(userId),
      entries: result.notifications.flatMap((descriptor) => {
        const feedId = feedIds.get(descriptor.data.threadId ?? -1);
        return feedId === undefined ? [] : [{ feedId, descriptor }];
      }),
    });
  }
  return result;
}

interface ResolvedProfile {
  publisherNamespaceId: number;
  profileNamespaceId: number;
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

const requestProfile = async (demand: ProfileDemand) => {
  const cached = await storage.findProfileForDemand(demand);
  if (cached) return { status: 'READY', profile: cached } as const;
  const response = await fetch(URLS.profileResolution, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(demand),
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
  const profile = envelope.data.profile;
  return {
    status: 'READY',
    profile: await storage.commitResolvedProfile({
      publisherNamespaceId: profile.publisherNamespaceId,
      profileNamespaceId: profile.profileNamespaceId,
      account: profile.account,
      rev: profile.rev,
      name: profile.name,
      bio: profile.bio,
      avatarBase64: profile.avatarBase64,
    }),
  } as const;
};

const requestStateFeed = async (query: {
  mode: 'full' | 'delta';
  after: number;
  through: number;
  take: number;
}) => {
  const params = new URLSearchParams({
    mode: query.mode,
    after: String(query.after),
    through: String(query.through),
    take: String(query.take),
  });
  const response = await fetch(`${URLS.stateFeed}?${params}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`state feed HTTP ${response.status}`);
  return response.json();
};

const requestThreadFeed = async (body: unknown) => {
  const response = await fetch(URLS.threadFeed, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`thread feed HTTP ${response.status}`);
  return response.json();
};

const requestGroupMeta = async (input: {
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
  const response = await fetch(`${URLS.groupMeta}?${query.toString()}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`group-meta HTTP ${response.status}`);
  return response.json();
};

const requestTombstone = async (input: {
  threadId: number;
  after: number;
  take: number;
  through: number;
  maxMessageSeq?: number;
}) => {
  const response = await fetch(URLS.tombstone, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      threadId: input.threadId,
      after: input.after,
      take: input.take,
      through: input.through,
      ...(input.maxMessageSeq === undefined
        ? {}
        : { maxMessageSeq: input.maxMessageSeq }),
    }),
  });
  if (!response.ok)
    throw new Error(`tombstone query HTTP ${response.status}`);
  return response.json();
};

const resolveGroupMetaProfile = async (
  reference: GroupMetaProfileReference,
) => {
  const demand: ProfileDemand =
    reference.type === 'GROUP'
      ? {
          publisherNamespaceId: reference.namespaceId,
          lookup: 'ACCOUNT_PROFILE',
          target: {
            profileNamespaceId: reference.namespaceId,
            account: reference.account,
            rev: reference.rev,
          },
        }
      : {
          publisherNamespaceId: reference.namespaceId,
          lookup: 'GROUP_MEMBER_PROFILE',
          target: {
            profileNamespaceId: reference.namespaceId,
            account: reference.account,
            rev: reference.rev,
          },
          groupAccount: await storage.groupAccountForThread(
            reference.threadId,
          ),
        };
  return (await requestProfile(demand)).status === 'READY';
};

const synchronizeGroupMeta = async (): Promise<number[]> =>
  syncGroupMeta(
    storage,
    requestGroupMeta,
    resolveGroupMetaProfile,
  );

type Request =
  | {
      id: number;
      type: 'bind-thread-feed';
      userId: string;
      port: MessagePort;
    }
  | {
      id: number;
      type: 'thread-sync';
      userId: string;
      target: number;
      after: number;
    }
  | {
      id: number;
      type: 'resolve-profile';
      userId: string;
      demand: ProfileDemand;
    }
  | {
      id: number;
      type: 'drain-thread-misc';
      userId: string;
      threadId: number | null;
      groupMetaEndId: string;
      tombstoneEndSeq: number;
    };

addEventListener('message', ({ data }: MessageEvent<Request>) => {
  void (async () => {
    try {
      const release = await acquireUserStorage(data.userId);
      try {
        if (data.type === 'bind-thread-feed') {
          feedPort?.close();
          const port = data.port;
          feedPort = port;
          const groupMetaWake = coalesceGroupMetaWakes(
            (task) => {
              enqueueConcurrent(() => withUserStorage(data.userId, task));
            },
            async (_target) => {
              if (feedPort !== port) return;
              try {
                const groupThreadIds = await synchronizeGroupMeta();
                if (feedPort === port)
                  port.postMessage({
                    userId: Number(data.userId),
                    changes: groupThreadIds.length ? ['GROUP_META'] : [],
                    groupThreadIds,
                  });
              } catch (error) {
                console.warn(
                  '[group-meta] wake failed; next wake retries',
                  error,
                );
              }
            },
          );
          const wake = coalesceThreadFeedWakes(
            (task) => {
              enqueueConcurrent(() => withUserStorage(data.userId, task));
            },
            async (target) => {
              if (feedPort !== port) return;
              try {
                const result = await synchronizeNotifications(
                  data.userId,
                  target,
                );
                if (result.error)
                  console.warn(
                    '[thread-feed] wake failed; next wake retries',
                    result.error,
                  );
                if (!result.error) groupMetaWake(target);
                if (feedPort === port)
                  port.postMessage({
                    userId: Number(data.userId),
                    cursor: result.cursor,
                    changes: result.states.length ? ['THREADS'] : [],
                    groupThreadIds: [],
                    aliases: result.states.flatMap((state) =>
                      state.threadFeedId !== null
                        ? [
                            {
                              threadId: state.threadId,
                              threadFeedId: state.threadFeedId,
                              alias: state.alias,
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
          const wakeState = coalesceThreadFeedWakes(
            (task) => {
              enqueueConcurrent(() => withUserStorage(data.userId, task));
            },
            async (target) => {
              if (feedPort !== port) return;
              try {
                const cursor = await synchronizeStateFeed(
                  storage,
                  target,
                  requestStateFeed,
                );
                if (feedPort === port)
                  port.postMessage({
                    stateCommit: { userId: Number(data.userId), cursor },
                  });
              } catch (error) {
                console.warn(
                  '[state-feed] wake failed; next wake retries',
                  error,
                );
              }
            },
          );
          port.onmessage = (event) => {
            if (feedPort !== port) return;
            const message = event.data as {
              stateTarget?: unknown;
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
              enqueueConcurrent(() =>
                withUserStorage(data.userId, async () => {
                  try {
                    if (message.event === 'PROFILE_AVAILABLE') {
                      await requestProfile({
                        publisherNamespaceId: key.publisherNamespaceId,
                        lookup: 'ACCOUNT_PROFILE',
                        target: {
                          profileNamespaceId: key.profileNamespaceId,
                          account: key.account,
                          rev: key.rev,
                        },
                      });
                      postMessage({
                        type: 'profile-wake',
                        wake: { event: 'PROFILE_AVAILABLE', key },
                      });
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
                    console.warn(
                      '[profile] event materialization failed',
                      error,
                    );
                  }
                }),
              );
              return;
            }
            if (typeof message.stateTarget === 'number')
              wakeState(message.stateTarget);
            if (typeof message.target === 'number') wake(message.target);
          };
          port.start();
          postMessage({ id: data.id, ok: true });
          return;
        }
        if (data.type === 'resolve-profile') {
          const result = await requestProfile(data.demand);
          postMessage({ id: data.id, ok: true, result });
          return;
        }
        if (data.type === 'thread-sync') {
          const result = await synchronizeNotifications(
            data.userId,
            data.target,
          );
          let groupThreadIds: number[] = [];
          let error = result.error;
          if (!error) {
            try {
              groupThreadIds = await synchronizeGroupMeta();
            } catch (groupError) {
              error =
                groupError instanceof Error
                  ? groupError.message
                  : String(groupError);
            }
          }
          const changes = await storage.readThreadFeedChanges(data.after);
          const notificationStates = new Map(
            result.states.map((state) => [state.threadId, state]),
          );
          postMessage({
            id: data.id,
            ok: true,
            result: {
              ...changes,
              groupThreadIds,
              states: changes.states.map((state) => {
                const transient = notificationStates.get(state.threadId);
                const previewSource = attentionSnapshot(transient);
                return previewSource &&
                  state.threadFeedId === previewSource.threadFeedId
                  ? { ...state, previews: previewSource.previews }
                  : state;
              }),
              ...(error ? { error } : {}),
            },
          });
          return;
        }
        if (data.type === 'drain-thread-misc') {
          if (data.threadId === null) {
            // Stop signal: the current page finishes and commits; the guard
            // prevents the next page once `openThreadId` no longer matches.
            openThreadId = null;
            postMessage({ id: data.id, ok: true });
            return;
          }
          openThreadId = data.threadId;
          const threadId = data.threadId;
          const guard = () => openThreadId === threadId;
          // Group Meta drain (groups only; non-groups no-op inside).
          let groupMetaFlight = groupMetaDrains.get(threadId);
          if (!groupMetaFlight) {
            groupMetaFlight = new TrailingSingleFlight<string>(async (target) => {
              try {
                const changed = await syncGroupMetaThread(
                  storage,
                  requestGroupMeta,
                  resolveGroupMetaProfile,
                  threadId,
                  target,
                  guard,
                );
                if (feedPort && changed.length)
                  feedPort.postMessage({
                    userId: Number(data.userId),
                    changes: ['GROUP_META'],
                    groupThreadIds: changed,
                  });
              } catch (error) {
                console.warn(
                  '[group-meta] per-thread drain failed; next wake retries',
                  error,
                );
              }
            });
            groupMetaDrains.set(threadId, groupMetaFlight);
          }
          // Tombstone drain.
          let tombstoneFlight = tombstoneDrains.get(threadId);
          if (!tombstoneFlight) {
            tombstoneFlight = new TrailingSingleFlight<number>(async (target) => {
              try {
                const committed = await syncTombstoneThread(
                  storage,
                  requestTombstone,
                  threadId,
                  target,
                  undefined,
                  guard,
                );
                if (committed.length)
                  postMessage({
                    type: 'tombstone-committed',
                    threadId,
                    tombstones: committed.map((item) => ({
                      seq: item.messageSeq,
                      type: item.type,
                    })),
                  });
              } catch (error) {
                console.warn(
                  '[tombstone] per-thread drain failed; next wake retries',
                  error,
                );
              }
            });
            tombstoneDrains.set(threadId, tombstoneFlight);
          }
          // Fire both concurrently; they share one `openThreadId` guard.
          await Promise.all([
            groupMetaFlight.trigger(data.groupMetaEndId),
            tombstoneFlight.trigger(data.tombstoneEndSeq),
          ]);
          postMessage({ id: data.id, ok: true });
          return;
        }
      } finally {
        release();
      }
    } catch (error) {
      postMessage({
        id: data.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});

function profileKey(value: unknown): ProfileKey | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const key = value as Partial<ProfileKey>;
  if (
    !Number.isSafeInteger(key.publisherNamespaceId) ||
    Number(key.publisherNamespaceId) < 0 ||
    !Number.isSafeInteger(key.profileNamespaceId) ||
    Number(key.profileNamespaceId) < 0 ||
    typeof key.account !== 'string' ||
    !key.account ||
    !Number.isSafeInteger(key.rev) ||
    Number(key.rev) < 1
  )
    return;
  return {
    publisherNamespaceId: Number(key.publisherNamespaceId),
    profileNamespaceId: Number(key.profileNamespaceId),
    account: key.account,
    rev: Number(key.rev),
  };
}
