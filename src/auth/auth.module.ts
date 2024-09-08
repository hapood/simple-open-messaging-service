import { Module, forwardRef } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserModule } from '../user/user.module';
import { PassportModule } from '@nestjs/passport';
import { LocalStrategy } from './local.strategy';
import { JwtStrategy } from './jwt.strategy';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [forwardRef(() => UserModule), PassportModule,
  JwtModule.register({
  }),],
  providers: [AuthService, LocalStrategy,
    JwtStrategy],
  exports: [AuthService],
})
export class AuthModule { }
