import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics.service.js';
import { DiagnosticsGcService } from './diagnostics-gc.service.js';

@Module({
  // DatabaseService + KvStoreService are @Global, so no database/KV module import is needed.
  // ThrottleGuard is exported globally by RateLimitModule, so the consumer route's
  // @UseGuards(ThrottleGuard) resolves without a duplicate provider instance here.
  // The admin controller (AdminDiagnosticsController) lives in AdminModule's controllers array — AdminModule
  // imports this module to consume DiagnosticsService + DiagnosticsGcService (mirrors UploadModule).
  controllers: [DiagnosticsController],
  providers: [DiagnosticsService, DiagnosticsGcService],
  exports: [DiagnosticsService, DiagnosticsGcService],
})
export class DiagnosticsModule {}
