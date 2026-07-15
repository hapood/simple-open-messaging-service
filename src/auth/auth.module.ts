import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
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
import { ThrottleGuard } from './throttle.guard.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { NotificationTokenService } from './notification-token.service.js';
import { NotificationTokenGuard } from './notification-token.guard.js';
import { SessionTokenService } from './session-token.service.js';
import { BearerAuthService } from './bearer-auth.service.js';

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
    JwtStrategy,
    AccessTokenValidator,
    ThrottleGuard,
    NotificationTokenService,
    NotificationTokenGuard,
    SessionTokenService,
    BearerAuthService,
    // Global guard: every route is authenticated unless it opts out with @Public(). Accepts an access
    // JWT OR a session token (via BearerAuthService). Registered here (not in AppModule) to co-locate
    // with JwtAuthGuard/JwtStrategy/PassportModule. Mirrors the APP_INTERCEPTOR→AdminAuditInterceptor
    // precedent in AdminModule.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [
    AuthService,
    LocalStrategy,
    AccessTokenValidator,
    NotificationTokenService,
    NotificationTokenGuard,
    SessionTokenService,
    BearerAuthService,
  ],
})
export class AuthModule {}
