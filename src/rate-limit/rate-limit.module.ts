import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service.js';
import { ClientIdentityService } from './client-identity.service.js';
import { AuthPolicyRegistry } from './auth-policy.registry.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimitModeService } from './rate-limit-mode.service.js';
import { FixedWindowPolicyService } from './fixed-window-policy.service.js';

/** Authentication policy engine with per-policy enforce, shadow, and disabled modes. */
@Global()
@Module({
  providers: [
    RateLimitService,
    ClientIdentityService,
    AuthPolicyRegistry,
    RateLimitGuard,
    RateLimitModeService,
    FixedWindowPolicyService,
  ],
  // Controllers declared by AppModule use RateLimitGuard directly via @UseGuards.
  // Export the guard's complete dependency graph so Nest can resolve that
  // controller-scoped guard from the importing module.
  exports: [
    RateLimitService,
    ClientIdentityService,
    AuthPolicyRegistry,
    RateLimitModeService,
    RateLimitGuard,
    FixedWindowPolicyService,
  ],
})
export class RateLimitModule {}
