import { ApiProperty } from '@nestjs/swagger';

/**
 * Response of `GET /api/v1/shell/compat?version=<shellVersion>`. The Tauri shell calls this BEFORE
 * downloading the web bundle to decide whether its build can talk to this server. `compatible ===
 * false` → the shell shows an "upgrade the app" message and refuses to proceed (no bundle download).
 */
export class ShellCompatDto {
  @ApiProperty({ example: true, description: 'Whether the caller shell version can use this server + bundle.' })
  compatible!: boolean;

  @ApiProperty({ example: '0.0.1', description: 'The server version (root package.json, same as /health).' })
  serverVersion!: string;

  @ApiProperty({
    example: '0.1.0',
    description: 'Minimum shell (Cargo/tauri.conf.json) version this server supports. Caller is compatible iff its version >= this.',
  })
  minShellVersion!: string;

  @ApiProperty({
    required: false,
    nullable: true,
    example: 'shell.incompatible',
    description: 'Optional i18n key the shell shows when compatible === false (null → shell default copy).',
  })
  messageKey?: string | null;
}

/**
 * Response of `GET /api/v1/shell/web-manifest`. Describes the current downloadable web bundle so the
 * shell can integrity-verify it BEFORE executing a byte: the bundle is signature-verified against a
 * public key pinned in the shell (mandatory — downloading + executing web is an RCE surface, and for
 * IP/http origins the signature is the only integrity guarantee since TLS is skipped).
 *
 * On-disk `data/shell/manifest.json` stores only `{ webVersion, sha256, signature }`; `minShellVersion`
 * + `downloadUrl` are merged in here from `SHELL_COMPAT` (single source of truth) so they can never
 * drift from the compat endpoint.
 */
export class ShellWebManifestDto {
  @ApiProperty({ example: '0.1.0', description: 'The web SPA version this bundle contains (web/package.json).' })
  webVersion!: string;

  @ApiProperty({
    example: '0.1.0',
    description: 'Minimum shell version this bundle requires. Caller refuses a bundle built for a newer shell.',
  })
  minShellVersion!: string;

  @ApiProperty({
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    description: 'Hex SHA-256 of the bundle bytes. The shell recomputes this over the downloaded bytes and MUST match before extracting.',
  })
  sha256!: string;

  @ApiProperty({
    description: 'Base64 Ed25519 signature over the bundle bytes, verified against the pubkey pinned in the shell.',
  })
  signature!: string;

  @ApiProperty({
    example: '/api/v1/shell/web-bundle',
    description: 'Relative URL of the bundle download (streamed application/gzip tarball).',
  })
  downloadUrl!: string;
}
