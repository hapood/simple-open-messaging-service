import { request } from '@/api/client';

export type RateLimitMode = 'disabled' | 'shadow' | 'enforce';

interface RateLimitStats {
  policy: string;
  mode: RateLimitMode;
  evaluated: number;
  allowed: number;
  wouldBlock: number;
  blocked: number;
  observeOnlyExceeded: number;
  maxRetryAfterMs: number;
}

interface RateLimitSample extends RateLimitStats {
  startedAt: number;
  endedAt: number;
}

export interface RateLimitPolicyView {
  policy: string;
  mode: RateLimitMode;
  buckets: Array<{
    name: string;
    ratePerSecond: number;
    burst: number;
    enforce: boolean;
  }>;
  totals: RateLimitStats;
  samples: RateLimitSample[];
  advice: Array<{
    code: string;
    level: 'info' | 'warning' | 'critical';
    message: string;
  }>;
}

export interface RateLimitMonitoring {
  generatedAt: number;
  intervalSeconds: number;
  retentionIntervals: number;
  policies: RateLimitPolicyView[];
  fixedWindowPolicies: FixedWindowPolicy[];
}

export interface FixedWindowPolicy {
  policy: string;
  limit: number;
  windowSeconds: number;
}

export function getRateLimitMonitoring(): Promise<RateLimitMonitoring> {
  return request<RateLimitMonitoring>('/admin/rate-limits');
}

export type RateLimitPolicyConfiguration = Pick<
  RateLimitPolicyView,
  'policy' | 'mode' | 'buckets'
>;

export function saveRateLimitConfiguration(
  policies: RateLimitPolicyConfiguration[],
): Promise<RateLimitPolicyConfiguration[]> {
  return request<RateLimitPolicyConfiguration[]>(
    '/admin/rate-limits/configuration',
    policies,
  );
}

export function saveFixedWindowConfiguration(
  policies: FixedWindowPolicy[],
): Promise<FixedWindowPolicy[]> {
  return request<FixedWindowPolicy[]>(
    '/admin/rate-limits/fixed-window-configuration',
    policies,
  );
}
