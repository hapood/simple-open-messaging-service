import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { ed25519 } from '@noble/curves/ed25519.js';
import sharp from 'sharp';
import { execSync } from 'node:child_process';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { PrismaService } from '../src/prisma.service.js';
import { KeypairService } from '../src/federation/keypair.service.js';
import { DiscoveryService } from '../src/federation/discovery.service.js';

/**
 * Federation e2e harness — boots TWO full AppModule instances (appA=aaa.local, appB=bbb.local) that make
 * real signed HTTP requests to each other over loopback, EACH ON ITS OWN DATABASE.
 *
 * The one trick that makes loopback work without /etc/hosts, SRV, or stubbing global fetch:
 * TestDiscoveryService maps each peer domain to the other app's `http://127.0.0.1:<port>` via resolveBase.
 * Every S2S endpoint URL (friend-request/approve, users, messages, …) is derived from that base as
 * `${base}/api/v1/s2s/<path>`, so the unusable real-domain host (`aaa.local`) never reaches the wire.
 * That keeps the signing `@authority` (url.host = 127.0.0.1:<port>) identical to what the receiving
 * Fastify sees in req.headers.host → signatures verify end-to-end. fetchWellKnown / getPublicKey are
 * inherited unchanged, so real keys are fetched + cached over loopback.
 *
 * The port map is late-bound: empty at compile time (ports unknown until listen), set after both apps
 * listen inside bootFederationPair.
 *
 * ─── DUAL-DATABASE INVARIANT (enforced) ─────────────────────────────────────────────────────────────
 * The two apps MUST run on SEPARATE databases. A group's fedGroupAccount is @unique per DB; if both apps
 * shared one DB, appB's findOrCreateMirrorThread would findUnique({fedGroupAccount}) into appA's ORIGIN
 * thread and alias it as "the mirror" (the create branch never runs) — so the origin→mirror round-trip is
 * never exercised and tests pass on shared-DB semantics. Three layers make a shared DB impossible:
 *   1. bootFederationPair() owns DB creation + assignment — the sanctioned entry tests call.
 *   2. bootFederationApp() takes a MANDATORY dbUrl (no default ⇒ a caller cannot forget to split).
 *   3. assertSeparateDatabases() queries current_database() on each prisma + throws at boot if equal,
 *      so any future bypass (shared DB, copy-paste, a missed dbUrl) fails LOUDLY at boot — never as a
 *      misleading assertion deep in a test.
 */

/** The canonical federation-test domains (single source — import these instead of redefining). */
export const FED_DOMAIN_A = 'aaa.local';
export const FED_DOMAIN_B = 'bbb.local';

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
 * DiscoveryService override for tests: resolveBase reads the static (late-bound) portMap. Every S2S
 * endpoint (friend-request/approve, users, messages, …) derives its URL from resolveBase as
 * `${base}/api/v1/s2s/<path>`, so overriding resolveBase alone routes all of them over loopback.
 * Everything else (well-known fetch, key fetch-on-miss + TTL cache, proactive refresh) is inherited
 * and operates over the loopback URLs resolveBase returns.
 */
export class TestDiscoveryService extends DiscoveryService {
  /** domain → `http://127.0.0.1:<port>`. Set after both apps listen. Shared across both apps' instances. */
  static portMap: Record<string, string> = {};

  override async resolveBase(domain: string): Promise<string> {
    const mapped = TestDiscoveryService.portMap[domain];
    if (mapped) return mapped;
    return super.resolveBase(domain); // fallback (unused in the federation tests)
  }
}

export interface BootedApp {
  app: INestApplication;
  port: number;
  prisma: PrismaService;
}

/** Derive the two per-app DB names from this fork's base fork DB (created by setup-env). */
function federationDbNames(): { a: string; b: string } {
  const poolId = process.env.VITEST_POOL_ID ?? '0';
  const base = `soms_test_fork${poolId}`;
  return { a: `${base}_a`, b: `${base}_b` };
}

/** CREATE DATABASE if missing — connect to the maintenance `postgres` DB + guard with SELECT (no IF NOT
 *  EXISTS in pg). Mirrors setup-env.ts. */
function createDbIfMissing(adminUrl: string, db: string): void {
  execSync(
    `psql "${adminUrl}" -v ON_ERROR_STOP=1 -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1 || psql "${adminUrl}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${db}"`,
    { stdio: 'inherit' },
  );
}

/** Migrate one DB: point DATABASE_URL at it + `prisma migrate deploy` (idempotent). Restores DATABASE_URL
 *  after (bootFederationApp sets it per-app at construction time anyway). */
function migrateDb(dbUrl: string): void {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = dbUrl;
  try {
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  } finally {
    process.env.DATABASE_URL = prev;
  }
}

/**
 * Create + migrate both per-app DBs for this fork (`soms_test_fork<pool>_a` + `_b`). Idempotent: safe to
 * call on every test-file load (migrate deploy is a fast no-op once current). Returns the two datasource
 * URLs for bootFederationApp.
 */
export async function ensureFederationDbs(): Promise<{ urlA: string; urlB: string }> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL missing — copy .env.example to .env and configure it.');
  }
  const base = new URL(process.env.DATABASE_URL);
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  adminUrl.search = ''; // psql ignores Prisma's ?schema= param; strip it for the maintenance call
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

