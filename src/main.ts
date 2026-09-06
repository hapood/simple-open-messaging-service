import 'dotenv/config'; // Load .env first so the AppModule import chain sees required environment variables.
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { parseTrustedProxyConfig } from './rate-limit/trusted-proxy.js';
import { resolveDirectTlsPaths } from './common/direct-tls.js';

// HTTP/2 requires TLS — browsers do not negotiate h2 over cleartext. When both TLS_CERT and
// TLS_KEY (PEM file paths) are provided the service speaks real ALPN h2 directly, which is
// useful when it runs as the edge. Without them it stays plain HTTP/1.1, the correct mode for
// local dev or a prod topology where a reverse proxy terminates TLS+h2 at the edge and the
// origin leg is h1.1. Never set http2 without https: that yields h2c, which browsers can't use.
//
// The options object is built inline so TypeScript checks it against FastifyAdapter's
// constructor union (FastifyServerOptions | FastifyHttp2SecureOptions | ...); pre-typing it as
// FastifyServerOptions would reject http2/https, which live on the h2-secure superset.
const directTls = resolveDirectTlsPaths(process.env);
const enableH2 = Boolean(directTls);

async function bootstrap() {
  const trustedProxies = parseTrustedProxyConfig(
    process.env.TRUSTED_PROXY_CIDRS,
  );
  const adapter = new FastifyAdapter(
    enableH2
      ? {
          // Only explicitly configured proxy networks may supply X-Forwarded-*.
          trustProxy: trustedProxies.isTrusted,
          // Correlation ID: honor an inbound X-Request-Id (reverse-proxy / upstream) else mint a UUID.
          // Fastify owns request.id; pino-http reuses it, so every access + app log for one request
          // shares the id, and bootstrap's onSend hook echoes it back on the response header.
          requestIdHeader: 'x-request-id',
          genReqId: () => randomUUID(),
          http2: true,
          https: {
            cert: readFileSync(directTls!.cert),
            key: readFileSync(directTls!.key),
          },
          // Global cap on every inbound request body (JSON API + S2S payloads). Multipart
          // uploads are NOT affected — @fastify/multipart enforces its own fileSize/fieldSize,
          // so large image/file uploads are unaffected. 1 MiB comfortably fits the largest legit
          // JSON body — an S2S friend-request/approve payload carrying a ~55 KiB base64 avatar
          // (512×512 webp) inline — and acts as a hard anti-OOM ceiling against a peer shipping
          // an oversized payload.
          bodyLimit: 1_048_576,
        }
      : {
          trustProxy: trustedProxies.isTrusted,
          // Correlation ID — see the h2 branch above.
          requestIdHeader: 'x-request-id',
          genReqId: () => randomUUID(),
          // See the h2 branch above: global JSON/body ceiling (fits a ~55 KiB base64 S2S avatar), multipart-exempt.
          bodyLimit: 1_048_576,
        },
  );

  // bufferLogs: Nest buffers early startup logs until the pino logger is registered below, then
  // flushes them through pino (no lost startup logs, no double logging). The structured pino logger
  // (multistream → stdout + rotating file + the in-process ring buffer/SSE fan-out) is built by
  // LoggerModule (nestjs-pino) and replaces Nest's default ConsoleLogger — so every existing
  // `new Logger('Ctx')` call site routes through pino with its context preserved, unchanged.
  // LOG_LEVEL is now resolved inside the pino factory, not here.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    {
      bufferLogs: true,
    },
  );
  app.useLogger(app.get(Logger));
  app.get(Logger).log(
    {
      event: 'trusted_proxy_config',
      rangeCount: trustedProxies.cidrs.length,
    },
    'Trusted proxy configuration loaded',
  );
  if (trustedProxies.trustAllCidrs.length > 0) {
    app.get(Logger).warn(
      {
        event: 'trusted_proxy_trust_all',
        cidrs: trustedProxies.trustAllCidrs,
      },
      'Trusted proxy configuration accepts forwarded addresses from every peer',
    );
  }
  await configureApp(app, adapter);
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(
    `[main] listening on ${enableH2 ? 'https' : 'http'}://0.0.0.0:${port} ` +
      `(${enableH2 ? 'HTTP/2 over TLS' : 'HTTP/1.1'})`,
  );
}

bootstrap();
