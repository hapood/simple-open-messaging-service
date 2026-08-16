import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { systemSetting } from '../database/schema.js';
import type { RateLimitMode } from './rate-limit.types.js';

export interface TokenBucketConfig {
  ratePerSecond: number;
  burst: number;
  enforce: boolean;
}

export interface AuthRateLimitConfig {
  mode: RateLimitMode;
  exactIp?: TokenBucketConfig;
  ipv6Prefix?: TokenBucketConfig;
  account?: TokenBucketConfig;
  qrToken?: TokenBucketConfig;
  user?: TokenBucketConfig;
}

type BucketName = Exclude<keyof AuthRateLimitConfig, 'mode'>;

interface PolicyDefinition {
  buckets: Partial<Record<BucketName, TokenBucketConfig>>;
}

export interface AuthRateLimitPolicyConfigView {
  policy: string;
  mode: RateLimitMode;
  buckets: Array<{
    name: BucketName;
    ratePerSecond: number;
    burst: number;
    enforce: boolean;
  }>;
}

const AUTH_RATE_LIMIT_SETTING_KEY = 'rateLimit:authPolicies';

const POLICY_DEFINITIONS: Record<string, PolicyDefinition> = {
  'auth.password.login': {
    buckets: {
      exactIp: bucket(1, 10),
      ipv6Prefix: bucket(5, 30),
      account: bucket(0.2, 5, false),
    },
  },
  'auth.otp.login': {
    buckets: {
      exactIp: bucket(0.2, 3),
      ipv6Prefix: bucket(1, 10),
      account: bucket(0.1, 3, false),
    },
  },
  'auth.qr.create': {
    buckets: {
      exactIp: bucket(0.2, 5),
      ipv6Prefix: bucket(1, 15),
    },
  },
  'auth.qr.poll': {
    buckets: {
      exactIp: bucket(5, 15),
      qrToken: bucket(1, 3),
    },
  },
  'auth.qr.scan': {
    buckets: { user: bucket(0.5, 5), qrToken: bucket(1, 2) },
  },
  'auth.qr.confirm': {
    buckets: { user: bucket(0.5, 5), qrToken: bucket(1, 2) },
  },
};

@Injectable()
export class RateLimitModeService implements OnModuleInit {
  private readonly logger = new Logger(RateLimitModeService.name);
  private configs: Record<string, AuthRateLimitConfig>;

  constructor(
    @Optional() private readonly database?: DatabaseService,
    @Optional()
    @Inject('SOMS_TEST_RATE_LIMIT_CONFIGURATION')
    private readonly testConfiguration?: unknown,
  ) {
    this.configs = testConfiguration
      ? parseConfigurationInput(testConfiguration)
      : defaultConfigs();
  }

  async onModuleInit(): Promise<void> {
    if (this.database && !this.testConfiguration) {
      const row = await this.database.db.query.systemSetting.findFirst({
        where: eq(systemSetting.key, AUTH_RATE_LIMIT_SETTING_KEY),
      });
      if (row) this.configs = parseConfigs(row.value);
    }
    this.logger.log({
      event: 'rate_limit_auth_config',
      policies: this.configs,
    });
  }


  forPolicy(name: string): AuthRateLimitConfig {
    const config = this.configs[name];
    if (!config)
      throw new Error(`unknown authentication rate-limit policy: ${name}`);
    return config;
  }

  monitoringConfig(): AuthRateLimitPolicyConfigView[] {
    return Object.entries(POLICY_DEFINITIONS).map(([policy, definition]) => {
      const config = this.configs[policy];
      return {
        policy,
        mode: config.mode,
        buckets: (Object.keys(definition.buckets) as BucketName[]).map(
          (name) => {
            const value = config[name]!;
            return {
              name,
              ratePerSecond: value.ratePerSecond,
              burst: value.burst,
              enforce: value.enforce,
            };
          },
        ),
      };
    });
  }

  async setConfiguration(
    input: unknown,
  ): Promise<AuthRateLimitPolicyConfigView[]> {
    if (!this.database) throw new Error('database is unavailable');
    const configs = parseConfigurationInput(input);
    const value = JSON.stringify(configurationView(configs));
    await this.database.db
      .insert(systemSetting)
      .values({
        key: AUTH_RATE_LIMIT_SETTING_KEY,
        value,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: { value, updatedAt: new Date() },
      });
    this.configs = configs;
    return this.monitoringConfig();
  }
}

function defaultConfigs(): Record<string, AuthRateLimitConfig> {
  return Object.fromEntries(
    Object.entries(POLICY_DEFINITIONS).map(([policy, definition]) => [
      policy,
      { mode: 'enforce', ...structuredClone(definition.buckets) },
    ]),
  );
}

function parseConfigs(raw: string): Record<string, AuthRateLimitConfig> {
  return parseConfigurationInput(JSON.parse(raw));
}

function configurationView(
  configs: Record<string, AuthRateLimitConfig>,
): AuthRateLimitPolicyConfigView[] {
  return Object.entries(POLICY_DEFINITIONS).map(([policy, definition]) => ({
    policy,
    mode: configs[policy].mode,
    buckets: (Object.keys(definition.buckets) as BucketName[]).map((name) => ({
      name,
      ...configs[policy][name]!,
    })),
  }));
}

function parseConfigurationInput(
  input: unknown,
): Record<string, AuthRateLimitConfig> {
  if (!Array.isArray(input))
    throw new Error('rate-limit configuration must be an array');
  const result = defaultConfigs();
  if (input.length !== Object.keys(result).length) {
    throw new Error(
      'rate-limit configuration must include every authentication policy',
    );
  }
  for (const item of input) {
    if (!item || typeof item !== 'object')
      throw new Error('invalid rate-limit policy');
    const value = item as Record<string, unknown>;
    const policy = value.policy;
    if (typeof policy !== 'string' || !POLICY_DEFINITIONS[policy]) {
      throw new Error('unknown authentication rate-limit policy');
    }
    const mode = value.mode;
    if (mode !== 'disabled' && mode !== 'shadow' && mode !== 'enforce') {
      throw new Error(`invalid mode for ${policy}`);
    }
    if (!Array.isArray(value.buckets))
      throw new Error(`invalid buckets for ${policy}`);
    const expected = POLICY_DEFINITIONS[policy].buckets;
    const config: AuthRateLimitConfig = { mode };
    if (value.buckets.length !== Object.keys(expected).length) {
      throw new Error(`configuration must include every bucket for ${policy}`);
    }
    for (const rawBucket of value.buckets) {
      if (!rawBucket || typeof rawBucket !== 'object')
        throw new Error(`invalid bucket for ${policy}`);
      const candidate = rawBucket as Record<string, unknown>;
      const name = candidate.name as BucketName;
      const defaults = expected[name];
      if (!defaults) throw new Error(`unknown bucket for ${policy}`);
      const ratePerSecond = Number(candidate.ratePerSecond);
      const burst = Number(candidate.burst);
      if (
        !Number.isFinite(ratePerSecond) ||
        ratePerSecond <= 0 ||
        !Number.isFinite(burst) ||
        burst < ratePerSecond
      ) {
        throw new Error(`invalid rate or burst for ${policy}.${name}`);
      }
      config[name] = { ratePerSecond, burst, enforce: defaults.enforce };
    }
    result[policy] = config;
  }
  return result;
}

function bucket(
  ratePerSecond: number,
  burst: number,
  enforce = true,
): TokenBucketConfig {
  return { ratePerSecond, burst, enforce };
}
