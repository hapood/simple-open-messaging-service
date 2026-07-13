import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service.js';

/**
 * @Global: RedisService is injected cross-module by JwtStrategy / LocalStrategy / AuthService / ThrottleGuard;
 * exporting it globally saves each module from importing it individually.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
