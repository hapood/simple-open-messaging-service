import { Module } from '@nestjs/common';
import { InviteService } from './invite.service.js';

/**
 * Invite domain module. InviteService owns invite DB state + the friend-request badge; it is
 * deliberately free of federation/SSE deps (the InviteController orchestrates those). Declared in
 * AppModule alongside the controller.
 */
@Module({
  providers: [InviteService],
  exports: [InviteService],
})
export class InviteModule {}
