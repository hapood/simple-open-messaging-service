import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DomainCommandDispatcherService } from './domain-command-dispatcher.service.js';
import { DomainCommandQueueService } from './domain-command-queue.service.js';
import { DomainCommandSchedulerService } from './domain-command-scheduler.service.js';
import { DomainCommandStoreService } from './domain-command-store.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    DomainCommandQueueService,
    DomainCommandStoreService,
    DomainCommandDispatcherService,
    DomainCommandSchedulerService,
  ],
  exports: [DomainCommandQueueService, DomainCommandDispatcherService],
})
export class DomainCommandModule {}
