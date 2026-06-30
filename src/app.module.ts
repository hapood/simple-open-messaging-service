import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MessageController } from './controller/message.controller';
import { AuthController } from './controller/auth.controller';
import { UserModule } from './user/user.module';
import { MessageModule } from './message/message.module';
import { AuthModule } from './auth/auth.module';
import { GatewayModule } from './gateway/gateway.module';
import { UserController } from './controller/user.controller';
import { GroupModule } from './group/group.module';
import { GroupController } from './controller/group.controller';
import { UploadModule } from './upload/upload.module';
import { RedisModule } from './redis/redis.module';
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
  ],
  controllers: [
    MessageController,
    AuthController,
    UserController,
    GroupController,
  ],
  providers: [],
})
export class AppModule {}
