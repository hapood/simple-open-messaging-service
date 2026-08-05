import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminController } from './admin.controller.js';
import { AdminSettingsController } from './admin-settings.controller.js';
import { AdminFederationController } from './admin-federation.controller.js';
import { AdminQuotaController } from './admin-quota.controller.js';
import { MediaAssetGcController } from './media-asset-gc.controller.js';
import { DashboardController } from './dashboard.controller.js';
import { AuditController } from './audit.controller.js';
import { AdminManageController } from './admin-manage.controller.js';
import { GroupManageController } from './group-manage.controller.js';
import { TwoFactorController } from './two-factor.controller.js';
import { WebAuthnController } from './webauthn.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { TwoFactorService } from './two-factor.service.js';
import { WebAuthnService } from './webauthn.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { AdminAuditInterceptor } from './admin-audit.interceptor.js';
import { MediaAssetGcService } from './media-asset-gc.service.js';
import { FederationSelfCheckService } from './federation-self-check.service.js';
import { DashboardService } from './dashboard.service.js';
import { AuditTargetLabelService } from './audit-target-label.service.js';
import { AdminManageService } from './admin-manage.service.js';
import { GroupManageService } from './group-manage.service.js';
import { AdminBootstrapService } from './admin-bootstrap.service.js';
import { ThrottleGuard } from '../auth/throttle.guard.js';
import { jwtConstants } from '../auth/constants.js';
import { AuthModule } from '../auth/auth.module.js';
import { UserManageModule } from '../user-manage/user-manage.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { PushModule } from '../push/push.module.js';
import { UploadModule } from '../upload/upload.module.js';
import { KvStoreModule } from '../kv-store/kv-store.module.js';
import { DiagnosticsModule } from '../diagnostics/diagnostics.module.js';
import { AdminDiagnosticsController } from '../diagnostics/diagnostics-admin.controller.js';
import { LoggerModule } from '../logger/logger.module.js';
import { LogViewerController } from '../logger/log-viewer.controller.js';
import { LinkPreviewModule } from '../link-preview/link-preview.module.js';
import { LinkCardRuleAdminController } from './link-card-rule-admin.controller.js';
import { RateLimitMonitoringController } from './rate-limit-monitoring.controller.js';
import { FederationResetService } from './federation-reset.service.js';
import { MessageModule } from '../message/message.module.js';
import { ThreadParticipantModule } from '../thread-participant/thread-participant.module.js';
import { MessageReportAdminController } from './message-report-admin.controller.js';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({ secret: jwtConstants.adminSecret }),
    AuthModule,
    UserManageModule,
    // SseService (exported by GatewayModule) powers the admin/connections live-SSE observation.
    GatewayModule,
    // PushService (exported by PushModule) powers admin/push device-token management + test pushes.
    PushModule,
    // UploadService lets MediaAssetGcService resolve CAS and avatar paths for manual cleanup.
    UploadModule,
    // KvStoreService backs ThrottleGuard's counters (admin/login failure rate-limiting).
    KvStoreModule,
    // DiagnosticsService + DiagnosticsGcService back AdminDiagnosticsController (list/download/gc).
    DiagnosticsModule,
    // LogViewerService (exported by LoggerModule) backs LogViewerController (admin log tail + history).
    LoggerModule,
    LinkPreviewModule,
    MessageModule,
    ThreadParticipantModule,
  ],
  controllers: [
    AdminController,
    AdminSettingsController,
    AdminFederationController,
    AdminQuotaController,
    MediaAssetGcController,
    DashboardController,
    AuditController,
    AdminManageController,
    GroupManageController,
    TwoFactorController,
    WebAuthnController,
    AdminDiagnosticsController,
    LogViewerController,
    LinkCardRuleAdminController,
    RateLimitMonitoringController,
    MessageReportAdminController,
  ],
  providers: [
    AdminAuthService,
    TwoFactorService,
    WebAuthnService,
    AdminAuthGuard,
    AdminRolesGuard,
    MediaAssetGcService,
    FederationSelfCheckService,
    FederationResetService,
    DashboardService,
    AuditTargetLabelService,
    AdminManageService,
    GroupManageService,
    // Self-seeds the bootstrap admin (account=admin) on every app start via OnApplicationBootstrap;
    // idempotent, decoupled from the deploy orchestrator. See admin-bootstrap.service.ts.
    AdminBootstrapService,
    // ThrottleGuard is opt-in per route via @Throttle (no metadata → canActivate returns true), so it
    // is safe to register here even though most admin routes don't use it.
    ThrottleGuard,
    // Global audit: no-ops for any handler without @Audit metadata, so registering it app-wide is safe.
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
  ],
  exports: [AdminAuthService],
})
export class AdminModule {}
