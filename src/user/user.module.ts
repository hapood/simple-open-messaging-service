import { GroupMetaFeedService } from '../group/meta/group-meta-feed.service.js';
import { Module } from '@nestjs/common';
import { UserService } from './user.service.js';

@Module({
  providers: [UserService, GroupMetaFeedService],
  exports: [UserService],
})
export class UserModule {}
