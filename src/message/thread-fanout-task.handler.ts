import {
  accountThreadFanoutScope,
  parseAccountThreadFanoutTarget,
} from './account-thread-fanout-task.js';
import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { ThreadFeedService } from './thread-feed.service.js';
import { SseService } from '../gateway/sse.service.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { PushService } from '../push/push.service.js';
import {
  parseThreadFanoutTarget,
  threadFanoutScope,
} from './thread-fanout-task.js';
import {
  ThreadFanoutProgressService,
  type ThreadFanoutProjection,
} from './thread-fanout-progress.service.js';

const FANOUT_YIELD_WINDOW = 50;

/** Durable database projection with lossy post-commit SSE and push hints.
 * Network delivery is not part of the task's completion condition. */
@Injectable()
export class ThreadFanoutTaskHandler implements OnModuleInit, OnModuleDestroy {
  private unregister: Array<() => void> = [];
  private readonly logger = new Logger(ThreadFanoutTaskHandler.name);

  constructor(
    private readonly dispatcher: DurableTaskDispatcherService,
    private readonly participants: AccountThreadStateService,
    private readonly feed: ThreadFeedService,
    private readonly push: PushService,
    private readonly progress: ThreadFanoutProgressService,
    private readonly sse: SseService,
  ) {}

  onModuleInit(): void {
    this.unregister.push(
      this.dispatcher.register({
        taskType: DurableTaskType.FAN_OUT_THREAD_CONTENT,
        execute: (task) => this.execute(task),
      }),
      this.dispatcher.register({
        taskType: DurableTaskType.FAN_OUT_ACCOUNT_THREAD_CONTENT,
        execute: (task) => this.executeAccount(task),
      }),
    );
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregister) unregister();
  }

  async execute(task: DurableTask): Promise<void> {
    const target = parseThreadFanoutTarget(task.payload);
    if (
      task.kind !== 'PROJECTION' ||
      task.scopeType !== 'THREAD' ||
      task.taskType !== DurableTaskType.FAN_OUT_THREAD_CONTENT ||
      task.scopeKey !==
        threadFanoutScope(
          DurableTaskType.FAN_OUT_THREAD_CONTENT,
          target.threadId,
        )
    ) {
      throw new Error('Thread fanout task scope mismatch');
    }
    const checkpoint = await this.progress.read(task.id);
    if (checkpoint.phase === 'DONE') return;
    if (checkpoint.phase === 'FEED') {
      // P2P and groups share this checkpointed loop. Each recipient commits in
      // its own transaction; the window only bounds work before checking for a
      // newer coalesced target. Processing never creates per-account child tasks.
      const audience = (
        await this.participants.getActiveParticipantUserIds(target.threadId)
      )
        .map((member) => member.userId)
        .filter((id) => id > checkpoint.afterAccountId)
        .sort((a, b) => a - b);
      for (
        let start = 0;
        start < audience.length;
        start += FANOUT_YIELD_WINDOW
      ) {
        if (await this.progress.yieldToNewer(task.id, target)) return;
        for (const userId of audience.slice(
          start,
          start + FANOUT_YIELD_WINDOW,
        )) {
          const projected = await this.progress.projectActiveAccount(
            task.id,
            target,
            userId,
          );
          void this.wakeBatch(projected).catch((error: unknown) => {
            this.logger.warn(
              `Thread notification hint failed: ${String(error)}`,
            );
          });
        }
      }
    }
    await this.progress.save(task.id, { phase: 'DONE', afterAccountId: 0 });
  }

  private async executeAccount(task: DurableTask): Promise<void> {
    const target = parseAccountThreadFanoutTarget(task.payload);
    if (
      task.kind !== 'PROJECTION' ||
      task.scopeType !== 'THREAD' ||
      task.taskType !== DurableTaskType.FAN_OUT_ACCOUNT_THREAD_CONTENT ||
      task.scopeKey !==
        accountThreadFanoutScope(target.threadId, target.accountId)
    )
      throw new Error('Account thread fanout task scope mismatch');
    if ((await this.progress.read(task.id)).phase === 'DONE') return;
    const projected = await this.progress.projectAccount(task.id, target);
    await this.wakeBatch(projected);
  }

  /** Best-effort hints. A process restart during the five-second window drops
   * this in-memory push round; the committed feed remains recoverable. */
  private async wakeBatch(projected: ThreadFanoutProjection[]): Promise<void> {
    const heads = await Promise.all(
      projected.map(async (result) => ({
        ...result,
        feedId: await this.feed.readEndId(result.userId),
      })),
    );
    // SSE failure must not suppress the independently scheduled Push fallback.
    for (const {
      userId,
      feedId,
      unreadCountChanged,
      previewChanged,
    } of heads) {
      try {
        this.sse.onThreadFeedUpdated(userId, {
          threadFeedEndId: feedId,
          notificationRelevant: unreadCountChanged || previewChanged,
        });
      } catch (error) {
        this.logger.warn(`Thread SSE hint failed: ${String(error)}`);
      }
      if (unreadCountChanged || previewChanged) {
        try {
          await this.push.enqueueForMessage([
            { userId, threadFeedEndId: feedId },
          ]);
        } catch (error) {
          this.logger.warn(`Thread push hint failed: ${String(error)}`);
        }
      }
    }
  }
}
