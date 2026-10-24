import { Writable } from 'node:stream';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import pinoHttp from 'pino-http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AdminAuthGuard } from '../admin/admin-auth.guard.js';
import { AdminRole } from '../database/enums.js';
import { LogViewerController } from './log-viewer.controller.js';
import { Test } from '@nestjs/testing';
import { LoggerModule } from './logger.module.js';
import { buildPino } from './pino-factory.js';
import { LogStreamStore } from './log-stream-store.js';
import { LogLevelService } from './log-level.service.js';
import { AdminLogOutputLevelDto } from './log-viewer.dto.js';

const output = vi.hoisted(() => ({
  console: [] as string[],
  file: [] as string[],
}));
vi.mock('pino-pretty', () => ({
  default: () =>
    new Writable({
      write(chunk, _encoding, done) {
        output.console.push(String(chunk));
        done();
      },
    }),
}));
vi.mock('./log-rotator.js', () => ({
  openRotatingDestination: () =>
    new Writable({
      write(chunk, _encoding, done) {
        output.file.push(String(chunk));
        done();
      },
    }),
  listLogFiles: () => [],
}));

beforeEach(() => {
  output.console.length = 0;
  output.file.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe('process-local log output level', () => {
  it('starts at error regardless of environment and resets for a fresh logger', () => {
    vi.stubEnv('LOG_LEVEL', 'trace');
    for (const mode of ['production', 'development']) {
      vi.stubEnv('NODE_ENV', mode);
      const logger = buildPino(new LogStreamStore(10));
      expect(logger.level).toBe('error');
      logger.level = 'debug';
      expect(buildPino(new LogStreamStore(10)).level).toBe('error');
    }
  });

  it('updates all destinations and already-created request children in both directions', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const store = new LogStreamStore(30);
    const logger = buildPino(store);
    const child = logger
      .child({ requestId: 'existing' })
      .child({ context: 'test' });
    const middleware = pinoHttp({ logger });
    const server = createServer((req, res) => {
      middleware(req, res);
      req.log.debug('hidden request debug');
      // A request that started before the threshold changed must follow the new value too.
      logger.level = 'debug';
      req.log.debug('visible request debug');
      res.end('ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      child.debug('hidden child debug');
      logger.error('visible error');
      const address = server.address() as { port: number };
      const response = await new Promise<import('node:http').IncomingMessage>(
        (resolve) => {
          get(`http://127.0.0.1:${address.port}`, resolve);
        },
      );
      response.resume();
      await once(response, 'end');
      child.debug('visible child debug');
      logger.level = 'trace';
      child.trace('visible trace');
      logger.level = 'error';
      child.warn('hidden child warning');
      logger.info('hidden info');
      child.error('visible child error');
      const records = store.snapshot();
      expect(records.map((r) => r.msg)).toEqual([
        'visible error',
        'visible request debug',
        'request completed',
        'visible child debug',
        'visible trace',
        'visible child error',
      ]);
      expect(output.console.map((line) => JSON.parse(line))).toEqual(records);
      expect(output.file.map((line) => JSON.parse(line))).toEqual(records);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it('controls the actual shared logger through Nest dependency injection', async () => {
    const module = await Test.createTestingModule({
      imports: [LoggerModule],
    }).compile();
    try {
      const service = module.get(LogLevelService);
      expect(service.getLevel()).toEqual({ level: 'error' });
      expect(service.setLevel('debug')).toEqual({ level: 'debug' });
      expect(service.setLevel('error')).toEqual({ level: 'error' });
    } finally {
      await module.close();
    }
  });

  it('exposes validated admin-only reads and changes over HTTP', async () => {
    let authorized = true;
    const module = await Test.createTestingModule({
      imports: [LoggerModule],
      controllers: [LogViewerController],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({
        canActivate: (context: import('@nestjs/common').ExecutionContext) => {
          if (!authorized) return false;
          context.switchToHttp().getRequest().user = { role: AdminRole.ADMIN };
          return true;
        },
      })
      .compile();
    const adapter = new FastifyAdapter();
    const app = module.createNestApplication(adapter, { logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
    await adapter.getInstance().ready();
    const request = (url: string, payload?: object) =>
      adapter.getInstance().inject({ method: 'POST', url, payload });
    try {
      expect((await request('/admin/logs/output-level')).json()).toEqual({
        level: 'error',
      });
      expect(
        (
          await request('/admin/logs/output-level/set', { level: 'trace' })
        ).json(),
      ).toEqual({ level: 'trace' });
      expect((await request('/admin/logs/output-level')).json()).toEqual({
        level: 'trace',
      });
      for (const payload of [{}, { level: 'all' }, { level: null }]) {
        expect(
          (await request('/admin/logs/output-level/set', payload)).statusCode,
        ).toBe(400);
      }
      expect(module.get(LogLevelService).getLevel()).toEqual({
        level: 'trace',
      });
      authorized = false;
      expect((await request('/admin/logs/output-level')).statusCode).toBe(403);
      expect(
        (await request('/admin/logs/output-level/set', { level: 'error' }))
          .statusCode,
      ).toBe(403);
      expect(module.get(LogLevelService).getLevel()).toEqual({
        level: 'trace',
      });
    } finally {
      await app.close();
    }
  });

  it('accepts only supported output levels', async () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      expect(
        await validate(Object.assign(new AdminLogOutputLevelDto(), { level })),
      ).toEqual([]);
    }
    for (const level of [
      undefined,
      null,
      '',
      'all',
      'silent',
      'verbose',
      'DEBUG',
      20,
    ]) {
      expect(
        await validate(Object.assign(new AdminLogOutputLevelDto(), { level })),
      ).not.toHaveLength(0);
    }
  });
});
