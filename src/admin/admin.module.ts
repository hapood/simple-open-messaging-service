import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminController } from './admin.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminJwtStrategy } from './admin.jwt.strategy.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { PrismaService } from '../prisma.service.js';
import { jwtConstants } from '../auth/constants.js';
import { AuthModule } from '../auth/auth.module.js';
import { UserManageModule } from '../user-manage/user-manage.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { PushModule } from '../push/push.module.js';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({ secret: jwtConstants.adminSecret }),
    AuthModule,
    UserManageModule,
    // SseService（导出自 GatewayModule）供 admin/connections 观测在线 SSE 连接。
    GatewayModule,
    // PushService（导出自 PushModule）供 admin/push 设备 token 管理 + 测试推送。
    PushModule,
  ],
  controllers: [AdminController],
  providers: [AdminAuthService, AdminJwtStrategy, AdminAuthGuard, PrismaService],
  exports: [AdminAuthService],
})
export class AdminModule {}
