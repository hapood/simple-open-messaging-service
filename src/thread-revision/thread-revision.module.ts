import { Module, Global } from '@nestjs/common';
import { ThreadRevisionService } from './thread-revision.service.js';
import { GatewayModule } from '../gateway/gateway.module.js';

/** @Global so every service that mutates a user's thread set (invite/group/user/federation) can inject
 *  ThreadRevisionService without per-module imports. */
@Global()
@Module({
  imports: [GatewayModule], // SseService
  providers: [ThreadRevisionService],
  exports: [ThreadRevisionService],
})
export class ThreadRevisionModule {}
