import { execSync } from 'node:child_process';
import { fork, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import sharp from 'sharp';
import { openSealedBox } from '../src/federation/sealed-box.js';
import type { RootKeyEntry } from '../src/federation/federation-certificate.js';
import { databaseSchema } from '../src/database/database-schema.js';
import type { Database } from '../src/database/database.service.js';
import { DiscoveryService } from '../src/federation/discovery.service.js';
import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../src/federation/federation-history-access-setting.js';
import { signingCertificateStatement } from '../src/federation/federation-certificate.js';
import { startS2sProxy, type S2sProxy } from './federation-proxy.js';
import { ensureDatabase } from './database.js';
import { e2eWorkerDatabaseName } from './e2e-database-names.js';

export type { S2sProxy };

/**
 * Federation e2e harness — boots TWO full SOMS apps in SEPARATE Node processes (appA=aaa.test on DB
 * _a, appB=bbb.test on DB _b), making real signed HTTP requests to each other over loopback. Each app
 * is a child process running the COMPILED entry (`ensureCompiledEntry` → tsc → `.e2e-build/`).
 *
 * Why separate processes (not two AppModule instances in one process, as before): a single Node process
 * shares process-global singletons — Passport's `local` strategy is registered globally, so appB's
 * registration overwrote appA's and appA's `/auth/login` was served by appB's AuthService. The old
 * shared-DB harness masked this (both apps read the same users). Separate processes give each app its
 * own V8 isolate (isolated global state) AND its own database — true cross-server isolation. Any failure
 * now is a real bug, not a test artifact.
 *
 * Why COMPILED (not tsx/ts-node): the entry is a Nest app, whose DI needs `design:paramtypes` decorator
 * metadata. esbuild (tsx) does NOT emit it → "Nest can't resolve dependencies". ts-node doesn't resolve
 * this project's `.js`-suffix ESM imports. tsc emits the metadata AND produces `.js` files matching those
 * imports, so `node` runs the compiled entry cleanly (the Fed↔Buffer forwardRef cycle that used to ESM-TDZ
 * at boot is now broken — one-way Fed→Buffer).
 *
 * Loopback without /etc/hosts/SRV/stubbing: TestDiscoveryService maps each peer domain to the other
 * app's `http://127.0.0.1:<port>` via resolveBase. Both ports are known up front (passed to both
 * subprocesses), so each app's map is complete. The signing @authority (127.0.0.1:<port>) matches what
 * the receiving Fastify sees → signatures verify end-to-end.
 *
 * DUAL-DATABASE INVARIANT (enforced): appA/appB MUST be on separate databases — a group's
 * fedGroupAccount is @unique per DB; a shared DB aliases appB's mirror to appA's origin thread.
 * assertSeparateDatabases throws at boot if they share one.
 */

/** The canonical federation-test domains (single source — the spec imports these). */
export const FED_DOMAIN_A = 'aaa.test';
export const FED_DOMAIN_B = 'bbb.test';

/** Path to the COMPILED subprocess entry (see ensureCompiledEntry — why it's compiled, not run via tsx). */
const APP_MAIN = join(
  process.cwd(),
  '.e2e-build',
  'test',
  'federation-app.main.js',
);

/** Compile the subprocess entry + its deps to .e2e-build/ via tsc, IF missing or stale. Staleness is
 *  gated (any relevant source newer than the build → recompile) so the ~10s compile runs only when needed. */
export function ensureCompiledEntry(): void {
  const _sources =
    'src test/federation-app.main.ts test/federation-harness.ts test/federation-proxy.ts test/federation-test-helpers.ts tsconfig.json tsconfig.e2e.json';
  const fresh =
    'test -f "${APP_MAIN}" && test -z "$(find ${sources} -newer "${APP_MAIN}" 2>/dev/null)"';
  try {
    execSync(fresh, { stdio: 'ignore' });
    return; // up-to-date — skip the compile
  } catch {
    // missing or stale → (re)compile below
  }
  // Workers can both observe staleness at once (e.g. sources edited mid-run)
  // and would then race two tsc processes over the same .e2e-build outputs,
  // failing each other. Serialize on a lock file and re-check freshness under
  // the lock so a worker queued behind the winner skips its own compile.
  execSync(
    `mkdir -p .e2e-build && flock -w 600 .e2e-build/.compile.lock sh -c '${fresh} || npx tsc -p tsconfig.e2e.json'`,
    { stdio: 'inherit' },
  );
}

/** A duck-typed KeypairService held entirely in memory — no file I/O, distinct keys per app. */
export interface InMemoryKeypair {
  assertAvailable(): void;
  getStatus(): { available: true };
  getKeyId(): string;
  getPrivateKey(): Uint8Array;
  getPublicKeyB64(): string;
  getRootPublicKeyB64(): string;
  getSigningKeyCertificates(): Array<{
    keyId: string;
    ed25519: string;
    notBefore: number;
    notAfter: number;
    authorizationSignature: string;
  }>;
  getIdentityEpoch(): number;
  getIdentityDomain(): string;
  /** The wire address of a subject in this publisher's local namespace (keypair.service.ts). */
  localAddress(account: string): { account: string; domain: string };
  getRootKeyFingerprint(): string;
  waitUntilInitialized(): Promise<void>;
  getRootGroup(): RootKeyEntry[];
  getCreatedAt(): number;
  getRetainedPrivateKey(publicKeyB64: string): Uint8Array | null;
  isRetainedPublicKey(publicKeyB64: string): boolean;
  openCardChallenge(publicKey: string, challenge: string): string;
}

export function makeInMemoryKeypair(domain: string): InMemoryKeypair {
  // Stable per test domain: restarting a subprocess models a normal process restart that reloads the
  // same on-disk identity, not catastrophic key loss. Distinct domains still receive distinct keys.
  const rootPrivateKey = createHash('sha256')
    .update(`soms-federation-e2e-root-key:${domain}`, 'utf8')
    .digest();
  const rootPublicKey = ed25519.getPublicKey(rootPrivateKey);
  const rootPublicKeyB64 = Buffer.from(rootPublicKey).toString('base64');
  const signingPrivateKey = createHash('sha256')
    .update(`soms-federation-e2e-signing-key:${domain}`, 'utf8')
    .digest();
  const signingPublicKey = ed25519.getPublicKey(signingPrivateKey);
  const signingPublicKeyB64 = Buffer.from(signingPublicKey).toString('base64');
  const rootKeyFingerprint = `sha256:${createHash('sha256')
    .update(rootPublicKey)
    .digest('base64url')}`;
  const rootGroup: RootKeyEntry[] = [
    {
      ed25519: rootPublicKeyB64,
      notBefore: 1_700_000_000_000,
      notAfter: 253_402_300_799_999,
    },
  ];
  const retainedKeys = new Map<string, Uint8Array>([
    [rootPublicKeyB64, rootPrivateKey],
    [signingPublicKeyB64, signingPrivateKey],
  ]);
  const unsignedCertificate = {
    keyId: `${domain}/key-1`,
    ed25519: signingPublicKeyB64,
    root: rootPublicKeyB64,
    notBefore: 1_700_000_000_000,
    notAfter: 253_402_300_799_999,
  };
  return {
    assertAvailable: () => undefined,
    getStatus: () => ({ available: true }),
    getKeyId: () => `${domain}/key-1`,
    getPrivateKey: () => signingPrivateKey,
    getPublicKeyB64: () => signingPublicKeyB64,
    getRootPublicKeyB64: () => rootPublicKeyB64,
    getSigningKeyCertificates: () => [
      {
        ...unsignedCertificate,
        authorizationSignature: Buffer.from(
          ed25519.sign(
            Buffer.from(signingCertificateStatement(unsignedCertificate)),
            rootPrivateKey,
          ),
        ).toString('base64'),
      },
    ],
    getIdentityEpoch: () => 1,
    getIdentityDomain: () => domain,
    localAddress: (account: string) => ({ account, domain }),
    getRootKeyFingerprint: () => rootKeyFingerprint,
    waitUntilInitialized: async () => undefined,
    getRootGroup: () => rootGroup.map((entry) => ({ ...entry })),
    getCreatedAt: () => unsignedCertificate.notBefore,
    getRetainedPrivateKey: (publicKeyB64: string) =>
      retainedKeys.get(publicKeyB64) ?? null,
    isRetainedPublicKey: (publicKeyB64: string) =>
      retainedKeys.has(publicKeyB64),
    openCardChallenge: (publicKey: string, challenge: string) => {
      const privateKey = retainedKeys.get(publicKey);
      if (!privateKey)
        throw new Error(
          `the supplied public key is not part of this server's retained key history`,
        );
      const opened = openSealedBox(
        Uint8Array.from(Buffer.from(challenge, 'base64')),
        privateKey,
      );
      if (!opened)
        throw new Error(
          'the card challenge does not open under the supplied key',
        );
      return Buffer.from(opened).toString('utf8');
    },
  };
}

/**
 * Generate a valid PNG (a solid `size`×`size` square of the given red channel) that round-trips
 * through the avatar decoder and validation pipeline. Hand-written base64 PNGs are risky because a
 * corrupt header is rejected during metadata validation.
 * `red` varies the bytes so two uploads produce distinct files (for the re-pull test).
 */
export async function makePng(
  red: number,
  size = 16,
  noisy = false,
): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    raw[i * 4] = noisy ? (red + i * 31) % 256 : red;
    if (noisy) raw[i * 4 + 1] = (red + i * 67) % 256;
    if (noisy) raw[i * 4 + 2] = (red + i * 113) % 256;
    raw[i * 4 + 3] = 255; // alpha
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * DiscoveryService override for tests: resolveBase reads the static portMap. Every S2S endpoint derives
 * its URL from resolveBase, so overriding resolveBase alone routes all of them over loopback. The
 * portMap is set by the subprocess entry (from FED_PORT_A/B) — identical in both processes.
 */
export class TestDiscoveryService extends DiscoveryService {
  static portMap: Record<string, string> = {};

  override async resolveBase(domain: string): Promise<string> {
    const mapped = TestDiscoveryService.portMap[domain];
    if (mapped) return mapped;
    return super.resolveBase(domain);
  }
}

// ─── dual-DB setup ────────────────────────────────────────────────────────────

/** Derive the two per-app DB names from this fork's base fork DB (created by setup-env). */
function federationDbNames(): { a: string; b: string } {
  const poolId = process.env.VITEST_POOL_ID ?? '0';
  return {
    a: e2eWorkerDatabaseName(poolId, 'a'),
    b: e2eWorkerDatabaseName(poolId, 'b'),
  };
}

/** Resolve both per-app DBs prepared by global setup. Returns the two datasource URLs. */
export async function ensureFederationDbs(): Promise<{
  urlA: string;
  urlB: string;
}> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL missing — copy .env.example to .env and configure it.',
    );
  }
  const base = new URL(process.env.DATABASE_URL);
  const mkUrl = (db: string): string => {
    const u = new URL(base.toString());
    u.pathname = `/${db}`;
    return u.toString();
  };
  const { a, b } = federationDbNames();
  const urlA = mkUrl(a);
  const urlB = mkUrl(b);
  await ensureDatabase(base.toString(), a);
  await ensureDatabase(base.toString(), b);
  return { urlA, urlB };
}

