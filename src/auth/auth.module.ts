import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthService } from './auth.service.js';
import { UserModule } from '../user/user.module.js';
import { PassportModule } from '@nestjs/passport';
import { LocalStrategy } from './local.strategy.js';
import { UserService } from '../user/user.service.js';
import { ThrottleGuard } from './throttle.guard.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { SessionTokenService } from './session-token.service.js';
import { BearerAuthService } from './bearer-auth.service.js';

@Module({
  imports: [UserModule, PassportModule, EventEmitterModule],
  providers: [
    AuthService,
    LocalStrategy,
    UserService,
    ThrottleGuard,
    SessionTokenService,
    BearerAuthService,
    // Global guard: every route is authenticated unless it opts out with @Public(). Resolves the
    // single session token via BearerAuthService. (Admin routes are @Public() + their own AdminJwtStrategy;
    // the s2s signature guard is @Public() + its own check.) Registered here to co-locate with
    // LocalStrategy/PassportModule — mirrors the APP_INTERCEPTOR→AdminAuditInterceptor precedent.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, LocalStrategy, SessionTokenService, BearerAuthService],
})
export class AuthModule {}
