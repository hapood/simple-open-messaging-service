import {
  groupState as groupStateTable,
  groupStateFields,
} from '../group/shared/group-state.js';
import { HttpStatus, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { isThreadMutuallyAuthorized } from '../relationship/shared/relationship-authorization.js';
import {
  type FederationContext,
  FederationNamespaceService,
} from './federation-namespace.service.js';

interface ThreadResourceResponseGate {
  threadId: number;
  peerDomain: string;
  peerToken: FederationContext;
}

/** Owns local send authorization and stale federation-response rejection for threads. */
@Injectable()
export class FederationThreadAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly namespaces: FederationNamespaceService,
  ) {}

  async assertGroupWritable(threadId: number): Promise<void> {
    await this.assertLocalSendNamespaceActive(threadId);
    const [state] = await this.database.db
      .select({ dissolvedAt: groupStateFields.dissolvedAt })
      .from(tables.messageThread)
      .innerJoin(
        groupStateTable,
        eq(groupStateTable.id, tables.messageThread.id),
      )
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (state?.dissolvedAt) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
  }

  async assertP2PWritable(
    threadId: number,
    localUserId: number,
  ): Promise<void> {
    await this.assertLocalSendNamespaceActive(threadId);
    if (
      !(await isThreadMutuallyAuthorized(
        this.database.db,
        localUserId,
        threadId,
      ))
    ) {
      throw new BusinessException(BusinessCode.FRIEND_NOT_FOUND, 'not friends');
    }
  }

  async assertThreadExists(
    threadId: number,
    peerDomain: string,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await this.namespaces.captureActiveInTx(tx, peerDomain);
      await this.assertResponseWritable(tx, threadId, peerDomain);
    });
  }

  async assertResponseWritable(
    tx: DatabaseTransaction,
    threadId: number,
    peerDomain: string,
  ): Promise<void> {
    const [state] = await tx
      .select({ id: tables.messageThread.id })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!state) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `stale federation response for thread ${threadId} from ${peerDomain}`,
      );
    }
  }

  capturePeerResponseToken(domain: string): Promise<FederationContext> {
    return this.namespaces.captureActive(domain);
  }

  async assertPeerResponseWritable(
    tx: DatabaseTransaction,
    token: FederationContext,
  ): Promise<void> {
    await this.namespaces.requireCapturedInTx(tx, token);
  }

  async assertResourceResponseWritable(
    tx: DatabaseTransaction,
    response: ThreadResourceResponseGate,
  ): Promise<void> {
    await this.assertPeerResponseWritable(tx, response.peerToken);
    await this.assertResponseWritable(
      tx,
      response.threadId,
      response.peerDomain,
    );
  }

  private async assertLocalSendNamespaceActive(
    threadId: number,
  ): Promise<void> {
    const [state] = await this.database.db
      .select({
        authorityNamespaceId: tables.messageThread.authorityNamespaceId,
        active: tables.identityNamespace.active,
      })
      .from(tables.messageThread)
      .innerJoin(
        tables.identityNamespace,
        eq(
          tables.identityNamespace.id,
          tables.messageThread.authorityNamespaceId,
        ),
      )
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!state) {
      throw new BusinessException(
        BusinessCode.THREAD_NOT_FOUND,
        `no thread [${threadId}]`,
      );
    }
    if (state.authorityNamespaceId !== 0 && !state.active) {
      throw new BusinessException(
        BusinessCode.FEDERATION_NAMESPACE_INACTIVE,
        `thread ${threadId} belongs to inactive namespace ${state.authorityNamespaceId}`,
        HttpStatus.CONFLICT,
      );
    }
  }
}
