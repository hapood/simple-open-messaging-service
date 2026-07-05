import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service.js';

/** 30-day TTL — the background poller re-issues on the next foreground login, so this only needs to
 *  outlast a typical "user hasn't opened the app" stretch. Long enough to be useful, short enough to
 *  limit exposure of a scoped credential. */
const NOTIFICATION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues + validates long-lived, revocable, single-purpose credentials for background pollers (the
 * Android NotificationSyncWorker). The poller can't hold a 15-minute access token, and MUST NOT share
 * the refresh-token family — doing so would race the web client's own renewal and trip refresh-reuse
 * detection. So we mint a separate opaque token, stored as a sha256 hash (mirrors RefreshToken), scoped
 * by {@link NotificationTokenGuard} to ONLY /notifications/*. Revoked on logout.
 */
@Injectable()
export class NotificationTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mint a new notification token for the user. Returns the plaintext ONCE (only the hash is stored).
   *  Does NOT revoke prior tokens — a user may have several (multiple devices); each is independently
   *  revocable. Expired tokens are left for a future sweep (validate() rejects them). */
  async issue(userId: number): Promise<string> {
    const plaintext = randomBytes(32).toString('hex');
    await this.prisma.notificationToken.create({
      data: {
        userId,
        tokenHash: hashToken(plaintext),
        expiresAt: new Date(Date.now() + NOTIFICATION_TOKEN_TTL_MS),
      },
    });
    return plaintext;
  }

  /** Validate a presented token. Returns the userId on success, null otherwise (not-found / revoked /
   *  expired). The hash lookup is constant-time-ish via the unique index; no timing-leak mitigation
   *  beyond that — this credential is scoped and short-lived. */
  async validate(raw: string): Promise<number | null> {
    const rec = await this.prisma.notificationToken.findUnique({
      where: { tokenHash: hashToken(raw) },
      select: { userId: true, expiresAt: true, revokedAt: true },
    });
    if (!rec) return null;
    if (rec.revokedAt !== null) return null;
    if (rec.expiresAt.getTime() <= Date.now()) return null;
    return rec.userId;
  }

  /** Revoke a single presented token (self-revoke on logout). Idempotent — a not-found or
   *  already-revoked token is a no-op so the device logout is resilient to retries / stale state. */
  async revoke(raw: string): Promise<void> {
    await this.prisma.notificationToken.updateMany({
      where: { tokenHash: hashToken(raw), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revoke ALL of the user's notification tokens — called on logout-all / password change
   *  (invalidateAllSessions) so every device's poller stops in one move. */
  async revokeAllForUser(userId: number): Promise<void> {
    await this.prisma.notificationToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
