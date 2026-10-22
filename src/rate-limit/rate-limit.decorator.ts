import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_POLICY_METADATA = 'rate-limit-policy';

/** Attach a stable business policy name to a handler. The guard is deliberately opt-in. */
export const UseRateLimitPolicy = (policy: string) =>
  SetMetadata(RATE_LIMIT_POLICY_METADATA, policy);
