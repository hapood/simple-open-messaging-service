import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from './logger/logger.module.js';
import { MessageController } from './controller/message.controller.js';
import { AuthController } from './controller/auth.controller.js';
import { UserModule } from './user/user.module.js';
import { MessageModule } from './message/message.module.js';
import { AuthModule } from './auth/auth.module.js';
import { GatewayModule } from './gateway/gateway.module.js';
import { UserController } from './controller/user.controller.js';
import { GroupModule } from './group/group.module.js';
import { GroupController } from './controller/group.controller.js';
import { UploadModule } from './upload/upload.module.js';
import { KvStoreModule } from './kv-store/kv-store.module.js';
import { AdminModule } from './admin/admin.module.js';
import { ThreadParticipantModule } from './thread-participant/thread-participant.module.js';
import { InviteModule } from './invite/invite.module.js';
import { InviteController } from './controller/invite.controller.js';
import { PushModule } from './push/push.module.js';
import { UserBlockModule } from './user-block/user-block.module.js';
import { FederationModule } from './federation/federation.module.js';
import { PrismaModule } from './prisma.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { DeviceController } from './controller/device.controller.js';
import { NotificationController } from './controller/notification.controller.js';
import { HealthController } from './controller/health.controller.js';
import { ConfigController } from './controller/config.controller.js';
import { AuthOtpController } from './controller/auth-otp.controller.js';
import { AuthQrController } from './controller/auth-qr.controller.js';
import { MessageFanoutModule } from './message/message-fanout.module.js';
import { ThreadRevisionModule } from './thread-revision/thread-revision.module.js';
import { QuotaModule } from './quota/quota.module.js';
import { ShellModule } from './shell/shell.module.js';
import { ShellController } from './shell/shell.controller.js';
import { DiagnosticsModule } from './diagnostics/diagnostics.module.js';
import { LinkPreviewModule } from './link-preview/link-preview.module.js';

// Static serving (uploaded images + the web/admin SPAs) is wired in main.ts via @fastify/static,
// not a Nest module — @nestjs/serve-static silently dropped maxAge on the Fastify path
// (nestjs/serve-static#187) and assumed an h1 ServerResponse in setHeaders.

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    LoggerModule,
    KvStoreModule,
    AuthModule,
    UserModule,
    GatewayModule,
    MessageModule,
    GroupModule,
    UploadModule,
    AdminModule,
    ThreadParticipantModule,
    InviteModule,
    PushModule,
    UserBlockModule,
    FederationModule,
    PrismaModule,
    SettingsModule,
    MessageFanoutModule,
    ThreadRevisionModule,
    QuotaModule,
    ShellModule,
    DiagnosticsModule,
    LinkPreviewModule,
  ],
  controllers: [
    MessageController,
    AuthController,
    UserController,
    GroupController,
    InviteController,
    DeviceController,
    NotificationController,
    HealthController,
    ConfigController,
    AuthOtpController,
    AuthQrController,
    ShellController,
  ],
  providers: [],
})
export class AppModule {}
