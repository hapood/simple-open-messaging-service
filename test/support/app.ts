import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { DatabaseService } from '../../src/database/database.service';

export interface TestApp {
  app: NestFastifyApplication;
  database: DatabaseService;
}

/**
 * Sole app-assembly path for e2e specs: boot the real AppModule behind Fastify on an ephemeral
 * port. The `<NestFastifyApplication>` generic lives here and only here — a bare
 * `createNestApplication()` infers `INestApplication`, which `configureApp` rejects. Specs needing
 * more from the container call `app.get(...)` themselves; specs swapping providers pass a
 * `configureModule` callback that runs before compilation.
 */
export async function createTestApp(
  configureModule?: (builder: TestingModuleBuilder) => void,
): Promise<TestApp> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  configureModule?.(builder);
  const adapter = new FastifyAdapter();
  const moduleFixture: TestingModule = await builder.compile();
  const app =
    moduleFixture.createNestApplication<NestFastifyApplication>(adapter);
  // configureApp must precede listen(): it sets the global prefix (must precede route
  // registration, which listen() performs) and registers the multipart parser + static mounts.
  // listen() then runs init + Fastify ready() (initializing route-context lifecycle hooks).
  await configureApp(app, adapter);
  await app.listen(0);
  return { app, database: app.get(DatabaseService) };
}
