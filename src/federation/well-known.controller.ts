import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
import { Controller, Get } from '@nestjs/common';
import { SERVER_VERSION } from '../common/version.js';
import { KeypairService } from './keypair.service.js';
import { loadFederationConfig } from './federation.config.js';
import { FEDERATION_PROTOCOL_VERSIONS } from './federation-protocol.js';

/**
 * Publish this server's S2S root identity group and signing certificates.
 * PUBLIC (no auth) — peers fetch this over HTTPS to discover and verify our
 * keys (RFC 8615 well-known URI). Excluded from the /api/v1 global prefix in
 * bootstrap.ts so it is served at exactly /.well-known/somfp.
 *
 * `roots` is the identity anchor set: every root epoch still published,
 * including rotated-out predecessors whose entries must remain visible until
 * every recognized peer adopted the rotation. `keys` contains root-authorized
 * signing certificates; after a root rotation only successor-authorized
 * certificates remain — their removal is the revocation channel.
 */
@Public()
@Raw()
@Controller('.well-known')
export class WellKnownController {
  private readonly config = loadFederationConfig();

  constructor(private readonly keypair: KeypairService) {}

  @Get('somfp')
  getWellKnown() {
    return {
      software: `soms/${SERVER_VERSION}`,
      protocolVersions: [...FEDERATION_PROTOCOL_VERSIONS],
      roots: this.keypair.getRootGroup(),
      keys: this.keypair.getSigningKeyCertificates(),
    };
  }
}
