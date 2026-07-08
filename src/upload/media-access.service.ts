import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';

/**
 * Per-object media authorization. Answers the single question the /uploads/shards/* gate needs:
 * "may this user read this digest?" — true iff the user is an active participant (leftAt IS NULL) of
 * at least one thread whose messages reference the digest.
 *
 * Backed by one indexed query over MediaMessage JOIN ThreadParticipant (the digest index selects ~1
 * row; sha256 is near-unique). Covers P2P (2 participants) and GROUP (N) uniformly via the shared
 * ThreadParticipant table. Type-agnostic by design — membership is leftAt IS NULL regardless of role.
 *
 * Avatars (/uploads/avatars/*) and legacy-flat files never reach this service: the gate calls it
 * only for /uploads/shards/ paths. Those exempt classes stay auth-n-only (avatars must render
 * cross-thread in lists/search/federation; legacy is GC-immune natural attrition).
 */
@Injectable()
export class MediaAccessService {
  constructor(private prisma: PrismaService) {}

  /** True iff `userId` is an active member of a thread that contains a message referencing `digest`. */
  async canReadDigest(userId: number, digest: string): Promise<boolean> {
    const row = await this.prisma.mediaMessage.findFirst({
      where: {
        digest,
        thread: {
          ThreadParticipant: { some: { userId, leftAt: null } },
        },
      },
      select: { id: true },
    });
    return row !== null;
  }
}
