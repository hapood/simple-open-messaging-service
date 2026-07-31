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
 * Avatars (/uploads/avatars/*) never reach this service: the gate calls it only for
 * /uploads/shards/ paths. Avatars stay auth-n-only (they must render cross-thread in
 * lists/search/federation).
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
      select: { messageId: true },
    });
    if (row !== null) return true;
    // Forward assets may live on a nested child bundle rather than directly on the visible root card.
    // Depth is capped at 3, so the explicit parent / grandparent probes are bounded and indexable.
    const forwarded = await this.prisma.forwardBundleAsset.findFirst({
      where: {
        digest,
        OR: [
          {
            bundle: {
              messages: {
                some: {
                  message: {
                    threadItem: {
                      ThreadParticipant: { some: { userId, leftAt: null } },
                    },
                    isDeleted: false,
                  },
                },
              },
            },
          },
          {
            bundle: {
              parents: {
                some: {
                  parent: {
                    messages: {
                      some: {
                        message: {
                          threadItem: {
                            ThreadParticipant: {
                              some: { userId, leftAt: null },
                            },
                          },
                          isDeleted: false,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          {
            bundle: {
              parents: {
                some: {
                  parent: {
                    parents: {
                      some: {
                        parent: {
                          messages: {
                            some: {
                              message: {
                                threadItem: {
                                  ThreadParticipant: {
                                    some: { userId, leftAt: null },
                                  },
                                },
                                isDeleted: false,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      select: { bundleId: true },
    });
    return forwarded !== null;
  }
}
