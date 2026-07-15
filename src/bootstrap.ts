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
import { mkdirSync } from 'fs';
import { join } from 'path';
import { Readable } from 'node:stream';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { SerializeInterceptor } from './common/serialize.interceptor.js';
import { MEDIA_TOKEN_COOKIE } from './auth/access-token.validator.js';
import { BearerAuthService } from './auth/bearer-auth.service.js';
import { MediaAccessService } from './upload/media-access.service.js';
import { BusinessCode } from './common/business-code.js';

// Multipart upload size cap — the hard ceiling for any single uploaded part. Raised to 100MB so
// POST /upload/video can admit video; images stay bounded at UploadService.MAX_IMAGE_BYTES, files at
// MAX_FILE_BYTES, audio at MAX_AUDIO_BYTES (each enforced in its consumer) so this ceiling does not
// also raise them. consumeImage/consumeFile/consumeVideo/consumeAudio treat over-limit as a
// 'too-large' rejection (not a 500).
const MULTIPART_LIMIT = 100 * 1024 * 1024;

/** Matches a CAS shard URL at the start of a request path and captures the 64-hex digest. The
 *  /uploads/ preHandler uses this to decide whether a request needs per-object authorization (a
 *  shard path → yes; avatars / legacy-flat → no, auth-n-only). No `g` flag: .exec is stateless
 *  across requests, which the shared hook requires. */
