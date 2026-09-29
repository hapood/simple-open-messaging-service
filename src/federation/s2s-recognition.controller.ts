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
    const namespaceEcho = this.assertRecognizeRequest(body);
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
    const context = await this.recognition.acceptInbound(
      domain,
      doc,
      namespaceEcho,
    );
    await this.discovery.cacheDocument(domain, context.namespaceId, doc);
    return {
      ok: true,
      status: 'recognized',
      peerAssignedLocalNamespaceId: context.namespaceId,
    } as const;
  }

  @Get('health')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async health(@Req() req: FastifyRequest) {
    this.assertEmptyGet(req);
    const headers = this.verify.extractHeaders(req);
    const signer = this.verify.parseSigner(headers);

    // Common authentication path. Inbound Health MUST NOT initiate well-known discovery,
    // even for a known peer: key freshness is maintained by the requester's outbound Health
    // overlap refresh and other ordinary discovery refreshes. A missing/expired certificate
    // or failed signature is a common authentication error, never a Health status object.
    const context = await this.resolveHealthSigner(signer.domain);
    const publicKey = await this.discovery.getCachedPublicKey(
      signer.domain,
      context.namespaceId,
      signer.keyId,
    );
    if (!publicKey) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        `signing certificate ${signer.keyId} is not available in local state`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.verify.verifyWithPublicKey(
      this.verify.signedRequest(req),
      headers,
      Buffer.from(publicKey).toString('base64'),
    );

    // Privacy projection begins only after authentication succeeds.
    if (!(await this.recognition.hasPreparedPeer(signer.domain))) {
      return this.unavailableHealth();
    }
    const status = await this.recognition.queryHealth(signer.domain);
    if (status === 'unavailable') return this.unavailableHealth();
    await this.recognition.markReachable(signer.domain);
    return {
      status,
      peerAssignedLocalNamespaceId: context.namespaceId,
    } as const;
  }

  /** Resolve the pinned namespace that scopes the signer's cached certificate set. Failure
   *  means no verified identity exists, so no certificate can be available: the common
   *  authentication error, not a privacy projection. */
  private async resolveHealthSigner(domain: string) {
    try {
      return await this.recognition.captureVerifiedContext(domain);
    } catch (error) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        `no verified identity for signer ${domain}: ${(error as Error).message}`,
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  private unavailableHealth() {
    return { status: 'unavailable' } as const;
  }

  private assertRecognizeRequest(value: unknown): number | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'recognize body must be an empty object or namespace echo',
        HttpStatus.BAD_REQUEST,
      );
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return undefined;
    if (
      keys.length === 1 &&
      keys[0] === 'namespaceId' &&
      this.isPositiveSafeInteger(
        (value as { namespaceId?: unknown }).namespaceId,
      )
    ) {
      return (value as { namespaceId: number }).namespaceId;
    }
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      'recognize body must be an empty object or namespace echo',
      HttpStatus.BAD_REQUEST,
    );
  }

  private isPositiveSafeInteger(value: unknown): value is number {
    return (
      Number.isSafeInteger(value) && typeof value === 'number' && value > 0
    );
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
