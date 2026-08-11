// Fastify's FastifyRequest type does not declare `user`, but @nestjs/passport attaches it to
// the request after a successful auth guard (SessionAuthGuard / LocalAuthGuard / AdminAuthGuard).
// Augmenting the interface here gives the whole codebase type-safe access to `req.user`
// (userId for the C-end auth, adminId for the admin console) without scattering casts.
import type { MessageThreadType } from '../database/enums.js';
import type { threadParticipant } from '../database/schema.js';

type ThreadParticipant = typeof threadParticipant.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    // Required on guarded routes: every auth guard (SessionAuthGuard / LocalAuthGuard / AdminAuthGuard /
    // the /uploads preHandler) populates `user` before the handler runs, so a
    // controller reading `req.user.userId` is always in a context where it is set. Typed as the C-end
    // principal `{ userId }` (the dominant shape) with adminId/role optional for the admin console,
    // which reads those via casts rather than `req.user.userId`. The index signature absorbs the
    // richer objects some guards attach (e.g. LocalStrategy's LoginAuthInfo — cast at the read site).
    user: {
      userId: number;
      /** The requesting credential's SessionToken row id — always set under SessionAuthGuard / the
       *  /uploads preHandler (C-end auth is session-token only); absent under admin guards. Used by
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
      /** P2P friendship/write state. False for a retained historical conversation after unfriend. */
      friendshipActive: boolean;
      /** Whether this participant is still active in the conversation (P2P friend / current group member). */
      membershipActive: boolean;
      /** Terminal group state. History reads remain allowed; mutation controllers reject with GROUP_DISSOLVED. */
      groupDissolved: boolean;
    };
    /**
     * Captured by the S2S preParsing hook (scoped to /s2s/v1/*): the exact request body bytes as
     * received over the wire. Required for RFC 9421 content-digest verification — re-serialized JSON
     * would not match the digest the sender signed. Read by S2sSignatureGuard.
     */
    rawBody?: Buffer;
    /**
     * Attached by S2sSignatureGuard on inbound S2S requests after a successful signature verify:
     * the verified signer's domain + keyId. Downstream handlers trust this (the guard verified the
     * signature + allow-list + binding rule).
     */
    peer?: { domain: string; keyId: string; signatureExpiresAtSec: number };
  }
}

export {};
