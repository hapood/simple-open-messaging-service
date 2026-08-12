import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
import { Controller, Get } from '@nestjs/common';
import { SERVER_VERSION } from '../common/version.js';
import { KeypairService } from './keypair.service.js';
import { loadFederationConfig } from './federation.config.js';
import { FEDERATION_PROTOCOL_VERSIONS } from './federation-protocol.js';

/**
 * Publish this server's S2S signing keys. PUBLIC (no auth) — peers fetch this over HTTPS to discover
 * and verify our signing keys (RFC 8615 well-known URI). Excluded from the /api/v1 global prefix in
 * bootstrap.ts so it's served at exactly /.well-known/soms.
 *
 * S2S endpoint paths (friend-request, friend-approve, users, messages, …) are NOT published here —
 * peers derive them from the resolved base URL as `${base}/s2s/v1/<path>`, the same way the
 * Step 2 pull routes are already resolved.
 *
 * `keys` contains root-authorized signing certificates and may overlap during online rotation.
 */
@Public()
@Raw()
@Controller('.well-known')
export class WellKnownController {
  private readonly config = loadFederationConfig();

  constructor(private readonly keypair: KeypairService) {}

  @Get('soms')
  getWellKnown() {
    return {
      software: `soms/${SERVER_VERSION}`,
      protocolVersions: [...FEDERATION_PROTOCOL_VERSIONS],
      rootKey: {
        ed25519: this.keypair.getRootPublicKeyB64(),
      },
      keys: this.keypair.getSigningKeyCertificates(),
    };
  }
}
