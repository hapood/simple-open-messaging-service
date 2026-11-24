import type { ConversationItem } from './model';
import type {
  ClientGroupMetaApply,
  ClientGroupMetaFeedPage,
  GroupMetaCommitPatch,
} from './group-meta-model';

const CLIENT_FEED_CURSOR_UNAVAILABLE = 30006;

export interface GroupMetaSyncStorage {
  getThreads(): Promise<ConversationItem[]>;
  getThreadResourceHeads(): Promise<
    Array<{
      threadId: number;
      tombstoneEndSeq: number;
      groupMetaFeedEndId: string | null;
    }>
  >;
  beginGroupMetaRecovery(threadId: number, through: string): Promise<void>;
  applyGroupMetaPage(
    update: ClientGroupMetaApply,
  ): Promise<GroupMetaCommitPatch | null>;
}

export interface GroupMetaRequest {
  threadId: number;
  after: string;
  through: string;
  take: number;
}

export type GroupMetaRequester = (
  request: GroupMetaRequest,
) => Promise<unknown>;

interface GroupMetaEnvelope {
  code?: unknown;
  data?: unknown;
}

export class GroupMetaSyncError extends Error {
  constructor(
    message: string,
    readonly threadIds: number[],
    readonly patches: GroupMetaCommitPatch[] = [],
  ) {
    super(message);
  }
}

function decimal(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function pageFrom(value: unknown): ClientGroupMetaFeedPage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const page = value as ClientGroupMetaFeedPage & {
    items: Array<ClientGroupMetaFact & { feedId: unknown }>;
  };
  if (!Array.isArray(page.items)) return null;
  const items: ClientGroupMetaFact[] = [];
  for (const item of page.items) {
    const feedId = decimal(item.feedId);
    if (feedId === null || feedId < 1) return null;
    items.push({ ...item, feedId });
  }
  return { ...page, items };
}

function recoveryWindow(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reset = value as { resumeAfter?: unknown; resumeBefore?: unknown };
  if (
    reset.resumeAfter !== '0' ||
    typeof reset.resumeBefore !== 'string' ||
    !/^[1-9][0-9]*$/.test(reset.resumeBefore)
  )
    return null;
  return (BigInt(reset.resumeBefore) - 1n).toString();
}

function validatePage(
  page: ClientGroupMetaFeedPage,
  expected: {
    account: string;
    after: string;
    through: string;
  },
): void {
  if (
    page.account !== expected.account ||
    !/^(0|[1-9]\d*)$/.test(page.scannedThrough) ||
    !/^(0|[1-9]\d*)$/.test(page.groupMetaFeedEndId) ||
    BigInt(page.scannedThrough) < BigInt(expected.after) ||
    BigInt(page.scannedThrough) > BigInt(expected.through) ||
    BigInt(page.groupMetaFeedEndId) < BigInt(expected.through) ||
    typeof page.hasMore !== 'boolean' ||
    (!page.hasMore && page.scannedThrough !== expected.through) ||
    page.items.some(
      (entry) =>
        (entry.operation !== 'GROUP_ANNOUNCEMENT' &&
          entry.operation !== 'GROUP_MEMBER_COUNT') ||
        typeof entry.body !== 'object' ||
        entry.body === null ||
        Array.isArray(entry.body) ||
        (entry.operation === 'GROUP_MEMBER_COUNT' &&
          (!Number.isSafeInteger(entry.body.memberCount) ||
            entry.body.memberCount < 0)),
    )
  )
    throw new Error('invalid group-meta page');
  if (page.hasMore && page.scannedThrough === expected.after)
    throw new Error('group-meta pagination made no progress');
  if (
    page.items.some(
      (entry) =>
        entry.operation === 'GROUP_ANNOUNCEMENT' &&
        (!Number.isSafeInteger(entry.feedId) ||
          entry.feedId < 1 ||
          typeof entry.body !== 'object' ||
          entry.body === null ||
          Object.keys(entry.body).length !== 1 ||
          (entry.body.text !== null &&
            (typeof entry.body.text !== 'string' ||
              [...entry.body.text].length < 1 ||
              [...entry.body.text].length > 4096))),
    )
  )
    throw new Error('invalid group announcement');
}

export interface GroupMetaPageResult {
  status: 'DONE' | 'MORE';
  changed: boolean;
  patch: GroupMetaCommitPatch | null;
}

