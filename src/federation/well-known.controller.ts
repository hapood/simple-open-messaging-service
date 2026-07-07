import { Controller, Get } from '@nestjs/common';
import { KeypairService } from './keypair.service.js';
import { loadFederationConfig } from './federation.config.js';

/**
 * Publish this server's S2S endpoint metadata + signing keys. PUBLIC (no auth) — peers fetch this
 * over HTTPS to discover our inbox URL and verify our signatures (RFC 8615 well-known URI).
 * Excluded from the /api/v1 global prefix in bootstrap.ts so it's served at exactly /.well-known/soms.
 *
 * `keys` is a list (JWKS-style) so future rotation can publish two keyIds simultaneously (§5.1).
 */
@Controller('.well-known')
export class WellKnownController {
  private readonly config = loadFederationConfig();

  constructor(private readonly keypair: KeypairService) {}

  @Get('soms')
  getWellKnown() {
    const scheme = this.config.allowInsecureHttp ? 'http' : 'https';
    return {
      inbox: `${scheme}://${this.config.domain}/api/v1/s2s/inbox`,
      software: 'soms/0.1',
      keys: [{ keyId: this.keypair.getKeyId(), ed25519: this.keypair.getPublicKeyB64() }],
    };
  }
}
