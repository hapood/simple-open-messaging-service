import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminController } from './admin.controller.js';
import { AdminSettingsController } from './admin-settings.controller.js';
import { AdminFederationController } from './admin-federation.controller.js';
import { AdminQuotaController } from './admin-quota.controller.js';
import { MediaTransferAdminController } from './media-transfer-admin.controller.js';
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
import { FederationSelfCheckService } from './federation-self-check.service.js';
import { DashboardService } from './dashboard.service.js';
import { AuditTargetLabelService } from './audit-target-label.service.js';
import { AdminManageService } from './admin-manage.service.js';
import { GroupManageService } from './group-manage.service.js';
import { AdminBootstrapService } from './admin-bootstrap.service.js';
import { jwtConstants } from '../auth/constants.js';
import { AuthModule } from '../auth/auth.module.js';
import { UserManageModule } from '../user-manage/user-manage.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { PushModule } from '../push/push.module.js';
import { UploadModule } from '../upload/upload.module.js';
import { ResumableUploadModule } from '../upload/resumable-upload.module.js';
import { KvStoreModule } from '../kv-store/kv-store.module.js';
import { DiagnosticsModule } from '../diagnostics/diagnostics.module.js';
import { AdminDiagnosticsController } from '../diagnostics/diagnostics-admin.controller.js';
import { LoggerModule } from '../logger/logger.module.js';
import { LogViewerController } from '../logger/log-viewer.controller.js';
import { RateLimitMonitoringController } from './rate-limit-monitoring.controller.js';
import { FederationResetService } from './federation-reset.service.js';
import { FederationNamespaceAdminService } from './federation-namespace-admin.service.js';
import { MessageModule } from '../message/message.module.js';
import { AccountThreadStateModule } from '../account-thread-state/account-thread-state.module.js';
import { FederationModule } from '../federation/federation.module.js';
import { QuotaModule } from '../quota/quota.module.js';
import { MessageReportAdminController } from './message-report-admin.controller.js';
import { DurableTaskAdminController } from './durable-task-admin.controller.js';
import { MediaStorageStatsService } from './media-storage-stats.service.js';

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
    UploadModule,
    // ResumableUploadService backs MediaTransferAdminController (export/import transfer).
    ResumableUploadModule,
    // KvStoreService backs ThrottleGuard's counters (admin/login failure rate-limiting).
    KvStoreModule,
    // DiagnosticsService + DiagnosticsGcService back AdminDiagnosticsController (list/download/gc).
    DiagnosticsModule,
    // LogViewerService (exported by LoggerModule) backs LogViewerController (admin log tail + history).
    LoggerModule,
    MessageModule,
    AccountThreadStateModule,
    FederationModule,
    QuotaModule,
  ],
  controllers: [
    AdminController,
    AdminSettingsController,
    AdminFederationController,
    AdminQuotaController,
    MediaTransferAdminController,
    DashboardController,
    AuditController,
    AdminManageController,
    GroupManageController,
    TwoFactorController,
    WebAuthnController,
    AdminDiagnosticsController,
    LogViewerController,
    RateLimitMonitoringController,
    MessageReportAdminController,
    DurableTaskAdminController,
  ],
  providers: [
    AdminAuthService,
    TwoFactorService,
    WebAuthnService,
    AdminAuthGuard,
    AdminRolesGuard,
    FederationSelfCheckService,
    FederationResetService,
    FederationNamespaceAdminService,
    DashboardService,
    AuditTargetLabelService,
    AdminManageService,
    GroupManageService,
    MediaStorageStatsService,
    // Self-seeds the bootstrap admin (account=admin) on every app start via OnApplicationBootstrap;
    // idempotent, decoupled from the deploy orchestrator. See admin-bootstrap.service.ts.
    AdminBootstrapService,
    // Global audit: no-ops for any handler without @Audit metadata, so registering it app-wide is safe.
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
  ],
  exports: [AdminAuthService],
})
export class AdminModule {}
