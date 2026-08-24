import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { systemSetting } from '../database/schema.js';

export interface FixedWindowPolicy {
  policy: string;
  limit: number;
  windowSeconds: number;
}

const SETTING_KEY = 'rateLimit:fixedWindowPolicies';

export const FIXED_WINDOW_DEFAULTS = {
  'shell.compat': [30, 60],
  'shell.manifest': [30, 60],
  'shell.bundle': [10, 60],
  'admin.two-factor': [10, 60],
  'admin.webauthn': [10, 60],
  'admin.login': [5, 60],
  'admin.login.verify': [5, 60],
  'admin.login.webauthn-begin': [5, 60],
  'admin.login.webauthn-finish': [5, 60],
  'auth.logout': [30, 60],
  'auth.change-password': [10, 60],
  'auth.set-password': [10, 60],
  'device.register': [10, 60],
  'message.report': [20, 60],
  'message.send': [60, 60],
  'message.forward': [60, 60],
  'message.media-stage': [60, 60],
  'thread.mark-read': [60, 60],
  'thread.read-delta': [60, 60],
  'thread.set-muted': [30, 60],
  'thread.set-blocked': [30, 60],
  'thread.set-pinned': [30, 60],
  'thread.clear-history': [10, 60],
  'thread.set-alias': [30, 60],
  'group.join-request-action': [30, 60],
  'message.search': [30, 60],
  'message.relocalize-media': [10, 60],
  'call.initiate': [20, 60],
  'call.accept': [60, 60],
  'call.ringing': [60, 60],
  'call.connected': [60, 60],
  'call.upgrade-video': [30, 60],
  'call.decline': [60, 60],
  'call.cancel': [60, 60],
  'call.end': [60, 60],
  'call.signal': [300, 60],
  'call.signaling': [30, 60],
  'diagnostics.report': [5, 60],
  'link-preview.generate': [20, 60],
  'group.create': [10, 60],
  'group.join-request': [20, 60],
  'group.leave': [20, 60],
  'group.dissolve': [10, 60],
  'group.kick': [20, 60],
  'group.transfer': [20, 60],
  'group.set-role': [20, 60],
  'group.update': [20, 60],
} as const satisfies Record<string, readonly [number, number]>;

export type FixedWindowPolicyName = keyof typeof FIXED_WINDOW_DEFAULTS;

@Injectable()
export class FixedWindowPolicyService implements OnModuleInit {
  private policies = this.defaults();
  private revision = 0;

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    const row = await this.database.db.query.systemSetting.findFirst({
      where: eq(systemSetting.key, SETTING_KEY),
    });
    if (!row) return;
    try {
      this.policies = this.validate(JSON.parse(row.value) as unknown);
      this.revision = row.updatedAt.getTime();
    } catch {
      this.policies = this.defaults();
    }
  }

  get(policy: FixedWindowPolicyName): FixedWindowPolicy {
    return this.policies[policy];
  }

  list(): FixedWindowPolicy[] {
    return Object.values(this.policies);
  }

  bucketKey(policy: FixedWindowPolicyName, clientAddress: string): string {
    return `rl:${this.revision}:${policy}:${clientAddress}`;
  }

  async set(input: unknown): Promise<FixedWindowPolicy[]> {
    const policies = this.validate(input);
    const updatedAt = new Date();
    await this.database.db
      .insert(systemSetting)
      .values({
        key: SETTING_KEY,
        value: JSON.stringify(Object.values(policies)),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: { value: JSON.stringify(Object.values(policies)), updatedAt },
      });
    this.policies = policies;
    this.revision = updatedAt.getTime();
    return this.list();
  }

  private defaults(): Record<FixedWindowPolicyName, FixedWindowPolicy> {
    return Object.fromEntries(
      Object.entries(FIXED_WINDOW_DEFAULTS).map(
        ([policy, [limit, windowSeconds]]) => [
          policy,
          { policy, limit, windowSeconds },
        ],
      ),
    ) as Record<FixedWindowPolicyName, FixedWindowPolicy>;
  }

  private validate(
    input: unknown,
  ): Record<FixedWindowPolicyName, FixedWindowPolicy> {
    if (!Array.isArray(input))
      throw new Error('fixed-window policies must be an array');
    const expected = Object.keys(
      FIXED_WINDOW_DEFAULTS,
    ) as FixedWindowPolicyName[];
    if (input.length !== expected.length)
      throw new Error('all fixed-window policies are required');
    const result = {} as Record<FixedWindowPolicyName, FixedWindowPolicy>;
    for (const item of input) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('invalid fixed-window policy');
      const { policy, limit, windowSeconds } = item as Record<string, unknown>;
      if (
        typeof policy !== 'string' ||
        !expected.includes(policy as FixedWindowPolicyName) ||
        result[policy as FixedWindowPolicyName]
      ) {
        throw new Error(
          'fixed-window policy names must be unique and supported',
        );
      }
      if (
        !Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 100_000
      ) {
        throw new Error(`${policy}.limit must be an integer from 1 to 100000`);
      }
      if (
        !Number.isSafeInteger(windowSeconds) ||
        (windowSeconds as number) < 1 ||
        (windowSeconds as number) > 86_400
      ) {
        throw new Error(
          `${policy}.windowSeconds must be an integer from 1 to 86400`,
        );
      }
      result[policy as FixedWindowPolicyName] = {
        policy,
        limit: limit as number,
        windowSeconds: windowSeconds as number,
      };
    }
    return result;
  }
}
