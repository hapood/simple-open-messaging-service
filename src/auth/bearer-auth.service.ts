import { Injectable } from '@nestjs/common';
import { AccessTokenValidator } from './access-token.validator.js';
import { SessionTokenService } from './session-token.service.js';

/**
 * Resolves a raw credential (the value of an `Authorization: Bearer <token>` header or the
 * `media_token` cookie) to a principal `{ userId, sessionId }` (sessionId null for the legacy access
 * JWT, which has no SessionToken row), trying the access JWT first and then a session token. The
 * single source of truth shared by the global {@link JwtAuthGuard} and the /uploads/*
 * media preHandler — so the API and media auth surfaces enforce identical rules and both accept
 * either credential kind.
 *
 * Order matters: the access JWT is stateless (signature verify is cheap and side-effect-free), so it
 * is tried first; a session token is not a JWT (it carries no dots, so `verifyToken` returns null
 * without ambiguity) and falls through to the DB/KV-backed session lookup.
 */
@Injectable()
export class BearerAuthService {
  constructor(
    private readonly access: AccessTokenValidator,
    private readonly sessions: SessionTokenService,
  ) {}

  async resolve(
    raw: string | null | undefined,
    opts: { ip?: string | null } = {},
  ): Promise<{ userId: number; sessionId: number | null } | null> {
    if (!raw) return null;
    const payload = this.access.verifyToken(raw);
    if (payload) {
      // Legacy access JWT — no SessionToken row, so sessionId is null (the device list can't mark a
      // current session for an access-JWT request; irrelevant once Phase 4 cuts the access JWT).
      const principal = await this.access.validatePayload(payload);
      return principal === null ? null : { userId: principal.userId, sessionId: null };
    }
    const session = await this.sessions.validate(raw, opts);
    return session === null
      ? null
      : { userId: session.userId, sessionId: session.sessionId };
  }
}
