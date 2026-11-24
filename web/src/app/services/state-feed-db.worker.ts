/// <reference lib="webworker" />

import { LoginConnection } from './session/login-connection';
import { WebdbStorage } from './webdb-storage';
import { BusinessCode } from './biz-code';
import { coalesceThreadFeedWakes } from './thread-feed-sync';
import { TrailingSingleFlight } from '../../../../shared/trailing-single-flight';
import { parseNotificationTarget } from '../../../../shared/notification-target';
import { syncGroupMetaPage } from './group-meta-sync';
import { syncTombstonePage } from './tombstone-sync';
import { ThreadResourceScheduler } from './thread-resource-scheduler';
import { syncPushState } from './push-state-sync';
import { syncPushThreads, type PushThreadResult } from './push-thread-sync';
import { PreferenceStorage } from './preference-storage';
import {
  restoreSessionCacheDescriptor,
  type SessionCacheDescriptor,
} from './session/session-identity';
import { apiPrefix } from './constants';
import en from '../i18n/en.json';
import zh from '../i18n/zh-CN.json';
import {
  type ProfileDemand,
  type ProfileKey,
} from '../../../../shared/profile-demand';

const storage = new WebdbStorage(() => null);
const preferences = new PreferenceStorage();

storage.messageDbCommitted$.subscribe((event) => {
  postMessage({ type: 'message-db-committed', ...event });
  resourceScheduler.wakeTomb(event.threadId);
});

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
// A worker is assigned once. It can never be rebound to a successor session.
let workerLogin: LoginConnection | undefined;
let storageLifecycle = Promise.resolve();
let activeStorageUsers = 0;
const idleWaiters: Array<() => void> = [];

let feedPort: MessagePort | null = null;

storage.threadFeedCommitted$.subscribe(({ userId, states }) => {
  postMessage({ type: 'thread-feed-committed', userId, states });
  if (openedUserId === String(userId)) {
    void withUserStorage(String(userId), () =>
      schedulePendingThreadResources(),
    ).catch(() => undefined);
  }
});

const resourceScheduler = new ThreadResourceScheduler({
  runTombPage: async (threadId) => {
    const userId = openedUserId;
    if (!userId) return { status: 'DONE' };
    return withUserStorage(userId, async () => {
      const heads = await storage.getThreadResourceHeads();
      const target =
        heads.find((item) => item.threadId === threadId)?.tombstoneEndSeq ??
        null;
      if (target === null) return { status: 'DONE' };
      const result = await syncTombstonePage(
        storage,
        requestTombstone,
        threadId,
        target,
      );
      if (result.committed.length > 0) {
        postMessage({
          type: 'tombstone-committed',
          threadId,
          tombstones: result.committed.map((item) => ({
            seq: item.messageSeq,
            type: item.type,
          })),
        });
      }
      if (result.status === 'CUTOFF_STALLED') {
        return {
          status: 'CUTOFF_STALLED',
          target: result.target,
          cutoff: result.cutoff,
        };
      }
      return { status: result.status };
    });
  },
  runMetaPage: async (threadId) => {
    const userId = openedUserId;
    if (!userId) return { status: 'DONE' };
    return withUserStorage(userId, async () => {
      const result = await syncGroupMetaPage(
        storage,
        requestGroupMeta,
        threadId,
      );
      if (result.changed) {
        postMessage({
          type: 'group-meta-committed',
          userId: Number(userId),
          threadIds: [threadId],
          patches: result.patch ? [result.patch] : [],
        });
      }
      return { status: result.status };
    });
  },
  readTombProgress: async (threadId) => {
    const userId = openedUserId;
    if (!userId) return null;
    return withUserStorage(userId, async () => {
      const heads = await storage.getThreadResourceHeads();
      const target =
        heads.find((item) => item.threadId === threadId)?.tombstoneEndSeq ??
        null;
      if (target === null) return null;
      const [hwm, cutoff] = await Promise.all([
        storage.getDeletedHwm(threadId),
        storage.getTombstoneCutoff(threadId),
      ]);
      return { target, hwm, cutoff };
    });
  },
  onError: (lane, threadId, error) => {
    console.warn(
      `[${lane === 'tomb' ? 'tombstone' : 'group-meta'}] scheduled round failed for thread ${threadId}; retrying with backoff`,
      error,
    );
  },
});

