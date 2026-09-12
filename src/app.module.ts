import { RevokeGroupRelationshipTaskHandler } from './relationship/revoke-group-relationship-task.handler.js';
import { RevokeUserRelationshipTaskHandler } from './relationship/revoke-user-relationship-task.handler.js';
import { Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
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
import { AccountThreadStateModule } from './account-thread-state/account-thread-state.module.js';
import { RelationshipModule } from './relationship/relationship.module.js';
import { RelationshipController } from './controller/relationship.controller.js';
import { PushModule } from './push/push.module.js';
import { FederationModule } from './federation/federation.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { DeviceController } from './controller/device.controller.js';
import { NotificationController } from './controller/notification.controller.js';
import { HealthController } from './controller/health.controller.js';
import { ConfigController } from './controller/config.controller.js';
import { AuthOtpController } from './controller/auth-otp.controller.js';
import { AuthQrController } from './controller/auth-qr.controller.js';
import { MessageFanoutModule } from './message/message-fanout.module.js';
import { ClientStateFeedModule } from './client-state-feed/client-state-feed.module.js';
import { QuotaModule } from './quota/quota.module.js';
import { ShellModule } from './shell/shell.module.js';
import { ShellController } from './shell/shell.controller.js';
import { DiagnosticsModule } from './diagnostics/diagnostics.module.js';
import { LinkPreviewModule } from './link-preview/link-preview.module.js';
import { CallsModule } from './calls/calls.module.js';
import { CallsController } from './controller/calls.controller.js';
import { ForwardBundleModule } from './forward/forward-bundle.module.js';
import { DatabaseModule } from './database/database.module.js';
import { ThreadPreviewModule } from './message/thread-preview.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { DurableTaskModule } from './durable-task/durable-task.module.js';
import { DurableTaskSchedulerService } from './durable-task/durable-task-scheduler.service.js';
import { DurableAsyncTaskSchedulerService } from './durable-task/durable-async-task-scheduler.service.js';
import { DatabaseService } from './database/database.service.js';
import { ClientStateFeedService } from './client-state-feed/client-state-feed.service.js';
import { PeerStateFeedService } from './federation/peer-state-feed.service.js';
import { FederationService } from './federation/federation.service.js';
import { FederationNamespaceService } from './federation/federation-namespace.service.js';
import { UserIntentService } from './business/user/p2p-intent/user-intent.service.js';

// Static serving (uploaded images + the web/admin SPAs) is wired in main.ts via @fastify/static,
// not a Nest module — @nestjs/serve-static silently dropped maxAge on the Fastify path
// (nestjs/serve-static#187) and assumed an h1 ServerResponse in setHeaders.

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    // Registers the SchedulerOrchestrator that scans providers for @Interval/@Timeout/@Cron and clears
    // intervals in beforeApplicationShutdown. One-time global registration.
    ScheduleModule.forRoot(),
    LoggerModule,
    RateLimitModule,
    KvStoreModule,
    AuthModule,
    UserModule,
    GatewayModule,
    MessageModule,
    GroupModule,
    UploadModule,
    AdminModule,
    AccountThreadStateModule,
    RelationshipModule,
    PushModule,
    FederationModule,
    DatabaseModule,
    ThreadPreviewModule,
    SettingsModule,
    MessageFanoutModule,
    ClientStateFeedModule,
    QuotaModule,
    ShellModule,
    DiagnosticsModule,
    LinkPreviewModule,
    CallsModule,
    ForwardBundleModule,
    DurableTaskModule,
  ],
  controllers: [
    MessageController,
    AuthController,
    UserController,
    GroupController,
    RelationshipController,
    DeviceController,
    NotificationController,
    HealthController,
    ConfigController,
    AuthOtpController,
    AuthQrController,
    ShellController,
    CallsController,
  ],
  providers: [
    RevokeUserRelationshipTaskHandler,
    RevokeGroupRelationshipTaskHandler,
    {
      // The intent service takes a single dependencies object, so it wires as a
      // factory. AppModule is the one scope that sees every dependency without a
      // module cycle (FederationModule imports RelationshipModule).
      provide: UserIntentService,
      inject: [
        DatabaseService,
        ClientStateFeedService,
        PeerStateFeedService,
        FederationService,
        FederationNamespaceService,
      ],
      useFactory: (
        database: DatabaseService,
        clientFeed: ClientStateFeedService,
        peerFeed: PeerStateFeedService,
        federation: FederationService,
        namespaces: FederationNamespaceService,
      ) =>
        new UserIntentService({
          database,
          clientFeed,
          peerFeed,
          federation,
          namespaces,
        }),
    },
  ],
})
export class AppModule implements OnModuleDestroy {
  private readonly logger = new Logger(AppModule.name);

  constructor(
    private readonly tasks: DurableTaskSchedulerService,
    private readonly asyncTasks: DurableAsyncTaskSchedulerService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    // Root teardown precedes imported modules: handlers and their dependencies
    // must stay registered until both schedulers have finished in-flight work.
    this.logger.log(
      'shutdown: stopping durable task dispatch and waiting for in-flight work',
    );
    await Promise.all([this.tasks.stop(), this.asyncTasks.stop()]);
    this.logger.log('shutdown: durable task execution drained');
  }
}
