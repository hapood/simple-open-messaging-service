import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthService } from './auth.service.js';
import { UserModule } from '../user/user.module.js';
import { PassportModule } from '@nestjs/passport';
import { LocalStrategy } from './local.strategy.js';
import { JwtStrategy } from './jwt.strategy.js';
import { AccessTokenValidator } from './access-token.validator.js';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from './constants.js';
import { UserService } from '../user/user.service.js';
import { PrismaService } from '../prisma.service.js';
import { ThrottleGuard } from './throttle.guard.js';

@Module({
  imports: [
    UserModule,
    PassportModule,
    EventEmitterModule,
    JwtModule.register({
      secret: jwtConstants.accessSecret,
    }),
  ],
  providers: [
    AuthService,
    LocalStrategy,
    UserService,
    PrismaService,
    JwtStrategy,
    AccessTokenValidator,
    ThrottleGuard,
  ],
  exports: [AuthService, LocalStrategy, AccessTokenValidator],
})
export class AuthModule {}
