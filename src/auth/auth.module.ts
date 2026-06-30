import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthService } from './auth.service';
import { UserModule } from '../user/user.module';
import { PassportModule } from '@nestjs/passport';
import { LocalStrategy } from './local.strategy';
import { JwtStrategy } from './jwt.strategy';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from './constants';
import { UserService } from 'src/user/user.service';
import { PrismaService } from '../prisma.service';
import { ThrottleGuard } from './throttle.guard';

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
    ThrottleGuard,
  ],
  exports: [AuthService],
})
export class AuthModule {}
