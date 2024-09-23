import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserModule } from '../user/user.module';
import { PassportModule } from '@nestjs/passport';
import { LocalStrategy } from './local.strategy';
import { JwtStrategy } from './jwt.strategy';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from './constants';
import { UserService } from 'src/user/user.service';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [UserModule, PassportModule,
    JwtModule.register({
      secret: jwtConstants.secret
    }),],
  providers: [AuthService, LocalStrategy, UserService, PrismaService,
    JwtStrategy],
  exports: [AuthService],
})
export class AuthModule { }
