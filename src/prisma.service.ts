import { Injectable, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaClient } from './prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { optionalIntEnv, requireEnv } from './common/env.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  // `connectionString` is Optional so the federation e2e harness can override PrismaService per-app with
  // `new PrismaService(dbUrl)` — giving two co-existing AppModule instances separate databases (a group's
  // fedGroupAccount is @unique per DB; a shared DB would alias appB's mirror to appA's origin thread). In
  // production Nest constructs this with no arg → falls back to DATABASE_URL, unchanged.
  constructor(@Optional() connectionString?: string) {
    // Prisma 7 driver-adapter path (Rust-free; rides on node-pg). The pool IS node-pg's pg.Pool, so
    // its sizing is governed by pg.PoolConfig here — NOT a `?connection_limit=` URL param, which this
    // path ignores. connectionString comes from DATABASE_URL (or the test override); pool max comes from
    // DATABASE_POOL_MAX (default 10, pg's native default). Keep `max × app-replica count` ≤ PostgreSQL's
    // max_connections.
    super({
      adapter: new PrismaPg({
        connectionString: connectionString ?? requireEnv('DATABASE_URL'),
        max: optionalIntEnv('DATABASE_POOL_MAX', 10),
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
