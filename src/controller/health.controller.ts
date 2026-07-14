import { Public } from '../common/public.decorator.js';
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { SERVER_VERSION } from '../common/version.js';

/** Payload of GET /api/v1/health. */
export class HealthResponseDto {
  @ApiProperty({ example: 'ok', description: 'Liveness marker — always "ok" on a 200 response.' })
  status!: string;

  @ApiProperty({ example: '0.1.0', description: 'Server version (from package.json).' })
  version!: string;

  @ApiProperty({
    example: 1720000000000,
    description: 'Server time as unix epoch milliseconds (lets a client sanity-check clock skew too).',
  })
  time!: number;
}

/**
 * Public liveness probe.
 *
 * Distinct from the other two "is the server alive" surfaces in this codebase:
 *  - `GET /s2s/ping` (federation) is a SIGNED peer-to-peer reachability + mutual-key-validity check
 *    between trusted servers — it proves identity, not just uptime.
 *  - The SSE `event: ping` heartbeat only fires on an already-established, AUTHENTICATED stream.
 *
 * `/health` is the one probe an UNAUTHENTICATED client can hit pre-login — notably the bundled Tauri /
 * Android "Server settings" page, which must let the user verify "this URL really is a SOMS backend I
 * can reach" BEFORE committing the origin or typing credentials. The body's `code: 0` + `version` is
 * the handshake: a 200 from a random non-SOMS HTTP server (e.g. a misconfigured reverse proxy's
 * welcome page) won't carry our envelope, so the client can tell "reachable but not SOMS" from
 * "reachable and correct".
 *
 * Never rate-limited: a liveness/reachability probe must return 200 whenever the process is
 * responsive, so a 429 here would make an orchestrator (Docker HEALTHCHECK) restart a perfectly
 * healthy container. The handler is zero-I/O — `SERVER_VERSION` is cached at module load, `time` is
 * `Date.now()` — so there is no load to protect and no per-probe counter cost. External flood
 * protection, if ever required, belongs at the Caddy edge (keyed on the real client IP), not an
 * in-process shared counter. No auth guard.
 */
@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  @Get('health')
  @ApiOperation({
    summary: 'Public liveness probe (unauthenticated): status, version, server time.',
  })
  health(): ApiResult<HealthResponseDto> {
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { status: 'ok', version: SERVER_VERSION, time: Date.now() },
    };
  }
}