// ─── free-port allocation (so the two subprocesses get distinct loopback ports) ────────────────

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

// ─── a booted federation app (subprocess + test-process Drizzle client) ──────────────────────

export interface FedApp {
  baseUrl: string;
  port: number;
  dataDir: string;
  database: Database;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Re-fork the subprocess on the SAME database + data root. `options.domain` boots it under a
   *  different SOMS_DOMAIN — the domain re-bind path: same persisted identity, new public name. */
  restart: (options?: { domain?: string }) => Promise<void>;
  close: () => Promise<void>;
}

interface FedAppConfig {
  domain: string;
  dbUrl: string;
  appPort: number;
  portA: number;
  portB: number;
  dataDir: string;
  /** Extra subprocess env (e.g. real-keypair/lifecycle overrides for the rotation e2e). */
  env?: Record<string, string>;
}

/** Boot one app in a subprocess. `start()` forks test/federation-app.main.ts (via tsx) with the app's
 *  env, awaits `FED_APP_READY <port>` on stdout, and exposes a test-process Drizzle client for assertions.
 *  `stop()` SIGTERMs the child (used by the degradation test to force a real ECONNREFUSED); `restart()`
 *  re-forks on the same port (used by the re-handshake test). */
function makeFedApp(cfg: FedAppConfig): FedApp {
  let currentDomain = cfg.domain;
  const pool = new Pool({ connectionString: cfg.dbUrl });
  const database = drizzle({ client: pool, schema: databaseSchema });
  let child: ChildProcess | null = null;
  let stopping = false;

  const start = async (): Promise<void> => {
    // Fixture users are inserted by the Vitest process and their password hashes therefore use its
    // pepper. Copy only that test secret into each otherwise-isolated node so the child can verify
    // those hashes. Real deployments generate a distinct pepper per independently writable data root.
    const parentDataDir =
      process.env.SOMS_DATA_DIR ?? join(process.cwd(), 'data');
    mkdirSync(cfg.dataDir, { recursive: true });
    copyFileSync(
      join(parentDataDir, 'password-pepper.key'),
      join(cfg.dataDir, 'password-pepper.key'),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SOMS_DOMAIN: currentDomain,
      DATABASE_URL: cfg.dbUrl,
      APP_PORT: String(cfg.appPort),
      FED_PORT_A: String(cfg.portA),
      FED_PORT_B: String(cfg.portB),
      SOMS_DATA_DIR: cfg.dataDir,
      LOG_DIR: join(cfg.dataDir, 'logs'),
      DATABASE_QUERY_LOG: '0',
      // Keep routine subprocess SQL/access logs out of the test reporter. Set FED_E2E_DEBUG=1 when
      // diagnosing a swallowed best-effort federation path to restore trace-level forwarding.
      LOG_LEVEL:
        process.env.FED_E2E_LOG_LEVEL ??
        (process.env.FED_E2E_DEBUG === '1' ? 'verbose' : 'warn'),
      ...cfg.env,
    };
    const startedChild = fork(APP_MAIN, {
      env,
      // fork() requires an IPC channel (the 4th stdio slot); we don't use it — readiness comes via
      // stdout, shutdown via SIGTERM — but the slot must be present. The entry is compiled JS (see
      // ensureCompiledEntry), so no tsx/ts-node loader — plain `node` runs it.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child = startedChild;
    stopping = false;
    let stdoutTail = '';
    let stderrTail = '';
    startedChild.stdout!.on('data', (d: Buffer) => {
      stdoutTail = (stdoutTail + d.toString()).slice(-2000);
      if (process.env.FED_E2E_DEBUG === '1') {
        process.stdout.write(`[${cfg.domain}] ${d}`);
      }
    });
    startedChild.stderr!.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
      if (process.env.FED_E2E_DEBUG === '1') {
        process.stderr.write(`[${cfg.domain}] ${d}`);
      }
    });
    startedChild.once('exit', (code, signal) => {
      if (child === startedChild) child = null;
      if (!stopping && (code !== 0 || signal !== null)) {
        console.error(
          `${cfg.domain}: federation test app exited unexpectedly ` +
            `(code=${String(code)}, signal=${String(signal)}).\n` +
            `stdout tail:\n${stdoutTail}\nstderr tail:\n${stderrTail}`,
        );
      }
    });
    await waitForReady(startedChild, cfg);
  };

  const stop = async (): Promise<void> => {
    const c = child;
    if (!c) return;
    stopping = true;
    child = null;
    const exited = new Promise<void>((resolve) => {
      c.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      // Allow bounded network requests and task finalization to drain before forcing exit.
      const timer = setTimeout(() => {
        console.warn(
          `${cfg.domain}: graceful shutdown exceeded 60s; forcing SIGKILL`,
        );
        c.kill('SIGKILL');
      }, 60_000);
      timer.unref();
    });
    c.kill('SIGTERM');
    await exited;
    stopping = false;
  };

  return {
    baseUrl: `http://127.0.0.1:${cfg.appPort}`,
    port: cfg.appPort,
    dataDir: cfg.dataDir,
    database,
    start,
    stop,
    restart: async (options?: { domain?: string }) => {
      if (options?.domain !== undefined) currentDomain = options.domain;
      await stop();
      await start();
    },
    close: async () => {
      await stop();
      await pool.end();
    },
  };
}

