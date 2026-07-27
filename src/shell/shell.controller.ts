import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { Throttle, ThrottleGuard } from '../auth/throttle.guard.js';
import { ShellService } from './shell.service.js';
import { ShellCompatDto, ShellWebManifestDto } from './shell.dto.js';

/**
 * Shell dynamic-update endpoints — the unauthenticated surface the Tauri shell reaches BEFORE it has
 * a session (it points itself at a server, verifies compatibility + TLS, downloads + sha256-verifies
 * the web bundle, installs it locally, then loads it). All routes are `@Public()` (no SessionAuthGuard)
 * and sit under the existing `/api/v1` global prefix, so Caddy's `/api/*` reverse proxy serves them
 * unchanged — no `docker/init.sh` change.
 *
 * The bundle route streams raw `application/gzip` bytes: it uses `@Res()` (NOT passthrough) + a manual
 * `reply.send(stream)`, which bypasses the global `SerializeInterceptor` (that interceptor only
 * recursively walks plain object payloads; a manually-sent binary stream is never handed to it).
 *
 * Rate-limiting: every route is `@Public()`, so they are an unauthenticated bandwidth / amplification
 * surface (anyone can pull the bundle repeatedly). `ThrottleGuard` is applied at the class level (its
 * deps — `KvStoreService` is `@Global`, `Reflector` is core — are resolvable from `AppModule` exactly
 * as they are for `MessageController`'s existing `@UseGuards(ThrottleGuard)`), and each method carries
 * its own `@Throttle(limit, 60s)` ceiling. The guard keys on `req.ip`+`req.url`; on exceed it throws
 * `HttpException(429)` → `AllExceptionsFilter` → HTTP 429 + `RATE_LIMITED(10005)`.
 */
@ApiTags('shell')
@Public()
@UseGuards(ThrottleGuard)
@Controller('shell')
export class ShellController {
  constructor(private readonly shell: ShellService) {}

  @Get('compat')
  @Throttle(30, 60) // tiny JSON; 30/min/IP covers wizard back-and-forth + multiple devices behind a NAT
  @ApiOperation({
    summary:
      'Reports this server version AND the public login policy (registrationOpen + loginMode). The shell owns compatibility (a hard-coded backend-version upper bound) and decides itself; the server sets no shell floor. The login policy is folded in so the shell gets it in the same round-trip (mirrors GET /api/v1/config).',
  })
  compat(): ApiResult<ShellCompatDto> {
    return { code: BusinessCode.OK, message: 'successful', data: this.shell.compat() };
  }

  @Get('web-manifest')
  @Throttle(30, 60) // tiny JSON; 30/min/IP
  @ApiOperation({
    summary:
      'The current web-bundle descriptor (version + sha256). The shell recomputes the downloaded bytes sha256 and refuses to install on mismatch.',
  })
  manifest(): ApiResult<ShellWebManifestDto> {
    return { code: BusinessCode.OK, message: 'successful', data: this.shell.manifest() };
  }

  @Raw()
  @Get('web-bundle')
  @Throttle(10, 60) // the MB-scale download: 10/min/IP is the bandwidth-amplification ceiling
  @ApiOperation({
    summary:
      'Streamed application/gzip tarball of the web SPA browser build. NOT enveloped in ApiResult (raw bytes).',
  })
  bundle(@Res() reply: FastifyReply): void {
    const path = this.shell.bundlePath();
    const version = this.shell.manifest().webVersion;
    reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="soms-web-${version}.tar.gz"`)
      .header('x-content-type-options', 'nosniff')
      .send(this.shell.bundleStream(path));
  }
}
