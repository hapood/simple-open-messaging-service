import { execSync } from 'node:child_process';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import sharp from 'sharp';
import { PrismaClient } from '../src/prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { DiscoveryService } from '../src/federation/discovery.service.js';
import { startS2sProxy, type S2sProxy } from './federation-proxy.js';

export type { S2sProxy };

/**
 * Federation e2e harness — boots TWO full SOMS apps in SEPARATE Node processes (appA=aaa.local on DB
 * _a, appB=bbb.local on DB _b), making real signed HTTP requests to each other over loopback. Each app
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
export const FED_DOMAIN_A = 'aaa.local';
export const FED_DOMAIN_B = 'bbb.local';

/** Path to the COMPILED subprocess entry (see ensureCompiledEntry — why it's compiled, not run via tsx). */
const APP_MAIN = join(process.cwd(), '.e2e-build', 'test', 'federation-app.main.js');

/** Compile the subprocess entry + its deps to .e2e-build/ via tsc, IF missing or stale. Staleness is
 *  gated (any relevant source newer than the build → recompile) so the ~10s compile runs only when needed. */
function ensureCompiledEntry(): void {
  const sources =
    'src test/federation-app.main.ts test/federation-harness.ts test/federation-proxy.ts test/federation-test-helpers.ts tsconfig.json tsconfig.e2e.json';
  try {
    execSync(
      `test -f "${APP_MAIN}" && test -z "$(find ${sources} -newer "${APP_MAIN}" 2>/dev/null)"`,
      { stdio: 'ignore' },
    );
    return; // up-to-date — skip the compile
  } catch {
    // missing or stale → (re)compile below
  }
  execSync('npx tsc -p tsconfig.e2e.json', { stdio: 'inherit' });
}

/** A duck-typed KeypairService held entirely in memory — no file I/O, distinct keys per app. */
export interface InMemoryKeypair {
  getKeyId(): string;
  getPrivateKey(): Uint8Array;
  getPublicKeyB64(): string;
}

export function makeInMemoryKeypair(domain: string): InMemoryKeypair {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    getKeyId: () => `${domain}/key-1`,
    getPrivateKey: () => privateKey,
    getPublicKeyB64: () => Buffer.from(publicKey).toString('base64'),
  };
}

/**
 * Generate a valid PNG (a solid `size`×`size` square of the given red channel) that round-trips
 * through saveAvatars' sharp decode→resize→webp pipeline. Hand-written base64 PNGs are risky — a
 * corrupt header is silently swallowed by save() (raw bytes) but throws inside saveAvatars (sharp).
 * `red` varies the bytes so two uploads produce distinct files (for the re-pull test).
 */
export async function makePng(red: number, size = 16): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    raw[i * 4] = red;
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
  const base = `soms_test_fork${poolId}`;
  return { a: `${base}_a`, b: `${base}_b` };
}

function createDbIfMissing(adminUrl: string, db: string): void {
  execSync(
    `psql "${adminUrl}" -v ON_ERROR_STOP=1 -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1 || psql "${adminUrl}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${db}"`,
    { stdio: 'inherit' },
  );
}

function migrateDb(dbUrl: string): void {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = dbUrl;
  try {
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  } finally {
    process.env.DATABASE_URL = prev;
  }
}

/** Create + migrate both per-app DBs for this fork. Idempotent. Returns the two datasource URLs. */
export async function ensureFederationDbs(): Promise<{ urlA: string; urlB: string }> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL missing — copy .env.example to .env and configure it.');
  }
  const base = new URL(process.env.DATABASE_URL);
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  const mkUrl = (db: string): string => {
    const u = new URL(base.toString());
    u.pathname = `/${db}`;
    return u.toString();
  };
  const { a, b } = federationDbNames();
  const urlA = mkUrl(a);
  const urlB = mkUrl(b);
  createDbIfMissing(adminUrl.toString(), a);
  createDbIfMissing(adminUrl.toString(), b);
  migrateDb(urlA);
  migrateDb(urlB);
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

// ─── a booted federation app (subprocess + test-process prisma) ───────────────────────────────

export interface FedApp {
  baseUrl: string;
  port: number;
  prisma: PrismaClient;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  close: () => Promise<void>;
}

interface FedAppConfig {
  domain: string;
  dbUrl: string;
  appPort: number;
  portA: number;
  portB: number;
}

/** Boot one app in a subprocess. `start()` forks test/federation-app.main.ts (via tsx) with the app's
 *  env, awaits `FED_APP_READY <port>` on stdout, and connects a test-process PrismaClient to its DB.
 *  `stop()` SIGTERMs the child (used by the demote test to force a real ECONNREFUSED); `restart()`
 *  re-forks on the same port (used by the re-handshake test). */
