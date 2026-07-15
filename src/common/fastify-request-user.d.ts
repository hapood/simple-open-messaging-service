// Fastify's FastifyRequest type does not declare `user`, but @nestjs/passport attaches it to
// the request after a successful auth guard (JwtAuthGuard / LocalAuthGuard / AdminAuthGuard).
// Augmenting the interface here gives the whole codebase type-safe access to `req.user`
// (userId for the C-end auth, adminId for the admin console) without scattering casts.
import type { MessageThreadType, ThreadParticipant } from '../prisma/generated/client.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Required on guarded routes: every auth guard (JwtAuthGuard / LocalAuthGuard / AdminAuthGuard /
    // the /uploads preHandler / notification-token guard) populates `user` before the handler runs, so a
    // controller reading `req.user.userId` is always in a context where it is set. Typed as the C-end
    // principal `{ userId }` (the dominant shape) with adminId/role optional for the admin console,
    // which reads those via casts rather than `req.user.userId`. The index signature absorbs the
    // richer objects some guards attach (e.g. LocalStrategy's LoginAuthInfo — cast at the read site).
    user: {
      userId: number;
      /** The requesting credential's SessionToken row id (set by JwtAuthGuard / the /uploads
       *  preHandler when the request authed via a session token). null when the request authed via
       *  the legacy access JWT (no session row); absent under admin/notification-token guards. Used by
       *  GET /auth/sessions to flag the current device. */
      sessionId?: number | null;
      adminId?: number;
      role?: string;
      [key: string]: unknown;
    };
    /**
     * Attached by ThreadAccessGuard on routes that carry a thread id in the body (the field name is
     * declared per-route via @ResourceId — `threadId` for message routes, `groupId` for group routes,
     * where the `groupId` value IS the threadId now that groups are `!`-User threads). Holds the
     * resolved thread id + type + the caller's ACTIVE ThreadParticipant (membership + role). Present
     * iff the guard ran and the caller is a current member; the controller + RolesGuard read it
     * instead of re-querying. P2P and GROUP routes share one access shape. Required on the guarded
     * routes that read it (every such route is behind ThreadAccessGuard, which populates it).
     */
    threadAccess: {
      threadId: number;
      /** P2P vs GROUP — resolved by the guard so message routes can branch (e.g. block-filter scoping
       *  applies to P2P only; group threads leave blocked members' messages visible). */
      threadType: MessageThreadType;
      participant: ThreadParticipant;
    };
    /**
     * Captured by the S2S preParsing hook (scoped to /api/v1/s2s/*): the exact request body bytes as
     * received over the wire. Required for RFC 9421 content-digest verification — re-serialized JSON
     * would not match the digest the sender signed. Read by S2sSignatureGuard.
     */
    rawBody?: Buffer;
    /**
     * Attached by S2sSignatureGuard on inbound S2S requests after a successful signature verify:
     * the verified signer's domain + keyId. Downstream handlers trust this (the guard verified the
     * signature + allow-list + binding rule).
     */
    peer?: { domain: string; keyId: string };
  }
}

export {};
