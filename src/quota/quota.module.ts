import { Global, Module } from '@nestjs/common';
import { QuotaService } from './quota.service.js';

/**
 * Unified daily-quota enforcement (local SOMS_DOMAIN node + each federated peer). @Global so the
 * federation service, the local user-facing controllers (message / upload / invite), and the admin
 * controller all inject QuotaService without per-module imports.
 */
@Global()
@Module({
  providers: [QuotaService],
  exports: [QuotaService],
})
export class QuotaModule {}
