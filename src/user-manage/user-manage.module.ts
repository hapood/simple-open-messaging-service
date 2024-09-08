import { Module } from '@nestjs/common';
import { UserManageService } from './user-manage.service';
import { PrismaService } from '../prisma.service';

@Module({
  providers: [UserManageService, PrismaService],
  exports: [UserManageService],
})
export class UserManageModule { }