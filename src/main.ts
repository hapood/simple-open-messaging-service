import 'dotenv/config'; // Load .env first so the AppModule import chain (requireEnv, Prisma) sees the vars.
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { readFileSync } from 'fs';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';

// HTTP/2 requires TLS — browsers do not negotiate h2 over cleartext. When both TLS_CERT and
// TLS_KEY (PEM file paths) are provided the service speaks real ALPN h2 directly, which is
// useful when it runs as the edge. Without them it stays plain HTTP/1.1, the correct mode for
// local dev or a prod topology where a reverse proxy terminates TLS+h2 at the edge and the
// origin leg is h1.1. Never set http2 without https: that yields h2c, which browsers can't use.
//
// The options object is built inline so TypeScript checks it against FastifyAdapter's
// constructor union (FastifyServerOptions | FastifyHttp2SecureOptions | ...); pre-typing it as
// FastifyServerOptions would reject http2/https, which live on the h2-secure superset.
const tlsCert = process.env.TLS_CERT;
const tlsKey = process.env.TLS_KEY;
const enableH2 = Boolean(tlsCert && tlsKey);

async function bootstrap() {
  const adapter = new FastifyAdapter(
    enableH2
      ? {
          // Trust a single reverse-proxy hop so rate limiting sees the real client IP
          // (see local.strategy.ts). Number = trust the last N hops; never `true`.
          trustProxy: 1,
          http2: true,
          https: {
            cert: readFileSync(tlsCert as string),
            key: readFileSync(tlsKey as string),
          },
        }
      : { trustProxy: 1 },
  );

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
  );
  await configureApp(app, adapter);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(
    `[main] listening on ${enableH2 ? 'https' : 'http'}://0.0.0.0:${port} ` +
      `(${enableH2 ? 'HTTP/2 over TLS' : 'HTTP/1.1'})`,
  );
}

bootstrap();
