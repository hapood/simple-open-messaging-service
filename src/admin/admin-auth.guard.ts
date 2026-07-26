import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AdminAuthService } from './admin-auth.service.js';
import { ADMIN_SESSION_COOKIE } from './admin-session.js';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    // CSRF is carried by the `admin_session` cookie's SameSite=Strict: a cross-site request cannot
    // attach it, so it arrives with no credential and is rejected at the token check below — the same
    // posture as the global SessionAuthGuard. There is deliberately NO Origin/Host validation here: it
    // would compare Origin against X-Forwarded-Host, which the dev vite proxy does not forward (Caddy
    // forwards it only in prod), so it rejected every authenticated request in dev while adding nothing
    // beyond SameSite=Strict for a cookie credential.
    const token = request.cookies?.[ADMIN_SESSION_COOKIE];
    if (!token) throw new UnauthorizedException();
    const principal = await this.auth.validateAdminSession(token, request.ip);
    if (!principal) throw new UnauthorizedException();
    request.user = principal;
    return true;
  }
}
