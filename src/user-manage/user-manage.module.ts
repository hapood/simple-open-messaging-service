import { Module } from '@nestjs/common';
import { UserManageService } from './user-manage.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { UserModule } from '../user/user.module.js';

@Module({
  imports: [AuthModule, UserModule],
  providers: [UserManageService],
  exports: [UserManageService],
})
export class UserManageModule {}