function makeFedApp(cfg: FedAppConfig): FedApp {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: cfg.dbUrl }) });
  let child: ChildProcess | null = null;

  const start = async (): Promise<void> => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SOMS_DOMAIN: cfg.domain,
      DATABASE_URL: cfg.dbUrl,
      APP_PORT: String(cfg.appPort),
      FED_PORT_A: String(cfg.portA),
      FED_PORT_B: String(cfg.portB),
    };
    child = fork(APP_MAIN, {
      env,
      // fork() requires an IPC channel (the 4th stdio slot); we don't use it — readiness comes via
      // stdout, shutdown via SIGTERM — but the slot must be present. The entry is compiled JS (see
      // ensureCompiledEntry), so no tsx/ts-node loader — plain `node` runs it.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    await waitForReady(child, cfg);
  };

  const stop = async (): Promise<void> => {
    const c = child;
    if (!c) return;
    child = null;
    const exited = new Promise<void>((resolve) => {
      c.once('exit', () => resolve());
      // Guard: if SIGTERM doesn't land within 10s, escalate to SIGKILL.
      setTimeout(() => c.kill('SIGKILL'), 10_000).unref();
    });
    c.kill('SIGTERM');
    await exited;
  };

  return {
    baseUrl: `http://127.0.0.1:${cfg.appPort}`,
    port: cfg.appPort,
    prisma,
    start,
    stop,
    restart: async () => {
      await stop();
      await start();
    },
    close: async () => {
      await stop();
      await prisma.$disconnect();
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
        reject(new Error(`${cfg.domain} reported FED_APP_ERROR:\n${stderrTail}`));
      }
    });
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`${cfg.domain} exited (code ${code}) before ready. stderr tail:\n${stderrTail}`));
      }
    });
  });
}

// ─── the sanctioned entry: boot the pair on separate DBs + assert isolation ────────────────────

/** Boot appA + appB in separate processes on separate DBs, wired over loopback. Tests call THIS.
 *  A transparent S2S proxy sits on the appB→appA path (appB's discovery[aaa] → proxy → appA); it relays
 *  all traffic verbatim by default and is only USED (fault injection) by the resume test, which calls
 *  `proxy.armGetFileTruncation()`. appA→appB stays direct (no fault test on that leg). */
export async function bootFederationPair(): Promise<{ appA: FedApp; appB: FedApp; proxy: S2sProxy }> {
  ensureCompiledEntry(); // compile the subprocess entry once (staleness-gated)
  const { urlA, urlB } = await ensureFederationDbs();
  const [portA, portB] = await Promise.all([pickFreePort(), pickFreePort()]);
  const proxy = await startS2sProxy(portA); // relays appB → appA (portA)
  const appA = makeFedApp({ domain: FED_DOMAIN_A, dbUrl: urlA, appPort: portA, portA, portB });
  // appB routes aaa.local through the proxy (portA field = proxy.port), so its signed /get_file calls can
  // be fault-injected; bbb.local stays appB's own port.
  const appB = makeFedApp({ domain: FED_DOMAIN_B, dbUrl: urlB, appPort: portB, portA: proxy.port, portB });
  await Promise.all([appA.start(), appB.start()]);
  await assertSeparateDatabases(appA, appB);
  return { appA, appB, proxy };
}

/** Enforcement guard: the two apps MUST be on different physical databases. Throws loudly if not. */
export async function assertSeparateDatabases(appA: FedApp, appB: FedApp): Promise<void> {
  const [dbA, dbB] = await Promise.all([
    appA.prisma.$queryRawUnsafe<{ current_database: string }[]>('SELECT current_database()'),
    appB.prisma.$queryRawUnsafe<{ current_database: string }[]>('SELECT current_database()'),
  ]);
  if (dbA[0].current_database === dbB[0].current_database) {
    throw new Error(
      `federation e2e invariant violated: appA and appB share database "${dbA[0].current_database}". They ` +
        `MUST be on separate DBs — a group's fedGroupAccount is @unique per DB, so a shared DB aliases ` +
        `appB's mirror to appA's origin thread and cross-server is never exercised. Use bootFederationPair().`,
    );
  }
}

/** The federation-relevant tables to TRUNCATE between tests (User CASCADE clears its kin). MediaAsset is
 *  included explicitly: it has NO FK to User/Message, so the User CASCADE doesn't reach it, and a
 *  deterministic fixture (makePng(red,size) → stable digest) would leave a row that makes localizeMedia's
 *  dedup SKIP the /get_file fetch on the next run — defeating the media tests (the proxy would see no
 *  /get_file). MediaMessage + Message are belt-and-suspenders (they FK-cascade, but list them anyway). */
const FEDERATION_TRUNCATE_SQL =
  'TRUNCATE TABLE "User", "Invite", "MessageThread", "Message", "MediaMessage", "MediaAsset", "FederatedPeer", "FederatedPeerEvent", "S2SKeyCache", "S2SFriendOpSeen" RESTART IDENTITY CASCADE';

/** Truncate BOTH apps' databases between tests (in parallel — a test cannot forget one side). */
export async function truncateFederationDbs(appA: FedApp, appB: FedApp): Promise<void> {
  await Promise.all([
    appA.prisma.$executeRawUnsafe(FEDERATION_TRUNCATE_SQL),
    appB.prisma.$executeRawUnsafe(FEDERATION_TRUNCATE_SQL),
  ]);
}
