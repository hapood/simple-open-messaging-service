import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { optionalIntEnv, requireEnv } from '../common/env.js';
import * as relations from './relations.js';
import * as schema from './schema.js';

export const databaseSchema = { ...schema, ...relations };
export type Database = NodePgDatabase<typeof databaseSchema>;
export type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;
  readonly db: Database;

  constructor() {
    this.pool = new Pool({
      connectionString: requireEnv('DATABASE_URL'),
      max: optionalIntEnv('DATABASE_POOL_MAX', 10),
    });
    this.db = drizzle({
      client: this.pool,
      schema: databaseSchema,
      logger: process.env.NODE_ENV !== 'production',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry({
      maxAttempts: optionalIntEnv('DATABASE_CONNECT_RETRIES', 5),
      baseDelayMs: optionalIntEnv('DATABASE_CONNECT_BASE_DELAY_MS', 500),
      maxDelayMs: optionalIntEnv('DATABASE_CONNECT_MAX_DELAY_MS', 5000),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private async connectWithRetry(opts: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  }): Promise<void> {
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      try {
        const client = await this.pool.connect();
        client.release();
        this.logger.log('connected to database');
        return;
      } catch (error) {
        const message = (error as Error).message;
        if (attempt >= opts.maxAttempts) {
          this.logger.error(
            `database connect failed after ${opts.maxAttempts} attempt(s): ${message}`,
          );
          throw error;
        }
        const ceiling = Math.min(
          opts.baseDelayMs * 2 ** (attempt - 1),
          opts.maxDelayMs,
        );
        const delay = Math.floor(Math.random() * ceiling);
        this.logger.warn(
          `database connect attempt ${attempt}/${opts.maxAttempts} failed: ${message}; retrying in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
