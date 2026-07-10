// Federation e2e — ONE app instance, booted in its own Node process (run via `tsx`). The test harness
// forks this twice (appA=aaa.local on DB _a, appB=bbb.local on DB _b). Running each app in a separate
// process gives each its own V8 isolate — so process-global singletons (Passport's `local` strategy,
// etc.) are per-app, not cross-app leaks the way the old in-process two-AppModule model was. Each
// process also has its OWN DATABASE_URL env → its own database. This is how real federation runs.
//
// Config is read from env (set by the harness):
//   SOMS_DOMAIN / DATABASE_URL / APP_PORT — this app's identity, DB, listen port.
//   FED_PORT_A / FED_PORT_B — BOTH apps' loopback ports (known up front so TestDiscoveryService.portMap
//     is complete in each process; loopback avoids /etc/hosts, SRV, or stubbing fetch).
// The app prints `FED_APP_READY <port>` on stdout once listening; the harness awaits that. SIGTERM →
// graceful app.close() (the demote test stops appB this way to force a real ECONNREFUSED on appA).
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { KeypairService } from '../src/federation/keypair.service.js';
import { DiscoveryService } from '../src/federation/discovery.service.js';
import { TestDiscoveryService, makeInMemoryKeypair } from './federation-harness.js';

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

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
