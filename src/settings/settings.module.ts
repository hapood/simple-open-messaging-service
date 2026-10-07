import { Global, Module } from '@nestjs/common';
import { FederationModule } from '../federation/federation.module.js';
import { SettingsService } from './settings.service.js';

/**
 * Global settings facade. Consumers span multiple modules — PushService (PushModule), NotificationController
 * (AppModule root), and the admin settings controller (AdminModule) — so the module is @Global (precedent:
 * DatabaseModule and MessageFanoutModule) and each consumer injects SettingsService without an explicit
 * import. DatabaseService is itself global, so it is available here without an import. SettingsService
 * reads the persisted federation identity domain through KeypairService, so FederationModule is imported
 * explicitly (the established pattern for its consumers, e.g. AdminModule); it does not import this
 * module back — its own consumers reach SettingsService through the global scope — so the edge is acyclic.
 */
@Global()
@Module({
  imports: [FederationModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
