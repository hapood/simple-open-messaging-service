import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { DurableAsyncTaskSchedulerService } from './durable-async-task-scheduler.service.js';
import { DurableTaskStoreService } from './durable-task-store.service.js';

/** Reconstructs non-durable async scheduler queues from durable task rows. */
@Injectable()
export class DurableAsyncTaskRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DurableAsyncTaskRecoveryService.name);

  constructor(
    private readonly store: DurableTaskStoreService,
    private readonly scheduler: DurableAsyncTaskSchedulerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const taskTypes = this.scheduler.supportedTaskTypes;
    if (taskTypes.length === 0) return;
    const tasks = await this.store.findAsyncProcessing(taskTypes);
    for (const task of tasks) {
      try {
        this.scheduler.enqueue(task);
      } catch (error) {
        this.logger.error(
          `failed to recover async durable task ${task.id.toString()}`,
          error,
        );
      }
    }
  }
}
