import 'dotenv/config'; // Load .env first so the AppModule import chain (requireEnv, Prisma) sees the vars.
import { NestFactory } from '@nestjs/core';
import { LogLevel } from '@nestjs/common';
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

// Nest log levels, least→most verbose. The logger option takes the explicit enabled set, so we
// expand a single requested level into that level + every more-severe one.
const LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

/**
 * Resolve LOG_LEVEL env to the enabled LogLevel set. Default 'log' keeps routine app output
 * (log/warn/error/fatal) while suppressing debug/verbose — so client-disconnect lines (logged at
 * debug by AllExceptionsFilter) stay quiet in normal operation. Set LOG_LEVEL=debug to surface
 * them when investigating an SSE/streaming incident; warn/error to quiet production.
 */
function resolveLogLevel(raw: string | undefined): LogLevel[] {
  const requested = (raw ?? 'log').toLowerCase();
  const idx = LOG_LEVELS.indexOf(requested as LogLevel);
  // Unknown value → fall back to 'log' (enables log/warn/error/fatal; debug/verbose off).
  const enabled = idx === -1 ? LOG_LEVELS.indexOf('log') : idx;
  return LOG_LEVELS.slice(0, enabled + 1);
}

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
          // Global cap on every inbound request body (JSON API + S2S envelopes). Multipart
          // uploads are NOT affected — @fastify/multipart enforces its own fileSize/fieldSize,
          // so large image/file uploads are unaffected. 1 MiB comfortably fits the largest legit
          // JSON body — an S2S friend.request/approve envelope carrying a ~55 KiB base64 avatar
          // (512×512 webp) inline — and acts as a hard anti-OOM ceiling against a peer shipping
          // an oversized payload. See docs/federation-protocol.md (avatar federation).
          bodyLimit: 1_048_576,
        }
      : {
          trustProxy: 1,
          // See the h2 branch above: global JSON/body ceiling (fits a ~55 KiB base64 S2S avatar), multipart-exempt.
          bodyLimit: 1_048_576,
        },
  );

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: resolveLogLevel(process.env.LOG_LEVEL),
  });
  await configureApp(app, adapter);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(
    `[main] listening on ${enableH2 ? 'https' : 'http'}://0.0.0.0:${port} ` +
      `(${enableH2 ? 'HTTP/2 over TLS' : 'HTTP/1.1'})`,
  );
}

bootstrap();