/** Execute one Group Meta page round for `threadId`. */
export async function syncGroupMetaPage(
  storage: GroupMetaSyncStorage,
  request: GroupMetaRequester,
  threadId: number,
): Promise<GroupMetaPageResult> {
  const [threads, heads] = await Promise.all([
    storage.getThreads(),
    storage.getThreadResourceHeads(),
  ]);
  const thread = threads.find((item) => item.threadId === threadId);
  const head = heads.find((item) => item.threadId === threadId);
  if (!thread || thread.type !== 'GROUP')
    return { status: 'DONE', changed: false, patch: null };
  const target = head?.groupMetaFeedEndId ?? thread.groupMetaFeedEndId;
  if (target === null || target === undefined)
    return { status: 'DONE', changed: false, patch: null };

  let after = thread.meta.groupMetaFeedId;
  const recoveryThrough = thread.meta.recoveryThrough ?? null;
  if (recoveryThrough === null && BigInt(after) >= BigInt(target))
    return { status: 'DONE', changed: false, patch: null };

  let through: string;
  let beganRecovery = false;
  if (recoveryThrough !== null || after === '0') {
    through = recoveryThrough ?? target;
    if (recoveryThrough === null) {
      await storage.beginGroupMetaRecovery(thread.threadId, through);
      beganRecovery = true;
      after = '0';
    }
  } else {
    through = target;
  }

  const envelope = (await request({
    threadId: thread.threadId,
    after,
    through,
    take: 100,
  })) as GroupMetaEnvelope;
  if (envelope?.code === CLIENT_FEED_CURSOR_UNAVAILABLE) {
    const resetThrough = recoveryWindow(envelope.data);
    if (resetThrough === null || recoveryThrough !== null)
      throw new Error('invalid group-meta recovery window');
    await storage.beginGroupMetaRecovery(thread.threadId, resetThrough);
    return { status: 'MORE', changed: true, patch: null };
  }
  const page = envelope?.code === 0 ? pageFrom(envelope.data) : null;
  if (!page)
    throw new Error(
      `group-meta pull failed (code ${String(envelope?.code)})`,
    );
  validatePage(page, {
    account: thread.account,
    after,
    through,
  });
  const patch = await storage.applyGroupMetaPage({
    threadId: thread.threadId,
    namespaceId: thread.publisherNamespaceId,
    page,
  });
  const hasMore =
    page.hasMore || BigInt(page.scannedThrough) < BigInt(target);
  return {
    status: hasMore ? 'MORE' : 'DONE',
    changed: beganRecovery || patch !== null,
    patch,
  };
}

/** Catch the thread's stored group projection up to its durable
 *  thread-head target, read fresh from storage on every call. */
async function syncGroupMetaThreadUnchecked(
  storage: GroupMetaSyncStorage,
  request: GroupMetaRequester,
  threadId: number,
  changed: number[],
  committed: GroupMetaCommitPatch[],
  failures: string[],
): Promise<void> {
  const threads = await storage.getThreads();
  const thread = threads.find((item) => item.threadId === threadId);
  if (!thread || thread.type !== 'GROUP') return;
  const context = `group ${thread.account} (namespace ${thread.publisherNamespaceId}, thread ${thread.threadId})`;
  try {
    for (;;) {
      const result = await syncGroupMetaPage(storage, request, threadId);
      if (result.changed) changed.push(threadId);
      if (result.patch) committed.push(result.patch);
      if (result.status !== 'MORE') return;
    }
  } catch (error) {
    failures.push(
      `${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function syncGroupMetaThread(
  storage: GroupMetaSyncStorage,
  request: GroupMetaRequester,
  threadId: number,
): Promise<{
  patches: GroupMetaCommitPatch[];
  threadIds: number[];
}> {
  const changed: number[] = [];
  const committed: GroupMetaCommitPatch[] = [];
  const failures: string[] = [];
  await syncGroupMetaThreadUnchecked(
    storage,
    request,
    threadId,
    changed,
    committed,
    failures,
  );
  if (failures.length) {
    const visible = failures.slice(0, 5);
    const overflow = failures.length - visible.length;
    throw new GroupMetaSyncError(
      visible.join('; ') + (overflow > 0 ? `; (+${overflow} more)` : ''),
      [...new Set(changed)],
      [...new Map(committed.map((p) => [p.threadId, p])).values()],
    );
  }
  return {
    patches: [...new Map(committed.map((p) => [p.threadId, p])).values()],
    threadIds: [...new Set(changed)],
  };
}