async function schedulePendingThreadResources(): Promise<void> {
  const pending = await storage.getPendingThreadResourceWork();
  for (const threadId of pending.tombThreadIds) {
    resourceScheduler.wakeTomb(threadId);
  }
  for (const threadId of pending.metaThreadIds) {
    resourceScheduler.wakeMeta(threadId);
  }
}

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
  const login = workerLogin;
  if (!login) throw new Error('database worker login is not initialized');
  login.assertAccount(userId);
  const acquire = storageLifecycle.then(async () => {
    login.assertAccount(userId);
    if (openedUserId !== userId) {
      await waitForStorageIdle();
      if (openedUserId !== null) await storage.close();
      if (workerLogin?.id) await storage.openExistingForUser(userId);
      else await storage.openForUser(userId);
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
  );
  if (openedUserId === userId) {
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
      syncComplete: !result.error,
      entries: result.notifications.flatMap((descriptor) => {
        const target = parseNotificationTarget(descriptor.data.target);
        const feedId =
          target?.kind === 'thread' ? feedIds.get(target.threadId) : undefined;
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
  rev: number;
  name: string;
  bio: string;
  avatarBase64: string | null;
}

type ProfileResolutionAttempt =
  | { status: 'READY'; profile: ResolvedProfile }
  | { status: 'PENDING'; key: ProfileKey };

const requestProfile = async (
  demand: ProfileDemand,
  options: { evidence?: null } = {},
) => {
  const cached = await storage.findProfileForDemand(demand);
  if (cached) return { status: 'READY', profile: cached } as const;
  const response = await fetch(URLS.profileResolution, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      Object.hasOwn(options, 'evidence')
        ? { demand, evidence: options.evidence }
        : demand,
    ),
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
  if (envelope.code === BusinessCode.FEDERATION_PROFILE_UNRECOVERABLE) {
    // Permanent loss — persist a tomb so the UI renders "gone", then error
    // the observable: there is no profile to deliver. The tomb spans every
    // rev, so the key omits profileRev.
    const t = demand.target;
    await storage.writeProfileTomb({
      publisherNamespaceId: demand.publisherNamespaceId,
      profileNamespaceId: t.profileNamespaceId,
      account: t.account,
    });
    throw new Error('profile permanently lost (UNRECOVERABLE)');
  }
  if (envelope.code !== 0 || !envelope.data)
    throw new Error(envelope.message ?? 'profile resolution failed');
  if (envelope.data.status === 'PENDING') {
    if (options.evidence === null)
      throw new Error('unevidenced profile lookup must not return PENDING');
    return envelope.data as ProfileResolutionAttempt;
  }
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
  after: string;
  through: string;
  take: number;
}) => {
  const query = new URLSearchParams({
    threadId: String(input.threadId),
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
  if (!response.ok) throw new Error(`tombstone query HTTP ${response.status}`);
  return response.json();
};

type Request = { cacheDescriptor?: SessionCacheDescriptor | null } & (
  | {
      id: number;
      type: 'bind-thread-feed';
      userId: string;
      port: MessagePort;
    }
  | {
      id: number;
      type: 'resolve-profile';
      userId: string;
      demand: ProfileDemand;
      evidence?: null;
    }
  | {
      id: number;
      type: 'tombstone-cutoff-grown';
      userId: string;
      threadId: number | null;
    }
);

addEventListener('message', ({ data }: MessageEvent<Request>) => {
  void (async () => {
    try {
      const descriptor =
        data.cacheDescriptor == null
          ? null
          : restoreSessionCacheDescriptor(data.cacheDescriptor);
      const id = descriptor?.id ?? null;
      if (workerLogin && workerLogin.id !== id) {
        throw new Error('database worker belongs to a different login session');
      }
      if (!workerLogin) {
        if (descriptor) storage.bindSessionCache(descriptor);
        workerLogin = new LoginConnection(id);
      }
      workerLogin.bindAccount(data.userId);
      const release = await acquireUserStorage(data.userId);
      try {
        if (data.type === 'bind-thread-feed') {
          feedPort?.close();
          const port = data.port;
          feedPort = port;
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
                const language =
                  (await preferences.get<string>('global', 'language')) ??
                  navigator.language;
                const result = await syncPushState(
                  storage,
                  target,
                  requestStateFeed,
                  preferences,
                  language,
                );
                if (feedPort === port) {
                  postMessage({
                    type: 'notification-batch',
                    userId: Number(data.userId),
                    stream: 'state',
                    syncComplete: !result.error,
                    entries: result.notifications.map((descriptor) => ({
                      feedId: result.cursor,
                      descriptor,
                    })),
                  });
                  postMessage({
                    type: 'state-feed-committed',
                    userId: Number(data.userId),
                  });
                  await schedulePendingThreadResources();
                }
                if (result.error) throw result.error;
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
          const account = await storage.readAccountState();
          if (account.stateFeedTarget > (account.stateFeedId ?? 0))
            wakeState(account.stateFeedTarget);
          await schedulePendingThreadResources();
          postMessage({ id: data.id, ok: true });
          return;
        }
        if (data.type === 'resolve-profile') {
          const result = await requestProfile(data.demand, {
            ...(Object.hasOwn(data, 'evidence')
              ? { evidence: data.evidence }
              : {}),
          });
          postMessage({ id: data.id, ok: true, result });
          return;
        }
        if (data.type === 'tombstone-cutoff-grown') {
          if (data.threadId !== null) resourceScheduler.wakeTomb(data.threadId);
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
