import { Inject, Injectable, Optional } from '@nestjs/common';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { SERVER_VERSION } from '../common/version.js';
import { deriveOrigin } from '../common/origin.js';
import { PUBLIC_CONFIG } from '../config/public-config.js';
import { ShellCompatDto, ShellWebManifestDto } from './shell.dto.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * Injection token for the on-disk shell-artifacts dir. Production value is `cwd/shell-bundle` (provided
 * by `ShellModule` — a READ-ONLY, image-bound dir the Dockerfile bakes at /app/shell-bundle, deliberately
 * OUTSIDE the bind-mounted /app/data volume so an operator can never mutate the integrity-checked bundle).
 * The e2e harness overrides this token with a temp dir so the manifest/bundle routes can be exercised
 * hermetically, without touching the image's real bundle or assuming any fixture exists on the dev machine.
 */
export const SHELL_DIR = 'SHELL_DIR';

/**
 * Shell dynamic-update surface: the Tauri shell (which ships WITHOUT the main web SPA bundled)
 * reaches this service at first run / reconfigure / launch-update to (1) check shell↔server
 * compatibility, (2) fetch the bundle manifest (sha256), and (3) stream the
 * integrity-verified web tarball it installs locally. All three routes are `@Public()` — they run
 * before the shell has any session (it hasn't chosen a server / logged in yet).
 *
 * The on-disk artifacts live in `shell-bundle/` — READ-ONLY and image-bound: baked into the image at
 * /app/shell-bundle by the Dockerfile packaging step (see `scripts/package-web-bundle.mjs`), deliberately
 * OUTSIDE the bind-mounted /app/data volume so the integrity-checked bundle is immutable per image and
 * can never drift into operator-writable runtime state:
 *   - `manifest.json`      → `{ webVersion, sha256 }` (bundle-only fields)
 *   - `soms-web-<ver>.tar.gz` → the SPA browser build, tar+gzip of `web/dist/web/browser`
 *
 * `downloadUrl` is NOT stored on disk — it is merged in at serve time from a fixed route path. The
 * shell owns version compatibility (a hard-coded `COMPAT_BACKEND_MAX` upper bound in its Cargo source),
 * so the server carries no shell floor and has nothing to merge for compat.
 */
@Injectable()
export class ShellService {
  /** `shell-bundle/` dir this service reads from (injected so the e2e harness can point it at a temp dir). */
  private readonly shellDir: string;
  private readonly manifestPath: string;

  /** mtime-revalidated cache of the parsed manifest — re-read only when the file changes on disk. */
  private cache: { mtimeMs: number; raw: RawManifest } | null = null;

  constructor(
    private readonly settings: SettingsService,
    @Optional() @Inject(SHELL_DIR) shellDir?: string,
  ) {
    // Falls back to the cwd/shell-bundle convention when instantiated without DI (the unit spec passes a
    // SettingsService stub; `ShellModule` injects the real providers in the running app). SettingsService is
    // @Global, so it resolves without ShellModule importing SettingsModule.
    this.shellDir = shellDir ?? join(process.cwd(), 'shell-bundle');
    this.manifestPath = join(this.shellDir, 'manifest.json');
  }

  /**
   * `GET /api/v1/shell/compat` — reports this server's version AND folds in the public login policy
   * (identical to `GET /api/v1/config`) so the shell learns the enabled login methods in the same
   * round-trip. The shell decides compatibility itself (it carries the upper bound); the server sets no
   * floor, so there is nothing else to compute here.
   */
  compat(): ShellCompatDto {
    const primaryDomain = process.env.SOMS_DOMAIN?.trim();
    const lanDomain = process.env.SOMS_LAN_DOMAIN?.trim();
    // Canonical client origins for the native shell's symmetric auto-fill: the user enters one domain, the
    // shell fills in the other from these. primaryOrigin always present (SOMS_DOMAIN is required at boot);
    // lanOrigin only when SOMS_LAN_DOMAIN is configured. Same backend on both. HTTPS-only (policy).
    // Firebase client config is folded in so the Android shell inits FirebaseApp from THIS response (no
    // separate /push/firebase-config round-trip) — the 4 fields when configured, else {configured:false}.
    const fb = this.settings.getFirebaseConfig();
    return {
      serverVersion: SERVER_VERSION,
      ...PUBLIC_CONFIG,
      ...(primaryDomain ? { primaryOrigin: deriveOrigin(primaryDomain) } : {}),
      ...(lanDomain ? { lanOrigin: deriveOrigin(lanDomain) } : {}),
      firebaseConfig: fb
        ? { configured: true, apiKey: fb.apiKey, projectId: fb.projectId, appId: fb.appId, gcmSenderId: fb.gcmSenderId }
        : { configured: false },
    };
  }

  /** `GET /api/v1/shell/web-manifest` — the bundle descriptor the shell integrity-verifies against. */
  manifest(): ShellWebManifestDto {
    const raw = this.readManifest();
    return {
      webVersion: raw.webVersion,
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
