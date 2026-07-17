import { Inject, Injectable, Optional } from '@nestjs/common';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { SERVER_VERSION } from '../common/version.js';
import { SHELL_COMPAT, semverGte } from '../config/shell-compat.js';
import { ShellCompatDto, ShellWebManifestDto } from './shell.dto.js';

/**
 * Injection token for the on-disk shell-artifacts dir. Production value is `cwd/data/shell` (provided
 * by `ShellModule` — the dir the Dockerfile signing step bakes, same convention as `data/uploads`). The
 * e2e harness overrides this token with a temp dir so the manifest/bundle routes can be exercised
 * hermetically, without touching the repo's real `data/shell` (which may hold a signed bundle from a
 * prior image build) or assuming any fixture exists on the dev machine.
 */
export const SHELL_DIR = 'SHELL_DIR';

/**
 * Shell dynamic-update surface: the Tauri shell (which ships WITHOUT the main web SPA bundled)
 * reaches this service at first run / reconfigure / launch-update to (1) check shell↔server
 * compatibility, (2) fetch the bundle manifest (sha256), and (3) stream the
 * integrity-verified web tarball it installs locally. All three routes are `@Public()` — they run
 * before the shell has any session (it hasn't chosen a server / logged in yet).
 *
 * The on-disk artifacts live in `data/shell/` (writable runtime dir, baked into the image by the
 * Dockerfile packaging step — see `scripts/package-web-bundle.mjs`):
 *   - `manifest.json`      → `{ webVersion, sha256 }` (bundle-only fields)
 *   - `soms-web-<ver>.tar.gz` → the SPA browser build, tar+gzip of `web/dist/web/browser`
 *
 * `minShellVersion` + `downloadUrl` are NOT stored on disk — they are merged in from `SHELL_COMPAT`
 * (single source of truth, shared with the compat endpoint) and a fixed route path, so the manifest
 * can never drift from the compat decision.
 */
@Injectable()
export class ShellService {
  /** `data/shell/` dir this service reads from (injected so the e2e harness can point it at a temp dir). */
  private readonly shellDir: string;
  private readonly manifestPath: string;

  /** mtime-revalidated cache of the parsed manifest — re-read only when the file changes on disk. */
  private cache: { mtimeMs: number; raw: RawManifest } | null = null;

  constructor(@Optional() @Inject(SHELL_DIR) shellDir?: string) {
    // Falls back to the cwd/data/shell convention when instantiated without DI (the unit spec calls
    // `new ShellService()`; `ShellModule` injects the real provider in the running app).
    this.shellDir = shellDir ?? join(process.cwd(), 'data', 'shell');
    this.manifestPath = join(this.shellDir, 'manifest.json');
  }

  /** `GET /api/v1/shell/compat` — is this shell version allowed to use this server + bundle? */
  compat(shellVersion: string | undefined): ShellCompatDto {
    const v = (shellVersion ?? '').trim();
    const min = SHELL_COMPAT.minShellVersion;
    const compatible = v !== '' && semverGte(v, min);
    return {
      compatible,
      serverVersion: SERVER_VERSION,
      minShellVersion: min,
      messageKey: compatible ? null : SHELL_COMPAT.messageKey,
    };
  }

  /** `GET /api/v1/shell/web-manifest` — the bundle descriptor the shell integrity-verifies against. */
  manifest(): ShellWebManifestDto {
    const raw = this.readManifest();
    return {
      webVersion: raw.webVersion,
      minShellVersion: SHELL_COMPAT.minShellVersion,
      sha256: raw.sha256,
      downloadUrl: '/api/v1/shell/web-bundle',
    };
  }

  /**
   * `GET /api/v1/shell/web-bundle` — the streamed tarball. Returns the absolute path so the
   * controller can `reply.send(createReadStream(path))` (binary; bypasses the ApiResult envelope +
   * SerializeInterceptor via a manual `@Res()` send). Throws NOT_FOUND if the manifest or the
   * tarball is absent (backend built without the signing step, or a partial deploy).
   */
  bundlePath(): string {
    const raw = this.readManifest();
    const path = join(this.shellDir, `soms-web-${raw.webVersion}.tar.gz`);
    try {
      statSync(path);
    } catch {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'web bundle not found', 404);
    }
    return path;
  }

  /** Stream helper exposed for the controller (keeps the createReadStream import in one place). */
  bundleStream(path: string): NodeJS.ReadableStream {
    return createReadStream(path);
  }

  /** Read + parse `manifest.json`, re-reading only when its mtime changes. */
  private readManifest(): RawManifest {
    let st: { mtimeMs: number };
    try {
      st = statSync(this.manifestPath);
    } catch {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'shell manifest not found (bundle not published on this server)',
        404,
      );
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs) {
      return this.cache.raw;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8'));
    } catch {
      throw new BusinessException(BusinessCode.INTERNAL, 'shell manifest is unreadable', 500);
    }
    const raw = asRawManifest(parsed);
    this.cache = { mtimeMs: st.mtimeMs, raw };
    return raw;
  }
}

interface RawManifest {
  webVersion: string;
  sha256: string;
}

/** Validate the parsed JSON has the two required string fields; throw INTERNAL (500) otherwise. */
function asRawManifest(parsed: unknown): RawManifest {
  const p = parsed as Record<string, unknown>;
  if (typeof p?.webVersion === 'string' && typeof p?.sha256 === 'string') {
    return { webVersion: p.webVersion, sha256: p.sha256 };
  }
  throw new BusinessException(BusinessCode.INTERNAL, 'shell manifest is malformed', 500);
}
