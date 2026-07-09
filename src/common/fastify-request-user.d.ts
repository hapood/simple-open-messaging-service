// Fastify's FastifyRequest type does not declare `user`, but @nestjs/passport attaches it to
// the request after a successful auth guard (JwtAuthGuard / LocalAuthGuard / AdminAuthGuard).
// Augmenting the interface here gives the whole codebase type-safe access to `req.user`
// (userId for the C-end auth, adminId for the admin console) without scattering casts.
import type { MessageThreadType, ThreadParticipant } from '../prisma/generated/client.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      userId?: number;
      adminId?: number;
      [key: string]: unknown;
    };
    /**
     * Attached by ThreadAccessGuard on routes that carry a thread id in the body (the field name is
     * declared per-route via @ResourceId — `threadId` for message routes, `groupId` for group routes,
     * where the `groupId` value IS the threadId now that groups are `!`-User threads). Holds the
     * resolved thread id + type + the caller's ACTIVE ThreadParticipant (membership + role). Present
     * iff the guard ran and the caller is a current member; the controller + RolesGuard read it
     * instead of re-querying. P2P and GROUP routes share one access shape.
     */
    threadAccess?: {
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
