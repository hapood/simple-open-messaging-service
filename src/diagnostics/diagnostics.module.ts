import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller.js';
import { DiagnosticsService } from './diagnostics.service.js';
import { DiagnosticsGcService } from './diagnostics-gc.service.js';
import { ThrottleGuard } from '../auth/throttle.guard.js';

@Module({
  // DatabaseService + KvStoreService are @Global, so no database/KV module import is needed.
  // ThrottleGuard is provided here (it is NOT exported by AuthModule) so the consumer route's
  // @UseGuards(ThrottleGuard) resolves; KvStoreService (@Global) + Reflector (Nest core) back it.
  // The admin controller (AdminDiagnosticsController) lives in AdminModule's controllers array — AdminModule
  // imports this module to consume DiagnosticsService + DiagnosticsGcService (mirrors UploadModule).
  controllers: [DiagnosticsController],
  providers: [DiagnosticsService, DiagnosticsGcService, ThrottleGuard],
  exports: [DiagnosticsService, DiagnosticsGcService],
})
export class DiagnosticsModule {}
