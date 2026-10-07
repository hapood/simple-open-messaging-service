import { GatewayModule } from '../gateway/gateway.module.js';
import { Module } from '@nestjs/common';
import { AccountThreadStateService } from './account-thread-state.service.js';
import { ThreadAccessGuard } from './thread-access.guard.js';
import { MessageModule } from '../message/message.module.js';
import { DurableTaskModule } from '../durable-task/durable-task.module.js';
import { ThreadPreviewModule } from '../message/thread-preview.module.js';
import { ClientStateFeedModule } from '../client-state-feed/client-state-feed.module.js';

@Module({
  // ThreadAccessGuard injects AccountThreadStateService to resolve the caller's membership; export it
  // so MessageController and GroupController (both declared in AppModule) can @UseGuards it — group
  // routes reuse it now that groups are `!`-User threads.
  imports: [
    MessageModule,
    DurableTaskModule,
    GatewayModule,
    ThreadPreviewModule,
    ClientStateFeedModule,
  ],
  providers: [AccountThreadStateService, ThreadAccessGuard],
  exports: [AccountThreadStateService, ThreadAccessGuard],
})
export class AccountThreadStateModule {}
