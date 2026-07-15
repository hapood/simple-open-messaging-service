import { Injectable } from '@nestjs/common';
import { SessionTokenService } from './session-token.service.js';

/**
 * Resolves a raw session credential (the `Authorization: Bearer <token>` header or the `media_token`
 * cookie) to a principal `{ userId, sessionId }` via the DB/KV-backed session lookup. The single source
 * of truth shared by the global {@link JwtAuthGuard} and the /uploads/* media preHandler — so the API
 * and media auth surfaces enforce identical rules (one session token authenticates both). There is no
 * access JWT anymore; every request presents the long-lived session token.
 */
@Injectable()
export class BearerAuthService {
  constructor(private readonly sessions: SessionTokenService) {}

  async resolve(
    raw: string | null | undefined,
    opts: { ip?: string | null } = {},
  ): Promise<{ userId: number; sessionId: number | null } | null> {
    if (!raw) return null;
    const session = await this.sessions.validate(raw, opts);
    return session === null ? null : { userId: session.userId, sessionId: session.sessionId };
  }
}
