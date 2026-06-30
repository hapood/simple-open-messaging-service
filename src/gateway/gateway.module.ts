import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventGateway } from './event.gateway';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from '../auth/constants';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [
    EventEmitterModule,
    JwtModule.register({
      secret: jwtConstants.accessSecret,
    }),
  ],
  providers: [EventGateway, PrismaService],
  exports: [EventGateway],
})
export class GatewayModule {}
