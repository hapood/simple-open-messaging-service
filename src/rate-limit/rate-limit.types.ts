export type RateLimitMode = 'disabled' | 'shadow' | 'enforce';

export interface RateLimitSubject {
  /** Stable dimension name, for example user, ip-exact, ip-prefix64, admin or peer. */
  type: string;
  /** Canonical value. It must not contain a raw URL or bearer credential. */
  key: string;
}

export interface RateLimitRule {
  subject: RateLimitSubject;
  ratePerSecond: number;
  burst: number;
  cost?: number;
  /** Observe-only rules collect signal but can never reject a request. Defaults to true. */
  enforce?: boolean;
}

export interface RateLimitPolicy {
  /** Stable business scope such as auth.login or message.send; never an instantiated URL. */
  name: string;
  mode: RateLimitMode;
  rules: readonly RateLimitRule[];
}

export interface RateLimitRuleResult {
  subjectType: string;
  enforce: boolean;
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimitResult {
  policy: string;
  mode: RateLimitMode;
  /** Effective decision. Disabled and shadow policies always allow the request. */
  allowed: boolean;
  /** Whether enforcement would have rejected this request. */
  wouldBlock: boolean;
  retryAfterMs: number;
  rules: readonly RateLimitRuleResult[];
}
