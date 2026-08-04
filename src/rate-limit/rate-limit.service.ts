import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { createHmac, randomBytes } from 'node:crypto';
import { TokenBucketStore } from './token-bucket.store.js';
import type {
  RateLimitPolicy,
  RateLimitResult,
  RateLimitRuleResult,
} from './rate-limit.types.js';

export interface RateLimitPolicyStats {
  policy: string;
  mode: RateLimitPolicy['mode'];
  evaluated: number;
  allowed: number;
  wouldBlock: number;
  blocked: number;
  observeOnlyExceeded: number;
  maxRetryAfterMs: number;
}

export interface RateLimitStatsInterval {
  startedAt: number;
  endedAt: number;
  policies: RateLimitPolicyStats[];
}

const SUMMARY_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 288;

/**
 * Policy executor for the new limiter. Nothing calls this service from the request pipeline in
 * Policies choose whether evaluated decisions are enforced, observed in shadow, or disabled.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly store = new TokenBucketStore();
  private readonly stats = new Map<string, RateLimitPolicyStats>();
  private readonly history: RateLimitStatsInterval[] = [];
  private intervalStartedAt = Date.now();
  private readonly subjectHashKey = randomBytes(32);
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly summaryTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.store.cleanup(performance.now()),
      5 * 60 * 1000,
    );
    this.cleanupTimer.unref();
    this.summaryTimer = setInterval(
      () => this.flushSummary(),
      SUMMARY_INTERVAL_MS,
    );
    this.summaryTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
    clearInterval(this.summaryTimer);
  }

  evaluate(
    policy: RateLimitPolicy,
    nowMs = performance.now(),
  ): RateLimitResult {
    validatePolicy(policy);
    if (policy.mode === 'disabled') {
      return {
        policy: policy.name,
        mode: policy.mode,
        allowed: true,
        wouldBlock: false,
        retryAfterMs: 0,
        rules: [],
      };
    }
    const rules: RateLimitRuleResult[] = policy.rules.map((rule) => {
      const decision = this.store.consume(
        `${policy.name}:${rule.subject.type}:${rule.subject.key}`,
        { ratePerSecond: rule.ratePerSecond, burst: rule.burst },
        rule.cost ?? 1,
        nowMs,
      );
      return {
        subjectType: rule.subject.type,
        enforce: rule.enforce !== false,
        ...decision,
      };
    });
    const wouldBlock = rules.some((rule) => !rule.allowed);
    const enforcedBlocks = rules.filter(
      (rule) => rule.enforce && !rule.allowed,
    );
    const result: RateLimitResult = {
      policy: policy.name,
      mode: policy.mode,
      allowed: policy.mode === 'shadow' || enforcedBlocks.length === 0,
      wouldBlock,
      retryAfterMs: Math.max(
        0,
        ...enforcedBlocks.map((rule) => rule.retryAfterMs),
      ),
      rules,
    };
    this.recordStats(result);
    return result;
  }

  snapshotStats(): RateLimitPolicyStats[] {
    return [...this.stats.values()].map((entry) => ({ ...entry }));
  }

  /** Bounded, identifier-free monitoring state (24 hours at the five-minute cadence). */
  monitoringSnapshot(now = Date.now()): {
    current: RateLimitStatsInterval;
    history: RateLimitStatsInterval[];
  } {
    return {
      current: {
        startedAt: this.intervalStartedAt,
        endedAt: now,
        policies: this.snapshotStats(),
      },
      history: this.history.map((interval) => ({
        ...interval,
        policies: interval.policies.map((policy) => ({ ...policy })),
      })),
    };
  }

  /** Obscure private account/user/token values before using them as in-memory bucket keys. */
  hashSubject(subject: string): string {
    return createHmac('sha256', this.subjectHashKey)
      .update(subject)
      .digest('hex')
      .slice(0, 16);
  }

  /** Emit and reset a bounded interval aggregate; never includes raw subject values. */
  flushSummary(): void {
    const endedAt = Date.now();
    const policies = this.snapshotStats();
    this.stats.clear();
    this.history.push({
      startedAt: this.intervalStartedAt,
      endedAt,
      policies,
    });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.intervalStartedAt = endedAt;
    if (policies.length > 0) {
      this.logger.log({ event: 'rate_limit_summary', policies });
    }
  }

  private recordStats(result: RateLimitResult): void {
    const statsKey = `${result.policy}:${result.mode}`;
    const current = this.stats.get(statsKey) ?? {
      policy: result.policy,
      mode: result.mode,
      evaluated: 0,
      allowed: 0,
      wouldBlock: 0,
      blocked: 0,
      observeOnlyExceeded: 0,
      maxRetryAfterMs: 0,
    };
    current.evaluated++;
    if (!result.allowed) current.blocked++;
    else if (
      result.mode === 'shadow' &&
      result.rules.some((rule) => rule.enforce && !rule.allowed)
    )
      current.wouldBlock++;
    else current.allowed++;
    if (result.rules.some((rule) => !rule.enforce && !rule.allowed))
      current.observeOnlyExceeded++;
    current.maxRetryAfterMs = Math.max(
      current.maxRetryAfterMs,
      result.retryAfterMs,
    );
    this.stats.set(statsKey, current);

    // Per-request outcomes deliberately stay out of logs. flushSummary emits one bounded aggregate.
  }
}

function validatePolicy(policy: RateLimitPolicy): void {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(policy.name))
    throw new Error(`invalid rate-limit policy name: ${policy.name}`);
  if (policy.rules.length === 0)
    throw new Error('a rate-limit policy must contain at least one rule');
  for (const rule of policy.rules) {
    if (!/^[a-z][a-z0-9-]*$/.test(rule.subject.type))
      throw new Error(`invalid rate-limit subject type: ${rule.subject.type}`);
    if (!rule.subject.key)
      throw new Error('rate-limit subject key is required');
  }
}
