import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DurableTaskDispatcherService } from './durable-task-dispatcher.service.js';
import { DurableTaskQueueService } from './durable-task-queue.service.js';
import { DurableTaskSchedulerService } from './durable-task-scheduler.service.js';
import { DurableTaskStoreService } from './durable-task-store.service.js';
import { DurableTaskWakeService } from './durable-task-wake.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    DurableTaskQueueService,
    DurableTaskStoreService,
    DurableTaskDispatcherService,
    DurableTaskSchedulerService,
    DurableTaskWakeService,
  ],
  exports: [
    DurableTaskSchedulerService,
    DurableTaskQueueService,
    DurableTaskStoreService,
    DurableTaskDispatcherService,
  ],
})
export class DurableTaskModule {}
