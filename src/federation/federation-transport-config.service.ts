import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { systemSetting } from '../database/schema.js';

export interface FederationTransportConfig {
  keyCacheTtlSec: number;
  connectTimeoutSec: number;
  requestIdleTimeoutSec: number;
  mediaChunkBytes: number;
  mediaMaxChunkRetries: number;
}

const SETTING_PREFIX = 'federation:transport:';
const DEFAULTS: FederationTransportConfig = {
  keyCacheTtlSec: 6 * 60 * 60,
  connectTimeoutSec: 12,
  requestIdleTimeoutSec: 30,
  mediaChunkBytes: 8 * 1024 * 1024,
  mediaMaxChunkRetries: 5,
};

const BOUNDS: Record<
  keyof FederationTransportConfig,
  readonly [number, number]
> = {
  keyCacheTtlSec: [60, 7 * 24 * 60 * 60],
  connectTimeoutSec: [1, 120],
  requestIdleTimeoutSec: [1, 600],
  mediaChunkBytes: [256 * 1024, 64 * 1024 * 1024],
  mediaMaxChunkRetries: [0, 20],
};

const CONFIG_KEYS = Object.keys(
  DEFAULTS,
) as (keyof FederationTransportConfig)[];

export function transportSettingKey(
  key: keyof FederationTransportConfig,
): string {
  return `${SETTING_PREFIX}${key}`;
}

/** Hot-reloadable federation transport policy. Static identity and network topology remain deploy config. */
@Injectable()
export class FederationTransportConfigService implements OnModuleInit {
  private value: FederationTransportConfig = { ...DEFAULTS };

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    const keys = CONFIG_KEYS.map((key) => transportSettingKey(key));
    const rows = await this.database.db.query.systemSetting.findMany({
      where: (setting, { inArray }) => inArray(setting.key, keys),
    });
    const parsed: Partial<FederationTransportConfig> = {};
    for (const row of rows) {
      const field = row.key.slice(
        SETTING_PREFIX.length,
      ) as keyof FederationTransportConfig;
      if (!CONFIG_KEYS.includes(field)) continue;
      const num = Number(row.value);
      const [min, max] = BOUNDS[field];
      if (Number.isSafeInteger(num) && num >= min && num <= max) {
        parsed[field] = num;
      }
    }
    // Any absent, unparseable, or out-of-range key cleanly falls back to its default.
    this.value = { ...DEFAULTS, ...parsed };
  }

  get(): Readonly<FederationTransportConfig> {
    return this.value;
  }

  async set(input: unknown): Promise<FederationTransportConfig> {
    const value = this.validate(input);
    const updatedAt = new Date();
    await this.database.db.transaction(async (tx) => {
      for (const key of CONFIG_KEYS) {
        const settingKey = transportSettingKey(key);
        const strVal = String(value[key]);
        await tx
          .insert(systemSetting)
          .values({ key: settingKey, value: strVal, updatedAt })
          .onConflictDoUpdate({
            target: systemSetting.key,
            set: { value: strVal, updatedAt },
          });
      }
    });
    this.value = value;
    return value;
  }

  private validate(input: unknown): FederationTransportConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('federation transport settings must be an object');
    }
    const record = input as Record<string, unknown>;
    if (
      Object.keys(record).length !== CONFIG_KEYS.length ||
      Object.keys(record).some((key) => !CONFIG_KEYS.includes(key as never))
    ) {
      throw new Error(
        'federation transport settings must contain exactly the supported fields',
      );
    }
    const value = {} as FederationTransportConfig;
    for (const key of CONFIG_KEYS) {
      const candidate = record[key];
      const [min, max] = BOUNDS[key];
      if (
        !Number.isSafeInteger(candidate) ||
        (candidate as number) < min ||
        (candidate as number) > max
      ) {
        throw new Error(`${key} must be an integer from ${min} to ${max}`);
      }
      value[key] = candidate as number;
    }
    return value;
  }
}