const SHARD_DIGEST_GATE_RE = /^\/uploads\/shards\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})\./;

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

  // Echo the request correlation id on the response. request.id is already set by Fastify at the
  // onRequest stage (honored from the inbound X-Request-Id header, else the UUID from the adapter's
  // genReqId in main.ts); pino-http reuses that same id, so the echoed value matches the req.id in
  // every access + app log line for the request — a client or support can grep the full trail. Set in
  // onRequest (not onSend): onSend has payload-return semantics a void header-setting hook would
  // violate (it hung the response); reply headers accumulate and are sent once at final send.
  // Scoped to API routes (static assets / SPA HTML carry no correlation value; hijacked SSE responses
  // skip Fastify's lifecycle entirely anyway).
  adapter.getInstance().addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/') && !request.url.startsWith('/.well-known/')) return;
    reply.header('X-Request-Id', String(request.id));
  });

  // CORS posture — fully open: reflect any Origin, NO credentialed cross-origin.
  //
  // CORS is a BROWSER-side gate against "another site rides the user's credentials" (CSRF); it is NOT
  // an access-control mechanism for this API. That gate is moot here because authentication is Bearer
  // tokens held in JS and sent via the Authorization header (see AuthInterceptor) — a cross-origin
  // attacker page can neither read those tokens nor forge the header, and the Authorization header
  // itself crosses origins fine via Access-Control-Allow-Headers (which @fastify/cors allows by
  // default). No `credentials: true` is needed for Bearer auth.
  //
  // The only cookie the API sets is the httpOnly media_token, and it is `SameSite=Strict`
  // (access-token.validator.ts) — so it NEVER travels on a cross-origin request regardless of the
  // credentials flag. Media therefore authenticates one of two ways, neither credentialed-CORS:
  //   - same-origin web deploy (single-image): CORS doesn't apply at all;
  //   - Tauri/Android: the media:// Rust proxy injects a Bearer header.
  // So `credentials: true` would be dead config that only broadens the credentialed-CORS surface for
  // no benefit — it is left off.
  //
  // Revisit if a `SameSite=None` cookie or cookie-session auth is ever introduced: that would create a
  // real cross-origin credential surface and warrant both `credentials: true` AND an explicit Origin
  // allowlist. The former ALLOWED_ORIGINS env + dev/prod split was removed because the split's prod
  // branch (origin:false) was exactly what broke cross-origin Tauri/Android clients.
  app.enableCors({ origin: true });

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
  // before Swagger createDocument so doc paths include it). The interactive docs mount at
  // /api/v1/docs in non-production only — see the gate below. .well-known/soms is excluded — it must
  // be served at the bare path per RFC 8615 (peers fetch it without knowing our /api/v1 prefix).
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: '.well-known/soms', method: RequestMethod.GET }],
  });

  // Interactive API docs (Swagger UI at /api/v1/docs, spec at /api/v1/docs-json). The UI is a
  // live "try-it-now" console, so it is NOT mounted in production by default — it would let anyone
  // probe the API surface from the public internet. Dev and staging keep it; an operator can opt a
  // specific prod instance back in with SWAGGER_ENABLED=true (e.g. behind a protected reverse proxy).
  // The web client's `gen:api` script runs against the dev server, so API-type generation is unaffected.
  const swaggerEnabled =
    process.env.NODE_ENV !== 'production' || process.env.SWAGGER_ENABLED === 'true';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Simple Open Chat API')
      .setDescription('Third-party IM integration API (P1a contract layer)')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/v1/docs', app, document);
  }

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
  const uploadsDir = join(process.cwd(), 'data', 'uploads');
  // @fastify/static throws at registration if root is missing; ensure it exists (matches the
  // lazy mkdir UploadService.ensureDir already does for the write path).
  mkdirSync(uploadsDir, { recursive: true });

  // Auth-gate /uploads/*: native <img src="/uploads/..."> and <a download> requests can't carry
  // the Authorization header, so the access token is also placed in an httpOnly `media_token`
  // cookie by the auth endpoints. Validate it here with the SAME AccessTokenValidator the API
  // JwtStrategy uses — a revoked token (logout / password change / session invalidate) therefore
  // loses media access too. Registered on the root instance as a global preHandler; Fastify
  // propagates parent hooks into the @fastify/static child context that owns the /uploads/ route.
  const bearerAuth = app.get(BearerAuthService);
  const mediaAccess = app.get(MediaAccessService);
  adapter.getInstance().addHook(
    'preHandler',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.url.startsWith('/uploads/')) return; // only the media mount is gated
      // Native <img>/<a download> can't send Authorization → they ride the httpOnly media_token
      // cookie (same-origin browser path). Cross-origin clients (the Tauri media proxy, any
      // native client) can't use that cookie — SameSite=Strict suppresses it cross-origin — so
      // also accept a Bearer header. BearerAuthService accepts an access JWT OR a session token, so
      // the API and media surfaces enforce identical auth (and revocation) rules.
      const raw = request.cookies?.[MEDIA_TOKEN_COOKIE] ?? extractBearer(request.headers.authorization);
      const principal = raw ? await bearerAuth.resolve(raw, { ip: request.ip }) : null;
      if (!principal) {
        return reply.code(401).type('application/json').send({
          statusCode: 401,
          code: BusinessCode.UNAUTHENTICATED,
          message: 'unauthenticated',
          data: null,
        });
      }
      request.user = { userId: principal.userId, sessionId: principal.sessionId };

      // Per-object authorization — chat media ONLY. A CAS shard URL (/uploads/shards/…/<sha256>.<ext>)
      // embeds the digest, so a logged-in user could otherwise read any other user's/group's media by
      // guessing/leaking the URL. Require an active thread membership for the digest. Avatars
      // (/uploads/avatars/*) and legacy-flat files match neither the shard shape nor any MediaMessage
      // row → they stay auth-n-only (avatars must render cross-thread; legacy is natural attrition).
      const shard = SHARD_DIGEST_GATE_RE.exec(request.url);
      if (shard) {
        const allowed = await mediaAccess.canReadDigest(principal.userId, shard[1]);
        if (!allowed) {
          return reply.code(403).type('application/json').send({
            statusCode: 403,
            code: BusinessCode.FORBIDDEN,
            message: 'forbidden',
            data: null,
          });
        }
      }
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

  // Frontend static serving (web + admin SPA) moved to Caddy — it serves the built dist via
  // file_server + try_files SPA fallback in the generated Caddyfile (see docker/init.sh). Fastify is
  // API-only here (/api/* routes) plus the auth-gated /uploads registered above. (Previously @fastify/static
  // also mounted the frontend here, registering a not-found handler Fastify rejected as "already set".)
}
