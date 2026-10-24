import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../dist/src/app.module.js';
import { configureApp } from '../../dist/src/bootstrap.js';
import { DiscoveryService } from '../../dist/src/federation/discovery.service.js';
import { parseTrustedProxyConfig } from '../../dist/src/rate-limit/trusted-proxy.js';
import { federationLabNodes, federationLabRoutes } from './topology.mjs';
import { installFixedFederationTransport } from './fixed-transport.mjs';

// The lab, not the production entry, owns disposable fixed routing and cleartext listeners.
const local = federationLabNodes.find((node) =>
  [node.domain, node.transitionDomain].includes(process.env.SOMS_DOMAIN),
);
if (!local) throw new Error('Unknown local federation lab identity');
const targets = { ...federationLabRoutes };
delete targets[local.domain];
delete targets[local.transitionDomain];
const adapter = new FastifyAdapter({
  trustProxy: parseTrustedProxyConfig(process.env.TRUSTED_PROXY_CIDRS)
    .isTrusted,
  requestIdHeader: 'x-request-id',
  genReqId: () => randomUUID(),
  bodyLimit: 1_048_576,
});
const app = await NestFactory.create(AppModule, adapter, { bufferLogs: true });
app.useLogger(app.get(Logger));
installFixedFederationTransport(app.get(DiscoveryService), targets);
await configureApp(app, adapter);
app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
await app.listen(local.backendPort, '0.0.0.0');
console.log(`[lab] listening on http://0.0.0.0:${local.backendPort}`);
