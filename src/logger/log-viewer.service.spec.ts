import { describe, expect, it, vi } from 'vitest';
import { get } from 'node:http';
import { once } from 'node:events';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AdminAuthGuard } from '../admin/admin-auth.guard.js';
import { LogViewerController } from './log-viewer.controller.js';
import { LogViewerService, matchesLogFilters } from './log-viewer.service.js';
import type { LogRecord } from './log-stream-store.js';

const record: LogRecord = {
  level: 'info',
  time: 1,
  msg: 'retried media transfer',
  scope: 'media-transfer',
  taskId: 'task-a',
};

describe('log viewer SSE', () => {
  it('ANDs scope and taskId filters', () => {
    expect(matchesLogFilters(record, {})).toBe(true);
    expect(matchesLogFilters(record, { scope: 'media-transfer' })).toBe(true);
    expect(matchesLogFilters(record, { taskId: 'task-a' })).toBe(true);
    expect(
      matchesLogFilters(record, { scope: 'media-transfer', taskId: 'task-a' }),
    ).toBe(true);
    expect(
      matchesLogFilters(record, { scope: 'other', taskId: 'task-a' }),
    ).toBe(false);
    expect(
      matchesLogFilters(record, { scope: 'media-transfer', taskId: 'task-b' }),
    ).toBe(false);
  });

  it('replays filtered records and releases the subscriber on stream close', () => {
    let publish: (rec: LogRecord) => void = () => undefined;
    const unsubscribe = vi.fn();
    const store = {
      snapshot: vi.fn(() => [record, { ...record, scope: 'other' }]),
      subscribe: vi.fn((handler: (rec: LogRecord) => void) => {
        publish = handler;
        return unsubscribe;
      }),
    };
    const service = new LogViewerService(store as never);
    const received: unknown[] = [];
    const sub = service
      .attach('info', 'media-transfer', 'task-a')
      .subscribe((event) => received.push(event));
    expect(received).toEqual([{ type: 'log', data: record }]);
    publish({ ...record, msg: 'next' });
    publish({ ...record, taskId: 'other' });
    expect(received).toHaveLength(2);
    sub.unsubscribe();
    expect(unsubscribe).toHaveBeenCalledOnce();
    publish(record);
    expect(received).toHaveLength(2);
  });

  it('releases an actual framework log stream on HTTP disconnect', async () => {
    const unsubscribe = vi.fn();
    const service = new LogViewerService({
      snapshot: () => [record],
      subscribe: () => unsubscribe,
    } as never);
    const module = await Test.createTestingModule({
      controllers: [LogViewerController],
      providers: [{ provide: LogViewerService, useValue: service }],
    })
      .overrideGuard(AdminAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = module.createNestApplication(new FastifyAdapter(), {
      logger: false,
    });
    await app.listen(0, '127.0.0.1');
    const request = get(`${await app.getUrl()}/admin/logs/stream`);
    try {
      const [response] = await once(request, 'response');
      expect(response.headers['content-type']).toBe('text/event-stream');
      const chunks: string[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
      await vi.waitFor(() => expect(chunks.join('')).toContain('event: log'));
      request.destroy();
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    } finally {
      request.destroy();
      await app.close();
    }
  });
});
