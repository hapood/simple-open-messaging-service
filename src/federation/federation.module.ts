import { Global, Module } from '@nestjs/common';
import { KeypairService } from './keypair.service.js';

/**
 * Federation (S2S). @Global because its services are injected across modules:
 * SignatureService/DiscoveryService by the S2S inbox controller, FederationService by
 * UserController (to enqueue outbound friend ops) and AdminController (peer approval),
 * KeypairService by the .well-known controller. Mirrors RedisModule's @Global rationale.
 *
 * Phase A wires only KeypairService; signing/discovery/inbox/outbound services are added
 * in later phases.
 */
@Global()
@Module({
  providers: [KeypairService],
  exports: [KeypairService],
})
export class FederationModule {}
