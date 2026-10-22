import { HttpStatus, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { identityNamespace } from '../database/schema.js';
import { FederationPeerHttp } from './federation-peer-http.js';

export interface AdminFederationHealthProbeResult {
  namespaceId: number;
  domain: string;
  status: 'available' | 'degraded' | 'unavailable';
  peerAssignedLocalNamespaceId?: number;
}

interface HealthResponse {
  status?: unknown;
  peerAssignedLocalNamespaceId?: unknown;
}

@Injectable()
export class FederationAdminHealthProbeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly peerHttp: FederationPeerHttp,
  ) {}

  async probe(namespaceId: number): Promise<AdminFederationHealthProbeResult> {
    if (!Number.isSafeInteger(namespaceId) || namespaceId <= 0) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'namespaceId must be a positive integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    const namespace = await this.database.db.query.identityNamespace.findFirst({
      where: eq(identityNamespace.id, namespaceId),
      columns: { id: true, domain: true },
    });
    if (!namespace) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'federation namespace not found',
      );
    }
    const raw = await this.peerHttp.get<
      HealthResponse | { data?: HealthResponse }
    >('/s2s/v1/health', namespace.domain, 4096);
    const response = (
      raw &&
      typeof raw === 'object' &&
      'data' in raw &&
      raw.data &&
      typeof raw.data === 'object'
        ? raw.data
        : raw
    ) as HealthResponse;
    if (
      response.status !== 'available' &&
      response.status !== 'degraded' &&
      response.status !== 'unavailable'
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `malformed federation health response: ${JSON.stringify(raw).slice(0, 200)}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    const result: AdminFederationHealthProbeResult = {
      namespaceId: namespace.id,
      domain: namespace.domain,
      status: response.status,
    };
    const peerAssignedLocalNamespaceId = response.peerAssignedLocalNamespaceId;
    if (peerAssignedLocalNamespaceId !== undefined) {
      if (!Number.isSafeInteger(peerAssignedLocalNamespaceId)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'malformed federation health namespace id',
          HttpStatus.BAD_GATEWAY,
        );
      }
      result.peerAssignedLocalNamespaceId =
        peerAssignedLocalNamespaceId as number;
    }
    return result;
  }
}
