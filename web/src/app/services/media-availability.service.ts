import { Injectable, Signal, WritableSignal, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MessageRepository } from './message-repository.service';
import { MsgService } from './message.service';
import { MEDIA_STATUS, MediaStatus } from './model';
import { WebsocketService } from './websocket.service';

export interface MediaAvailabilityRegistration {
  readonly status: Signal<MediaStatus>;
  subscribe(listener: (status: MediaStatus) => void): () => void;
  onWithdrawn(listener: () => void): () => void;
  unregister(): void;
}

interface MediaEntry {
  readonly threadId: number;
  readonly seq: number;
  readonly status: WritableSignal<MediaStatus>;
  readonly listeners: Set<(status: MediaStatus) => void>;
  readonly withdrawnListeners: Set<() => void>;
  refs: number;
  generation: number;
}

/**
 * Shared live availability for mounted CAS messages.
 *
 * Cards and viewers register the same (threadId, seq), so one backend snapshot/SSE transition owns
 * both presentations. Registration and SSE reconnect coalesce into bulk queries; no interval exists.
 * TODO: replace the coarse MEDIA_STATUS wake with the backend's temporary media-message/file progress
 * SSE streams when the Web/Tauri media progress UI is migrated.
 */
@Injectable({ providedIn: 'root' })
export class MediaAvailabilityService {
  private readonly entries = new Map<string, MediaEntry>();
  private readonly queuedThreads = new Set<number>();
  private readonly lanes = new Map<number, Promise<void>>();
  private flushQueued = false;

  constructor(
    private readonly msg: MsgService,
    private readonly repo: MessageRepository,
    private readonly ws: WebsocketService,
  ) {
    this.ws.eventSubject.subscribe((event) => {
      if (event.event !== 'MEDIA_STATUS' || event.status !== 0 || !event.data) {
        return;
      }
      const data = event.data as unknown as {
        threadId?: unknown;
        seq?: unknown;
        status?: unknown;
      };
      if (
        typeof data.threadId !== 'number' ||
        typeof data.seq !== 'number' ||
        !isMediaStatus(data.status)
      ) {
        return;
      }
      const entry = this.entries.get(keyOf(data.threadId, data.seq));
      if (!entry) return;
      entry.generation += 1;
      void this.enqueue(data.threadId, () =>
        this.apply(entry, data.status as MediaStatus),
      );
    });

    this.ws.reconnect$.subscribe(() => {
      for (const entry of this.entries.values()) {
        if (entry.refs > 0) this.scheduleQuery(entry.threadId);
      }
    });

    this.repo.deletedLive$.subscribe(({ threadId, deletions }) => {
      for (const { seq } of deletions) {
        const key = keyOf(threadId, seq);
        const entry = this.entries.get(key);
        if (!entry) continue;
        entry.generation += 1;
        this.entries.delete(key);
        for (const listener of entry.withdrawnListeners) listener();
        entry.listeners.clear();
        entry.withdrawnListeners.clear();
      }
    });
  }

  register(
    threadId: number,
    seq: number,
    initialStatus: MediaStatus = MEDIA_STATUS.READY,
  ): MediaAvailabilityRegistration {
    const key = keyOf(threadId, seq);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        threadId,
        seq,
        status: signal(initialStatus),
        listeners: new Set(),
        withdrawnListeners: new Set(),
        refs: 0,
        generation: 0,
      };
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    this.scheduleQuery(threadId);

    let registered = true;
    return {
      status: entry.status.asReadonly(),
      subscribe: (listener) => {
        if (!registered) return () => undefined;
        entry!.listeners.add(listener);
        return () => entry!.listeners.delete(listener);
      },
      onWithdrawn: (listener) => {
        if (!registered) return () => undefined;
        entry!.withdrawnListeners.add(listener);
        return () => entry!.withdrawnListeners.delete(listener);
      },
      unregister: () => {
        if (!registered) return;
        registered = false;
        entry!.refs -= 1;
        if (entry!.refs === 0) {
          entry!.listeners.clear();
          entry!.withdrawnListeners.clear();
          entry!.generation += 1;
          this.entries.delete(key);
        }
      },
    };
  }

  async retry(threadId: number, seq: number): Promise<MediaStatus> {
    let result: MediaStatus = MEDIA_STATUS.FAILED;
    await this.enqueue(threadId, async () => {
      const before = this.entries.get(keyOf(threadId, seq));
      const generation = before?.generation;
      const response = await firstValueFrom(
        this.msg.relocalizeMedia(threadId, seq),
      );
      if (response.code !== 0 || !response.data) {
        throw new Error('media retry was rejected');
      }
      result = response.data.status;
      const entry = this.entries.get(keyOf(threadId, seq));
      if (entry && entry === before && entry.generation === generation) {
        await this.apply(entry, result);
      }
    });
    return result;
  }

  private scheduleQuery(threadId: number): void {
    if (threadId <= 0) return;
    this.queuedThreads.add(threadId);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const threads = [...this.queuedThreads];
      this.queuedThreads.clear();
      for (const id of threads) void this.enqueue(id, () => this.query(id));
    });
  }

  private async query(threadId: number): Promise<void> {
    const entries = [...this.entries.values()].filter(
      (entry) => entry.threadId === threadId && entry.refs > 0,
    );
    for (let offset = 0; offset < entries.length; offset += 50) {
      const chunk = entries.slice(offset, offset + 50);
      const generations = new Map(
        chunk.map((entry) => [entry.seq, entry.generation]),
      );
      try {
        const response = await firstValueFrom(
          this.msg.queryMediaStatus(
            threadId,
            chunk.map((entry) => entry.seq),
          ),
        );
        if (response.code !== 0 || !response.data) continue;
        for (const snapshot of response.data.statuses) {
          if (!isMediaStatus(snapshot.status)) continue;
          const entry = this.entries.get(keyOf(threadId, snapshot.seq));
          if (
            !entry ||
            entry.refs === 0 ||
            entry.generation !== generations.get(snapshot.seq)
          ) {
            continue;
          }
          await this.apply(entry, snapshot.status);
        }
      } catch {
        // Keep the last known state. A later mount or SSE reconnect reconciles again.
      }
    }
  }

  private async apply(entry: MediaEntry, status: MediaStatus): Promise<void> {
    if (entry.status() === status) return;
    await this.repo.setMediaStatus(entry.threadId, entry.seq, status);
    if (this.entries.get(keyOf(entry.threadId, entry.seq)) !== entry) return;
    entry.status.set(status);
    for (const listener of entry.listeners) listener(status);
  }

  private enqueue(threadId: number, task: () => Promise<void>): Promise<void> {
    const previous = this.lanes.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.lanes.set(threadId, next);
    void next.finally(() => {
      if (this.lanes.get(threadId) === next) this.lanes.delete(threadId);
    });
    return next;
  }
}

function keyOf(threadId: number, seq: number): string {
  return `${threadId}:${seq}`;
}

function isMediaStatus(value: unknown): value is MediaStatus {
  return (
    value === MEDIA_STATUS.PENDING ||
    value === MEDIA_STATUS.DOWNLOADING ||
    value === MEDIA_STATUS.READY ||
    value === MEDIA_STATUS.FAILED
  );
}
