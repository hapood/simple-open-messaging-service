import { Module } from '@nestjs/common';
import { AccountThreadStateService } from './account-thread-state.service.js';
import { ThreadAccessGuard } from './thread-access.guard.js';
import { MessageModule } from '../message/message.module.js';
import { DurableTaskModule } from '../durable-task/durable-task.module.js';
import { EndFriendshipTaskHandler } from './end-friendship-task.handler.js';

@Module({
  // ThreadAccessGuard injects AccountThreadStateService to resolve the caller's membership; export it
  // so MessageController and GroupController (both declared in AppModule) can @UseGuards it — group
  // routes reuse it now that groups are `!`-User threads.
  imports: [MessageModule, DurableTaskModule],
  providers: [
    AccountThreadStateService,
    ThreadAccessGuard,
    EndFriendshipTaskHandler,
  ],
  exports: [AccountThreadStateService, ThreadAccessGuard],
})
export class AccountThreadStateModule {}
