import { Module } from '@nestjs/common';
import { UserService } from './user.service.js';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from '../auth/constants.js';

@Module({
  imports: [
    JwtModule.register({
      secret: jwtConstants.accessSecret,
    }),
  ],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
