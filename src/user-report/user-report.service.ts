import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';

/**
 * UserReport data layer — abuse/complaint ingestion only.
 *
 * Filing a report records a row for the admin console and has NO behavioral effect on chat (messages
 * are not blocked, no notification is suppressed). The admin surface reads by reportedUserId.
 */
@Injectable()
export class UserReportService {
  constructor(private prisma: PrismaService) {}

  /** Record a report. Always creates a new row (a user may file repeated reports against the same
   *  person — each is a distinct timestamped complaint for moderation). */
  report(reporterId: number, reportedUserId: number, reason: string) {
    return this.prisma.userReport.create({
      data: { reporterId, reportedUserId, reason },
    });
  }
}