/** Await `FED_APP_READY <port>` on the child's stdout; surface errors / early exits loudly. */
function waitForReady(child: ChildProcess, cfg: FedAppConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const readyMarker = `FED_APP_READY ${cfg.appPort}`;
    const timer = setTimeout(() => {
      reject(new Error(`${cfg.domain}: timed out waiting for ${readyMarker}`));
    }, 60_000);
    let stderrTail = '';
    const onStdout = (chunk: Buffer): void => {
      if (chunk.toString().includes(readyMarker)) {
        clearTimeout(timer);
        child.stdout!.off('data', onStdout);
        resolve();
      }
    };
    child.stdout!.on('data', onStdout);
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      if (chunk.toString().includes('FED_APP_ERROR')) {
        clearTimeout(timer);
        reject(
          new Error(`${cfg.domain} reported FED_APP_ERROR:\n${stderrTail}`),
        );
      }
    });
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(
          new Error(
            `${cfg.domain} exited (code ${code}) before ready. stderr tail:\n${stderrTail}`,
          ),
        );
      }
    });
  });
}

// ─── the sanctioned entry: boot the pair on separate DBs + assert isolation ────────────────────

/** Boot appA + appB in separate processes on separate DBs, wired over loopback. Tests call THIS.
 *  A transparent S2S proxy sits on the appB→appA path (appB's discovery[aaa] → proxy → appA); it relays
 *  all traffic verbatim by default and is only USED (fault injection) by the resume test, which calls
 *  `proxy.armGetFileTruncation()`. appA→appB stays direct (no fault test on that leg).
 *  `env` is merged into both subprocesses after the standard harness env, so a spec can opt into
 *  the real database-backed signing-key lifecycle (FED_E2E_REAL_KEYPAIR=1 plus lifecycle overrides).
 *
 *  `scheme: 'https'` runs the S2S loopback over TLS (both apps listen with the given cert/key and
 *  verify each other against NODE_EXTRA_CA_CERTS supplied via `env`): the appB→appA leg then routes
 *  DIRECT — the plain-http fault-injection proxy cannot relay TLS. `extraRoutesOnB` adds loopback
 *  routes for additional domains hosted by appB (e.g. the post-re-bind domain of the domain-change
 *  spec), wired into BOTH subprocesses. */
