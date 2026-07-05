import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { NotificationTokenService } from './notification-token.service.js';

/**
 * Admits a request carrying a notification token in the `Authorization: Bearer <token>` header — the
 * credential the Android NotificationSyncWorker uses to call /notifications/missed. lighter than a
 * Passport strategy (the token is an opaque random string, not a JWT, so JWT verification is moot).
 * On success, `req.user = { userId }` — the same shape JwtAuthGuard leaves behind, so the controller
 * reads `req.user.userId` identically.
 *
 * Scope discipline: apply this guard ONLY to /notifications/* routes. A notification token grants no
 * other app access — even if it leaks, the worst case is "attacker learns the user's unread-thread
 * summary," not message contents or send capability.
 */
@Injectable()
export class NotificationTokenGuard implements CanActivate {
  constructor(private readonly tokens: NotificationTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers['authorization'] ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) {
      throw new UnauthorizedException('missing notification token');
    }
    const userId = await this.tokens.validate(match[1]);
    if (userId === null) {
      throw new UnauthorizedException('invalid or expired notification token');
    }
    (req as unknown as { user: { userId: number } }).user = { userId };
    return true;
  }
}
