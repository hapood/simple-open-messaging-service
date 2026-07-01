import { Module } from '@nestjs/common';
import { UserManageService } from './user-manage.service.js';
import { PrismaService } from '../prisma.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  providers: [UserManageService, PrismaService],
  exports: [UserManageService],
})
export class UserManageModule {}