/**
 * Boot one federation app. Sets SOMS_DOMAIN + SOMS_ALLOW_INSECURE_HTTP + DATABASE_URL (all read by
 * field-initializer configs + PrismaService's eager constructor at instantiation, BEFORE compile returns),
 * overrides KeypairService (in-memory key) + DiscoveryService (loopback map), then runs the full
 * production wiring via configureApp + listen(0).
 *
 * `dbUrl` is MANDATORY: each app MUST be on its own database (see the DUAL-DATABASE INVARIANT at the top
 * of this file). Tests should call bootFederationPair(), not this directly.
 */
export async function bootFederationApp(opts: {
  domain: string;
  keypair: InMemoryKeypair;
  dbUrl: string;
}): Promise<BootedApp> {
  process.env.SOMS_DOMAIN = opts.domain;
  process.env.SOMS_ALLOW_INSECURE_HTTP = '1';

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    // Per-app database by CONSTRUCTION, not env: override PrismaService with an instance built on THIS
    // app's dbUrl, so every service in the app (auth chain, federation, …) shares the ONE singleton on the
    // right DB. Mutating process.env.DATABASE_URL between boots was unreliable — it's global state, and
    // the auth DI chain ended up reading the wrong DB. (SOMS_DOMAIN above is still per-app env because
    // loadFederationConfig reads it at field-init and there is no DI override for the domain.)
    .overrideProvider(PrismaService)
    .useValue(new PrismaService(opts.dbUrl))
    .overrideProvider(KeypairService)
    .useValue(opts.keypair)
    .overrideProvider(DiscoveryService)
    .useClass(TestDiscoveryService)
    .compile();

  const adapter = new FastifyAdapter();
  const app = moduleRef.createNestApplication(adapter);
  await configureApp(app, adapter);
  await app.listen(0);
  const port = (app.getHttpServer().address() as { port: number }).port;
  return { app, port, prisma: app.get(PrismaService) };
}

/** The physical database a prisma is connected to (for the separation guard). */
async function currentDatabase(prisma: PrismaService): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
    'SELECT current_database()',
  );
  return rows[0].current_database;
}

/**
 * Enforcement guard: the two apps MUST be on different physical databases. Throws a loud, specific error
 * at boot if they share one — so a future test can never silently regress to shared-DB semantics (which
 * would make group cross-server assertions pass without actually exercising the origin→mirror round-trip).
 */
export async function assertSeparateDatabases(
  appA: BootedApp,
  appB: BootedApp,
): Promise<void> {
  const [dbA, dbB] = await Promise.all([
    currentDatabase(appA.prisma),
    currentDatabase(appB.prisma),
  ]);
  if (dbA === dbB) {
    throw new Error(
      `federation e2e invariant violated: appA and appB share database "${dbA}". They MUST be on ` +
        `separate DBs — a group's fedGroupAccount is @unique per DB, so a shared DB aliases appB's mirror ` +
        `to appA's origin thread and cross-server is never exercised. Use bootFederationPair().`,
    );
  }
}

/**
 * The single sanctioned boot entry: creates the two per-fork DBs, boots appA on _a + appB on _b, wires the
 * loopback port map, and asserts the databases are distinct. Tests call THIS — not bootFederationApp — so
 * the dual-DB invariant is upheld by construction.
 */
export async function bootFederationPair(): Promise<{ appA: BootedApp; appB: BootedApp }> {
  const { urlA, urlB } = await ensureFederationDbs();
  const appA = await bootFederationApp({
    domain: FED_DOMAIN_A,
    keypair: makeInMemoryKeypair(FED_DOMAIN_A),
    dbUrl: urlA,
  });
  const appB = await bootFederationApp({
    domain: FED_DOMAIN_B,
    keypair: makeInMemoryKeypair(FED_DOMAIN_B),
    dbUrl: urlB,
  });
  TestDiscoveryService.portMap = {
    [FED_DOMAIN_A]: `http://127.0.0.1:${appA.port}`,
    [FED_DOMAIN_B]: `http://127.0.0.1:${appB.port}`,
  };
  await assertSeparateDatabases(appA, appB);
  return { appA, appB };
}

/** The federation-relevant tables to TRUNCATE between tests (User CASCADE clears its kin). */
const FEDERATION_TRUNCATE_SQL =
  'TRUNCATE TABLE "User", "Invite", "MessageThread", "FederatedPeer", "FederatedPeerEvent", "S2SKeyCache", "S2SFriendOpSeen" RESTART IDENTITY CASCADE';

/**
 * Truncate BOTH apps' databases between tests. Runs in parallel. A test cannot forget one side (which
 * would leave stale state that makes cross-server assertions pass for the wrong reason).
 */
export async function truncateFederationDbs(
  appA: BootedApp,
  appB: BootedApp,
): Promise<void> {
  await Promise.all([
    appA.prisma.$executeRawUnsafe(FEDERATION_TRUNCATE_SQL),
    appB.prisma.$executeRawUnsafe(FEDERATION_TRUNCATE_SQL),
  ]);
}
