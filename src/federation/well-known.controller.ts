import { Controller, Get } from '@nestjs/common';
import { SERVER_VERSION } from '../common/version.js';
import { KeypairService } from './keypair.service.js';
import { loadFederationConfig } from './federation.config.js';

/**
 * Publish this server's S2S signing keys. PUBLIC (no auth) — peers fetch this over HTTPS to discover
 * and verify our signing keys (RFC 8615 well-known URI). Excluded from the /api/v1 global prefix in
 * bootstrap.ts so it's served at exactly /.well-known/soms.
 *
 * S2S endpoint paths (friend-request, friend-approve, users, messages, …) are NOT published here —
 * peers derive them from the resolved base URL as `${base}/api/v1/s2s/<path>`, the same way the
 * Step 2 pull routes are already resolved.
 *
 * `keys` is a list (JWKS-style) so future rotation can publish two keyIds simultaneously (§5.1).
 */
@Controller('.well-known')
export class WellKnownController {
  private readonly config = loadFederationConfig();

  constructor(private readonly keypair: KeypairService) {}

  @Get('soms')
  getWellKnown() {
    return {
      software: `soms/${SERVER_VERSION}`,
      keys: [{ keyId: this.keypair.getKeyId(), ed25519: this.keypair.getPublicKeyB64() }],
    };
  }
}
