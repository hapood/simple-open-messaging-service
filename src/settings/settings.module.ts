import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service.js';

/**
 * Global settings facade. Consumers span multiple modules — PushService (PushModule), NotificationController
 * (AppModule root), and the admin settings controller (AdminModule) — so the module is @Global (precedent:
 * PrismaModule, MessageFanoutModule) and each consumer injects SettingsService without an explicit import.
 * PrismaService is itself global (PrismaModule), so it is available here without an import.
 */
@Global()
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
