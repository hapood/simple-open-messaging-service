import { Module } from '@nestjs/common';
import { UserReportService } from './user-report.service.js';
import { PrismaService } from '../prisma.service.js';

@Module({
  providers: [UserReportService, PrismaService],
  exports: [UserReportService],
})
export class UserReportModule {}
