/**
 * Shell ↔ server compatibility policy for the Tauri shell dynamic-update flow.
 *
 * The Tauri shell ships WITHOUT the main web SPA bundled; on first run (and on reconfigure) it asks
 * the server `GET /api/v1/shell/compat?version=<shellVersion>` whether this shell build can talk to
 * this server before it downloads + signature-verifies the web bundle (`GET /api/v1/shell/web-manifest`
 * + `/api/v1/shell/web-bundle`). `minShellVersion` is the floor: a shell older than this is rejected
 * (its IPC contract / init protocol predates the server's), so an obsolete shell surfaces a clear
 * "upgrade the app" message instead of a cryptic download/runtime failure.
 *
 * This is a CONST, not a `SystemSetting`: it moves at deploy cadence (tied to the bundle the same
 * image ships), not at operator whim — flipping it at runtime would let an admin orphan every
 * installed shell in the field. Same rationale + pattern as `SERVER_VERSION`
 * (`src/common/version.ts`) and `PUBLIC_CONFIG` (`src/config/public-config.ts`).
 *
 * `minShellVersion` is ALSO stamped into the web-bundle manifest served by `ShellService`, so the
 * single source of truth (this const) reaches both the compat decision and the manifest the client
 * reads — there is no second minShellVersion to drift.
 */
export const SHELL_COMPAT = {
  /** Lowest shell (Cargo/tauri.conf.json) version this server + bundle support. Semver `MAJOR.MINOR.PATCH`. */
  minShellVersion: '0.1.0',
  /** Optional i18n key the shell shows when `compatible === false` (null → shell uses its own default copy). */
  messageKey: null as string | null,
};

/**
 * Compare two `MAJOR.MINOR.PATCH` version strings. Returns a negative/zero/positive number like a
 * classic comparator (so `gte(a, b) === compare(a, b) >= 0`). Prerelease/build metadata are ignored:
 * every shell and web version this project ships is a clean triplet, and the compare is only ever
 * `shellVersion >= minShellVersion`. Hand-rolled rather than pulling the `semver` package so the
 * server build stays self-contained for a compare over two project-controlled triplets.
 */
export function compareSemver(a: string, b: string): number {
  const pa = (a || '0').split('.');
  const pb = (b || '0').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    // Strip any prerelease/build suffix (`-rc.1`, `+build`) from the numeric segment.
    const na = parseInt((pa[i] ?? '0').replace(/[^0-9].*$/, ''), 10) || 0;
    const nb = parseInt((pb[i] ?? '0').replace(/[^0-9].*$/, ''), 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** `a >= b` over `MAJOR.MINOR.PATCH` triplets. */
export function semverGte(a: string, b: string): boolean {
  return compareSemver(a, b) >= 0;
}
