import {
  Body,
  Controller,
  Get,
  HttpStatus,
  type INestApplication,
  Post,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BusinessCode } from './business-code.js';
import { BusinessException } from './business.exception.js';
import { AllExceptionsFilter } from './exception.filter.js';

@Controller('s2s/v1/error-probe')
class FederationErrorProbeController {
  @Get('internal')
  internal(): never {
    throw new Error('database offline');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new BusinessException(
      BusinessCode.FORBIDDEN,
      'not visible',
      HttpStatus.FORBIDDEN,
    );
  }

  @Post('body')
  body(@Body() body: unknown): unknown {
    return body;
  }
}

describe('AllExceptionsFilter federation HTTP boundary', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      controllers: [FederationErrorProbeController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = fixture.createNestApplication(new FastifyAdapter({ bodyLimit: 32 }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => app.close());

  it('returns HTTP 200 for an ordinary business refusal', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/s2s/v1/error-probe/forbidden',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      code: BusinessCode.FORBIDDEN,
      message: 'not visible',
      data: null,
    });
  });

  it('returns HTTP 503 for an unexpected handler failure', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/s2s/v1/error-probe/internal',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: BusinessCode.INTERNAL,
      message: 'federation service temporarily unavailable',
      data: null,
    });
  });

  it('normalizes an oversized body before controller execution', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/s2s/v1/error-probe/body',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ value: 'x'.repeat(64) }),
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: BusinessCode.FEDERATION_MALFORMED,
      message: 'malformed federation request',
      data: null,
    });
  });

  it('normalizes malformed JSON before controller execution', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/s2s/v1/error-probe/body',
        headers: { 'content-type': 'application/json' },
        payload: '{"broken"',
      });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: BusinessCode.FEDERATION_MALFORMED,
      message: 'malformed federation request',
      data: null,
    });
  });
});
