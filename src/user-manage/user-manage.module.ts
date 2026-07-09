import { Module } from '@nestjs/common';
import { UserManageService } from './user-manage.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  providers: [UserManageService],
  exports: [UserManageService],
})
export class UserManageModule {}
