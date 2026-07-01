import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

/**
 * Auth e2e smoke — the regression anchor for the ESM migration.
 *
 * One flow exercises the entire native-interop risk surface:
 *   register (argon2.hash + Prisma write)
 *   -> login (argon2.verify + JwtService) -> access token
 *   -> guarded route (JwtAuthGuard validates the signed token)
 * Must stay green after the CJS->ESM flip.
 */
describe('Auth e2e (register -> login -> guarded)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    // Isolate every run: truncating User CASCADE-clears RefreshToken,
    // AdminRefreshToken, threads, messages, etc.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers a user, logs in, and reaches a guarded route', async () => {
    // 1. register (argon2.hash + Prisma)
    const reg = await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ uniqName: 'e2etest', password: 'Pass1234' });
    expect(reg.status).toBe(200);
    expect(reg.body.code).toBe(0);

    // 2. login (argon2.verify + JwtService) -> access token
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ uniqName: 'e2etest', password: 'Pass1234' });
    expect(login.status).toBe(200);
    expect(login.body.code).toBe(0);
    const accessToken = login.body.data.access_token;
    expect(accessToken).toBeTruthy();

    // 3. guarded route (JwtAuthGuard validates the signed token)
    const guarded = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(guarded.status).toBe(200);
    expect(guarded.body.code).toBe(0);
  });
});
