import Fastify, { type FastifyRequest } from 'fastify';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { MEDIA_UPLOAD_CHUNK_BYTES } from '../../shared/media-upload-limits.js';
import {
  UploadActivityService,
  type UploadActivityHandle,
} from './upload-activity.service.js';
import {
  registerUploadActivityTransport,
  uploadBodyActivity,
} from './upload-activity.transport.js';

const id = '9007199254740993';
const url = `/api/v1/uploads/resumable/${id}`;
const task = { taskId: id, userId: 1 };
const headers = {
  'content-type': 'application/octet-stream',
  authorization: 'Bearer valid',
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('upload receive transport', () => {
  let fastify: ReturnType<typeof Fastify>;
  let activity: UploadActivityService;
  let lastRequest: FastifyRequest;
  let handle: UploadActivityHandle;
  let authorizationBarrier: Promise<void> | undefined;
  let fail: ReturnType<typeof vi.fn<() => void>>;
  let handler: ReturnType<typeof vi.fn<(request: { body: Buffer }) => unknown>>;
  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    });
    activity = new UploadActivityService();
    fail = vi.fn();
    handle = activity.watch(task, fail);
    authorizationBarrier = undefined;
    fastify = Fastify();
    registerUploadActivityTransport(fastify, activity, async (request) => {
      lastRequest = request;
      if (request.headers.authorization !== 'Bearer valid') {
        throw new BusinessException(
          BusinessCode.UNAUTHENTICATED,
          'unauthenticated',
          401,
        );
      }
      if (request.headers['x-owner'] === 'other') {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'upload not found',
          404,
        );
      }
      const authorizedHandle = handle;
      await authorizationBarrier;
      return authorizedHandle;
    });
    handler = vi.fn((request) => ({
      bytes: request.body.length,
      currentHandle: uploadBodyActivity(request.body)?.upload === handle,
    }));
    fastify.put(
      '/api/v1/uploads/resumable/:id',
      async (request: FastifyRequest) => handler(request as { body: Buffer }),
    );
    await fastify.ready();
  });
  afterEach(async () => {
    activity.onApplicationShutdown();
    await fastify.close();
    vi.useRealTimers();
  });

  it('buffers all bytes without draining before the parser and preserves the exact execution handle', async () => {
    const response = await fastify.inject({
      method: 'PUT',
      url,
      headers: { ...headers, 'content-length': '6' },
      payload: Readable.from([Buffer.from('abc'), Buffer.from('def')]),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bytes: 6, currentHandle: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fail).toHaveBeenCalledOnce();
  });

  it('accepts exactly 4MiB without changing the binary body', async () => {
    const payload = Buffer.alloc(MEDIA_UPLOAD_CHUNK_BYTES, 0xa5);
    handler.mockImplementation((request) => {
      expect(request.body.equals(payload)).toBe(true);
      return { bytes: request.body.length };
    });
    const response = await fastify.inject({
      method: 'PUT',
      url,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().bytes).toBe(MEDIA_UPLOAD_CHUNK_BYTES);
  });

  it('rejects other body types so they cannot bypass receive tracking', async () => {
    const response = await fastify.inject({
      method: 'PUT',
      url,
      headers: { ...headers, 'content-type': 'text/plain' },
      payload: 'untracked',
    });
    expect(response.statusCode).toBe(415);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fail).toHaveBeenCalledOnce();
  });

  it('times out a body that never sends its first byte without renewing on headers', async () => {
    await vi.advanceTimersByTimeAsync(20_000);
    const body = new PassThrough();
    const response = fastify.inject({
      method: 'PUT',
      url,
      headers,
      payload: body,
    });
    await turn();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await response).statusCode).toBe(408);
    expect(fail).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    body.destroy();
  });

  it('preserves the 4MiB parser bound for declared and streamed lengths', async () => {
    const declared = await fastify.inject({
      method: 'PUT',
      url,
      headers: {
        ...headers,
        'content-length': String(MEDIA_UPLOAD_CHUNK_BYTES + 1),
      },
      payload: 'a',
    });
    expect(declared.statusCode).toBe(413);
    const streamed = await fastify.inject({
      method: 'PUT',
      url,
      headers,
      payload: Readable.from([
        Buffer.alloc(MEDIA_UPLOAD_CHUNK_BYTES),
        Buffer.from('x'),
      ]),
    });
    expect(streamed.statusCode).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves Content-Length mismatch validation', async () => {
    const response = await fastify.inject({
      method: 'PUT',
      url,
      headers: { ...headers, 'content-length': '8' },
      payload: Readable.from([Buffer.from('short')]),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('FST_ERR_CTP_INVALID_CONTENT_LENGTH');
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...headers, authorization: 'Bearer invalid' }, 401],
    [{ ...headers, 'x-owner': 'other' }, 404],
  ])(
    'rejects unauthorized activity without refreshing the waiting deadline',
    async (requestHeaders, status) => {
      await vi.advanceTimersByTimeAsync(29_999);
      const response = await fastify.inject({
        method: 'PUT',
        url,
        headers: requestHeaders,
        payload: 'data',
      });
      expect(response.statusCode).toBe(status);
      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fail).toHaveBeenCalledOnce();
    },
  );

  it('renews on streaming bytes and terminates an incomplete body exactly 30s after the last byte', async () => {
    const body = new PassThrough();
    const response = fastify.inject({
      method: 'PUT',
      url,
      headers,
      payload: body,
    });
    await turn();
    body.write(Buffer.from('one'));
    await turn();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fail).not.toHaveBeenCalled();
    body.write(Buffer.from('two'));
    await turn();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await response).statusCode).toBe(408);
    expect(fail).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    body.destroy();
  });

  it('stops an old receiving body on retry and cannot refresh the replacement', async () => {
    const body = new PassThrough();
    const response = fastify.inject({
      method: 'PUT',
      url,
      headers,
      payload: body,
    });
    await turn();
    body.write('old');
    await turn();
    const nextFail = vi.fn();
    activity.stop(handle);
    handle = activity.watch(task, nextFail);
    expect((await response).statusCode).toBe(409);
    body.write('stale');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(nextFail).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    body.destroy();
  });

  it('rejects stale admission when stop/retry replaces the same task during authorization', async () => {
    let authorize!: () => void;
    authorizationBarrier = new Promise<void>(
      (resolve) => (authorize = resolve),
    );
    const response = fastify.inject({
      method: 'PUT',
      url,
      headers,
      payload: 'stale body',
    });
    await turn();
    const old = handle;
    activity.stop(old);
    const nextFail = vi.fn();
    handle = activity.watch(task, nextFail);
    expect(handle.task).toEqual(old.task);
    expect(handle).not.toBe(old);
    await vi.advanceTimersByTimeAsync(20_000);
    authorize();
    expect((await response).statusCode).toBe(409);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(nextFail).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it('retains the last byte deadline after a request disconnect', async () => {
    const body = new PassThrough();
    const response = fastify.inject({
      method: 'PUT',
      url,
      headers,
      payload: body,
    });
    await turn();
    body.write('partial');
    await turn();
    await vi.advanceTimersByTimeAsync(25_000);
    lastRequest.raw.emit('aborted');
    expect((await response).statusCode).toBe(400);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fail).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    body.destroy();
  });

  it('does not time out while the server processes a fully buffered body', async () => {
    let finish!: () => void;
    handler.mockImplementation(async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      return { ok: true };
    });
    const response = fastify.inject({
      method: 'PUT',
      url,
      headers,
      payload: 'complete body',
    });
    await turn();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fail).not.toHaveBeenCalled();
    finish();
    expect((await response).statusCode).toBe(200);
  });
});
