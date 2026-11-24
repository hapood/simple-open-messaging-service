import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Observable, Subject, concatMap } from 'rxjs';
import { DatabaseService } from '../database/database.service.js';
import { MessageThreadType } from '../database/enums.js';
import {
  accountThreadState,
  federationThreadHistoryGap,
  identityNamespace,
  messageThread,
} from '../database/schema.js';
import { FederationThreadRoundSchedulerService } from '../federation/federation-thread-round-scheduler.service.js';
import {
  HistoryIntervalEventsService,
  type HistoryIntervalEvent,
} from './history-interval-events.service.js';

interface HistoryIntervalScheduling {
  threadId: number;
  namespaceId: number;
}

/** Owns a mounted local `(left, right]` subscription, not a federation cursor.
 * Committed notifications only ask the client to reread its local history page. */
@Injectable()
export class HistoryIntervalService {
  private readonly logger = new Logger(HistoryIntervalService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly events: HistoryIntervalEventsService,
    private readonly scheduler: FederationThreadRoundSchedulerService,
  ) {}

  async open(
    userId: number,
    threadId: number,
    left: number,
    right: number,
  ): Promise<Observable<HistoryIntervalEvent>> {
    // Validate before constructing a lazy stream. No history query runs until
    // the committed-event listener has been registered by subscribe().
    const committed = this.events.observe(threadId, left, right);
    return new Observable<HistoryIntervalEvent>((sink) => {
      const pending = new Subject<{
        event: HistoryIntervalEvent;
        initial: boolean;
      }>();
      sink.add(() => pending.complete());
      sink.add(
        pending
          .pipe(
            concatMap(async ({ event, initial }) => {
              const visible = await this.resolveViewerInterval(
                userId,
                threadId,
                left,
                right,
              );
              if (sink.closed) return;
              if (visible === null) {
                sink.complete();
                return;
              }
              const clipped = {
                threadId,
                left: Math.max(visible.left, event.left),
                right: Math.min(visible.right, event.right),
              };
              if (clipped.left >= clipped.right) return;
              sink.next(clipped);
              if (!initial || sink.closed) return;

              const scheduling = await this.resolveScheduling(
                threadId,
                visible.left,
                visible.right,
              );
              // Disconnect cancels subscription-owned work. An already queued
              // round belongs to the shared scheduler, not to this connection.
              for (const source of scheduling) {
                if (sink.closed) return;
                this.requestReverse(source);
              }
            }),
          )
          .subscribe({ error: (error: unknown) => sink.error(error) }),
      );
      sink.add(
        committed.subscribe({
          next: (event) => pending.next({ event, initial: false }),
          error: (error: unknown) => sink.error(error),
        }),
      );
      // Register first: commits racing with either the initial read or gap
      // query are queued and reauthorized rather than lost.
      pending.next({ event: { threadId, left, right }, initial: true });
    });
  }

  private async resolveViewerInterval(
    userId: number,
    threadId: number,
    left: number,
    right: number,
  ): Promise<HistoryIntervalEvent | null> {
    // A single MVCC read captures membership and both visibility boundaries.
    // Retained read-only conversations remain readable only through their
    // frozen visible-through coordinate; they must not observe newer commits.
    const [scope] = await this.database.db
      .select({
        clearedSeq: messageThread.clearedSeq,
        currentEnd: messageThread.curSeq,
        visibleThroughSeq: accountThreadState.messageVisibleThroughSeq,
      })
      .from(accountThreadState)
      .innerJoin(
        messageThread,
        eq(messageThread.id, accountThreadState.threadId),
      )
      .where(
        and(
          eq(accountThreadState.accountId, userId),
          eq(accountThreadState.threadId, threadId),
        ),
      );
    if (!scope) return null;
    const clippedLeft = Math.max(left, scope.clearedSeq ?? 0);
    const allowedRight = Math.min(right, scope.visibleThroughSeq ?? right);
    if (clippedLeft >= allowedRight) return null;
    // Match queryClientMessagePage: blocking suppresses live delivery, not
    // retained history reads. A not-yet-committed tail is different from lost
    // access: keep listening, but never emit coordinates beyond currentEnd.
    return {
      threadId,
      left: clippedLeft,
      right: Math.min(allowedRight, scope.currentEnd),
    };
  }

  private requestReverse(scheduling: HistoryIntervalScheduling): void {
    try {
      // The scheduler chooses reverse for this ordinary source and continues
      // toward older sequences. This wake does not select a cursor.
      this.scheduler.onWake({ ...scheduling, mode: 'thread' });
    } catch (error) {
      this.logger.warn(
        `history interval reverse wake failed for thread ${scheduling.threadId}: ${(error as Error).message}`,
      );
    }
  }

  private async resolveScheduling(
    threadId: number,
    left: number,
    right: number,
  ): Promise<HistoryIntervalScheduling[]> {
    const rows = await this.database.db
      .select({
        namespaceId: federationThreadHistoryGap.namespaceId,
        namespaceActive: identityNamespace.active,
        authorityNamespaceId: messageThread.authorityNamespaceId,
        threadType: messageThread.type,
        roundsEnabled: messageThread.federationRoundsEnabled,
        gapStartSeq: federationThreadHistoryGap.startSeq,
        gapEndSeq: federationThreadHistoryGap.endSeq,
        gapMessageSeqOffset: federationThreadHistoryGap.messageSeqOffset,
        gapRecoverable: federationThreadHistoryGap.recoverable,
      })
      .from(federationThreadHistoryGap)
      .innerJoin(
        messageThread,
        eq(messageThread.id, federationThreadHistoryGap.threadId),
      )
      .innerJoin(
        identityNamespace,
        eq(identityNamespace.id, federationThreadHistoryGap.namespaceId),
      )
      .where(eq(federationThreadHistoryGap.threadId, threadId));
    const sources = new Map<number, HistoryIntervalScheduling>();
    for (const row of rows) {
      if (
        !row.roundsEnabled ||
        !row.namespaceActive ||
        row.namespaceId === 0 ||
        !row.gapRecoverable ||
        // A local group origin consumes member submissions forward-only. A
        // mirror may reverse-fill only its authority's timeline.
        (row.threadType === MessageThreadType.GROUP &&
          (row.authorityNamespaceId === 0 ||
            row.namespaceId !== row.authorityNamespaceId))
      )
        continue;
      const gapLeft = row.gapStartSeq + row.gapMessageSeqOffset - 1;
      const gapRight = row.gapEndSeq + row.gapMessageSeqOffset;
      if (left < gapRight && gapLeft < right)
        sources.set(row.namespaceId, {
          threadId,
          namespaceId: row.namespaceId,
        });
    }
    return [...sources.values()];
  }
}
