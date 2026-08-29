import {
  Body,
  Controller,
  Get,
  Header,
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
    this.assertEmptyObject(body);
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
    const context = await this.recognition.acceptInbound(domain, doc);
    await this.discovery.cacheDocument(domain, context.namespaceId, doc);
    this.recognition.dispatchReverse(domain);
    return { ok: true } as const;
  }

  @Get('health')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async health(@Req() req: FastifyRequest) {
    this.assertEmptyGet(req);
    const headers = this.verify.extractHeaders(req);
    const signer = this.verify.parseSigner(headers);
    if (!(await this.recognition.hasPinnedIdentity(signer.domain))) {
      return this.unavailableHealth();
    }
    let publicKey: Uint8Array | null;
    try {
      // A recognized peer may legitimately rotate to a newly published key. Refresh on a cache miss,
      // but collapse every fetch/authorization outcome into Health's privacy-safe result.
      const context = await this.recognition.captureContext(signer.domain);
      publicKey = await this.discovery.getPublicKey(
        signer.domain,
        context.namespaceId,
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

  private assertEmptyObject(value: unknown): void {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 0
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'recognize body must be an empty object',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertEmptyGet(req: FastifyRequest): void {
    if (
      req.url.includes('?') ||
      (req.rawBody?.length ?? 0) !== 0 ||
      req.headers['content-type'] !== undefined
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'health request must not contain a query, body, or Content-Type',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
