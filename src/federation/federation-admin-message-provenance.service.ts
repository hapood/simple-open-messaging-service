import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  identityNamespace,
  message,
  messageThread,
  relationshipPair,
} from '../database/schema.js';
import { FederationPeerHttp } from './federation-peer-http.js';

export type AdminMessageProvenanceKnown = 'yes' | 'no' | 'declined';

interface ProvenanceResponse {
  results?: Array<{ known?: unknown }>;
}

@Injectable()
export class FederationAdminMessageProvenanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly peerHttp: FederationPeerHttp,
  ) {}

  async verify(
    threadId: number,
    seq: number,
  ): Promise<{
    known: AdminMessageProvenanceKnown;
  }> {
    const [row] = await this.database.db
      .select({
        messageSeq: message.seq,
        originSeq: message.originSeq,
        payloadDigest: message.payloadDigest,
        publisherNamespaceId: message.publisherNamespaceId,
        threadType: messageThread.type,
        groupAccount: messageThread.groupAccount,
      })
      .from(message)
      .innerJoin(messageThread, eq(messageThread.id, message.threadId))
      .where(and(eq(message.threadId, threadId), eq(message.seq, seq)))
      .limit(1);

    if (!row)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'message not found',
        HttpStatus.NOT_FOUND,
      );
    if (
      row.publisherNamespaceId === 0 ||
      row.originSeq === null ||
      row.payloadDigest === null
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'message has no remote provenance coordinate',
        HttpStatus.BAD_REQUEST,
      );
    }

    const peer = await this.database.db.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.id, row.publisherNamespaceId),
        eq(identityNamespace.active, true),
      ),
      columns: { domain: true },
    });
    if (!peer)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'message provenance peer not found',
        HttpStatus.NOT_FOUND,
      );

    const thread = await this.wireThread(
      threadId,
      row.threadType,
      row.groupAccount,
      row.publisherNamespaceId,
    );
    const response = await this.peerHttp.postJson<ProvenanceResponse>(
      '/s2s/v1/message-provenance',
      JSON.stringify({
        queries: [
          {
            thread,
            seq: row.originSeq,
            payloadDigest: row.payloadDigest,
          },
        ],
      }),
      peer.domain,
    );
    const known = response.results?.[0]?.known;
    if (known !== 'yes' && known !== 'no' && known !== 'declined') {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'peer returned an invalid provenance response',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return { known };
  }

  private async wireThread(
    threadId: number,
    type: 'P2P' | 'GROUP',
    groupAccount: string | null,
    publisherNamespaceId: number,
  ): Promise<{ account: string; peerAccount?: string }> {
    if (type === 'GROUP') {
      if (!groupAccount)
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'group thread has no group account',
          HttpStatus.BAD_REQUEST,
        );
      return { account: groupAccount };
    }

    const [pair] = await this.database.db
      .select({
        endpointAAccount: relationshipPair.endpointAAccount,
        endpointANamespaceId: relationshipPair.endpointANamespaceId,
        endpointBAccount: relationshipPair.endpointBAccount,
        endpointBNamespaceId: relationshipPair.endpointBNamespaceId,
      })
      .from(relationshipPair)
      .where(
        and(
          eq(relationshipPair.threadId, threadId),
          eq(relationshipPair.kind, 'P2P'),
          eq(relationshipPair.endpointAType, 'USER'),
          eq(relationshipPair.endpointANamespaceId, 0),
          eq(relationshipPair.endpointBType, 'USER'),
          eq(relationshipPair.endpointBNamespaceId, publisherNamespaceId),
        ),
      )
      .limit(1);
    if (!pair)
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'P2P thread has no canonical provenance address',
        HttpStatus.BAD_REQUEST,
      );
    if (pair.endpointANamespaceId === publisherNamespaceId) {
      return {
        account: pair.endpointAAccount,
        peerAccount: pair.endpointBAccount,
      };
    }
    return {
      account: pair.endpointBAccount,
      peerAccount: pair.endpointAAccount,
    };
  }
}
