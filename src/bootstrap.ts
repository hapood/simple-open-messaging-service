import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyCompress from '@fastify/compress';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { SerializeInterceptor } from './common/serialize.interceptor.js';

// Multipart upload size cap. Single source of truth — consumeImage treats over-limit as a
// 'too-large' rejection (not a 500).
const MULTIPART_LIMIT = 10 * 1024 * 1024;

/**
 * Shared Fastify/Nest wiring — the single place plugins, global pipes/filters/interceptors,
 * the API prefix, Swagger UI, and static serving are configured. Called by both main.ts
 * (production) and the e2e harness so tests exercise the real adapter config (multipart parser,
 * static mounts, etc.) instead of a stripped-down stand-in.
 *
 * Must be called after the app context is initialized (NestFactory.create inits implicitly;
 * the e2e harness calls app.init() first) so SwaggerModule.createDocument can see the routes.
 */
export async function configureApp(
  app: NestFastifyApplication,
  adapter: FastifyAdapter,
): Promise<void> {
  // Security headers first, before any route is registered, so no response slips out
  // unprotected. Defaults mirror the previous Express helmet() posture.
  await app.register(fastifyHelmet);
  // gzip/brotli for static assets + API responses (replaces Express compression()).
  await app.register(fastifyCompress);
  // multipart/form-data parsing for the image-upload routes (replaces multer).
  await app.register(fastifyMultipart, {
    limits: { fileSize: MULTIPART_LIMIT },
  });

  // Same-origin in production (single-image, path-prefix deploy) → no CORS needed.
  // Dev echoes any Origin so the separate frontend dev servers (web :4200, admin :5180) can call :3000.
  const isDev = process.env.NODE_ENV !== 'production';
  app.enableCors({ origin: isDev });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip fields not declared on the DTO
      forbidNonWhitelisted: true, // reject requests with undeclared fields (400)
      transform: true, // convert plain objects to DTO instances and coerce scalars via @Type
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new SerializeInterceptor());

  // Global route prefix. All HTTP endpoints (incl. SSE /events) live under /api/v1 (must be set
  // before Swagger createDocument so doc paths include it). Swagger UI mounts at /api/v1/docs.
  app.setGlobalPrefix('api/v1');

  const config = new DocumentBuilder()
    .setTitle('Simple Open Chat API')
    .setDescription('Third-party IM integration API (P1a contract layer)')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);

  await registerStaticServing(app, adapter);
}

/**
 * Static asset serving: uploaded images at /uploads/* and, when the built frontends are
 * present, the web + admin SPAs.
 *
 * Replaces @nestjs/serve-static, which on the Fastify path silently drops most options
 * (nestjs/serve-static#187 — maxAge was ineffective) and typed setHeaders against an h1
 * ServerResponse. Serving both SPAs via @fastify/static with a prefix-aware not-found
 * handler gives correct long-cache headers on hashed assets, no-cache on index.html, and an
 * index.html fallback for client-side deep links while preserving JSON 404s for /api and
 * /uploads so API clients and broken image URLs never receive HTML.
 *
 * In dev the frontends run on their own dev servers (ng serve / vite), so public/ is absent
 * and only the /uploads mount is registered.
 */
async function registerStaticServing(
  app: NestFastifyApplication,
  adapter: FastifyAdapter,
) {
  const uploadsDir = join(process.cwd(), 'uploads');
  // @fastify/static throws at registration if root is missing; ensure it exists (matches the
  // lazy mkdir UploadService.ensureDir already does for the write path).
  mkdirSync(uploadsDir, { recursive: true });

  // Uploaded images are served at /uploads/*. decorateReply:false because we never use
  // reply.sendFile (the SPA fallback reads index.html directly), and multiple @fastify/static
  // registrations must not re-decorate the reply.
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
  });

  const webRoot = join(process.cwd(), 'public', 'web');
  if (!existsSync(webRoot)) return; // dev: frontends served by their own dev servers

  const adminRoot = join(process.cwd(), 'public', 'admin');
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  // Long-cache hashed assets for a year; never cache index.html so new deploys are picked up
  // immediately. The structural setHeader type accepts both h1 ServerResponse and h2 Http2ServerResponse.
  const cacheOptions = {
    maxAge: ONE_YEAR_MS,
    setHeaders: (
      res: { setHeader: (name: string, value: string) => void },
      resourcePath: string,
    ) => {
      if (resourcePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  };

  // Register admin before the root web mount so the /admin prefix is its own scope.
  await app.register(fastifyStatic, {
    root: adminRoot,
    prefix: '/admin',
    decorateReply: false,
    ...cacheOptions,
  });
  // Web SPA at root (no prefix, avoids the '/' + '/{*any}' double-slash).
  await app.register(fastifyStatic, {
    root: webRoot,
    decorateReply: false,
    ...cacheOptions,
  });

  // SPA fallback for client-side deep links (e.g. /admin/users, /dashboard). Requests to
  // /api/* and /uploads/* keep a JSON 404 so they don't receive HTML.
  const webIndex = readFileSync(join(webRoot, 'index.html'));
  const adminIndex = readFileSync(join(adminRoot, 'index.html'));
  adapter.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url;
    if (url.startsWith('/api/') || url.startsWith('/uploads/')) {
      return reply
        .code(404)
        .type('application/json')
        .send({
          statusCode: 404,
          message: `Cannot ${req.method} ${url}`,
          error: 'Not Found',
        });
    }
    const index = url.startsWith('/admin') ? adminIndex : webIndex;
    return reply
      .code(200)
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .type('text/html')
      .send(index);
  });
}
