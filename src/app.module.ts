import { Module } from '@nestjs/common';
import { MessageController } from './controller/message.controller';
import { AuthController } from './controller/auth.controller';
import { UserModule } from './user/user.module';
import { MessageModule } from './message/message.module';
import { AuthModule } from './auth/auth.module';
import { GatewayModule } from './gateway/gateway.module';
import { UserController } from './controller/user.controller';
@Module({
  imports: [AuthModule, UserModule, GatewayModule, MessageModule],
  controllers: [MessageController, AuthController, UserController],
  providers: [],
})
export class AppModule {
}
