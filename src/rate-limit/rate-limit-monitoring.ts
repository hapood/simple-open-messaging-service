import type { RateLimitMode } from './rate-limit.types.js';

type RateLimitAdviceLevel = 'info' | 'warning' | 'critical';

export interface RateLimitAdvice {
  code: string;
  level: RateLimitAdviceLevel;
  message: string;
}

export interface RateLimitAdviceInput {
  mode: RateLimitMode;
  evaluated: number;
  wouldBlock: number;
  blocked: number;
  maxRetryAfterMs: number;
  lastActivityAt?: number;
  observationStartedAt: number;
  now: number;
}

/** Conservative, deterministic hints. They never change configuration automatically. */
export function rateLimitAdvice(
  input: RateLimitAdviceInput,
): RateLimitAdvice[] {
  const advice: RateLimitAdvice[] = [];
  const hits = input.mode === 'shadow' ? input.wouldBlock : input.blocked;
  const ratio = input.evaluated > 0 ? hits / input.evaluated : 0;

  if (input.mode === 'disabled') {
    advice.push({
      code: 'disabled',
      level: 'critical',
      message: 'Policy is disabled; enable shadow observation or enforcement.',
    });
  }
  if (input.evaluated < 1_000) {
    advice.push({
      code: 'insufficient-sample',
      level: 'info',
      message:
        'Fewer than 1,000 requests observed; do not tune or promote from this sample alone.',
    });
  }
  const activityReference = input.lastActivityAt ?? input.observationStartedAt;
  if (input.now - activityReference > 30 * 60 * 1000) {
    advice.push({
      code: 'stale',
      level: 'warning',
      message:
        'No requests observed for 30 minutes; verify traffic and monitoring wiring.',
    });
  }
  if (input.evaluated >= 100 && ratio >= 0.05) {
    advice.push({
      code: input.mode === 'shadow' ? 'high-would-block' : 'high-block-rate',
      level: ratio >= 0.2 ? 'critical' : 'warning',
      message:
        input.mode === 'shadow'
          ? 'High would-block ratio; inspect shared NAT/retries and consider raising burst before rate.'
          : 'High block ratio; distinguish attack traffic from false positives before tuning.',
    });
  }
  if (input.maxRetryAfterMs >= 30_000) {
    advice.push({
      code: 'long-retry',
      level: 'warning',
      message:
        'Retry delay reached 30 seconds; burst or refill rate may be too restrictive.',
    });
  }
  if (input.mode === 'shadow' && input.evaluated >= 1_000 && ratio < 0.01) {
    advice.push({
      code: 'review-ready',
      level: 'info',
      message:
        'Sample is large with a low would-block ratio; ready for human rollout review.',
    });
  }
  return advice;
}
