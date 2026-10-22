import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  DefaultLogger,
  type Logger as DrizzleLogger,
} from 'drizzle-orm/logger';
import { Pool, type PoolClient } from 'pg';
import { optionalIntEnv } from '../common/env.js';
import {
  executionMeasurementSampleRate,
  recordSqlExecution,
} from '../diagnostics/execution-measurement.js';
import { databaseSchema } from './database-schema.js';
import { instrumentDatabaseClient } from './database-execution-measurement.js';

export type Database = NodePgDatabase<typeof databaseSchema>;
export type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;
  readonly db: Database;

  constructor() {
    const measurementEnabled = executionMeasurementSampleRate() > 0;
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
      const missing = ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].filter(
        (name) => !process.env[name]?.trim(),
      );
      if (missing.length > 0) {
        throw new Error(
          `DATABASE_URL or standard PostgreSQL variables are required (missing: ${missing.join(', ')})`,
        );
      }
    }
    this.pool = new Pool({
      ...(connectionString ? { connectionString } : {}),
      max: optionalIntEnv('DATABASE_POOL_MAX', 10),
      // Absolute instants are stored as timestamptz, but pin the session timezone too so SQL date
      // arithmetic, CURRENT_DATE, logs, and any future timestamp casts have one deterministic UTC
      // interpretation regardless of the PostgreSQL server/role default.
      options: '-c timezone=UTC',
    });
    if (measurementEnabled) {
      this.pool.on('connect', (client: PoolClient) => {
        instrumentDatabaseClient(client);
      });
    }
    const logQueries =
      process.env.NODE_ENV !== 'production' &&
      process.env.DATABASE_QUERY_LOG !== '0';
    this.db = drizzle({
      client: this.pool,
      schema: databaseSchema,
      logger: measurementEnabled
        ? new MeasurementQueryLogger(
            logQueries ? new DefaultLogger() : undefined,
          )
        : logQueries,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry({
      maxAttempts: optionalIntEnv('DATABASE_CONNECT_RETRIES', 5),
      baseDelayMs: optionalIntEnv('DATABASE_CONNECT_BASE_DELAY_MS', 500),
      maxDelayMs: optionalIntEnv('DATABASE_CONNECT_MAX_DELAY_MS', 5000),
    });
  }

  async onApplicationShutdown(): Promise<void> {
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
        try {
          const result = await client.query<{ timezone: string }>(
            "SELECT current_setting('TimeZone') AS timezone",
          );
          if (result.rows[0]?.timezone !== 'UTC') {
            throw new Error(
              `database session timezone must be UTC (got ${result.rows[0]?.timezone ?? 'unknown'})`,
            );
          }
        } finally {
          client.release();
        }
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

class MeasurementQueryLogger implements DrizzleLogger {
  constructor(private readonly delegate?: DrizzleLogger) {}

  logQuery(query: string, params: unknown[]): void {
    recordSqlExecution();
    this.delegate?.logQuery(query, params);
  }
}
