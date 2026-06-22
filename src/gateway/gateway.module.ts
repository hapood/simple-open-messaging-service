import { Module } from '@nestjs/common';
import { EventGateway } from './event.gateway';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from '../auth/constants';

@Module({
  imports: [
    JwtModule.register({
      secret: jwtConstants.accessSecret,
    }),
  ],
  providers: [EventGateway],
  exports: [EventGateway],
})
export class GatewayModule {}
