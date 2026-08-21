import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DiscoveryService } from './discovery.service.js';
import { FEDERATION_API_PREFIX } from './federation-protocol.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { KeypairService } from './keypair.service.js';
import { S2sVerifyService } from './s2s-verify.service.js';

@Public()
@Raw()
@Controller(FEDERATION_API_PREFIX)
export class S2sRecognitionController {
  constructor(
    private readonly keypair: KeypairService,
    private readonly verify: S2sVerifyService,
    private readonly discovery: DiscoveryService,
    private readonly recognition: FederationRecognitionService,
  ) {}

  @Post('recognize')
  @HttpCode(HttpStatus.OK)
  async recognize(@Req() req: FastifyRequest, @Body() body: unknown) {
    this.keypair.assertAvailable();
    const headers = this.verify.extractHeaders(req);
    const { keyId, domain } = this.verify.parseSigner(headers);
    this.assertDomainBody(body, domain);
    const doc = await this.discovery.fetchWellKnown(domain);
    const certificate = doc.keys.find(
      (key) =>
        key.keyId === keyId &&
        key.notBefore <= Date.now() &&
        Date.now() < key.notAfter,
    );
    if (!certificate) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        `keyId ${keyId} is not currently authorized`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.verify.verifyWithPublicKey(
      this.verify.signedRequest(req),
      headers,
      certificate.ed25519,
    );
    await this.discovery.cacheDocument(domain, doc);
    await this.recognition.acceptInbound(domain, doc);
    this.recognition.dispatchReverse(domain);
    return { ok: true } as const;
  }

  @Post('healthy')
  @HttpCode(HttpStatus.OK)
  async healthy(@Req() req: FastifyRequest, @Body() body: unknown) {
    const headers = this.verify.extractHeaders(req);
    let signer: { keyId: string; domain: string };
    try {
      signer = this.verify.parseSigner(headers);
    } catch (error) {
      throw error;
    }
    if (!this.isDomainBody(body, signer.domain))
      return this.unavailableHealth();
    if (!(await this.recognition.hasPinnedIdentity(signer.domain))) {
      return this.unavailableHealth();
    }
    let publicKey: Uint8Array | null;
    try {
      // A recognized peer may legitimately rotate to a newly published key. Refresh on a cache miss,
      // but collapse every fetch/authorization outcome into Healthy's privacy-safe result.
      publicKey = await this.discovery.getPublicKey(
        signer.domain,
        signer.keyId,
      );
    } catch {
      return this.unavailableHealth();
    }
    if (!publicKey) return this.unavailableHealth();
    try {
      await this.verify.verifyWithPublicKey(
        this.verify.signedRequest(req),
        headers,
        Buffer.from(publicKey).toString('base64'),
      );
    } catch {
      return this.unavailableHealth();
    }
    const status = await this.recognition.queryHealth(signer.domain);
    if (status === 'unavailable') return this.unavailableHealth();
    return { status } as const;
  }

  private unavailableHealth() {
    return { status: 'unavailable' } as const;
  }

  private assertDomainBody(value: unknown, signerDomain: string): void {
    if (!this.isDomainBody(value, signerDomain)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BINDING_VIOLATION,
        'recognize domain does not match signer',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  private isDomainBody(value: unknown, signerDomain: string): boolean {
    return (
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      (value as { domain?: unknown }).domain === signerDomain
    );
  }
}
