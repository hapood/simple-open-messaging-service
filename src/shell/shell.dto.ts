import { ApiProperty } from '@nestjs/swagger';
import { LoginMode } from '../config/public-config.js';

/**
 * Response of `GET /api/v1/shell/compat`. The shell decides compatibility itself: it carries a hard-coded
 * upper bound (`COMPAT_BACKEND_MAX` in the shell's Cargo source) and accepts this server iff
 * `serverVersion < COMPAT_BACKEND_MAX`. The server sets no shell floor, so it has nothing to compute or
 * gate on for compat.
 *
 * The response ALSO folds in the public login policy (`registrationOpen` + `loginMode`, identical to
 * `GET /api/v1/config`) so the Tauri shell — which hits `/shell/compat` first, before it has a session —
 * learns the enabled login methods in the SAME round-trip and never needs a separate `/config` call. The
 * browser build (served by Caddy, never calls `/shell/*`) keeps using `/config`.
 */
export class ShellCompatDto {
  @ApiProperty({ example: '0.1.0', description: 'The server version (root package.json, same as /health).' })
  serverVersion!: string;

  @ApiProperty({
    example: false,
    description:
      'Whether end-user self-registration is open. Mirrors GET /api/v1/config; folded in so the shell gets the login policy with the version in one call.',
  })
  registrationOpen!: boolean;

  @ApiProperty({
    enum: LoginMode,
    enumName: 'LoginMode',
    example: LoginMode.APP_OTP_AND_QR,
    description: 'Which login methods are enabled (see LoginMode). Mirrors GET /api/v1/config.',
  })
  loginMode!: LoginMode;
}

/**
 * Response of `GET /api/v1/shell/web-manifest`. Describes the current downloadable web bundle so the
 * shell can integrity-verify it BEFORE executing a byte: it recomputes the bundle's SHA-256 and refuses
 * to install on mismatch. Transport integrity + authenticity come from TLS (https origins); the SHA-256
 * catches transport corruption, partial downloads, and manifest/bundle version drift. IP/http origins
 * are not guaranteed secure by policy.
 *
 * The shell uses `sha256` for BOTH install-time integrity AND update detection (installed-hash on disk
 * vs. this value); `webVersion` is for display/naming only, never compared. On-disk
 * `shell-bundle/manifest.json` stores only `{ webVersion, sha256 }`; `downloadUrl` is merged in here
 * from a fixed route path.
 */
export class ShellWebManifestDto {
  @ApiProperty({ example: '0.1.0', description: 'The web SPA version this bundle contains (web/package.json). Display + filename only.' })
  webVersion!: string;

  @ApiProperty({
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    description: 'Hex SHA-256 of the bundle bytes. The shell recomputes this over the downloaded bytes and MUST match before extracting; it also compares this against the persisted installed hash to detect updates.',
  })
  sha256!: string;

  @ApiProperty({
    example: '/api/v1/shell/web-bundle',
    description: 'Relative URL of the bundle download (streamed application/gzip tarball).',
  })
  downloadUrl!: string;
}
