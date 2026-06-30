import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * @Global：RedisService 被 JwtStrategy / LocalStrategy / AuthService / ThrottleGuard
 * 跨域注入，全局导出免去各模块逐个 import。
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
