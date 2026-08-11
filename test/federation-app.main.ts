// Federation e2e — ONE app instance, booted in its own Node process (run via `tsx`). The test harness
// forks this twice (appA=aaa.local on DB _a, appB=bbb.local on DB _b). Running each app in a separate
// process gives each its own V8 isolate — so process-global singletons (Passport's `local` strategy,
// etc.) are per-app, not cross-app leaks the way the old in-process two-AppModule model was. Each
// process also has its own DATABASE_URL env → its own database. This is how real federation runs.
//
// Config is read from env (set by the harness):
//   SOMS_DOMAIN / DATABASE_URL / APP_PORT — this app's identity, DB, listen port.
//   FED_PORT_A / FED_PORT_B — BOTH apps' loopback ports (known up front so TestDiscoveryService.portMap
//     is complete in each process; loopback avoids /etc/hosts, SRV, or stubbing fetch).
// The app prints `FED_APP_READY <port>` on stdout once listening; the harness awaits that. SIGTERM →
// graceful app.close() (the demote test stops appB this way to force a real ECONNREFUSED on appA).
import 'dotenv/config';
import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../src/common/public.decorator.js';
import { Raw } from '../src/common/raw.decorator.js';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { KeypairService } from '../src/federation/keypair.service.js';
import { SignatureService } from '../src/federation/signature.service.js';
import { DiscoveryService } from '../src/federation/discovery.service.js';
import {
  TestDiscoveryService,
  makeInMemoryKeypair,
} from './federation-harness.js';

/**
 * Test-only probe (NOT in prod — this is the test subprocess entry): drive a signed S2S GET as THIS app
 * using its OWN SignatureService + DiscoveryService (the framework's real signing machinery — no
 * reinvented signing, no key exposure). Lets the e2e exercise SERVE-only endpoints SOMS has no internal
 * caller for a backward-only legacy route (SOMS is forward-only). The e2e hits
 * /api/v1/test/signed-s2s-get?peerDomain=...&path=... and this app signs + fetches + relays the upstream
 * {status, body}. Registered as a proper Nest controller (NOT a raw Fastify route — the raw form raced
 * Nest's listen-time route finalization + caused intermittent boot failures). SignatureService +
 * DiscoveryService are @Global-exported by FederationModule, so they inject here. See design-review B3.
 */
@Public() // opts out of the global JwtAuthGuard — this is a test-only probe (no JWT; it signs the upstream S2S call itself).
@Raw() // returns a non-envelope {status, body} (mirrors the upstream S2S response) — must bypass envelope wrapping.
@Controller('test')
class TestS2sHookController {
  constructor(
    private readonly sig: SignatureService,
    private readonly discovery: DiscoveryService,
  ) {}

  @Get('signed-s2s-get')
  async signedGet(
    @Query('peerDomain') peerDomain: string,
    @Query('path') path: string,
  ): Promise<{ status: number; body: unknown }> {
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}${path}`);
    const headers = await this.sig.signOutbound({
      method: 'GET',
      url,
      body: '', // GET — content-digest covers sha256("")
    });
    const upstream = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await upstream.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return { status: upstream.status, body };
  }
}

async function main(): Promise<void> {
  const domain = process.env.SOMS_DOMAIN;
  const dbUrl = process.env.DATABASE_URL;
  const port = Number(process.env.APP_PORT);
  const portA = process.env.FED_PORT_A;
  const portB = process.env.FED_PORT_B;
  if (!domain || !dbUrl || !Number.isFinite(port) || !portA || !portB) {
    console.error(
      'FED_APP_ERROR missing env (need SOMS_DOMAIN, DATABASE_URL, APP_PORT, FED_PORT_A, FED_PORT_B)',
    );
    process.exit(1);
  }
  process.env.SOMS_ALLOW_INSECURE_HTTP = '1';

  // The loopback map is identical in both processes (each knows both ports), so appA's signed requests
  // to bbb.local route to appB's listener and vice versa — the signing @authority (127.0.0.1:<port>)
  // matches what the receiving Fastify sees, so signatures verify end-to-end.
  TestDiscoveryService.portMap = {
    'aaa.local': `http://127.0.0.1:${portA}`,
    'bbb.local': `http://127.0.0.1:${portB}`,
  };

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [TestS2sHookController], // test-only signed-S2S-GET probe (see the class doc)
  })
    .overrideProvider(KeypairService)
    .useValue(makeInMemoryKeypair(domain))
    .overrideProvider(DiscoveryService)
    .useClass(TestDiscoveryService)
    .compile();
  const adapter = new FastifyAdapter();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
  await configureApp(app, adapter);
  await app.listen(port, '0.0.0.0');
  // Signal readiness to the harness (which awaits this exact line on stdout).
  console.log(`FED_APP_READY ${port}`);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } catch {
      // best-effort — the harness is tearing us down anyway
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((e: unknown) => {
  console.error('FED_APP_ERROR', (e as Error)?.message ?? String(e));
  process.exit(1);
});
