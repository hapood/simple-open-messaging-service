import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module.js';
import { PushModule } from '../push/push.module.js';
import { AccountThreadStateModule } from '../account-thread-state/account-thread-state.module.js';
import { MessageModule } from './message.module.js';
import { UserModule } from '../user/user.module.js';
import { GroupModule } from '../group/group.module.js';
import { UploadModule } from '../upload/upload.module.js';
import { DurableTaskModule } from '../durable-task/durable-task.module.js';
import { ThreadPreviewModule } from './thread-preview.module.js';
import { ThreadFanoutTaskHandler } from './thread-fanout-task.handler.js';
import { ThreadFanoutProgressService } from './thread-fanout-progress.service.js';

/** Local device projection handlers. */
@Module({
  imports: [
    DurableTaskModule,
    ThreadPreviewModule,
    GatewayModule,
    PushModule,
    AccountThreadStateModule,
    MessageModule,
    UserModule,
    GroupModule,
    UploadModule,
  ],
  providers: [ThreadFanoutProgressService, ThreadFanoutTaskHandler],
})
export class MessageFanoutModule {}
