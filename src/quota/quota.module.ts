import { Global, Module } from '@nestjs/common';
import { QuotaService } from './quota.service.js';
import { UserQuotaService } from './user-quota.service.js';

/**
 * Quota services share infrastructure but keep separate accounting boundaries: federated peers are
 * domain-scoped, while local accounts are userId-scoped. @Global lets enforcement and admin surfaces
 * inject the appropriate service without coupling feature modules to one another.
 */
@Global()
@Module({
  providers: [QuotaService, UserQuotaService],
  exports: [QuotaService, UserQuotaService],
})
export class QuotaModule {}
