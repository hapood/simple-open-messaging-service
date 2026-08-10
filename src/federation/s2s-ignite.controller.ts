import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DiscoveryService } from './discovery.service.js';
import {
  FederationIdentityService,
  type FederationIdentityClaim,
} from './federation-identity.service.js';
import { KeypairService } from './keypair.service.js';
import { loadFederationConfig } from './federation.config.js';
import { S2sVerifyService } from './s2s-verify.service.js';
import { FederationIgniteService } from './federation-ignite.service.js';
import {
  FEDERATION_API_PREFIX,
  FEDERATION_PROTOCOL_VERSION,
  selectFederationProtocolVersion,
} from './federation-protocol.js';

@Public()
@Raw()
@Controller(FEDERATION_API_PREFIX)
export class S2sIgniteController {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly verify: S2sVerifyService,
    private readonly discovery: DiscoveryService,
    private readonly identity: FederationIdentityService,
    private readonly keypair: KeypairService,
    private readonly federationInit: FederationIgniteService,
  ) {}

  @Post('ignite')
  @HttpCode(HttpStatus.ACCEPTED)
  async postInit(@Req() req: FastifyRequest) {
    this.keypair.assertAvailable();
    const headers = this.verify.extractHeaders(req);
    const { keyId, domain } = this.verify.parseSigner(headers);
    const preUpgradeKey = await this.identity.getPreUpgradeCachedKey(
      domain,
      keyId,
    );
    const claim = this.identity.validateClaim(
      req.body,
      domain,
      this.config.domain,
      true,
    );
    const doc = await this.assertWellKnownIdentity(domain, claim);
    await this.discovery.cacheKeys(domain, doc.keys);
    await this.verify.fetchAndVerify(
      this.verify.signedRequest(req),
      headers,
      keyId,
      domain,
    );
    const localStartChangeId = await this.federationInit.accept({
      domain,
      claim,
      legacyContinuityProven:
        preUpgradeKey !== undefined && preUpgradeKey === doc.rootKey?.ed25519,
    });
    return this.identity.signClaim(
      this.identity.createClaim(domain, claim.nonce, localStartChangeId),
    );
  }

  @Get('identity')
  async getIdentity(@Req() req: FastifyRequest, @Query('nonce') nonce: string) {
    this.keypair.assertAvailable();
    const headers = this.verify.extractHeaders(req);
    const { keyId, domain } = this.verify.parseSigner(headers);
    await this.identity.requireIdentityEndpointPeer(domain);
    await this.verify.fetchAndVerify(
      this.verify.signedRequest(req),
      headers,
      keyId,
      domain,
    );
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_PROOF_INVALID,
        'invalid identity nonce',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.identity.markIdentityEndpointRecovered(domain);
    return this.identity.signClaim(this.identity.createClaim(domain, nonce));
  }

  private async assertWellKnownIdentity(
    domain: string,
    claim: FederationIdentityClaim,
  ) {
    const doc = await this.discovery.fetchWellKnown(domain);
    const rootPublicKey = doc.rootKey?.ed25519;
    const computed = rootPublicKey
      ? `sha256:${createHash('sha256').update(Buffer.from(rootPublicKey, 'base64')).digest('base64url')}`
      : undefined;
    if (
      selectFederationProtocolVersion(doc.protocolVersions) !==
        FEDERATION_PROTOCOL_VERSION ||
      doc.rootKey?.fingerprint !== claim.rootKeyFingerprint ||
      computed !== claim.rootKeyFingerprint ||
      doc.keys.length !== 1 ||
      doc.keys[0]?.ed25519 !== rootPublicKey
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_PROOF_INVALID,
        `well-known identity does not match the signed claim for ${domain}`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    return doc;
  }
}