export async function bootFederationPair(options?: {
  env?: Record<string, string>;
  extraRoutesOnB?: string[];
  scheme?: 'http' | 'https';
  appATls?: { cert: string; key: string };
  appBTls?: { cert: string; key: string };
}): Promise<{
  appA: FedApp;
  appB: FedApp;
  proxy: S2sProxy;
}> {
  ensureCompiledEntry(); // compile the subprocess entry once (staleness-gated)
  const scheme = options?.scheme ?? 'http';
  if (scheme === 'https' && (!options?.appATls || !options?.appBTls))
    throw new Error(
      'bootFederationPair: scheme https requires TLS material for both apps (appATls + appBTls)',
    );
  const tlsEnv = (tls?: {
    cert: string;
    key: string;
  }): Record<string, string> =>
    tls ? { FED_E2E_TLS_CERT: tls.cert, FED_E2E_TLS_KEY: tls.key } : {};
  const { urlA, urlB } = await ensureFederationDbs();
  const [portA, portB] = await Promise.all([pickFreePort(), pickFreePort()]);
  const proxy = await startS2sProxy(portA); // relays appB → appA (portA)
  const extraRoutes = Object.fromEntries(
    (options?.extraRoutesOnB ?? []).map((domain) => [
      domain,
      `${scheme}://127.0.0.1:${portB}`,
    ]),
  );
  const sharedEnv: Record<string, string> = {
    FED_E2E_SCHEME: scheme,
    ...(Object.keys(extraRoutes).length > 0
      ? { FED_E2E_EXTRA_ROUTES: JSON.stringify(extraRoutes) }
      : {}),
  };
  const poolId = process.env.VITEST_POOL_ID ?? '0';
  const federationDataRoot = join(
    process.env.SOMS_DATA_DIR ?? join(process.cwd(), 'data'),
    'federation',
  );
  const dataDirA = join(federationDataRoot, `${poolId}-a`);
  const dataDirB = join(federationDataRoot, `${poolId}-b`);
  // Each federation spec truncates this worker's databases after boot. Reset the matching node data
  // roots at the same boundary so deterministic media fixtures cannot be mistaken for already-local
  // CAS objects left by an earlier file or test run. restart() deliberately does not clean these paths:
  // restart coverage must exercise durable on-disk state within the current test pair.
  rmSync(dataDirA, { recursive: true, force: true });
  rmSync(dataDirB, { recursive: true, force: true });
  const appA = makeFedApp({
    domain: FED_DOMAIN_A,
    dbUrl: urlA,
    appPort: portA,
    portA,
    portB,
    dataDir: dataDirA,
    env: { ...options?.env, ...sharedEnv, ...tlsEnv(options?.appATls) },
  });
  // appB routes aaa.test through the proxy (portA field = proxy.port), so its signed media calls can
  // be fault-injected; bbb.test stays appB's own port. Over TLS the proxy leg is replaced by the
  // direct appA port — the plain-http relay cannot terminate TLS.
  const appB = makeFedApp({
    domain: FED_DOMAIN_B,
    dbUrl: urlB,
    appPort: portB,
    portA: scheme === 'https' ? portA : proxy.port,
    portB,
    dataDir: dataDirB,
    env: { ...options?.env, ...sharedEnv, ...tlsEnv(options?.appBTls) },
  });
  // Clean both persistent stores before any lifecycle hook or recovery scheduler can observe them.
  // Truncating after startup races in-memory recovery work against the replacement fixture state.
  await truncateFederationDbs(appA, appB);
  await Promise.all([appA.start(), appB.start()]);
  await assertSeparateDatabases(appA, appB);
  return { appA, appB, proxy };
}

