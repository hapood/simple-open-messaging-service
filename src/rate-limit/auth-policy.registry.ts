import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { normalizeAccount } from '../common/account.js';
import { ClientIdentityService } from './client-identity.service.js';
import { RateLimitService } from './rate-limit.service.js';
import {
  RateLimitModeService,
  type TokenBucketConfig,
} from './rate-limit-mode.service.js';
import type {
  RateLimitPolicy,
  RateLimitRule,
  RateLimitSubject,
} from './rate-limit.types.js';

export const AUTH_RATE_LIMIT_POLICIES = {
  passwordLogin: 'auth.password.login',
  otpLogin: 'auth.otp.login',
  qrCreate: 'auth.qr.create',
  qrPoll: 'auth.qr.poll',
  qrScan: 'auth.qr.scan',
  qrConfirm: 'auth.qr.confirm',
} as const;

export type AuthRateLimitPolicyName =
  (typeof AUTH_RATE_LIMIT_POLICIES)[keyof typeof AUTH_RATE_LIMIT_POLICIES];

/** Builds the six iteration-2 authentication policies from trusted, canonical request subjects. */
@Injectable()
export class AuthPolicyRegistry {
  constructor(
    private readonly identities: ClientIdentityService,
    private readonly rateLimits: RateLimitService,
    private readonly modes: RateLimitModeService,
  ) {}

  build(name: string, request: FastifyRequest): RateLimitPolicy {
    const body = request.body as Record<string, unknown> | undefined;
    const config = this.modes.forPolicy(name);
    switch (name) {
      case AUTH_RATE_LIMIT_POLICIES.passwordLogin:
        return this.policy(
          name,
          [
            ...this.ipRules(request, config.exactIp!, config.ipv6Prefix),
            this.privateRule(
              'account',
              normalizeAccount(readString(body, 'account')),
              config.account!,
            ),
          ],
          config.mode,
        );
      case AUTH_RATE_LIMIT_POLICIES.otpLogin:
        return this.policy(
          name,
          [
            ...this.ipRules(request, config.exactIp!, config.ipv6Prefix),
            this.privateRule(
              'account',
              normalizeAccount(readString(body, 'account')),
              config.account!,
            ),
          ],
          config.mode,
        );
      case AUTH_RATE_LIMIT_POLICIES.qrCreate:
        return this.policy(
          name,
          this.ipRules(request, config.exactIp!, config.ipv6Prefix),
          config.mode,
        );
      case AUTH_RATE_LIMIT_POLICIES.qrPoll:
        return this.policy(
          name,
          [
            ...this.ipRules(request, config.exactIp!),
            this.privateRule(
              'qr-token',
              readString(body, 'qrToken'),
              config.qrToken!,
            ),
          ],
          config.mode,
        );
      case AUTH_RATE_LIMIT_POLICIES.qrScan:
        return this.qrActorPolicy(name, request, body, config);
      case AUTH_RATE_LIMIT_POLICIES.qrConfirm:
        return this.qrActorPolicy(name, request, body, config);
      default:
        throw new Error(`unknown authentication rate-limit policy: ${name}`);
    }
  }

  private qrActorPolicy(
    name: AuthRateLimitPolicyName,
    request: FastifyRequest,
    body: Record<string, unknown> | undefined,
    config: ReturnType<RateLimitModeService['forPolicy']>,
  ): RateLimitPolicy {
    const userId = (request.user as { userId?: number } | undefined)?.userId;
    return this.policy(
      name,
      [
        this.privateRule('user', String(userId ?? 'unknown'), config.user!),
        this.privateRule(
          'qr-token',
          readString(body, 'qrToken'),
          config.qrToken!,
        ),
      ],
      config.mode,
    );
  }

  private ipRules(
    request: FastifyRequest,
    exact: TokenBucketConfig,
    prefix64?: TokenBucketConfig,
  ): RateLimitRule[] {
    const address = this.identities.fromRequest(request);
    if (!address) {
      return [this.privateRule('ip-unknown', 'unknown', exact)];
    }
    const rules: RateLimitRule[] = [
      {
        subject: { type: 'ip-exact', key: address.exactSubject },
        ratePerSecond: exact.ratePerSecond,
        burst: exact.burst,
      },
    ];
    if (address.family === 'ipv6' && prefix64 !== undefined) {
      rules.push({
        subject: { type: 'ip-prefix64', key: address.prefix64Subject },
        ratePerSecond: prefix64.ratePerSecond,
        burst: prefix64.burst,
      });
    }
    return rules;
  }

  private privateRule(
    type: string,
    value: string,
    config: TokenBucketConfig,
  ): RateLimitRule {
    return {
      subject: this.privateSubject(type, value),
      ratePerSecond: config.ratePerSecond,
      burst: config.burst,
      enforce: config.enforce,
    };
  }

  private privateSubject(type: string, value: string): RateLimitSubject {
    return {
      type,
      key: this.rateLimits.hashSubject(`${type}:${value}`),
    };
  }

  private policy(
    name: AuthRateLimitPolicyName,
    rules: readonly RateLimitRule[],
    mode: RateLimitPolicy['mode'],
  ): RateLimitPolicy {
    return { name, mode, rules };
  }
}

function readString(
  body: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = body?.[key];
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}
