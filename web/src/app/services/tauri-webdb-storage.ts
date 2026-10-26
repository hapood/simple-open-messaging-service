import { DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbStorage } from './webdb-storage';
import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import type { GroupMetaCommitPatch } from './group-meta-model';
import { NativeCommitEventsService } from './native-commit-events.service';
import { tauriInvoke } from './runtime';

/**
 * Tauri (desktop + Android) `WebdbStorage` specialization.
 *
 * The Rust SSE supervisor (`src-tauri/src/sse.rs`) and the native database
 * (`src-tauri/src/native_db`) are the feed/DB execution layer — a peer of the
 * browser's `state-feed-db.worker`, not something the web shell drives through a
 * Worker. This class therefore:
 *
 *  - Routes per-thread Group Meta + tombstone drains to the Rust executor via
 *    `tauriInvoke('native_db_drain_thread_misc')` instead of a worker
 *    `postMessage`. No `state-feed-db.worker` is ever created under Tauri.
 *  - Subscribes to the native executor completion port and forwards Rust's local
 *    completion events (`LOCAL_THREAD_FEED_COMMITTED`,
 *    `LOCAL_STATE_FEED_COMMITTED`, `LOCAL_GROUP_META_COMMITTED`) into the same
 *    `*Committed$` Subjects the browser path drives from worker `postMessage`,
 *    so `ThreadStoreService` is platform-agnostic.
 *
 * Storage read/write methods (meta/threads/messages/profiles) stay inherited
 * from `WebdbStorage`; each already dispatches `isTauri() → tauriInvoke` vs
 * IndexedDB. They are thin per-method dispatches, not feed-execution logic, so
 * they do not belong in a worker.
 */
export class TauriWebdbStorage extends WebdbStorage {
  private readonly nativeCommits = inject(NativeCommitEventsService);
  private readonly destroyRef = inject(DestroyRef);

  constructor(lifecycle: SessionLifecycleService) {
    // No browser worker under Tauri: pass a factory that always returns null.
    super(() => null, lifecycle);
    // Rust → renderer local completions feed the same Subjects the browser
    // worker drives, keeping ThreadStoreService platform-agnostic.
    this.nativeCommits.committed$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((m) => {
        if (this.accountMaintenance || this.currentUserId === null) return;
        if (m.event === 'LOCAL_MESSAGE_DB_COMMITTED') {
          const data = m.data as
            | { userId?: number; threadId?: number }
            | undefined;
          if (
            data?.userId === this.currentUserIdAsNumber() &&
            typeof data?.threadId === 'number'
          )
            this.messageDbCommitted.next({
              userId: data.userId!,
              threadId: data.threadId,
            });
        } else if (m.event === 'LOCAL_THREAD_FEED_COMMITTED') {
          const data = m.data as
            | { userId?: number; states?: LocalThreadAttention[] }
            | undefined;
          if (
            data?.userId !== undefined &&
            Array.isArray(data.states) &&
            data.userId === this.currentUserIdAsNumber()
          )
            this.threadFeedCommitted.next({
              userId: data.userId,
              states: data.states,
            });
        } else if (m.event === 'LOCAL_STATE_FEED_COMMITTED') {
          const data = m.data as { userId?: number } | undefined;
          if (
            data?.userId !== undefined &&
            data.userId === this.currentUserIdAsNumber()
          )
            this.stateFeedCommitted.next({ userId: data.userId });
        } else if (m.event === 'LOCAL_GROUP_META_COMMITTED') {
          const data = m.data as
            | {
                userId?: number;
                threadIds?: number[];
                patches?: GroupMetaCommitPatch[];
              }
            | undefined;
          if (
            data?.userId !== undefined &&
            Array.isArray(data.threadIds) &&
            data.userId === this.currentUserIdAsNumber()
          )
            this.groupMetaCommitted.next({
              userId: data.userId,
              threadIds: data.threadIds,
              patches: Array.isArray(data.patches) ? data.patches : [],
            });
        } else if (m.event === 'LOCAL_TOMBSTONE_COMMITTED') {
          const data = m.data as
            | {
                userId?: number;
                threadId?: number;
                tombstones?: Array<{
                  seq: number;
                  type: 'USER_RETRACTION' | 'MODERATION_REMOVAL';
                }>;
              }
            | undefined;
          if (
            data?.userId !== undefined &&
            data.userId === this.currentUserIdAsNumber() &&
            typeof data.threadId === 'number'
          )
            this.tombstoneCommitted.next({
              threadId: data.threadId,
              deletions: data.tombstones ?? [],
            });
        }
      });
  }

  /** Numeric mirror of the inherited `currentUserId` (a string) for event
   *  filtering; Rust emits `userId` as a number. */
  private currentUserIdAsNumber(): number | undefined {
    return this.currentUserId === null ? undefined : Number(this.currentUserId);
  }

  /** Tauri never opens an IndexedDB handle: the Rust executor (SQLCipher) owns
   *  durable state. We still record the active user and publish `ready` so the
   *  rest of the renderer (which treats `WebdbStorage` uniformly) keeps working. */
  override async openExistingForUser(userId: string): Promise<null> {
    ++this.cacheEpoch;
    this.currentUserId = userId;
    this.activateMessageLifetime();
    this.ready.set(true);
    return null;
  }

  override async recreateForUser(userId: string): Promise<null> {
    ++this.cacheEpoch;
    this.currentUserId = userId;
    this.activateMessageLifetime();
    this.ready.set(true);
    return null;
  }

  /** Per-thread Group Meta + tombstone drains run in the Rust executor. */
  override async drainThreadMisc(threadId: number | null): Promise<void> {
    if (this.accountMaintenance || this.currentUserId === null)
      throw new Error('account cache lifetime expired');
    await tauriInvoke('native_db_drain_thread_misc', {
      userId: Number(this.currentUserId),
      threadId: threadId ?? 0,
    });
  }
}
