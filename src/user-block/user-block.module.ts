import { Module } from '@nestjs/common';
import { UserBlockService } from './user-block.service.js';

@Module({
  // UserBlockService is consumed by MessageController (send fan-out + query filter) and UserController
  // (block/unblock), both declared in AppModule — exported so they can inject it.
  providers: [UserBlockService],
  exports: [UserBlockService],
})
export class UserBlockModule {}
