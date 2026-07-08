import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { ed25519 } from '@noble/curves/ed25519.js';
import sharp from 'sharp';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { PrismaService } from '../src/prisma.service.js';
import { KeypairService } from '../src/federation/keypair.service.js';
import { DiscoveryService } from '../src/federation/discovery.service.js';

/**
 * Federation e2e harness — boots TWO full AppModule instances in one vitest fork (appA=aaa.local,
 * appB=bbb.local) and lets them make real signed HTTP requests to each other over loopback.
 *
 * The one trick that makes loopback work without /etc/hosts, SRV, or stubbing global fetch:
 * TestDiscoveryService maps each peer domain to the other app's `http://127.0.0.1:<port>`, and derives
 * the inbox URL from resolveBase (NOT the well-known `inbox` field, which still carries the unusable
 * `aaa.local` host). That keeps the signing `@authority` (url.host = 127.0.0.1:<port>) identical to what
 * the receiving Fastify sees in req.headers.host → signatures verify end-to-end. fetchWellKnown /
 * getPublicKey are inherited unchanged, so real keys are fetched + cached over loopback.
 *
 * The port map is late-bound: empty at compile time (ports unknown until listen), set after both apps
 * listen via `TestDiscoveryService.portMap = {...}`.
 */

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
 * DiscoveryService override for tests: resolveBase reads the static (late-bound) portMap; resolveInboxUrl
 * is derived from resolveBase so the well-known `inbox` field (which carries the real domain host) is
 * never used for sending. Everything else (well-known fetch, key fetch-on-miss + TTL cache, proactive
 * refresh) is inherited and operates over the loopback URLs resolveBase returns.
 */
export class TestDiscoveryService extends DiscoveryService {
  /** domain → `http://127.0.0.1:<port>`. Set after both apps listen. Shared across both apps' instances. */
  static portMap: Record<string, string> = {};

  override async resolveBase(domain: string): Promise<string> {
    const mapped = TestDiscoveryService.portMap[domain];
    if (mapped) return mapped;
    return super.resolveBase(domain); // fallback (unused in the federation tests)
  }

  override async resolveInboxUrl(domain: string): Promise<string> {
    return (await this.resolveBase(domain)) + '/api/v1/s2s/inbox';
  }
}

export interface BootedApp {
  app: INestApplication;
  port: number;
  prisma: PrismaService;
}

/**
 * Boot one federation app. Sets SOMS_DOMAIN (read by loadFederationConfig in field initializers at
 * instantiation) + SOMS_ALLOW_INSECURE_HTTP, overrides KeypairService (in-memory key) + DiscoveryService
 * (loopback map), then runs the full production wiring via configureApp + listen(0).
 */
export async function bootFederationApp(opts: {
  domain: string;
  keypair: InMemoryKeypair;
}): Promise<BootedApp> {
  process.env.SOMS_DOMAIN = opts.domain;
  process.env.SOMS_ALLOW_INSECURE_HTTP = '1';

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
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

/** Truncate the federation-relevant tables (both apps share soms_test). User CASCADE clears its kin. */
export async function truncateFederationTables(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "User", "Friendship", "MessageThread", "FederatedPeer", "FederatedPeerEvent", "S2SKeyCache", "S2SInboxSeen" RESTART IDENTITY CASCADE',
  );
}
