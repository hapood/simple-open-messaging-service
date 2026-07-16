import { Injectable } from '@nestjs/common';
import { SessionTokenService } from './session-token.service.js';

/**
 * Resolves a raw session credential (the `Authorization: Bearer <token>` header or the `media_token`
 * cookie) to a principal `{ userId, sessionId, slid, persistent }` via the DB/KV-backed session lookup.
 * `slid` (the web/desktop deadline moved this call) + `persistent` (cookie-persistence choice) let the
 * guard / /uploads validator re-issue the browser cookie so its lifetime tracks the sliding session. The
 * single source of truth shared by the global {@link SessionAuthGuard} and the /uploads/* media preHandler —
 * so the API and media auth surfaces enforce identical rules (one session token authenticates both).
 * There is no access JWT anymore; every request presents the long-lived session token.
 */
@Injectable()
export class BearerAuthService {
  constructor(private readonly sessions: SessionTokenService) {}

  async resolve(
    raw: string | null | undefined,
    opts: { ip?: string | null } = {},
  ): Promise<{ userId: number; sessionId: number | null; slid: boolean; persistent: boolean; mustChangePassword: boolean } | null> {
    if (!raw) return null;
    const session = await this.sessions.validate(raw, opts);
    return session === null
      ? null
      : {
          userId: session.userId,
          sessionId: session.sessionId,
          slid: session.slid,
          persistent: session.persistent,
          mustChangePassword: session.mustChangePassword,
        };
  }
}
