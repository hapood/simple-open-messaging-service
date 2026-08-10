import { Public } from '../common/public.decorator.js';
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { SERVER_VERSION } from '../common/version.js';
import { DatabaseService } from '../database/database.service.js';

/**
 * Fail-fast ceiling for the `SELECT 1` reachability probe. Stays under Docker HEALTHCHECK's 5s
 * `--timeout` so a hanging DB still returns a 200 (with `database: "down"`) in time to keep the
 * container healthy — liveness must never restart on a dependency blip.
 */
const DB_PROBE_TIMEOUT_MS = 3000;

/** Payload of GET /api/v1/health. */
export class HealthResponseDto {
  @ApiProperty({
    example: 'ok',
    description: 'Liveness marker — always "ok" on a 200 response.',
  })
  status!: string;

  @ApiProperty({
    example: 'up',
    description:
      'Database reachability as seen by this process ("up" | "down"). Probed once per call via a fail-fast SELECT 1. Reported as data only — the HTTP status stays 200 either way, so an orchestrator never restarts on a DB blip; monitoring alerts on "down".',
  })
  database!: 'up' | 'down';

  @ApiProperty({
    example: '0.1.0',
    description: 'Server version (from package.json).',
  })
  version!: string;

  @ApiProperty({
    example: 1720000000000,
    description:
      'Server time as unix epoch milliseconds (lets a client sanity-check clock skew too).',
  })
  time!: number;
}

/**
 * Public liveness probe.
 *
 * Distinct from the other two "is the server alive" surfaces in this codebase:
 *  - nonce-bound `GET /s2s/v1/identity` is the signed federation continuity/recovery check
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
 * HTTP 200 is returned UNCONDITIONALLY — even when the database is unreachable — so an orchestrator
 * (Docker HEALTHCHECK) never restarts a perfectly-live process over a transient dependency blip. DB
 * reachability is still surfaced, as data: `data.database` is `"up"` when a fail-fast `SELECT 1`
 * succeeds within `DB_PROBE_TIMEOUT_MS`, and `"down"` otherwise (failure OR timeout). Monitoring
 * alerts on `database === "down"`; the orchestrator restarts only on a wedged process (a non-200
 * here), never on a DB hiccup. A k8s-style liveness/readiness split is deliberately NOT used: SOMS is
 * single-instance by decision, so there is no load balancer to reroute traffic away on a readiness
 * failure — a separate 503 probe would drive zero action.
 *
 * Never rate-limited: a liveness/reachability probe must return 200 whenever the process is responsive,
 * so a 429 here would make an orchestrator restart a perfectly healthy container. One cheap `SELECT 1`
 * per Docker 30s probe plus occasional pre-login hits is negligible DB load; external flood protection,
 * if ever required, belongs at the Caddy edge (keyed on the real client IP), not an in-process shared
 * counter. No auth guard.
 */
@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('health')
  @ApiOperation({
    summary:
      'Public liveness probe (unauthenticated): status, DB reachability, version, server time.',
  })
  async health(): Promise<HealthResponseDto> {
    return {
      status: 'ok',
      database: await this.probeDatabase(),
      version: SERVER_VERSION,
      time: Date.now(),
    };
  }

  /** `SELECT 1` under a fail-fast timeout. Never throws — any error or timeout resolves to `"down"`. */
  private async probeDatabase(): Promise<'up' | 'down'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.database.db.execute(sql`SELECT 1`),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('database probe timed out')),
            DB_PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
