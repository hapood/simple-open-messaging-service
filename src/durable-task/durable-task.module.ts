import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DurableTaskDispatcherService } from './durable-task-dispatcher.service.js';
import { DurableTaskQueueService } from './durable-task-queue.service.js';
import { DurableTaskSchedulerService } from './durable-task-scheduler.service.js';
import { DurableTaskStoreService } from './durable-task-store.service.js';
import { DurableAsyncTaskDispatcherService } from './durable-async-task-dispatcher.service.js';
import { DurableAsyncTaskRecoveryService } from './durable-async-task-recovery.service.js';
import { DurableAsyncTaskSchedulerService } from './durable-async-task-scheduler.service.js';
import { DurableTaskWakeService } from './durable-task-wake.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    DurableTaskQueueService,
    DurableTaskStoreService,
    DurableTaskDispatcherService,
    DurableAsyncTaskDispatcherService,
    DurableAsyncTaskSchedulerService,
    DurableAsyncTaskRecoveryService,
    DurableTaskSchedulerService,
    DurableTaskWakeService,
  ],
  exports: [
    DurableTaskSchedulerService,
    DurableAsyncTaskSchedulerService,
    DurableTaskQueueService,
    DurableTaskStoreService,
    DurableTaskDispatcherService,
    DurableAsyncTaskDispatcherService,
  ],
})
export class DurableTaskModule {}
