import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, type Prisma } from './prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { optionalIntEnv, requireEnv } from './common/env.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Prisma 7 driver-adapter path (Rust-free; rides on node-pg). The pool IS node-pg's pg.Pool, so its
    // sizing is governed by pg.PoolConfig here — NOT a `?connection_limit=` URL param, which this path
    // ignores. connectionString comes from DATABASE_URL; pool max comes from DATABASE_POOL_MAX (default
    // 10, pg's native default). Keep `max × app-replica count` ≤ PostgreSQL's max_connections.
    //
    // Logging: `warn` + `error` always reach stdout (operations must never lose a DB-layer warning); the
    // `query` level is added only outside production for N+1 / slow-query detection. The string-array
    // form is shorthand for `emit: 'stdout'`. Deliberately NOT `$on('warn'/'error')`: Prisma infers
    // `$on`'s `LogOpts` type from the literal `log:` array, so a conditionally-built event array breaks
    // that inference. Declaring `logLevels: Prisma.LogLevel[]` contextually types the literals instead.
    const logLevels: Prisma.LogLevel[] =
      process.env.NODE_ENV !== 'production'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'];
    super({
      log: logLevels,
      adapter: new PrismaPg({
        connectionString: requireEnv('DATABASE_URL'),
        max: optionalIntEnv('DATABASE_POOL_MAX', 10),
      }),
    });
  }

  async onModuleInit() {
    // Tolerate a transiently-unavailable PostgreSQL at boot with a bounded retry loop, rather than
    // relying solely on the orchestrator's container restart. Knobs (all optional, read once here so the
    // unit spec can drive connectWithRetry with millisecond delays directly): DATABASE_CONNECT_RETRIES
    // (5), DATABASE_CONNECT_BASE_DELAY_MS (500), DATABASE_CONNECT_MAX_DELAY_MS (5000) — worst case
    // ~0.5+1+2+4 = 7.5s before giving up, after which the error re-throws and the process exits for the
    // restart policy to re-loop the whole container.
    await this.connectWithRetry({
      maxAttempts: optionalIntEnv('DATABASE_CONNECT_RETRIES', 5),
      baseDelayMs: optionalIntEnv('DATABASE_CONNECT_BASE_DELAY_MS', 500),
      maxDelayMs: optionalIntEnv('DATABASE_CONNECT_MAX_DELAY_MS', 5000),
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Connect with bounded retries: exponential backoff + full jitter (the AWS-recommended strategy —
   * delay uniformly random in `[0, min(base · 2^(attempt-1), maxDelayMs)]`). Full jitter spreads
   * concurrent reconnects and the ceiling cap keeps a high retry count from ballooning a single wait.
   * Knobs arrive as params (env is read by the caller) so a unit spec can exercise this directly.
   */
  private async connectWithRetry(opts: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  }): Promise<void> {
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      try {
        await this.$connect();
        this.logger.log('connected to database');
        return;
      } catch (err) {
        const message = (err as Error).message;
        if (attempt >= opts.maxAttempts) {
          this.logger.error(
            `database connect failed after ${opts.maxAttempts} attempt(s): ${message}`,
          );
          throw err;
        }
        const ceiling = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
        const delay = Math.floor(Math.random() * ceiling);
        this.logger.warn(
          `database connect attempt ${attempt}/${opts.maxAttempts} failed: ${message}; retrying in ${delay}ms`,
        );
        await this.sleep(delay);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