/** Enforcement guard: the two apps MUST be on different physical databases. Throws loudly if not. */
export async function assertSeparateDatabases(
  appA: FedApp,
  appB: FedApp,
): Promise<void> {
  const [dbA, dbB] = await Promise.all([
    appA.database.execute(
      sql<{ current_database: string }>`SELECT current_database()`,
    ),
    appB.database.execute(
      sql<{ current_database: string }>`SELECT current_database()`,
    ),
  ]);
  if (dbA.rows[0].current_database === dbB.rows[0].current_database) {
    throw new Error(
      `federation e2e invariant violated: appA and appB share database "${dbA.rows[0].current_database}". They ` +
        `MUST be on separate DBs — a group's fedGroupAccount is @unique per DB, so a shared DB aliases ` +
        `appB's mirror to appA's origin thread and cross-server is never exercised. Use bootFederationPair().`,
    );
  }
}

/** Reset isolated federation fixtures, including profiles and media without account foreign keys.
 *  The LocalFederation identity tables are included: a previous REAL-keypair spec leaves its
 *  compressed-lifetime identity behind, and the next one would load it instead of bootstrapping
 *  with its own env (silently stalling rotation, or failing the skew-budget check at boot). */
const FEDERATION_TRUNCATE_SQL =
  'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread", "Message", "MessageAsset", "MediaAsset", "S2SKeyCache", "PeerStateFeed", "ProfileNamespaceFeed", "ProfileNamespace", "FileSyncProgress", "ForwardBundle", "LocalFederationRoot", "LocalFederationSigningKey", "LocalFederationSigningState" RESTART IDENTITY CASCADE';
