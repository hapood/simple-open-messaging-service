import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import type { ConversationItem } from './model';
import type {
  ClientGroupMetaApply,
  ClientGroupMetaFeedPage,
  GroupMetaProfileReference,
} from './group-meta-model';

export type { GroupMetaProfileReference } from './group-meta-model';

const CLIENT_FEED_CURSOR_UNAVAILABLE = 30006;

export interface GroupMetaSyncStorage {
  getThreads(): Promise<ConversationItem[]>;
  getThreadStates(): Promise<LocalThreadAttention[]>;
  getUnresolvedGroupMetaProfiles(): Promise<GroupMetaProfileReference[]>;
  beginGroupMetaRecovery(threadId: number, through: string): Promise<void>;
  applyGroupMetaPage(update: ClientGroupMetaApply): Promise<void>;
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

export type GroupMetaProfileResolver = (
  reference: GroupMetaProfileReference,
) => Promise<boolean>;

interface GroupMetaEnvelope {
  code?: unknown;
  data?: unknown;
}

export class GroupMetaSyncError extends Error {
  constructor(
    message: string,
    readonly threadIds: number[],
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
          entry.operation !== 'UPSERT' &&
          entry.operation !== 'DEPART') ||
        ((entry.operation === 'UPSERT' || entry.operation === 'DEPART') &&
          (!entry.account ||
            !entry.domain ||
            !Number.isSafeInteger(entry.namespaceId) ||
            entry.namespaceId < 0)),
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

/** Catch every stored group projection up to its durable thread-head target. */
export async function syncGroupMeta(
  storage: GroupMetaSyncStorage,
  request: GroupMetaRequester,
  resolveProfile: GroupMetaProfileResolver,
): Promise<number[]> {
  const changed: number[] = [];
  try {
    return await syncGroupMetaUnchecked(
      storage,
      request,
      resolveProfile,
      changed,
    );
  } catch (error) {
    throw new GroupMetaSyncError(
      error instanceof Error ? error.message : String(error),
      [...new Set(changed)],
    );
  }
}

async function syncGroupMetaUnchecked(
  storage: GroupMetaSyncStorage,
  request: GroupMetaRequester,
  resolveProfile: GroupMetaProfileResolver,
  changed: number[],
): Promise<number[]> {
  const [threads, states] = await Promise.all([
    storage.getThreads(),
    storage.getThreadStates(),
  ]);
  const byThread = new Map(threads.map((thread) => [thread.threadId, thread]));
  for (const state of states) {
    const target = state.server?.groupMetaFeedEndId;
    const thread = byThread.get(state.threadId);
    if (
      target === null ||
      target === undefined ||
      thread?.type !== 'GROUP' ||
      thread.conversationState === 'READ_ONLY'
    )
      continue;

    let after = thread.group.groupMetaFeedId;
    let recoveryThrough = thread.groupMetaRecoveryThrough ?? null;
    if (recoveryThrough === null && BigInt(after) >= BigInt(target)) continue;

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
      if (!page) throw new Error('group-meta pull failed');
      validatePage(page, {
        account: thread.group.account,
        mode,
        after,
        through,
      });
      await storage.applyGroupMetaPage({
        threadId: thread.threadId,
        sourceServer: thread.group.domain,
        namespaceId: thread.group.namespaceId,
        page,
      });
      changed.push(thread.threadId);
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
  }
  const unresolved = await storage.getUnresolvedGroupMetaProfiles();
  const unique = new Map(
    unresolved.map((reference) => [JSON.stringify(reference), reference]),
  );
  const references = [...unique.values()];
  for (const reference of references)
    if (await resolveProfile(reference)) changed.push(reference.threadId);
  return [...new Set(changed)];
}
