import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AdminAuthService } from './admin-auth.service.js';
import { ADMIN_SESSION_COOKIE } from './admin-session.js';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const origin = request.headers.origin;
    if (origin) {
      const forwardedProto = String(request.headers['x-forwarded-proto'] ?? request.protocol).split(',')[0];
      const forwardedHost = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0];
      if (!forwardedHost || origin !== `${forwardedProto}://${forwardedHost}`) {
        throw new UnauthorizedException('invalid origin');
      }
    }
    const token = request.cookies?.[ADMIN_SESSION_COOKIE];
    if (!token) throw new UnauthorizedException();
    const principal = await this.auth.validateAdminSession(token, request.ip);
    if (!principal) throw new UnauthorizedException();
    request.user = principal;
    return true;
  }
}
