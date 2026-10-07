import { Module } from '@nestjs/common';
import { QuotaService } from './quota.service.js';
import { UserQuotaService } from './user-quota.service.js';

/**
 * Quota services share infrastructure but keep separate accounting boundaries: federated peers are
 * domain-scoped, while local accounts are userId-scoped. Enforcement and admin surfaces import
 * this module explicitly to inject the appropriate service.
 */
@Module({
  providers: [QuotaService, UserQuotaService],
  exports: [QuotaService, UserQuotaService],
})
export class QuotaModule {}
