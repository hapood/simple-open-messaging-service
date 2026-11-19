import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { expect, it, vi } from 'vitest';
import { HttpAdmissionService } from './http-admission.service.js';
import Fastify from 'fastify';

it('rejects before body parsing and route hooks for every route namespace', async () => {
  const server = Fastify();
  const admission = new HttpAdmissionService();
  admission.register(server);
  const preHandler = vi.fn(async () => {});
  const handler = vi.fn(async () => ({ ready: true }));
  server.addHook('preHandler', preHandler);
  for (const url of ['/api/v1/send', '/somfp/v1/feed-heads', '/uploads/file'])
    server.post(url, handler);
  await server.ready();
  admission.onModuleDestroy();
  try {
    for (const url of [
      '/api/v1/send',
      '/somfp/v1/feed-heads',
      '/uploads/file',
    ]) {
      const response = await server.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: '{invalid-json',
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        message: 'service shutting down',
      });
    }
    expect(preHandler).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

it('rejects new HTTP requests before imported services drain, without aborting admitted work', async () => {
  let releaseDestroy!: () => void;
  let releaseRequest!: () => void;
  const destroying = new Promise<void>((resolve) => {
    releaseDestroy = resolve;
  });
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const destroy = vi.fn(() => destroying);
  const handler = vi.fn(async () => {
    await requestGate;
    return { ready: true };
  });
  @Module({
    providers: [{ provide: 'worker', useValue: { onModuleDestroy: destroy } }],
  })
  class WorkerModule {}
  const mod = await Test.createTestingModule({
    imports: [WorkerModule],
    providers: [HttpAdmissionService],
  }).compile();
  const adapter = new FastifyAdapter();
  const app = mod.createNestApplication<NestFastifyApplication>(adapter);
  mod.get(HttpAdmissionService).register(adapter.getInstance());
  adapter.getInstance().get('/work', handler);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const admitted = fetch(`${base}/work`);
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  const closing = app.close();
  try {
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    const rejected = await fetch(`${base}/work`);
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('connection')).toBe('close');
    expect(rejected.headers.get('retry-after')).toBe('1');
    expect(await rejected.json()).toMatchObject({
      message: 'service shutting down',
    });
    expect(handler).toHaveBeenCalledOnce();
    releaseRequest();
    const response = await admitted;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
  } finally {
    releaseRequest();
    releaseDestroy();
    await closing;
  }
});
