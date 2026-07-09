import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MessageController } from './controller/message.controller.js';
import { AuthController } from './controller/auth.controller.js';
import { UserModule } from './user/user.module.js';
import { MessageModule } from './message/message.module.js';
import { AuthModule } from './auth/auth.module.js';
import { GatewayModule } from './gateway/gateway.module.js';
import { UserController } from './controller/user.controller.js';
import { GroupModule } from './group/group.module.js';
import { GroupController } from './controller/group.controller.js';
import { UploadModule } from './upload/upload.module.js';
import { RedisModule } from './redis/redis.module.js';
import { AdminModule } from './admin/admin.module.js';
import { NotifyModule } from './notify/notify.module.js';
import { NotifyController } from './controller/notify.controller.js';
import { ThreadParticipantModule } from './thread-participant/thread-participant.module.js';
import { FriendshipModule } from './friendship/friendship.module.js';
import { PushModule } from './push/push.module.js';
import { UserBlockModule } from './user-block/user-block.module.js';
import { FederationModule } from './federation/federation.module.js';
import { PrismaModule } from './prisma.module.js';
import { DeviceController } from './controller/device.controller.js';
import { NotificationController } from './controller/notification.controller.js';
import { NotificationQueryService } from './notification/notification-query.service.js';

// Static serving (uploaded images + the web/admin SPAs) is wired in main.ts via @fastify/static,
// not a Nest module — @nestjs/serve-static silently dropped maxAge on the Fastify path
// (nestjs/serve-static#187) and assumed an h1 ServerResponse in setHeaders.

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    RedisModule,
    AuthModule,
    UserModule,
    GatewayModule,
    MessageModule,
    GroupModule,
    UploadModule,
    AdminModule,
    NotifyModule,
    ThreadParticipantModule,
    FriendshipModule,
    PushModule,
    UserBlockModule,
    FederationModule,
    PrismaModule,
  ],
  controllers: [
    MessageController,
    AuthController,
    UserController,
    GroupController,
    NotifyController,
    DeviceController,
    NotificationController,
  ],
  providers: [NotificationQueryService],
})
export class AppModule {}