const FEDERATION_NAMESPACE_RESET_SQL = `
  DO $$ DECLARE dependent regclass; BEGIN
    FOR dependent IN
      SELECT conrelid::regclass FROM pg_constraint
      WHERE confrelid = '"IdentityNamespace"'::regclass AND contype = 'f'
    LOOP
      EXECUTE format('DELETE FROM %s', dependent);
    END LOOP;
  END $$;
  DELETE FROM "IdentityNamespace" WHERE id <> 0;`;

function resetLocalNamespaceSentinelSql(domain: string) {
  return sql`
    INSERT INTO "IdentityNamespace" (
      id,
      domain,
      "rootPublicKey",
      "identityPinnedAt",
      "peerAssignedLocalNamespaceId",
      active,
      "trustLevel",
      "trustedAt",
      "lastSuccessAt",
      "degradedAt",
      "degradationReason",
      "degradationCount",
      "haltedAt",
      "haltCode",
      "haltReason",
      "peerAcceptanceConfirmed",
      "localServiceAvailable",
      "remoteServiceReachable",
      "resetAt",
      "stateFeedEndId",
      "stateFeedPulledThrough",
      "profileNamespaceFeedEndId",
      "profileNamespaceFeedPulledThrough",
      "retiredAt"
    ) VALUES (
      0,
      ${domain},
      NULL,
      NULL,
      NULL,
      false,
      'unrecognized',
      NULL,
      NULL,
      NULL,
      NULL,
      0,
      NULL,
      NULL,
      NULL,
      false,
      false,
      false,
      NULL,
      0,
      NULL,
      0,
      0,
      NULL
    )
    ON CONFLICT (id) DO UPDATE SET
      domain = EXCLUDED.domain,
      "rootPublicKey" = NULL,
      "identityPinnedAt" = NULL,
      "peerAssignedLocalNamespaceId" = NULL,
      active = false,
      "trustLevel" = 'unrecognized',
      "trustedAt" = NULL,
      "lastSuccessAt" = NULL,
      "degradedAt" = NULL,
      "degradationReason" = NULL,
      "degradationCount" = 0,
      "haltedAt" = NULL,
      "haltCode" = NULL,
      "haltReason" = NULL,
      "peerAcceptanceConfirmed" = false,
      "localServiceAvailable" = false,
      "remoteServiceReachable" = false,
      "resetAt" = NULL,
      "stateFeedEndId" = 0,
      "stateFeedPulledThrough" = NULL,
      "profileNamespaceFeedEndId" = 0,
      "profileNamespaceFeedPulledThrough" = 0,
      "retiredAt" = NULL
  `;
}

/** Truncate BOTH apps' databases between tests (in parallel — a test cannot forget one side). */
export async function truncateFederationDbs(
  appA: FedApp,
  appB: FedApp,
): Promise<void> {
  await Promise.all([
    appA.database.transaction(async (tx) => {
      await tx.execute(sql.raw(FEDERATION_TRUNCATE_SQL));
      await tx.execute(sql`DELETE FROM "SystemSetting"
        WHERE key = ${FEDERATION_HISTORY_ACCESS_SETTING_KEY}`);
      await tx.execute(sql.raw(FEDERATION_NAMESPACE_RESET_SQL));
      await tx.execute(resetLocalNamespaceSentinelSql(FED_DOMAIN_A));
    }),
    appB.database.transaction(async (tx) => {
      await tx.execute(sql.raw(FEDERATION_TRUNCATE_SQL));
      await tx.execute(sql`DELETE FROM "SystemSetting"
        WHERE key = ${FEDERATION_HISTORY_ACCESS_SETTING_KEY}`);
      await tx.execute(sql.raw(FEDERATION_NAMESPACE_RESET_SQL));
      await tx.execute(resetLocalNamespaceSentinelSql(FED_DOMAIN_B));
    }),
  ]);
}
