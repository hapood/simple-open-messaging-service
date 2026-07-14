import { firstValueFrom } from 'rxjs';
import { MsgService } from '../../services/message.service';
import { MessageRepository } from '../../services/message-repository.service';

/**
 * Scroll-driven SSE backstop for federated media status.
 *
 * A `MEDIA_STATUS` frame can be missed while the client is disconnected (the SSE stream does not replay
 * offline frames), so a federated media message can be stuck on the optimistic 'downloading' state even
 * though the backend has long since reached 'ready'/'failed'. This scheduler fixes that: when the user
 * scrolls and there are in-flight ('downloading') media seqs, it debounces + rate-limits a bulk
 * `/media-status` probe and applies the returned terminals through the repository's reducer pipeline
 * (anti-regression + idempotent), which then re-renders each card in place.
 *
 * Plain class (NOT @Injectable): each {@link FriendMessageComponent} owns its own instance via
 * `new MediaProbeScheduler(msgService, msgRepo)` — one per open thread, never shared (the A/B pane buffer
 * can mount two threads at once), and trivially unit-testable without TestBed.
 */
export class MediaProbeScheduler {
  /** In-flight ('downloading') media seqs in THIS thread — fed by createItem + the mediaStatus live cb. */
  private readonly seqs = new Set<number>();
  private timer?: ReturnType<typeof setTimeout>;
  /** Timestamp (ms) of the last probe run. -Infinity ⇒ never run → the first schedule is a 300ms debounce,
   *  not a 5s rate-limit wait. */
  private lastRun = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly msg: MsgService,
    private readonly repo: MessageRepository,
  ) {}

  /** Track a message's downloading state: true → in-flight (probe it), false → terminal (drop it). */
  track(seq: number, downloading: boolean): void {
    if (downloading) this.seqs.add(seq);
    else this.seqs.delete(seq);
  }

  /** Schedule a probe after a scroll. 300ms debounce when ≥5s since the last run; otherwise rate-limited to
   *  once per 5s (`delay = 5000 - elapsed`). No-op when nothing is in flight. Re-arming resets the timer
   *  (trailing-edge debounce — only the last scroll in a burst fires). */
  schedule(threadId: number): void {
    if (this.seqs.size === 0) return;
    if (this.timer) clearTimeout(this.timer);
    const elapsed = Date.now() - this.lastRun;
    const delay = elapsed >= 5000 ? 300 : 5000 - elapsed;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run(threadId);
    }, delay);
  }

  /** Bulk-probe the backend for the in-flight seqs + apply the returned terminals via the repository's
   *  reducer (markMediaStatusBatch → reduceMediaStatus → mediaStatusLive$ → card re-renders). No-op on
   *  threadId 0 or an empty set. A non-zero `code` or a network throw is a transient miss — the next scroll
   *  re-arms, no crash. */
  async run(threadId: number): Promise<void> {
    const tid = threadId;
    const snapshot = [...this.seqs];
    if (tid === 0 || snapshot.length === 0) return;
    this.lastRun = Date.now();
    try {
      const res = await firstValueFrom(this.msg.queryMediaStatus(tid, snapshot));
      if (res.code !== 0 || !res.data) return;
      await this.repo.markMediaStatusBatch(tid, res.data.statuses);
    } catch {
      /* transient — the next scroll re-arms */
    }
  }

  /** Cancel any pending timer + clear the tracked set. Called on the host's teardown. */
  destroy(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.seqs.clear();
  }
}
