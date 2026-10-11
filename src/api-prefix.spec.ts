import 'reflect-metadata';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GLOBAL_PREFIX_EXCLUSIONS } from './bootstrap.js';
import {
  CLIENT_API_PREFIX,
  FEDERATION_API_PREFIX,
} from './federation/federation-protocol.js';

@Controller(FEDERATION_API_PREFIX)
class ProtocolProbeController {
  @Post('verify')
  verify() {
    return { surface: 'federation' };
  }

  @Get('future-resource/:id/nested')
  futureResource() {
    return { surface: 'federation' };
  }
}

@Controller()
class ClientProbeController {
  @Get('user/probe')
  user() {
    return { surface: 'user' };
  }

  @Post('admin/federation/probe')
  admin() {
    return { surface: 'admin' };
  }

  @Get('.well-known/somfp')
  discovery() {
    return { surface: 'discovery' };
  }

  @Get('s2s/v10/probe')
  otherVersion() {
    return { surface: 'client' };
  }
}

@Module({ controllers: [ProtocolProbeController, ClientProbeController] })
class PrefixProbeModule {}

describe('API namespace prefix boundaries', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      PrefixProbeModule,
      new FastifyAdapter(),
      { logger: false },
    );
    app.setGlobalPrefix(CLIENT_API_PREFIX, {
      exclude: [...GLOBAL_PREFIX_EXCLUSIONS],
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['POST', '/s2s/v1/verify', '/api/v1/s2s/v1/verify'],
    [
      'GET',
      '/s2s/v1/future-resource/42/nested',
      '/api/v1/s2s/v1/future-resource/42/nested',
    ],
    ['GET', '/.well-known/somfp', '/api/v1/.well-known/somfp'],
    ['GET', '/api/v1/user/probe', '/user/probe'],
    ['POST', '/api/v1/admin/federation/probe', '/admin/federation/probe'],
    ['GET', '/api/v1/s2s/v10/probe', '/s2s/v10/probe'],
  ] as const)(
    'registers %s %s without an alternate prefix',
    async (method, url, absent) => {
      const instance = app.getHttpAdapter().getInstance();
      const response = await instance.inject({ method, url });
      expect(response.statusCode).toBe(method === 'POST' ? 201 : 200);
      expect((await instance.inject({ method, url: absent })).statusCode).toBe(
        404,
      );
    },
  );
});
