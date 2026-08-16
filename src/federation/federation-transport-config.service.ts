import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { systemSetting } from '../database/schema.js';

export interface FederationTransportConfig {
  keyCacheTtlSec: number;
  connectTimeoutSec: number;
  callTimeoutSec: number;
  mediaChunkBytes: number;
  mediaChunkTimeoutSec: number;
  mediaMaxChunkRetries: number;
}

const SETTING_KEY = 'federation:transport';
const DEFAULTS: FederationTransportConfig = {
  keyCacheTtlSec: 6 * 60 * 60,
  connectTimeoutSec: 12,
  callTimeoutSec: 12,
  mediaChunkBytes: 8 * 1024 * 1024,
  mediaChunkTimeoutSec: 120,
  mediaMaxChunkRetries: 5,
};

const BOUNDS: Record<
  keyof FederationTransportConfig,
  readonly [number, number]
> = {
  keyCacheTtlSec: [60, 7 * 24 * 60 * 60],
  connectTimeoutSec: [1, 120],
  callTimeoutSec: [1, 600],
  mediaChunkBytes: [256 * 1024, 64 * 1024 * 1024],
  mediaChunkTimeoutSec: [5, 3600],
  mediaMaxChunkRetries: [0, 20],
};

/** Hot-reloadable federation transport policy. Static identity and network topology remain deploy config. */
@Injectable()
export class FederationTransportConfigService implements OnModuleInit {
  private value: FederationTransportConfig = { ...DEFAULTS };

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    const row = await this.database.db.query.systemSetting.findFirst({
      where: eq(systemSetting.key, SETTING_KEY),
    });
    if (!row) return;
    try {
      this.value = this.validate(JSON.parse(row.value) as unknown);
    } catch {
      this.value = { ...DEFAULTS };
    }
  }

  get(): Readonly<FederationTransportConfig> {
    return this.value;
  }

  async set(input: unknown): Promise<FederationTransportConfig> {
    const value = this.validate(input);
    const updatedAt = new Date();
    await this.database.db
      .insert(systemSetting)
      .values({ key: SETTING_KEY, value: JSON.stringify(value), updatedAt })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: { value: JSON.stringify(value), updatedAt },
      });
    this.value = value;
    return value;
  }

  private validate(input: unknown): FederationTransportConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('federation transport settings must be an object');
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(DEFAULTS) as (keyof FederationTransportConfig)[];
    if (
      Object.keys(record).length !== keys.length ||
      Object.keys(record).some((key) => !keys.includes(key as never))
    ) {
      throw new Error('federation transport settings must contain exactly the supported fields');
    }
    const value = {} as FederationTransportConfig;
    for (const key of keys) {
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
