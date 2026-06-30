import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Admin 守卫：走独立 'admin-jwt' 策略（照 JwtAuthGuard one-liner 模板）。 */
@Injectable()
export class AdminAuthGuard extends AuthGuard('admin-jwt') {}
