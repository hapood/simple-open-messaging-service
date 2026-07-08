import { ValidationPipe, RequestMethod } from '@nestjs/common';
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
import fastifyCookie from '@fastify/cookie';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'node:stream';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { SerializeInterceptor } from './common/serialize.interceptor.js';
import { AccessTokenValidator, MEDIA_TOKEN_COOKIE } from './auth/access-token.validator.js';
import { BusinessCode } from './common/business-code.js';

// Multipart upload size cap — the hard ceiling for any single uploaded part. Raised to 100MB so
// POST /upload/video can admit video; images stay bounded at UploadService.MAX_IMAGE_BYTES, files at
// MAX_FILE_BYTES, audio at MAX_AUDIO_BYTES (each enforced in its consumer) so this ceiling does not
// also raise them. consumeImage/consumeFile/consumeVideo/consumeAudio treat over-limit as a
// 'too-large' rejection (not a 500).
const MULTIPART_LIMIT = 100 * 1024 * 1024;

/** Parse a comma-separated ALLOWED_ORIGINS env into a trimmed, de-duplicated list. Empty when
 *  unset → CORS falls back to the dev/permissive posture (see configureApp). Used to admit
 *  cross-origin native clients such as the Tauri desktop webview (tauri://localhost,
 *  https://tauri.localhost, http://tauri.localhost). */
function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const origin = part.trim();
    if (origin && !seen.has(origin)) {
      seen.add(origin);
      out.push(origin);
    }
  }
  return out;
}

/** Extract the token from an `Authorization: Bearer <token>` header, case-insensitive. Used as
 *  the cross-origin fallback for /uploads/* (native <img> can't set headers → they use the
 *  media_token cookie; the Tauri media proxy + other native clients send Bearer instead). */
function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(header);
  return match ? match[1] : undefined;
}

/** Media extensions served INLINE from /uploads. Images (magic-byte-verified at POST /upload) plus
 *  video/audio containers — the latter so <video src>/<audio src> can stream-play rather than being
 *  forced to download. Everything else (generic files: .html/.svg/.exe/...) is forced to download so
 *  it can never inline-render in this origin (XSS via the same-origin httpOnly media_token cookie). */
const INLINE_MEDIA_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', // images
  'mp4', 'webm', 'mov', 'flv', 'avi', // video
  'mp3', 'ogg', 'opus', 'wav', 'm4a', 'flac', 'aac', // audio
]);

/** Whether a /uploads resource path should be served inline (image/video/audio via <img>/<video>/
 *  <audio src>) or forced to a download. Non-media user uploads MUST download. */
function isInlineMedia(resourcePath: string): boolean {
  const dot = resourcePath.lastIndexOf('.');
  if (dot < 0) return false;
  return INLINE_MEDIA_EXTS.has(resourcePath.slice(dot + 1).toLowerCase());
}

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
  // Cookie parsing for the httpOnly media_token cookie that authenticates same-origin /uploads/*
  // requests (native <img>/<a download> can't send the Authorization header). @fastify/cookie is
  // fp-wrapped, so it decorates the root instance and request.cookies is reachable both here and in
  // the /uploads/ preHandler hook (registered in registerStaticServing).
  await app.register(fastifyCookie);

  // S2S raw-body capture: RFC 9421 content-digest verification needs the EXACT body bytes the sender
  // signed — re-serialized JSON would not match. Scoped to /api/v1/s2s/* so only S2S requests pay
  // the double-buffer cost; every other route passes through untouched. S2sSignatureGuard reads
  // req.rawBody.
  adapter.getInstance().addHook('preParsing', async (req, _reply, payload) => {
    if (!req.url.startsWith('/api/v1/s2s/')) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload as AsyncIterable<Buffer>) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    req.rawBody = raw;
    const stream = new Readable();
    stream.push(raw);
    stream.push(null);
    return stream;
  });

  // CORS posture:
  //  - Same-origin production deploy (single-image, path-prefix) needs none.
  //  - Dev echoes any Origin so the separate frontend dev servers (web :4200, admin :5180) can call :3000.
  //  - Cross-origin native clients (Tauri desktop webview at tauri://localhost etc.) set
  //    ALLOWED_ORIGINS to an explicit allowlist; the request Origin is mirrored only if listed,
  //    and credentials are allowed so the media_token cookie + Authorization can ride along.
  const isDev = process.env.NODE_ENV !== 'production';
  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  app.enableCors(
    allowedOrigins.length > 0
      ? { origin: allowedOrigins, credentials: true }
      : { origin: isDev },
  );

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
  // .well-known/soms is excluded — it must be served at the bare path per RFC 8615 (peers fetch it
  // without knowing our /api/v1 prefix).
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: '.well-known/soms', method: RequestMethod.GET }],
  });

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

  // Auth-gate /uploads/*: native <img src="/uploads/..."> and <a download> requests can't carry
  // the Authorization header, so the access token is also placed in an httpOnly `media_token`
  // cookie by the auth endpoints. Validate it here with the SAME AccessTokenValidator the API
  // JwtStrategy uses — a revoked token (logout / password change / session invalidate) therefore
  // loses media access too. Registered on the root instance as a global preHandler; Fastify
  // propagates parent hooks into the @fastify/static child context that owns the /uploads/ route.
  const tokenValidator = app.get(AccessTokenValidator);
  adapter.getInstance().addHook(
    'preHandler',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.url.startsWith('/uploads/')) return; // only the media mount is gated
      // Native <img>/<a download> can't send Authorization → they ride the httpOnly media_token
      // cookie (same-origin browser path). Cross-origin clients (the Tauri media proxy, any
      // native client) can't use that cookie — SameSite=Strict suppresses it cross-origin — so
      // also accept a Bearer header. Same validator, same revocation; the cookie stays primary.
      const raw = request.cookies?.[MEDIA_TOKEN_COOKIE] ?? extractBearer(request.headers.authorization);
      const payload = raw ? tokenValidator.verifyToken(raw) : null;
      const principal = payload ? await tokenValidator.validatePayload(payload) : null;
      if (!principal) {
        return reply.code(401).type('application/json').send({
          statusCode: 401,
          code: BusinessCode.UNAUTHENTICATED,
          message: 'unauthenticated',
          data: null,
        });
      }
      request.user = { userId: principal.userId };
    },
  );

  // Uploaded files are served at /uploads/*. decorateReply:false because we never use
  // reply.sendFile (the SPA fallback reads index.html directly), and multiple @fastify/static
  // registrations must not re-decorate the reply.
  // cacheControl:false makes the `send` stream omit its own Cache-Control (otherwise it emits
  // "public, max-age=0" and @fastify/static applies it AFTER setHeaders, clobbering ours). With it
  // off, setHeaders controls the directive: `private` (no proxy caching — the resource is
  // auth-gated) with a short browser max-age; Vary:Cookie so a shared browser doesn't reuse one
  // session's response for another.
  //
  // Open upload model (any file type accepted at POST /upload/file): serving-side headers carry
  // the security the old whitelist used to. nosniff is set on EVERYTHING so the extension's
  // Content-Type is honored, never sniffed into text/html. Non-image responses get
  // Content-Disposition: attachment — the browser downloads them, never navigates/renders, so an
  // uploaded .html/.svg/.exe cannot execute in this origin. send/Content-Type is left untouched
  // (Content-Disposition alone is sufficient and avoids fighting @fastify/static's Content-Type,
  // which it sets after setHeaders). Images stay inline so <img src> renders.
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (
      res: { setHeader: (name: string, value: string) => void },
      resourcePath: string,
    ) => {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('Vary', 'Cookie');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!isInlineMedia(resourcePath)) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
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
