import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BusinessCode } from '../common/business-code.js';
import { S2sController } from './s2s.controller.js';

function target() {
  const federation = {
    resolveMediaFile: vi.fn().mockResolvedValue({
      absPath: '/unused',
      bytes: 16,
    }),
  };
  const controller = new S2sController(
    federation as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller, federation };
}

function mediaRequest(range: string): FastifyRequest {
  return {
    method: 'GET',
    url: `/s2s/v1/media/${'a'.repeat(64)}?fromAccount=alice&fromDomain=b.example&toAccount=bob&seq=42`,
    rawBody: Buffer.alloc(0),
    headers: { range },
    peer: { domain: 'a.example', keyId: 'a.example/key-1' },
  } as unknown as FastifyRequest;
}

function replyTarget() {
  const headers = new Map<string, string>();
  let status = 200;
  let body: unknown;
  const reply = {
    code: vi.fn((value: number) => {
      status = value;
      return reply;
    }),
    header: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
      return reply;
    }),
    send: vi.fn((value?: unknown) => {
      body = value;
      return reply;
    }),
  } as unknown as FastifyReply;
  return {
    reply,
    result: () => ({ status, headers, body }),
  };
}

describe('S2sController federation media errors', () => {
  it('returns the registered JSON envelope and Content-Range for 416', async () => {
    const { controller } = target();
    const response = replyTarget();
    await controller.getFile(mediaRequest('bytes=16-20'), response.reply);
    expect(response.result()).toMatchObject({
      status: 416,
      body: {
        code: BusinessCode.FEDERATION_RANGE_NOT_SATISFIABLE,
        message: 'requested range is not satisfiable',
        data: null,
      },
    });
    expect(response.result().headers.get('content-type')).toBe(
      'application/json',
    );
    expect(response.result().headers.get('content-range')).toBe('bytes */16');
  });

  it('rejects malformed and multi-range instead of serving the full file', async () => {
    const { controller } = target();
    await expect(
      controller.getFile(mediaRequest('bytes=0-1,3-4'), replyTarget().reply),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
  });

  it('maps an indeterminate resource lookup failure to retryable 503 INTERNAL', async () => {
    const { controller, federation } = target();
    federation.resolveMediaFile.mockRejectedValueOnce(new Error('db offline'));

    await expect(
      controller.getFile(mediaRequest('bytes=0-4'), replyTarget().reply),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.INTERNAL,
      status: 503,
    });
  });
});
