import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { jwtConstants } from './constants.js';
import { RedisService } from '../redis/redis.service.js';
import { PrismaService } from '../prisma.service.js';

/** Access-token JWT claims: sub = userId, jti = unique token id, tver = tokenVersion at issuance. */
export type AccessPayload = {
  sub: number;
  jti?: string;
  tver?: number;
  iat?: number;
  exp?: number;
};

/**
 * Single source of truth for access-token validation, shared by the Passport JwtStrategy
 * (Bearer-header API auth) and the /uploads/* Fastify hook (httpOnly-cookie media auth).
 *
 * Keeping the revocation rules in one place — jti blacklist (single-token revoke) + tokenVersion
 * (global session invalidation) — means a token accepted by the API is exactly as valid for media,
 * and a logout that revokes one revokes both. Both auth surfaces can never drift.
 */
@Injectable()
export class AccessTokenValidator {
  constructor(
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Verify signature + expiry of a raw access token, returning the payload or null on any failure
   * (bad signature, expired, malformed). The /uploads/ hook uses this — it receives the raw cookie
   * value, not a Passport-verified payload. Synchronous because JwtService.verify is synchronous.
   */
  verifyToken(raw: string): AccessPayload | null {
    try {
      return this.jwtService.verify<AccessPayload>(raw);
    } catch {
      return null;
    }
  }

  /**
   * Revocation-aware check on an already-verified payload:
   * 1. jti blacklist (single-token revoke) → reject (fail-open if Redis is down).
   * 2. tokenVersion: claim.tver must equal the user's current version (global logout / password
   *    change bumps it), else reject.
   * Legacy tokens (pre-Phase-2, no jti/tver) pass through to natural expiry (≤15min).
   * Returns the authenticated principal, or null (→ 401 for the API, 401 for media).
   */
  async validatePayload(
    payload: AccessPayload,
  ): Promise<{ userId: number } | null> {
    if (!payload.jti || payload.tver === undefined) {
      return { userId: payload.sub }; // legacy token compat
    }
    if (this.redis.enabled) {
      const blocked = await this.redis
        .existsKey(`access:jti:${payload.jti}`)
        .catch(() => false);
      if (blocked) return null;
    }
    const cur = await this.currentTokenVersion(payload.sub);
    if (cur !== payload.tver) return null;
    return { userId: payload.sub };
  }

  /** Current tokenVersion: Redis cache (60s) → DB fallback. Redis error falls back to DB (correctness lives in the DB). */
  private async currentTokenVersion(userId: number): Promise<number> {
    if (this.redis.enabled) {
      const cached = await this.redis
        .get(`access:tver:${userId}`)
        .catch(() => null);
      if (cached !== null) return Number(cached);
    }
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true, isDeleted: true },
    });
    // user gone OR admin-disabled (soft-deleted) → sentinel that matches no issued tver → reject.
    // Defense-in-depth: admin disable already bumps tokenVersion (invalidateAllSessions), so this is the
    // backstop for any future disable path that forgets to bump. Cached only on the happy path below.
    if (!u || u.isDeleted) return -1;
    if (this.redis.enabled) {
      await this.redis
        .setex(`access:tver:${userId}`, 60, String(u.tokenVersion))
        .catch(() => {});
    }
    return u.tokenVersion;
  }
}

/** Cookie name carrying the access token for same-origin /uploads/* media requests. */
export const MEDIA_TOKEN_COOKIE = 'media_token';

/** Cookie options for the media access token. `secure: 'auto'` honors X-Forwarded-Proto (trustProxy:1), so it
 *  is set over TLS in prod and dropped correctly in plain-HTTP dev. httpOnly keeps it JS-unreadable (XSS-safe);
 *  sameSite:'strict' blocks cross-site sending while same-origin <img>/<a> still attach it automatically. */
export const MEDIA_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: 'auto' as const,
  path: '/',
  maxAge: jwtConstants.accessTtlSec,
};
