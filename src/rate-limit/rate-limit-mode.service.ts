import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
  envPrefix: string;
  buckets: Partial<Record<BucketName, TokenBucketConfig>>;
}

export interface AuthRateLimitPolicyConfigView {
  policy: string;
  mode: RateLimitMode;
  modeEnv: string;
  buckets: Array<{
    name: BucketName;
    ratePerSecond: number;
    burst: number;
    enforce: boolean;
    rateEnv: string;
    burstEnv: string;
  }>;
}

const POLICY_DEFINITIONS: Record<string, PolicyDefinition> = {
  'auth.password.login': {
    envPrefix: 'RATE_LIMIT_AUTH_PASSWORD_LOGIN',
    buckets: {
      exactIp: bucket(1, 10),
      ipv6Prefix: bucket(5, 30),
      account: bucket(0.2, 5, false),
    },
  },
  'auth.otp.login': {
    envPrefix: 'RATE_LIMIT_AUTH_OTP_LOGIN',
    buckets: {
      exactIp: bucket(0.2, 3),
      ipv6Prefix: bucket(1, 10),
      account: bucket(0.1, 3, false),
    },
  },
  'auth.qr.create': {
    envPrefix: 'RATE_LIMIT_AUTH_QR_CREATE',
    buckets: {
      exactIp: bucket(0.2, 5),
      ipv6Prefix: bucket(1, 15),
    },
  },
  'auth.qr.poll': {
    envPrefix: 'RATE_LIMIT_AUTH_QR_POLL',
    buckets: {
      exactIp: bucket(5, 15),
      qrToken: bucket(1, 3),
    },
  },
  'auth.qr.scan': {
    envPrefix: 'RATE_LIMIT_AUTH_QR_SCAN',
    buckets: { user: bucket(0.5, 5), qrToken: bucket(1, 2) },
  },
  'auth.qr.confirm': {
    envPrefix: 'RATE_LIMIT_AUTH_QR_CONFIRM',
    buckets: { user: bucket(0.5, 5), qrToken: bucket(1, 2) },
  },
};

const BUCKET_ENV_NAMES: Record<BucketName, string> = {
  exactIp: 'IP',
  ipv6Prefix: 'IPV6_PREFIX',
  account: 'ACCOUNT',
  qrToken: 'QR_TOKEN',
  user: 'USER',
};

@Injectable()
export class RateLimitModeService implements OnModuleInit {
  private readonly logger = new Logger(RateLimitModeService.name);
  private readonly configs: Record<string, AuthRateLimitConfig>;

  constructor() {
    this.configs = Object.fromEntries(
      Object.entries(POLICY_DEFINITIONS).map(([policy, definition]) => [
        policy,
        resolvePolicyConfig(definition, process.env),
      ]),
    );
  }

  onModuleInit(): void {
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
        modeEnv: `${definition.envPrefix}_MODE`,
        buckets: (Object.keys(definition.buckets) as BucketName[]).map(
          (name) => {
            const value = config[name]!;
            const prefix = `${definition.envPrefix}_${BUCKET_ENV_NAMES[name]}`;
            return {
              name,
              ratePerSecond: value.ratePerSecond,
              burst: value.burst,
              enforce: value.enforce,
              rateEnv: `${prefix}_RATE_PER_SECOND`,
              burstEnv: `${prefix}_BURST`,
            };
          },
        ),
      };
    });
  }
}

function resolvePolicyConfig(
  definition: PolicyDefinition,
  env: NodeJS.ProcessEnv,
): AuthRateLimitConfig {
  const result: AuthRateLimitConfig = {
    mode: resolveRateLimitMode(
      env[`${definition.envPrefix}_MODE`],
      `${definition.envPrefix}_MODE`,
    ),
  };
  for (const [name, defaults] of Object.entries(definition.buckets) as [
    BucketName,
    TokenBucketConfig,
  ][]) {
    const prefix = `${definition.envPrefix}_${BUCKET_ENV_NAMES[name]}`;
    result[name] = {
      ratePerSecond: resolvePositiveNumber(
        env[`${prefix}_RATE_PER_SECOND`],
        `${prefix}_RATE_PER_SECOND`,
        defaults.ratePerSecond,
      ),
      burst: resolvePositiveNumber(
        env[`${prefix}_BURST`],
        `${prefix}_BURST`,
        defaults.burst,
      ),
      enforce: defaults.enforce,
    };
    if (result[name]!.burst < result[name]!.ratePerSecond) {
      throw new Error(
        `${prefix}_BURST must be greater than or equal to ${prefix}_RATE_PER_SECOND`,
      );
    }
  }
  return result;
}

export function resolveRateLimitMode(
  raw: string | undefined,
  variable: string,
): RateLimitMode {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'enforce') return 'enforce';
  if (value === 'shadow') return 'shadow';
  if (value === 'enforce' || value === 'disabled') return value;
  throw new Error(
    `${variable} must be one of disabled, shadow, or enforce; received ${JSON.stringify(raw)}`,
  );
}

export function resolvePositiveNumber(
  raw: string | undefined,
  variable: string,
  defaultValue: number,
): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${variable} must be a finite number greater than zero`);
  }
  return value;
}

function bucket(
  ratePerSecond: number,
  burst: number,
  enforce = true,
): TokenBucketConfig {
  return { ratePerSecond, burst, enforce };
}
