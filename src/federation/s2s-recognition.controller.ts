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
import { DatabaseService } from '../database/database.service.js';
import { DiscoveryService } from './discovery.service.js';
import { parseRootKeyHeader } from './signature.service.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { identityNamespace } from '../database/schema.js';
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
    private readonly database: DatabaseService,
  ) {}

  @Post('recognize')
  @HttpCode(HttpStatus.OK)
  async recognize(@Req() req: FastifyRequest, @Body() body: unknown) {
    this.keypair.assertAvailable();
    const headers = this.verify.extractHeaders(req);
    const { keyId, domain, expires } = this.verify.parseSigner(headers);
    const claimedRoot = parseRootKeyHeader(headers['s2s-root-key']);
    if (!claimedRoot) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing or malformed S2S-Root-Key header',
        HttpStatus.BAD_REQUEST,
      );
    }
    const senderAssignedLocalNamespaceId = this.assertRecognizeRequest(body);
    return this.recognition.submitInboundRecognize({
      domain,
      keyId,
      claimedRoot,
      signedRequest: this.verify.signedRequest(req),
      headers,
      senderAssignedLocalNamespaceId,
      signatureExpires: expires,
    });
  }

  @Get('health')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async health(@Req() req: FastifyRequest) {
    this.assertEmptyGet(req);
    // Uniform privacy projection: every authentication failure — malformed
    // signature structure, missing or unresolvable S2S-Root-Key, invalid
    // signature, unavailable or unpublished certificate — and every signer
    // whose relationship is not recognized or prepared answers the same
    // HTTP 200 `unavailable`. Inbound Health MUST NOT initiate well-known
    // discovery even for a known peer: key freshness is maintained by the
    // requester's outbound Health overlap refresh and other ordinary
    // discovery refreshes.
    try {
      const headers = this.verify.extractHeaders(req);
      const signer = this.verify.parseSigner(headers);
      const claimedRoot = parseRootKeyHeader(headers['s2s-root-key']);
      if (!claimedRoot) return this.unavailableHealth();
      const context = await this.resolveHealthSigner(claimedRoot);
      if (!context) return this.unavailableHealth();
      const publicKey = await this.discovery.getCachedPublicKey(
        context.domain,
        context.namespaceId,
        signer.keyId,
      );
      if (!publicKey) return this.unavailableHealth();
      await this.verify.verifyWithPublicKey(
        this.verify.signedRequest(req),
        headers,
        Buffer.from(publicKey).toString('base64'),
      );

      // Privacy projection begins only after authentication succeeds.
      if (!(await this.recognition.hasPreparedPeer(context.domain))) {
        return this.unavailableHealth();
      }
      const status = await this.recognition.queryHealth(context.domain);
      if (status === 'unavailable') return this.unavailableHealth();
      await this.recognition.markReachable(context.domain);
      return {
        status,
        peerAssignedLocalNamespaceId: context.namespaceId,
      } as const;
    } catch {
      return this.unavailableHealth();
    }
  }

  /** Resolve the pinned namespace that scopes the signer's cached certificate
   *  set, by the claimed root. A root pinned to no unretired epoch has no
   *  cached certificate set: authentication failure, uniform `unavailable`. */
  private async resolveHealthSigner(claimedRoot: string) {
    const [namespace] = await this.database.db
      .select({
        domain: identityNamespace.domain,
        namespaceId: identityNamespace.id,
      })
      .from(identityNamespace)
      .where(
        and(
          eq(identityNamespace.rootPublicKey, claimedRoot),
          isNull(identityNamespace.retiredAt),
          sql`${identityNamespace.id} > 0`,
        ),
      )
      .limit(1);
    return namespace ?? null;
  }

  private unavailableHealth() {
    return { status: 'unavailable' } as const;
  }

  private assertRecognizeRequest(value: unknown): number | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'recognize body must be an empty object or a sender-assigned local namespace',
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
      'recognize body must be an empty object or a sender-assigned local namespace',
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
