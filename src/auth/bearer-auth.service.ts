import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { BAN_DIM_IP, BruteForceService } from './brute-force.service.js';
import { IP_AUTH_FAILURE_STEPS } from './ip-auth-policy.js';
import { SessionTokenService } from './session-token.service.js';

/**
 * Resolves a raw session credential (the `Authorization: Bearer <token>` header or the `media_token`
 * cookie) to a principal via the DB/KV-backed session lookup. `slid` lets the guard and uploads validator
 * re-issue the browser cookie when the server deadline moves. The
 * single source of truth shared by the global {@link SessionAuthGuard} and the /uploads/* media preHandler —
 * so the API and media auth surfaces enforce identical rules (one session token authenticates both).
 * There is no access JWT anymore; every request presents the long-lived session token.
 */
@Injectable()
export class BearerAuthService {
  constructor(
    private readonly sessions: SessionTokenService,
    private readonly bruteForce: BruteForceService,
  ) {}

  async resolve(
    raw: string | null | undefined,
    opts: { ip?: string | null } = {},
  ): Promise<{
    userId: number;
    sessionId: number | null;
    slid: boolean;
    autoTerminateDays: number;
    mustChangePassword: boolean;
  } | null> {
    // Missing credentials are ordinary anonymous traffic, not failed guesses.
    if (!raw) return null;
    const ip = opts.ip ?? 'unknown';
    this.rejectBan(
      this.bruteForce.activeBanUntil([{ dimension: BAN_DIM_IP, value: ip }]),
    );
    // Reject malformed credentials before storage access. Only issued 32-byte hex tokens are valid.
    // Storage errors propagate without being counted as credential failures.
    const session = /^[a-f0-9]{64}$/.test(raw)
      ? await this.sessions.validate(raw, opts)
      : null;
    if (session === null) {
      this.rejectBan(
        this.bruteForce.registerFailure(BAN_DIM_IP, ip, IP_AUTH_FAILURE_STEPS),
      );
      return null;
    }
    // Never clear the shared IP counter on success: another client behind the same NAT
    // (or an attacker with one valid credential) must not reset unsuccessful guesses.
    return {
      userId: session.userId,
      sessionId: session.sessionId,
      slid: session.slid,
      autoTerminateDays: session.autoTerminateDays,
      mustChangePassword: session.mustChangePassword,
    };
  }

  private rejectBan(bannedUntil: number | undefined): void {
    if (bannedUntil === undefined) return;
    throw new BusinessException(
      BusinessCode.RATE_LIMITED,
      'too many authentication failures',
      HttpStatus.TOO_MANY_REQUESTS,
      { bannedUntil },
    );
  }
}
