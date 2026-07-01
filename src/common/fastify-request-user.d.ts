// Fastify's FastifyRequest type does not declare `user`, but @nestjs/passport attaches it to
// the request after a successful auth guard (JwtAuthGuard / LocalAuthGuard / AdminAuthGuard).
// Augmenting the interface here gives the whole codebase type-safe access to `req.user`
// (userId for the C-end auth, adminId for the admin console) without scattering casts.
declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      userId?: number;
      adminId?: number;
      [key: string]: unknown;
    };
  }
}

export {};
