import { Module } from '@nestjs/common';
import { UserManageService } from './user-manage.service';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [UserManageService, PrismaService],
  exports: [UserManageService],
})
export class UserManageModule {}
