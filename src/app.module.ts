import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [UserModule, AuthModule, GatewayModule],
  controllers: [AppController],
  providers: [],
})
export class AppModule {
}
