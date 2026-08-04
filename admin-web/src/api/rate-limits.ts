import { request } from '@/api/client';

export type RateLimitMode = 'disabled' | 'shadow' | 'enforce';

export interface RateLimitStats {
  policy: string;
  mode: RateLimitMode;
  evaluated: number;
  allowed: number;
  wouldBlock: number;
  blocked: number;
  observeOnlyExceeded: number;
  maxRetryAfterMs: number;
}

export interface RateLimitSample extends RateLimitStats {
  startedAt: number;
  endedAt: number;
}

export interface RateLimitPolicyView {
  policy: string;
  mode: RateLimitMode;
  modeEnv: string;
  buckets: Array<{
    name: string;
    ratePerSecond: number;
    burst: number;
    enforce: boolean;
    rateEnv: string;
    burstEnv: string;
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
}

export function getRateLimitMonitoring(): Promise<RateLimitMonitoring> {
  return request<RateLimitMonitoring>('/admin/rate-limits');
}
