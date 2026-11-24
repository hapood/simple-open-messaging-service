import { Module } from '@nestjs/common';
import { AccountThreadStateModule } from '../account-thread-state/account-thread-state.module.js';
import { MessageHistoryIntervalController } from '../controller/message-history-interval.controller.js';
import { FederationModule } from '../federation/federation.module.js';
import { HistoryIntervalService } from './history-interval.service.js';
import { MessageModule } from './message.module.js';

/** Mounted server-gap interval subscription (SSE + committed reverse-page wakes). */
@Module({
  imports: [AccountThreadStateModule, FederationModule, MessageModule],
  controllers: [MessageHistoryIntervalController],
  providers: [HistoryIntervalService],
})
export class HistoryIntervalModule {}
