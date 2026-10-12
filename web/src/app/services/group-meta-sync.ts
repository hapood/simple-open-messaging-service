import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import type { ConversationItem } from './model';
import type {
  ClientGroupMetaApply,
  ClientGroupMetaFeedPage,
  GroupMetaCommitPatch,
} from './group-meta-model';

const CLIENT_FEED_CURSOR_UNAVAILABLE = 30006;

export interface GroupMetaSyncStorage {
  getThreads(): Promise<ConversationItem[]>;
  getThreadStates(): Promise<LocalThreadAttention[]>;
  beginGroupMetaRecovery(threadId: number, through: string): Promise<void>;
  applyGroupMetaPage(
    update: ClientGroupMetaApply,
  ): Promise<GroupMetaCommitPatch | null>;
}

export interface GroupMetaRequest {
  threadId: number;
  mode: 'full' | 'delta';
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

function pageFrom(value: unknown): ClientGroupMetaFeedPage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const page = value as ClientGroupMetaFeedPage;
  return Array.isArray(page.items) ? page : null;
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
    mode: 'full' | 'delta';
    after: string;
    through: string;
  },
): void {
  if (
    page.mode !== expected.mode ||
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
        (entry.operation !== 'GROUP_PROFILE' &&
          entry.operation !== 'GROUP_ANNOUNCEMENT' &&
          entry.operation !== 'MEMBER_UPSERT' &&
          entry.operation !== 'MEMBER_DEPART') ||
        (typeof entry.body !== 'object' ||
          entry.body === null ||
          Array.isArray(entry.body)) ||
        ((entry.operation === 'MEMBER_UPSERT' ||
          entry.operation === 'MEMBER_DEPART') &&
          (!entry.body.account ||
            !Number.isSafeInteger(entry.body.namespaceId) ||
            entry.body.namespaceId < 0 ||
            (entry.body.role !== 'OWNER' &&
              entry.body.role !== 'ADMIN' &&
              entry.body.role !== 'MEMBER') ||
            !Number.isSafeInteger(entry.body.profileRev) ||
            entry.body.profileRev < 0)) ||
        (entry.operation === 'GROUP_PROFILE' &&
          (!entry.body.account ||
            !Number.isSafeInteger(entry.body.namespaceId) ||
            entry.body.namespaceId < 0 ||
            !Number.isSafeInteger(entry.body.profileRev) ||
            entry.body.profileRev < 0)),
    )
  )
    throw new Error('invalid group-meta page');
  if (page.hasMore && page.scannedThrough === expected.after)
    throw new Error('group-meta pagination made no progress');
  if (
    page.items.some(
      (entry) =>
        entry.operation === 'GROUP_ANNOUNCEMENT' &&
        (!/^[1-9]\d*$/.test(entry.feedId) ||
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

/** Catch every stored group projection up to its durable thread-head target.
 *  A failing group isolates to its own error entry and
 *  never starves the remaining groups; the aggregated failure still rejects
 *  the invocation so the caller's wake/retry pressure is preserved. */
export async function syncGroupMeta(
  storage: GroupMetaSyncStorage,
  request: GroupMetaRequester,
): Promise<number[]> {
  const changed: number[] = [];
  const patches: GroupMetaCommitPatch[] = [];
  const failures: string[] = [];
  try {
    const committed = await syncGroupMetaUnchecked(
      storage,
      request,
      changed,
      patches,
      failures,
    );
    if (failures.length) {
      const visible = failures.slice(0, 5);
      const overflow = failures.length - visible.length;
      throw new GroupMetaSyncError(
        visible.join('; ') + (overflow > 0 ? `; (+${overflow} more)` : ''),
        [...new Set(changed)],
        [...new Map(patches.map((p) => [p.threadId, p])).values()],
      );
    }
    return committed;
  } catch (error) {
    if (error instanceof GroupMetaSyncError) throw error;
    throw new GroupMetaSyncError(
      error instanceof Error ? error.message : String(error),
      [...new Set(changed)],
      [...new Map(patches.map((p) => [p.threadId, p])).values()],
    );
  }
}

async function syncGroupMetaThreadUnchecked(
  storage: GroupMetaSyncStorage,
  request: GroupMetaRequester,
  threadId: number,
  target: string,
  changed: number[],
  committed: GroupMetaCommitPatch[],
  failures: string[],
  guard?: () => boolean,
): Promise<void> {
  const [threads, states] = await Promise.all([
    storage.getThreads(),
    storage.getThreadStates(),
  ]);
  const thread = threads.find((item) => item.threadId === threadId);
  const state = states.find((item) => item.threadId === threadId);
  if (
    !thread ||
    thread.type !== 'GROUP' ||
    thread.conversationState === 'READ_ONLY'
  )
    return;
  const feedTarget = state?.threadFeedId === null ? null : target;
  if (feedTarget === null) return;

  let after = thread.group.groupMetaFeedId;
  let recoveryThrough = thread.groupMetaRecoveryThrough ?? null;
  if (recoveryThrough === null && BigInt(after) >= BigInt(target)) return;

  const context = `group ${thread.group.account} (namespace ${thread.group.namespaceId}, thread ${thread.threadId})`;
  try {
    let mode: 'full' | 'delta';
    let through: string;
    if (recoveryThrough !== null || after === '0') {
      through = recoveryThrough ?? target;
      if (recoveryThrough === null) {
        await storage.beginGroupMetaRecovery(thread.threadId, through);
        changed.push(thread.threadId);
        after = '0';
        recoveryThrough = through;
      }
      mode = 'full';
    } else {
      mode = 'delta';
      through = target;
    }

    // A persisted recovery window is resumable. `reopened` only guards the one
    // server-directed replacement window allowed during this invocation.
    let reopened = false;
    for (;;) {
      if (guard && !guard()) return;
      const envelope = (await request({
        threadId: thread.threadId,
        mode,
        after,
        through,
        take: 100,
      })) as GroupMetaEnvelope;
      if (envelope?.code === CLIENT_FEED_CURSOR_UNAVAILABLE) {
        const resetThrough = recoveryWindow(envelope.data);
        if (resetThrough === null || reopened)
          throw new Error('invalid group-meta recovery window');
        await storage.beginGroupMetaRecovery(thread.threadId, resetThrough);
        changed.push(thread.threadId);
        mode = 'full';
        after = '0';
        through = resetThrough;
        reopened = true;
        continue;
      }
      const page = envelope?.code === 0 ? pageFrom(envelope.data) : null;
      if (!page)
        throw new Error(
          `group-meta pull failed (code ${String(envelope?.code)})`,
        );
      validatePage(page, {
        account: thread.group.account,
        mode,
        after,
        through,
      });
      const patch = await storage.applyGroupMetaPage({
        threadId: thread.threadId,
        namespaceId: thread.group.namespaceId,
        page,
      });
      if (patch) {
        committed.push(patch);
        changed.push(thread.threadId);
      }
      after = page.scannedThrough;
      if (!page.hasMore) {
        if (mode === 'full' && BigInt(after) < BigInt(target)) {
          mode = 'delta';
          through = target;
          continue;
        }
        break;
      }
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
  target: string,
  guard?: () => boolean,
): Promise<{
  /** Committed Group Meta facts, one per thread (latest wins). */
  patches: GroupMetaCommitPatch[];
  /** Threads with any committed fact or recovery change. */
  threadIds: number[];
}> {
  const changed: number[] = [];
  const committed: GroupMetaCommitPatch[] = [];
  const failures: string[] = [];
  await syncGroupMetaThreadUnchecked(
    storage,
    request,
    threadId,
    target,
    changed,
    committed,
    failures,
    guard,
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

async function syncGroupMetaUnchecked(
  storage: GroupMetaSyncStorage,
  request: GroupMetaRequester,
  changed: number[],
  committed: GroupMetaCommitPatch[],
  failures: string[],
): Promise<number[]> {
  const [threads, states] = await Promise.all([
    storage.getThreads(),
    storage.getThreadStates(),
  ]);
  const byThread = new Map(threads.map((thread) => [thread.threadId, thread]));
  for (const state of states) {
    const target =
      state.threadFeedId === null ? null : state.groupMetaFeedEndId;
    const thread = byThread.get(state.threadId);
    if (
      target === null ||
      target === undefined ||
      thread?.type !== 'GROUP' ||
      thread.conversationState === 'READ_ONLY'
    )
      continue;
    await syncGroupMetaThreadUnchecked(
      storage,
      request,
      state.threadId,
      target,
      changed,
      committed,
      failures,
    );
  }
  return [...new Set(changed)];
}
