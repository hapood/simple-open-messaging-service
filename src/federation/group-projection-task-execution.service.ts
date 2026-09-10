import { groupState as group, groupStateFields } from '../group/group-state.js';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  durableTask,
  groupMetaFeed,
  messageThread,
  threadAudience,
} from '../database/schema.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';
import { loadFederationConfig } from './federation.config.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';
import type { GroupMetaHeadFanoutPayload } from './group-projection-task.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { lockBusinessAccountsInTx } from '../relationship/business-scope-lock.js';

const AUDIENCE_PAGE_SIZE = 10;

interface ProjectionPageEffect {
  processed: boolean;
  clientUpdates: Array<PendingClientStateFeedUpdate & { audienceId: bigint }>;
  peerTargets: Array<{ audienceId: bigint; peerDomain: string }>;
}

/** Fans one canonical Group Meta head out to current local and federation audiences. */
@Injectable()
export class GroupProjectionTaskExecutionService {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly database: DatabaseService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly peerStateFeed: PeerStateFeedService,
    private readonly events: EventEmitter2,
  ) {}

  async execute(
    task: DurableTask,
    payload: GroupMetaHeadFanoutPayload,
  ): Promise<void> {
    for (;;) {
      const effect = await this.processNextPage(task, payload);
      if (!effect.processed) return;
      const current = await this.retainCurrentAudience(effect);
      this.clientStateFeed.notifyFeedUpdates(
        current.clientUpdates.map(({ userId, feedId }) => ({ userId, feedId })),
      );
      for (const peerDomain of new Set(
        current.peerTargets.map((target) => target.peerDomain),
      ))
        this.events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
    }
  }

  private async processNextPage(
    task: DurableTask,
    payload: GroupMetaHeadFanoutPayload,
  ): Promise<ProjectionPageEffect> {
    return this.database.db.transaction(async (tx) => {
      const [identity] = await tx
        .select({
          account: groupStateFields.account,
          domain: groupStateFields.domain,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .where(eq(messageThread.id, payload.threadId))
        .limit(1);
      if (!identity)
        throw new Error('Group Meta head fan-out source is missing');
      // Membership mutations hold this scope before touching audiences and client
      // allocators. Acquire it before even the task row: those mutations can also
      // enqueue a successor task. Re-read the canonical head after the lock.
      await lockBusinessAccountsInTx(tx, [identity]);
      const locked = await tx.execute<{
        status: string;
        taskType: string;
        coalescingKey: string | null;
        afterAudienceId: string | null;
      }>(sql`
        SELECT status, "taskType", "coalescingKey",
               checkpoint ->> 'afterAudienceId' AS "afterAudienceId"
        FROM "DurableTask"
        WHERE id = ${task.id}
        FOR NO KEY UPDATE
      `);
      const current = locked.rows[0];
      if (!current || current.status !== 'PROCESSING') return emptyEffect();
      if (current.taskType !== task.taskType)
        throw new Error('processing Group Meta head fan-out type changed');
      if (current.coalescingKey === null)
        throw new Error(
          'processing Group Meta head fan-out has no coalescing key',
        );
      const [successor] = await tx
        .select({ id: durableTask.id })
        .from(durableTask)
        .where(
          and(
            eq(durableTask.coalescingKey, current.coalescingKey),
            eq(durableTask.status, 'PENDING'),
            sql`${durableTask.id} > ${task.id}`,
          ),
        )
        .limit(1);
      // A newer task starts from audience zero and reconciles the latest canonical head.
      // Yield only at a page boundary so this task never abandons an open transaction.
      if (successor) return emptyEffect();
      const afterAudienceId = readCursor(current.afterAudienceId);
      const [state] = await tx
        .select({
          groupId: group.id,
          account: groupStateFields.account,
          domain: groupStateFields.domain,
          namespaceId: groupStateFields.namespaceId,
          feedEndId: groupMetaFeed.feedEndId,
        })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.id))
        .innerJoin(groupMetaFeed, eq(groupMetaFeed.threadId, group.id))
        .where(eq(messageThread.id, payload.threadId))
        .limit(1);
      if (!state) throw new Error('Group Meta head fan-out source is missing');
      if (state.domain !== 'local' || state.namespaceId !== 0)
        throw new Error(
          'a mirrored group cannot author Group Meta head fan-out',
        );

      const page = await tx
        .select({
          id: threadAudience.id,
          targetDomain: threadAudience.targetDomain,
          targetNamespaceId: threadAudience.targetNamespaceId,
          localUserId: threadAudience.localUserId,
        })
        .from(threadAudience)
        .where(
          and(
            eq(threadAudience.threadId, payload.threadId),
            sql`${threadAudience.id} > ${afterAudienceId}`,
          ),
        )
        .orderBy(asc(threadAudience.id))
        .limit(AUDIENCE_PAGE_SIZE);
      if (page.length === 0) return emptyEffect();

      const currentAudience = await tx
        .select({ id: threadAudience.id })
        .from(threadAudience)
        .where(
          and(
            eq(threadAudience.threadId, payload.threadId),
            inArray(
              threadAudience.id,
              page.map((audience) => audience.id),
            ),
          ),
        )
        .for('no key update');
      const currentIds = new Set(
        currentAudience.map((audience) => audience.id),
      );
      const activePage = page
        .filter((audience) => currentIds.has(audience.id))
        .sort(compareAudienceTargets);
      await this.peerStateFeed.lockTargetsInTx(
        tx,
        activePage
          .filter((audience) => audience.targetDomain !== 'local')
          .map((audience) => ({
            peerDomain: audience.targetDomain,
            namespaceId: audience.targetNamespaceId,
          })),
      );
      const clientUpdates: Array<
        PendingClientStateFeedUpdate & { audienceId: bigint }
      > = [];
      const peerTargets: Array<{
        audienceId: bigint;
        peerDomain: string;
      }> = [];
      for (const audience of activePage) {
        if (audience.targetDomain === 'local') {
          if (audience.localUserId === null)
            throw new Error('local group audience has no account');
          const feedId = await this.clientStateFeed.writeInTx(tx, {
            userId: audience.localUserId,
            account: state.account,
            domain: state.domain,
            namespaceId: state.namespaceId,
            eventType: 'GROUP_META_FEED_HEAD',
            subjectAccount: '',
            subjectDomain: 'local',
            body: { groupMetaFeedEndId: state.feedEndId.toString() },
          });
          if (feedId !== null)
            clientUpdates.push({
              audienceId: audience.id,
              userId: audience.localUserId,
              feedId,
            });
          continue;
        }
        if (audience.localUserId !== null)
          throw new Error('federation group audience has a local account');
        const published = await this.peerStateFeed.writeManyInTx(tx, [
          {
            peerDomain: audience.targetDomain,
            namespaceId: audience.targetNamespaceId,
            account: state.account,
            domain: this.config.domain,
            eventType: 'GROUP_META_FEED_HEAD',
            subjectAccount: '',
            subjectDomain: 'local',
            body: { groupMetaFeedEndId: state.feedEndId.toString() },
          },
        ]);
        if (published.has(audience.targetDomain))
          peerTargets.push({
            audienceId: audience.id,
            peerDomain: audience.targetDomain,
          });
      }
      await saveTaskCheckpointInTx(tx, task.id, {
        afterAudienceId: page.at(-1)!.id.toString(),
      });
      return { processed: true, clientUpdates, peerTargets };
    });
  }

  /** Drop wake hints whose audience disappeared after the page committed. */
  private async retainCurrentAudience(
    effect: ProjectionPageEffect,
  ): Promise<ProjectionPageEffect> {
    const audienceIds = [
      ...effect.clientUpdates.map((update) => update.audienceId),
      ...effect.peerTargets.map((target) => target.audienceId),
    ];
    if (audienceIds.length === 0) return effect;
    const current = await this.database.db
      .select({ id: threadAudience.id })
      .from(threadAudience)
      .where(inArray(threadAudience.id, audienceIds));
    const currentIds = new Set(current.map((audience) => audience.id));
    return {
      processed: effect.processed,
      clientUpdates: effect.clientUpdates.filter((update) =>
        currentIds.has(update.audienceId),
      ),
      peerTargets: effect.peerTargets.filter((target) =>
        currentIds.has(target.audienceId),
      ),
    };
  }
}

function compareAudienceTargets(
  left: {
    targetDomain: string;
    targetNamespaceId: number;
    localUserId: number | null;
  },
  right: {
    targetDomain: string;
    targetNamespaceId: number;
    localUserId: number | null;
  },
): number {
  return (
    left.targetDomain.localeCompare(right.targetDomain) ||
    left.targetNamespaceId - right.targetNamespaceId ||
    (left.localUserId ?? 0) - (right.localUserId ?? 0)
  );
}

function readCursor(value: string | null): bigint {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error('invalid Group Meta head fan-out checkpoint');
  return BigInt(value);
}

function emptyEffect(): ProjectionPageEffect {
  return {
    processed: false,
    clientUpdates: [],
    peerTargets: [],
  };
}
