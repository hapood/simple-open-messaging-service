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
/**
 * The Firebase client config folded into {@link ShellCompatDto} for the Android shell's runtime FirebaseApp
 * init (the APK ships WITHOUT google-services.json; each server publishes its own here so the shell inits
 * FirebaseApp at runtime — replacing a separate /push/firebase-config round-trip). The 4 fields are present
 * only when configured; otherwise just `{configured:false}`. All 4 are public identifiers, safe to serve
 * unauthenticated (see src/settings/firebase.ts).
 */
export class ShellFirebaseConfigDto {
  @ApiProperty({
    description:
      'Whether a valid google-services.json is configured on this server.',
  })
  configured!: boolean;

  @ApiProperty({
    required: false,
    description:
      'client[].api_key[0].current_key. Present only when configured.',
  })
  apiKey?: string;

  @ApiProperty({
    required: false,
    description: 'project_info.project_id. Present only when configured.',
  })
  projectId?: string;

  @ApiProperty({
    required: false,
    description:
      'client[].client_info.mobilesdk_app_id. Present only when configured.',
  })
  appId?: string;

  @ApiProperty({
    required: false,
    description:
      'project_info.project_number (FCM/GCM sender ID). Present only when configured.',
  })
  gcmSenderId?: string;
}

export class ShellCompatDto {
  @ApiProperty({
    example: '0.1.0',
    description: 'The server version (root package.json, same as /health).',
  })
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
    description:
      'Which login methods are enabled (see LoginMode). Mirrors GET /api/v1/config.',
  })
  loginMode!: LoginMode;

  @ApiProperty({
    example: 'https://soms.example.com:7667',
    required: false,
    description:
      'Canonical client origin (scheme+host[:port]) for SOMS_WEB_DOMAIN, falling back to SOMS_DOMAIN. The native shell uses this + lanOrigin for symmetric auto-fill: the user enters one domain, the shell fills in the other from these and confirms via a modal. Same backend as lanOrigin.',
  })
  primaryOrigin?: string;

  @ApiProperty({
    example: 'https://soms-lan.example.com:7667',
    required: false,
    description:
      'Canonical client origin for SOMS_LAN_DOMAIN (the LAN fallback). Same backend as primaryOrigin. Omitted when SOMS_LAN_DOMAIN is not configured. Auto-fill/display only — the user explicitly confirms before the shell trusts it as a connection target; HTTPS-only.',
  })
  lanOrigin?: string;

  @ApiProperty({
    description:
      'Firebase client config for Android FCM runtime init. The native shell (APK ships without google-services.json) inits FirebaseApp from this at runtime — folded in so the shell gets it in the same compat round-trip (replaces a separate /push/firebase-config). {configured:false} when the server has no valid google-services.json.',
  })
  firebaseConfig!: ShellFirebaseConfigDto;
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
  @ApiProperty({
    example: '0.1.0',
    description:
      'The web SPA version this bundle contains (web/package.json). Display + filename only.',
  })
  webVersion!: string;

  @ApiProperty({
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    description:
      'Hex SHA-256 of the bundle bytes. The shell recomputes this over the downloaded bytes and MUST match before extracting; it also compares this against the persisted installed hash to detect updates.',
  })
  sha256!: string;

  @ApiProperty({
    example: '/api/v1/shell/web-bundle',
    description:
      'Relative URL of the bundle download (streamed application/gzip tarball).',
  })
  downloadUrl!: string;
}
