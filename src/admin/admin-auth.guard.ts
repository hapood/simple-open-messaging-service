import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Admin guard: uses the standalone 'admin-jwt' strategy (mirrors the SessionAuthGuard one-liner template). */
@Injectable()
export class AdminAuthGuard extends AuthGuard('admin-jwt') {}
