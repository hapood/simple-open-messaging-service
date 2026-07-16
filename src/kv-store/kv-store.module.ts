import { Global, Module } from '@nestjs/common';
import { KvStoreService } from './kv-store.service.js';

/**
 * @Global: KvStoreService is injected cross-module by SessionTokenService (token-validation cache) and ThrottleGuard (rate-limit counters);
 * exporting it globally saves each module from importing it individually.
 */
@Global()
@Module({
  providers: [KvStoreService],
  exports: [KvStoreService],
})
export class KvStoreModule {}
