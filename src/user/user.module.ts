import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { PrismaService } from '../prisma.service';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from '../auth/constants';

@Module({
  imports: [JwtModule.register({
    secret: jwtConstants.secret
  }),],
  providers: [UserService, PrismaService],
  exports: [UserService],
})
export class UserModule { }