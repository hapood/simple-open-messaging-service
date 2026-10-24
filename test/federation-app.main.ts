// Federation e2e — ONE app instance, booted in its own Node process (run via `tsx`). The test harness
// forks this twice (appA=aaa.test on DB _a, appB=bbb.test on DB _b). Running each app in a separate
// process gives each its own V8 isolate — so process-global singletons (Passport's `local` strategy,
// etc.) are per-app, not cross-app leaks the way the old in-process two-AppModule model was. Each
// process also has its own DATABASE_URL env → its own database. This is how real federation runs.
//
// Config is read from env (set by the harness):
//   SOMS_DOMAIN / DATABASE_URL / APP_PORT — this app's identity, DB, listen port.
//   FED_PORT_A / FED_PORT_B — both apps' connection targets, injected into the disposable
//     request implementation without changing domain authority or stubbing HTTP responses.
// The app prints `FED_APP_READY <port>` on stdout once listening; the harness awaits that. SIGTERM →
// graceful app.close() (the degradation test stops appB this way to force a real ECONNREFUSED on appA).
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { DatabaseService } from '../src/database/database.service.js';
import { identityNamespace } from '../src/database/schema.js';
import { KeypairService } from '../src/federation/keypair.service.js';
import { DiscoveryService } from '../src/federation/discovery.service.js';
import { makeInMemoryKeypair } from './federation-harness.js';

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

  // The disposable transport owns these fixed connection targets, not production config.
  // Scheme and extra domains allow TLS, proxy legs, three-node and identity-rebind tests.
  const scheme = process.env.FED_E2E_SCHEME === 'https' ? 'https' : 'http';
  const routes: Record<string, string> = {
    'aaa.test': `${scheme}://127.0.0.1:${portA}`,
    'bbb.test': `${scheme}://127.0.0.1:${portB}`,
  };
  if (process.env.FED_E2E_EXTRA_ROUTES !== undefined) {
    try {
      const extra = JSON.parse(process.env.FED_E2E_EXTRA_ROUTES) as Record<
        string,
        string
      >;
      for (const [domain, base] of Object.entries(extra)) {
        const parsed = new URL(base);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
          throw new Error(`unsupported route scheme for ${domain}`);
        routes[domain] = base;
      }
    } catch (error) {
      console.error(
        'FED_APP_ERROR invalid FED_E2E_EXTRA_ROUTES:',
        (error as Error).message,
      );
      process.exit(1);
    }
  }

  // FED_E2E_REAL_KEYPAIR=1 keeps the REAL database-backed KeypairService (bootstrap,
  //  well-known publication, and the adaptive rotation lifecycle). Used by the
  //  signing-key-rotation e2e; every other spec keeps the deterministic in-memory keypair.
  const overrides =
    process.env.FED_E2E_REAL_KEYPAIR === '1'
      ? (builder: ReturnType<typeof Test.createTestingModule>) => builder
      : (builder: ReturnType<typeof Test.createTestingModule>) =>
          builder
            .overrideProvider(KeypairService)
            .useValue(makeInMemoryKeypair(domain));

  const moduleRef = await overrides(
    Test.createTestingModule({
      imports: [AppModule],
    }),
  ).compile();
  const { installFixedFederationTransport } = await import(
    pathToFileURL(join(process.cwd(), 'dev/federation-lab/fixed-transport.mjs'))
      .href
  );
  installFixedFederationTransport(moduleRef.get(DiscoveryService), routes);
  // The in-memory keypair bypasses the real KeypairService bootstrap, which is now the
  // component that creates the local IdentityNamespace(id=0) row (the WIP root-identity
  // redesign moved it there). Seed it here exactly as bootstrapOrLoad would, so Profile
  // and namespace-0 foreign keys hold for the in-memory path too.
  if (process.env.FED_E2E_REAL_KEYPAIR !== '1') {
    const database = moduleRef.get(DatabaseService, { strict: false });
    await database.db
      .insert(identityNamespace)
      .values({ id: 0, domain, rootPublicKey: null, identityPinnedAt: null })
      .onConflictDoNothing();
  }
  // Optional TLS listener material (FED_E2E_TLS_CERT / FED_E2E_TLS_KEY, file paths set by the
  // harness for scheme https): the app then serves BOTH its client API and its S2S endpoints over
  // TLS, and the peers connect with hostname verification against NODE_EXTRA_CA_CERTS.
  const tlsCertPath = process.env.FED_E2E_TLS_CERT;
  const tlsKeyPath = process.env.FED_E2E_TLS_KEY;
  if ((tlsCertPath !== undefined) !== (tlsKeyPath !== undefined)) {
    console.error(
      'FED_APP_ERROR FED_E2E_TLS_CERT and FED_E2E_TLS_KEY must be set together',
    );
    process.exit(1);
  }
  const adapter =
    tlsCertPath && tlsKeyPath
      ? new FastifyAdapter({
          https: {
            cert: readFileSync(tlsCertPath),
            key: readFileSync(tlsKeyPath),
          },
        })
      : new FastifyAdapter();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
  app.useLogger(moduleRef.get(Logger, { strict: false }));
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
  console.error('FED_APP_ERROR', (e as Error)?.stack ?? String(e));
  process.exit(1);
});
