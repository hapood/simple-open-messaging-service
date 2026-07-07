import { Global, Module } from '@nestjs/common';
import { KeypairService } from './keypair.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { WellKnownController } from './well-known.controller.js';
import { PrismaService } from '../prisma.service.js';

/**
 * Federation (S2S). @Global so its services inject across modules: SignatureService/DiscoveryService
 * by the S2S inbox (Phase C) + init handshake (Phase E), FederationService by UserController (Phase D)
 * + AdminController (Phase E), KeypairService by this .well-known controller.
 *
 * PrismaService is provided here (it is not @Global) so DiscoveryService can read/write S2SKeyCache.
 */
@Global()
@Module({
  controllers: [WellKnownController],
  providers: [KeypairService, SignatureService, DiscoveryService, PrismaService],
  exports: [KeypairService, SignatureService, DiscoveryService],
})
export class FederationModule {}
