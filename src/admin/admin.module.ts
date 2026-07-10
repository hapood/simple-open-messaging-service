import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminController } from './admin.controller.js';
import { AdminFederationController } from './admin-federation.controller.js';
import { MediaAssetGcController } from './media-asset-gc.controller.js';
import { DashboardController } from './dashboard.controller.js';
import { AuditController } from './audit.controller.js';
import { AdminManageController } from './admin-manage.controller.js';
import { GroupManageController } from './group-manage.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminJwtStrategy } from './admin.jwt.strategy.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { AdminAuditInterceptor } from './admin-audit.interceptor.js';
import { MediaAssetGcService } from './media-asset-gc.service.js';
import { FederationSelfCheckService } from './federation-self-check.service.js';
import { DashboardService } from './dashboard.service.js';
import { AdminManageService } from './admin-manage.service.js';
import { GroupManageService } from './group-manage.service.js';
import { ThrottleGuard } from '../auth/throttle.guard.js';
import { jwtConstants } from '../auth/constants.js';
import { AuthModule } from '../auth/auth.module.js';
import { UserManageModule } from '../user-manage/user-manage.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { PushModule } from '../push/push.module.js';
import { UploadModule } from '../upload/upload.module.js';
import { RedisModule } from '../redis/redis.module.js';

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
    // UploadService（导出自 UploadModule）供 MediaAssetGcService 解析 shards/ 路径（refs<=0 回收）。
    UploadModule,
    // RedisService 供 ThrottleGuard 计数（admin/login 失败限流）。
    RedisModule,
  ],
  controllers: [AdminController, AdminFederationController, MediaAssetGcController, DashboardController, AuditController, AdminManageController, GroupManageController],
  providers: [
    AdminAuthService,
    AdminJwtStrategy,
    AdminAuthGuard,
    AdminRolesGuard,
    MediaAssetGcService,
    FederationSelfCheckService,
    DashboardService,
    AdminManageService,
    GroupManageService,
    // ThrottleGuard is opt-in per route via @Throttle (no metadata → canActivate returns true), so it
    // is safe to register here even though most admin routes don't use it.
    ThrottleGuard,
    // Global audit: no-ops for any handler without @Audit metadata, so registering it app-wide is safe.
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
  ],
  exports: [AdminAuthService],
})
export class AdminModule {}
